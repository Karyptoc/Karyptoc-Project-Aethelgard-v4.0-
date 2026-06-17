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
  ATR_SL_MULTIPLIERS,
  PIP_SIZES: BASE_PIP_SIZES,
  getRiskPercent
} = require("./riskEngine");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PAIRS = [
  "GOLD", "EURUSD", "GBPUSD", "USDJPY",
  "US30Cash", "GER40Cash", "BTCUSD",
  "AUDUSD", "USDCAD", "USDCHF", "NZDUSD",
  "GBPJPY", "EURJPY",
];

const PIP_SIZES = {
  ...BASE_PIP_SIZES,
  AUDUSD: 0.0001, USDCAD: 0.0001, USDCHF: 0.0001,
  NZDUSD: 0.0001, GBPJPY: 0.01, EURJPY: 0.01,
};

const PAIR_SESSIONS = {
  GOLD:     ["LONDON_OPEN","NY_OPEN","NY_MAIN","LONDON_MAIN"],
  EURUSD:   ["LONDON_OPEN","NY_OPEN","LONDON_MAIN","NY_MAIN"],
  GBPUSD:   ["LONDON_OPEN","NY_OPEN","LONDON_MAIN"],
  USDJPY:   ["ASIAN","LONDON_OPEN","NY_OPEN","LONDON_MAIN"],
  AUDUSD:   ["ASIAN","LONDON_OPEN","LONDON_MAIN"],
  USDCAD:   ["NY_OPEN","NY_MAIN","LONDON_MAIN"],
  USDCHF:   ["LONDON_OPEN","NY_OPEN","LONDON_MAIN"],
  NZDUSD:   ["ASIAN","LONDON_OPEN"],
  GBPJPY:   ["LONDON_OPEN","NY_OPEN","ASIAN"],
  EURJPY:   ["ASIAN","LONDON_OPEN","LONDON_MAIN"],
  US30Cash: ["NY_OPEN","NY_MAIN"],
  GER40Cash:["LONDON_OPEN","LONDON_MAIN"],
  BTCUSD:   ["LONDON_OPEN","NY_OPEN","NY_MAIN","NY_CLOSE"],
};

// H4 primary — backtest proven (PF 9.56 GOLD, PF 4.54 USDCAD)
const PAIR_PRIMARY_TF = {
  GOLD: "H4", GER40Cash: "H4", BTCUSD: "H4", US30Cash: "H4",
  USDCAD: "H4", USDJPY: "H4", EURUSD: "H4", GBPUSD: "H4",
  USDCHF: "H4", AUDUSD: "H4", NZDUSD: "H4", GBPJPY: "H4", EURJPY: "H4",
};

// ── Trading Mode ─────────────────────────────────────────────────────────────
// PURE_MATH: Zero API cost. ICT math score makes all decisions.
// HYBRID:    Claude only called when confluence score >= 65 (A-grade setups).
// AI:        Full Claude analysis on every pair (original behavior).

const TRADING_MODES = { PURE_MATH: "PURE_MATH", HYBRID: "HYBRID", AI: "AI" };

async function getTradingMode() {
  try {
    const { data } = await supabaseAdmin
      .from("platform_settings")
      .select("value")
      .eq("key", "trading_mode")
      .single();
    const mode = (data?.value || "AI").toUpperCase();
    return TRADING_MODES[mode] || TRADING_MODES.AI;
  } catch {
    return TRADING_MODES.AI; // default to AI if setting missing
  }
}

/**
 * PURE MATH DECISION ENGINE
 * Makes BUY/SELL/HOLD decision entirely from ICT confluence score.
 * Zero Claude API cost. Used in PURE_MATH mode and HYBRID mode (low scores).
 *
 * Decision logic:
 * - HTF bias must agree with direction
 * - Score >= minScore for the current session
 * - Sweep adds conviction (but not required)
 * - RSI must not be extreme against direction
 */
