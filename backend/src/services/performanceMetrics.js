/**
 * AETHELGARD - Shared Performance Metrics
 * backend/src/services/performanceMetrics.js
 *
 * NEW (Oct 4 — Prioritized Improvement Roadmap, Phase 2 item 7): expectancy,
 * R-multiple distribution, Sharpe, and Sortino. Before this, every place in
 * the codebase that reports performance (backtest.js, dashboard.js,
 * reportGenerator.js) computed only profit_factor/win_rate/max_drawdown —
 * exactly the gap the diagnostic report's Section 8 flagged: "risk-adjusted
 * performance should be evaluated on expectancy/profit-factor/drawdown/
 * Sharpe/Sortino, NOT win rate alone." Pure, dependency-free functions so
 * they can be unit-tested without touching the database and reused
 * identically across backtested and live trade data — the same "one shared
 * copy of the logic" discipline signalCore.js already applies to strategy
 * logic.
 *
 * Deliberately decoupled from any particular trade's field names: every
 * function here takes plain numeric arrays. Each caller (backtest.js,
 * dashboard.js, reportGenerator.js) is responsible for mapping its own
 * trade shape into { pnl, riskAmount } pairs first — see
 * normalizeTradeForMetrics() below for the one conversion both live
 * `trades` rows (open_price/stop_loss/volume/profit) and backtest trade
 * objects (entry_price/stop_loss/lot_size/pnl) share.
 */

function mean(arr) {
  return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
}

