/**
 * AETHELGARD RISK ENGINE v4
 * backend/src/services/riskEngine.js
 *
 * Upgrades:
 * - Fully dynamic lot sizing from dashboard risk% setting
 * - Volatility spike detector (alert only, keep trading)
 * - ATR-based SL width (adapts to instrument volatility)
 * - Claude AI SL decision respected
 * - Tighter break-even (10 pips) and trailing (15 pips)
 * - Per-pair max open position check
 */

const { supabaseAdmin, log } = require("./supabase");

const PIP_SIZES = {
  GOLD: 0.01, EURUSD: 0.0001, GBPUSD: 0.0001, USDJPY: 0.01,
  US30Cash: 1.0, GER40Cash: 1.0, BTCUSD: 1.0,
  AUDUSD: 0.0001, USDCAD: 0.0001, USDCHF: 0.0001,
  NZDUSD: 0.0001, GBPJPY: 0.01, EURJPY: 0.01,
};

// Pip value in USD per standard lot (approximate)
const PIP_VALUES_USD = {
  GOLD: 1.0, EURUSD: 10, GBPUSD: 10, USDJPY: 9.1,
  US30Cash: 1.0, GER40Cash: 1.0, BTCUSD: 1.0,
  AUDUSD: 10, USDCAD: 7.5, USDCHF: 9.8,
  NZDUSD: 10, GBPJPY: 9.1, EURJPY: 9.1,
};

const CORRELATION_GROUPS = [
  ["EURUSD", "GBPUSD"],
  ["GOLD", "EURUSD"],
  ["US30Cash", "GER40Cash"],
  ["USDJPY", "EURJPY", "GBPJPY"],  // JPY pairs — don't stack
];

const MAX_SPREAD_PIPS = {
  GOLD: 150, EURUSD: 3, GBPUSD: 5, USDJPY: 3,
  US30Cash: 50, GER40Cash: 50, BTCUSD: 300,
  AUDUSD: 3, USDCAD: 4, USDCHF: 4,
  NZDUSD: 4, GBPJPY: 8, EURJPY: 6,
};

// ATR multiplier for SL calculation per instrument
// Higher = wider SL (more room to breathe), lower = tighter
const ATR_SL_MULTIPLIERS = {
  GOLD: 1.8,      // Gold needs room — high volatility
  BTCUSD: 2.0,    // Crypto very volatile
  US30Cash: 1.5,  // Indices moderate
  GER40Cash: 1.5,
  GBPJPY: 1.8,    // Cross pairs need room
  EURJPY: 1.6,
  USDJPY: 1.2,    // Tighter on JPY majors
  EURUSD: 1.2,
  GBPUSD: 1.3,
  USDCHF: 1.2,
  AUDUSD: 1.2,
  USDCAD: 1.2,
  NZDUSD: 1.2,
};

// ── Read Risk % from Platform Settings ───────────────────────────────────────

async function getRiskPercent() {
  try {
    const { data } = await supabaseAdmin
      .from("platform_settings")
      .select("value")
      .eq("key", "default_risk_percent")
      .single();
    const val = parseFloat(data?.value);
    return isNaN(val) ? 1.0 : Math.min(Math.max(val, 0.1), 5.0); // clamp 0.1-5%
  } catch {
    return 1.0; // fallback
  }
}

// ── Dynamic Lot Sizing ────────────────────────────────────────────────────────

async function calculateDynamicLotSize({ symbol, balance, stopLossPips, signalGrade = "B", positionSizeModifier = 1.0 }) {
  const riskPercent = await getRiskPercent();

  // Grade multiplier — better grade = slightly larger size
  const gradeMultiplier = { "A": 1.2, "B": 1.0, "C": 0.7, "D": 0.5 }[signalGrade] || 1.0;

  // Risk amount in USD
  const riskAmount = balance * (riskPercent / 100) * gradeMultiplier * positionSizeModifier;

  // Pip value per lot
  const pipValuePerLot = PIP_VALUES_USD[symbol] || 10;

  // Lot size = risk amount / (SL pips × pip value per lot)
  const rawLot = riskAmount / (stopLossPips * pipValuePerLot);

  // Conservative caps — never over-expose
  const maxLot = symbol === "BTCUSD" ? 0.05
    : ["US30Cash", "GER40Cash"].includes(symbol) ? 0.2
    : ["GOLD"].includes(symbol) ? 0.05
    : 0.05; // forex pairs max 0.05 lots until proven edge

  const finalLot = Math.min(
    Math.max(0.01, parseFloat(rawLot.toFixed(2))),
    maxLot
  );

  return {
    lotSize: finalLot,
    riskAmount: parseFloat(riskAmount.toFixed(2)),
    riskPercent,
    gradeMultiplier,
    stopLossPips: parseFloat(stopLossPips.toFixed(1))
  };
}