function makePureMathDecision(confluence, htfBias, ictSequence, ind, session) {
  const score = confluence.score;
  const htf = htfBias.bias;

  // Determine direction from multiple sources (in priority order)
  let direction = "HOLD";
  let directionSource = "";

  // 1. Clear HTF bias (strongest signal)
  if (htf === "bullish") {
    direction = "BUY"; directionSource = "HTF_BULL";
  } else if (htf === "bearish") {
    direction = "SELL"; directionSource = "HTF_BEAR";

  // 2. ICT sweep direction (institutional signal)
  } else if (ictSequence.sweep) {
    direction = ictSequence.sweep.type === "SSL_SWEEP" ? "BUY" : "SELL";
    directionSource = "ICT_SWEEP";

  // 3. BOS direction (structure break)
  } else if (ind.bos) {
    direction = ind.bos.type.includes("BULLISH") ? "BUY" : "SELL";
    directionSource = "BOS";

  // 4. CHoCH direction
  } else if (ind.choch) {
    direction = ind.choch.type.includes("BULLISH") ? "BUY" : "SELL";
    directionSource = "CHOCH";

  // 5. RSI extreme as last resort (only in kill zones)
  } else if (session.killZone) {
    const r = ind.rsi14;
    if (r < 35) { direction = "BUY"; directionSource = "RSI_OVERSOLD"; }
    else if (r > 65) { direction = "SELL"; directionSource = "RSI_OVERBOUGHT"; }
  }

  if (direction === "HOLD") {
    return { direction: "HOLD", confidence: 0, reason: "No directional signal — HTF neutral, no sweep/BOS/CHoCH" };
  }

  // RSI conflict check
  const r = ind.rsi14;
  if (direction === "BUY" && r > 78) {
    return { direction: "HOLD", confidence: 0, reason: `RSI overbought: ${r}` };
  }
  if (direction === "SELL" && r < 22) {
    return { direction: "HOLD", confidence: 0, reason: `RSI oversold: ${r}` };
  }

  // EMA conflict — only block if HTF was neutral (non-HTF direction source)
  if (directionSource !== "HTF_BULL" && directionSource !== "HTF_BEAR") {
    if (direction === "BUY" && !ind.bullish && score < 55) {
      return { direction: "HOLD", confidence: 0, reason: "EMA bearish + no HTF + low score" };
    }
    if (direction === "SELL" && ind.bullish && score < 55) {
      return { direction: "HOLD", confidence: 0, reason: "EMA bullish + no HTF + low score" };
    }
  }

  // Score → confidence mapping (slightly lower thresholds for non-HTF sources)
  const baseScore = directionSource === "HTF_BULL" || directionSource === "HTF_BEAR" ? score : score - 5;
  let confidence;
  if (baseScore >= 80) confidence = 0.82;
  else if (baseScore >= 70) confidence = 0.72;
  else if (baseScore >= 60) confidence = 0.63;
  else if (baseScore >= 50) confidence = 0.55;
  else if (baseScore >= 38) confidence = 0.50;
  else return { direction: "HOLD", confidence: 0, reason: `Score too low: ${score} (source: ${directionSource})` };

  // Boosts
  if (ictSequence.hasFullSequence) confidence = Math.min(confidence + 0.08, 0.88);
  else if (ictSequence.hasPartialSequence) confidence = Math.min(confidence + 0.04, 0.80);
  if (session.entryModel) confidence = Math.min(confidence + 0.05, 0.88);
  if (session.killZone && directionSource === "ICT_SWEEP") confidence = Math.min(confidence + 0.05, 0.85);

  // Volatility penalty
  if (ind.atr_ratio >= 2.5) confidence = Math.max(confidence - 0.15, 0.45);

  // Minimum confidence gate — relaxed for kill zone setups
  const minConf = ind.atr_ratio >= 2.5 ? 0.65 : session.killZone ? 0.48 : 0.50;
  if (confidence < minConf) {
    return { direction: "HOLD", confidence, reason: `Confidence ${confidence.toFixed(2)} < ${minConf} (${directionSource})` };
  }

  const regime = ind.atr_ratio >= 2.5 ? "HIGH_VOLATILITY" :
    ictSequence.hasFullSequence ? "BREAKOUT" :
    htf !== "neutral" ? (htf === "bullish" ? "TRENDING_BULL" : "TRENDING_BEAR") : "RANGING";

  return {
    direction,
    confidence: parseFloat(confidence.toFixed(2)),
    regime,
    regime_detail: {
      description: `Pure math ICT score ${score}/100 via ${directionSource}`,
      strength: parseFloat((score / 100).toFixed(2)),
      timeframe_alignment: htf !== "neutral" ? "aligned" : "mixed",
      direction_source: directionSource
    },
    smc_context: {
      structure: direction === "BUY" ? "bullish" : "bearish",
      ict_sequence_quality: ictSequence.hasFullSequence ? "full" : ictSequence.hasPartialSequence ? "partial" : "none",
      liquidity_target: ictSequence.eqLiquidity?.eqh?.length > 0 ? "EQH target" : ictSequence.eqLiquidity?.eql?.length > 0 ? "EQL target" : "Session level",
      htf_aligned: htf !== "neutral",
      entry_model_quality: score >= 75 ? "A" : score >= 60 ? "B" : score >= 45 ? "C" : "no_setup"
    },
    entry_logic: `[PURE MATH/${directionSource}] Score:${score} HTF:${htf} RSI:${r} EMA:${ind.bullish ? "bull" : "bear"} ${ictSequence.sweep?.type || ""}`,
    sl_reasoning: ictSequence.sweep ? `Structural SL at swept level` : "ATR-based SL",
    stop_loss_pips: 0,
    reward_risk_ratio: ictSequence.hasFullSequence ? 3.0 : score >= 65 ? 2.5 : 2.0,
    tp1_logic: "Session level TP1",
    tp2_logic: "2.5R from entry",
    sentiment_score: direction === "BUY" ? parseFloat((confidence - 0.5).toFixed(2)) : parseFloat((0.5 - confidence).toFixed(2)),
    rationale: `Pure math: ${direction} via ${directionSource} | Score ${score}/100 | ${session.name} | ICT:${ictSequence.hasFullSequence ? "FULL" : ictSequence.hasPartialSequence ? "PARTIAL" : "NONE"}`,
    invalidation: direction === "BUY" ? `Below ${(ind.currentPrice * 0.998).toFixed(5)}` : `Above ${(ind.currentPrice * 1.002).toFixed(5)}`,
    timeframe_primary: "H4",
    position_size_modifier: score >= 75 ? 1.2 : score >= 60 ? 1.0 : 0.7,
    mode: "PURE_MATH"
  };
}

// ── Session Detection ─────────────────────────────────────────────────────────

function getSessionInfo() {
  const now = new Date();
  const utcDecimal = now.getUTCHours() + now.getUTCMinutes() / 60;
  const day = now.getUTCDay();
  if (day === 0 && utcDecimal < 22) return { session: "WEEKEND", killZone: false, strength: 0, name: "Weekend", entryModel: false, sessQuality: 0 };
  if (day === 6) return { session: "WEEKEND", killZone: false, strength: 0, name: "Weekend", entryModel: false, sessQuality: 0 };

  // Precision entry model windows (from Indicator 2 — tightest, highest probability)
  // London Entry: 06:00-08:00 UTC (02:00-04:00 NY)
  // NY Entry:     12:30-14:00 UTC (08:30-10:00 NY)
  const inLondonEntry = utcDecimal >= 6 && utcDecimal < 8;
  const inNYEntry = utcDecimal >= 12.5 && utcDecimal < 14;
  // ICT Asian Kill Zone: 00:00-04:00 UTC (20:00-00:00 NY / 03:00-07:00 EAT)
  // Prime window for USDJPY, AUDUSD, NZDUSD, EURJPY
  const inAsianKZ = utcDecimal >= 0 && utcDecimal < 4;

  if (inLondonEntry) return { session: "LONDON_OPEN", killZone: true, strength: 1.0, name: "★ London Entry Model 02:00-04:00 NY", entryModel: true, sessQuality: 3 };
  if (inNYEntry)     return { session: "NY_OPEN",     killZone: true, strength: 1.0, name: "★ NY Entry Model 08:30-10:00 NY",    entryModel: true, sessQuality: 3 };
  if (inAsianKZ)     return { session: "ASIAN",       killZone: true, strength: 0.8, name: "Asian Kill Zone 20:00-00:00 NY",     entryModel: false, sessQuality: 2 };

  if (utcDecimal >= 4 && utcDecimal < 6)   return { session: "ASIAN",       killZone: false, strength: 0.4, name: "Asian Session (late)",  entryModel: false, sessQuality: 1 };
  if (utcDecimal >= 7 && utcDecimal < 9)   return { session: "LONDON_OPEN", killZone: true,  strength: 0.9, name: "London Kill Zone",       entryModel: false, sessQuality: 2 };
  if (utcDecimal >= 9 && utcDecimal < 13)  return { session: "LONDON_MAIN", killZone: false, strength: 0.75, name: "London Session",         entryModel: false, sessQuality: 1 };
  if (utcDecimal >= 13 && utcDecimal < 16) return { session: "NY_OPEN",     killZone: true,  strength: 0.9, name: "NY Kill Zone",           entryModel: false, sessQuality: 2 };
  if (utcDecimal >= 16 && utcDecimal < 20) return { session: "NY_MAIN",     killZone: false, strength: 0.65, name: "New York Session",       entryModel: false, sessQuality: 1 };
  if (utcDecimal >= 20 && utcDecimal < 22) return { session: "NY_CLOSE",    killZone: true,  strength: 0.75, name: "NY Close",               entryModel: false, sessQuality: 2 };
  if (utcDecimal >= 22)                    return { session: "ASIAN",        killZone: false, strength: 0.3, name: "Pre-Asian (quiet)",       entryModel: false, sessQuality: 0 };
  return { session: "DEAD_ZONE", killZone: false, strength: 0.1, name: "Dead Zone", entryModel: false, sessQuality: 0 };
}

