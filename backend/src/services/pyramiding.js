/**
 * AETHELGARD - Pyramiding gate
 *
 * Decides whether a signal may open an ADDITIONAL trade on a pair where the
 * account already holds a same-direction position.
 *
 * Why: in the real MT5 history, 1,021 Aethelgard trades, setups that opened
 * 2-3 same-direction trades within an hour lost money (2 trades: -$628 over
 * 115 setups, 3 trades: -$1,840 over 58 setups) while single-trade setups made
 * +$527. The engine was re-firing the same signal at full risk each time -
 * triple exposure to one idea - not scaling into a winner.
 *
 * The first trade on a pair/direction is never blocked here. An extra trade is
 * allowed only when ALL of these hold:
 *   1. the signal is grade A (the engine's top confluence grade);
 *   2. nothing for this pair/direction is already queued but not yet filled
 *      (stops a re-fire from slipping through before the first trade shows up);
 *   3. EVERY existing same-direction position is in profit AND its stop has
 *      been moved to break-even or better, so the earlier trades cannot lose
 *      money any more - which also means the stack's total risk is still just
 *      one trade's worth;
 *   4. price has moved in our favour by at least MIN_ADVANCE_R times the new
 *      trade's own risk since EVERY existing entry, so it is a genuinely new
 *      price level and not the same entry repeated.
 *
 * The cap on how many positions a pair may hold stays with the existing
 * max_open_per_pair setting (the caller enforces it).
 */

const MIN_ADVANCE_R = 0.5;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object}   args
 * @param {object}   args.signal            signal row (direction, entry_price, stop_loss, regime_detail)
 * @param {object[]} args.existingSameDir   open trades for this account+symbol+direction
 *                                          (direction, open_price, stop_loss, profit)
 * @param {number}   args.inflightCount     queued commands for this account+symbol+direction
 * @returns {{allowed: boolean, reason?: string}}
 */
function checkPyramiding({ signal, existingSameDir = [], inflightCount = 0 }) {
  if (!existingSameDir.length && inflightCount === 0) return { allowed: true };

  if (inflightCount > 0) {
    return { allowed: false, reason: "another entry on this pair/direction is already queued" };
  }

  const grade = signal?.regime_detail?.confluence_grade;
  if (grade !== "A") {
    return { allowed: false, reason: `already in a ${signal?.direction} on this pair; extra trades need grade A (this is ${grade || "ungraded"})` };
  }

  const entry = num(signal.entry_price);
  const stop = num(signal.stop_loss);
  if (entry === null || stop === null || entry === stop) {
    return { allowed: false, reason: "signal has no usable entry/stop to measure a new price level" };
  }
  const risk = Math.abs(entry - stop);
  const dir = signal.direction;

  for (const t of existingSameDir) {
    const open = num(t.open_price);
    const sl = num(t.stop_loss);
    const profit = num(t.profit);
    if (open === null || open === 0 || sl === null || sl === 0 || profit === null) {
      return { allowed: false, reason: "an existing position has no confirmed entry/stop yet" };
    }
    if (!(profit > 0)) {
      return { allowed: false, reason: "an existing position is not in profit yet" };
    }
    const protectedAtBE = dir === "BUY" ? sl >= open : sl <= open;
    if (!protectedAtBE) {
      return { allowed: false, reason: "an existing position's stop is not at break-even yet" };
    }
    const advance = dir === "BUY" ? entry - open : open - entry;
    if (advance < MIN_ADVANCE_R * risk) {
      return { allowed: false, reason: "price has not moved far enough from an existing entry (not a new level)" };
    }
  }
  return { allowed: true };
}

module.exports = { checkPyramiding, MIN_ADVANCE_R };