// Sync version for non-async contexts
function calculatePositionSize({ balance, riskPercent = 1.0, stopLossPips, symbol, signalGrade = "B", equityCurveMultiplier = 1.0 }) {
  const gradeMultiplier = { "A": 1.2, "B": 1.0, "C": 0.7, "D": 0.5 }[signalGrade] || 1.0;
  const riskAmount = balance * (riskPercent / 100) * gradeMultiplier * equityCurveMultiplier;
  const pipValuePerLot = PIP_VALUES_USD[symbol] || 10;
  const rawLot = riskAmount / (stopLossPips * pipValuePerLot);
  const maxLot = ["BTCUSD"].includes(symbol) ? 0.05
    : ["US30Cash","GER40Cash"].includes(symbol) ? 0.2
    : ["GOLD"].includes(symbol) ? 0.05
    : 0.05;
  return {
    lotSize: Math.min(Math.max(0.01, parseFloat(rawLot.toFixed(2))), maxLot),
    riskAmount: parseFloat(riskAmount.toFixed(2)),
    riskPercent,
    gradeMultiplier,
    equityCurveMultiplier
  };
}

// ── ATR-Based Structural SL ───────────────────────────────────────────────────

function calculateATRStopLoss(direction, currentPrice, indicators, atrVal, symbol) {
  const pip = PIP_SIZES[symbol] || 0.0001;
  const multiplier = ATR_SL_MULTIPLIERS[symbol] || 1.3;

  let stopLoss;
  if (direction === "BUY") {
    // Place below nearest OB or recent swing low
    const ob = indicators?.obs?.find(o => o.type === "BULLISH_OB");
    const swingLow = indicators?.recentLow || (currentPrice - atrVal * multiplier);
    const obSL = ob ? ob.low - atrVal * 0.3 : null;

    // Use tighter of OB-based or ATR-based
    if (obSL && obSL > swingLow - atrVal * 0.5) {
      stopLoss = obSL;
    } else {
      stopLoss = currentPrice - atrVal * multiplier;
    }

    // Minimum 1x ATR distance
    if (currentPrice - stopLoss < atrVal) stopLoss = currentPrice - atrVal;

  } else {
    const ob = indicators?.obs?.find(o => o.type === "BEARISH_OB");
    const swingHigh = indicators?.recentHigh || (currentPrice + atrVal * multiplier);
    const obSL = ob ? ob.high + atrVal * 0.3 : null;

    if (obSL && obSL < swingHigh + atrVal * 0.5) {
      stopLoss = obSL;
    } else {
      stopLoss = currentPrice + atrVal * multiplier;
    }

    if (stopLoss - currentPrice < atrVal) stopLoss = currentPrice + atrVal;
  }

  const slPips = Math.abs(currentPrice - stopLoss) / pip;
  return {
    stopLoss: parseFloat(stopLoss.toFixed(5)),
    slPips: parseFloat(slPips.toFixed(1))
  };
}

// ── Volatility Spike Detector ─────────────────────────────────────────────────

async function checkVolatilitySpike(symbol, currentATR, historicalATR) {
  if (!currentATR || !historicalATR) return { spiked: false };

  const ratio = currentATR / historicalATR;

  // Alert if ATR expanded more than 2.5x normal
  if (ratio >= 2.5) {
    const msg = `⚠️ VOLATILITY SPIKE: ${symbol} ATR is ${ratio.toFixed(1)}x normal (${currentATR.toFixed(5)} vs avg ${historicalATR.toFixed(5)}) — possible high-impact news event`;
    await log("warning", "riskEngine", msg);

    // Store alert in platform_settings for dashboard display
    await supabaseAdmin.from("platform_settings").upsert({
      key: "volatility_alert",
      value: JSON.stringify({
        symbol,
        ratio: parseFloat(ratio.toFixed(2)),
        message: msg,
        time: new Date().toISOString()
      }),
      updated_at: new Date().toISOString()
    }, { onConflict: "key" });

    return {
      spiked: true,
      ratio,
      message: msg,
      // Alert only — keep trading
      blockTrade: false
    };
  }

  return { spiked: false };
}

