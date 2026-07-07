/**
 * AETHELGARD SIGNAL ENGINE v13
 * backend/src/services/signalEngine.js
 *
 * v12b → v13: AI Mode Toggle — 3 operating modes
 * ─────────────────────────────────────────────────────────────────────────────
 * NEW: PURE_MATH mode — zero Claude API cost, ICT math only
 * NEW: HYBRID mode  — Claude only for high-score setups (score >= 65)
 * NEW: AI mode      — original full Claude analysis (existing behavior)
 * NEW: Mode readable from platform_settings table (dashboard toggle)
 * NEW: makePureMathDecision() — full BUY/SELL logic from confluence score
 * Cost: AI=$7.49/day | HYBRID=$1.50/day | PURE_MATH=$0.00/day
 */

const Anthropic = require("@anthropic-ai/sdk");
const { supabaseAdmin, log } = require("./supabase");
const {
  calculateATRStopLoss,
  checkVolatilitySpike,
  isPairEnabled,
  checkDynamicSpread,
  recordSpread,
  checkCurrencyExposure,
  ATR_SL_MULTIPLIERS,
  getRiskPercent
} = require("./riskEngine");

// FIX: strategy logic (indicators, ICT detection, confluence scoring,
// PURE_MATH decisions, session/news logic) now lives in signalCore.js —
// the SAME module backtest.js uses. This is what makes backtest results
// mean something again: live and backtest can no longer silently diverge,
// because there's only one copy of this logic instead of two.
const {
  PIP_SIZES,
  PAIR_SESSIONS,
  SCALP_PAIRS,
  DXY_INVERSE_PAIRS,
  DXY_DIRECT_PAIRS,
  makePureMathDecision,
  getSessionInfo,
  isPairActiveInSession,
  isNewsBlackout,
  ema,
  rsi,
  atrCalc,
  atrHistorical,
  detectMarketStructure,
  detectLiquiditySweep,
  detectDisplacement,
  detectOBs,
  detectFVGs,
  detectEqualHighsLows,
  calculateStrength,
  checkRetest,
  detectM5Entry,
  getPremiumDiscount,
  getHTFBias,
  getADRStatus,
  getSessionBiasProjection,
  getMidnightOpenArray,
  getDXYConflict,
  makeScalpDecision,
  scoreConfluence,
  getIndicators,
  calculateStructuralSLTP,
} = require("./signalCore");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PAIRS = [
  "GOLD", "EURUSD", "GBPUSD", "USDJPY",
  "US30Cash", "GER40Cash", "BTCUSD",
  "AUDUSD", "USDCAD", "USDCHF", "NZDUSD",
  "GBPJPY", "EURJPY",
];

// H4 primary — NOTE: the "backtest proven PF 9.56 GOLD / PF 4.54 USDCAD"
// comment that used to be here referred to backtest.js's OLD standalone
// simulation, which never actually tested this multi-timeframe H4/D1/W1
// strategy. Re-validate this choice once backtest.js is rebuilt against
// signalCore.js — don't treat the old numbers as evidence for this anymore.
const PAIR_PRIMARY_TF = {
  GOLD: "H4", GER40Cash: "H4", BTCUSD: "H4", US30Cash: "H4",
  USDCAD: "H4", USDJPY: "H4", EURUSD: "H4", GBPUSD: "H4",
  USDCHF: "H4", AUDUSD: "H4", NZDUSD: "H4", GBPJPY: "H4", EURJPY: "H4",
};

// ── Trading Mode ─────────────────────────────────────────────────────────────
// PURE_MATH: Zero API cost. ICT math score makes all decisions.
// HYBRID:    Claude only called when confluence score >= 65 (A-grade setups).
// AI:        Full Claude analysis on every pair (original behavior).

const TRADING_MODES = { PURE_MATH: "PURE_MATH", HYBRID: "HYBRID", AI: "AI", SCALP: "SCALP" };

