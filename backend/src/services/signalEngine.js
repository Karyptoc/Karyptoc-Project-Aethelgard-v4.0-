/**
 * AETHELGARD SIGNAL ENGINE v5
 * Upgrades:
 * - Duplicate signal prevention (no repeat signal same pair within 1 hour)
 * - HTF (Daily) bias check
 * - DXY context for GOLD/EURUSD/GBPUSD
 * - Equity curve position sizing
 * - Grade-based execution sizing
 * - Improved session filtering
 */

const Anthropic = require("@anthropic-ai/sdk");
const { supabaseAdmin, log } = require("./supabase");
const {
  calculateATR, calculateStopLoss, calculateTakeProfit,
  getEquityCurveMultiplier, checkCorrelation, PIP_SIZES
} = require("./riskEngine");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PAIRS = ["GOLD", "EURUSD", "GBPUSD", "USDJPY", "US30Cash", "GER40Cash", "BTCUSD"];
const TIMEFRAMES = ["M15", "H1", "H4"];

// ── Duplicate Signal Prevention ───────────────────────────────────────────────

async function hasRecentSignal(symbol, minutes = 60) {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  const { data } = await supabaseAdmin
    .from("signals")
    .select("id, direction, created_at")
    .eq("symbol", symbol)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.length > 0 ? data[0] : null;
}

// ── Session Detection ─────────────────────────────────────────────────────────

function getSessionInfo() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const utcDecimal = utcHour + utcMin / 60;

  if (utcDecimal >= 7 && utcDecimal < 9)
    return { session: "LONDON_OPEN", killZone: true, strength: 1.0, name: "London Kill Zone" };
  if (utcDecimal >= 9 && utcDecimal < 13)
    return { session: "LONDON_MAIN", killZone: false, strength: 0.7, name: "London Session" };
  if (utcDecimal >= 13 && utcDecimal < 16)
    return { session: "NY_OPEN", killZone: true, strength: 1.0, name: "New York Kill Zone" };
  if (utcDecimal >= 16 && utcDecimal < 20)
    return { session: "NY_MAIN", killZone: false, strength: 0.6, name: "New York Session" };
  if (utcDecimal >= 20 && utcDecimal < 22)
    return { session: "NY_CLOSE", killZone: true, strength: 0.75, name: "NY Close Scalp Window" };
  if (utcDecimal >= 0 && utcDecimal < 6)
    return { session: "ASIAN", killZone: false, strength: 0.3, name: "Asian Session" };
  return { session: "DEAD_ZONE", killZone: false, strength: 0.1, name: "Dead Zone" };
}

function isNewsBlackout() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const utcDecimal = utcHour + utcMin / 60;
  const day = now.getUTCDay();

  if (day === 5 && utcDecimal >= 12 && utcDecimal < 14)
    return { blocked: true, reason: "Friday NFP/News blackout" };
  if (day === 3 && utcDecimal >= 17.5 && utcDecimal < 20)
    return { blocked: true, reason: "FOMC window" };
  if (day === 4 && utcDecimal >= 12 && utcDecimal < 13.5)
    return { blocked: true, reason: "ECB announcement window" };
  return { blocked: false };
}

// ── Technical Analysis ────────────────────────────────────────────────────────

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
  if (losses === 0) return 100;
  return parseFloat((100 - 100 / (1 + gains / losses)).toFixed(2));
}

function calculateATRLocal(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    tr.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    ));
  }
  return parseFloat((tr.slice(-period).reduce((a, b) => a + b, 0) / period).toFixed(6));
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
  const c = bars[bars.length - 1].close;
  if (c > lastHigh && lastHigh > -Infinity) return { type: "BULLISH_BOS", level: lastHigh };
  if (c < lastLow && lastLow < Infinity) return { type: "BEARISH_BOS", level: lastLow };
  return null;
}

