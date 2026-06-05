/**
 * AETHELGARD RISK ENGINE
 * Kelly Criterion + CVaR position sizing
 * Hard circuit breakers per account
 */

const { supabaseAdmin, log } = require("./supabase");

const PAIRS_PIP = {
  XAUUSD: 0.01,
  EURUSD: 0.0001,
  GBPUSD: 0.0001,
  USDJPY: 0.01,
};

const PAIRS_PIP_VALUE = {
  XAUUSD: 1.0,    // $1 per 0.01 move per 0.01 lot
  EURUSD: 1.0,    // $1 per pip per 0.01 lot (100k * 0.0001 * 0.01)
  GBPUSD: 1.0,
  USDJPY: 0.9,    // approx
};

/**
 * Calculate position size using fractional Kelly
 * f* = (μ/σ²) * (1 - CVaR/Capital)
 */
function calculatePositionSize({
  balance,
  riskPercent = 1.0,
  stopLossPips,
  symbol,
  winRate = 0.55,
  avgWin = 1.5,
  avgLoss = 1.0
}) {
  const riskAmount = (balance * riskPercent) / 100;

  // Kelly fraction (conservative half-Kelly)
  const kellyEdge = (winRate * avgWin - (1 - winRate) * avgLoss);
  const kellyF = Math.max(0, Math.min(kellyEdge / avgWin, 0.25)); // cap at 25%
  const halfKelly = kellyF * 0.5;

  // CVaR adjustment (simple: reduce if drawdown is already high)
  const cvarAdjustment = 1.0; // Will be dynamic once we have trade history

  // Base risk amount adjusted by Kelly
  const adjustedRisk = riskAmount * (0.5 + halfKelly) * cvarAdjustment;

  // Pip value calculation
  const pipValue = PAIRS_PIP_VALUE[symbol] || 1.0;
  const lotSize = adjustedRisk / (stopLossPips * pipValue * 100);

  // Round to valid lot steps (0.01 minimum)
  const roundedLot = Math.max(0.01, Math.round(lotSize * 100) / 100);

  // Hard cap: never risk more than 2% regardless
  const maxRisk = (balance * 2.0) / 100;
  const maxLot = maxRisk / (stopLossPips * pipValue * 100);
  const finalLot = Math.min(roundedLot, Math.max(0.01, Math.round(maxLot * 100) / 100));

  return {
    lotSize: finalLot,
    riskAmount: adjustedRisk,
    riskPercent: (adjustedRisk / balance) * 100,
    kellyFraction: halfKelly
  };
}

/**
 * Calculate ATR-based stop loss
 */
function calculateStopLoss({ direction, entryPrice, atr, symbol, multiplier = 1.5 }) {
  const pip = PAIRS_PIP[symbol] || 0.0001;
  const atrPips = atr / pip;
  const stopPips = Math.round(atrPips * multiplier);

  let stopLoss;
  if (direction === "BUY") {
    stopLoss = entryPrice - (stopPips * pip);
  } else {
    stopLoss = entryPrice + (stopPips * pip);
  }

  return { stopLoss: parseFloat(stopLoss.toFixed(5)), stopPips };
}

/**
 * Calculate take profit (RR ratio based)
 */
function calculateTakeProfit({ direction, entryPrice, stopLoss, rrRatio = 2.0 }) {
  const risk = Math.abs(entryPrice - stopLoss);
  const reward = risk * rrRatio;

  let takeProfit;
  if (direction === "BUY") {
    takeProfit = entryPrice + reward;
  } else {
    takeProfit = entryPrice - reward;
  }

  return parseFloat(takeProfit.toFixed(5));
}

/**
 * Circuit breaker check — should we allow trading?
 */
async function checkCircuitBreaker(accountId) {
  const { data: account } = await supabaseAdmin
    .from("mt5_accounts")
    .select("*")
    .eq("id", accountId)
    .single();

  if (!account) return { allowed: false, reason: "Account not found" };
  if (!account.is_active) return { allowed: false, reason: "Account disabled" };
  if (!account.is_connected) return { allowed: false, reason: "Account not connected" };

  // Check daily loss
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const { data: todayTrades } = await supabaseAdmin
    .from("trades")
    .select("profit")
    .eq("account_id", accountId)
    .eq("status", "closed")
    .gte("close_time", todayStart.toISOString());

  if (todayTrades && todayTrades.length > 0) {
    const dailyPnL = todayTrades.reduce((sum, t) => sum + (t.profit || 0), 0);
    const dailyLossPct = Math.abs(Math.min(0, dailyPnL)) / account.balance * 100;

    if (dailyLossPct >= account.max_daily_loss) {
      await log("warning", "riskEngine",
        `Circuit breaker triggered for ${accountId}: daily loss ${dailyLossPct.toFixed(2)}%`
      );
      return {
        allowed: false,
        reason: `Daily loss limit reached: ${dailyLossPct.toFixed(2)}% / ${account.max_daily_loss}%`
      };
    }
  }

  // Check max open trades
  const { data: openTrades } = await supabaseAdmin
    .from("trades")
    .select("id")
    .eq("account_id", accountId)
    .eq("status", "open");

  if (openTrades && openTrades.length >= account.max_trades) {
    return {
      allowed: false,
      reason: `Max open trades reached: ${openTrades.length}/${account.max_trades}`
    };
  }

  // Check global circuit breaker (1.5% equity drop in 60 min)
  const sixtyMinAgo = new Date(Date.now() - 60 * 60 * 1000);
  const { data: snapshot } = await supabaseAdmin
    .from("account_snapshots")
    .select("equity")
    .eq("account_id", accountId)
    .gte("snapshot_time", sixtyMinAgo.toISOString())
    .order("snapshot_time", { ascending: true })
    .limit(1)
    .single();

  if (snapshot && account.equity) {
    const equityDrop = ((snapshot.equity - account.equity) / snapshot.equity) * 100;
    if (equityDrop <= -1.5) {
      await log("critical", "riskEngine",
        `Hard circuit breaker: equity dropped ${Math.abs(equityDrop).toFixed(2)}% in 60min`
      );
      return {
        allowed: false,
        reason: `Hard circuit breaker: equity dropped ${Math.abs(equityDrop).toFixed(2)}% in 60min`
      };
    }
  }

  return { allowed: true };
}

/**
 * Simple ATR calculation from OHLCV bars
 */
function calculateATR(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;

  const trValues = [];
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevClose = bars[i - 1].close;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trValues.push(tr);
  }

  // Simple ATR (average of last `period` TRs)
  const recentTRs = trValues.slice(-period);
  const atr = recentTRs.reduce((a, b) => a + b, 0) / recentTRs.length;
  return parseFloat(atr.toFixed(5));
}

module.exports = {
  calculatePositionSize,
  calculateStopLoss,
  calculateTakeProfit,
  checkCircuitBreaker,
  calculateATR,
  PAIRS_PIP
};