function stddevSample(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  const variance = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function round(x, d = 3) {
  return x === null || x === undefined || Number.isNaN(x) ? null : parseFloat(x.toFixed(d));
}

/**
 * Converts one trade into the { pnl, riskAmount } shape every metric below
 * needs, from whichever of the two field-naming conventions this codebase
 * uses:
 *   - live `trades` table rows: profit, open_price, stop_loss, volume
 *   - backtest.js trade objects: pnl, entry_price, stop_loss, lot_size
 * riskAmount is the dollar risk implied by the stop distance at entry
 * (|entry - stop| in pips * pip value per lot * lot size) — the same
 * convention calculatePositionSize() already sizes trades by, so R=1 means
 * "lost exactly the planned risk," matching how the stop was actually set,
 * not a re-derived or assumed number.
 */
function normalizeTradeForMetrics(trade, pipSize, pipValuePerLot) {
  const pnl = trade.pnl !== undefined ? trade.pnl : trade.profit;
  const entry = trade.entry_price !== undefined ? trade.entry_price : trade.open_price;
  const stop = trade.stop_loss;
  const lots = trade.lot_size !== undefined ? trade.lot_size : trade.volume;
  if (pnl === null || pnl === undefined || !entry || !stop || !lots || !pipSize) {
    return { pnl: typeof pnl === "number" ? pnl : null, riskAmount: null };
  }
  const riskAmount = Math.abs(entry - stop) / pipSize * (pipValuePerLot || 10) * lots;
  return { pnl, riskAmount: riskAmount > 0 ? riskAmount : null };
}

/** Average dollar P&L per trade. */
function expectancyDollars(pnls) {
  return round(mean(pnls), 2);
}

/** R-multiples: pnl / riskAmount for every trade where riskAmount is known. */
function rMultiples(normalizedTrades) {
  return normalizedTrades
    .filter(t => t.riskAmount && t.pnl !== null)
    .map(t => t.pnl / t.riskAmount);
}

/**
 * Distribution stats over a set of R-multiples, plus R-expectancy (the
 * standard "expectancy in R" figure: mean R across all trades, which
 * equals win_rate * avg_win_R - loss_rate * avg_loss_R). Returns null
 * (not a fabricated zero) when there isn't enough risk-amount data to
 * compute any R-multiples at all — e.g. trades missing stop_loss.
 */
function rMultipleStats(normalizedTrades) {
  const rs = rMultiples(normalizedTrades);
  if (!rs.length) return null;
  const sorted = [...rs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    count: rs.length,
    coverage: round(rs.length / normalizedTrades.length * 100, 1), // % of trades that had a usable stop/risk figure
    mean_r: round(mean(rs)),
    median_r: round(median),
    stddev_r: round(stddevSample(rs)),
    best_r: round(Math.max(...rs)),
    worst_r: round(Math.min(...rs)),
    pct_positive_r: round(rs.filter(r => r > 0).length / rs.length * 100, 1),
  };
}

/**
 * Sharpe ratio from per-trade returns (pnl / balance-before-trade),
 * annualized by sqrt(periodsPerYear) — the standard scaling for
 * non-fixed-interval (trade-level, not daily) return series. Returns null
 * rather than a misleading number when there are fewer than 10 trades
 * (too little data for a stddev to mean anything) or when periodsPerYear
 * couldn't be estimated.
 */
function sharpeRatio(returns, periodsPerYear) {
  if (!returns || returns.length < 10 || !periodsPerYear) return null;
  const sd = stddevSample(returns);
  if (!sd || sd === 0) return null;
  return round(mean(returns) / sd * Math.sqrt(periodsPerYear));
}

/**
 * Sortino ratio: same idea as Sharpe but only penalizes downside
 * volatility (returns below `mar`, the minimum acceptable return — 0 by
 * default, i.e. "any losing trade"). Downside deviation uses the full
 * sample size as its denominator (the standard convention), not just the
 * count of losing trades, so a strategy with very few losers isn't
 * rewarded with an artificially tiny denominator. Returns null when there
 * are no losing trades in the sample (the ratio is undefined/infinite,
 * not a real "no downside risk" result for a short sample) or too few
 * trades overall.
 */
function sortinoRatio(returns, periodsPerYear, mar = 0) {
  if (!returns || returns.length < 10 || !periodsPerYear) return null;
  const downsideSqSum = returns.reduce((s, r) => s + (r < mar ? (r - mar) ** 2 : 0), 0);
  if (downsideSqSum === 0) return null; // no losing trades in sample — not a meaningful ratio yet
  const downsideDev = Math.sqrt(downsideSqSum / returns.length);
  if (downsideDev === 0) return null;
  return round((mean(returns) - mar) / downsideDev * Math.sqrt(periodsPerYear));
}

/**
 * Estimates trades-per-year from a sorted-ascending array of trade
 * timestamps (ISO strings or Date), for annualizing Sharpe/Sortino.
 * Needs at least 2 trades spanning at least 1 day; returns null otherwise
 * rather than guessing.
 */
function estimatePeriodsPerYear(times) {
  if (!times || times.length < 2) return null;
  const sorted = times.map(t => new Date(t).getTime()).sort((a, b) => a - b);
  const spanDays = (sorted[sorted.length - 1] - sorted[0]) / (24 * 60 * 60 * 1000);
  if (spanDays < 1) return null;
  return (times.length / spanDays) * 365;
}

/**
 * Convenience: builds the full { expectancy_dollars, expectancy_r,
 * r_multiple, sharpe, sortino } block from a list of already-normalized
 * { pnl, riskAmount } trades plus parallel arrays of per-trade returns
 * (pnl / balance-before-trade) and timestamps. Every caller in this
 * codebase (backtest.js, dashboard.js, reportGenerator.js) builds these
 * three parallel arrays from its own trade rows and calls this once.
 */
function buildRiskAdjustedSummary({ normalizedTrades, returns, times }) {
  const periodsPerYear = estimatePeriodsPerYear(times);
  const rStats = rMultipleStats(normalizedTrades);
  return {
    expectancy_dollars: expectancyDollars(normalizedTrades.map(t => t.pnl).filter(p => p !== null)),
    expectancy_r: rStats ? rStats.mean_r : null,
    r_multiple: rStats,
    sharpe_ratio: sharpeRatio(returns, periodsPerYear),
    sortino_ratio: sortinoRatio(returns, periodsPerYear),
    annualization_trades_per_year: periodsPerYear ? round(periodsPerYear, 1) : null,
    note: !periodsPerYear
      ? "Sharpe/Sortino unavailable — fewer than 2 trades or a sub-1-day sample; need more history to estimate an annualization factor."
      : (returns.length < 10 ? "Sharpe/Sortino unavailable — fewer than 10 trades, too small a sample for a meaningful ratio." : undefined),
  };
}

module.exports = {
  mean, stddevSample, round,
  normalizeTradeForMetrics,
  expectancyDollars,
  rMultiples,
  rMultipleStats,
  sharpeRatio,
  sortinoRatio,
  estimatePeriodsPerYear,
  buildRiskAdjustedSummary,
};
