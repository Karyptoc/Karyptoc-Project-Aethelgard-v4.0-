/**
 * AETHELGARD - Backtest Route (REBUILT)
 * backend/src/routes/backtest.js
 *
 * FIX: this used to run its own simplified, standalone strategy
 * simulation (analyzeBar/runBacktest) that was materially different from
 * what's actually live in signalEngine.js. This version walks real
 * historical H4/D1/W1 bars and calls the SAME functions signalEngine.js
 * uses live, from signalCore.js and riskEngine.js.
 */

const express = require("express");
const router = express.Router();
const { supabaseAdmin, log } = require("../services/supabase");
const { verifyToken } = require("../middleware/auth");
const core = require("../services/signalCore");
const riskEngine = require("../services/riskEngine");

const ASSUMED_SPREAD_PIPS = {
  GOLD: 25, EURUSD: 1.2, GBPUSD: 1.8, USDJPY: 1.2,
  US30Cash: 200, GER40Cash: 150, BTCUSD: 3000,
  AUDUSD: 1.5, USDCAD: 1.8, USDCHF: 1.8,
  NZDUSD: 2.0, GBPJPY: 3.0, EURJPY: 2.0,
};

router.post("/cache", async (req, res) => {
  const secret = req.headers["x-bridge-secret"];
  if (!secret || secret !== process.env.BRIDGE_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const { symbol, timeframe, bars } = req.body;
    if (!symbol || !timeframe || !bars?.length) {
      return res.status(400).json({ error: "symbol, timeframe, bars required" });
    }
    const rows = bars.map(b => ({
      symbol, timeframe, time: b.time,
      open: b.open, high: b.high, low: b.low, close: b.close,
      volume: b.volume || 0
    }));
    const { error } = await supabaseAdmin
      .from("ohlcv_cache")
      .upsert(rows, { onConflict: "symbol,timeframe,time", ignoreDuplicates: true });
    if (error) throw error;
    res.json({ ok: true, stored: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function fetchCachedBars(symbol, timeframe, fromDate = null) {
  let query = supabaseAdmin
    .from("ohlcv_cache")
    .select("time, open, high, low, close, volume")
    .eq("symbol", symbol)
    .eq("timeframe", timeframe)
    .order("time", { ascending: true });
  if (fromDate) query = query.gte("time", fromDate);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(b => ({
    time: b.time,
    open: parseFloat(b.open), high: parseFloat(b.high),
    low: parseFloat(b.low), close: parseFloat(b.close),
    volume: parseInt(b.volume) || 0
  }));
}

router.get("/availability", verifyToken, async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from("ohlcv_cache")
      .select("symbol, timeframe, time")
      .order("time", { ascending: false });
    const map = {};
    (data || []).forEach(row => {
      const key = `${row.symbol}_${row.timeframe}`;
      if (!map[key]) map[key] = { symbol: row.symbol, timeframe: row.timeframe, latest: row.time, count: 0 };
      map[key].count++;
    });
    res.json({ availability: Object.values(map) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/run", verifyToken, async (req, res) => {
  try {
    const { symbol, days = 30, initial_balance = 1000, risk_percent = 1.0 } = req.body;
    if (!symbol) return res.status(400).json({ error: "symbol required" });

    const fromDate = new Date(Date.now() - (days + 120) * 24 * 60 * 60 * 1000).toISOString();
    const [h4Bars, d1Bars, w1Bars] = await Promise.all([
      fetchCachedBars(symbol, "H4", fromDate),
      fetchCachedBars(symbol, "D1"),
      fetchCachedBars(symbol, "W1"),
    ]);

    if (h4Bars.length < 100) {
      return res.status(400).json({
        error: `Insufficient H4 data: need 100+ bars, got ${h4Bars.length} for ${symbol}.`
      });
    }
    if (d1Bars.length < 30 || w1Bars.length < 20) {
      await log("info", "backtest", `${symbol}: limited D1/W1 history — HTF alignment weaker until more accumulates.`);
    }

    const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = runBacktest(symbol, h4Bars, d1Bars, w1Bars, {
      initialBalance: initial_balance, riskPercent: risk_percent, windowStart,
    });

    await log("info", "backtest",
      `Complete (rebuilt engine): ${symbol} | ${result.summary.total_trades} trades | WR:${result.summary.win_rate}% | PF:${result.summary.profit_factor}`);

    res.json({ ok: true, symbol, timeframe: "H4", days, bars_used: h4Bars.length, engine_version: "v2_shared_core", ...result });
  } catch (e) {
    await log("error", "backtest", `Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

function runBacktest(symbol, h4Bars, d1Bars, w1Bars, params) {
  const { initialBalance = 1000, riskPercent = 1.0, windowStart } = params;
  const pipSize = core.PIP_SIZES[symbol] || 0.0001;
  const spreadPips = ASSUMED_SPREAD_PIPS[symbol] || 2.0;

  let balance = initialBalance;
  let peakBalance = initialBalance;
  let maxDrawdown = 0;
  const trades = [];
  const equityCurve = [{ time: h4Bars[0]?.time, equity: balance }];

  const LOOKBACK = 60;
  const MAX_HOLD_BARS = 60;
  let lastTradeExitIndex = -1;

  for (let i = LOOKBACK; i < h4Bars.length - 1; i++) {
    const bar = h4Bars[i];
    const barTime = new Date(bar.time);
    if (barTime < windowStart) continue;
    if (i <= lastTradeExitIndex) continue;

    const session = core.getSessionInfo(barTime);
    if (session.session === "WEEKEND" || session.session === "DEAD_ZONE") continue;

    const news = core.isNewsBlackout(barTime);
    if (news.blocked) continue;

    const isPairActive = core.isPairActiveInSession(symbol, session.session);
    const sessionThreshold = (session.sessQuality >= 2) ? 0.2 : 0.4;
    if (!isPairActive && session.strength < sessionThreshold) continue;
    if (!session.killZone) continue;

    const primaryBars = h4Bars.slice(Math.max(0, i - 200 + 1), i + 1);
    const currentATR = core.atrCalc(primaryBars, 14);
    const ind = core.getIndicators(primaryBars, currentATR);
    if (!ind) continue;

    const d1Window = d1Bars.filter(b => new Date(b.time) <= barTime).slice(-100);
    const w1Window = w1Bars.filter(b => new Date(b.time) <= barTime).slice(-60);
    const htfBias = core.getHTFBias(primaryBars, d1Window.length ? d1Window : null, w1Window.length ? w1Window : null);

    const adrStatus = core.getADRStatus(primaryBars, d1Window, symbol);
    if (adrStatus.exhausted) continue;

    const sweep = core.detectLiquiditySweep(primaryBars, 15);
    const displacement = currentATR ? core.detectDisplacement(primaryBars, currentATR) : null;
    const fvgs = ind.fvgs || [];
    const obs = ind.obs || [];
    const retestDirection = sweep?.direction || (htfBias.bias === "bullish" ? "BUY" : "SELL");
    const retest = core.checkRetest(primaryBars, fvgs, obs, retestDirection);
    const eqLiquidity = currentATR ? core.detectEqualHighsLows(primaryBars, currentATR) : null;
    const strength = currentATR ? core.calculateStrength(primaryBars, currentATR) : null;
    const pdZone = core.getPremiumDiscount(primaryBars);

    const ictSequence = {
      sweep, displacement, retest,
      eqLiquidity: (eqLiquidity?.eqh?.length > 0 || eqLiquidity?.eql?.length > 0) ? eqLiquidity : null,
      strength, pdZone,
      hasFullSequence: !!(sweep && displacement && retest),
      hasPartialSequence: !!(sweep && displacement)
    };

    ind.direction = retestDirection;
    const confluence = core.scoreConfluence(ind, session, htfBias, isPairActive, ictSequence);

    let minScore;
    if (ictSequence.hasFullSequence) minScore = 30;
    else if (ictSequence.hasPartialSequence) minScore = 33;
    else if (session.killZone && isPairActive) minScore = 35;
    else if (session.killZone) minScore = 38;
    else minScore = 42;

    if (confluence.score < minScore) continue;

    const analysis = core.makePureMathDecision(confluence, htfBias, ictSequence, ind, session);
    if (analysis.direction === "HOLD") continue;

    const sltp = core.calculateStructuralSLTP(
      analysis.direction, bar.close, ind, currentATR, symbol, ictSequence, analysis.reward_risk_ratio
    );
    if (!sltp.stopLoss || !sltp.takeProfit) continue;

    const sizing = riskEngine.calculatePositionSize({
      balance,
      riskPercent: riskPercent * (analysis.position_size_modifier || 1.0),
      stopLossPips: sltp.slPips,
      symbol,
      signalGrade: confluence.grade,
    });

    const pipValuePerLot = { GOLD: 1, BTCUSD: 1, US30Cash: 1, GER40Cash: 1 }[symbol] || 10;
    const spreadCost = spreadPips * pipValuePerLot * sizing.lotSize;

    const entryPrice = bar.close;
    let currentSL = sltp.stopLoss;
    let remainingLots = sizing.lotSize;
    let realizedPnl = -spreadCost;
    let outcome = null;
    let exitIndex = i;
    let exitPrice = null;

    for (let j = i + 1; j < Math.min(i + 1 + MAX_HOLD_BARS, h4Bars.length); j++) {
      const fb = h4Bars[j];
      exitIndex = j;

      const hitSL = analysis.direction === "BUY" ? fb.low <= currentSL : fb.high >= currentSL;
      const hitTP = analysis.direction === "BUY" ? fb.high >= sltp.takeProfit : fb.low <= sltp.takeProfit;

      if (hitSL) {
        const lossPips = Math.abs(entryPrice - currentSL) / pipSize;
        realizedPnl += -lossPips * pipValuePerLot * remainingLots;
        outcome = realizedPnl >= 0 ? "WIN" : "LOSS";
        exitPrice = currentSL;
        break;
      }
      if (hitTP) {
        const winPips = Math.abs(sltp.takeProfit - entryPrice) / pipSize;
        realizedPnl += winPips * pipValuePerLot * remainingLots;
        outcome = "WIN";
        exitPrice = sltp.takeProfit;
        break;
      }

      const recentBars = h4Bars.slice(Math.max(0, j - 5), j + 1);
      const mgmt = riskEngine.calculateAsymmetricPartialTP(
        analysis.direction, entryPrice, fb.close, currentSL, currentATR, recentBars
      );

      if (mgmt.action === "partial_close" && mgmt.closePercent > 0) {
        const closingLots = remainingLots * (mgmt.closePercent / 100);
        const gainPips = analysis.direction === "BUY"
          ? (fb.close - entryPrice) / pipSize
          : (entryPrice - fb.close) / pipSize;
        realizedPnl += gainPips * pipValuePerLot * closingLots;
        remainingLots -= closingLots;
        if (mgmt.newSL) currentSL = mgmt.newSL;
      } else if ((mgmt.action === "move_to_be" || mgmt.action === "tighten_trail") && mgmt.newSL) {
        currentSL = mgmt.newSL;
      }

      if (remainingLots <= 0.001) {
        outcome = realizedPnl >= 0 ? "WIN" : "LOSS";
        exitPrice = fb.close;
        break;
      }
    }

    if (outcome === null) {
      const lastBar = h4Bars[Math.min(i + MAX_HOLD_BARS, h4Bars.length - 1)];
      exitPrice = lastBar.close;
      const gainPips = analysis.direction === "BUY"
        ? (exitPrice - entryPrice) / pipSize
        : (entryPrice - exitPrice) / pipSize;
      realizedPnl += gainPips * pipValuePerLot * remainingLots;
      outcome = realizedPnl >= 0 ? "WIN" : "LOSS";
    }

    realizedPnl = parseFloat(realizedPnl.toFixed(2));
    balance += realizedPnl;
    if (balance > peakBalance) peakBalance = balance;
    const dd = ((peakBalance - balance) / peakBalance) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
    lastTradeExitIndex = exitIndex;

    trades.push({
      entry_time: bar.time,
      exit_time: h4Bars[Math.min(exitIndex, h4Bars.length - 1)].time,
      direction: analysis.direction,
      entry_price: parseFloat(entryPrice.toFixed(5)),
      stop_loss: parseFloat(sltp.stopLoss.toFixed(5)),
      take_profit: parseFloat(sltp.takeProfit.toFixed(5)),
      exit_price: exitPrice ? parseFloat(exitPrice.toFixed(5)) : null,
      lot_size: sizing.lotSize,
      pnl: realizedPnl,
      outcome,
      grade: confluence.grade,
      score: confluence.score,
      session: session.name,
      kill_zone: session.killZone,
      htf_bias: htfBias.bias,
      htf_full_alignment: htfBias.fullAlignment,
      ict_full_sequence: ictSequence.hasFullSequence,
      spread_cost: parseFloat(spreadCost.toFixed(2)),
      balance_after: parseFloat(balance.toFixed(2))
    });

    equityCurve.push({
      time: h4Bars[Math.min(exitIndex, h4Bars.length - 1)].time,
      equity: parseFloat(balance.toFixed(2))
    });
  }

  const winners = trades.filter(t => t.outcome === "WIN");
  const losers = trades.filter(t => t.outcome === "LOSS");
  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));

  const bySession = {};
  trades.forEach(t => {
    if (!bySession[t.session]) bySession[t.session] = { trades: 0, wins: 0, pnl: 0 };
    bySession[t.session].trades++;
    if (t.outcome === "WIN") bySession[t.session].wins++;
    bySession[t.session].pnl += t.pnl;
  });

  const byGrade = {};
  trades.forEach(t => {
    if (!byGrade[t.grade]) byGrade[t.grade] = { trades: 0, wins: 0, pnl: 0 };
    byGrade[t.grade].trades++;
    if (t.outcome === "WIN") byGrade[t.grade].wins++;
    byGrade[t.grade].pnl += t.pnl;
  });

  const htfAligned = trades.filter(t => t.htf_full_alignment);
  const htfNotAligned = trades.filter(t => !t.htf_full_alignment);

  return {
    summary: {
      total_trades: trades.length,
      winners: winners.length,
      losers: losers.length,
      win_rate: trades.length > 0 ? parseFloat((winners.length / trades.length * 100).toFixed(1)) : 0,
      profit_factor: grossLoss > 0 ? parseFloat((grossProfit / grossLoss).toFixed(2)) : null,
      total_pnl: parseFloat((balance - initialBalance).toFixed(2)),
      gross_profit: parseFloat(grossProfit.toFixed(2)),
      gross_loss: parseFloat(grossLoss.toFixed(2)),
      initial_balance: initialBalance,
      final_balance: parseFloat(balance.toFixed(2)),
      max_drawdown_pct: parseFloat(maxDrawdown.toFixed(2)),
      avg_win: winners.length > 0 ? parseFloat((grossProfit / winners.length).toFixed(2)) : 0,
      avg_loss: losers.length > 0 ? parseFloat((grossLoss / losers.length).toFixed(2)) : 0,
      total_spread_cost: parseFloat(trades.reduce((s, t) => s + (t.spread_cost || 0), 0).toFixed(2)),
      htf_aligned_trades: htfAligned.length,
      htf_aligned_win_rate: htfAligned.length > 0
        ? parseFloat((htfAligned.filter(t => t.outcome === "WIN").length / htfAligned.length * 100).toFixed(1)) : null,
      htf_not_aligned_win_rate: htfNotAligned.length > 0
        ? parseFloat((htfNotAligned.filter(t => t.outcome === "WIN").length / htfNotAligned.length * 100).toFixed(1)) : null,
    },
    by_session: bySession,
    by_grade: byGrade,
    trades: trades.slice(-100),
    equity_curve: equityCurve
  };
}

module.exports = router;