function isPairActiveInSession(symbol, session) {
  return (PAIR_SESSIONS[symbol] || ["LONDON_OPEN","NY_OPEN"]).includes(session);
}

function isNewsBlackout() {
  const now = new Date();
  const utcDecimal = now.getUTCHours() + now.getUTCMinutes() / 60;
  const day = now.getUTCDay();
  if (day === 5 && utcDecimal >= 12 && utcDecimal < 14) return { blocked: true, reason: "Friday NFP window" };
  if (day === 3 && utcDecimal >= 17.5 && utcDecimal < 20) return { blocked: true, reason: "FOMC window" };
  if (day === 4 && utcDecimal >= 12 && utcDecimal < 13.5) return { blocked: true, reason: "ECB window" };
  return { blocked: false };
}

// ── Duplicate Prevention ──────────────────────────────────────────────────────

async function getDuplicateWindow() {
  try {
    const { data } = await supabaseAdmin
      .from("platform_settings").select("value")
      .eq("key", "duplicate_signal_minutes").single();
    return parseInt(data?.value) || 20;
  } catch { return 20; }
}

async function hasRecentSignal(symbol, minutes = 20) {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const { data } = await supabaseAdmin
    .from("signals").select("id, direction, created_at")
    .eq("symbol", symbol).gte("created_at", cutoff)
    .order("created_at", { ascending: false }).limit(1);
  return data?.length > 0 ? data[0] : null;
}

// ── Technical Analysis ────────────────────────────────────────────────────────

function ema(data, period) {
  if (data.length < period) return data[data.length - 1];
  const k = 2 / (period + 1);
  let val = data.slice(0, period).reduce((a,b)=>a+b,0) / period;
  for (let i = period; i < data.length; i++) val = data[i]*k + val*(1-k);
  return parseFloat(val.toFixed(6));
}

function rsi(data, period = 14) {
  if (data.length < period + 1) return 50;
  let gains = 0, losses = 0;
  const slice = data.slice(-(period + 1));
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i-1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  if (losses === 0) return 100;
  return parseFloat((100 - 100 / (1 + gains/losses)).toFixed(2));
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
  return parseFloat((tr.slice(-period).reduce((a,b)=>a+b,0)/period).toFixed(6));
}

function atrHistorical(bars, period = 14, lookback = 50) {
  if (!bars || bars.length < lookback) return null;
  const olderBars = bars.slice(-lookback, -period);
  return atrCalc(olderBars, period);
}

// ── ICT Structure Detection ───────────────────────────────────────────────────

/**
 * Detect Break of Structure (BOS) and Change of Character (CHoCH)
 * Uses swing pivots (left=10, right=3 for H4 bars)
 */
function detectMarketStructure(bars) {
  if (!bars || bars.length < 25) return { bos: null, choch: null, trend: "neutral" };

  const len = bars.length;
  const lookback = Math.min(20, len - 3);
  let swingHighs = [], swingLows = [];

  // Find swing points
  for (let i = 3; i < lookback; i++) {
    const idx = len - 1 - i;
    // Swing high: higher than 3 bars on each side
    if (bars[idx].high > bars[idx-1].high && bars[idx].high > bars[idx-2].high &&
        bars[idx].high > bars[idx+1].high && bars[idx].high > bars[idx+2].high) {
      swingHighs.push({ price: bars[idx].high, idx });
    }
    // Swing low: lower than 3 bars on each side
    if (bars[idx].low < bars[idx-1].low && bars[idx].low < bars[idx-2].low &&
        bars[idx].low < bars[idx+1].low && bars[idx].low < bars[idx+2].low) {
      swingLows.push({ price: bars[idx].low, idx });
    }
  }

  const currentClose = bars[len-1].close;
  const prevClose = bars[len-2].close;

  // BOS: current close breaks beyond last swing point
  let bos = null, choch = null, trend = "neutral";

  if (swingHighs.length > 0) {
    const lastSwingHigh = swingHighs[0].price;
    if (currentClose > lastSwingHigh && prevClose <= lastSwingHigh) {
      bos = { type: "BULLISH_BOS", level: lastSwingHigh };
      trend = "bullish";
    }
  }
  if (swingLows.length > 0) {
    const lastSwingLow = swingLows[0].price;
    if (currentClose < lastSwingLow && prevClose >= lastSwingLow) {
      bos = { type: "BEARISH_BOS", level: lastSwingLow };
      trend = "bearish";
    }
  }

  // CHoCH detected when BOS occurs against the prevailing trend
  if (bos) {
    const priorTrend = swingHighs.length >= 2 && swingLows.length >= 2
      ? (swingHighs[0].price < swingHighs[1].price ? "bearish" : "bullish")
      : "neutral";
    if ((bos.type === "BULLISH_BOS" && priorTrend === "bearish") ||
        (bos.type === "BEARISH_BOS" && priorTrend === "bullish")) {
      choch = { ...bos, type: bos.type.replace("BOS", "CHOCH") };
    }
  }

  return { bos, choch, trend, swingHighs, swingLows };
}

