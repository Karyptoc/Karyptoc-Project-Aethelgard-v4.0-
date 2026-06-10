/**
 * AETHELGARD RISK ENGINE v3
 * backend/src/services/riskEngine.js
 * 
 * Preserves all v2 functions + adds:
 * - Per-pair enabled/halted check from pair_controls table
 * - Per-pair daily loss auto-halt
 * - Weekly/monthly loss limits
 * - Equity curve position sizing
 */

const { supabaseAdmin, log } = require("./supabase");

const PIP_SIZES = {
  GOLD: 0.01, EURUSD: 0.0001, GBPUSD: 0.0001, USDJPY: 0.01,
  US30Cash: 1.0, GER40Cash: 1.0, BTCUSD: 1.0,
  AUDUSD: 0.0001, USDCAD: 0.0001, USDCHF: 0.0001,
  NZDUSD: 0.0001, GBPJPY: 0.01, EURJPY: 0.01,
};

const CORRELATION_GROUPS = [
  ["EURUSD", "GBPUSD"],
  ["GOLD", "EURUSD"],
  ["US30Cash", "GER40Cash"],
];

const MAX_SPREAD_PIPS = {
  GOLD: 150, EURUSD: 3, GBPUSD: 5, USDJPY: 3,
  US30Cash: 50, GER40Cash: 50, BTCUSD: 300,
  AUDUSD: 3, USDCAD: 4, USDCHF: 4,
  NZDUSD: 4, GBPJPY: 8, EURJPY: 6,
};

// ── Pair Controls ─────────────────────────────────────────────────────────────

async function isPairEnabled(symbol) {
  try {
    const { data } = await supabaseAdmin
      .from("pair_controls")
      .select("enabled, auto_halted, auto_halt_reason, max_daily_loss_usd, max_trades_per_day")
      .eq("symbol", symbol)
      .single();

    if (!data) return { allowed: true }; // allow if no record found

    if (!data.enabled) {
      return { allowed: false, reason: `${symbol} manually halted` };
    }
    if (data.auto_halted) {
      return { allowed: false, reason: `${symbol} auto-halted: ${data.auto_halt_reason}` };
    }

    // Check daily loss limit
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const { data: todayTrades } = await supabaseAdmin
      .from("trades").select("profit")
      .eq("symbol", symbol).eq("status", "closed")
      .gte("close_time", todayStart.toISOString());

    if (todayTrades?.length) {
      const dailyPnL = todayTrades.reduce((s, t) => s + (t.profit || 0), 0);
      const maxLoss = data.max_daily_loss_usd || 10;
      if (dailyPnL <= -maxLoss) {
        // Auto-halt the pair
        await supabaseAdmin.from("pair_controls").update({
          auto_halted: true,
          auto_halt_reason: `Daily loss limit hit: $${Math.abs(dailyPnL).toFixed(2)} / $${maxLoss}`,
          updated_at: new Date().toISOString()
        }).eq("symbol", symbol);
        await log("warning", "riskEngine", `${symbol} auto-halted: daily loss $${Math.abs(dailyPnL).toFixed(2)}`);
        return { allowed: false, reason: `${symbol} daily loss limit reached: $${Math.abs(dailyPnL).toFixed(2)}` };
      }

      // Check max trades per day
      const maxTrades = data.max_trades_per_day || 5;
      if (todayTrades.length >= maxTrades) {
        return { allowed: false, reason: `${symbol} max trades/day reached (${todayTrades.length}/${maxTrades})` };
      }
    }

    return { allowed: true };
  } catch (e) {
    await log("error", "riskEngine", `isPairEnabled error for ${symbol}: ${e.message}`);
    return { allowed: true }; // fail open to not block trading on DB error
  }
}

// ── Position Sizing ───────────────────────────────────────────────────────────

function calculatePositionSize({
  balance, equity, riskPercent = 1.0,
  stopLossPips, symbol,
  winRate = 0.55, avgWin = 1.5, avgLoss = 1.0,
  equityCurveMultiplier = 1.0,
  signalGrade = "B"
}) {
  const gradeMultiplier = { "A": 1.2, "B": 1.0, "C": 0.7, "D": 0.5 }[signalGrade] || 1.0;
  const adjustedRisk = (balance * riskPercent / 100) * equityCurveMultiplier * gradeMultiplier;

  const kellyEdge = (winRate * avgWin - (1 - winRate) * avgLoss);
  const kellyF = Math.max(0, Math.min(kellyEdge / avgWin, 0.25));
  const finalRisk = adjustedRisk * (0.5 + kellyF * 0.5);

  const pipValue = symbol === "USDJPY" ? 0.9 : 1.0;
  const lotSize = finalRisk / (stopLossPips * pipValue * 100);

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
    const ratio = recentAvg / olderAvg;

    if (ratio < 0.95) return 0.5;
    if (ratio < 0.98) return 0.75;
    if (ratio > 1.02) return 1.1;
    return 1.0;
  } catch { return 1.0; }
}