async function getTradingMode() {
  try {
    const { data } = await supabaseAdmin
      .from("platform_settings")
      .select("value")
      .eq("key", "trading_mode")
      .single();
    const mode = (data?.value || "PURE_MATH").toString().replace(/"/g,"").toUpperCase();
    return TRADING_MODES[mode] || TRADING_MODES.PURE_MATH;
  } catch { return TRADING_MODES.PURE_MATH; }
}

async function getDuplicateWindow() {
  try {
    const { data } = await supabaseAdmin
      .from("platform_settings").select("value")
      .eq("key", "duplicate_signal_minutes").single();
    return parseInt(data?.value) || 3;
  } catch { return 3; }
}
// FIX: default window reduced from 20 to 3 minutes. This check's job is now
// just to prevent the same 5-minute cycle (or an adjacent one) from firing
// two near-simultaneous signals for the same setup - the REAL concurrency
// limit (how many trades can be open on a symbol at once) is now handled
// by getOpenPositionCount() + the grade-based check below, so this no
// longer needs to be wide enough to block a legitimate second or third
// grade-A entry hours apart.

// NEW: counts currently open trades for a symbol, so multiple concurrent
// positions can be allowed for high-quality (grade A) setups specifically,
// while lower grades stay capped at one at a time.
async function getOpenPositionCount(symbol) {
  try {
    const { data, error } = await supabaseAdmin
      .from("trades")
      .select("id")
      .eq("symbol", symbol)
      .eq("status", "open");
    if (error) throw error;
    return data?.length ?? 0;
  } catch (e) {
    // Fail safe: if we can't determine open count, assume the conservative
    // maximum (1) so a DB hiccup never accidentally allows overexposure.
    await log("warning", "signalEngine", `getOpenPositionCount(${symbol}) failed: ${e.message} - assuming 1`);
    return 1;
  }
}

async function hasRecentSignal(symbol, minutes = 3) {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const { data } = await supabaseAdmin
    .from("signals").select("id, direction, created_at")
    .eq("symbol", symbol).gte("created_at", cutoff)
    .order("created_at", { ascending: false }).limit(1);
  return data?.length > 0 ? data[0] : null;
}

// ── Technical Analysis ────────────────────────────────────────────────────────

async function analyzeWithClaude(symbol, multiTFData, session, confluence, htfBias, perf, atrInfo, ictSequence) {
  const isCross  = ["GBPJPY","EURJPY"].includes(symbol);
  const isCrypto = symbol === "BTCUSD";
  const isIndex  = ["US30Cash","GER40Cash"].includes(symbol);
  const atrMultiplier = ATR_SL_MULTIPLIERS[symbol] || 1.3;

  // Build ICT context string for Claude
  const ictContext = [
    ictSequence.sweep ? `✅ ${ictSequence.sweep.type} sweep at ${ictSequence.sweep.sweptLevel?.toFixed(5)} → SL anchor` : "⏳ No sweep detected",
    ictSequence.displacement ? `✅ Displacement candle: ${ictSequence.displacement.atrRatio}x ATR body` : "⏳ No displacement",
    ictSequence.retest ? `✅ Retesting ${ictSequence.retest.zone} (${ictSequence.retest.type})` : "⏳ No retest",
    ictSequence.eqLiquidity ? `✅ EQH/EQL targets: ${JSON.stringify(ictSequence.eqLiquidity)}` : "No EQH/EQL found",
    ictSequence.pdZone ? `Zone: ${ictSequence.pdZone.zone.toUpperCase()} (${(ictSequence.pdZone.pct*100).toFixed(0)}% of range)` : "",
    ictSequence.strength ? `Buyer: ${ictSequence.strength.buyerStr}% | Seller: ${ictSequence.strength.sellerStr}%` : "",
  ].filter(Boolean).join("\n");

  const systemPrompt = `You are Aethelgard, an ICT/SMC institutional trading engine using the full ICT execution model.

SESSION: ${session.name} | Entry Model: ${session.entryModel} | Quality: ${session.sessQuality}/3
HTF BIAS: ${htfBias.bias.toUpperCase()} (${(htfBias.strength*100).toFixed(0)}%)
SMC SCORE: ${confluence.score}/100 (Grade ${confluence.grade})
ATR RATIO: ${atrInfo?.ratio || 1.0}x normal ${atrInfo?.ratio >= 2.5 ? "⚠️ VOLATILITY SPIKE" : ""}
TIMEFRAME MODEL: H4 analysis + M5 precision entry
- H4: bias, structure, sweep detection, FVG/OB zones, TP targets
- M5: entry candle timing inside H4 zone (kill zones only)
- Entry price comes from M5 when in kill zone; H4 price otherwise
PRIMARY TF: H4 (backtest-proven optimal)
INSTRUMENT: ${isCross ? "Cross pair" : isCrypto ? "Crypto" : isIndex ? "Index CFD" : "Major forex"}

ICT EXECUTION SEQUENCE STATUS:
${ictContext}

SL RULES — CRITICAL:
- If sweep detected: SL = swept level + ATR buffer (structural SL — TIGHTER than ATR-only)
- If no sweep: SL = ${atrMultiplier}x ATR from entry
- NEVER wider than 2.5x ATR
- Minimum SL: ${symbol === "GOLD" ? "50 pips ($0.50)" : symbol === "BTCUSD" ? "$500" : "5 pips"}

TP RULES — NEW (extends winners):
- TP1: If EQH/EQL detected nearby → use liquidity pool as TP1 (higher probability)
- TP2: Session high/low opposite side
- TP3: 3.0R minimum
- Prefer 2.5-4.0R on full ICT sequence setups
- NEVER close below 2.0R if full sequence confirmed

TRADING RULES:
- Full ICT sequence (sweep+displacement+retest) = up to 0.90 confidence
- Partial sequence (sweep+displacement only) = up to 0.75 confidence  
- No sweep detected = max 0.60 confidence
- Entry model window = extra 0.05 confidence bonus
- Dead zone = HOLD always
- Volatility spike = reduce confidence 0.15
- RR >= 2.0 required, prefer 3.0+ on A-grade setups
Respond in JSON only.`;

  const userPrompt = `Analyze ${symbol} for ICT execution signal.
DATA: ${JSON.stringify(multiTFData, null, 2)}
ATR_INFO: current=${atrInfo?.current?.toFixed(5)}, historical=${atrInfo?.historical?.toFixed(5)}, ratio=${atrInfo?.ratio}
${perf ? `PERFORMANCE: WR ${perf.win_rate}% | ${perf.on_losing_streak ? "⚠️ LOSING STREAK — be conservative" : "Normal"}` : ""}

JSON response:
{
  "symbol": "${symbol}",
  "direction": "BUY"|"SELL"|"HOLD",
  "confidence": 0.0-1.0,
  "regime": "TRENDING_BULL"|"TRENDING_BEAR"|"RANGING"|"HIGH_VOLATILITY"|"BREAKOUT",
  "regime_detail": {"description":"brief","strength":0.0-1.0,"timeframe_alignment":"aligned"|"mixed"|"conflicted"},
  "smc_context": {
    "structure":"bullish"|"bearish"|"consolidating",
    "ict_sequence_quality":"full"|"partial"|"none",
    "liquidity_target":"describe nearest EQH/EQL or session level",
    "htf_aligned":true|false,
    "entry_model_quality":"A+"|"A"|"B"|"C"|"no_setup"
  },
  "entry_logic": "describe sweep level, MSS level, FVG/OB being retested with specific prices",
  "sl_reasoning": "structural SL using swept level or ATR — give specific price",
  "stop_loss_pips": number,
  "reward_risk_ratio": number,
  "tp1_logic": "first target: EQH/EQL or session level with specific price",
  "tp2_logic": "second target: opposite session extreme",
  "sentiment_score": -1.0 to 1.0,
  "rationale": "2-3 sentences: sweep context + HTF + session quality + expected move",
  "invalidation": "specific price level that invalidates the setup",
  "timeframe_primary": "H4",
  "position_size_modifier": 0.5-1.5
}`;

  try {
    const resp = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1100,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    });
    return JSON.parse(resp.content[0].text.trim().replace(/```json|```/g,"").trim());
  } catch (e) {
    await log("error", "signalEngine", `Claude failed for ${symbol}: ${e.message}`);
    return null;
  }
}