/**
 * NEW: SSL/BSL Liquidity Sweep Detection (from Indicator 2)
 * SSL Sweep (Sell-Side Liquidity): wick below recent low, closes back above → BUY setup
 * BSL Sweep (Buy-Side Liquidity): wick above recent high, closes back below → SELL setup
 */
function detectLiquiditySweep(bars, lookback = 15) {
  if (!bars || bars.length < lookback + 3) return null;
  const len = bars.length;

  // Recent range for sweep detection (exclude last 2 bars)
  const recentBars = bars.slice(len - lookback - 2, len - 2);
  const recentHigh = Math.max(...recentBars.map(b => b.high));
  const recentLow  = Math.min(...recentBars.map(b => b.low));

  const prev = bars[len-2]; // confirmed bar
  const curr = bars[len-1]; // current bar

  // SSL Sweep: wick below recent low, close back above → bullish setup
  if (prev.low < recentLow && prev.close > recentLow && prev.close > prev.open) {
    return {
      type: "SSL_SWEEP",
      direction: "BUY",
      sweptLevel: recentLow,
      sweepBar: prev,
      slAnchor: recentLow // SL placed below swept level
    };
  }

  // BSL Sweep: wick above recent high, close back below → bearish setup
  if (prev.high > recentHigh && prev.close < recentHigh && prev.close < prev.open) {
    return {
      type: "BSL_SWEEP",
      direction: "SELL",
      sweptLevel: recentHigh,
      sweepBar: prev,
      slAnchor: recentHigh // SL placed above swept level
    };
  }

  return null;
}

/**
 * NEW: Displacement Candle Detection (from Indicator 2)
 * MSS requires displacement: body > 1.5x ATR, body > 50% of range
 * Filters out fake breakouts
 */
function detectDisplacement(bars, atrVal) {
  if (!bars || bars.length < 3 || !atrVal) return null;
  const len = bars.length;
  const bar = bars[len-2]; // last confirmed bar

  const bodySize = Math.abs(bar.close - bar.open);
  const fullRange = bar.high - bar.low;
  const bodyPct = fullRange > 0 ? bodySize / fullRange : 0;
  const isBull = bar.close > bar.open;
  const isBear = bar.close < bar.open;

  const isDisplacement = bodySize > atrVal * 1.5 && bodyPct > 0.5;

  if (!isDisplacement) return null;

  return {
    direction: isBull ? "BUY" : "SELL",
    bodySize,
    bodyPct: parseFloat(bodyPct.toFixed(2)),
    atrRatio: parseFloat((bodySize / atrVal).toFixed(2)),
    displacementLow: bar.low,
    displacementHigh: bar.high
  };
}

/**
 * Detect Order Blocks (OBs) — both swing and internal
 * Triggered on BOS/MSS confirmation
 */
function detectOBs(bars) {
  if (!bars || bars.length < 10) return [];
  const len = bars.length, obs = [];
  for (let i = len-10; i < len-2; i++) {
    const b = bars[i], n = bars[i+1];
    const range = b.high - b.low;
    // Bullish OB: bearish candle followed by strong bullish move (1.5x range)
    if (b.close < b.open && n.close > n.open && (n.close-n.open) > range*1.5)
      obs.push({ type: "BULLISH_OB", high: b.high, low: b.low, idx: i });
    // Bearish OB: bullish candle followed by strong bearish move
    if (b.close > b.open && n.close < n.open && (n.open-n.close) > range*1.5)
      obs.push({ type: "BEARISH_OB", high: b.high, low: b.low, idx: i });
  }
  return obs.slice(-3); // last 3 OBs
}

/**
 * Detect Fair Value Gaps (FVGs)
 * BULL FVG: low[current] > high[2 bars ago]
 * BEAR FVG: low[2 bars ago] > high[current]
 */
function detectFVGs(bars, atrVal) {
  if (!bars || bars.length < 4 || !atrVal) return [];
  const len = bars.length;
  const fvgs = [];
  const minSize = atrVal * 0.2; // ATR floor for FVG size

  for (let i = 2; i < Math.min(len-1, 12); i++) {
    const curr = bars[len-1-i+2];
    const mid  = bars[len-1-i+1];
    const prev = bars[len-1-i];

    if (!curr || !mid || !prev) continue;

    // Bullish FVG: gap between prev.high and curr.low
    const bullGap = curr.low - prev.high;
    if (bullGap > minSize && mid.close > mid.open) {
      fvgs.push({ type: "BULLISH_FVG", high: curr.low, low: prev.high, size: bullGap, idx: len-1-i });
    }

    // Bearish FVG: gap between curr.high and prev.low
    const bearGap = prev.low - curr.high;
    if (bearGap > minSize && mid.close < mid.open) {
      fvgs.push({ type: "BEARISH_FVG", high: prev.low, low: curr.high, size: bearGap, idx: len-1-i });
    }
  }
  return fvgs.slice(0, 3);
}

/**
 * NEW: Equal Highs/Lows Detection (EQH/EQL) — resting liquidity pools
 * From Indicator 2: clusters of equal swing points = institutional stop targets
 */