// ── Spread Filter ─────────────────────────────────────────────────────────────

function checkSpread(symbol, bidAskSpread) {
  if (!bidAskSpread || bidAskSpread <= 0) return { allowed: true };
  const pip = PIP_SIZES[symbol] || 0.0001;
  const spreadPips = bidAskSpread / pip;
  const maxAllowed = MAX_SPREAD_PIPS[symbol] || 10;
  if (spreadPips > maxAllowed) {
    return { allowed: false, reason: `Spread too wide: ${spreadPips.toFixed(1)} pips (max: ${maxAllowed})` };
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

    for (const group of CORRELATION_GROUPS) {
      if (group.includes(symbol)) {
        const alreadyOpen = group.filter(s => s !== symbol && openSymbols.includes(s));
        if (alreadyOpen.length > 0) {
          return { allowed: false, reason: `Correlated pair already open: ${alreadyOpen.join(", ")}` };
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

    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const { data: weekTrades } = await supabaseAdmin
      .from("trades").select("profit")
      .eq("account_id", accountId).eq("status", "closed")
      .gte("close_time", weekAgo.toISOString());

    if (weekTrades?.length) {
      const weekPnL = weekTrades.reduce((s, t) => s + (t.profit || 0), 0);
      const weekLossPct = Math.abs(Math.min(0, weekPnL)) / account.balance * 100;
      const weekLimit = (account.max_daily_loss || 5) * 2.5;
      if (weekLossPct >= weekLimit) {
        return { allowed: false, reason: `Weekly loss limit: ${weekLossPct.toFixed(1)}% / ${weekLimit}%` };
      }
    }

    const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const { data: monthTrades } = await supabaseAdmin
      .from("trades").select("profit")
      .eq("account_id", accountId).eq("status", "closed")
      .gte("close_time", monthAgo.toISOString());

    if (monthTrades?.length) {
      const monthPnL = monthTrades.reduce((s, t) => s + (t.profit || 0), 0);
      const monthLossPct = Math.abs(Math.min(0, monthPnL)) / account.balance * 100;
      const monthLimit = (account.max_daily_loss || 5) * 6;
      if (monthLossPct >= monthLimit) {
        return { allowed: false, reason: `Monthly loss limit: ${monthLossPct.toFixed(1)}% / ${monthLimit}%` };
      }
    }

    return { allowed: true };
  } catch (e) { return { allowed: true }; }
}

// ── Circuit Breaker ───────────────────────────────────────────────────────────

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

  // Pair controls check
  if (symbol) {
    const pairCheck = await isPairEnabled(symbol);
    if (!pairCheck.allowed) {
      await log("info", "riskEngine", `Pair blocked: ${pairCheck.reason}`);
      return pairCheck;
    }
  }

  // Daily loss
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

// ── Trade Management ──────────────────────────────────────────────────────────

function calculateTrailingStop(direction, currentPrice, openPrice, stopLoss, atr, symbol) {
  const pip = PIP_SIZES[symbol] || 0.0001;
  const profitPips = direction === "BUY"
    ? (currentPrice - openPrice) / pip
    : (openPrice - currentPrice) / pip;

  if (profitPips < 20) return null;

  const trailDistance = atr * 1.5;
  let newSL;
  if (direction === "BUY") {
    newSL = currentPrice - trailDistance;
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

  if (profitPips < 15) return null;

  const breakEvenLevel = direction === "BUY"
    ? openPrice + (pip * 2)
    : openPrice - (pip * 2);

  if (direction === "BUY" && breakEvenLevel <= (stopLoss || 0)) return null;
  if (direction === "SELL" && breakEvenLevel >= (stopLoss || 999999)) return null;

  return parseFloat(breakEvenLevel.toFixed(5));
}

function calculatePartialCloseLevels(direction, entryPrice, stopLoss) {
  const risk = Math.abs(entryPrice - stopLoss);
  return {
    tp1: { price: direction === "BUY" ? entryPrice + risk : entryPrice - risk, closePercent: 33 },
    tp2: { price: direction === "BUY" ? entryPrice + risk * 2 : entryPrice - risk * 2, closePercent: 33 },
    tp3: { price: direction === "BUY" ? entryPrice + risk * 3 : entryPrice - risk * 3, closePercent: 34 }
  };
}

// ── ATR Helpers ───────────────────────────────────────────────────────────────

function calculateATR(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    tr.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    ));
  }
  return parseFloat((tr.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(5));
}

function calculateStopLoss({ direction, entryPrice, atr, symbol, multiplier = 1.5 }) {
  const pip = PIP_SIZES[symbol] || 0.0001;
  const stopPips = Math.round((atr / pip) * multiplier);
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
  isPairEnabled,
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