function detectOrderBlocks(bars) {
  if (!bars || bars.length < 10) return [];
  const len = bars.length;
  const obs = [];
  for (let i = len - 10; i < len - 2; i++) {
    const b = bars[i], n = bars[i + 1];
    const r = b.high - b.low;
    if (b.close < b.open && n.close > n.open && (n.close - n.open) > r * 1.5)
      obs.push({ type: "BULLISH_OB", high: b.high, low: b.low });
    if (b.close > b.open && n.close < n.open && (n.open - n.close) > r * 1.5)
      obs.push({ type: "BEARISH_OB", high: b.high, low: b.low });
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

/**
 * HTF Daily Bias — determines if we're trading WITH or AGAINST the trend
 */
function calculateHTFBias(h4Bars, h1Bars) {
  if (!h4Bars || h4Bars.length < 20) return { bias: "neutral", strength: 0 };

  const closes = h4Bars.map(b => b.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, Math.min(50, closes.length - 1));
  const currentPrice = closes[closes.length - 1];

  const rsi14 = rsi(closes, 14);

  let bias = "neutral";
  let strength = 0;

  if (currentPrice > ema20 && ema20 > ema50) {
    bias = "bullish";
    strength = rsi14 > 50 ? 0.9 : 0.6;
  } else if (currentPrice < ema20 && ema20 < ema50) {
    bias = "bearish";
    strength = rsi14 < 50 ? 0.9 : 0.6;
  } else if (currentPrice > ema20) {
    bias = "bullish";
    strength = 0.5;
  } else {
    bias = "bearish";
    strength = 0.5;
  }

  return {
    bias,
    strength: parseFloat(strength.toFixed(2)),
    ema20_h4: parseFloat(ema20.toFixed(5)),
    ema50_h4: parseFloat(ema50.toFixed(5)),
    rsi_h4: rsi14,
    aligned: true
  };
}

function calculateFullIndicators(bars) {
  if (!bars || bars.length < 30) return null;
  const closes = bars.map(b => b.close);
  const len = bars.length;
  const currentPrice = closes[len - 1];
  const ema20val = ema(closes, 20);
  const ema50val = ema(closes, Math.min(50, len - 1));
  const avgVol = bars.slice(-20).reduce((s, b) => s + b.volume, 0) / 20;

  return {
    currentPrice,
    ema20: ema20val,
    ema50: ema50val,
    rsi14: rsi(closes, 14),
    atr14: calculateATRLocal(bars, 14),
    breakOfStructure: detectBOS(bars),
    orderBlocks: detectOrderBlocks(bars),
    fairValueGaps: detectFVG(bars),
    bullishBias: ema20val > ema50val,
    priceAboveEMA20: currentPrice > ema20val,
    priceAboveEMA50: currentPrice > ema50val,
    volumeRatio: parseFloat((bars[len-1].volume / avgVol).toFixed(2)),
    highVolume: bars[len-1].volume > avgVol * 1.5,
    recentHigh: Math.max(...bars.slice(-20).map(b => b.high)),
    recentLow: Math.min(...bars.slice(-20).map(b => b.low)),
  };
}

function calculateAsianRange(bars) {
  if (!bars || bars.length < 10) return null;
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const asian = bars.filter(b => {
    const t = new Date(b.time);
    return t > dayAgo && t.getUTCHours() >= 0 && t.getUTCHours() < 6;
  });
  if (!asian.length) return null;
  const high = Math.max(...asian.map(b => b.high));
  const low = Math.min(...asian.map(b => b.low));
  return { high: parseFloat(high.toFixed(6)), low: parseFloat(low.toFixed(6)), mid: parseFloat(((high+low)/2).toFixed(6)) };
}

function scoreSMC(indicators, sessionInfo, asianRange, htfBias) {
  let score = 0;
  const factors = [];

  if (sessionInfo.killZone) { score += 30; factors.push(`Kill zone: ${sessionInfo.name}`); }
  else if (sessionInfo.strength > 0.5) { score += 15; factors.push(`Active session: ${sessionInfo.name}`); }

  if (indicators.breakOfStructure) { score += 20; factors.push(`BOS: ${indicators.breakOfStructure.type}`); }
  if (indicators.orderBlocks?.length > 0) { score += 15; factors.push("Order block"); }
  if (indicators.fairValueGaps?.length > 0) { score += 15; factors.push("FVG present"); }

  const r = indicators.rsi14;
  if (r < 35 || r > 65) { score += 10; factors.push(`RSI extreme: ${r}`); }
  if (indicators.highVolume) { score += 5; factors.push("High volume"); }
  if (indicators.bullishBias && indicators.priceAboveEMA20) { score += 10; factors.push("Bullish EMA alignment"); }
  else if (!indicators.bullishBias && !indicators.priceAboveEMA20) { score += 10; factors.push("Bearish EMA alignment"); }

  // HTF bias alignment bonus
  if (htfBias.bias !== "neutral") {
    score += 10;
    factors.push(`HTF bias: ${htfBias.bias} (${(htfBias.strength * 100).toFixed(0)}%)`);
  }

  return {
    score: Math.min(score, 100),
    factors,
    grade: score >= 75 ? "A" : score >= 60 ? "B" : score >= 45 ? "C" : "D",
    tradeable: score >= 45
  };
}

// ── Claude Analysis ───────────────────────────────────────────────────────────

async function analyzeWithClaude(symbol, multiTFData, sessionInfo, asianRange, confluenceScore, htfBias, perfContext) {
  const systemPrompt = `You are Aethelgard, an elite ICT/SMC trading engine.

SESSION: ${sessionInfo.name} | Kill Zone: ${sessionInfo.killZone}
HTF BIAS (H4): ${htfBias.bias.toUpperCase()} (strength: ${(htfBias.strength*100).toFixed(0)}%)
SMC SCORE: ${confluenceScore.score}/100 (Grade ${confluenceScore.grade})
FACTORS: ${confluenceScore.factors.join(", ")}

ICT RULES:
- Only trade WITH the H4 bias direction unless extremely strong counter-trend setup
- Kill zone = up to 0.85 confidence max
- Outside kill zone = 0.60 confidence max
- Dead zone = always HOLD
- Need BOS + OB or FVG for valid setup
- ${htfBias.bias === "bullish" ? "H4 BULLISH: prefer BUY setups" : htfBias.bias === "bearish" ? "H4 BEARISH: prefer SELL setups" : "NEUTRAL: trade best setup regardless"}
Respond in valid JSON only.`;

  const userPrompt = `Analyze ${symbol}.
SESSION: ${sessionInfo.name}
HTF BIAS: ${htfBias.bias} | Asian Range: ${asianRange ? JSON.stringify(asianRange) : "N/A"}
DATA: ${JSON.stringify(multiTFData, null, 2)}
${perfContext ? `HISTORY: WinRate ${perfContext.win_rate}% | ${perfContext.on_losing_streak ? "⚠️ LOSING STREAK" : "Normal"}` : ""}

JSON response:
{
  "symbol": "${symbol}",
  "direction": "BUY" | "SELL" | "HOLD",
  "confidence": 0.0-1.0,
  "regime": "TRENDING_BULL" | "TRENDING_BEAR" | "RANGING" | "HIGH_VOLATILITY" | "BREAKOUT",
  "regime_detail": { "description": "brief", "strength": 0.0-1.0, "timeframe_alignment": "aligned" | "mixed" | "conflicted" },
  "smc_context": {
    "structure": "bullish" | "bearish" | "consolidating",
    "liquidity_target": "nearest pool",
    "htf_aligned": true | false,
    "kill_zone_quality": "A" | "B" | "C" | "no_setup"
  },
  "entry_logic": "specific ICT entry reason",
  "risk_assessment": { "stop_loss_pips": number, "reward_risk_ratio": number, "expected_value_score": 0.0-1.0 },
  "sentiment_score": -1.0 to 1.0,
  "rationale": "2-3 sentence ICT rationale with session + HTF context",
  "invalidation": "specific level",
  "timeframe_primary": "M15" | "H1" | "H4",
  "position_size_modifier": 0.5-1.5
}
Rules: Kill zone + BOS + OB/FVG = up to 0.85. Outside kill zone = max 0.60. Dead zone = HOLD always. Against HTF bias = max 0.55. RR >= 2.0.`;

  try {
    const resp = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    });
    return JSON.parse(resp.content[0].text.trim().replace(/```json|```/g, "").trim());
  } catch (e) {
    await log("error", "signalEngine", `Claude failed for ${symbol}: ${e.message}`);
    return null;
  }
}

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
        ? parseFloat((winners.reduce((s,t)=>s+t.profit,0)/Math.abs(losers.reduce((s,t)=>s+t.profit,0))).toFixed(2))
        : null,
      recent_outcomes: recent5,
      on_losing_streak: recent5.slice(0,3).every(o => o === "LOSS")
    };
  } catch { return null; }
}

