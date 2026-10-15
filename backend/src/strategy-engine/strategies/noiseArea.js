'use strict';
/**
 * Strategies A and B — noise-area intraday momentum.
 * Source: Zarattini, Aziz & Barbon (2024, rev. 2025), "Beat the Market", SFI WP 24-97.
 *
 * Pure functions only: no database, broker or clock calls. The same code runs
 * live (engine) and on history (replay harness), so live and backtest agree.
 *
 * A bar is { m, o, h, l, c, v } where m = exchange-local minute of the bar's START
 * (09:30 bar has m = 570) and v = tick volume.
 */

const { checkpoints } = require('../sessionClock');

const DEFAULT_PARAMS = Object.freeze({
  lookback: 14,          // sessions used for the sigma profile
  vm: 1.0,               // volatility multiplier (paper default, not best-in-sample)
  useVwapTrail: true,    // trailing stop = max(UB, VWAP) for longs, min(LB, VWAP) for shorts
  allowReversal: true,   // close and reverse on opposite-band cross
});

/** Price at a checkpoint = close of the last bar that ended at or before it. */
function priceAt(bars, minute) {
  let p = null;
  for (const b of bars) {
    if (b.m < minute) p = b.c; else break;
  }
  return p;
}

/** Summary of one completed session, used to build tomorrow's profile. */
function summarizeSession(bars, session) {
  const inSession = bars.filter((b) => b.m >= session.open && b.m < session.close);
  if (inSession.length === 0) return null;
  const open = inSession[0].o;
  const close = inSession[inSession.length - 1].c;
  const prices = {};
  for (const cp of checkpoints(session)) {
    const p = priceAt(inSession, cp);
    if (p != null) prices[cp] = p;
  }
  return { open, close, prices };
}

/**
 * Sigma profile: for each checkpoint, mean |P_cp / Open - 1| over the last
 * `lookback` sessions. Returns null if there are not enough complete sessions.
 */
function buildProfile(history, session, lookback = DEFAULT_PARAMS.lookback) {
  const cps = checkpoints(session);
  const recent = history.slice(-lookback);
  if (recent.length < lookback) return null;
  const sigma = {};
  for (const cp of cps) {
    const moves = recent.filter((s) => s.prices[cp] != null).map((s) => Math.abs(s.prices[cp] / s.open - 1));
    if (moves.length < lookback) return null; // incomplete history: refuse rather than guess
    sigma[cp] = moves.reduce((a, b) => a + b, 0) / moves.length;
  }
  return { sigma, lookback, prevClose: recent[recent.length - 1].close };
}

function bands(open, prevClose, sigma, vm) {
  return {
    ub: Math.max(open, prevClose) * (1 + vm * sigma),
    lb: Math.min(open, prevClose) * (1 - vm * sigma),
  };
}

/** Running session VWAP from bars; tick volume is the weight (minimum 1 per bar). */
function vwapUpTo(bars, minute, sessionOpen) {
  let pv = 0; let vol = 0;
  for (const b of bars) {
    if (b.m < sessionOpen) continue;
    if (b.m >= minute) break;
    const w = Math.max(b.v || 0, 1);
    pv += ((b.h + b.l + b.c) / 3) * w;
    vol += w;
  }
  return vol > 0 ? pv / vol : null;
}

/**
 * Core decision at one checkpoint.
 * position: -1 | 0 | 1 (this strategy's own position on this symbol)
 * Returns { target, action, reason }.
 */
