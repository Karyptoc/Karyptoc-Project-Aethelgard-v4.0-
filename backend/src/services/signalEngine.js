/**
 * AETHELGARD SIGNAL ENGINE v8
 * backend/src/services/signalEngine.js
 *
 * Upgrades:
 * - Volatility spike detector with dashboard alert
 * - ATR-based SL (Claude AI + ATR combined)
 * - Dynamic lot sizing reads from dashboard risk%
 * - Tighter break-even (10 pips) and trailing (15 pips)
 * - Historical ATR tracking for spike comparison
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

// ── Session Detection ─────────────────────────────────────────────────────────

function getSessionInfo() {
  const now = new Date();
  const utcDecimal = now.getUTCHours() + now.getUTCMinutes() / 60;
  const day = now.getUTCDay();
  if (day === 0 && utcDecimal < 22) return { session: "WEEKEND", killZone: false, strength: 0, name: "Weekend" };
  if (day === 6) return { session: "WEEKEND", killZone: false, strength: 0, name: "Weekend" };
  if (utcDecimal >= 7 && utcDecimal < 9)   return { session: "LONDON_OPEN", killZone: true,  strength: 1.0, name: "London Kill Zone" };
  if (utcDecimal >= 9 && utcDecimal < 13)  return { session: "LONDON_MAIN", killZone: false, strength: 0.75, name: "London Session" };
  if (utcDecimal >= 13 && utcDecimal < 16) return { session: "NY_OPEN",     killZone: true,  strength: 1.0, name: "NY Kill Zone" };
  if (utcDecimal >= 16 && utcDecimal < 20) return { session: "NY_MAIN",     killZone: false, strength: 0.65, name: "New York Session" };
  if (utcDecimal >= 20 && utcDecimal < 22) return { session: "NY_CLOSE",    killZone: true,  strength: 0.75, name: "NY Close" };
  if (utcDecimal >= 0 && utcDecimal < 6)   return { session: "ASIAN",       killZone: false, strength: 0.5,  name: "Asian Session" };
  return { session: "DEAD_ZONE", killZone: false, strength: 0.1, name: "Dead Zone" };
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

function atrLocal(bars, period = 14) {
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
  // Calculate ATR over a longer lookback for spike comparison
  if (!bars || bars.length < lookback) return null;
  const olderBars = bars.slice(-lookback, -period);
  return atrLocal(olderBars, period);
}

function detectBOS(bars) {
  if (!bars || bars.length < 20) return null;
  const r = bars.slice(-20);
  let hi = -Infinity, lo = Infinity;
  for (let i = 1; i < r.length-1; i++) {
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
    const b = bars[i], n = bars[i+1], r = b.high-b.low;
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
    if (bars[i+1].low > bars[i-1].high) fvgs.push({ type: "BULLISH_FVG", high: bars[i+1].low, low: bars[i-1].high });
    if (bars[i+1].high < bars[i-1].low) fvgs.push({ type: "BEARISH_FVG", high: bars[i-1].low, low: bars[i+1].high });
  }
  return fvgs.slice(-3);
}

function getIndicators(bars) {
  if (!bars || bars.length < 30) return null;
  const closes = bars.map(b=>b.close);
  const len = bars.length;
  const price = closes[len-1];
  const e20 = ema(closes, 20);
  const e50 = ema(closes, Math.min(50, len-1));
  const avgVol = bars.slice(-20).reduce((s,b)=>s+b.volume,0)/20;
  const currentATR = atrLocal(bars, 14);
  const histATR = atrHistorical(bars, 14, 50);
  return {
    currentPrice: price, ema20: e20, ema50: e50,
    rsi14: rsi(closes, 14),
    atr14: currentATR,
    atr14_historical: histATR,
    atr_ratio: currentATR && histATR ? parseFloat((currentATR/histATR).toFixed(2)) : 1.0,
    bos: detectBOS(bars), obs: detectOBs(bars), fvgs: detectFVGs(bars),
    bullish: e20 > e50, aboveEMA20: price > e20,
    recentHigh: Math.max(...bars.slice(-20).map(b=>b.high)),
    recentLow: Math.min(...bars.slice(-20).map(b=>b.low)),
    highVol: bars[len-1].volume > avgVol * 1.5,
  };
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

function scoreConfluence(ind, session, htfBias, isPairActive) {
  let score = 0;
  const factors = [];
  if (session.killZone && isPairActive) { score += 35; factors.push(`Kill zone: ${session.name}`); }
  else if (session.killZone) { score += 20; factors.push("Kill zone"); }
  else if (isPairActive && session.strength >= 0.5) { score += 20; factors.push(`Active session: ${session.name}`); }
  else if (session.strength >= 0.5) { score += 10; factors.push(`Session: ${session.name}`); }
  if (ind.bos) { score += 20; factors.push(`BOS: ${ind.bos.type}`); }
  if (ind.obs?.length > 0) { score += 15; factors.push("Order block"); }
  if (ind.fvgs?.length > 0) { score += 15; factors.push("FVG"); }
  const r = ind.rsi14;
  if (r < 35 || r > 65) { score += 10; factors.push(`RSI: ${r}`); }
  if (ind.highVol) { score += 5; factors.push("High volume"); }
  if (ind.bullish && ind.aboveEMA20) { score += 10; factors.push("Bullish EMA"); }
  else if (!ind.bullish && !ind.aboveEMA20) { score += 10; factors.push("Bearish EMA"); }
  if (htfBias.bias !== "neutral") { score += 10; factors.push(`HTF: ${htfBias.bias}`); }
  // Volatility spike penalty — reduce score if ATR is abnormally high
  if (ind.atr_ratio >= 2.5) { score -= 15; factors.push(`⚠️ Volatility spike: ${ind.atr_ratio}x normal`); }
  return {
    score: Math.min(Math.max(score, 0), 100), factors,
    grade: score >= 75 ? "A" : score >= 55 ? "B" : score >= 40 ? "C" : "D",
    tradeable: score >= 35,
    volatilitySpike: ind.atr_ratio >= 2.5
  };
}

// ── Claude Analysis ───────────────────────────────────────────────────────────

async function analyzeWithClaude(symbol, multiTFData, session, confluence, htfBias, perf, atrInfo) {
  const isCross = ["GBPJPY","EURJPY"].includes(symbol);
  const isCrypto = symbol === "BTCUSD";
  const isIndex = ["US30Cash","GER40Cash"].includes(symbol);
  const atrMultiplier = ATR_SL_MULTIPLIERS[symbol] || 1.3;

  const systemPrompt = `You are Aethelgard, an ICT/SMC institutional trading engine.
SESSION: ${session.name} | Kill Zone: ${session.killZone}
HTF BIAS: ${htfBias.bias.toUpperCase()} (${(htfBias.strength*100).toFixed(0)}%)
SMC SCORE: ${confluence.score}/100 (Grade ${confluence.grade})
ATR RATIO: ${atrInfo?.ratio || 1.0}x normal ${atrInfo?.ratio >= 2.5 ? "⚠️ VOLATILITY SPIKE DETECTED" : ""}
INSTRUMENT: ${isCross ? "Cross pair" : isCrypto ? "Crypto" : isIndex ? "Index CFD" : "Major forex"}

SL RULES — CRITICAL:
- Use ATR-based SL: current ATR × ${atrMultiplier} multiplier
- SL must be structural (below OB/FVG/swing) AND ATR-based
- For ${symbol}: recommended SL = ${atrMultiplier}x ATR from entry
- NEVER place SL wider than 2.5x ATR
- If volatility spike: tighten SL to 1.0x ATR or return HOLD

TRADING RULES:
- Kill zone + full confluence = up to 0.85 confidence
- Outside kill zone = max 0.65 confidence
- Dead zone = HOLD always
- Volatility spike (ATR > 2.5x normal) = reduce confidence by 0.15
- RR >= 2.0 required (prefer 2.5 for indices/crypto)
Respond in JSON only.`;

  const userPrompt = `Analyze ${symbol}.
DATA: ${JSON.stringify(multiTFData, null, 2)}
ATR_INFO: current=${atrInfo?.current?.toFixed(5)}, historical=${atrInfo?.historical?.toFixed(5)}, ratio=${atrInfo?.ratio}
${perf ? `HISTORY: WR ${perf.win_rate}% | ${perf.on_losing_streak ? "⚠️ LOSING STREAK — be conservative" : "Normal"}` : ""}

JSON response:
{
  "symbol": "${symbol}",
  "direction": "BUY"|"SELL"|"HOLD",
  "confidence": 0.0-1.0,
  "regime": "TRENDING_BULL"|"TRENDING_BEAR"|"RANGING"|"HIGH_VOLATILITY"|"BREAKOUT",
  "regime_detail": {"description":"brief","strength":0.0-1.0,"timeframe_alignment":"aligned"|"mixed"|"conflicted"},
  "smc_context": {
    "structure":"bullish"|"bearish"|"consolidating",
    "liquidity_target":"nearest pool description",
    "htf_aligned":true|false,
    "kill_zone_quality":"A"|"B"|"C"|"no_setup"
  },
  "entry_logic": "specific ICT/SMC reason with OB/FVG reference",
  "sl_reasoning": "explain SL placement using ATR and structure",
  "stop_loss_atr_multiplier": ${atrMultiplier},
  "risk_assessment": {
    "stop_loss_pips": number,
    "reward_risk_ratio": number,
    "expected_value_score": 0.0-1.0
  },
  "sentiment_score": -1.0 to 1.0,
  "rationale": "2-3 sentences: session + HTF + volatility context",
  "invalidation": "specific price level",
  "timeframe_primary": "M15"|"H1"|"H4",
  "position_size_modifier": 0.5-1.5
}`;

  try {
    const resp = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
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

// ── Main Signal Generation ────────────────────────────────────────────────────

async function generateSignalFromOHLCV(symbol, ohlcvData) {
  try {
    const session = getSessionInfo();
    if (session.session === "WEEKEND" || session.session === "DEAD_ZONE") return null;

    const news = isNewsBlackout();
    if (news.blocked) { await log("info", "signalEngine", `${symbol}: ${news.reason}`); return null; }

    // Pair halt check
    const pairCheck = await isPairEnabled(symbol);
    if (!pairCheck.allowed) { await log("info", "signalEngine", `${symbol}: ${pairCheck.reason}`); return null; }

    // Duplicate check
    const dupMinutes = await getDuplicateWindow();
    const recent = await hasRecentSignal(symbol, dupMinutes);
    if (recent) {
      await log("info", "signalEngine",
        `${symbol}: Duplicate skip — ${recent.direction} was ${Math.round((Date.now()-new Date(recent.created_at))/60000)}min ago`
      );
      return null;
    }

    const isPairActive = isPairActiveInSession(symbol, session.session);
    if (!isPairActive && session.strength < 0.5) return null;

    // Build indicators
    const multiTFData = {};
    let h1Bars = null, h4Bars = null;
    for (const [tf, bars] of Object.entries(ohlcvData)) {
      if (bars && bars.length > 30) {
        const ind = getIndicators(bars);
        if (ind) {
          multiTFData[tf] = { bars_count: bars.length, latest_close: bars[bars.length-1].close, indicators: ind };
          if (tf === "H1") h1Bars = bars;
          if (tf === "H4") h4Bars = bars;
        }
      }
    }
    if (!Object.keys(multiTFData).length) return null;

    const htfBias = getHTFBias(h4Bars || h1Bars);
    const primaryInd = multiTFData["H1"]?.indicators || multiTFData["M15"]?.indicators;
    const confluence = primaryInd
      ? scoreConfluence(primaryInd, session, htfBias, isPairActive)
      : { score: 0, factors: [], grade: "D", tradeable: false };

    if (!confluence.tradeable && !session.killZone) return null;

    // Volatility spike detection — alert only, keep trading
    const currentATR = primaryInd?.atr14;
    const histATR = primaryInd?.atr14_historical;
    const atrRatio = primaryInd?.atr_ratio || 1.0;
    const atrInfo = { current: currentATR, historical: histATR, ratio: atrRatio };

    if (atrRatio >= 2.5) {
      await checkVolatilitySpike(symbol, currentATR, histATR);
      // Alert sent, continue trading but with reduced confidence cap
    }

    const perf = await getRecentPerformance(symbol);
    const analysis = await analyzeWithClaude(symbol, multiTFData, session, confluence, htfBias, perf, atrInfo);

    if (!analysis || analysis.direction === "HOLD") {
      await log("info", "signalEngine", `${symbol}: HOLD — ${analysis?.smc_context?.kill_zone_quality || "no setup"}`);
      return null;
    }

    // Confidence threshold — tighter during volatility spikes
    const minConf = atrRatio >= 2.5 ? 0.65 : 0.50;
    if (analysis.confidence < minConf) {
      await log("info", "signalEngine", `${symbol}: Confidence ${analysis.confidence} < ${minConf}`);
      return null;
    }

    // Calculate SL using BOTH ATR structure and Claude's recommendation
    const price = primaryInd?.currentPrice;
    let stopLoss, takeProfit, slPips;

    if (price && currentATR) {
      // ATR-based structural SL
      const atrSL = calculateATRStopLoss(analysis.direction, price, primaryInd, currentATR, symbol);

      // Claude's SL in pips
      const claudeSLPips = analysis.risk_assessment?.stop_loss_pips;

      // Use tighter of ATR-based or Claude's suggestion
      const pip = PIP_SIZES[symbol] || 0.0001;
      let finalSLPips;

      if (claudeSLPips && claudeSLPips > 0) {
        // Take the more conservative (tighter) of the two
        finalSLPips = Math.min(atrSL.slPips, claudeSLPips * 1.2); // allow Claude 20% wider
      } else {
        finalSLPips = atrSL.slPips;
      }

      // Hard cap SL at 2.5x ATR
      const maxSLPips = (currentATR * 2.5) / pip;
      finalSLPips = Math.min(finalSLPips, maxSLPips);

      // Recalculate actual SL price
      stopLoss = analysis.direction === "BUY"
        ? parseFloat((price - finalSLPips * pip).toFixed(5))
        : parseFloat((price + finalSLPips * pip).toFixed(5));

      slPips = finalSLPips;

      // TP at minimum 2.0 RR
      const rrRatio = Math.max(analysis.risk_assessment?.reward_risk_ratio || 2.0, 2.0);
      const risk = Math.abs(price - stopLoss);
      takeProfit = analysis.direction === "BUY"
        ? parseFloat((price + risk * rrRatio).toFixed(5))
        : parseFloat((price - risk * rrRatio).toFixed(5));
    }

    const signal = {
      symbol, direction: analysis.direction,
      entry_price: price, stop_loss: stopLoss, take_profit: takeProfit,
      confidence: analysis.confidence, regime: analysis.regime,
      regime_detail: {
        ...analysis.regime_detail,
        smc_context: analysis.smc_context,
        entry_logic: analysis.entry_logic,
        sl_reasoning: analysis.sl_reasoning,
        session: session.name, kill_zone: session.killZone,
        confluence_score: confluence.score, confluence_grade: confluence.grade,
        htf_bias: htfBias.bias,
        position_size_modifier: analysis.position_size_modifier || 1.0,
        atr_ratio: atrRatio,
        sl_pips: slPips,
        volatility_spike: atrRatio >= 2.5
      },
      sentiment_score: analysis.sentiment_score,
      timeframe: analysis.timeframe_primary || "H1",
      rationale: `[${session.name}] [HTF:${htfBias.bias.toUpperCase()}] [SMC:${confluence.score}/100 ${confluence.grade}] ${atrRatio >= 2.5 ? "⚠️SPIKE " : ""}${analysis.entry_logic} | ${analysis.rationale}`,
      status: "pending",
      expires_at: new Date(Date.now() + 2*60*60*1000).toISOString()
    };

    const { data, error } = await supabaseAdmin.from("signals").insert(signal).select().single();
    if (error) throw error;

    await log("info", "signalEngine",
      `✅ ${analysis.direction} ${symbol} @ ${price} | Conf:${analysis.confidence} | ${session.name} | Grade:${confluence.grade} | SL:${slPips?.toFixed(1)}pips | RR:${analysis.risk_assessment?.reward_risk_ratio}`
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
    `Signal cycle — ${session.name} | Kill Zone: ${session.killZone} | Pairs: ${PAIRS.length}`
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
