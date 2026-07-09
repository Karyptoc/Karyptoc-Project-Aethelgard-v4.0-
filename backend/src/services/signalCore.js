/**
 * AETHELGARD SIGNAL CORE — Pure Strategy Logic
 * backend/src/services/signalCore.js
 *
 * EXTRACTED from signalEngine.js so that live trading and backtesting
 * share exactly one implementation of the strategy. Every function in
 * this file is pure (no Supabase, no Claude API, no side effects) —
 * given the same bars/session/etc inputs, it always produces the same
 * output. This is what makes it safe to call from a tight backtest loop
 * AND from live signal generation without ever diverging again.
 *
 * signalEngine.js (live orchestration: DB reads/writes, duplicate checks,
 * pair enablement, Claude calls) requires this file and re-uses these
 * functions unchanged.
 *
 * backtest.js (historical simulation) also requires this file directly,
 * walks real multi-timeframe historical bars, and calls the SAME
 * makePureMathDecision / scoreConfluence / calculateStructuralSLTP that
 * live trading uses — so a backtest result now actually predicts what
 * the live strategy would have done, because it's the same code.
 *
 * DO NOT duplicate any of these functions elsewhere. If the strategy
 * needs to change, change it here once.
 */

const {
  PIP_SIZES: BASE_PIP_SIZES,
  ATR_SL_MULTIPLIERS,
  calculateATRStopLoss,
} = require("./riskEngine");

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

const SCALP_PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "GOLD", "US30Cash", "GER40Cash"];
const DXY_INVERSE_PAIRS = ["EURUSD", "GBPUSD", "AUDUSD", "NZDUSD", "GOLD"];
const DXY_DIRECT_PAIRS  = ["USDCAD", "USDCHF", "USDJPY"];

// ═══════════════════════════════════════════════════════════════════════════
// PURE STRATEGY FUNCTIONS (extracted verbatim from signalEngine.js)
// ═══════════════════════════════════════════════════════════════════════════

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

  // Score → confidence mapping — aligned with backtest min_confluence=35
  const baseScore = directionSource === "HTF_BULL" || directionSource === "HTF_BEAR" ? score : score - 3;
  let confidence;
  if (baseScore >= 80) confidence = 0.82;
  else if (baseScore >= 70) confidence = 0.72;
  else if (baseScore >= 55) confidence = 0.63;
  else if (baseScore >= 45) confidence = 0.55;
  else if (baseScore >= 35) confidence = 0.50;
  else return { direction: "HOLD", confidence: 0, reason: `Score too low: ${score} (source: ${directionSource})` };

  // Boosts
  if (ictSequence.hasFullSequence) confidence = Math.min(confidence + 0.08, 0.88);
  else if (ictSequence.hasPartialSequence) confidence = Math.min(confidence + 0.04, 0.80);
  if (session.entryModel) confidence = Math.min(confidence + 0.05, 0.88);
  if (session.killZone && directionSource === "ICT_SWEEP") confidence = Math.min(confidence + 0.05, 0.85);

  // Volatility penalty
  if (ind.atr_ratio >= 2.5) confidence = Math.max(confidence - 0.15, 0.45);

  // Minimum confidence gate — low bar to match backtest behavior
  const minConf = ind.atr_ratio >= 2.5 ? 0.60 : session.killZone ? 0.45 : 0.48;
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

