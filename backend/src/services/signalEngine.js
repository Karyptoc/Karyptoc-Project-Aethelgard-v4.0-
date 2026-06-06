/**
 * AETHELGARD SIGNAL ENGINE v4 - STRATEGY UPGRADED
 * Research-based improvements:
 * - ICT Kill Zone filter (London/NY sessions only)
 * - Asian session range as liquidity targets
 * - OTE Fibonacci 0.618-0.786 entry zones
 * - High-impact news blackout periods
 * - Session-aware Claude prompting
 * - Structural stop loss placement
 * - SMC confluence scoring
 */

const Anthropic = require("@anthropic-ai/sdk");
const { supabaseAdmin, log } = require("./supabase");
const { calculateATR, calculateStopLoss, calculateTakeProfit } = require("./riskEngine");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PAIRS = ["GOLD", "EURUSD", "GBPUSD", "USDJPY", "US30Cash", "GER40Cash", "BTCUSD"];
const TIMEFRAMES = ["M15", "H1", "H4"];

const PIP_SIZES = {
  GOLD: 0.01, EURUSD: 0.0001, GBPUSD: 0.0001, USDJPY: 0.01,
  US30Cash: 1.0, GER40Cash: 1.0, BTCUSD: 1.0
};

// ── Kill Zone Detection ───────────────────────────────────────────────────────

/**
 * ICT Kill Zones (UTC times)
 * London Open:    07:00 - 09:00 UTC  (10:00 - 12:00 EAT)
 * NY Open:        13:00 - 16:00 UTC  (16:00 - 19:00 EAT)
 * London/NY OVL:  13:00 - 16:00 UTC
 * Asia Session:   00:00 - 06:00 UTC  (03:00 - 09:00 EAT)
 */
function getSessionInfo() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  const utcDecimal = utcHour + utcMinute / 60;

  let session = "OFF_SESSION";
  let killZone = false;
  let sessionStrength = 0;
  let sessionName = "Off Session";

  // London Kill Zone: 07:00-09:00 UTC
  if (utcDecimal >= 7 && utcDecimal < 9) {
    session = "LONDON_OPEN";
    killZone = true;
    sessionStrength = 1.0;
    sessionName = "London Kill Zone";
  }
  // London Main Session: 09:00-13:00 UTC
  else if (utcDecimal >= 9 && utcDecimal < 13) {
    session = "LONDON_MAIN";
    killZone = false;
    sessionStrength = 0.7;
    sessionName = "London Session";
  }
  // NY Kill Zone / London-NY Overlap: 13:00-16:00 UTC
  else if (utcDecimal >= 13 && utcDecimal < 16) {
    session = "NY_OPEN";
    killZone = true;
    sessionStrength = 1.0;
    sessionName = "New York Kill Zone (London/NY Overlap)";
  }
  // NY Main Session: 16:00-20:00 UTC
  else if (utcDecimal >= 16 && utcDecimal < 20) {
    session = "NY_MAIN";
    killZone = false;
    sessionStrength = 0.6;
    sessionName = "New York Session";
  }
  // Forex Fury window: Late NY / early close 20:00-22:00 UTC
  else if (utcDecimal >= 20 && utcDecimal < 22) {
    session = "NY_CLOSE";
    killZone = true;
    sessionStrength = 0.8;
    sessionName = "NY Close (Low Volatility Scalp Window)";
  }
  // Asian Session: 00:00-06:00 UTC
  else if (utcDecimal >= 0 && utcDecimal < 6) {
    session = "ASIAN";
    killZone = false;
    sessionStrength = 0.3;
    sessionName = "Asian Session (Range Building)";
  }
  // Dead zone: 22:00-00:00 UTC
  else {
    session = "DEAD_ZONE";
    killZone = false;
    sessionStrength = 0.1;
    sessionName = "Dead Zone - Avoid Trading";
  }

  return { session, killZone, sessionStrength, sessionName, utcHour };
}

// ── News Blackout Detection ───────────────────────────────────────────────────