// ── Structural Stop Loss ──────────────────────────────────────────────────────

function calculateStructuralSL(direction, currentPrice, indicators, atr, symbol) {
  let stopLoss;
  if (direction === "BUY") {
    const ob = indicators.orderBlocks?.find(o => o.type === "BULLISH_OB");
    stopLoss = ob ? ob.low - atr * 0.5 : indicators.recentLow - atr * 0.5;
    if (currentPrice - stopLoss < atr * 1.5) stopLoss = currentPrice - atr * 1.5;
  } else {
    const ob = indicators.orderBlocks?.find(o => o.type === "BEARISH_OB");
    stopLoss = ob ? ob.high + atr * 0.5 : indicators.recentHigh + atr * 0.5;
    if (stopLoss - currentPrice < atr * 1.5) stopLoss = currentPrice + atr * 1.5;
  }
  return parseFloat(stopLoss.toFixed(5));
}

// ── Main Signal Generation ────────────────────────────────────────────────────

async function generateSignalFromOHLCV(symbol, ohlcvData) {
  try {
    const sessionInfo = getSessionInfo();
    const newsCheck = isNewsBlackout();

    if (newsCheck.blocked) {
      await log("info", "signalEngine", `${symbol}: News blackout — ${newsCheck.reason}`);
      return null;
    }
    if (sessionInfo.session === "DEAD_ZONE") return null;

    // DUPLICATE CHECK — skip if signal generated in last 60 min
    const recent = await hasRecentSignal(symbol, 60);
    if (recent) {
      await log("info", "signalEngine", `${symbol}: Duplicate skipped — last signal ${recent.direction} was ${Math.round((Date.now() - new Date(recent.created_at)) / 60000)}min ago`);
      return null;
    }

    // Build multiTF data
    const multiTFData = {};
    let h1Bars = null, h4Bars = null;
    for (const [tf, bars] of Object.entries(ohlcvData)) {
      if (bars && bars.length > 30) {
        const ind = calculateFullIndicators(bars);
        if (ind) {
          multiTFData[tf] = { bars_count: bars.length, latest_close: bars[bars.length-1].close, indicators: ind };
          if (tf === "H1") h1Bars = bars;
          if (tf === "H4") h4Bars = bars;
        }
      }
    }

    if (!Object.keys(multiTFData).length) return null;

    // HTF bias
    const htfBias = calculateHTFBias(h4Bars || h1Bars, h1Bars);

    // SMC scoring
    const primaryInd = multiTFData["H1"]?.indicators || multiTFData["M15"]?.indicators;
    const asianRange = calculateAsianRange(h1Bars);
    const confluenceScore = primaryInd
      ? scoreSMC(primaryInd, sessionInfo, asianRange, htfBias)
      : { score: 0, factors: [], grade: "D", tradeable: false };

    // Skip low confluence
    if (!sessionInfo.killZone && confluenceScore.score < 35) return null;
    if (!confluenceScore.tradeable && !sessionInfo.killZone) return null;

    const perfContext = await getRecentPerformance(symbol);
    const analysis = await analyzeWithClaude(symbol, multiTFData, sessionInfo, asianRange, confluenceScore, htfBias, perfContext);

    if (!analysis || analysis.direction === "HOLD" || analysis.confidence < 0.55) {
      await log("info", "signalEngine", `${symbol}: No trade — ${analysis?.direction || "null"} conf:${analysis?.confidence || 0}`);
      return null;
    }

    // SL/TP
    const currentPrice = primaryInd?.currentPrice;
    const atr = primaryInd?.atr14;
    let stopLoss, takeProfit;
    if (currentPrice && atr) {
      stopLoss = calculateStructuralSL(analysis.direction, currentPrice, primaryInd, atr, symbol);
      const risk = Math.abs(currentPrice - stopLoss);
      const rrRatio = Math.max(analysis.risk_assessment?.reward_risk_ratio || 2.0,
        ["US30Cash", "GER40Cash", "BTCUSD"].includes(symbol) ? 2.0 : 1.8);
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
        session: sessionInfo.name,
        kill_zone: sessionInfo.killZone,
        confluence_score: confluenceScore.score,
        confluence_grade: confluenceScore.grade,
        htf_bias: htfBias.bias,
        htf_aligned: analysis.smc_context?.htf_aligned,
        position_size_modifier: analysis.position_size_modifier || 1.0,
        asian_range: asianRange
      },
      sentiment_score: analysis.sentiment_score,
      timeframe: analysis.timeframe_primary || "H1",
      rationale: `[${sessionInfo.name}] [HTF:${htfBias.bias.toUpperCase()}] [SMC:${confluenceScore.score}/100 Grade:${confluenceScore.grade}] ${analysis.entry_logic} | ${analysis.rationale}`,
      status: "pending",
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() // 2hr expiry (was 4hr)
    };

    const { data, error } = await supabaseAdmin.from("signals").insert(signal).select().single();
    if (error) throw error;

    await log("info", "signalEngine",
      `✅ ${analysis.direction} ${symbol} @ ${currentPrice} | Conf:${analysis.confidence} | ${sessionInfo.name} | HTF:${htfBias.bias} | Grade:${confluenceScore.grade}`
    );
    return data;
  } catch (e) {
    await log("error", "signalEngine", `generateSignalFromOHLCV failed ${symbol}: ${e.message}`);
    return null;
  }
}

async function generateSignalForPair(symbol) {
  return generateSignalFromOHLCV(symbol, {});
}

async function generateSignalsForAllPairs() {
  const session = getSessionInfo();
  await log("info", "signalEngine", `Signal cycle — ${session.name} | Kill Zone: ${session.killZone}`);
  const signals = [];
  for (const pair of PAIRS) {
    const s = await generateSignalFromOHLCV(pair, {});
    if (s) signals.push(s);
    await new Promise(r => setTimeout(r, 2000));
  }
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
