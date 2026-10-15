'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const clock = require('../sessionClock');
const { SESSIONS } = require('../config/instruments');
const na = require('../strategies/noiseArea');
const te = require('../strategies/trendEnsemble');
const risk = require('../riskLayer');
const admin = require('../adminSettings');

// ---------------------------------------------------------------- clock
test('US cash open converts correctly across the DST change', () => {
  assert.equal(clock.zonedToUtc(2026, 10, 14, 570, 'America/New_York').toISOString(), '2026-10-14T13:30:00.000Z');
  assert.equal(clock.zonedToUtc(2026, 11, 2, 570, 'America/New_York').toISOString(), '2026-11-02T14:30:00.000Z');
  // Europe changes a week earlier than the US
  assert.equal(clock.zonedToUtc(2026, 10, 26, 540, 'Europe/Berlin').toISOString(), '2026-10-26T08:00:00.000Z');
  assert.equal(clock.toLocalLabel(new Date('2026-11-02T14:30:00Z'), 'Africa/Nairobi'), '2026-11-02 17:30');
});

test('session clock emits checkpoint and flatten events, none on weekends', () => {
  const s = SESSIONS.US_CASH;
  assert.deepEqual(clock.eventsAt(new Date('2026-10-14T14:00:00Z'), s).map((e) => e.type), ['checkpoint']);
  assert.deepEqual(clock.eventsAt(new Date('2026-10-14T19:59:00Z'), s).map((e) => e.type), ['flatten']);
  assert.deepEqual(clock.eventsAt(new Date('2026-10-17T14:00:00Z'), s), []);
  assert.equal(clock.checkpoints(s).length, 12);
});

// ---------------------------------------------------------------- noise area
const S = SESSIONS.US_CASH;
function session(open, pathFn) {
  // 1-minute bars 09:30..15:59 following pathFn(minuteIndex) -> price
  const bars = [];
  let prev = open;
  for (let m = S.open, i = 0; m < S.close; m++, i++) {
    const c = pathFn(i);
    bars.push({ m, o: prev, h: Math.max(prev, c), l: Math.min(prev, c), c, v: 100 });
    prev = c;
  }
  return bars;
}
const quiet = (open) => session(open, (i) => open * (1 + 0.002 * Math.sin(i / 20)));

function history(n = 14) {
  const out = [];
  for (let d = 0; d < n; d++) out.push(na.summarizeSession(quiet(100), S));
  return out;
}

test('profile refuses to build without enough sessions', () => {
  assert.equal(na.buildProfile(history(10), S, 14), null);
  assert.ok(na.buildProfile(history(14), S, 14));
});

test('trend day: enters long at first checkpoint above the band and is flat at the close', () => {
  const profile = na.buildProfile(history(), S);
  const today = session(100, (i) => 100 * (1 + 0.00015 * i)); // steady +0.015% per minute
  const { trades, evaluations } = na.replaySession(today, profile, S);
  assert.equal(evaluations[0].action, 'enter_long');
  assert.equal(evaluations[0].minute, 600);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].reason, 'session_end');
  assert.ok(trades[0].ret > 0);
});

test('quiet day: no trades', () => {
  const profile = na.buildProfile(history(), S);
  const { trades } = na.replaySession(quiet(100), profile, S);
  assert.equal(trades.length, 0);
});

test('reversal day: long is closed by the trailing stop before the close', () => {
  const profile = na.buildProfile(history(), S);
  const today = session(100, (i) => (i < 120 ? 100 * (1 + 0.0001 * i) : 100 * (1.012 - 0.0001 * (i - 120))));
  const { trades } = na.replaySession(today, profile, S);
  assert.ok(trades.length >= 1);
  assert.notEqual(trades[0].reason, 'session_end');
  assert.equal(trades[0].side, 1);
});

test('decide(): vwap trail and reversal rules', () => {
  assert.equal(na.decide(0, { price: 101, ub: 100.5, lb: 99.5, vwap: 100 }).action, 'enter_long');
  assert.equal(na.decide(1, { price: 100.6, ub: 100.5, lb: 99.5, vwap: 100.8 }).action, 'exit');
  assert.equal(na.decide(1, { price: 99.4, ub: 100.5, lb: 99.5, vwap: 100 }).action, 'reverse_short');
  assert.equal(na.decide(-1, { price: 99.0, ub: 100.5, lb: 99.5, vwap: 99.8 }).action, 'hold');
});

// ---------------------------------------------------------------- trend ensemble
const daily = (fn, n = 300) => Array.from({ length: n }, (_, i) => { const c = fn(i); return { t: i, o: c, h: c * 1.005, l: c * 0.995, c }; });

test('ensemble is fully long in a steady uptrend and refuses short history', () => {
  assert.equal(te.ensembleSignal(daily((i) => 100 + i)).signal, 1);
  assert.equal(te.ensembleSignal(daily((i) => 100 + i, 200)).ready, false);
});

test('long-only instruments never go short', () => {
  assert.equal(te.ensembleSignal(daily((i) => 400 - i), te.DEFAULT_PARAMS, true).signal, 0);
  assert.equal(te.ensembleSignal(daily((i) => 400 - i)).signal, -1);
});