/**
 * Check if we're near a major news event
 * Uses known recurring high-impact windows
 */
function isNewsBlackout() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  const utcDecimal = utcHour + utcMinute / 60;
  const dayOfWeek = now.getUTCDay(); // 0=Sun, 5=Fri

  // NFP: First Friday of month 12:30 UTC — skip all of Friday NY session
  // We approximate by blocking Friday 12:00-14:00 UTC
  if (dayOfWeek === 5 && utcDecimal >= 12 && utcDecimal < 14) {
    return { blocked: true, reason: "Potential NFP/Friday news blackout" };
  }

  // FOMC (Wednesday 18:00 UTC) - block 17:30-20:00
  if (dayOfWeek === 3 && utcDecimal >= 17.5 && utcDecimal < 20) {
    return { blocked: true, reason: "Potential FOMC window" };
  }

  // ECB (Thursday 12:15 UTC) - block 12:00-13:30
  if (dayOfWeek === 4 && utcDecimal >= 12 && utcDecimal < 13.5) {
    return { blocked: true, reason: "Potential ECB announcement" };
  }

  return { blocked: false };
}

// ── Asian Range Calculation ───────────────────────────────────────────────────

function calculateAsianRange(bars) {
  if (!bars || bars.length < 20) return null;

  // Find bars from Asian session (00:00-06:00 UTC) in the last 24h
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const asianBars = bars.filter(b => {
    const barTime = new Date(b.time);
    const utcHour = barTime.getUTCHours();
    return barTime > oneDayAgo && utcHour >= 0 && utcHour < 6;
  });

  if (asianBars.length === 0) return null;

  const asianHigh = Math.max(...asianBars.map(b => b.high));
  const asianLow = Math.min(...asianBars.map(b => b.low));
  const asianMid = (asianHigh + asianLow) / 2;
  const asianRange = asianHigh - asianLow;

  return {
    high: parseFloat(asianHigh.toFixed(6)),
    low: parseFloat(asianLow.toFixed(6)),
    mid: parseFloat(asianMid.toFixed(6)),
    range: parseFloat(asianRange.toFixed(6)),
    // Buy-side liquidity sits ABOVE Asian high
    buySideLiquidity: parseFloat((asianHigh * 1.0002).toFixed(6)),
    // Sell-side liquidity sits BELOW Asian low
    sellSideLiquidity: parseFloat((asianLow * 0.9998).toFixed(6))
  };
}

// ── OTE Fibonacci Zones ────────────────────────────────────────────────────────

function calculateOTEZones(bars) {
  if (!bars || bars.length < 10) return null;

  const recent = bars.slice(-20);
  const swingHigh = Math.max(...recent.map(b => b.high));
  const swingLow = Math.min(...recent.map(b => b.low));
  const range = swingHigh - swingLow;

  // OTE = Optimal Trade Entry = 0.618-0.786 Fibonacci retracement
  return {
    // Bullish OTE: retracement into demand zone
    bullishOTE: {
      entry_low: parseFloat((swingHigh - range * 0.786).toFixed(6)),
      entry_high: parseFloat((swingHigh - range * 0.618).toFixed(6)),
      description: "Bullish OTE demand zone (0.618-0.786 retrace)"
    },
    // Bearish OTE: retracement into supply zone
    bearishOTE: {
      entry_low: parseFloat((swingLow + range * 0.618).toFixed(6)),
      entry_high: parseFloat((swingLow + range * 0.786).toFixed(6)),
      description: "Bearish OTE supply zone (0.618-0.786 retrace)"
    },
    swingHigh: parseFloat(swingHigh.toFixed(6)),
    swingLow: parseFloat(swingLow.toFixed(6)),
    equilibrium: parseFloat(((swingHigh + swingLow) / 2).toFixed(6))
  };
}

// ── SMC Confluence Scoring ────────────────────────────────────────────────────