async function getRecentPerformance(symbol) {
  try {
    const { data } = await supabaseAdmin
      .from("trades").select("profit")
      .eq("symbol", symbol).eq("status", "closed")
      .order("close_time", { ascending: false }).limit(10);
    if (!data?.length) return null;
    const winners = data.filter(t => (t.profit||0) > 0);
    const recent5 = data.slice(0,5).map(t => t.profit > 0 ? "WIN" : "LOSS");
    return {
      win_rate: parseFloat((winners.length/data.length*100).toFixed(1)),
      recent_outcomes: recent5,
      on_losing_streak: recent5.slice(0,3).every(o => o === "LOSS")
    };
  } catch { return null; }
}

// ── SL/TP Calculation with Structural Anchor ──────────────────────────────────

async function generateSignalFromOHLCV(symbol, ohlcvData) {
  try {
    const session = getSessionInfo();
    if (session.session === "WEEKEND" || session.session === "DEAD_ZONE") return null;

    const news = isNewsBlackout();
    if (news.blocked) { await log("info", "signalEngine", `${symbol}: ${news.reason}`); return null; }

    const pairCheck = await isPairEnabled(symbol);
    if (!pairCheck.allowed) { await log("info", "signalEngine", `${symbol}: ${pairCheck.reason}`); return null; }

    const dupMinutes = await getDuplicateWindow();
    const recent = await hasRecentSignal(symbol, dupMinutes);
    if (recent) {
      await log("info", "signalEngine",
        `${symbol}: Duplicate skip — ${recent.direction} was ${Math.round((Date.now()-new Date(recent.created_at))/60000)}min ago`
      );
      return null;
    }

    const isPairActive = isPairActiveInSession(symbol, session.session);
    const sessionThreshold = (session.sessQuality >= 2) ? 0.2 : 0.4;
    if (!isPairActive && session.strength < sessionThreshold) return null;

    // ── KILL ZONE GATE ─────────────────────────────────────────────────────
    if (!session.killZone) {
      await log("info", "signalEngine", `${symbol}: Outside kill zone (${session.session}) — HOLD`);
      return null;
    }

    // ── SESSION TRADE CAP: max 3 per 2.5hr window ─────────────────────────
    try {
      const kzCutoff = new Date(Date.now() - 2.5 * 60 * 60 * 1000).toISOString();
      const { data: kzTrades } = await supabaseAdmin
        .from("trades").select("id").gte("open_time", kzCutoff);
      if ((kzTrades?.length || 0) >= 3) {
        await log("info", "signalEngine", `${symbol}: Session cap (${kzTrades.length}/3) — HOLD`);
        return null;
      }
    } catch(e) { /* non-blocking */ }

    // Build multi-timeframe data
    const multiTFData = {};
    let h1Bars = null, h4Bars = null, m15Bars = null, m5Bars = null, d1Bars = null, w1Bars = null;
    for (const [tf, bars] of Object.entries(ohlcvData)) {
      if (bars && bars.length > 30) {
        const atrV = atrCalc(bars, 14);
        const ind = getIndicators(bars, atrV);
        if (ind) {
          multiTFData[tf] = {
            bars_count: bars.length,
            latest_close: bars[bars.length-1].close,
            indicators: ind
          };
          if (tf === "H1")  h1Bars  = bars;
          if (tf === "H4")  h4Bars  = bars;
          if (tf === "M15") m15Bars = bars;
          if (tf === "M5")  m5Bars  = bars;
          if (tf === "D1")  d1Bars  = bars;
          if (tf === "W1")  w1Bars  = bars;
          if (tf === "USDCHF") multiTFData[tf].bars = bars; // keep for DXY proxy
        }
      }
    }
    if (!Object.keys(multiTFData).length) return null;

    const htfBias = getHTFBias(h4Bars || h1Bars, d1Bars, w1Bars);

    const adrStatus = getADRStatus(h4Bars, d1Bars, symbol);
    if (adrStatus.exhausted) {
      await log("info", "signalEngine", `${symbol}: ADR exhausted ${adrStatus.consumedPct.toFixed(0)}% — skipping`);
      return null;
    }
    const sessionBias = getSessionBiasProjection(h4Bars, session.session);
    const midnightArray = h4Bars ? getMidnightOpenArray(h4Bars) : null;
    const primaryTF = PAIR_PRIMARY_TF[symbol] || "H4";

    // Fix: explicitly pick primary bars based on primaryTF — don't fallback to m15Bars
    // If H4 bars exist use them always; H1 only as last resort; never use M15 as primary
    const primaryBars = h4Bars || h1Bars || null;
    const primaryInd = multiTFData[primaryTF]?.indicators
      || multiTFData["H4"]?.indicators
      || multiTFData["H1"]?.indicators;

    // If no H4 or H1 data — skip, don't fall to M15 as primary
    if (!primaryInd || !primaryBars) {
      await log("info", "signalEngine", `${symbol}: No H4/H1 data available — skipping`);
      return null;
    }

    const currentATR = primaryInd.atr14;
    const histATR    = primaryInd.atr14_historical;
    const atrRatio   = primaryInd.atr_ratio || 1.0;
    const atrInfo    = { current: currentATR, historical: histATR, ratio: atrRatio };

    // Volatility spike alert
    if (atrRatio >= 2.5) {
      await checkVolatilitySpike(symbol, currentATR, histATR);
    }

    // ── NEW: ICT Sequence Detection ─────────────────────────────────────────

    // Step 1: Liquidity Sweep
    const sweep = detectLiquiditySweep(primaryBars, 15);

    // Step 2: Displacement candle (MSS confirmation)
    const displacement = currentATR ? detectDisplacement(primaryBars, currentATR) : null;

    // Step 3: FVGs and OBs from primary bars
    const fvgs = primaryInd.fvgs || [];
    const obs  = primaryInd.obs  || [];

    // Step 4: Retest check
    const retestDirection = sweep?.direction || (htfBias.bias === "bullish" ? "BUY" : "SELL");
    const retest = checkRetest(primaryBars, fvgs, obs, retestDirection);

    // Step 5: Equal Highs/Lows (liquidity targets)
    const eqLiquidity = currentATR ? detectEqualHighsLows(primaryBars, currentATR) : null;

    // Step 6: Strength engine
    const strength = currentATR ? calculateStrength(primaryBars, currentATR) : null;

    // Step 7: Premium/Discount zone
    const pdZone = getPremiumDiscount(primaryBars);

    // Bundle ICT sequence
    const ictSequence = {
      sweep,
      displacement,
      retest,
      eqLiquidity: (eqLiquidity?.eqh?.length > 0 || eqLiquidity?.eql?.length > 0) ? eqLiquidity : null,
      strength,
      pdZone,
      hasFullSequence: !!(sweep && displacement && retest),
      hasPartialSequence: !!(sweep && displacement)
    };

    // Confluence scoring with ICT sequence
    primaryInd.direction = retestDirection;
    const confluence = scoreConfluence(primaryInd, session, htfBias, isPairActive, ictSequence);

    // Minimum tradeable threshold — significantly lowered per pair type
    // Full ICT sequence (sweep+displacement+retest) = lowest bar (35)
    // Minimum score thresholds — aligned with backtest default min_confluence=35
    let minScore;
    if (ictSequence.hasFullSequence) {
      minScore = 30; // full ICT sequence = very low bar
    } else if (ictSequence.hasPartialSequence) {
      minScore = 33;
    } else if (session.killZone && isPairActive) {
      minScore = 35; // matches backtest default
    } else if (session.killZone) {
      minScore = 38;
    } else {
      minScore = 42; // outside kill zone still needs more
    }

    await log("info", "signalEngine", `${symbol}: DBG score=${confluence.score} min=${minScore} htf=${htfBias.bias} sq=${session.sessQuality} kz=${session.killZone} active=${isPairActive}`);
    if (confluence.score < minScore) {
      await log("info", "signalEngine", `${symbol}: Score ${confluence.score} < ${minScore} — no setup`);
      return null;
    }

    // NEW: grade-based concurrency limit. Grade A setups can stack up to 3
    // concurrent positions on the same pair; everything else stays capped
    // at 1 at a time, same as before. This runs AFTER grade is known
    // (confluence.grade) and BEFORE the more expensive AI/SL-TP work below,
    // so a blocked signal doesn't waste that computation.
    const maxConcurrent = confluence.grade === "A" ? 3 : 1;
    const openCount = await getOpenPositionCount(symbol);
    if (openCount >= maxConcurrent) {
      await log("info", "signalEngine",
        `${symbol}: At capacity (${openCount}/${maxConcurrent} open, grade ${confluence.grade}) — HOLD`);
      return null;
    }

    const perf = await getRecentPerformance(symbol);

    // ── Trading mode selection ────────────────────────────────────────────────
    const tradingMode = await getTradingMode();
    let analysis = null;

    if (tradingMode === TRADING_MODES.SCALP) {
      const m5Atr = m5Bars ? atrCalc(m5Bars, 14) : null;
      analysis = makeScalpDecision(symbol, m5Bars, m5Atr, session, htfBias);
      if (analysis.direction !== "HOLD") {
        await log("info", "signalEngine", `${symbol}: SCALP ${analysis.direction} | Conf:${analysis.confidence} | ${session.name}`);
      }
    } else if (tradingMode === TRADING_MODES.PURE_MATH) {
      // Zero cost — pure ICT math decision
      analysis = makePureMathDecision(confluence, htfBias, ictSequence, primaryInd, session);
      if (analysis.direction !== "HOLD") {
        await log("info", "signalEngine", `${symbol}: PURE_MATH ${analysis.direction} | Score:${confluence.score} | Conf:${analysis.confidence}`);
      }

    } else if (tradingMode === TRADING_MODES.HYBRID) {
      // Use Claude only for high-confidence setups (score >= 65)
      // Everything else decided by pure math
      if (confluence.score >= 65 || ictSequence.hasFullSequence) {
        await log("info", "signalEngine", `${symbol}: HYBRID mode — score ${confluence.score} qualifies for AI analysis`);
        analysis = await analyzeWithClaude(symbol, multiTFData, session, confluence, htfBias, perf, atrInfo, ictSequence);
      } else {
        analysis = makePureMathDecision(confluence, htfBias, ictSequence, primaryInd, session);
        await log("info", "signalEngine", `${symbol}: HYBRID mode — score ${confluence.score} < 65, using pure math`);
      }

    } else {
      // AI mode — full Claude analysis (original behavior)
      analysis = await analyzeWithClaude(symbol, multiTFData, session, confluence, htfBias, perf, atrInfo, ictSequence);
    }

    if (!analysis || analysis.direction === "HOLD") {
      await log("info", "signalEngine", `${symbol}: HOLD — ${analysis?.smc_context?.entry_model_quality || "no setup"}`);
      return null;
    }

    // ── DXY Confluence Check ──────────────────────────────────────────────────
    const dxyCheck = getDXYConflict(symbol, analysis.direction, multiTFData);
    if (dxyCheck.conflict) {
      await log("info", "signalEngine", `${symbol}: DXY conflict — ${dxyCheck.reason}`);
      return null;
    }

    // ── Session Bias Projection Filter ────────────────────────────────────────
    // If London→NY bias conflicts AND there is no HTF support, skip
    if (sessionBias.biasDirection && sessionBias.biasDirection !== analysis.direction && htfBias.bias === "neutral") {
      await log("info", "signalEngine", `${symbol}: Session bias ${sessionBias.biasDirection} conflicts with ${analysis.direction} + HTF neutral — skipping`);
      return null;
    }

    // ── Midnight NY Open Array Filter ─────────────────────────────────────────
    if (midnightArray) {
      if (analysis.direction === "BUY" && midnightArray.zone === "premium") {
        analysis.confidence = Math.max(analysis.confidence - 0.08, 0.40);
        await log("info", "signalEngine", `${symbol}: BUY in premium (above midnight open) — conf reduced to ${analysis.confidence}`);
      }
      if (analysis.direction === "SELL" && midnightArray.zone === "discount") {
        analysis.confidence = Math.max(analysis.confidence - 0.08, 0.40);
        await log("info", "signalEngine", `${symbol}: SELL in discount (below midnight open) — conf reduced to ${analysis.confidence}`);
      }
    }

    // ── Session Bias Projection ──────────────────────────────────────────────
    if (sessionBias.biasDirection && sessionBias.biasDirection !== analysis.direction && htfBias.bias === "neutral") {
      await log("info","signalEngine",`${symbol}: Session bias ${sessionBias.biasDirection} conflicts ${analysis.direction} + HTF neutral — skip`);
      return null;
    }

    // ── Midnight NY Open Array ────────────────────────────────────────────────
    if (midnightArray) {
      if (analysis.direction==="BUY"  && midnightArray.zone==="premium")  analysis.confidence = Math.max(analysis.confidence-0.08,0.40);
      if (analysis.direction==="SELL" && midnightArray.zone==="discount") analysis.confidence = Math.max(analysis.confidence-0.08,0.40);
    }

    // Confidence thresholds — calibrated per setup quality
    let minConf = 0.48; // base threshold slightly lower to allow more signals
    if (atrRatio >= 2.5) minConf = 0.65; // spike = must be very confident
    if (ictSequence.hasFullSequence && session.entryModel) minConf = 0.42; // perfect setup
    if (ictSequence.hasFullSequence) minConf = 0.45; // full ICT sequence
    if (ictSequence.hasPartialSequence) minConf = 0.48; // partial sequence
    if (!ictSequence.hasFullSequence && !ictSequence.hasPartialSequence) minConf = 0.48; // no sequence needs more confidence

    if (analysis.confidence < minConf) {
      await log("info", "signalEngine", `${symbol}: Confidence ${analysis.confidence} < ${minConf}`);
      return null;
    }

    // Calculate SL/TP with structural anchoring
    const h4Price = primaryInd.currentPrice;
    if (!h4Price || !currentATR) return null;

    // ── M5 PRECISION ENTRY ────────────────────────────────────────────────────
    // Only inside kill zones — M5 noise outside kill zones is too high
    let m5Entry = null;
    let entryPrice = h4Price;
    let entryTimeframe = "H4";

    if (session.killZone && m5Bars && m5Bars.length >= 10) {
      // Find the H4 zone to watch for M5 entry
      // Use H4 FVG zone if available, otherwise H4 OB zone
      let h4Zone = null;

      if (fvgs.length > 0) {
        const relevantFVG = fvgs.find(f =>
          analysis.direction === "BUY" ? f.type === "BULLISH_FVG" : f.type === "BEARISH_FVG"
        );
        if (relevantFVG) h4Zone = { high: relevantFVG.high, low: relevantFVG.low, source: "H4_FVG" };
      }

      if (!h4Zone && obs.length > 0) {
        const relevantOB = obs.find(o =>
          analysis.direction === "BUY" ? o.type === "BULLISH_OB" : o.type === "BEARISH_OB"
        );
        if (relevantOB) h4Zone = { high: relevantOB.high, low: relevantOB.low, source: "H4_OB" };
      }

      // If no specific zone, use a buffer around current H4 price as the zone
      if (!h4Zone) {
        const zoneBuffer = currentATR * 0.5;
        h4Zone = {
          high: h4Price + zoneBuffer,
          low: h4Price - zoneBuffer,
          source: "H4_PRICE_BUFFER"
        };
      }

      // Calculate M5 ATR for entry validation
      const m5Atr = atrCalc(m5Bars, 14);

      if (m5Atr) {
        m5Entry = detectM5Entry(m5Bars, analysis.direction, h4Zone, m5Atr, symbol);

        if (m5Entry?.found) {
          entryPrice = m5Entry.entryPrice;
          entryTimeframe = "M5";
          await log("info", "signalEngine",
            `${symbol}: M5 entry found @ ${entryPrice} | SL: ${m5Entry.stopLoss} (${m5Entry.slPips}pips) | H4 zone: ${h4Zone.low}-${h4Zone.high} [${h4Zone.source}]`
          );
        } else {
          await log("info", "signalEngine",
            `${symbol}: No M5 entry candle in H4 zone — using H4 price`
          );
        }
      }
    }

    // Build SL/TP — if M5 entry found, use M5 SL; otherwise H4 structural SL
    let sltp;
    if (m5Entry?.found) {
      // M5 SL is already validated in detectM5Entry
      const risk = Math.abs(entryPrice - m5Entry.stopLoss);
      const rrRatio = Math.max(analysis.reward_risk_ratio || 2.5, 2.5);

      // TP still from H4 liquidity targets — same destination, tighter risk = better RR
      const h4sltp = calculateStructuralSLTP(
        analysis.direction, h4Price, primaryInd, currentATR,
        symbol, ictSequence, rrRatio
      );

      sltp = {
        stopLoss: m5Entry.stopLoss,
        takeProfit: h4sltp.takeProfit, // H4 TP target
        tp1: h4sltp.tp1,
        tp2: h4sltp.tp2,
        tp3: h4sltp.tp3,
        slPips: m5Entry.slPips,
        rrActual: parseFloat((Math.abs(h4sltp.takeProfit - entryPrice) / risk).toFixed(2)),
        usedStructuralSL: false,
        usedM5Entry: true
      };
    } else {
      // Fall back to H4 structural SL/TP
      sltp = calculateStructuralSLTP(
        analysis.direction, h4Price, primaryInd, currentATR,
        symbol, ictSequence, analysis.reward_risk_ratio
      );
      sltp.usedM5Entry = false;
    }

    // ── Pending Order Type Selection ─────────────────────────────────────────
    // Retest of FVG/OB → limit order (price must come to us).
    // Breakout/sweep momentum → market order.
    // Scalp mode → always market (time-critical).
    let orderType = "MARKET";
    let pendingOrderPrice = null;

    if (tradingMode !== TRADING_MODES.SCALP && retest) {
      if (analysis.direction === "BUY" && retest.type?.includes("BULLISH")) {
        orderType = "BUY_LIMIT";
        pendingOrderPrice = parseFloat(retest.low.toFixed(5));
      } else if (analysis.direction === "SELL" && retest.type?.includes("BEARISH")) {
        orderType = "SELL_LIMIT";
        pendingOrderPrice = parseFloat(retest.high.toFixed(5));
      }
    } else if (tradingMode !== TRADING_MODES.SCALP && ictSequence.sweep && !retest) {
      // Sweep detected but no retest yet — use limit slightly inside current price
      if (analysis.direction === "BUY") {
        orderType = "BUY_LIMIT";
        pendingOrderPrice = parseFloat((entryPrice * 0.9998).toFixed(5));
      } else {
        orderType = "SELL_LIMIT";
        pendingOrderPrice = parseFloat((entryPrice * 1.0002).toFixed(5));
      }
    }

    await log("info", "signalEngine", `${symbol}: Order type → ${orderType}${pendingOrderPrice ? ` @ ${pendingOrderPrice}` : ""}`);

    // Build signal
    const signal = {
      symbol,
      direction: analysis.direction,
      entry_price: pendingOrderPrice || entryPrice,
      stop_loss: sltp.stopLoss,
      take_profit: sltp.takeProfit,
      order_type: orderType,
      pending_price: pendingOrderPrice,
      confidence: analysis.confidence,
      regime: analysis.regime,
      regime_detail: {
        ...analysis.regime_detail,
        smc_context: analysis.smc_context,
        entry_logic: analysis.entry_logic,
        sl_reasoning: analysis.sl_reasoning,
        tp1: sltp.tp1, tp2: sltp.tp2, tp3: sltp.tp3,
        tp1_logic: analysis.tp1_logic,
        tp2_logic: analysis.tp2_logic,
        session: session.name,
        entry_model: session.entryModel,
        sess_quality: session.sessQuality,
        kill_zone: session.killZone,
        confluence_score: confluence.score,
        confluence_grade: confluence.grade,
        htf_bias: htfBias.bias,
        position_size_modifier: analysis.position_size_modifier || 1.0,
        atr_ratio: atrRatio,
        sl_pips: sltp.slPips,
        rr_actual: sltp.rrActual,
        used_structural_sl: sltp.usedStructuralSL,
        used_m5_entry: sltp.usedM5Entry,
        entry_timeframe: entryTimeframe,
        m5_entry_price: m5Entry?.found ? m5Entry.entryPrice : null,
        m5_sl: m5Entry?.found ? m5Entry.stopLoss : null,
        m5_body_ratio: m5Entry?.found ? m5Entry.bodyRatio : null,
        h4_analysis_price: h4Price,
        volatility_spike: atrRatio >= 2.5,
        // Forecasting metadata
        htf_alignment: htfBias.alignment,
        htf_w1: htfBias.w1,
        htf_d1: htfBias.d1,
        htf_h4: htfBias.h4,
        htf_full_alignment: htfBias.fullAlignment,
        adr_pips: adrStatus.adr,
        adr_consumed_pct: adrStatus.consumedPct,
        session_bias_direction: sessionBias.biasDirection,
        session_bias_target: sessionBias.targetLevel,
        midnight_array_zone: midnightArray?.zone,
        midnight_array_level: midnightArray?.level,
        order_type: orderType,
        pending_price: pendingOrderPrice,
        // ICT sequence data
        ict_sweep: sweep ? `${sweep.type} @ ${sweep.sweptLevel?.toFixed(5)}` : null,
        ict_displacement: displacement ? `${displacement.atrRatio}x ATR` : null,
        ict_retest: retest ? `${retest.zone}:${retest.type}` : null,
        ict_full_sequence: ictSequence.hasFullSequence,
        ict_partial_sequence: ictSequence.hasPartialSequence,
        eq_highs: eqLiquidity?.eqh?.slice(0,3),
        eq_lows: eqLiquidity?.eql?.slice(0,3),
        buyer_strength: strength?.buyerStr,
        seller_strength: strength?.sellerStr,
        pd_zone: pdZone?.zone
      },
      sentiment_score: analysis.sentiment_score,
      timeframe: entryTimeframe,
      rationale: [
        `[${session.name}]`,
        `[HTF:${htfBias.bias.toUpperCase()}]`,
        `[SMC:${confluence.score}/100 ${confluence.grade}]`,
        ictSequence.hasFullSequence ? "[ICT:FULL✅]" : ictSequence.hasPartialSequence ? "[ICT:PARTIAL]" : "",
        sltp.usedM5Entry ? `[M5-ENTRY✅ SL:${sltp.slPips}pips RR:${sltp.rrActual}]` : "[H4-ENTRY]",
        sweep ? `[${sweep.type}]` : "",
        atrRatio >= 2.5 ? "⚠️SPIKE" : "",
        analysis.entry_logic,
        "|",
        analysis.rationale
      ].filter(Boolean).join(" "),
      status: "pending",
      expires_at: new Date(Date.now() + 2*60*60*1000).toISOString()
    };

    const { data, error } = await supabaseAdmin.from("signals").insert(signal).select().single();
    if (error) throw error;

    await log("info", "signalEngine",
      `✅ ${analysis.direction} ${symbol} @ ${entryPrice} [${entryTimeframe}] | Conf:${analysis.confidence} | ${session.name} | Grade:${confluence.grade} | SL:${sltp.slPips}pips | RR:${sltp.rrActual} | ICT:${ictSequence.hasFullSequence?"FULL":ictSequence.hasPartialSequence?"PARTIAL":"NONE"} | M5:${sltp.usedM5Entry?"✅":"❌"}`
    );
    return data;

  } catch (e) {
    await log("error", "signalEngine", `${symbol} error: ${e.message}`);
    return null;
  }
}

