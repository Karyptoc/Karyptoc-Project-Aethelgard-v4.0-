/**
 * AETHELGARD - Monte Carlo trade-resampling
 * backend/src/services/monteCarlo.js
 *
 * Roadmap Phase 5. A backtest produces ONE ordering of trades, so its max
 * drawdown and final balance are a single draw from a distribution — the
 * same trades in a different order would have produced a different
 * equity curve. This bootstraps the observed per-trade results (sampling
 * WITH replacement, so a run can contain more losers in a row than the
 * original did) many times and reports the spread of outcomes:
 * how bad can drawdown plausibly get, and how often does the account
 * end up losing money or hitting a ruin level.
 *
 * Resamples per-trade RETURNS (pnl / balance before the trade), not raw
 * dollars, and compounds them — consistent with how the backtester sizes
 * risk as a % of current balance, so a resampled sequence compounds the
 * same way a real one would. Deterministic (seeded) so the same trades
 * always give the same answer — a result that changes on every refresh
 * can't be compared across runs or windows.
 *
 * Limits: it assumes trades are independent and drawn from the same
 * distribution. Real trades cluster (losing streaks in one regime), so
 * this UNDERSTATES tail risk if the strategy is regime-dependent — pair
 * it with the per-regime breakdown, don't treat it as a guarantee.
 */

const MIN_TRADES = 20; // below this a bootstrap is mostly noise

// mulberry32: small, fast, well-distributed seeded PRNG.
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

const r2 = x => (x === null || x === undefined ? null : Math.round(x * 100) / 100);

/**
 * @param {number[]} returns  per-trade fractional returns (0.012 = +1.2%)
 * @param {object}   opts     { initialBalance, simulations, ruinPct, seed }
 *   ruinPct: balance fall (from the starting balance) counted as "ruin",
 *   e.g. 50 = a 50% loss of starting capital at any point in the path.
 * Returns null when there are too few trades to say anything honest.
 */
function runMonteCarlo(returns, opts = {}) {
  const {
    initialBalance = 1000,
    simulations = 1000,
    ruinPct = 50,
    seed = 12345,
  } = opts;

  const clean = (returns || []).filter(r => typeof r === "number" && isFinite(r));
  if (clean.length < MIN_TRADES) {
    return {
      available: false,
      note: `Monte Carlo needs at least ${MIN_TRADES} trades for a meaningful resample; this run has ${clean.length}.`,
    };
  }

  const rng = makeRng(seed);
  const n = clean.length;
  const ruinLevel = initialBalance * (1 - ruinPct / 100);

  const finals = [];
  const maxDDs = [];
  let ruined = 0, losing = 0;

  for (let s = 0; s < simulations; s++) {
    let bal = initialBalance, peak = initialBalance, maxDD = 0, hitRuin = false;
    for (let i = 0; i < n; i++) {
      bal *= 1 + clean[Math.floor(rng() * n)];
      if (bal > peak) peak = bal;
      const dd = peak > 0 ? (peak - bal) / peak * 100 : 100;
      if (dd > maxDD) maxDD = dd;
      if (bal <= ruinLevel) hitRuin = true;
    }
    finals.push(bal);
    maxDDs.push(maxDD);
    if (hitRuin) ruined++;
    if (bal < initialBalance) losing++;
  }

  finals.sort((a, b) => a - b);
  maxDDs.sort((a, b) => a - b);

  return {
    available: true,
    simulations,
    trades_per_simulation: n,
    seed,
    final_balance: {
      p5: r2(percentile(finals, 0.05)),
      p25: r2(percentile(finals, 0.25)),
      median: r2(percentile(finals, 0.5)),
      p75: r2(percentile(finals, 0.75)),
      p95: r2(percentile(finals, 0.95)),
    },
    max_drawdown_pct: {
      median: r2(percentile(maxDDs, 0.5)),
      p95: r2(percentile(maxDDs, 0.95)), // "1 time in 20 it's at least this bad"
      worst: r2(maxDDs[maxDDs.length - 1]),
    },
    probability_of_loss_pct: r2(losing / simulations * 100),
    ruin_threshold_pct: ruinPct,
    probability_of_ruin_pct: r2(ruined / simulations * 100),
    note: "Assumes trades are independent and identically distributed; real losing streaks cluster by regime, so tail risk here is a floor, not a ceiling.",
  };
}

module.exports = { runMonteCarlo, makeRng, percentile, MIN_TRADES };