function scoreSMCConfluence(indicators, sessionInfo, asianRange, oteZones) {
  let score = 0;
  let factors = [];

  // Kill zone bonus (+30%)
  if (sessionInfo.killZone) {
    score += 30;
    factors.push(`Kill zone active: ${sessionInfo.sessionName}`);
  } else if (sessionInfo.sessionStrength > 0.5) {
    score += 15;
    factors.push(`Active session: ${sessionInfo.sessionName}`);
  }

  // BOS confirmation (+20%)
  if (indicators.breakOfStructure) {
    score += 20;
    factors.push(`BOS: ${indicators.breakOfStructure.type}`);
  }

  // Order block present (+15%)
  if (indicators.orderBlocks?.length > 0) {
    score += 15;
    factors.push(`Order block detected`);
  }

  // FVG present (+15%)
  if (indicators.fairValueGaps?.length > 0) {
    score += 15;
    factors.push(`Fair value gap detected`);
  }

  // RSI confluence (+10%)
  const rsi = indicators.rsi14;
  if (rsi < 35) { score += 10; factors.push(`RSI oversold (${rsi})`); }
  else if (rsi > 65) { score += 10; factors.push(`RSI overbought (${rsi})`); }

  // Trend alignment (+10%)
  if (indicators.bullishBias && indicators.priceAboveEMA20) {
    score += 10; factors.push("Price above EMA20 - bullish trend");
  } else if (!indicators.bullishBias && !indicators.priceAboveEMA20) {
    score += 10; factors.push("Price below EMA20 - bearish trend");
  }

  // Asian range confluence (+10%)
  if (asianRange) {
    const price = indicators.currentPrice;
    if (Math.abs(price - asianRange.high) / price < 0.001) {
      score += 10; factors.push("Price at Asian session high (BSL target)");
    } else if (Math.abs(price - asianRange.low) / price < 0.001) {
      score += 10; factors.push("Price at Asian session low (SSL target)");
    }
  }

  // MACD confirmation (+10%)
  if (indicators.macd?.bullish) { score += 10; factors.push("MACD bullish"); }
  else if (indicators.macd?.bearish) { score += 10; factors.push("MACD bearish"); }

  // Volume confirmation (+5%)
  if (indicators.highVolume) { score += 5; factors.push("High volume confirmation"); }

  return {
    score: Math.min(score, 100),
    factors,
    grade: score >= 70 ? "A" : score >= 55 ? "B" : score >= 40 ? "C" : "D",
    tradeable: score >= 50
  };
}

// ── Technical Indicators ──────────────────────────────────────────────────────

function ema(data, period) {
  if (data.length < period) return data[data.length - 1];
  const k = 2 / (period + 1);
  let val = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) val = data[i] * k + val * (1 - k);
  return parseFloat(val.toFixed(6));
}

function rsi(data, period = 14) {
  if (data.length < period + 1) return 50;
  let gains = 0, losses = 0;
  const slice = data.slice(-(period + 1));
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
}

function macd(data) {
  if (data.length < 35) return null;
  const ema12 = ema(data, 12);
  const ema26 = ema(data, 26);
  const macdLine = ema12 - ema26;
  return {
    macd: parseFloat(macdLine.toFixed(6)),
    bullish: macdLine > 0,
    bearish: macdLine < 0
  };
}

function bollingerBands(data, period = 20) {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: parseFloat((mean + 2 * std).toFixed(6)),
    middle: parseFloat(mean.toFixed(6)),
    lower: parseFloat((mean - 2 * std).toFixed(6)),
    bandwidth: parseFloat(((4 * std) / mean * 100).toFixed(3)),
    squeeze: (4 * std) / mean * 100 < 1.5
  };
}

