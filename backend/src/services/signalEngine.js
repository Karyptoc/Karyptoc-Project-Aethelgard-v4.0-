/**
 * AETHELGARD SIGNAL ENGINE v6
 * Expanded pairs + relaxed confidence thresholds for more daily trades
 * New pairs based on research:
 * - AUDUSD: Asian session + London overlap, tight spreads
 * - USDCAD: NY session, oil correlation
 * - GBPJPY: High volatility, big pip moves
 * - EURJPY: London/Tokyo overlap
 * - USDCHF: Safe haven, inverse EUR/USD
 * - NZDUSD: Asian session pair
 * 
 * Fix: relaxed session filter to allow more trades during active sessions
 */

const Anthropic = require("@anthropic-ai/sdk");
const { supabaseAdmin, log } = require("./supabase");
const { calculateATR, PIP_SIZES: BASE_PIP_SIZES } = require("./riskEngine");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// EXPANDED PAIRS LIST — 13 pairs across all sessions
const PAIRS = [
  // Major pairs (existing)
  "GOLD", "EURUSD", "GBPUSD", "USDJPY",
  // Indices (existing)
  "US30Cash", "GER40Cash", "BTCUSD",
  // NEW — Major pairs
  "AUDUSD",   // Asian + London, tight spreads
  "USDCAD",   // NY session, oil-driven
  "USDCHF",   // Safe haven, inverse EURUSD
  "NZDUSD",   // Asian session
  // NEW — Cross pairs (no USD, higher volatility)
  "GBPJPY",   // High volatility, big moves
  "EURJPY",   // London/Tokyo overlap
];

// Extended pip sizes
const PIP_SIZES = {
  ...BASE_PIP_SIZES,
  AUDUSD: 0.0001,
  USDCAD: 0.0001,
  USDCHF: 0.0001,
  NZDUSD: 0.0001,
  GBPJPY: 0.01,
  EURJPY: 0.01,
};

// Which session each pair is most active in
const PAIR_SESSIONS = {
  GOLD:     ["LONDON_OPEN", "NY_OPEN", "NY_MAIN", "LONDON_MAIN"],
  EURUSD:   ["LONDON_OPEN", "NY_OPEN", "LONDON_MAIN", "NY_MAIN"],
  GBPUSD:   ["LONDON_OPEN", "NY_OPEN", "LONDON_MAIN"],
  USDJPY:   ["ASIAN", "LONDON_OPEN", "NY_OPEN", "LONDON_MAIN"],
  AUDUSD:   ["ASIAN", "LONDON_OPEN", "LONDON_MAIN"],
  USDCAD:   ["NY_OPEN", "NY_MAIN", "LONDON_MAIN"],
  USDCHF:   ["LONDON_OPEN", "NY_OPEN", "LONDON_MAIN"],
  NZDUSD:   ["ASIAN", "LONDON_OPEN"],
  GBPJPY:   ["LONDON_OPEN", "NY_OPEN", "ASIAN"],
  EURJPY:   ["ASIAN", "LONDON_OPEN", "LONDON_MAIN"],
  US30Cash: ["NY_OPEN", "NY_MAIN"],
  GER40Cash:["LONDON_OPEN", "LONDON_MAIN"],
  BTCUSD:   ["LONDON_OPEN", "NY_OPEN", "NY_MAIN", "NY_CLOSE"],
};

const TIMEFRAMES = ["M15", "H1", "H4"];

// ── Session Detection ─────────────────────────────────────────────────────────

