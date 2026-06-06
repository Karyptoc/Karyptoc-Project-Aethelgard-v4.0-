/**
 * AETHELGARD RISK ENGINE v2
 * New features:
 * - Trailing stop loss
 * - Break-even mechanism
 * - Partial closes (TP1/TP2/TP3)
 * - Spread filter
 * - Correlation filter
 * - Weekly/monthly loss limits
 * - Equity curve trading (reduce size in losing streaks)
 */

const { supabaseAdmin, log } = require("./supabase");

const PIP_SIZES = {
  GOLD: 0.01, EURUSD: 0.0001, GBPUSD: 0.0001, USDJPY: 0.01,
  US30Cash: 1.0, GER40Cash: 1.0, BTCUSD: 1.0
};

// Correlated pairs — don't open all simultaneously
const CORRELATION_GROUPS = [
  ["EURUSD", "GBPUSD"],           // Both USD base, highly correlated
  ["GOLD", "EURUSD"],             // Both inverse USD
  ["US30Cash", "GER40Cash"],      // Both indices
];

// Max spread allowed per instrument (in pips)
const MAX_SPREAD_PIPS = {
  GOLD: 50,       // 0.50 spread max
  EURUSD: 3,      // 3 pip max
  GBPUSD: 5,      // 5 pip max
  USDJPY: 3,
  US30Cash: 30,
  GER40Cash: 30,
  BTCUSD: 200
};

// ── Position Sizing ───────────────────────────────────────────────────────────

function calculatePositionSize({
  balance, equity, riskPercent = 1.0,
  stopLossPips, symbol,
  winRate = 0.55, avgWin = 1.5, avgLoss = 1.0,
  equityCurveMultiplier = 1.0,
  signalGrade = "B"
}) {
  // Grade-based size adjustment
  const gradeMultiplier = { "A": 1.2, "B": 1.0, "C": 0.7, "D": 0.5 }[signalGrade] || 1.0;

  // Equity curve multiplier (reduced in losing streaks)
  const adjustedRisk = (balance * riskPercent / 100) * equityCurveMultiplier * gradeMultiplier;

  // Kelly fraction
  const kellyEdge = (winRate * avgWin - (1 - winRate) * avgLoss);
  const kellyF = Math.max(0, Math.min(kellyEdge / avgWin, 0.25));
  const halfKelly = kellyF * 0.5;
  const finalRisk = adjustedRisk * (0.5 + halfKelly);

  // Pip value
  const pipValue = symbol === "USDJPY" ? 0.9 : 1.0;
  const lotSize = finalRisk / (stopLossPips * pipValue * 100);

  // Hard caps
  const maxRisk = (balance * 2.0) / 100;
  const maxLot = maxRisk / (stopLossPips * pipValue * 100);
  const finalLot = Math.min(
    Math.max(0.01, Math.round(lotSize * 100) / 100),
    Math.max(0.01, Math.round(maxLot * 100) / 100)
  );

  return {
    lotSize: finalLot,
    riskAmount: parseFloat(finalRisk.toFixed(2)),
    riskPercent: parseFloat((finalRisk / balance * 100).toFixed(2)),
    gradeMultiplier,
    equityCurveMultiplier
  };
}

// ── Equity Curve Trading ──────────────────────────────────────────────────────

async function getEquityCurveMultiplier(accountId) {
  try {
    const { data: snapshots } = await supabaseAdmin
      .from("account_snapshots")
      .select("equity, snapshot_time")
      .eq("account_id", accountId)
      .order("snapshot_time", { ascending: false })
      .limit(20);

    if (!snapshots || snapshots.length < 5) return 1.0;

    const equities = snapshots.map(s => s.equity).reverse();
    const recent = equities.slice(-5);
    const older = equities.slice(0, -5);

    if (older.length === 0) return 1.0;

    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;

    // If recent equity is below older average — reduce size
    const ratio = recentAvg / olderAvg;
    if (ratio < 0.95) return 0.5;      // Down >5% — half size
    if (ratio < 0.98) return 0.75;     // Down 2-5% — 75% size
    if (ratio > 1.02) return 1.1;      // Up >2% — slight increase
    return 1.0;                         // Normal
  } catch { return 1.0; }
}

// ── Spread Filter ─────────────────────────────────────────────────────────────

function checkSpread(symbol, bidAskSpread) {
  if (!bidAskSpread || bidAskSpread <= 0) return { allowed: true };

  const pip = PIP_SIZES[symbol] || 0.0001;
  const spreadPips = bidAskSpread / pip;
  const maxAllowed = MAX_SPREAD_PIPS[symbol] || 10;

  if (spreadPips > maxAllowed) {
    return {
      allowed: false,
      reason: `Spread too wide: ${spreadPips.toFixed(1)} pips (max: ${maxAllowed})`
    };
  }
  return { allowed: true, spreadPips: spreadPips.toFixed(1) };
}