function calculateATRLocal(bars, period = 14) {
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
  return parseFloat((trValues.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(6));
}

function detectBOS(bars) {
  if (!bars || bars.length < 20) return null;
  const recent = bars.slice(-20);
  let lastHigh = -Infinity, lastLow = Infinity;
  for (let i = 1; i < recent.length - 1; i++) {
    if (recent[i].high > recent[i-1].high && recent[i].high > recent[i+1].high)
      lastHigh = Math.max(lastHigh, recent[i].high);
    if (recent[i].low < recent[i-1].low && recent[i].low < recent[i+1].low)
      lastLow = Math.min(lastLow, recent[i].low);
  }
  const currentClose = bars[bars.length - 1].close;
  if (currentClose > lastHigh && lastHigh > -Infinity)
    return { type: "BULLISH_BOS", level: lastHigh };
  if (currentClose < lastLow && lastLow < Infinity)
    return { type: "BEARISH_BOS", level: lastLow };
  return null;
}

function detectOrderBlocks(bars) {
  if (!bars || bars.length < 10) return [];
  const len = bars.length;
  const obs = [];
  for (let i = len - 10; i < len - 2; i++) {
    const bar = bars[i], next = bars[i + 1];
    const barRange = bar.high - bar.low;
    if (bar.close < bar.open && next.close > next.open && (next.close - next.open) > barRange * 1.5)
      obs.push({ type: "BULLISH_OB", high: bar.high, low: bar.low });
    if (bar.close > bar.open && next.close < next.open && (next.open - next.close) > barRange * 1.5)
      obs.push({ type: "BEARISH_OB", high: bar.high, low: bar.low });
  }
  return obs.slice(-2);
}

function detectFVG(bars) {
  if (!bars || bars.length < 3) return [];
  const len = bars.length;
  const fvgs = [];
  for (let i = 1; i < len - 1; i++) {
    if (bars[i+1].low > bars[i-1].high)
      fvgs.push({ type: "BULLISH_FVG", high: bars[i+1].low, low: bars[i-1].high });
    if (bars[i+1].high < bars[i-1].low)
      fvgs.push({ type: "BEARISH_FVG", high: bars[i-1].low, low: bars[i+1].high });
  }
  return fvgs.slice(-3);
}

function calculateFullIndicators(bars) {
  if (!bars || bars.length < 30) return null;
  const closes = bars.map(b => b.close);
  const len = bars.length;
  const currentPrice = closes[len - 1];
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, Math.min(50, len - 1));
  const avgVol = bars.slice(-20).reduce((s, b) => s + b.volume, 0) / 20;

  return {
    currentPrice,
    ema20, ema50,
    rsi14: rsi(closes, 14),
    bollingerBands: bollingerBands(closes, 20),
    atr14: calculateATRLocal(bars, 14),
    macd: macd(closes),
    breakOfStructure: detectBOS(bars),
    orderBlocks: detectOrderBlocks(bars),
    fairValueGaps: detectFVG(bars),
    bullishBias: ema20 > ema50,
    priceAboveEMA20: currentPrice > ema20,
    priceAboveEMA50: currentPrice > ema50,
    volumeRatio: parseFloat((bars[len-1].volume / avgVol).toFixed(2)),
    highVolume: bars[len-1].volume > avgVol * 1.5,
    recentHigh: Math.max(...bars.slice(-20).map(b => b.high)),
    recentLow: Math.min(...bars.slice(-20).map(b => b.low)),
  };
}

// ── Structural Stop Loss ──────────────────────────────────────────────────────

function calculateStructuralSL(direction, currentPrice, indicators, atr, symbol) {
  const pip = PIP_SIZES[symbol] || 0.0001;
  let stopLoss;

  if (direction === "BUY") {
    // Place SL below nearest order block low or recent swing low
    const bullishOB = indicators.orderBlocks?.find(ob => ob.type === "BULLISH_OB");
    if (bullishOB && bullishOB.low < currentPrice) {
      stopLoss = bullishOB.low - (atr * 0.5); // Below OB with buffer
    } else {
      stopLoss = indicators.recentLow - (atr * 0.5);
    }
    // Minimum 1.5x ATR
    if (currentPrice - stopLoss < atr * 1.5) {
      stopLoss = currentPrice - (atr * 1.5);
    }
  } else {
    // Place SL above nearest bearish order block high or recent swing high
    const bearishOB = indicators.orderBlocks?.find(ob => ob.type === "BEARISH_OB");
    if (bearishOB && bearishOB.high > currentPrice) {
      stopLoss = bearishOB.high + (atr * 0.5);
    } else {
      stopLoss = indicators.recentHigh + (atr * 0.5);
    }
    if (stopLoss - currentPrice < atr * 1.5) {
      stopLoss = currentPrice + (atr * 1.5);
    }
  }

  return parseFloat(stopLoss.toFixed(5));
}