function getSessionInfo() {
  const now = new Date();
  const utcDecimal = now.getUTCHours() + now.getUTCMinutes() / 60;
  const day = now.getUTCDay();

  // Weekend check
  if (day === 0 && utcDecimal < 22) return { session: "WEEKEND", killZone: false, strength: 0, name: "Weekend - Market Closed" };
  if (day === 6) return { session: "WEEKEND", killZone: false, strength: 0, name: "Weekend - Market Closed" };

  if (utcDecimal >= 7 && utcDecimal < 9)
    return { session: "LONDON_OPEN", killZone: true, strength: 1.0, name: "London Kill Zone" };
  if (utcDecimal >= 9 && utcDecimal < 13)
    return { session: "LONDON_MAIN", killZone: false, strength: 0.75, name: "London Session" };
  if (utcDecimal >= 13 && utcDecimal < 16)
    return { session: "NY_OPEN", killZone: true, strength: 1.0, name: "NY Kill Zone (London/NY Overlap)" };
  if (utcDecimal >= 16 && utcDecimal < 20)
    return { session: "NY_MAIN", killZone: false, strength: 0.65, name: "New York Session" };
  if (utcDecimal >= 20 && utcDecimal < 22)
    return { session: "NY_CLOSE", killZone: true, strength: 0.75, name: "NY Close Scalp Window" };
  if (utcDecimal >= 0 && utcDecimal < 3)
    return { session: "SYDNEY", killZone: false, strength: 0.4, name: "Sydney Session" };
  if (utcDecimal >= 0 && utcDecimal < 6)
    return { session: "ASIAN", killZone: false, strength: 0.5, name: "Asian Session" };
  // 22:00-00:00 UTC dead zone
  return { session: "DEAD_ZONE", killZone: false, strength: 0.1, name: "Dead Zone" };
}

function isPairActiveInSession(symbol, session) {
  const activeSessions = PAIR_SESSIONS[symbol] || ["LONDON_OPEN", "NY_OPEN"];
  return activeSessions.includes(session);
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

async function hasRecentSignal(symbol, minutes = 45) {
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
  let val = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) val = data[i] * k + val * (1 - k);
  return parseFloat(val.toFixed(6));
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
  return parseFloat((100 - 100 / (1 + gains / losses)).toFixed(2));
}

function atr(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    tr.push(Math.max(bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i-1].close),
      Math.abs(bars[i].low - bars[i-1].close)));
  }
  return parseFloat((tr.slice(-period).reduce((a,b)=>a+b,0)/period).toFixed(6));
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
    if (bars[i+1].low > bars[i-1].high) fvgs.push({ type: "BULLISH_FVG", high: bars[i+1].low, low: bars[i-1].high });
    if (bars[i+1].high < bars[i-1].low) fvgs.push({ type: "BEARISH_FVG", high: bars[i-1].low, low: bars[i+1].high });
  }
  return fvgs.slice(-3);
}

function getIndicators(bars) {
  if (!bars || bars.length < 30) return null;
  const closes = bars.map(b => b.close);
  const len = bars.length;
  const price = closes[len-1];
  const e20 = ema(closes, 20);
  const e50 = ema(closes, Math.min(50, len-1));
  const avgVol = bars.slice(-20).reduce((s,b)=>s+b.volume,0)/20;
  return {
    currentPrice: price, ema20: e20, ema50: e50,
    rsi14: rsi(closes, 14), atr14: atr(bars, 14),
    bos: detectBOS(bars), obs: detectOBs(bars), fvgs: detectFVGs(bars),
    bullish: e20 > e50, aboveEMA20: price > e20,
    recentHigh: Math.max(...bars.slice(-20).map(b=>b.high)),
    recentLow: Math.min(...bars.slice(-20).map(b=>b.low)),
    highVol: bars[len-1].volume > avgVol * 1.5,
    volRatio: parseFloat((bars[len-1].volume/avgVol).toFixed(2))
  };
}

function getHTFBias(h4Bars) {
  if (!h4Bars || h4Bars.length < 20) return { bias: "neutral", strength: 0.5 };
  const closes = h4Bars.map(b=>b.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, Math.min(50, closes.length-1));
  const price = closes[closes.length-1];
  const r = rsi(closes, 14);
  if (price > e20 && e20 > e50) return { bias: "bullish", strength: r > 50 ? 0.9 : 0.65, ema20: e20, rsi: r };
  if (price < e20 && e20 < e50) return { bias: "bearish", strength: r < 50 ? 0.9 : 0.65, ema20: e20, rsi: r };
  return { bias: price > e20 ? "bullish" : "bearish", strength: 0.5, ema20: e20, rsi: r };
}

