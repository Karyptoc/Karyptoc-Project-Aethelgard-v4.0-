/**
 * AETHELGARD - Decision-engine evaluation
 * backend/src/services/modelEval.js
 *
 * Roadmap Phase 5 (model eval). Compares trades grouped by which decision
 * engine produced the signal (PURE_MATH, HYBRID_AI, HYBRID_MATH, AI, SCALP —
 * tagged in signalEngine.js as regime_detail.decision_engine).
 *
 * The point is to stop eyeballing "Hybrid felt better this week." Win rate
 * and total P&L over a few dozen trades are mostly noise, so every pairwise
 * comparison gets a bootstrap 95% confidence interval on the DIFFERENCE in
 * average result per trade, and a verdict that is only ever "A_BETTER" /
 * "B_BETTER" when that interval excludes zero. Anything else is reported as
 * what it is: not enough evidence yet.
 *
 * Compares in R-multiples (result relative to the risk taken on that trade)
 * when enough trades have a usable stop, because engines may size or place
 * stops differently and raw dollars would reward whichever risked more.
 * Falls back to dollars, and says so.
 *
 * Pure functions, no DB access, so they can be unit-tested directly.
 */

const perf = require("./performanceMetrics");
const { makeRng, percentile } = require("./monteCarlo");

const MIN_TRADES_PER_ENGINE = 30; // below this a mean is not an estimate worth comparing
const BOOTSTRAP_ITERATIONS = 2000;

const r3 = x => (x === null || x === undefined || !isFinite(x) ? null : Math.round(x * 1000) / 1000);

/** Per-engine summary from normalized { pnl, riskAmount } trades. */
function summarizeEngine(trades) {
  const pnls = trades.map(t => t.pnl).filter(p => typeof p === "number");
  const wins = pnls.filter(p => p > 0), losses = pnls.filter(p => p < 0);
  const grossProfit = wins.reduce((s, p) => s + p, 0);
  const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
  const rStats = perf.rMultipleStats(trades);
  return {
    trades: pnls.length,
    win_rate: pnls.length ? r3(wins.length / pnls.length * 100) : null,
    total_pnl: r3(pnls.reduce((s, p) => s + p, 0)),
    expectancy_dollars: perf.expectancyDollars(pnls),
    expectancy_r: rStats ? rStats.mean_r : null,
    r_coverage_pct: rStats ? rStats.coverage : 0,
    profit_factor: grossLoss > 0 ? r3(grossProfit / grossLoss) : null,
    sufficient_sample: pnls.length >= MIN_TRADES_PER_ENGINE,
  };
}

/**
 * Chooses the per-trade value series to compare for a pair: R-multiples if
 * BOTH sides have at least MIN_TRADES_PER_ENGINE usable R values, else
 * dollars. Returns { unit, a, b }.
 */
function comparableSeries(tradesA, tradesB) {
  const ra = perf.rMultiples(tradesA), rb = perf.rMultiples(tradesB);
  if (ra.length >= MIN_TRADES_PER_ENGINE && rb.length >= MIN_TRADES_PER_ENGINE) {
    return { unit: "R", a: ra, b: rb };
  }
  return {
    unit: "dollars",
    a: tradesA.map(t => t.pnl).filter(p => typeof p === "number"),
    b: tradesB.map(t => t.pnl).filter(p => typeof p === "number"),
  };
}

/**
 * Bootstrap 95% CI for (mean(a) - mean(b)). Resamples each group
 * independently with replacement. Seeded so the same data gives the same
 * answer on every refresh.
 */
function bootstrapMeanDiff(a, b, seed = 4242) {
  const rng = makeRng(seed);
  const mean = arr => arr.reduce((s, x) => s + x, 0) / arr.length;
  const diffs = [];
  for (let i = 0; i < BOOTSTRAP_ITERATIONS; i++) {
    let sa = 0, sb = 0;
    for (let j = 0; j < a.length; j++) sa += a[Math.floor(rng() * a.length)];
    for (let j = 0; j < b.length; j++) sb += b[Math.floor(rng() * b.length)];
    diffs.push(sa / a.length - sb / b.length);
  }
  diffs.sort((x, y) => x - y);
  return {
    observed_diff: mean(a) - mean(b),
    ci95_low: percentile(diffs, 0.025),
    ci95_high: percentile(diffs, 0.975),
  };
}

/** Verdict for one ordered pair (A vs B). */
function comparePair(nameA, tradesA, nameB, tradesB) {
  if (tradesA.length < MIN_TRADES_PER_ENGINE || tradesB.length < MIN_TRADES_PER_ENGINE) {
    return {
      a: nameA, b: nameB,
      verdict: "INSUFFICIENT_DATA",
      note: `Need at least ${MIN_TRADES_PER_ENGINE} closed trades per engine (${nameA}: ${tradesA.length}, ${nameB}: ${tradesB.length}).`,
    };
  }
  const { unit, a, b } = comparableSeries(tradesA, tradesB);
  const ci = bootstrapMeanDiff(a, b);
  let verdict = "NO_CLEAR_DIFFERENCE";
  if (ci.ci95_low > 0) verdict = "A_BETTER";
  else if (ci.ci95_high < 0) verdict = "B_BETTER";
  return {
    a: nameA, b: nameB,
    unit,
    mean_diff_a_minus_b: r3(ci.observed_diff),
    ci95: [r3(ci.ci95_low), r3(ci.ci95_high)],
    verdict,
    winner: verdict === "A_BETTER" ? nameA : verdict === "B_BETTER" ? nameB : null,
    note: verdict === "NO_CLEAR_DIFFERENCE"
      ? "The 95% interval on the difference includes zero — the data can't separate these engines yet, whatever the raw averages look like."
      : `Interval excludes zero (in ${unit} per trade). Still a historical result over this sample, not a guarantee, and it doesn't account for Claude API cost.`,
  };
}

/**
 * @param {Object<string, Array<{pnl:number, riskAmount:number|null}>>} byEngine
 *   engine name -> normalized trades
 */
function compareEngines(byEngine) {
  const names = Object.keys(byEngine).sort();
  const engines = {};
  names.forEach(n => { engines[n] = summarizeEngine(byEngine[n]); });

  const comparisons = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      comparisons.push(comparePair(names[i], byEngine[names[i]], names[j], byEngine[names[j]]));
    }
  }
  return { engines, comparisons, min_trades_per_engine: MIN_TRADES_PER_ENGINE };
}

module.exports = {
  compareEngines, comparePair, summarizeEngine, bootstrapMeanDiff,
  MIN_TRADES_PER_ENGINE,
};