// ── Session-Aware Claude Analysis ─────────────────────────────────────────────

async function analyzeWithClaude(symbol, multiTFData, sessionInfo, asianRange, oteZones, confluenceScore, perfContext) {
  const isIndex = ["US30Cash", "GER40Cash"].includes(symbol);
  const isCrypto = symbol === "BTCUSD";

  const systemPrompt = `You are Aethelgard, an elite institutional trading engine using ICT/SMC methodology.

CURRENT MARKET CONTEXT:
- Session: ${sessionInfo.sessionName}
- Kill Zone Active: ${sessionInfo.killZone ? "YES — HIGH PROBABILITY WINDOW" : "NO"}
- Session Strength: ${(sessionInfo.sessionStrength * 100).toFixed(0)}%
- SMC Confluence Score: ${confluenceScore.score}/100 (Grade: ${confluenceScore.grade})
- Confluence Factors: ${confluenceScore.factors.join(", ")}

ICT TRADING RULES YOU MUST FOLLOW:
1. Kill zones (London 07-09 UTC, NY 13-16 UTC) = highest probability entries
2. Look for liquidity sweeps BEFORE reversal entries
3. OTE entries at 0.618-0.786 Fibonacci retracement only
4. Always require BOS + OB or FVG confluence
5. Asian range high/low = primary liquidity targets
6. NEVER trade into opposing order blocks
7. Minimum 2:1 RR, prefer 3:1 for kill zone setups
8. ${sessionInfo.killZone ? "KILL ZONE ACTIVE: Higher confidence entries permitted" : "NOT in kill zone: Be MORE conservative, require stronger confluence"}

Asset: ${isIndex ? "Index CFD" : isCrypto ? "Crypto" : "Forex/Commodity"}
Respond in valid JSON only.`;

  const userPrompt = `Analyze ${symbol} with ICT/SMC kill zone strategy.

SESSION: ${sessionInfo.sessionName} | Kill Zone: ${sessionInfo.killZone}
ASIAN RANGE: ${asianRange ? JSON.stringify(asianRange) : "Not available"}
OTE ZONES: ${oteZones ? JSON.stringify(oteZones) : "Not available"}
SMC SCORE: ${confluenceScore.score}/100

MARKET DATA:
${JSON.stringify(multiTFData, null, 2)}

${perfContext ? `TRADE HISTORY FEEDBACK:
- Win Rate: ${perfContext.win_rate}% | Profit Factor: ${perfContext.profit_factor}
- Recent: ${perfContext.recent_outcomes?.join(", ")}
- ${perfContext.on_losing_streak ? "⚠️ LOSING STREAK: reduce size, be more conservative" : "Normal confidence"}` : ""}

Required JSON:
{
  "symbol": "${symbol}",
  "direction": "BUY" | "SELL" | "HOLD",
  "confidence": 0.0-1.0,
  "regime": "TRENDING_BULL" | "TRENDING_BEAR" | "RANGING" | "HIGH_VOLATILITY" | "BREAKOUT",
  "regime_detail": {
    "description": "brief",
    "strength": 0.0-1.0,
    "timeframe_alignment": "aligned" | "mixed" | "conflicted"
  },
  "smc_context": {
    "structure": "bullish" | "bearish" | "consolidating",
    "liquidity_target": "description of nearest liquidity pool",
    "kill_zone_quality": "A" | "B" | "C" | "no_setup",
    "ote_entry_valid": true | false,
    "institutional_bias": "long" | "short" | "neutral"
  },
  "entry_logic": "specific entry combining ICT concepts + session context",
  "risk_assessment": {
    "stop_loss_pips": number,
    "reward_risk_ratio": number,
    "expected_value_score": 0.0-1.0,
    "key_invalidation_level": price
  },
  "sentiment_score": -1.0 to 1.0,
  "rationale": "2-3 sentence ICT-based rationale with session context",
  "invalidation": "specific level",
  "timeframe_primary": "M15" | "H1" | "H4",
  "position_size_modifier": 0.5-1.5
}

Rules:
- Kill zone + BOS + OB/FVG = confidence up to 0.85
- Kill zone without full confluence = max 0.70
- Outside kill zone = max 0.60 confidence regardless of setup
- Dead zone (22:00-00:00 UTC) = HOLD always
- Losing streak = position_size_modifier: 0.5
- RR must be >= 2.0 (indices/crypto) or >= 1.8 (forex)`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    });
    const text = response.content[0].text.trim();
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch (e) {
    await log("error", "signalEngine", `Claude analysis failed for ${symbol}: ${e.message}`);
    return null;
  }
}