// ── Pair Controls ─────────────────────────────────────────────────────────────

async function isPairEnabled(symbol) {
  try {
    const { data } = await supabaseAdmin
      .from("pair_controls")
      .select("enabled, auto_halted, auto_halt_reason, max_daily_loss_usd, max_trades_per_day")
      .eq("symbol", symbol)
      .single();

    if (!data) return { allowed: true };
    if (!data.enabled) return { allowed: false, reason: `${symbol} manually halted` };
    if (data.auto_halted) return { allowed: false, reason: `${symbol} auto-halted: ${data.auto_halt_reason}` };

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // ── Fix 1: Max trades per day — count ALL trades (open + closed) opened today
    // BUG WAS: check was nested inside "if (closedTrades.length)" so it was skipped
    // entirely when all trades were still open — causing 100+ trades to fire per pair.
    const maxTrades = data.max_trades_per_day || 5;
    const { data: allTodayTrades } = await supabaseAdmin
      .from("trades").select("id, profit, status")
      .eq("symbol", symbol)
      .gte("open_time", todayStart.toISOString());

    const totalTodayCount = allTodayTrades?.length || 0;
    if (totalTodayCount >= maxTrades) {
      await log("info", "riskEngine", `${symbol} max trades/day reached: ${totalTodayCount}/${maxTrades}`);
      return { allowed: false, reason: `${symbol} max ${maxTrades} trades/day reached (${totalTodayCount} opened today)` };
    }

    // ── Fix 2: Daily loss check — only closed (realised) P&L
    const closedTodayTrades = (allTodayTrades || []).filter(t => t.status === "closed");
    if (closedTodayTrades.length) {
      const dailyPnL = closedTodayTrades.reduce((s, t) => s + (t.profit || 0), 0);
      const maxLoss = data.max_daily_loss_usd || 10;
      if (dailyPnL <= -maxLoss) {
        await supabaseAdmin.from("pair_controls").update({
          auto_halted: true,
          auto_halt_reason: `Daily loss $${Math.abs(dailyPnL).toFixed(2)} exceeded limit $${maxLoss}`,
          updated_at: new Date().toISOString()
        }).eq("symbol", symbol);
        await log("warning", "riskEngine", `${symbol} auto-halted: daily loss $${Math.abs(dailyPnL).toFixed(2)}`);
        return { allowed: false, reason: `${symbol} daily loss limit reached` };
      }
    }

    return { allowed: true };
  } catch (e) {
    await log("error", "riskEngine", `isPairEnabled error ${symbol}: ${e.message}`);
    return { allowed: true }; // fail open
  }
}

// ── Equity Curve Multiplier ───────────────────────────────────────────────────

async function getEquityCurveMultiplier(accountId) {
  try {
    const { data: snapshots } = await supabaseAdmin
      .from("account_snapshots")
      .select("equity")
      .eq("account_id", accountId)
      .order("snapshot_time", { ascending: false })
      .limit(20);

    if (!snapshots || snapshots.length < 5) return 1.0;
    const equities = snapshots.map(s => s.equity).reverse();
    const recent = equities.slice(-5);
    const older = equities.slice(0, -5);
    if (!older.length) return 1.0;
    const recentAvg = recent.reduce((a,b)=>a+b,0) / recent.length;
    const olderAvg  = older.reduce((a,b)=>a+b,0)  / older.length;
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
    return { allowed: false, reason: `Spread ${spreadPips.toFixed(1)} pips > max ${maxAllowed}` };
  }
  return { allowed: true, spreadPips: spreadPips.toFixed(1) };
}

// ── Correlation Filter ────────────────────────────────────────────────────────

