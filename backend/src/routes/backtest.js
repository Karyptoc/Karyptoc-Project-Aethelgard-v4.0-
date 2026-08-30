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

// FIX: these were badly miscalibrated for GOLD/US30Cash/GER40Cash/BTCUSD -
// confirmed by comparing against real spreads observed in live bridge logs
// (e.g. "Spread:50.0pips" for BTCUSD, "Spread:5.5pips" for US30Cash,
// "Spread:2.5pips" for GER40Cash - vs the old assumed 3000/200/150). The
// old BTCUSD value alone was ~60x too high, which was silently erasing
// most or all of every simulated trade's profit before the strategy ever
// got a fair test - confirmed by the mathematically implausible negative
// average win it was producing. GOLD was actually a bit too LOW versus
// real observed spreads (50-56 in live logs vs the old 25), corrected too.
const ASSUMED_SPREAD_PIPS = {
  GOLD: 50, EURUSD: 1.2, GBPUSD: 1.8, USDJPY: 1.2,
  US30Cash: 5.5, GER40Cash: 2.5, BTCUSD: 50,
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
  // FIX (confirmed live via diagnostic logging): this had no explicit
  // limit, and Supabase/PostgREST silently caps unlimited queries at 1000
  // rows by default. Ordered ascending with no limit meant that once a
  // symbol/timeframe's cache grew past 1000 total rows - which M15/M5 hit
  // far sooner than H4/D1/W1 given how many more bars get pushed per cycle
  // and from the one-time backfill - the query started silently returning
  // only the OLDEST 1000 rows, not the most recent ones. Confirmed exactly:
  // a 30-day GOLD backtest received M15 data from May 28-June 11, 47+ days
  // stale relative to the actual requested window - explaining why the
  // Stage 3 lookback fix appeared to do nothing (it was working correctly
  // on data that was simply too old to matter). Now explicitly orders
  // descending with a generous limit to get the MOST RECENT bars, then
  // reverses back to ascending order since the rest of the code (H4 replay
  // loop, window slicing) expects chronological order.
  const MAX_BARS = 30000; // generous enough for 90 days of M5 (~25920) plus headroom
  let query = supabaseAdmin
    .from("ohlcv_cache")
    .select("time, open, high, low, close, volume")
    .eq("symbol", symbol)
    .eq("timeframe", timeframe)
    .order("time", { ascending: false })
    .limit(MAX_BARS);
  if (fromDate) query = query.gte("time", fromDate);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).reverse().map(b => ({
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
    const { symbol, days = 30, initial_balance = 1000, risk_percent = 1.0, min_score_override } = req.body;
    if (!symbol) return res.status(400).json({ error: "symbol required" });

    const fromDate = new Date(Date.now() - (days + 120) * 24 * 60 * 60 * 1000).toISOString();
    // M5/M15/H1 added for the new POI detection (sweep/OB/FVG moved from
    // H4 to M15/M5) and H1-added HTF bias. These have far less accumulated
    // history than H4 right now (one-time ~45-day backfill vs H4's longer
    // running history) - fetchCachedBars just returns whatever exists in
    // the window, so this degrades gracefully rather than erroring while
    // the cache builds up further via the bridge's ongoing per-cycle push.
    const [h4Bars, d1Bars, w1Bars, h1Bars, m15Bars, m5Bars] = await Promise.all([
      fetchCachedBars(symbol, "H4", fromDate),
      fetchCachedBars(symbol, "D1"),
      fetchCachedBars(symbol, "W1"),
      fetchCachedBars(symbol, "H1", fromDate),
      fetchCachedBars(symbol, "M15", fromDate),
      fetchCachedBars(symbol, "M5", fromDate),
    ]);

    if (h4Bars.length < 100) {
      return res.status(400).json({
        error: `Insufficient H4 data: need 100+ bars, got ${h4Bars.length} for ${symbol}.`
      });
    }
    if (d1Bars.length < 30 || w1Bars.length < 20) {
      await log("info", "backtest", `${symbol}: limited D1/W1 history — HTF alignment weaker until more accumulates.`);
    }
    if (m15Bars.length < 100 || m5Bars.length < 100) {
      await log("info", "backtest",
        `${symbol}: limited M15/M5 history (${m15Bars.length}/${m5Bars.length} bars) — POI detection window may be sparse until the backfill/ongoing cache accumulates more.`);
    }

    // DIAGNOSTIC (temporary, round 2) - re-added after the row-limit fixes
    // (code + Supabase Max Rows setting) to directly confirm whether the
    // M15 date range actually updated, rather than inferring from the
    // final P&L number again. Also logging H4's range this time, since 2
    // trades/641 bars for a 30-day GOLD test is itself worth double-checking.
    await log("info", "backtest",
      `${symbol}: DIAGNOSTIC2 m15Bars.length=${m15Bars.length}, earliest=${m15Bars[0]?.time || "none"}, latest=${m15Bars[m15Bars.length-1]?.time || "none"}`);
    await log("info", "backtest",
      `${symbol}: DIAGNOSTIC2 h4Bars.length=${h4Bars.length}, earliest=${h4Bars[0]?.time || "none"}, latest=${h4Bars[h4Bars.length-1]?.time || "none"}, windowStart=${new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()}`);

    const windowStart = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = runBacktest(symbol, h4Bars, d1Bars, w1Bars, h1Bars, m15Bars, m5Bars, {
      initialBalance: initial_balance, riskPercent: risk_percent, windowStart, minScoreOverride: min_score_override,
    });

    await log("info", "backtest",
      `${symbol}: DIAGNOSTIC2 usingPoiM15 count=${result.summary.poiM15Count || 0}/${result.summary.poiTotalChecks || 0} bars evaluated`);
    await log("info", "backtest",
      `${symbol}: DIAGNOSTIC3 filterCounts=${JSON.stringify(result.summary.filterCounts)}`);
    await log("info", "backtest",
      `${symbol}: DIAGNOSTIC4 holdReasons=${JSON.stringify(result.summary.holdReasons)}`);

    await log("info", "backtest",
      `Complete (rebuilt engine): ${symbol} | ${result.summary.total_trades} trades | WR:${result.summary.win_rate}% | PF:${result.summary.profit_factor}`);

    res.json({ ok: true, symbol, timeframe: "H4", days, bars_used: h4Bars.length, engine_version: "v2_shared_core", ...result });
  } catch (e) {
    await log("error", "backtest", `Error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// STAGE 1 (data plumbing only): h1Bars/m15Bars/m5Bars now reach this
// function and are available for the POI-detection rewrite (moving
// sweep/OB/FVG from H4 to M15/M5, and adding H1 to HTF bias) - the replay
// loop itself still runs on H4 exactly as before. Intentionally split into
// its own stage so this data-availability change can be verified
// independently before the higher-risk logic rewrite happens on top of it.
function runBacktest(symbol, h4Bars, d1Bars, w1Bars, h1Bars, m15Bars, m5Bars, params) {
  const { initialBalance = 1000, riskPercent = 1.0, windowStart, minScoreOverride } = params;
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

  // DIAGNOSTIC (temporary) - track how many evaluated bars actually used
  // the M15 POI path vs falling back to H4, to get direct evidence of
  // what's happening rather than guessing.
  let poiM15Count = 0;
  let poiTotalChecks = 0;

  // DIAGNOSTIC (temporary, round 3) - exact breakdown of which filter is
  // responsible for cutting a 30-day window (~180 H4 bars, ~90 of them
  // mechanically kill-zone-eligible per the fixed clock-boundary alignment)
  // down to just 3 bars actually reaching POI detection.
  const filterCounts = {
    beforeWindow: 0, inTradeCooldown: 0, weekendOrDead: 0, news: 0,
    sessionStrength: 0, notKillZone: 0, noIndicators: 0, adrExhausted: 0,
    reachedPOI: 0
  };

  // DIAGNOSTIC (temporary, round 4) - why makePureMathDecision returns HOLD
  // for bars that reached POI detection - to understand GOLD's drop to
  // zero trades after the HTF-permission fix.
  const holdReasons = {
    noStructure: 0, htfConflict: 0, rsiConflict: 0, emaConflict: 0,
    scoreTooLow: 0, confidenceTooLow: 0, other: 0,
    mandatorySequence: 0, missingSweep: 0, missingMSS: 0,
    missingDisplacement: 0, missingPOI: 0
  };

  for (let i = LOOKBACK; i < h4Bars.length - 1; i++) {
    const bar = h4Bars[i];
    const barTime = new Date(bar.time);
    if (barTime < windowStart) { filterCounts.beforeWindow++; continue; }
    if (i <= lastTradeExitIndex) { filterCounts.inTradeCooldown++; continue; }

    const session = core.getSessionInfo(barTime);
    if (session.session === "WEEKEND" || session.session === "DEAD_ZONE") { filterCounts.weekendOrDead++; continue; }

    const news = core.isNewsBlackout(barTime);
    if (news.blocked) { filterCounts.news++; continue; }

    const isPairActive = core.isPairActiveInSession(symbol, session.session);
    const sessionThreshold = (session.sessQuality >= 2) ? 0.2 : 0.4;
    if (!isPairActive && session.strength < sessionThreshold) { filterCounts.sessionStrength++; continue; }
    if (!session.killZone) { filterCounts.notKillZone++; continue; }

    const primaryBars = h4Bars.slice(Math.max(0, i - 200 + 1), i + 1);
    const currentATR = core.atrCalc(primaryBars, 14);
    const ind = core.getIndicators(primaryBars, currentATR);
    if (!ind) { filterCounts.noIndicators++; continue; }

    const d1Window = d1Bars.filter(b => new Date(b.time) <= barTime).slice(-100);
    const w1Window = w1Bars.filter(b => new Date(b.time) <= barTime).slice(-60);
    // STAGE 2: h1Window added, filtered to barTime the same way as
    // d1Window/w1Window to avoid lookahead bias. 150-bar window matches
    // what bridge.py fetches live for H1 ("structure" per its own
    // comments), keeping backtest and live behavior consistent.
    const h1Window = (h1Bars || []).filter(b => new Date(b.time) <= barTime).slice(-150);
    const htfBias = core.getHTFBias(primaryBars, d1Window.length ? d1Window : null, w1Window.length ? w1Window : null, h1Window.length ? h1Window : null);

    const adrStatus = core.getADRStatus(primaryBars, d1Window, symbol);
    if (adrStatus.exhausted) { filterCounts.adrExhausted++; continue; }
    filterCounts.reachedPOI++;

    // ── STAGE 3: POI detection moved to M15, matching the live change ──────
    // Filtered to barTime to avoid lookahead bias, same discipline as
    // d1Window/w1Window/h1Window. 150-bar window (~37 hours) gives enough
    // recent session structure for sweep/OB/FVG without reaching back into
    // unrelated prior sessions.
    //
    // GRACEFUL FALLBACK: the M15/M5 backfill only covers ~45 days, but this
    // backtest can run over a 90-day window. For bars older than that (the
    // portion of the window predating the backfill), there's no M15 history
    // available yet - falls back to the original H4-based detection for
    // those specific bars rather than skipping them or breaking. This means
    // the most recent ~45 days of any backtest get the more precise M15
    // treatment, older bars get the previous H4 treatment - a real, known
    // asymmetry worth being aware of, not silently hidden.
    const m15Window = (m15Bars || []).filter(b => new Date(b.time) <= barTime).slice(-150);
    const usingPoiM15 = m15Window.length >= 30;
    poiTotalChecks++;
    if (usingPoiM15) poiM15Count++;
    const poiBars = usingPoiM15 ? m15Window : primaryBars;
    const poiATR = usingPoiM15 ? core.atrCalc(poiBars, 14) : currentATR;

    // FIX (confirmed real bug via live A/B test): these lookback windows
    // were hardcoded assuming H4 bars - see the matching fix and full
    // explanation in signalEngine.js. Only applied when actually using the
    // M15 path; the H4 fallback path (older bars, pre-backfill) keeps the
    // exact original defaults so that portion of the backtest is completely
    // unaffected by this change.
    const M15_OB_LOOKBACK = 40, M15_FVG_LOOKBACK = 40, M15_EQHL_LOOKBACK = 60,
          M15_STRENGTH_LOOKBACK = 60, M15_SWEEP_LOOKBACK = 48, M15_PD_LOOKBACK = 80;

    const poiInd = usingPoiM15
      ? core.getIndicators(poiBars, poiATR, M15_OB_LOOKBACK, M15_FVG_LOOKBACK, M15_EQHL_LOOKBACK)
      : ind;

    const sweep = core.detectLiquiditySweep(poiBars, usingPoiM15 ? M15_SWEEP_LOOKBACK : 15);
    const displacement = poiATR ? core.detectDisplacement(poiBars, poiATR) : null;
    const fvgs = poiInd?.fvgs || [];
    const obs = poiInd?.obs || [];
    const retestDirection = sweep?.direction || (htfBias.bias === "bullish" ? "BUY" : "SELL");
    const retest = core.checkRetest(poiBars, fvgs, obs, retestDirection);
    const eqLiquidity = poiATR ? core.detectEqualHighsLows(poiBars, poiATR, usingPoiM15 ? M15_EQHL_LOOKBACK : 20) : null;
    const strength = poiATR ? core.calculateStrength(poiBars, poiATR, usingPoiM15 ? M15_STRENGTH_LOOKBACK : 20) : null;
    const pdZone = core.getPremiumDiscount(poiBars, usingPoiM15 ? M15_PD_LOOKBACK : 20);

    // STAGE 4: obs/fvgs (already computed above from poiInd) and previous
    // day's high/low now feed structural TP target selection. Uses
    // d1Window (already filtered to barTime above) rather than raw d1Bars,
    // to keep the same lookahead-bias discipline as everything else here.
    const lastD1Bar = d1Window.length ? d1Window[d1Window.length - 1] : null;

    const ictSequence = {
      sweep, displacement, retest,
      eqLiquidity: (eqLiquidity?.eqh?.length > 0 || eqLiquidity?.eql?.length > 0) ? eqLiquidity : null,
      strength, pdZone,
      obs, fvgs,
      prevDayHigh: lastD1Bar?.high || null,
      prevDayLow: lastD1Bar?.low || null,
      hasFullSequence: !!(sweep && displacement && retest),
      hasPartialSequence: !!(sweep && displacement),
      _session: session, // needed by calculateStructuralSLTP for kill-zone-aware SL cap
    };

    ind.direction = retestDirection;
    const confluence = core.scoreConfluence(ind, session, htfBias, isPairActive, ictSequence);

    let minScore;
    if (typeof minScoreOverride === "number") {
      // Test mode: flat floor regardless of ICT sequence/session context,
      // for comparing "what if we required at least grade B/A" against
      // real historical data before ever touching production thresholds.
      minScore = minScoreOverride;
    } else if (ictSequence.hasFullSequence) minScore = 30;
    else if (ictSequence.hasPartialSequence) minScore = 33;
    else if (session.killZone && isPairActive) minScore = 35;
    else if (session.killZone) minScore = 38;
    else minScore = 42;

    if (confluence.score < minScore) continue;

    const analysis = core.makePureMathDecision(confluence, htfBias, ictSequence, ind, session);
    if (analysis.direction === "HOLD") {
      // DIAGNOSTIC (temporary, round 5) - categorize why, including precise
      // breakdown of which mandatory-sequence element(s) are missing, since
      // GOLD dropped from 8 trades to 0 over the full 90-day window after
      // the mandatory sequence gate was added.
      const reason = analysis.reason || "unknown";
      if (reason.includes("No directional signal")) holdReasons.noStructure++;
      else if (reason.includes("HTF") && reason.includes("conflicts")) holdReasons.htfConflict++;
      else if (reason.includes("Mandatory sequence incomplete")) {
        holdReasons.mandatorySequence++;
        if (reason.includes("sweep")) holdReasons.missingSweep++;
        if (reason.includes("MSS")) holdReasons.missingMSS++;
        if (reason.includes("displacement")) holdReasons.missingDisplacement++;
        if (reason.includes("POI retest")) holdReasons.missingPOI++;
      }
      else if (reason.includes("RSI")) holdReasons.rsiConflict++;
      else if (reason.includes("EMA")) holdReasons.emaConflict++;
      else if (reason.includes("Score too low")) holdReasons.scoreTooLow++;
      else if (reason.includes("Confidence")) holdReasons.confidenceTooLow++;
      else holdReasons.other++;
      continue;
    }

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
      best_trade: trades.length > 0 ? parseFloat(Math.max(...trades.map(t => t.pnl)).toFixed(2)) : 0,
      worst_trade: trades.length > 0 ? parseFloat(Math.min(...trades.map(t => t.pnl)).toFixed(2)) : 0,
      poiM15Count, poiTotalChecks, filterCounts, holdReasons, // DIAGNOSTIC (temporary)
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