// ── Performance Feedback ──────────────────────────────────────────────────────

async function getRecentPerformance(symbol) {
  try {
    const { data } = await supabaseAdmin
      .from("trades").select("direction, profit")
      .eq("symbol", symbol).eq("status", "closed")
      .order("close_time", { ascending: false }).limit(10);
    if (!data?.length) return null;
    const winners = data.filter(t => (t.profit || 0) > 0);
    const losers = data.filter(t => (t.profit || 0) < 0);
    const recent5 = data.slice(0, 5).map(t => t.profit > 0 ? "WIN" : "LOSS");
    return {
      total: data.length,
      win_rate: parseFloat((winners.length / data.length * 100).toFixed(1)),
      profit_factor: losers.length > 0
        ? parseFloat((winners.reduce((s,t) => s+t.profit,0) / Math.abs(losers.reduce((s,t) => s+t.profit,0))).toFixed(2))
        : null,
      recent_outcomes: recent5,
      on_losing_streak: recent5.slice(0,3).every(o => o === "LOSS")
    };
  } catch { return null; }
}

// ── Main Signal Generation ────────────────────────────────────────────────────

async function generateSignalFromOHLCV(symbol, ohlcvData) {
  try {
    // Check session
    const sessionInfo = getSessionInfo();

    // Check news blackout
    const newsCheck = isNewsBlackout();
    if (newsCheck.blocked) {
      await log("info", "signalEngine", `${symbol}: Skipped — ${newsCheck.reason}`);
      return null;
    }

    // Dead zone check
    if (sessionInfo.session === "DEAD_ZONE") {
      await log("info", "signalEngine", `${symbol}: Skipped — Dead zone (22:00-00:00 UTC)`);
      return null;
    }

    // Build multiTF data
    const multiTFData = {};
    let h1Bars = null;

    for (const [tf, bars] of Object.entries(ohlcvData)) {
      if (bars && bars.length > 30) {
        const indicators = calculateFullIndicators(bars);
        if (indicators) {
          multiTFData[tf] = {
            bars_count: bars.length,
            latest_close: bars[bars.length - 1].close,
            latest_high: bars[bars.length - 1].high,
            latest_low: bars[bars.length - 1].low,
            indicators
          };
          if (tf === "H1") h1Bars = bars;
        }
      }
    }

    if (Object.keys(multiTFData).length === 0) {
      await log("warning", "signalEngine", `${symbol}: No OHLCV data`);
      return null;
    }

    // Calculate contextual data
    const primaryBars = h1Bars || Object.values(ohlcvData)[0];
    const asianRange = calculateAsianRange(primaryBars);
    const oteZones = calculateOTEZones(primaryBars);
    const h1Indicators = multiTFData["H1"]?.indicators || multiTFData["M15"]?.indicators;
    const confluenceScore = h1Indicators
      ? scoreSMCConfluence(h1Indicators, sessionInfo, asianRange, oteZones)
      : { score: 0, factors: [], grade: "D", tradeable: false };

    // Skip low confluence outside kill zones
    if (!sessionInfo.killZone && confluenceScore.score < 35) {
      await log("info", "signalEngine",
        `${symbol}: Skipped — Low confluence (${confluenceScore.score}/100) outside kill zone`
      );
      return null;
    }

    // Performance feedback
    const perfContext = await getRecentPerformance(symbol);

    // Claude analysis
    const analysis = await analyzeWithClaude(
      symbol, multiTFData, sessionInfo, asianRange, oteZones, confluenceScore, perfContext
    );

    if (!analysis || analysis.direction === "HOLD") {
      await log("info", "signalEngine", `${symbol}: HOLD — ${analysis?.smc_context?.kill_zone_quality || "no setup"}`);
      return null;
    }

    if (analysis.confidence < 0.55) {
      await log("info", "signalEngine", `${symbol}: Confidence too low (${analysis.confidence})`);
      return null;
    }

    // Calculate SL/TP
    const currentPrice = h1Indicators?.currentPrice;
    const atr = h1Indicators?.atr14;
    let stopLoss, takeProfit;

    if (currentPrice && atr) {
      stopLoss = calculateStructuralSL(analysis.direction, currentPrice, h1Indicators, atr, symbol);
      const rrRatio = Math.max(
        analysis.risk_assessment?.reward_risk_ratio || 2.0,
        ["US30Cash", "GER40Cash", "BTCUSD"].includes(symbol) ? 2.0 : 1.8
      );
      const risk = Math.abs(currentPrice - stopLoss);
      takeProfit = analysis.direction === "BUY"
        ? parseFloat((currentPrice + risk * rrRatio).toFixed(5))
        : parseFloat((currentPrice - risk * rrRatio).toFixed(5));
    }

    const signal = {
      symbol,
      direction: analysis.direction,
      entry_price: currentPrice,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      confidence: analysis.confidence,
      regime: analysis.regime,
      regime_detail: {
        ...analysis.regime_detail,
        smc_context: analysis.smc_context,
        entry_logic: analysis.entry_logic,
        session: sessionInfo.sessionName,
        kill_zone: sessionInfo.killZone,
        confluence_score: confluenceScore.score,
        confluence_grade: confluenceScore.grade,
        position_size_modifier: analysis.position_size_modifier || 1.0,
        asian_range: asianRange,
        ote_zones: oteZones
      },
      sentiment_score: analysis.sentiment_score,
      timeframe: analysis.timeframe_primary || "H1",
      rationale: `[${sessionInfo.sessionName}] [SMC: ${confluenceScore.score}/100] ${analysis.entry_logic} | ${analysis.rationale}`,
      status: "pending",
      expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
    };

    const { data, error } = await supabaseAdmin
      .from("signals").insert(signal).select().single();
    if (error) throw error;

    await log("info", "signalEngine",
      `✅ Signal: ${analysis.direction} ${symbol} @ ${currentPrice} | Conf: ${analysis.confidence} | Session: ${sessionInfo.sessionName} | SMC: ${confluenceScore.score}/100 | Grade: ${confluenceScore.grade}`
    );

    return data;
  } catch (e) {
    await log("error", "signalEngine", `generateSignalFromOHLCV failed for ${symbol}: ${e.message}`);
    return null;
  }
}

async function generateSignalForPair(symbol) {
  return generateSignalFromOHLCV(symbol, {});
}

async function generateSignalsForAllPairs() {
  const sessionInfo = getSessionInfo();
  await log("info", "signalEngine",
    `Signal cycle — Session: ${sessionInfo.sessionName} | Kill Zone: ${sessionInfo.killZone}`
  );

  const signals = [];
  for (const pair of PAIRS) {
    const signal = await generateSignalFromOHLCV(pair, {});
    if (signal) signals.push(signal);
    await new Promise(r => setTimeout(r, 2000));
  }
  return signals;
}

// Command queue
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