function scoreConfluence(ind, session, htfBias, isPairActive) {
  let score = 0;
  const factors = [];

  // Session scoring — MORE GENEROUS now
  if (session.killZone && isPairActive) { score += 35; factors.push(`Kill zone: ${session.name}`); }
  else if (session.killZone) { score += 20; factors.push(`Kill zone (pair not primary)`); }
  else if (isPairActive && session.strength >= 0.5) { score += 20; factors.push(`Active session for pair: ${session.name}`); }
  else if (session.strength >= 0.5) { score += 10; factors.push(`Session: ${session.name}`); }

  if (ind.bos) { score += 20; factors.push(`BOS: ${ind.bos.type}`); }
  if (ind.obs?.length > 0) { score += 15; factors.push("Order block"); }
  if (ind.fvgs?.length > 0) { score += 15; factors.push("FVG present"); }

  const r = ind.rsi14;
  if (r < 35 || r > 65) { score += 10; factors.push(`RSI extreme: ${r}`); }
  if (ind.highVol) { score += 5; factors.push("High volume"); }

  if (ind.bullish && ind.aboveEMA20) { score += 10; factors.push("Bullish EMA"); }
  else if (!ind.bullish && !ind.aboveEMA20) { score += 10; factors.push("Bearish EMA"); }

  if (htfBias.bias !== "neutral") { score += 10; factors.push(`HTF: ${htfBias.bias}`); }

  return {
    score: Math.min(score, 100), factors,
    grade: score >= 75 ? "A" : score >= 55 ? "B" : score >= 40 ? "C" : "D",
    tradeable: score >= 35  // LOWERED from 45 to get more signals
  };
}

// ── Claude Analysis ───────────────────────────────────────────────────────────