async function generateSignalForPair(symbol) {
  const ohlcvData = {};
  const timeframes = ["H4", "D1", "W1"];
  for (const tf of timeframes) {
    try {
      // FIX: this was querying open_price/high_price/low_price/close_price/bar_time,
      // which don't exist in ohlcv_cache — the table is actually written with
      // open/high/low/close/time (see backtest.js's /cache endpoint and
      // bridge.py's get_ohlcv/cache_ohlcv_for_backtest). This query was
      // silently returning nothing for every symbol/timeframe, meaning this
      // function — and the manual "Generate Signal" dashboard button that
      // calls it — never actually worked.
      const { data, error } = await supabaseAdmin
        .from("ohlcv_cache")
        .select("open, high, low, close, volume, time")
        .eq("symbol", symbol)
        .eq("timeframe", tf)
        .order("time", { ascending: true })
        .limit(250);
      if (error) {
        await log("warning", "signalEngine", `${symbol} ${tf}: ohlcv_cache query error: ${error.message}`);
        continue;
      }
      if (data && data.length >= 30) {
        ohlcvData[tf] = data.map(b => ({
          open:   parseFloat(b.open),
          high:   parseFloat(b.high),
          low:    parseFloat(b.low),
          close:  parseFloat(b.close),
          volume: b.volume || 0,
          time:   b.time
        }));
      }
    } catch(e) {
      await log("warning", "signalEngine", `${symbol} ${tf}: unexpected error fetching cached bars: ${e.message}`);
    }
  }
  if (!Object.keys(ohlcvData).length) {
    await log("info", "signalEngine", `${symbol}: No cached bars — HOLD`);
    return null;
  }
  return generateSignalFromOHLCV(symbol, ohlcvData);
}