function detectEqualHighsLows(bars, atrVal) {
  if (!bars || bars.length < 20 || !atrVal) return { eqh: [], eql: [] };

  const threshold = atrVal * 0.15; // within 0.15x ATR = "equal"
  const pivotBars = bars.slice(-20);
  const eqh = [], eql = [];

  // Find swing highs and lows
  const swingHighs = [], swingLows = [];
  for (let i = 2; i < pivotBars.length - 2; i++) {
    if (pivotBars[i].high > pivotBars[i-1].high && pivotBars[i].high > pivotBars[i-2].high &&
        pivotBars[i].high > pivotBars[i+1].high && pivotBars[i].high > pivotBars[i+2].high) {
      swingHighs.push(pivotBars[i].high);
    }
    if (pivotBars[i].low < pivotBars[i-1].low && pivotBars[i].low < pivotBars[i-2].low &&
        pivotBars[i].low < pivotBars[i+1].low && pivotBars[i].low < pivotBars[i+2].low) {
      swingLows.push(pivotBars[i].low);
    }
  }

  // Find clusters of equal highs
  for (let i = 0; i < swingHighs.length; i++) {
    for (let j = i+1; j < swingHighs.length; j++) {
      if (Math.abs(swingHighs[i] - swingHighs[j]) < threshold) {
        const lvl = (swingHighs[i] + swingHighs[j]) / 2;
        if (!eqh.find(e => Math.abs(e - lvl) < threshold)) {
          eqh.push(parseFloat(lvl.toFixed(5)));
        }
      }
    }
  }

  // Find clusters of equal lows
  for (let i = 0; i < swingLows.length; i++) {
    for (let j = i+1; j < swingLows.length; j++) {
      if (Math.abs(swingLows[i] - swingLows[j]) < threshold) {
        const lvl = (swingLows[i] + swingLows[j]) / 2;
        if (!eql.find(e => Math.abs(e - lvl) < threshold)) {
          eql.push(parseFloat(lvl.toFixed(5)));
        }
      }
    }
  }

  return { eqh, eql, swingHighs, swingLows };
}

/**
 * NEW: Buyer/Seller Strength Engine — 7 factors from Indicator 2
 */
function calculateStrength(bars, atrVal) {
  if (!bars || bars.length < 20 || !atrVal) return { buyerStr: 50, sellerStr: 50 };

  const len = bars.length;
  const recentBars = bars.slice(-20);

  // 1. Volume bias (directional volume)
  const bullVol = recentBars.filter(b => b.close > b.open).reduce((s,b)=>s+b.volume,0);
  const bearVol = recentBars.filter(b => b.close < b.open).reduce((s,b)=>s+b.volume,0);
  const totalVol = bullVol + bearVol + 1;
  const f1b = Math.min(bullVol / totalVol * 20, 20);
  const f1s = Math.min(bearVol / totalVol * 20, 20);

  // 2. Body dominance (last 5 bars)
  const last5 = bars.slice(-5);
  const f2b = last5.filter(b=>b.close>b.open).length / 5 * 15;
  const f2s = last5.filter(b=>b.close<b.open).length / 5 * 15;

  // 3. RSI
  const closes = bars.map(b=>b.close);
  const r = rsi(closes, 14);
  const f3b = Math.max((r - 50) / 50 * 15, 0);
  const f3s = Math.max((50 - r) / 50 * 15, 0);

  // 4. EMA alignment
  const e20 = ema(closes, 20);
  const e50 = ema(closes, Math.min(50, closes.length-1));
  const price = closes[len-1];
  const f4b = (price > e20 && e20 > e50) ? 15 : (price > e20) ? 7 : 0;
  const f4s = (price < e20 && e20 < e50) ? 15 : (price < e20) ? 7 : 0;

  // 5. ATR momentum (current ATR vs average)
  const histATR = atrHistorical(bars, 14, 50);
  const atrRatio = histATR ? atrVal / histATR : 1.0;
  const f5b = (atrRatio > 1.2 && bars[len-1].close > bars[len-1].open) ? 10 : 5;
  const f5s = (atrRatio > 1.2 && bars[len-1].close < bars[len-1].open) ? 10 : 5;

  // 6. Recent performance (wins vs losses last 5 bars)
  const recentWins = last5.filter(b=>b.close>b.open).length;
  const f6b = recentWins / 5 * 15;
  const f6s = (5 - recentWins) / 5 * 15;

  // 7. Price location in range
  const high20 = Math.max(...recentBars.map(b=>b.high));
  const low20  = Math.min(...recentBars.map(b=>b.low));
  const range20 = high20 - low20 + 1e-10;
  const pctInRange = (price - low20) / range20;
  const f7b = pctInRange < 0.3 ? 10 : 5; // discount zone = bullish
  const f7s = pctInRange > 0.7 ? 10 : 5; // premium zone = bearish

  const buyerStr = Math.min(Math.round(f1b+f2b+f3b+f4b+f5b+f6b+f7b), 100);
  const sellerStr = Math.min(Math.round(f1s+f2s+f3s+f4s+f5s+f6s+f7s), 100);

  return { buyerStr, sellerStr, rsi: r, ema20: e20, ema50: e50, atrRatio: parseFloat((atrRatio||1).toFixed(2)) };
}

/**
 * NEW: Check if price is retesting a FVG or OB (retest entry trigger)
 * Returns the zone being retested and expected entry direction
 */
function checkRetest(bars, fvgs, obs, direction) {
  if (!bars || bars.length < 2) return null;
  const currentPrice = bars[bars.length-1].close;
  const prevPrice    = bars[bars.length-2].close;

  // Check FVG retest
  for (const fvg of fvgs) {
    if (direction === "BUY" && fvg.type === "BULLISH_FVG") {
      if (currentPrice >= fvg.low && currentPrice <= fvg.high) {
        return { zone: "FVG", type: "BULLISH_FVG", high: fvg.high, low: fvg.low, size: fvg.size };
      }
    }
    if (direction === "SELL" && fvg.type === "BEARISH_FVG") {
      if (currentPrice >= fvg.low && currentPrice <= fvg.high) {
        return { zone: "FVG", type: "BEARISH_FVG", high: fvg.high, low: fvg.low, size: fvg.size };
      }
    }
  }

  // Check OB retest
  for (const ob of obs) {
    if (direction === "BUY" && ob.type === "BULLISH_OB") {
      if (currentPrice >= ob.low && currentPrice <= ob.high) {
        return { zone: "OB", type: "BULLISH_OB", high: ob.high, low: ob.low };
      }
    }
    if (direction === "SELL" && ob.type === "BEARISH_OB") {
      if (currentPrice >= ob.low && currentPrice <= ob.high) {
        return { zone: "OB", type: "BEARISH_OB", high: ob.high, low: ob.low };
      }
    }
  }

  return null;
}