// ── Correlation Filter ────────────────────────────────────────────────────────

async function checkCorrelation(symbol, accountId) {
  try {
    const { data: openTrades } = await supabaseAdmin
      .from("trades")
      .select("symbol, direction")
      .eq("account_id", accountId)
      .eq("status", "open");

    if (!openTrades?.length) return { allowed: true };

    const openSymbols = openTrades.map(t => t.symbol);

    // Check if any correlated pair is already open
    for (const group of CORRELATION_GROUPS) {
      if (group.includes(symbol)) {
        const alreadyOpen = group.filter(s => s !== symbol && openSymbols.includes(s));
        if (alreadyOpen.length > 0) {
          return {
            allowed: false,
            reason: `Correlated pair already open: ${alreadyOpen.join(", ")}`
          };
        }
      }
    }
    return { allowed: true };
  } catch { return { allowed: true }; }
}

// ── Weekly/Monthly Loss Limits ────────────────────────────────────────────────

async function checkExtendedLossLimits(accountId) {
  try {
    const { data: account } = await supabaseAdmin
      .from("mt5_accounts").select("*").eq("id", accountId).single();
    if (!account) return { allowed: false, reason: "Account not found" };

    const now = new Date();

    // Weekly check (rolling 7 days)
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const { data: weekTrades } = await supabaseAdmin
      .from("trades").select("profit")
      .eq("account_id", accountId).eq("status", "closed")
      .gte("close_time", weekAgo.toISOString());

    if (weekTrades?.length) {
      const weekPnL = weekTrades.reduce((s, t) => s + (t.profit || 0), 0);
      const weekLossPct = Math.abs(Math.min(0, weekPnL)) / account.balance * 100;
      const weekLimit = (account.max_daily_loss || 5) * 2.5; // 2.5x daily = weekly
      if (weekLossPct >= weekLimit) {
        return {
          allowed: false,
          reason: `Weekly loss limit hit: ${weekLossPct.toFixed(1)}% / ${weekLimit}%`
        };
      }
    }

    // Monthly check (rolling 30 days)
    const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const { data: monthTrades } = await supabaseAdmin
      .from("trades").select("profit")
      .eq("account_id", accountId).eq("status", "closed")
      .gte("close_time", monthAgo.toISOString());

    if (monthTrades?.length) {
      const monthPnL = monthTrades.reduce((s, t) => s + (t.profit || 0), 0);
      const monthLossPct = Math.abs(Math.min(0, monthPnL)) / account.balance * 100;
      const monthLimit = (account.max_daily_loss || 5) * 6; // 6x daily = monthly
      if (monthLossPct >= monthLimit) {
        return {
          allowed: false,
          reason: `Monthly loss limit hit: ${monthLossPct.toFixed(1)}% / ${monthLimit}%`
        };
      }
    }

    return { allowed: true };
  } catch (e) { return { allowed: true }; }
}

// ── Circuit Breaker (enhanced) ────────────────────────────────────────────────

async function checkCircuitBreaker(accountId, symbol = null, spread = null) {
  const { data: account } = await supabaseAdmin
    .from("mt5_accounts").select("*").eq("id", accountId).single();

  if (!account) return { allowed: false, reason: "Account not found" };
  if (!account.is_active) return { allowed: false, reason: "Account disabled" };
  if (!account.is_connected) return { allowed: false, reason: "Account not connected" };

  // Spread check
  if (symbol && spread !== null) {
    const spreadCheck = checkSpread(symbol, spread);
    if (!spreadCheck.allowed) return spreadCheck;
  }

  // Daily loss check
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const { data: todayTrades } = await supabaseAdmin
    .from("trades").select("profit")
    .eq("account_id", accountId).eq("status", "closed")
    .gte("close_time", todayStart.toISOString());

  if (todayTrades?.length) {
    const dailyPnL = todayTrades.reduce((s, t) => s + (t.profit || 0), 0);
    const dailyLossPct = Math.abs(Math.min(0, dailyPnL)) / account.balance * 100;
    if (dailyLossPct >= (account.max_daily_loss || 5)) {
      await log("warning", "riskEngine", `Daily loss limit: ${dailyLossPct.toFixed(1)}%`);
      return { allowed: false, reason: `Daily loss limit: ${dailyLossPct.toFixed(1)}%` };
    }
  }

  // Weekly/monthly limits
  const extCheck = await checkExtendedLossLimits(accountId);
  if (!extCheck.allowed) {
    await log("warning", "riskEngine", extCheck.reason);
    return extCheck;
  }

  // Max open trades
  const { data: openTrades } = await supabaseAdmin
    .from("trades").select("id").eq("account_id", accountId).eq("status", "open");
  if (openTrades?.length >= (account.max_trades || 5)) {
    return { allowed: false, reason: `Max trades: ${openTrades.length}/${account.max_trades}` };
  }

  // Hard circuit breaker (1.5% equity drop in 60 min)
  const sixtyMinAgo = new Date(Date.now() - 60 * 60 * 1000);
  const { data: snapshot } = await supabaseAdmin
    .from("account_snapshots").select("equity")
    .eq("account_id", accountId).gte("snapshot_time", sixtyMinAgo.toISOString())
    .order("snapshot_time", { ascending: true }).limit(1).single();

  if (snapshot && account.equity) {
    const drop = ((snapshot.equity - account.equity) / snapshot.equity) * 100;
    if (drop <= -1.5) {
      await log("critical", "riskEngine", `Hard circuit breaker: ${Math.abs(drop).toFixed(2)}% drop`);
      return { allowed: false, reason: `Circuit breaker: ${Math.abs(drop).toFixed(2)}% drop in 60min` };
    }
  }

  return { allowed: true };
}