function decide(position, { price, ub, lb, vwap }, params = DEFAULT_PARAMS) {
  const longStop = params.useVwapTrail && vwap != null ? Math.max(ub, vwap) : lb;
  const shortStop = params.useVwapTrail && vwap != null ? Math.min(lb, vwap) : ub;

  if (position === 0) {
    if (price > ub) return { target: 1, action: 'enter_long', reason: 'price above upper band' };
    if (price < lb) return { target: -1, action: 'enter_short', reason: 'price below lower band' };
    return { target: 0, action: 'none', reason: 'inside noise area' };
  }
  if (position === 1) {
    if (params.allowReversal && price < lb) return { target: -1, action: 'reverse_short', reason: 'crossed lower band' };
    if (price < longStop) return { target: 0, action: 'exit', reason: params.useVwapTrail ? 'below max(UB, VWAP)' : 'below lower band' };
    return { target: 1, action: 'hold', reason: 'trend intact' };
  }
  if (params.allowReversal && price > ub) return { target: 1, action: 'reverse_long', reason: 'crossed upper band' };
  if (price > shortStop) return { target: 0, action: 'exit', reason: params.useVwapTrail ? 'above min(LB, VWAP)' : 'above upper band' };
  return { target: -1, action: 'hold', reason: 'trend intact' };
}

/**
 * Evaluate a checkpoint from raw bars (what the live engine calls).
 * day: { bars (today so far), profile, open, prevClose }
 */
function evaluateCheckpoint(position, minute, day, session, params = DEFAULT_PARAMS) {
  const sigma = day.profile && day.profile.sigma[minute];
  if (sigma == null) return { target: 0, action: 'none', reason: 'no profile for checkpoint', inputs: null };
  const price = priceAt(day.bars, minute);
  if (price == null) return { target: position, action: 'hold', reason: 'no price yet (stale data)', inputs: null };
  const { ub, lb } = bands(day.open, day.prevClose, sigma, params.vm);
  const vwap = vwapUpTo(day.bars, minute, session.open);
  const out = decide(position, { price, ub, lb, vwap }, params);
  // Emergency stop for a NEW position: the opposite band at entry.
  if (out.target !== position && out.target !== 0) out.emergencyStop = out.target === 1 ? lb : ub;
  out.inputs = { minute, price, ub, lb, vwap, sigma };
  return out;
}

/**
 * Replay one full session (used by the replay harness and tests).
 * Fills at the checkpoint price; emergency stop is checked on every bar;
 * flattens at the session's flatten minute. Costs are applied by the caller.
 */
function replaySession(bars, profile, session, params = DEFAULT_PARAMS) {
  const sessBars = bars.filter((b) => b.m >= session.open && b.m < session.close);
  if (!profile || sessBars.length === 0) return { trades: [], evaluations: [] };
  const day = { bars: sessBars, profile, open: sessBars[0].o, prevClose: profile.prevClose };
  const cps = new Set(checkpoints(session));
  const trades = []; const evaluations = [];
  let pos = 0; let entry = null; let stop = null; let entryMinute = null;

  const close = (price, minute, why) => {
    trades.push({ side: pos, entry, exit: price, entryMinute, exitMinute: minute, ret: pos * (price / entry - 1), reason: why });
    pos = 0; entry = null; stop = null; entryMinute = null;
  };

  for (const b of sessBars) {
    // emergency stop inside the bar (gap-aware)
    if (pos === 1 && b.l <= stop) close(Math.min(b.o, stop), b.m, 'emergency_stop');
    else if (pos === -1 && b.h >= stop) close(Math.max(b.o, stop), b.m, 'emergency_stop');

    const cpMinute = b.m + 1; // a checkpoint is evaluated when the bar ending at it closes
    if (cps.has(cpMinute)) {
      const ev = evaluateCheckpoint(pos, cpMinute, { ...day, bars: sessBars.filter((x) => x.m < cpMinute) }, session, params);
      evaluations.push({ minute: cpMinute, position: pos, ...ev });
      if (ev.target !== pos) {
        const px = ev.inputs.price;
        if (pos !== 0) close(px, cpMinute, ev.action);
        if (ev.target !== 0) { pos = ev.target; entry = px; stop = ev.emergencyStop; entryMinute = cpMinute; }
      }
    }
    if (pos !== 0 && b.m + 1 >= session.flattenAt + 1) close(b.c, b.m + 1, 'session_end');
  }
  if (pos !== 0) close(sessBars[sessBars.length - 1].c, session.close, 'session_end');
  return { trades, evaluations };
}

module.exports = { DEFAULT_PARAMS, priceAt, summarizeSession, buildProfile, bands, vwapUpTo, decide, evaluateCheckpoint, replaySession };