async function checkCorrelation(symbol, accountId) {
  try {
    const { data: openTrades } = await supabaseAdmin
      .from("trades").select("symbol")
      .eq("account_id", accountId).eq("status", "open");
    if (!openTrades?.length) return { allowed: true };
    const openSymbols = openTrades.map(t => t.symbol);
    for (const group of CORRELATION_GROUPS) {
      if (group.includes(symbol)) {
        const alreadyOpen = group.filter(s => s !== symbol && openSymbols.includes(s));
        if (alreadyOpen.length > 0) {
          return { allowed: false, reason: `Correlated pair open: ${alreadyOpen.join(", ")}` };
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

    const weekAgo = new Date(Date.now() - 7*24*60*60*1000);
    const { data: weekTrades } = await supabaseAdmin
      .from("trades").select("profit")
      .eq("account_id", accountId).eq("status", "closed")
      .gte("close_time", weekAgo.toISOString());
    if (weekTrades?.length) {
      const weekPnL = weekTrades.reduce((s,t)=>s+(t.profit||0),0);
      const weekLossPct = Math.abs(Math.min(0, weekPnL)) / account.balance * 100;
      const weekLimit = (account.max_daily_loss || 5) * 2.5;
      if (weekLossPct >= weekLimit)
        return { allowed: false, reason: `Weekly loss limit: ${weekLossPct.toFixed(1)}%` };
    }

    const monthAgo = new Date(Date.now() - 30*24*60*60*1000);
    const { data: monthTrades } = await supabaseAdmin
      .from("trades").select("profit")
      .eq("account_id", accountId).eq("status", "closed")
      .gte("close_time", monthAgo.toISOString());
    if (monthTrades?.length) {
      const monthPnL = monthTrades.reduce((s,t)=>s+(t.profit||0),0);
      const monthLossPct = Math.abs(Math.min(0, monthPnL)) / account.balance * 100;
      const monthLimit = (account.max_daily_loss || 5) * 6;
      if (monthLossPct >= monthLimit)
        return { allowed: false, reason: `Monthly loss limit: ${monthLossPct.toFixed(1)}%` };
    }
    return { allowed: true };
  } catch { return { allowed: true }; }
}

// ── Circuit Breaker ───────────────────────────────────────────────────────────

async function checkCircuitBreaker(accountId, symbol = null, spread = null) {
  const { data: account } = await supabaseAdmin
    .from("mt5_accounts").select("*").eq("id", accountId).single();
  if (!account) return { allowed: false, reason: "Account not found" };
  if (!account.is_active) return { allowed: false, reason: "Account disabled" };
  if (!account.is_connected) return { allowed: false, reason: "Account not connected" };

  if (symbol && spread !== null) {
    const spreadCheck = checkSpread(symbol, spread);
    if (!spreadCheck.allowed) return spreadCheck;
  }

  if (symbol) {
    const pairCheck = await isPairEnabled(symbol);
    if (!pairCheck.allowed) return pairCheck;
  }

  // Read circuit breaker % from platform settings
  let cbPct = 5.0;
  try {
    const { data: cbSetting } = await supabaseAdmin
      .from("platform_settings").select("value")
      .eq("key", "circuit_breaker_daily_loss_pct").single();
    cbPct = parseFloat(cbSetting?.value) || 5.0;
  } catch {}

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const { data: todayTrades } = await supabaseAdmin
    .from("trades").select("profit")
    .eq("account_id", accountId).eq("status", "closed")
    .gte("close_time", todayStart.toISOString());

  if (todayTrades?.length) {
    const dailyPnL = todayTrades.reduce((s,t)=>s+(t.profit||0),0);
    const dailyLossPct = Math.abs(Math.min(0, dailyPnL)) / account.balance * 100;
    if (dailyLossPct >= cbPct) {
      await log("warning", "riskEngine", `Daily CB triggered: ${dailyLossPct.toFixed(1)}%`);
      return { allowed: false, reason: `Daily circuit breaker: ${dailyLossPct.toFixed(1)}%` };
    }
  }

  const extCheck = await checkExtendedLossLimits(accountId);
  if (!extCheck.allowed) { await log("warning", "riskEngine", extCheck.reason); return extCheck; }

  // Read max concurrent trades from platform settings
  let maxTrades = 5;
  try {
    const { data: maxSetting } = await supabaseAdmin
      .from("platform_settings").select("value")
      .eq("key", "max_concurrent_trades").single();
    maxTrades = parseInt(maxSetting?.value) || 5;
  } catch {}

  const { data: openTrades } = await supabaseAdmin
    .from("trades").select("id").eq("account_id", accountId).eq("status", "open");
  if ((openTrades?.length || 0) >= maxTrades) {
    return { allowed: false, reason: `Max concurrent trades: ${openTrades.length}/${maxTrades}` };
  }

  // Hard circuit breaker — 2% equity drop in 60 min
  const sixtyMinAgo = new Date(Date.now() - 60*60*1000);
  const { data: snapshot } = await supabaseAdmin
    .from("account_snapshots").select("equity")
    .eq("account_id", accountId).gte("snapshot_time", sixtyMinAgo.toISOString())
    .order("snapshot_time", { ascending: true }).limit(1).single();
  if (snapshot && account.equity) {
    const drop = ((snapshot.equity - account.equity) / snapshot.equity) * 100;
    if (drop <= -2.0) {
      await log("critical", "riskEngine", `Hard CB: ${Math.abs(drop).toFixed(2)}% drop in 60min`);
      return { allowed: false, reason: `Circuit breaker: ${Math.abs(drop).toFixed(2)}% drop in 60min` };
    }
  }

  return { allowed: true };
}

// ── Trade Management — Tighter Settings ──────────────────────────────────────

function calculateTrailingStop(direction, currentPrice, openPrice, stopLoss, atr, symbol) {
  const pip = PIP_SIZES[symbol] || 0.0001;
  const profitPips = direction === "BUY"
    ? (currentPrice - openPrice) / pip
    : (openPrice - currentPrice) / pip;

  // Trailing activates at 15 pips (reduced from 20)
  if (profitPips < 15) return null;

  const trailDistance = atr * 1.2; // tighter trail
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

  // Break-even at 10 pips (reduced from 15)
  if (profitPips < 10) return null;

  const breakEvenLevel = direction === "BUY"
    ? openPrice + (pip * 3)   // entry + 3 pips (small profit lock)
    : openPrice - (pip * 3);

  if (direction === "BUY" && breakEvenLevel <= (stopLoss || 0)) return null;
  if (direction === "SELL" && breakEvenLevel >= (stopLoss || 999999)) return null;
  return parseFloat(breakEvenLevel.toFixed(5));
}

function calculatePartialCloseLevels(direction, entryPrice, stopLoss) {
  const risk = Math.abs(entryPrice - stopLoss);
  return {
    tp1: { price: direction === "BUY" ? entryPrice + risk * 1.0 : entryPrice - risk * 1.0, closePercent: 33 },
    tp2: { price: direction === "BUY" ? entryPrice + risk * 2.0 : entryPrice - risk * 2.0, closePercent: 33 },
    tp3: { price: direction === "BUY" ? entryPrice + risk * 3.0 : entryPrice - risk * 3.0, closePercent: 34 }
  };
}

// ── ATR Helpers ───────────────────────────────────────────────────────────────

function calculateATR(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    tr.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i-1].close),
      Math.abs(bars[i].low - bars[i-1].close)
    ));
  }
  return parseFloat((tr.slice(-period).reduce((a,b)=>a+b,0)/period).toFixed(5));
}

function calculateStopLoss({ direction, entryPrice, atr, symbol, multiplier }) {
  const pip = PIP_SIZES[symbol] || 0.0001;
  const mult = multiplier || ATR_SL_MULTIPLIERS[symbol] || 1.3;
  const stopLoss = direction === "BUY"
    ? entryPrice - atr * mult
    : entryPrice + atr * mult;
  const stopPips = Math.abs(entryPrice - stopLoss) / pip;
  return { stopLoss: parseFloat(stopLoss.toFixed(5)), stopPips: parseFloat(stopPips.toFixed(1)) };
}

function calculateTakeProfit({ direction, entryPrice, stopLoss, rrRatio = 2.0 }) {
  const risk = Math.abs(entryPrice - stopLoss);
  const tp = direction === "BUY" ? entryPrice + risk * rrRatio : entryPrice - risk * rrRatio;
  return parseFloat(tp.toFixed(5));
}

module.exports = {
  calculateDynamicLotSize,
  calculatePositionSize,
  calculateATRStopLoss,
  checkVolatilitySpike,
  isPairEnabled,
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
  getRiskPercent,
  ATR_SL_MULTIPLIERS,
  PIP_SIZES,
};
