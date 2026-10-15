'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const rt = require('../runtime');
const { SESSIONS } = require('../config/instruments');
const { defaultSettings } = require('../adminSettings');

// ---- synthetic broker data (server clock = New York + 7h, like XM/HFM)
const srv = (y, mo, d, nyMinute) => Date.UTC(y, mo - 1, d, 7, 0) / 1000 + nyMinute * 60;
function sessionBars(y, mo, d, pathFn, from = 570, to = 960) {
  const out = []; let prev = pathFn(0);
  for (let m = from, i = 0; m < to; m++, i++) {
    const c = pathFn(i);
    out.push({ t: srv(y, mo, d, m), o: prev, h: Math.max(prev, c), l: Math.min(prev, c), c, v: 50, s: 210 });
    prev = c;
  }
  return out;
}
const quiet = (i) => 20000 * (1 + 0.002 * Math.sin(i / 20));
const HIST_DAYS = [14, 15, 16, 17, 18, 21, 22, 23, 24, 25, 28, 29, 30].map((d) => [2026, 9, d]).concat([[2026, 10, 1], [2026, 10, 2]]);
const history = HIST_DAYS.flatMap(([y, m, d], k) => sessionBars(y, m, d, (i) => 20000 * (1 + 0.002 * (1 + 0.3 * Math.sin(k)) * Math.sin(i / 20))));
const S = { key: 'US_CASH', ...SESSIONS.US_CASH };
const TODAY = [2026, 10, 5]; // Monday
const profile = rt.buildProfileFromHistory(rt.localiseBars(history, 'ny_close', S.tz), S, '2026-10-05', 14);

const spec = { tick_size: 1, tick_value: 1, point: 0.01, digits: 2, volume_min: 0.01, volume_step: 0.01, volume_max: 100, trade_stops_level: 40, margin_per_lot: 75 };
const nyToMs = (minute) => srv(...TODAY, minute) * 1000 - 7 * 3600 * 1000 + 4 * 3600 * 1000; // NY (EDT, UTC-4) -> UTC
function settingsWith(mode = 'demo', patch = {}) {
  const s = defaultSettings();
  s.global.brokerProfile = 'HFM';
  s.strategies.A.mode = mode;
  s.strategies.C.mode = 'off';
  Object.assign(s.global, patch);
  return s;
}
const account = (extra = {}) => ({ login: '57548575', tradeModeDemo: true, equity: 130000, startOfDayEquity: 130000, startOfWeekEquity: 130000, peakEquity: 130000, marginUsed: 0, ...extra });
const trendBars = sessionBars(...TODAY, (i) => 20000 * (1 + 0.00015 * i));
function input(over = {}) {
  return {
    nowMs: nyToMs(600) + 5000, settings: settingsWith(), brokerServerMode: 'ny_close', account: account(),
    positions: [], instruments: { NAS100: { brokerSymbol: 'USA100', spec, spreadPoints: 210, bars: trendBars.filter((b) => b.t < srv(...TODAY, 600)) } },
    profiles: { 'A|NAS100': profile }, evaluatedKeys: new Set(), events: [], commands: [], ...over,
  };
}

test('server clock conversion: 09:30 New York on 5 Oct 2026 is 13:30 UTC', () => {
  assert.equal(new Date(rt.serverEpochToUtcMs(srv(2026, 10, 5, 570), 'ny_close')).toISOString(), '2026-10-05T13:30:00.000Z');
  assert.equal(new Date(rt.serverEpochToUtcMs(srv(2026, 11, 2, 570), 'ny_close')).toISOString(), '2026-11-02T14:30:00.000Z');
});

test('profile builds from 15 sessions of history and has a daily volatility', () => {
  assert.ok(profile && profile.sigma[600] > 0 && profile.dailyVol >= 0);
  assert.equal(rt.buildProfileFromHistory(rt.localiseBars(history.slice(0, 5000), 'ny_close', S.tz), S, '2026-10-05', 14), null);
});

test('demo mode: trend day opens a long at 10:00 with a server-side stop and risk-capped size', () => {
  const out = rt.step(input());
  assert.equal(out.evaluations.length, 1);
  assert.equal(out.evaluations[0].action, 'enter_long');
  const o = out.orders.find((x) => x.action === 'open');
  assert.ok(o, JSON.stringify(out.riskDecisions));
  assert.equal(o.side, 'buy'); assert.equal(o.symbol, 'USA100'); assert.equal(o.magic, 710001);
  assert.ok(o.sl < 20000 && o.lots >= 0.01);
  assert.equal(o.comment, 'A|NAS100|2026-10-05|600');
  // risk to stop never exceeds the US equity cluster budget (0.5% of 130,000 = 650)
  assert.ok((o.requestedPrice - o.sl) * o.lots * 1 <= 650 + 1e-6);
});