async function analyzeWithClaude(symbol, multiTFData, session, confluence, htfBias, perf) {
  const isCross = ["GBPJPY","EURJPY"].includes(symbol);
  const isCrypto = symbol === "BTCUSD";
  const isIndex = ["US30Cash","GER40Cash"].includes(symbol);

  const systemPrompt = `You are Aethelgard, an ICT/SMC trading engine.
SESSION: ${session.name} | Kill Zone: ${session.killZone}
HTF BIAS: ${htfBias.bias.toUpperCase()} (${(htfBias.strength*100).toFixed(0)}%)
SMC SCORE: ${confluence.score}/100 (Grade ${confluence.grade})
INSTRUMENT TYPE: ${isCross ? "Cross pair - higher volatility" : isCrypto ? "Crypto 24/7" : isIndex ? "Index CFD" : "Major forex pair"}
${isCross ? "Note: Cross pairs like GBPJPY can move 100-200 pips/day — wider stops acceptable" : ""}
RULES:
- Kill zone + full SMC = up to 0.85 confidence
- Active session + partial SMC = up to 0.72 confidence  
- ANY session + strong SMC (score>60) = up to 0.65 confidence
- Dead zone = HOLD always
- RR >= 1.8 required
Respond in JSON only.`;

  const userPrompt = `Analyze ${symbol}.
DATA: ${JSON.stringify(multiTFData, null, 2)}
${perf ? `HISTORY: WR ${perf.win_rate}% | ${perf.on_losing_streak ? "⚠️ LOSING STREAK — be conservative" : "Normal"}` : ""}

JSON:
{
  "symbol": "${symbol}",
  "direction": "BUY"|"SELL"|"HOLD",
  "confidence": 0.0-1.0,
  "regime": "TRENDING_BULL"|"TRENDING_BEAR"|"RANGING"|"HIGH_VOLATILITY"|"BREAKOUT",
  "regime_detail": {"description":"brief","strength":0.0-1.0,"timeframe_alignment":"aligned"|"mixed"|"conflicted"},
  "smc_context": {"structure":"bullish"|"bearish"|"consolidating","liquidity_target":"description","htf_aligned":true|false,"kill_zone_quality":"A"|"B"|"C"|"no_setup"},
  "entry_logic": "specific ICT/SMC entry reason",
  "risk_assessment": {"stop_loss_pips":number,"reward_risk_ratio":number,"expected_value_score":0.0-1.0},
  "sentiment_score": -1.0 to 1.0,
  "rationale": "2-3 sentences with session + HTF context",
  "invalidation": "specific level",
  "timeframe_primary": "M15"|"H1"|"H4",
  "position_size_modifier": 0.5-1.5
}`;

  try {
    const resp = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 900,
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

function calcStructuralSL(direction, price, ind, atrVal, symbol) {
  let sl;
  if (direction === "BUY") {
    const ob = ind.obs?.find(o => o.type === "BULLISH_OB");
    sl = ob ? ob.low - atrVal*0.5 : ind.recentLow - atrVal*0.5;
    if (price - sl < atrVal*1.5) sl = price - atrVal*1.5;
  } else {
    const ob = ind.obs?.find(o => o.type === "BEARISH_OB");
    sl = ob ? ob.high + atrVal*0.5 : ind.recentHigh + atrVal*0.5;
    if (sl - price < atrVal*1.5) sl = price + atrVal*1.5;
  }
  return parseFloat(sl.toFixed(5));
}

// ── Main Signal Generation ────────────────────────────────────────────────────

async function generateSignalFromOHLCV(symbol, ohlcvData) {
  try {
    const session = getSessionInfo();

    // Weekend block
    if (session.session === "WEEKEND") return null;

    // Dead zone block
    if (session.session === "DEAD_ZONE") return null;

    // News blackout
    const news = isNewsBlackout();
    if (news.blocked) {
      await log("info", "signalEngine", `${symbol}: ${news.reason}`);
      return null;
    }

    // Check if pair is active in current session
    const isPairActive = isPairActiveInSession(symbol, session.session);

    // Skip Asian-only pairs during London/NY if no special setup
    if (!isPairActive && session.strength < 0.5) {
      await log("info", "signalEngine", `${symbol}: Not active in ${session.name}`);
      return null;
    }

    // Duplicate check — 45 min window
    const recent = await hasRecentSignal(symbol, 45);
    if (recent) {
      await log("info", "signalEngine",
        `${symbol}: Duplicate skip — ${recent.direction} was ${Math.round((Date.now()-new Date(recent.created_at))/60000)}min ago`
      );
      return null;
    }

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

    // RELAXED threshold: allow if score >= 35 OR in kill zone with any setup
    if (!confluence.tradeable && !session.killZone) {
      await log("info", "signalEngine", `${symbol}: Low confluence ${confluence.score}/100`);
      return null;
    }

    const perf = await getRecentPerformance(symbol);
    const analysis = await analyzeWithClaude(symbol, multiTFData, session, confluence, htfBias, perf);

    if (!analysis || analysis.direction === "HOLD") return null;

    // RELAXED confidence threshold: 0.50 (was 0.55)
    if (analysis.confidence < 0.50) {
      await log("info", "signalEngine", `${symbol}: Confidence too low: ${analysis.confidence}`);
      return null;
    }

    const price = primaryInd?.currentPrice;
    const atrVal = primaryInd?.atr14;
    let stopLoss, takeProfit;

    if (price && atrVal) {
      stopLoss = calcStructuralSL(analysis.direction, price, primaryInd, atrVal, symbol);
      const risk = Math.abs(price - stopLoss);
      const rr = Math.max(analysis.risk_assessment?.reward_risk_ratio || 2.0, 1.8);
      takeProfit = analysis.direction === "BUY"
        ? parseFloat((price + risk*rr).toFixed(5))
        : parseFloat((price - risk*rr).toFixed(5));
    }

    const signal = {
      symbol, direction: analysis.direction,
      entry_price: price, stop_loss: stopLoss, take_profit: takeProfit,
      confidence: analysis.confidence, regime: analysis.regime,
      regime_detail: {
        ...analysis.regime_detail,
        smc_context: analysis.smc_context,
        entry_logic: analysis.entry_logic,
        session: session.name, kill_zone: session.killZone,
        confluence_score: confluence.score, confluence_grade: confluence.grade,
        htf_bias: htfBias.bias, position_size_modifier: analysis.position_size_modifier || 1.0
      },
      sentiment_score: analysis.sentiment_score,
      timeframe: analysis.timeframe_primary || "H1",
      rationale: `[${session.name}] [HTF:${htfBias.bias.toUpperCase()}] [SMC:${confluence.score}/100 ${confluence.grade}] ${analysis.entry_logic} | ${analysis.rationale}`,
      status: "pending",
      expires_at: new Date(Date.now() + 2*60*60*1000).toISOString()
    };

    const { data, error } = await supabaseAdmin.from("signals").insert(signal).select().single();
    if (error) throw error;

    await log("info", "signalEngine",
      `✅ ${analysis.direction} ${symbol} @ ${price} | Conf:${analysis.confidence} | ${session.name} | Grade:${confluence.grade}`
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