/**
 * M5 PRECISION ENTRY DETECTION
 * ─────────────────────────────────────────────────────────────────────────────
 * H4 identifies WHERE to trade (FVG zone, OB zone, swept level)
 * M5 identifies WHEN to enter (first valid M5 candle inside that zone)
 *
 * Entry trigger: M5 displacement candle whose body > 0.8x M5 ATR
 * inside the H4 structural zone. This gives:
 *   - Entry price: M5 candle close (precise, not H4 approximate)
 *   - SL: M5 candle low -buffer (BUY) or M5 candle high +buffer (SELL)
 *   - TP: still from H4 EQH/EQL targets (same destination, tighter risk)
 *
 * Only activates during kill zone windows to avoid M5 noise.
 *
 * @param {Array} m5Bars - M5 OHLCV bars (last 40 bars = 200 minutes)
 * @param {string} direction - "BUY" or "SELL"
 * @param {Object} h4Zone - H4 zone {high, low} from FVG or OB
 * @param {number} m5Atr - ATR calculated on M5 bars
 * @param {string} symbol - pair name for pip size
 * @returns {Object|null} M5 entry details or null if no valid candle
 */
function detectM5Entry(m5Bars, direction, h4Zone, m5Atr, symbol) {
  if (!m5Bars || m5Bars.length < 10 || !h4Zone || !m5Atr) return null;

  const pip = PIP_SIZES[symbol] || 0.0001;
  const minBodySize = m5Atr * 0.8; // displacement on M5 = 0.8x M5 ATR (lower than H4 1.5x)

  // Scan last 12 M5 bars (= last 60 minutes) for valid entry candle
  // Start from most recent and work backwards
  const scanBars = m5Bars.slice(-12);

  for (let i = scanBars.length - 1; i >= 0; i--) {
    const bar = scanBars[i];
    const bodySize = Math.abs(bar.close - bar.open);
    const isBullish = bar.close > bar.open;
    const isBearish = bar.close < bar.open;

    // Check if bar close is INSIDE the H4 zone
    const insideZone = bar.close >= h4Zone.low && bar.close <= h4Zone.high;
    if (!insideZone) continue;

    // BUY: need bullish M5 candle inside H4 bullish FVG/OB
    if (direction === "BUY" && isBullish && bodySize >= minBodySize) {
      const slBuffer = m5Atr * 0.5;
      const m5SL = parseFloat((bar.low - slBuffer).toFixed(5));
      const m5Entry = parseFloat(bar.close.toFixed(5));

      // Sanity: SL must be below entry
      if (m5SL >= m5Entry) continue;

      // Minimum SL distance check
      const slPips = (m5Entry - m5SL) / pip;
      const minPips = symbol === "GOLD" ? 80 :
                      symbol === "BTCUSD" ? 500 :
                      symbol === "GBPJPY" ? 50 :
                      symbol === "EURJPY" ? 30 :
                      symbol === "USDJPY" ? 20 :
                      ["US30Cash","GER40Cash"].includes(symbol) ? 30 : 10;
      if (slPips < minPips) continue;

      return {
        found: true,
        entryPrice: m5Entry,
        stopLoss: m5SL,
        slPips: parseFloat(slPips.toFixed(1)),
        entryCandle: { open: bar.open, high: bar.high, low: bar.low, close: bar.close },
        bodyRatio: parseFloat((bodySize / m5Atr).toFixed(2)),
        timeframe: "M5",
        barsAgo: scanBars.length - 1 - i
      };
    }

    // SELL: need bearish M5 candle inside H4 bearish FVG/OB
    if (direction === "SELL" && isBearish && bodySize >= minBodySize) {
      const slBuffer = m5Atr * 0.5;
      const m5SL = parseFloat((bar.high + slBuffer).toFixed(5));
      const m5Entry = parseFloat(bar.close.toFixed(5));

      // Sanity: SL must be above entry
      if (m5SL <= m5Entry) continue;

      const slPips = (m5SL - m5Entry) / pip;
      const minPips = symbol === "GOLD" ? 80 :
                      symbol === "BTCUSD" ? 500 :
                      symbol === "GBPJPY" ? 50 :
                      symbol === "EURJPY" ? 30 :
                      symbol === "USDJPY" ? 20 :
                      ["US30Cash","GER40Cash"].includes(symbol) ? 30 : 10;
      if (slPips < minPips) continue;

      return {
        found: true,
        entryPrice: m5Entry,
        stopLoss: m5SL,
        slPips: parseFloat(slPips.toFixed(1)),
        entryCandle: { open: bar.open, high: bar.high, low: bar.low, close: bar.close },
        bodyRatio: parseFloat((bodySize / m5Atr).toFixed(2)),
        timeframe: "M5",
        barsAgo: scanBars.length - 1 - i
      };
    }
  }

  return null; // no valid M5 entry candle found in the zone
}

/**
 * Premium/Discount zone check
 */
function getPremiumDiscount(bars, lookback = 20) {
  if (!bars || bars.length < lookback) return { zone: "neutral", pct: 0.5 };
  const recent = bars.slice(-lookback);
  const high = Math.max(...recent.map(b=>b.high));
  const low  = Math.min(...recent.map(b=>b.low));
  const range = high - low + 1e-10;
  const price = bars[bars.length-1].close;
  const pct = (price - low) / range;
  const zone = pct > 0.7 ? "premium" : pct < 0.3 ? "discount" : "equilibrium";
  return { zone, pct: parseFloat(pct.toFixed(2)), rangeHigh: high, rangeLow: low };
}

function getHTFBias(h4Bars) {
  if (!h4Bars || h4Bars.length < 20) return { bias: "neutral", strength: 0.5 };
  const closes = h4Bars.map(b=>b.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, Math.min(50, closes.length-1));
  const price = closes[closes.length-1];
  const r = rsi(closes, 14);
  if (price > e20 && e20 > e50) return { bias: "bullish", strength: r > 50 ? 0.9 : 0.65 };
  if (price < e20 && e20 < e50) return { bias: "bearish", strength: r < 50 ? 0.9 : 0.65 };
  return { bias: price > e20 ? "bullish" : "bearish", strength: 0.5 };
}

/**
 * UPGRADED Confluence Scoring — incorporates ICT sequence quality
 * Now rewards: sweep detection, displacement, retest, EQH/EQL, strength engine
 */