test('shadow mode logs the decision but sends no order', () => {
  const out = rt.step(input({ settings: settingsWith('shadow') }));
  assert.equal(out.evaluations.length, 1);
  assert.equal(out.orders.length, 0);
  assert.match(out.riskDecisions[0].skipReason, /shadow/);
});

test('an already evaluated checkpoint is never evaluated twice', () => {
  const out = rt.step(input({ evaluatedKeys: new Set(['A|NAS100|2026-10-05|600']) }));
  assert.equal(out.evaluations.length, 0); assert.equal(out.orders.length, 0);
});

test('a real-money account receives no entries while settings say demo', () => {
  const out = rt.step(input({ account: account({ tradeModeDemo: false }) }));
  assert.equal(out.orders.filter((o) => o.action === 'open').length, 0);
  assert.ok(out.logs.some((l) => l.level === 'critical'));
});

test('stale bars: no evaluation, retried next minute', () => {
  const out = rt.step(input({ instruments: { NAS100: { brokerSymbol: 'USA100', spec, spreadPoints: 210, bars: trendBars.filter((b) => b.t < srv(...TODAY, 590)) } } }));
  assert.equal(out.evaluations.length, 0);
  assert.ok(out.logs.some((l) => /stale/.test(l.msg)));
});

test('news blackout and kill switch block entries but are logged', () => {
  const news = rt.step(input({ events: [{ country: 'USD', timestamp: nyToMs(602) }] }));
  assert.equal(news.orders.length, 0); assert.match(news.riskDecisions[0].skipReason, /news/);
  const killed = rt.step(input({ settings: settingsWith('demo', { killSwitch: true, killMode: 'freeze' }) }));
  assert.equal(killed.orders.length, 0); assert.match(killed.riskDecisions[0].skipReason, /kill/);
});

test('position is closed at the session end and outside the session', () => {
  const pos = [{ ticket: 11, symbol: 'USA100', type: 0, volume: 0.02, price_open: 20000, sl: 19900, magic: 710001 }];
  const atClose = rt.step(input({ nowMs: nyToMs(959) + 5000, positions: pos }));
  assert.deepEqual(atClose.orders.map((o) => [o.action, o.ticket, o.side]), [['close', 11, 'sell']]);
  const evening = rt.step(input({ nowMs: nyToMs(1100), positions: pos }));
  assert.equal(evening.orders[0].action, 'close');
});

test('kill switch "close everything" and admin close commands close strategy positions only', () => {
  const pos = [
    { ticket: 11, symbol: 'USA100', type: 0, volume: 0.02, price_open: 20000, sl: 19900, magic: 710001 },
    { ticket: 99, symbol: 'USA100', type: 0, volume: 1, price_open: 20000, sl: 0, magic: 20260101 }, // old engine: never touched
  ];
  const out = rt.step(input({ settings: settingsWith('demo', { killSwitch: true, killMode: 'flatten' }), positions: pos }));
  assert.deepEqual(out.orders.map((o) => o.ticket), [11]);
  const cmd = rt.step(input({ positions: pos, commands: [{ id: 5, command: 'flatten', strategy: 'A' }] }));
  assert.ok(cmd.orders.some((o) => o.ticket === 11)); assert.ok(!cmd.orders.some((o) => o.ticket === 99));
  const doneCmd = rt.step(input({ positions: [], commands: [{ id: 5, command: 'flatten', strategy: 'A' }] }));
  assert.deepEqual(doneCmd.commandsDone, [5]);
});

test('switching a symbol off closes its open position', () => {
  const s = settingsWith(); s.symbols.NAS100.strategies = ['C'];
  const pos = [{ ticket: 11, symbol: 'USA100', type: 1, volume: 0.02, price_open: 20000, sl: 20100, magic: 710001 }];
  const out = rt.step(input({ settings: s, positions: pos }));
  assert.equal(out.orders[0].action, 'close'); assert.equal(out.orders[0].side, 'buy');
});

test('history is requested before the open when no profile exists', () => {
  const out = rt.step(input({ nowMs: nyToMs(540), profiles: {} }));
  assert.deepEqual(out.needHistory, [{ strategy: 'A', instrument: 'NAS100' }]);
});

test('daily loss limit blocks new entries', () => {
  const out = rt.step(input({ account: account({ equity: 126000 }) }));
  assert.equal(out.orders.length, 0);
  assert.match(out.riskDecisions[0].skipReason, /daily loss/);
});
