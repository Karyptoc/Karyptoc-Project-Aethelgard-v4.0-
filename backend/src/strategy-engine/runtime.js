'use strict';
/**
 * Strategy runtime — the decision step for the noise-area strategies (A, B).
 *
 * Pure: takes a snapshot (time, settings, account, broker positions, bars, profiles,
 * news events) and returns what should happen (evaluations to log, risk decisions,
 * orders for the bridge). No database, broker or clock calls, so it is unit-tested
 * and behaves identically in replay.
 *
 * Broker positions are the source of truth for "what am I holding" — the runtime never
 * trusts its own memory of positions, which makes every tick a reconciliation.
 */

const { INSTRUMENTS, SESSIONS } = require('./config/instruments');
const clock = require('./sessionClock');
const na = require('./strategies/noiseArea');
const risk = require('./riskLayer');
const { canSendOrders } = require('./adminSettings');

const MAGIC = { A: 710001, B: 710002, C: 710003 };
const STRATEGY_OF_MAGIC = { 710001: 'A', 710002: 'B', 710003: 'C' };
const NOISE_STRATEGIES = ['A', 'B'];
const CHECKPOINT_GRACE_MIN = 5;     // evaluate a checkpoint up to 5 minutes late, never later
const STALE_BAR_MIN = 2;            // the last closed bar must be at most 2 minutes old at a checkpoint
const NEWS_CURRENCIES = { US_CASH: ['USD'], COMEX_DAY: ['USD'], LONDON_GOLD: ['USD'], XETRA: ['EUR', 'USD'] };

/** Session used by a strategy on an instrument. */
function sessionFor(strategy, instrument, settings) {
  if (strategy === 'B') {
    const anchor = settings.strategies.B.params.anchor || 'COMEX_DAY';
    return { key: anchor, ...SESSIONS[anchor] };
  }
  const key = INSTRUMENTS[instrument].session;
  return { key, ...SESSIONS[key] };
}

/**
 * MT5 returns bar times as the broker's server wall clock encoded as epoch seconds.
 * 'ny_close' servers run at New York time + 7h; 'utc' servers run at UTC.
 */
function serverEpochToUtcMs(sec, mode) {
  if (mode === 'utc') return sec * 1000;
  const d = new Date((sec - 7 * 3600) * 1000); // New York wall clock, read through UTC getters
  const utc = clock.zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(),
    d.getUTCHours() * 60 + d.getUTCMinutes(), 'America/New_York');
  return utc.getTime() + d.getUTCSeconds() * 1000;
}

/** Convert raw bridge bars to session-local bars { m, o, h, l, c, v, s, dateKey, utc }. */
function localiseBars(rawBars, serverMode, tz) {
  return rawBars.map((b) => {
    const utc = serverEpochToUtcMs(b.t, serverMode);
    const p = clock.zonedParts(new Date(utc), tz);
    return { m: p.minuteOfDay, dateKey: p.dateKey, utc, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, s: b.s || 0 };
  });
}

/**
 * Build the day's profile from history. Returns null if there are fewer than
 * `lookback` complete prior sessions (the strategy refuses rather than guesses).
 */
function buildProfileFromHistory(localBars, session, todayKey, lookback) {
  const byDay = new Map();
  for (const b of localBars) {
    if (b.dateKey >= todayKey) continue;
    if (b.m < session.open || b.m >= session.close) continue;
    if (!byDay.has(b.dateKey)) byDay.set(b.dateKey, []);
    byDay.get(b.dateKey).push(b);
  }
  const expected = session.close - session.open;
  const sessions = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .filter(([, bars]) => bars.length >= expected * 0.9) // skip half days and gappy sessions
    .map(([dateKey, bars]) => ({ dateKey, ...na.summarizeSession(bars.sort((x, y) => x.m - y.m), session) }));
  const profile = na.buildProfile(sessions, session, lookback);
  if (!profile) return null;
  const closes = sessions.slice(-(lookback + 1)).map((s) => s.close);
  const rets = closes.slice(1).map((c, i) => c / closes[i] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const dailyVol = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1));
  return { ...profile, dailyVol, sessionsUsed: sessions.slice(-lookback).map((s) => s.dateKey) };
}

function inNewsBlackout(nowMs, events, currencies, beforeMin, afterMin) {
  return (events || []).some((e) => currencies.includes(e.country)
    && nowMs >= e.timestamp - beforeMin * 60000 && nowMs <= e.timestamp + afterMin * 60000);
}

function roundPrice(px, digits) { return Number(px.toFixed(digits)); }

/**
 * One decision step.
 * input = {
 *   nowMs, settings, brokerServerMode,
 *   account: { login, tradeModeDemo, equity, startOfDayEquity, startOfWeekEquity, peakEquity, marginUsed },
 *   positions: [{ ticket, symbol, type: 0|1, volume, price_open, sl, magic }],
 *   instruments: { NAS100: { brokerSymbol, spec, bars: [raw], spreadPoints } },
 *   profiles: { 'A|NAS100': profile },            // today's profiles already built
 *   evaluatedKeys: Set<string>,                    // keys already evaluated (from DB)
 *   events: [ { country, timestamp } ],            // high-impact news
 *   commands: [ { id, command, strategy, symbol } ]
 * }
 */