function scoreConfluence(ind, session, htfBias, isPairActive, ictSequence) {
  let score = 0;
  const factors = [];

  // Session quality (from Indicator 2 sessQuality 0-3)
  const sq = session.sessQuality || 0;
  if (sq === 3) { score += 40; factors.push(`★ Entry Model: ${session.name}`); }
  else if (sq === 2 && isPairActive) { score += 32; factors.push(`Kill Zone: ${session.name}`); }
  else if (sq === 2) { score += 22; factors.push(`Kill Zone (pair not primary)`); }
  else if (sq === 1 && isPairActive) { score += 20; factors.push(`Active session: ${session.name}`); }
  else if (sq === 1) { score += 12; factors.push(`Session: ${session.name}`); }

  // ICT Sequence — bonus points for institutional confirmation
  if (ictSequence.sweep) { score += 18; factors.push(`${ictSequence.sweep.type} sweep confirmed`); }
  if (ictSequence.displacement) { score += 12; factors.push(`Displacement ${ictSequence.displacement.atrRatio}x ATR`); }
  if (ictSequence.retest) { score += 12; factors.push(`Retest: ${ictSequence.retest.zone} (${ictSequence.retest.type})`); }

  // Traditional SMC — boosted so non-ICT setups can still qualify
  if (ind.bos) { score += 12; factors.push(`BOS: ${ind.bos.type}`); }
  if (ind.choch) { score += 8; factors.push(`CHoCH: ${ind.choch.type}`); }
  if (ind.obs?.length > 0) { score += 10; factors.push("Order block"); }
  if (ind.fvgs?.length > 0) { score += 10; factors.push("FVG present"); }

  // Equal Highs/Lows as TP targets
  if (ictSequence.eqLiquidity) { score += 8; factors.push("EQH/EQL liquidity target"); }

  // Strength engine
  if (ictSequence.strength) {
    const { buyerStr, sellerStr } = ictSequence.strength;
    if (ind.direction === "BUY" && buyerStr > sellerStr + 10) { score += 10; factors.push(`Buyer strength: ${buyerStr}%`); }
    if (ind.direction === "SELL" && sellerStr > buyerStr + 10) { score += 10; factors.push(`Seller strength: ${sellerStr}%`); }
  }

  // RSI extremes
  const r = ind.rsi14;
  if (r < 30 || r > 70) { score += 12; factors.push(`RSI extreme: ${r}`); }
  else if (r < 40 || r > 60) { score += 6; factors.push(`RSI biased: ${r}`); }

  // HTF bias — always give credit
  if (htfBias.bias !== "neutral") {
    const htfPts = htfBias.strength > 0.8 ? 12 : 8;
    score += htfPts;
    factors.push(`HTF: ${htfBias.bias} (${(htfBias.strength*100).toFixed(0)}%)`);
  }

  // EMA alignment bonus
  if (ind.bullish && ind.direction === "BUY") { score += 6; factors.push("EMA aligned bullish"); }
  if (!ind.bullish && ind.direction === "SELL") { score += 6; factors.push("EMA aligned bearish"); }

  // Premium/Discount zone alignment
  if (ictSequence.pdZone) {
    const { zone } = ictSequence.pdZone;
    if (ind.direction === "BUY" && zone === "discount") { score += 8; factors.push("In discount zone"); }
    if (ind.direction === "SELL" && zone === "premium") { score += 8; factors.push("In premium zone"); }
  }

  // Volatility spike penalty
  if (ind.atr_ratio >= 2.5) { score -= 15; factors.push(`⚠️ Volatility spike: ${ind.atr_ratio}x`); }

  return {
    score: Math.min(Math.max(score, 0), 100), factors,
    grade: score >= 75 ? "A" : score >= 55 ? "B" : score >= 40 ? "C" : "D",
    tradeable: score >= 40,
    hasSequence: !!(ictSequence.sweep && ictSequence.displacement)
  };
}

function getIndicators(bars, atrVal) {
  if (!bars || bars.length < 30) return null;
  const closes = bars.map(b=>b.close);
  const len = bars.length;
  const price = closes[len-1];
  const e20 = ema(closes, 20);
  const e50 = ema(closes, Math.min(50, len-1));
  const avgVol = bars.slice(-20).reduce((s,b)=>s+b.volume,0)/20;
  const currentATR = atrVal || atrCalc(bars, 14);
  const histATR = atrHistorical(bars, 14, 50);
  const fvgs = detectFVGs(bars, currentATR);
  const obs  = detectOBs(bars);
  const ms   = detectMarketStructure(bars);

  return {
    currentPrice: price, ema20: e20, ema50: e50,
    rsi14: rsi(closes, 14),
    atr14: currentATR,
    atr14_historical: histATR,
    atr_ratio: currentATR && histATR ? parseFloat((currentATR/histATR).toFixed(2)) : 1.0,
    bos: ms.bos, choch: ms.choch, trend: ms.trend,
    obs, fvgs,
    bullish: e20 > e50, aboveEMA20: price > e20,
    recentHigh: Math.max(...bars.slice(-20).map(b=>b.high)),
    recentLow: Math.min(...bars.slice(-20).map(b=>b.low)),
    highVol: bars[len-1].volume > avgVol * 1.5,
    direction: e20 > e50 ? "BUY" : "SELL"
  };
}

// ── Claude AI Analysis ────────────────────────────────────────────────────────

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

