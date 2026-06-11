/**
 * AETHELGARD - Backtest Cache Route
 * backend/src/routes/backtest.js (add to existing backtest route)
 * Receives OHLCV data from bridge and stores for backtesting
 */

const express = require("express");
const router = express.Router();
const { supabaseAdmin, log } = require("../services/supabase");
const { verifyToken } = require("../middleware/auth");

function verifyBridgeSecret(req, res, next) {
  const secret = req.headers["x-bridge-secret"];
  if (secret && secret === process.env.BRIDGE_SECRET) return next();
  // Also allow authenticated users
  verifyToken(req, res, next);
}

// POST /api/backtest/cache — bridge stores OHLCV bars
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

    // Upsert bars — ignore duplicates
    const rows = bars.map(b => ({
      symbol,
      timeframe,
      time: b.time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
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

// POST /api/backtest/run — run backtest
router.post("/run", verifyToken, async (req, res) => {
  try {
    const {
      symbol,
      timeframe = "H1",
      days = 30,
      initial_balance = 1000,
      risk_percent = 1.0,
      min_confluence = 35,
      kill_zone_only = false
    } = req.body;

    if (!symbol) return res.status(400).json({ error: "symbol required" });

    const PIP_SIZES = {
      GOLD: 0.01, EURUSD: 0.0001, GBPUSD: 0.0001, USDJPY: 0.01,
      US30Cash: 1.0, GER40Cash: 1.0, BTCUSD: 1.0,
      AUDUSD: 0.0001, USDCAD: 0.0001, USDCHF: 0.0001,
      NZDUSD: 0.0001, GBPJPY: 0.01, EURJPY: 0.01
    };
    const pipSize = PIP_SIZES[symbol] || 0.0001;

    const fromDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data: ohlcvData, error } = await supabaseAdmin
      .from("ohlcv_cache")
      .select("time, open, high, low, close, volume")
      .eq("symbol", symbol)
      .eq("timeframe", timeframe)
      .gte("time", fromDate)
      .order("time", { ascending: true });

    if (error) throw error;

    if (!ohlcvData || ohlcvData.length < 100) {
      return res.status(400).json({
        error: `Insufficient data: need 100+ bars, got ${ohlcvData?.length || 0} for ${symbol} ${timeframe}. Keep the bridge running to collect more data.`
      });
    }

    // Parse numeric fields
    const bars = ohlcvData.map(b => ({
      time: b.time,
      open: parseFloat(b.open),
      high: parseFloat(b.high),
      low: parseFloat(b.low),
      close: parseFloat(b.close),
      volume: parseInt(b.volume) || 0
    }));

    await log("info", "backtest", `Running: ${symbol} ${timeframe} | ${bars.length} bars | ${days}d`);

    const result = runBacktest(bars, {
      initialBalance: initial_balance,
      riskPercent: risk_percent,
      minConfluence: min_confluence,
      killZoneOnly: kill_zone_only,
      pipSize
    });

    await log("info", "backtest",
      `Complete: ${symbol} | ${result.summary.total_trades} trades | WR:${result.summary.win_rate}% | PF:${result.summary.profit_factor}`
    );

    res.json({ ok: true, symbol, timeframe, days, bars_used: bars.length, ...result });
  } catch (e) {
    await log("error", "backtest", `Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/backtest/availability
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

// ── Backtest Engine ───────────────────────────────────────────────────────────

function ema(data, period) {
  if (data.length < period) return data[data.length - 1];
  const k = 2 / (period + 1);
  let val = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) val = data[i] * k + val * (1 - k);
  return val;
}

function rsi(data, period = 14) {
  if (data.length < period + 1) return 50;
  let gains = 0, losses = 0;
  const slice = data.slice(-(period + 1));
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function atrCalc(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    tr.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i-1].close),
      Math.abs(bars[i].low - bars[i-1].close)
    ));
  }
  return tr.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function detectBOS(bars) {
  if (!bars || bars.length < 20) return null;
  const r = bars.slice(-20);
  let hi = -Infinity, lo = Infinity;
  for (let i = 1; i < r.length - 1; i++) {
    if (r[i].high > r[i-1].high && r[i].high > r[i+1].high) hi = Math.max(hi, r[i].high);
    if (r[i].low < r[i-1].low && r[i].low < r[i+1].low) lo = Math.min(lo, r[i].low);
  }
  const c = bars[bars.length-1].close;
  if (c > hi && hi > -Infinity) return { type: "BULLISH_BOS", level: hi };
  if (c < lo && lo < Infinity) return { type: "BEARISH_BOS", level: lo };
  return null;
}

function detectOBs(bars) {
  if (!bars || bars.length < 10) return [];
  const len = bars.length, obs = [];
  for (let i = len-10; i < len-2; i++) {
    const b = bars[i], n = bars[i+1], r = b.high - b.low;
    if (b.close < b.open && n.close > n.open && (n.close-n.open) > r*1.5)
      obs.push({ type: "BULLISH_OB", high: b.high, low: b.low });
    if (b.close > b.open && n.close < n.open && (n.open-n.close) > r*1.5)
      obs.push({ type: "BEARISH_OB", high: b.high, low: b.low });
  }
  return obs.slice(-2);
}

function detectFVGs(bars) {
  if (!bars || bars.length < 3) return [];
  const fvgs = [];
  for (let i = 1; i < bars.length-1; i++) {
    if (bars[i+1].low > bars[i-1].high) fvgs.push({ type: "BULLISH_FVG" });
    if (bars[i+1].high < bars[i-1].low) fvgs.push({ type: "BEARISH_FVG" });
  }
  return fvgs.slice(-3);
}

function getSession(date) {
  const h = date.getUTCHours() + date.getUTCMinutes() / 60;
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return { session: "WEEKEND", killZone: false, strength: 0, name: "Weekend" };
  if (h >= 7 && h < 9)  return { session: "LONDON_OPEN", killZone: true,  strength: 1.0, name: "London Kill Zone" };
  if (h >= 9 && h < 13) return { session: "LONDON_MAIN", killZone: false, strength: 0.75, name: "London Session" };
  if (h >= 13 && h < 16) return { session: "NY_OPEN",    killZone: true,  strength: 1.0, name: "NY Kill Zone" };
  if (h >= 16 && h < 20) return { session: "NY_MAIN",    killZone: false, strength: 0.65, name: "New York Session" };
  if (h >= 20 && h < 22) return { session: "NY_CLOSE",   killZone: true,  strength: 0.75, name: "NY Close" };
  if (h >= 0 && h < 6)   return { session: "ASIAN",      killZone: false, strength: 0.5,  name: "Asian Session" };
  return { session: "DEAD_ZONE", killZone: false, strength: 0.1, name: "Dead Zone" };
}

function analyzeBar(bars, session) {
  const closes = bars.map(b => b.close);
  const len = bars.length;
  const price = closes[len-1];
  const e20 = ema(closes, 20);
  const e50 = ema(closes, Math.min(50, len-1));
  const r = rsi(closes, 14);
  const atrVal = atrCalc(bars, 14);
  const bos = detectBOS(bars);
  const obs = detectOBs(bars);
  const fvgs = detectFVGs(bars);
  const avgVol = bars.slice(-20).reduce((s,b)=>s+b.volume,0)/20;
  const highVol = bars[len-1].volume > avgVol * 1.5;
  const bullish = e20 > e50;
  const aboveEMA20 = price > e20;

  let score = 0;
  let direction = "HOLD";

  if (session.killZone) score += 35;
  else if (session.strength >= 0.5) score += 15;

  if (bos) {
    score += 20;
    direction = bos.type === "BULLISH_BOS" ? "BUY" : "SELL";
  }
  if (obs.length > 0) score += 15;
  if (fvgs.length > 0) score += 15;
  if (r < 35) { score += 10; if (direction === "HOLD") direction = "BUY"; }
  if (r > 65) { score += 10; if (direction === "HOLD") direction = "SELL"; }
  if (highVol) score += 5;
  if (bullish && aboveEMA20) { score += 10; if (direction === "HOLD") direction = "BUY"; }
  else if (!bullish && !aboveEMA20) { score += 10; if (direction === "HOLD") direction = "SELL"; }

  let stopLoss = null, takeProfit = null;
  if (direction !== "HOLD" && atrVal) {
    const recentHigh = Math.max(...bars.slice(-20).map(b=>b.high));
    const recentLow  = Math.min(...bars.slice(-20).map(b=>b.low));
    const bullishOB = obs.find(o => o.type === "BULLISH_OB");
    const bearishOB = obs.find(o => o.type === "BEARISH_OB");
    if (direction === "BUY") {
      stopLoss = bullishOB ? bullishOB.low - atrVal*0.5 : recentLow - atrVal*0.5;
      if (price - stopLoss < atrVal*1.5) stopLoss = price - atrVal*1.5;
      takeProfit = price + Math.abs(price - stopLoss) * 2.0;
    } else {
      stopLoss = bearishOB ? bearishOB.high + atrVal*0.5 : recentHigh + atrVal*0.5;
      if (stopLoss - price < atrVal*1.5) stopLoss = price + atrVal*1.5;
      takeProfit = price - Math.abs(stopLoss - price) * 2.0;
    }
  }

  return {
    direction, score, atrVal, stopLoss, takeProfit,
    grade: score >= 75 ? "A" : score >= 55 ? "B" : score >= 40 ? "C" : "D",
    bos: bos?.type, hasOB: obs.length > 0, hasFVG: fvgs.length > 0
  };
}

function runBacktest(bars, params) {
  const { initialBalance=1000, riskPercent=1.0, minConfluence=35, killZoneOnly=false, pipSize=0.0001 } = params;
  let balance = initialBalance;
  let peakBalance = initialBalance;
  let maxDrawdown = 0;
  const trades = [];
  const equityCurve = [{ time: bars[0]?.time, equity: balance }];
  const LOOKBACK = 50;
  let lastTradeBar = -4;

  for (let i = LOOKBACK; i < bars.length - 1; i++) {
    const window = bars.slice(Math.max(0, i - LOOKBACK), i + 1);
    const bar = bars[i];
    const session = getSession(new Date(bar.time));

    if (session.session === "WEEKEND" || session.session === "DEAD_ZONE") continue;
    if (killZoneOnly && !session.killZone) continue;
    if (i - lastTradeBar < 4) continue;

    const analysis = analyzeBar(window, session);
    if (analysis.direction === "HOLD" || analysis.score < minConfluence) continue;
    if (!analysis.stopLoss || !analysis.takeProfit) continue;

    const riskAmount = balance * riskPercent / 100;
    const slPips = Math.abs(bar.close - analysis.stopLoss) / pipSize;
    if (slPips < 1) continue;
    const lotSize = Math.max(0.01, Math.min(parseFloat((riskAmount / (slPips * 10)).toFixed(2)), 5.0));

    let outcome = "OPEN";
    let exitPrice = null;
    let exitBar = i + 1;
    let pnl = 0;

    for (let j = i + 1; j < Math.min(i + 51, bars.length); j++) {
      const fb = bars[j];
      exitBar = j;
      if (analysis.direction === "BUY") {
        if (fb.low <= analysis.stopLoss) { outcome = "LOSS"; exitPrice = analysis.stopLoss; pnl = -riskAmount; break; }
        if (fb.high >= analysis.takeProfit) { outcome = "WIN"; exitPrice = analysis.takeProfit; pnl = riskAmount * 2.0; break; }
      } else {
        if (fb.high >= analysis.stopLoss) { outcome = "LOSS"; exitPrice = analysis.stopLoss; pnl = -riskAmount; break; }
        if (fb.low <= analysis.takeProfit) { outcome = "WIN"; exitPrice = analysis.takeProfit; pnl = riskAmount * 2.0; break; }
      }
    }

    if (outcome === "OPEN") {
      exitPrice = bars[Math.min(i + 50, bars.length-1)].close;
      const rawPnl = analysis.direction === "BUY"
        ? (exitPrice - bar.close) / pipSize * lotSize * 10
        : (bar.close - exitPrice) / pipSize * lotSize * 10;
      pnl = parseFloat(rawPnl.toFixed(2));
      outcome = pnl >= 0 ? "WIN" : "LOSS";
    }

    balance += pnl;
    if (balance > peakBalance) peakBalance = balance;
    const dd = ((peakBalance - balance) / peakBalance) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
    lastTradeBar = i;

    trades.push({
      entry_time: bar.time,
      exit_time: bars[Math.min(exitBar, bars.length-1)].time,
      direction: analysis.direction,
      entry_price: parseFloat(bar.close.toFixed(5)),
      stop_loss: parseFloat(analysis.stopLoss.toFixed(5)),
      take_profit: parseFloat(analysis.takeProfit.toFixed(5)),
      exit_price: parseFloat((exitPrice||bar.close).toFixed(5)),
      lot_size: lotSize,
      pnl: parseFloat(pnl.toFixed(2)),
      outcome,
      grade: analysis.grade,
      score: analysis.score,
      session: session.name || session.session,
      kill_zone: session.killZone,
      balance_after: parseFloat(balance.toFixed(2))
    });

    equityCurve.push({
      time: bars[Math.min(exitBar, bars.length-1)].time,
      equity: parseFloat(balance.toFixed(2))
    });
  }

  const winners = trades.filter(t => t.outcome === "WIN");
  const losers  = trades.filter(t => t.outcome === "LOSS");
  const grossProfit = winners.reduce((s,t) => s+t.pnl, 0);
  const grossLoss   = Math.abs(losers.reduce((s,t) => s+t.pnl, 0));

  const bySession = {};
  trades.forEach(t => {
    if (!bySession[t.session]) bySession[t.session] = { trades:0, wins:0, pnl:0 };
    bySession[t.session].trades++;
    if (t.outcome === "WIN") bySession[t.session].wins++;
    bySession[t.session].pnl += t.pnl;
  });

  const byGrade = {};
  trades.forEach(t => {
    if (!byGrade[t.grade]) byGrade[t.grade] = { trades:0, wins:0, pnl:0 };
    byGrade[t.grade].trades++;
    if (t.outcome === "WIN") byGrade[t.grade].wins++;
    byGrade[t.grade].pnl += t.pnl;
  });

  return {
    summary: {
      total_trades: trades.length,
      winners: winners.length,
      losers: losers.length,
      win_rate: trades.length > 0 ? parseFloat((winners.length/trades.length*100).toFixed(1)) : 0,
      profit_factor: grossLoss > 0 ? parseFloat((grossProfit/grossLoss).toFixed(2)) : null,
      total_pnl: parseFloat((balance - initialBalance).toFixed(2)),
      gross_profit: parseFloat(grossProfit.toFixed(2)),
      gross_loss: parseFloat(grossLoss.toFixed(2)),
      initial_balance: initialBalance,
      final_balance: parseFloat(balance.toFixed(2)),
      max_drawdown_pct: parseFloat(maxDrawdown.toFixed(2)),
      avg_win: winners.length > 0 ? parseFloat((grossProfit/winners.length).toFixed(2)) : 0,
      avg_loss: losers.length > 0 ? parseFloat((grossLoss/losers.length).toFixed(2)) : 0,
      best_trade: trades.length > 0 ? Math.max(...trades.map(t=>t.pnl)) : 0,
      worst_trade: trades.length > 0 ? Math.min(...trades.map(t=>t.pnl)) : 0,
      kill_zone_trades: trades.filter(t=>t.kill_zone).length,
      kill_zone_win_rate: (() => {
        const kz = trades.filter(t=>t.kill_zone);
        return kz.length > 0 ? parseFloat((kz.filter(t=>t.outcome==="WIN").length/kz.length*100).toFixed(1)) : 0;
      })()
    },
    by_session: bySession,
    by_grade: byGrade,
    trades: trades.slice(-100),
    equity_curve: equityCurve
  };
}

module.exports = router;