function step(input) {
  const { nowMs, settings, account, positions = [], instruments = {}, profiles = {}, evaluatedKeys = new Set(), events = [], commands = [] } = input;
  const serverMode = input.brokerServerMode || 'ny_close';
  const out = { evaluations: [], riskDecisions: [], orders: [], needHistory: [], logs: [], commandsDone: [] };
  const g = settings.global;
  const mine = positions.filter((p) => STRATEGY_OF_MAGIC[p.magic]);

  // ---- account-type safety: never send orders to a real account unless a strategy is approved for live
  const accountIsDemo = account.tradeModeDemo === true;
  if (!accountIsDemo && g.accountType !== 'live') {
    out.logs.push({ level: 'critical', msg: `Connected account ${account.login} is NOT a demo account but settings say demo — no orders will be sent.` });
  }
  const ordersAllowedFor = (strategy) => canSendOrders(settings, strategy) && (accountIsDemo ? g.accountType === 'demo' : g.accountType === 'live');

  const closeOrder = (p, reason) => ({
    key: `close|${p.ticket}`, action: 'close', ticket: p.ticket, symbol: p.symbol, lots: p.volume,
    side: p.type === 0 ? 'sell' : 'buy', magic: p.magic, strategy: STRATEGY_OF_MAGIC[p.magic], reason,
  });
  const closing = new Set();
  // Closing always reduces risk, so closes are sent whenever the strategy holds something it should not.
  const closeAll = (list, reason) => {
    for (const p of list) {
      if (closing.has(p.ticket)) continue;
      closing.add(p.ticket);
      out.orders.push(closeOrder(p, reason));
    }
  };

  // ---- kill switch (flatten) and admin close commands
  if (g.killSwitch && g.killMode === 'flatten') closeAll(mine, 'kill switch (close everything)');
  for (const cmd of commands) {
    const sym = cmd.symbol ? instruments[cmd.symbol]?.brokerSymbol : null;
    const matching = cmd.command === 'flatten_all' ? mine
      : mine.filter((p) => (!cmd.strategy || STRATEGY_OF_MAGIC[p.magic] === cmd.strategy) && (!sym || p.symbol === sym));
    if (matching.length === 0) out.commandsDone.push(cmd.id);
    else closeAll(matching, cmd.command === 'flatten_all' ? 'admin close-all' : `admin close (${cmd.strategy || 'all'})`);
  }

  // risk inputs shared by all entries
  const riskPositions = mine.map((p) => {
    const inst = Object.entries(instruments).find(([, v]) => v.brokerSymbol === p.symbol);
    const spec = inst ? inst[1].spec : null;
    const stop = p.sl > 0 ? p.sl : p.price_open * (p.type === 0 ? 0.98 : 1.02); // no SL -> assume a wide 2% stop
    return { ticket: p.ticket, strategy: STRATEGY_OF_MAGIC[p.magic], symbol: inst ? inst[0] : p.symbol, cluster: inst ? INSTRUMENTS[inst[0]].cluster : 'UNKNOWN',
      lots: p.volume, entry: p.price_open, stop, valuePerUnit: spec ? risk.valuePerUnit(spec) : 0 };
  });

  for (const strategy of NOISE_STRATEGIES) {
    const sSet = settings.strategies[strategy];
    for (const [id, inst] of Object.entries(instruments)) {
      const symSettings = settings.symbols[id];
      if (!INSTRUMENTS[id] || !INSTRUMENTS[id].strategies.includes(strategy)) continue;
      const session = sessionFor(strategy, id, settings);
      const held = mine.filter((p) => p.magic === MAGIC[strategy] && p.symbol === inst.brokerSymbol);
      const enabledHere = sSet.mode !== 'off' && symSettings && symSettings.enabled && symSettings.strategies.includes(strategy);

      // strategy or symbol switched off while holding -> close
      if (!enabledHere) {
        if (held.length) closeAll(held, `strategy off for ${id}`);
        continue;
      }

      const nowP = clock.zonedParts(new Date(nowMs), session.tz);
      const weekday = clock.isWeekday(new Date(nowMs), session.tz);
      const M = nowP.minuteOfDay;
      const inSession = weekday && M >= session.open && M < session.flattenAt;

      // A/B are always flat outside their session (covers flatten time, missed flattens and restarts)
      if (!inSession) {
        if (held.length) closeAll(held, M >= session.flattenAt ? 'session end' : 'outside session');
        // ask for history ahead of the open so the profile is ready
        const profKey = `${strategy}|${id}`;
        if (weekday && M >= session.open - 60 && M < session.open && !profiles[profKey]) out.needHistory.push({ strategy, instrument: id });
        continue;
      }

      if (held.length > 1) {
        out.logs.push({ level: 'warning', msg: `${strategy} ${id}: ${held.length} open tickets, expected at most 1 — entries blocked, closing extras.` });
        closeAll(held.slice(1), 'duplicate position');
      }
      const position = held.length ? (held[0].type === 0 ? 1 : -1) : 0;

      const profKey = `${strategy}|${id}`;
      const profile = profiles[profKey];
      if (!profile) { out.needHistory.push({ strategy, instrument: id }); continue; }

      // latest due checkpoint within the grace window
      const due = clock.checkpoints(session).filter((cp) => cp <= M && M - cp <= CHECKPOINT_GRACE_MIN);
      if (!due.length) continue;
      const cp = due[due.length - 1];
      const key = `${strategy}|${id}|${nowP.dateKey}|${cp}`;
      if (evaluatedKeys.has(key)) continue;

      const bars = localiseBars(inst.bars || [], serverMode, session.tz)
        .filter((b) => b.dateKey === nowP.dateKey && b.m >= session.open && b.m < cp && b.utc + 60000 <= nowMs)
        .sort((a, b) => a.m - b.m);
      if (!bars.length || bars[bars.length - 1].m < cp - STALE_BAR_MIN) {
        out.logs.push({ level: 'warning', msg: `${key}: stale or missing bars (last ${bars.length ? bars[bars.length - 1].m : 'none'}), retrying next minute.` });
        continue;
      }
      const day = { bars, profile, open: bars[0].o, prevClose: profile.prevClose };
      const ev = na.evaluateCheckpoint(position, cp, day, session, { ...na.DEFAULT_PARAMS, ...sSet.params });
      const evaluation = {
        key, strategy, instrument: id, evalTimeMs: clock.zonedToUtc(nowP.year, nowP.month, nowP.day, cp, session.tz).getTime(),
        checkpoint: cp, positionBefore: position, target: ev.target, action: ev.action, reason: ev.reason,
        price: ev.inputs?.price ?? null, ub: ev.inputs?.ub ?? null, lb: ev.inputs?.lb ?? null, vwap: ev.inputs?.vwap ?? null,
        mode: sSet.mode, paramsVersion: sSet.paramsVersion,
      };
      out.evaluations.push(evaluation);
      if (ev.target === position) continue;

      // exits and reversals always close the current ticket first
      if (position !== 0 && !closing.has(held[0].ticket)) {
        closing.add(held[0].ticket);
        out.orders.push({ ...closeOrder(held[0], ev.action), evaluationKey: key });
      }
      if (ev.target === 0) continue;

      // ---- new entry gates
      const skip = (why) => out.riskDecisions.push({ strategy, symbol: id, evaluationKey: key, approved: false, skipReason: why, steps: [] });
      if (sSet.mode === 'shadow') { skip('shadow mode (logged only)'); continue; }
      if (g.killSwitch) { skip('kill switch on'); continue; }
      if (!ordersAllowedFor(strategy)) { skip(`orders not allowed (mode ${sSet.mode}, account ${accountIsDemo ? 'demo' : 'REAL'}, setting ${g.accountType})`); continue; }
      if (held.length > 1) { skip('duplicate positions present'); continue; }
      if (inNewsBlackout(nowMs, events, NEWS_CURRENCIES[session.key] || ['USD'], g.newsBlackoutBeforeMin, g.newsBlackoutAfterMin)) { skip('news blackout'); continue; }
      const maxSpread = symSettings.maxSpreadPoints;
      if (maxSpread != null && inst.spreadPoints > maxSpread) { skip(`spread ${inst.spreadPoints} > max ${maxSpread} points`); continue; }

      const spec = inst.spec;
      const desired = risk.volTargetLots({ equity: account.equity, dailyVol: profile.dailyVol, price: ev.inputs.price, spec, target: 0.01, maxLeverage: 2 });
      const otherPositions = riskPositions.filter((p) => !closing.has(p.ticket));
      const sized = risk.sizeOrder({ strategy, symbol: id, cluster: INSTRUMENTS[id].cluster, desiredLots: desired, entry: ev.inputs.price, stop: ev.emergencyStop, spec },
        account, otherPositions, settings);
      out.riskDecisions.push({ strategy, symbol: id, evaluationKey: key, approved: sized.approved, skipReason: sized.skipReason || null, steps: sized.steps, desiredLots: desired, finalLots: sized.lots });
      if (!sized.approved) continue;
      out.orders.push({
        key, action: 'open', strategy, instrument: id, symbol: inst.brokerSymbol, side: ev.target === 1 ? 'buy' : 'sell',
        lots: sized.lots, sl: roundPrice(ev.emergencyStop, spec.digits ?? 2), magic: MAGIC[strategy],
        comment: key.slice(0, 31), requestedPrice: ev.inputs.price, reason: ev.action,
      });
    }
  }
  return out;
}

module.exports = { MAGIC, STRATEGY_OF_MAGIC, serverEpochToUtcMs, localiseBars, buildProfileFromHistory, sessionFor, inNewsBlackout, step };