function calculateStructuralSLTP(direction, price, ind, atrVal, symbol, ictSequence, analysisRR) {
  const pip = PIP_SIZES[symbol] || 0.0001;
  const atrMultiplier = ATR_SL_MULTIPLIERS[symbol] || 1.3;
  const minSLPips = symbol === "GOLD" ? 80 :
                    symbol === "BTCUSD" ? 500 :
                    symbol === "GBPJPY" ? 50 :
                    symbol === "EURJPY" ? 30 :
                    symbol === "USDJPY" ? 20 :
                    ["US30Cash","GER40Cash"].includes(symbol) ? 30 : 10;

  let stopLoss, slPips;

  // NEW: Use swept level as SL anchor (structural — tighter and more precise)
  if (ictSequence.sweep?.slAnchor) {
    const atrBuffer = atrVal * 0.3; // small buffer beyond swept level
    if (direction === "BUY") {
      stopLoss = ictSequence.sweep.slAnchor - atrBuffer;
    } else {
      stopLoss = ictSequence.sweep.slAnchor + atrBuffer;
    }
    slPips = Math.abs(price - stopLoss) / pip;

    // Ensure minimum SL distance
    if (slPips < minSLPips) {
      stopLoss = direction === "BUY"
        ? price - minSLPips * pip
        : price + minSLPips * pip;
      slPips = minSLPips;
    }
  } else {
    // Fallback: ATR-based structural SL
    const atrSL = calculateATRStopLoss(direction, price, ind, atrVal, symbol);
    stopLoss = atrSL.stopLoss;
    slPips = atrSL.slPips;

    // Enforce minimum SL distance
    if (slPips < minSLPips) {
      stopLoss = direction === "BUY"
        ? price - minSLPips * pip
        : price + minSLPips * pip;
      slPips = minSLPips;
    }
  }

  // Hard cap at 2.5x ATR
  const maxSLPips = (atrVal * 2.5) / pip;
  if (slPips > maxSLPips) {
    stopLoss = direction === "BUY"
      ? price - maxSLPips * pip
      : price + maxSLPips * pip;
    slPips = maxSLPips;
  }

  stopLoss = parseFloat(stopLoss.toFixed(5));
  const risk = Math.abs(price - stopLoss);

  // NEW: TP targets using liquidity pools (EQH/EQL) when available
  let tp1, tp2, tp3;
  const rrRatio = Math.max(analysisRR || 2.0, 2.0);

  if (ictSequence.eqLiquidity) {
    const { eqh, eql } = ictSequence.eqLiquidity;
    if (direction === "BUY" && eqh.length > 0) {
      // TP1 = nearest EQH above price
      const nearestEQH = eqh.filter(h => h > price).sort((a,b)=>a-b)[0];
      tp1 = nearestEQH || parseFloat((price + risk * rrRatio).toFixed(5));
    } else if (direction === "SELL" && eql.length > 0) {
      // TP1 = nearest EQL below price
      const nearestEQL = eql.filter(l => l < price).sort((a,b)=>b-a)[0];
      tp1 = nearestEQL || parseFloat((price - risk * rrRatio).toFixed(5));
    }
  }

  // Ensure TP1 is at least 1.5R
  if (!tp1 || Math.abs(tp1 - price) < risk * 1.5) {
    tp1 = direction === "BUY"
      ? parseFloat((price + risk * Math.max(rrRatio, 1.5)).toFixed(5))
      : parseFloat((price - risk * Math.max(rrRatio, 1.5)).toFixed(5));
  }

  tp2 = direction === "BUY"
    ? parseFloat((price + risk * Math.max(rrRatio, 2.5)).toFixed(5))
    : parseFloat((price - risk * Math.max(rrRatio, 2.5)).toFixed(5));

  tp3 = direction === "BUY"
    ? parseFloat((price + risk * 4.0).toFixed(5))
    : parseFloat((price - risk * 4.0).toFixed(5));

  // Use TP2 as primary take profit for the trade
  const takeProfit = tp2;

  return {
    stopLoss, takeProfit, tp1, tp2, tp3,
    slPips: parseFloat(slPips.toFixed(1)),
    rrActual: parseFloat((Math.abs(takeProfit - price) / risk).toFixed(2)),
    usedStructuralSL: !!ictSequence.sweep?.slAnchor
  };
}

// ── Main Signal Generation ────────────────────────────────────────────────────

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

    // Build multi-timeframe data
    const multiTFData = {};
    let h1Bars = null, h4Bars = null, m15Bars = null, m5Bars = null;
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
        }
      }
    }
    if (!Object.keys(multiTFData).length) return null;

    const htfBias = getHTFBias(h4Bars || h1Bars);
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
    // Partial sequence (sweep+displacement) = medium bar (38)
    // No sequence but in kill zone = allow with lower bar (42)
    // No sequence, no kill zone = higher bar (50)
    let minScore;
    if (ictSequence.hasFullSequence) {
      minScore = 35;
    } else if (ictSequence.hasPartialSequence) {
      minScore = 38;
    } else if (session.killZone && isPairActive) {
      minScore = 42; // kill zone + pair active = good enough without sequence
    } else if (session.killZone) {
      minScore = 45;
    } else {
      minScore = 50; // outside kill zone requires more confluence
    }

    if (confluence.score < minScore) {
      await log("info", "signalEngine", `${symbol}: Score ${confluence.score} < ${minScore} — no setup`);
      return null;
    }

    const perf = await getRecentPerformance(symbol);

    // ── Trading mode selection ────────────────────────────────────────────────
    const tradingMode = await getTradingMode();
    let analysis = null;

    if (tradingMode === TRADING_MODES.PURE_MATH) {
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

    // Confidence thresholds — calibrated per setup quality
    let minConf = 0.48; // base threshold slightly lower to allow more signals
    if (atrRatio >= 2.5) minConf = 0.65; // spike = must be very confident
    if (ictSequence.hasFullSequence && session.entryModel) minConf = 0.42; // perfect setup
    if (ictSequence.hasFullSequence) minConf = 0.45; // full ICT sequence
    if (ictSequence.hasPartialSequence) minConf = 0.48; // partial sequence
    if (!ictSequence.hasFullSequence && !ictSequence.hasPartialSequence) minConf = 0.55; // no sequence needs more confidence

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

    // Build signal
    const signal = {
      symbol,
      direction: analysis.direction,
      entry_price: entryPrice,
      stop_loss: sltp.stopLoss,
      take_profit: sltp.takeProfit,
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
  return generateSignalFromOHLCV(symbol, {});
}

async function generateSignalsForAllPairs() {
  const session = getSessionInfo();
  await log("info", "signalEngine",
    `Signal cycle — ${session.name} | Entry Model: ${session.entryModel} | Quality: ${session.sessQuality}/3 | Pairs: ${PAIRS.length}`
  );
  const signals = [];
  for (const pair of PAIRS) {
    const s = await generateSignalFromOHLCV(pair, {});
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