// ── Trade Management — Trailing Stop / Break-even / Partial Close ─────────────

function calculateTrailingStop(direction, currentPrice, openPrice, stopLoss, atr, symbol) {
  const pip = PIP_SIZES[symbol] || 0.0001;
  const profitPips = direction === "BUY"
    ? (currentPrice - openPrice) / pip
    : (openPrice - currentPrice) / pip;

  // Activate trailing after 20 pips profit
  if (profitPips < 20) return null;

  // Trail at 1.5x ATR from current price
  const trailDistance = atr * 1.5;
  let newSL;
  if (direction === "BUY") {
    newSL = currentPrice - trailDistance;
    // Only move SL up, never down
    if (newSL <= (stopLoss || 0)) return null;
  } else {
    newSL = currentPrice + trailDistance;
    if (newSL >= (stopLoss || 999999)) return null;
  }
  return parseFloat(newSL.toFixed(5));
}

function calculateBreakEven(direction, currentPrice, openPrice, stopLoss, symbol) {
  const pip = PIP_SIZES[symbol] || 0.0001;
  const profitPips = direction === "BUY"
    ? (currentPrice - openPrice) / pip
    : (openPrice - currentPrice) / pip;

  // Move SL to break-even after 15 pips profit
  if (profitPips < 15) return null;

  const breakEvenLevel = direction === "BUY"
    ? openPrice + (pip * 2)   // Entry + 2 pips
    : openPrice - (pip * 2);  // Entry - 2 pips

  // Only update if it improves the SL
  if (direction === "BUY" && breakEvenLevel <= (stopLoss || 0)) return null;
  if (direction === "SELL" && breakEvenLevel >= (stopLoss || 999999)) return null;

  return parseFloat(breakEvenLevel.toFixed(5));
}

function calculatePartialCloseLevels(direction, entryPrice, stopLoss, symbol) {
  const pip = PIP_SIZES[symbol] || 0.0001;
  const risk = Math.abs(entryPrice - stopLoss);

  return {
    tp1: {
      price: direction === "BUY" ? entryPrice + risk * 1.0 : entryPrice - risk * 1.0,
      closePercent: 33,
      description: "TP1 — 1R — Close 33%"
    },
    tp2: {
      price: direction === "BUY" ? entryPrice + risk * 2.0 : entryPrice - risk * 2.0,
      closePercent: 33,
      description: "TP2 — 2R — Close 33%"
    },
    tp3: {
      price: direction === "BUY" ? entryPrice + risk * 3.0 : entryPrice - risk * 3.0,
      closePercent: 34,
      description: "TP3 — 3R — Close remaining 34%"
    }
  };
}

// ── ATR helpers ───────────────────────────────────────────────────────────────

function calculateATR(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const trValues = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
    trValues.push(tr);
  }
  return parseFloat((trValues.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(5));
}

function calculateStopLoss({ direction, entryPrice, atr, symbol, multiplier = 1.5 }) {
  const pip = PIP_SIZES[symbol] || 0.0001;
  const atrPips = atr / pip;
  const stopPips = Math.round(atrPips * multiplier);
  const stopLoss = direction === "BUY"
    ? entryPrice - (stopPips * pip)
    : entryPrice + (stopPips * pip);
  return { stopLoss: parseFloat(stopLoss.toFixed(5)), stopPips };
}

function calculateTakeProfit({ direction, entryPrice, stopLoss, rrRatio = 2.0 }) {
  const risk = Math.abs(entryPrice - stopLoss);
  const takeProfit = direction === "BUY"
    ? entryPrice + risk * rrRatio
    : entryPrice - risk * rrRatio;
  return parseFloat(takeProfit.toFixed(5));
}

module.exports = {
  calculatePositionSize,
  getEquityCurveMultiplier,
  checkSpread,
  checkCorrelation,
  checkExtendedLossLimits,
  checkCircuitBreaker,
  calculateTrailingStop,
  calculateBreakEven,
  calculatePartialCloseLevels,
  calculateATR,
  calculateStopLoss,
  calculateTakeProfit,
  PIP_SIZES
};