test('targetLots respects the rebalance band', () => {
  const bars = daily((i) => 100 * Math.exp(0.002 * i + 0.01 * Math.sin(i)));
  const spec = { valuePerPriceUnitPerLot: 1 };
  const first = te.targetLots({ bars, equity: 10000, spec, nInstruments: 9 });
  assert.ok(first.trade && first.lots > 0);
  const again = te.targetLots({ bars, equity: 10000, spec, nInstruments: 9, currentLots: first.rawLots * 1.1 });
  assert.equal(again.trade, false);
});

// ---------------------------------------------------------------- risk layer
const spec = { tick_size: 0.01, tick_value: 0.01, point: 0.01, volume_min: 0.1, volume_step: 0.1, volume_max: 50, margin_per_lot: 100 };
const acct = { equity: 1000, startOfDayEquity: 1000, startOfWeekEquity: 1000, peakEquity: 1000, marginUsed: 0 };
const req = (over = {}) => ({ strategy: 'A', symbol: 'NAS100', cluster: 'US_EQUITY', desiredLots: 5, entry: 20000, stop: 19980, spec, ...over });

test('$1,000 account: cluster budget binds and lots round down', () => {
  const s = admin.defaultSettings();
  const r = risk.sizeOrder(req(), acct, [], s);
  // US_EQUITY cluster 0.5% of 1000 = $5; 20-point stop at $1/point/lot -> 0.25 lots -> rounds to 0.2
  assert.equal(r.approved, true);
  assert.equal(r.lots, 0.2);
  assert.equal(r.shadow, true);
});

test('$1,000 account: wide stop is skipped instead of rounded up to minimum', () => {
  const r = risk.sizeOrder(req({ stop: 19900 }), acct, [], admin.defaultSettings());
  assert.equal(r.approved, false);
  assert.match(r.skipReason, /below minimum lot/);
});

test('kill switch, disabled strategy and loss limits block entries', () => {
  const s = admin.defaultSettings();
  s.global.killSwitch = true;
  assert.equal(risk.sizeOrder(req(), acct, [], s).skipReason, 'kill switch on');
  const s2 = admin.defaultSettings(); s2.strategies.A.mode = 'off';
  assert.match(risk.sizeOrder(req(), acct, [], s2).skipReason, /off/);
  const lossy = { ...acct, equity: 975 };
  assert.match(risk.sizeOrder(req(), lossy, [], admin.defaultSettings()).skipReason, /daily loss/);
  // daily limit does not stop Strategy C
  const c = risk.sizeOrder(req({ strategy: 'C', desiredLots: 0.1 }), lossy, [], admin.defaultSettings());
  assert.equal(c.approved, true);
});

test('existing open risk in the cluster reduces what is left', () => {
  const open = [{ strategy: 'C', symbol: 'US30', cluster: 'US_EQUITY', lots: 0.2, entry: 40000, stop: 39980, valuePerUnit: 1 }];
  const r = risk.sizeOrder(req(), acct, open, admin.defaultSettings());
  assert.equal(r.approved, false); // $4 of the $5 cluster budget is used -> 0.05 lots < 0.1 min
});

// ---------------------------------------------------------------- admin
test('admin: ceilings are enforced', () => {
  const r = admin.applyAdminChange(admin.defaultSettings(), [{ path: 'risk.perTradeRiskPct', value: 5 }], { actor: 'john' });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /between 0.1 and 1.5/);
});

test('admin: live mode needs approval and a live account', () => {
  const s = admin.defaultSettings();
  let r = admin.applyAdminChange(s, [{ path: 'strategies.A.mode', value: 'live' }], { actor: 'john' });
  assert.equal(r.ok, false);
  r = admin.applyAdminChange(s, [
    { path: 'strategies.A.liveApproved', value: true },
    { path: 'strategies.A.approvalRef', value: 'validation-report-A-v1' },
    { path: 'global.accountType', value: 'live' },
    { path: 'strategies.A.mode', value: 'live' },
  ], { actor: 'john', reason: 'passed demo gate' });
  assert.equal(r.ok, true);
  assert.equal(admin.canSendOrders(r.next, 'A'), true);
  assert.equal(r.audit.length, 4);
});

test('admin: changing parameters demotes a demo/live strategy to shadow and bumps version', () => {
  const s = admin.defaultSettings(); s.strategies.A.mode = 'demo';
  const r = admin.applyAdminChange(s, [{ path: 'strategies.A.params.vm', value: 1.5 }], { actor: 'john' });
  assert.equal(r.ok, true);
  assert.equal(r.next.strategies.A.mode, 'shadow');
  assert.equal(r.next.strategies.A.paramsVersion, 2);
  assert.equal(r.notices.length, 1);
});

test('admin: kill switch off requires a reason; on does not', () => {
  const on = admin.applyAdminChange(admin.defaultSettings(), [{ path: 'global.killSwitch', value: true }], { actor: 'john' });
  assert.equal(on.ok, true);
  const off = admin.applyAdminChange(on.next, [{ path: 'global.killSwitch', value: false }], { actor: 'john' });
  assert.equal(off.ok, false);
  const off2 = admin.applyAdminChange(on.next, [{ path: 'global.killSwitch', value: false }], { actor: 'john', reason: 'checked positions' });
  assert.equal(off2.ok, true);
});

test('admin: symbol strategies limited to what the instrument supports', () => {
  const r = admin.applyAdminChange(admin.defaultSettings(), [{ path: 'symbols.EURUSD.strategies', value: ['A', 'C'] }], { actor: 'john' });
  assert.equal(r.ok, false);
});