function getSessionInfo(atDate) {
  // FIX: optional atDate parameter added so backtest.js can compute the
  // correct session for each historical bar's own timestamp. Live call
  // sites in signalEngine.js call getSessionInfo() with no argument,
  // which defaults to "now" exactly as before — zero behavior change live.
  const now = atDate || new Date();
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

function isNewsBlackout(atDate) {
  // FIX: same optional-date pattern as getSessionInfo, for backtest reuse.
  // Note (separate from this fix, worth knowing): this checks recurring
  // day-of-week/time-of-day windows, not an actual economic calendar, so
  // it blocks every Friday ~12:30 UTC year-round rather than only real
  // NFP weeks. Fine for a rough filter; not a substitute for a real
  // calendar feed if you want tighter precision later.
  const now = atDate || new Date();
  const u = now.getUTCHours() + now.getUTCMinutes() / 60;
  const d = now.getUTCDay();
  const B=0.25;
  if (d===5 && u>=(12.5-B) && u<(12.5+B)) return { blocked:true, reason:"NFP (US Jobs)" };
  if ((d===2||d===3) && u>=(12.5-B) && u<(12.5+B)) return { blocked:true, reason:"US CPI" };
  if (d===3 && u>=(18.0-0.5) && u<(18.0+0.5)) return { blocked:true, reason:"FOMC rate decision" };
  if (d===3 && u>=17.5 && u<20.0) return { blocked:true, reason:"FOMC window" };
  if ((d===2||d===4) && u>=(12.5-B) && u<(12.5+B)) return { blocked:true, reason:"US data 12:30 UTC" };
  if (d===4 && u>=(12.25-B) && u<13.5) return { blocked:true, reason:"ECB decision+presser" };
  if (d===4 && u>=(12.0-B) && u<(12.0+B)) return { blocked:true, reason:"BOE rate decision" };
  if (d===3 && u>=(7.0-B) && u<(7.0+B)) return { blocked:true, reason:"UK CPI" };
  if ((d===4||d===5) && u>=(3.0-B) && u<(3.0+B)) return { blocked:true, reason:"BOJ rate decision" };
  if (d===2 && u>=(3.5-B) && u<(3.5+B)) return { blocked:true, reason:"RBA rate decision" };
  if ((d===4||d===5) && u>=(12.5-B) && u<(12.5+B)) return { blocked:true, reason:"US GDP/major data" };
  if (d===5 && u>=20.0) return { blocked:true, reason:"Pre-weekend" };
  return { blocked:false };
}

// ── Duplicate Prevention ──────────────────────────────────────────────────────

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

function getHTFBias(h4Bars, d1Bars = null, w1Bars = null) {
  const getBias = (bars) => {
    if (!bars || bars.length < 20) return "neutral";
    const closes = bars.map(b => b.close);
    const e20 = ema(closes, 20), e50 = ema(closes, Math.min(50, closes.length - 1));
    const price = closes[closes.length - 1];
    if (price > e20 && e20 > e50) return "bullish";
    if (price < e20 && e20 < e50) return "bearish";
    return price > e20 ? "bullish" : "bearish";
  };
  const h4Bias = getBias(h4Bars), d1Bias = d1Bars ? getBias(d1Bars) : null, w1Bias = w1Bars ? getBias(w1Bars) : null;
  const biases = [h4Bias, d1Bias, w1Bias].filter(Boolean);
  const bullCount = biases.filter(b => b === "bullish").length, bearCount = biases.filter(b => b === "bearish").length;
  let bias, strength;
  if (bullCount === biases.length)      { bias = "bullish"; strength = biases.length >= 3 ? 0.95 : biases.length === 2 ? 0.80 : 0.65; }
  else if (bearCount === biases.length) { bias = "bearish"; strength = biases.length >= 3 ? 0.95 : biases.length === 2 ? 0.80 : 0.65; }
  else if (bullCount > bearCount)       { bias = "bullish"; strength = 0.60; }
  else if (bearCount > bullCount)       { bias = "bearish"; strength = 0.60; }
  else                                  { bias = "neutral"; strength = 0.40; }
  return { bias, strength, alignment: biases.length, h4: h4Bias, d1: d1Bias || "n/a", w1: w1Bias || "n/a",
           fullAlignment: bias !== "neutral" && (bullCount === biases.length || bearCount === biases.length) };
}

function getADRStatus(h4Bars, d1Bars, symbol) {
  if (!d1Bars || d1Bars.length < 10) return { adr: 0, consumed: 0, consumedPct: 0, exhausted: false };
  const pip = PIP_SIZES[symbol] || 0.0001;
  const last14 = d1Bars.slice(-15, -1);
  const adrPips = last14.length ? last14.reduce((s,b) => s+(b.high-b.low)/pip, 0)/last14.length : 0;
  const todayBars = h4Bars ? h4Bars.slice(-6) : [];
  const todayHigh = todayBars.length ? Math.max(...todayBars.map(b=>b.high)) : 0;
  const todayLow  = todayBars.length ? Math.min(...todayBars.map(b=>b.low))  : 0;
  const consumed = todayBars.length ? (todayHigh - todayLow)/pip : 0;
  const consumedPct = adrPips > 0 ? (consumed/adrPips)*100 : 0;
  return { adr: parseFloat(adrPips.toFixed(1)), consumed: parseFloat(consumed.toFixed(1)),
           consumedPct: parseFloat(consumedPct.toFixed(1)), exhausted: consumedPct >= 80, todayHigh, todayLow };
}

function getSessionBiasProjection(h4Bars, currentSession) {
  if (!h4Bars || h4Bars.length < 12) return { biasDirection: null, targetLevel: null };
  const londonBars = h4Bars.filter(b => { const h = new Date(b.time||0).getUTCHours(); return h>=6 && h<13; });
  if (!londonBars.length) return { biasDirection: null, targetLevel: null };
  const londonHigh = Math.max(...londonBars.map(b=>b.high)), londonLow = Math.min(...londonBars.map(b=>b.low));
  const londonBullish = (londonBars[londonBars.length-1]?.close||0) > (londonBars[0]?.open||0);
  if (currentSession === "NY_OPEN" || currentSession === "NY_MAIN") {
    return { biasDirection: londonBullish ? "SELL" : "BUY", targetLevel: londonBullish ? londonLow : londonHigh,
             londonHigh, londonLow, londonBullish };
  }
  return { biasDirection: null, targetLevel: null, londonHigh, londonLow };
}

function getMidnightOpenArray(h4Bars) {
  if (!h4Bars || h4Bars.length < 2) return null;
  const recent = h4Bars.slice(-6);
  const mb = recent.find(b => { const h = new Date(b.time||0).getUTCHours(); return h>=4 && h<=6; }) || recent[0];
  if (!mb) return null;
  const currentPrice = h4Bars[h4Bars.length-1].close;
  return { level: parseFloat(mb.open.toFixed(5)), priceIsAbove: currentPrice > mb.open,
           zone: currentPrice > mb.open ? "premium" : "discount" };
}

function getDXYConflict(symbol, direction, multiTFData) {
  const isInverse = DXY_INVERSE_PAIRS.includes(symbol), isDirect = DXY_DIRECT_PAIRS.includes(symbol);
  if (!isInverse && !isDirect) return { conflict: false };
  const usdchfBars = multiTFData["USDCHF"]?.bars;
  if (!usdchfBars || usdchfBars.length < 20) return { conflict: false };
  const closes = usdchfBars.map(b=>b.close);
  const e20 = ema(closes,20), e50 = ema(closes, Math.min(50,closes.length-1));
  const price = closes[closes.length-1];
  const dxyBull = price>e20 && e20>e50, dxyBear = price<e20 && e20<e50;
  if (dxyBull && isInverse && direction==="BUY")  return { conflict:true, reason:`DXY bullish blocks ${symbol} BUY` };
  if (dxyBear && isInverse && direction==="SELL") return { conflict:true, reason:`DXY bearish blocks ${symbol} SELL` };
  if (dxyBull && isDirect  && direction==="SELL") return { conflict:true, reason:`DXY bullish blocks ${symbol} SELL` };
  if (dxyBear && isDirect  && direction==="BUY")  return { conflict:true, reason:`DXY bearish blocks ${symbol} BUY` };
  return { conflict: false };
}

function makeScalpDecision(symbol, m5Bars, m5Atr, session, htfBias) {
  if (!SCALP_PAIRS.includes(symbol)) return { direction:"HOLD", confidence:0, reason:`${symbol} not in scalp list` };
  if (!session.killZone) return { direction:"HOLD", confidence:0, reason:"Scalp requires kill zone" };
  if (!m5Bars || m5Bars.length < 20 || !m5Atr) return { direction:"HOLD", confidence:0, reason:"No M5 data" };
  const closes = m5Bars.map(b=>b.close), len = closes.length;
  const price = closes[len-1], e8 = ema(closes,8), e21 = ema(closes,21), r = rsi(closes,14);
  const m5Sweep = detectLiquiditySweep(m5Bars,8), m5Disp = detectDisplacement(m5Bars,m5Atr);
  let direction="HOLD", confidence=0;
  if (e8>e21 && price>e8 && r>45 && r<70)      { direction="BUY";  confidence=0.55; }
  else if (e8<e21 && price<e8 && r<55 && r>30) { direction="SELL"; confidence=0.55; }
  if (direction==="HOLD") return { direction:"HOLD", confidence:0, reason:`M5 no direction RSI:${r}` };
  if (htfBias.bias!=="neutral" && htfBias.bias!==(direction==="BUY"?"bullish":"bearish"))
    return { direction:"HOLD", confidence:0, reason:`HTF ${htfBias.bias} conflicts M5 ${direction}` };
  if (m5Sweep && m5Sweep.direction===direction) confidence+=0.12;
  if (m5Disp  && m5Disp.direction ===direction) confidence+=0.08;
  if (session.entryModel) confidence+=0.05;
  if (htfBias.bias!=="neutral") confidence+=0.05;
  confidence = Math.min(confidence,0.82);
  if (confidence<0.58) return { direction:"HOLD", confidence, reason:`Scalp conf ${confidence.toFixed(2)} low` };
  const sl = direction==="BUY" ? parseFloat((price-m5Atr*0.5).toFixed(5)) : parseFloat((price+m5Atr*0.5).toFixed(5));
  return { direction, confidence:parseFloat(confidence.toFixed(2)), regime:"SCALP",
    entry_logic:`[SCALP/M5] RSI:${r} ${m5Sweep?m5Sweep.type:""} ${m5Disp?"DISP":""}`,
    sl_reasoning:"M5 ATR×0.5", stop_loss_pips:0, reward_risk_ratio:1.2,
    sentiment_score:direction==="BUY"?0.3:-0.3,
    rationale:`Scalp ${direction} | M5 aligned | ${session.name} | HTF:${htfBias.bias}`,
    invalidation:direction==="BUY"?`Below ${sl}`:`Above ${sl}`,
    timeframe_primary:"M5", position_size_modifier:0.6, mode:"SCALP", m5_sl:sl };
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

  // FIX (confirmed bug): this cap used to run unconditionally after the
  // minSLPips floor above, with no guarantee maxSLPips >= minSLPips. When
  // atrVal was small, 1.5x ATR could come out SMALLER than the minimum
  // floor, silently shrinking the stop back down - this is what produced
  // the near-zero GBPUSD/NZDUSD stops ("SL distance 0.00006 < minimum
  // 0.00100") that bridge.py had to catch and correct at execution time.
  // The cap can now never go below the floor.
  const maxSLPips = Math.max((atrVal * 1.5) / pip, minSLPips);
  if (slPips > maxSLPips) {
    stopLoss = direction === "BUY"
      ? price - maxSLPips * pip
      : price + maxSLPips * pip;
    slPips = maxSLPips;
  }

  // NEW SAFETY NET: catches the class of bug behind the EURUSD/USDCAD/
  // USDCHF trades that all showed IDENTICAL SL/TP regardless of entry
  // price (e.g. every EURUSD SELL getting SL=1.17715/TP=1.17141 no matter
  // whether entry was 1.14144 or 1.14372). I traced every "recent window"
  // function this could plausibly come from (getIndicators, detectOBs,
  // detectMarketStructure, detectLiquiditySweep) and all of them correctly
  // scope to the last 10-20 bars - none should be able to produce a
  // reference price hundreds of pips from live price for 24+ hours. I
  // could not pin down the exact mechanism through static reading alone.
  //
  // FIX (this was a real gap in my first version of this check, confirmed
  // by live logs on 2026-07-09 where sl=1.17715 still got through despite
  // this check being deployed): the ceiling below was calculated relative
  // to atrVal. If atrVal ITSELF is corrupted or stale for the same
  // underlying reason as the stuck SL, the ceiling inflates right along
  // with it and the bug slips through anyway - a relative check is only
  // as trustworthy as the thing it's relative to. Added a hard, ABSOLUTE
  // per-symbol ceiling below that doesn't depend on atrVal at all (mirrors
  // the same fixed table already in bridge.py), and the true ceiling is
  // now whichever of the two is SMALLER - so a corrupted ATR can no longer
  // raise the ceiling high enough to let this back in.
  const ABSOLUTE_MAX_PIPS = {
    GOLD: 500, BTCUSD: 3000, US30Cash: 1500, GER40Cash: 1000,
    GBPJPY: 300, EURJPY: 300, USDJPY: 150,
  };
  const absoluteCeiling = ABSOLUTE_MAX_PIPS[symbol] || 150; // forex majors default: 150 pips
  const relativeCeiling = Math.max(maxSLPips * 3, minSLPips * 5);
  const maxSanePips = Math.min(absoluteCeiling, relativeCeiling);

  if (slPips > maxSanePips) {
    console.error(`[SLTP SANITY] ${symbol}: computed SL ${slPips.toFixed(1)} pips from price ${price} is implausible ` +
      `(ceiling ${maxSanePips.toFixed(1)}p = min(absolute ${absoluteCeiling}p, relative ${relativeCeiling.toFixed(1)}p)). ` +
      `stopLoss=${stopLoss}, atrVal=${atrVal}, sweepAnchor=${ictSequence.sweep?.slAnchor}, ` +
      `recentHigh=${ind?.recentHigh}, recentLow=${ind?.recentLow}. Discarding structural result.`);

    // FIX: also guard the correction itself - if atrVal is implausibly
    // large in pip terms (a sign it's corrupted too, same root issue),
    // don't use it to build the "corrected" SL either, or the fallback
    // inherits the same corruption. Fall back to a fixed 1% of price.
    const atrPips = atrVal / pip;
    const safeAtrVal = atrPips > absoluteCeiling ? price * 0.01 : atrVal;
    stopLoss = direction === "BUY" ? price - safeAtrVal * 1.5 : price + safeAtrVal * 1.5;
    slPips = Math.abs(price - stopLoss) / pip;
  }

  stopLoss = parseFloat(stopLoss.toFixed(5));
  const risk = Math.abs(price - stopLoss);

  // NEW: TP targets using liquidity pools (EQH/EQL) when available
  let tp1, tp2, tp3;
  // FIX: floor reduced from 2.0 to 1.5 - a 2.0R minimum on every single
  // trade regardless of setup quality was part of what made TPs (and
  // therefore effective SL distance, since both compound) too large.
  const rrRatio = Math.max(analysisRR || 1.5, 1.5);

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

  // FIX: floor reduced from 1.5R to 1.2R, consistent with the overall tightening
  if (!tp1 || Math.abs(tp1 - price) < risk * 1.2) {
    tp1 = direction === "BUY"
      ? parseFloat((price + risk * Math.max(rrRatio, 1.2)).toFixed(5))
      : parseFloat((price - risk * Math.max(rrRatio, 1.2)).toFixed(5));
  }

  // FIX: this is the actual takeProfit used (see "const takeProfit = tp2"
  // below) - was floored at 2.5R minimum on every trade, which combined
  // with the wide SL cap above is what made TPs consistently large.
  // Reduced floor to 1.8R - still solidly profitable (>1.5:1 reward:risk)
  // without the excess.
  tp2 = direction === "BUY"
    ? parseFloat((price + risk * Math.max(rrRatio, 1.8)).toFixed(5))
    : parseFloat((price - risk * Math.max(rrRatio, 1.8)).toFixed(5));

  // FIX: stretch target reduced from 4.0R to 2.5R for the same reason
  tp3 = direction === "BUY"
    ? parseFloat((price + risk * 2.5).toFixed(5))
    : parseFloat((price - risk * 2.5).toFixed(5));

  // ── TP DIRECTION VALIDATION: prevent TP below entry ─────────────────────
  const slDist = Math.abs(price - stopLoss);
  if (tp1 && direction === "BUY"  && tp1 <= price) tp1 = parseFloat((price + slDist * 1.5).toFixed(5));
  if (tp1 && direction === "SELL" && tp1 >= price) tp1 = parseFloat((price - slDist * 1.5).toFixed(5));
  if (tp2 && direction === "BUY"  && tp2 <= price) tp2 = parseFloat((price + slDist * 2.0).toFixed(5));
  if (tp2 && direction === "SELL" && tp2 >= price) tp2 = parseFloat((price - slDist * 2.0).toFixed(5));

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


module.exports = {
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
};
