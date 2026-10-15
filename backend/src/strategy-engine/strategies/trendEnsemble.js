'use strict';
/**
 * Strategy C — daily Donchian-ensemble trend following.
 * Design follows Zarattini, Pagani & Barbon (2025), "Catching Crypto Trends"
 * (ensemble of Donchian channels + volatility sizing), applied multi-asset as in
 * Babu, Levine, Ooi, Pedersen & Stamelos (2020), "Trends Everywhere".
 *
 * Input: daily bars { t, o, h, l, c } oldest first, closed bars only.
 */

const DEFAULT_PARAMS = Object.freeze({
  lookbacks: [20, 40, 60, 120, 250],
  volWindow: 60,          // days of returns for realised volatility
  portfolioVolTarget: 0.10,
  rebalanceBand: 0.25,    // only trade when target differs from current by > 25%
  disasterAtrMult: 4,
  atrWindow: 20,
});

/** Per-lookback state machine replayed over the whole history (no look-ahead). */
function subSignal(closes, L, longOnly) {
  let state = 0;
  for (let i = L; i < closes.length; i++) {
    let hh = -Infinity; let ll = Infinity;
    for (let j = i - L; j < i; j++) { if (closes[j] > hh) hh = closes[j]; if (closes[j] < ll) ll = closes[j]; }
    const mid = (hh + ll) / 2; const c = closes[i];
    if (state === 0) {
      if (c > hh) state = 1;
      else if (!longOnly && c < ll) state = -1;
    } else if (state === 1 && c < mid) state = 0;
    else if (state === -1 && c > mid) state = 0;
  }
  return state;
}

function ensembleSignal(bars, params = DEFAULT_PARAMS, longOnly = false) {
  const closes = bars.map((b) => b.c);
  const usable = params.lookbacks.filter((L) => closes.length > L);
  if (usable.length < params.lookbacks.length) {
    return { signal: 0, parts: {}, ready: false, reason: `need > ${Math.max(...params.lookbacks)} daily bars, have ${closes.length}` };
  }
  const parts = {};
  for (const L of params.lookbacks) parts[L] = subSignal(closes, L, longOnly);
  const signal = Object.values(parts).reduce((a, b) => a + b, 0) / params.lookbacks.length;
  return { signal: Math.round(signal * 10) / 10, parts, ready: true };
}

function annualisedVol(bars, window, periodsPerYear) {
  const closes = bars.map((b) => b.c).slice(-(window + 1));
  if (closes.length < window + 1) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v * periodsPerYear);
}

function atr(bars, window) {
  if (bars.length < window + 1) return null;
  let sum = 0;
  for (let i = bars.length - window; i < bars.length; i++) {
    const b = bars[i]; const pc = bars[i - 1].c;
    sum += Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
  }
  return sum / window;
}

/**
 * Target position in LOTS for one instrument.
 * spec.valuePerPriceUnitPerLot = tick_value / tick_size (account currency).
 * nInstruments = number of instruments enabled for C.
 */
function targetLots({ bars, equity, spec, nInstruments, currentLots = 0, longOnly = false, periodsPerYear = 252 }, params = DEFAULT_PARAMS) {
  const sig = ensembleSignal(bars, params, longOnly);
  if (!sig.ready) return { lots: currentLots, signal: 0, reason: sig.reason, trade: false };
  const vol = annualisedVol(bars, params.volWindow, periodsPerYear);
  const price = bars[bars.length - 1].c;
  const notionalPerLot = price * spec.valuePerPriceUnitPerLot;
  if (!vol || vol <= 0 || !notionalPerLot) return { lots: currentLots, signal: sig.signal, reason: 'volatility or spec unavailable', trade: false };

  const perInstrumentVol = params.portfolioVolTarget / Math.sqrt(nInstruments);
  const rawLots = (sig.signal * equity * perInstrumentVol / vol) / notionalPerLot;
  const a = atr(bars, params.atrWindow);
  const disasterDistance = a ? params.disasterAtrMult * a : null;

  // rebalance band: ignore small changes
  const changed = currentLots === 0
    ? rawLots !== 0
    : Math.abs(rawLots - currentLots) / Math.abs(currentLots) > params.rebalanceBand || Math.sign(rawLots) !== Math.sign(currentLots);
  return {
    lots: changed ? rawLots : currentLots,
    rawLots, signal: sig.signal, parts: sig.parts, vol, price, disasterDistance,
    trade: changed, reason: changed ? 'target changed' : 'within rebalance band',
  };
}

module.exports = { DEFAULT_PARAMS, subSignal, ensembleSignal, annualisedVol, atr, targetLots };