async function generateSignalsForAllPairs() {
  const session = getSessionInfo();
  await log("info", "signalEngine",
    `Signal cycle — ${session.name} | Entry Model: ${session.entryModel} | Quality: ${session.sessQuality}/3 | Pairs: ${PAIRS.length}`
  );
  // FIX: this used to call generateSignalFromOHLCV(pair, {}) — an empty
  // object. Object.entries({}) is always empty, so generateSignalFromOHLCV
  // returned null immediately for every pair, every 15-minute cron cycle,
  // silently. This cron has never actually generated a signal. Fixed by
  // calling generateSignalForPair(pair), which fetches real H4/D1/W1 bars
  // from ohlcv_cache (see the column-name fix above — this also depended
  // on that being correct).
  //
  // Note: this only has H4/D1/W1 available (bridge.py doesn't cache
  // M5/M15 — they'd be stale by the time this cron reads them), so
  // signals from this path use H4 structural SL/TP rather than M5
  // precision entry. That's expected, not a bug — this cron is now a
  // genuine redundant safety net alongside the Python bridge's reactive
  // push, not the primary signal source. The existing duplicate-signal
  // check (hasRecentSignal) prevents this and the bridge's push from
  // double-firing on the same setup.
  const signals = [];
  for (const pair of PAIRS) {
    const s = await generateSignalForPair(pair);
    if (s) signals.push(s);
    await new Promise(r => setTimeout(r, 1500));
  }
  await log("info", "signalEngine", `Cycle complete — ${signals.length} signals generated`);
  return signals;
}

let commandQueue = [];
let commandResults = {};
function getAndClearCommands() { const c = [...commandQueue]; commandQueue = []; return c; }
function acknowledgeCommand(id, result) { commandResults[id] = result; }

module.exports = {
  generateSignalForPair,
  generateSignalsForAllPairs,
  generateSignalFromOHLCV,
  getAndClearCommands,
  acknowledgeCommand,
  getSessionInfo,
  PAIRS
};
