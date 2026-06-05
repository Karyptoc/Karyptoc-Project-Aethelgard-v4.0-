/**
 * AETHELGARD SIGNAL ENGINE
 * Claude-powered market analysis, regime detection & signal generation
 */

const Anthropic = require("@anthropic-ai/sdk");
const { supabaseAdmin, log } = require("./supabase");
const { calculateATR, calculateStopLoss, calculateTakeProfit } = require("./riskEngine");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PAIRS = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY"];
const TIMEFRAMES = ["M15", "H1", "H4"];

// Command queue for MT5 bridge
let commandQueue = [];
let commandResults = {};

function queueCommand(type, params) {
  const id = `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  commandQueue.push({ id, type, ...params, created_at: new Date().toISOString() });
  return id;
}

async function waitForResult(cmdId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (commandResults[cmdId] !== undefined) {
      const result = commandResults[cmdId];
      delete commandResults[cmdId];
      return result;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

function getAndClearCommands() {
  const cmds = [...commandQueue];
  commandQueue = [];
  return cmds;
}

function acknowledgeCommand(cmdId, result) {
  commandResults[cmdId] = result;
}

/**
 * Fetch OHLCV data via bridge command queue
 */
async function fetchOHLCV(symbol, timeframe = "H1", count = 100) {
  const cmdId = queueCommand("GET_OHLCV", { symbol, timeframe, count });
  const result = await waitForResult(cmdId);
  if (!result || !result.success) return null;
  return result.bars;
}

/**
 * Calculate technical indicators from OHLCV
 */
function calculateIndicators(bars) {
  if (!bars || bars.length < 50) return null;

  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);

  // EMA calculation
  function ema(data, period) {
    const k = 2 / (period + 1);
    let emaVal = data[0];
    for (let i = 1; i < data.length; i++) {
      emaVal = data[i] * k + emaVal * (1 - k);
    }
    return parseFloat(emaVal.toFixed(5));
  }

  // RSI
  function rsi(data, period = 14) {
    let gains = 0, losses = 0;
    for (let i = data.length - period; i < data.length; i++) {
      const diff = data[i] - data[i - 1];
      if (diff > 0) gains += diff;
      else losses += Math.abs(diff);
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
  }

  // Bollinger Bands
  function bollingerBands(data, period = 20) {
    const slice = data.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / period;
    const std = Math.sqrt(variance);
    return {
      upper: parseFloat((mean + 2 * std).toFixed(5)),
      middle: parseFloat(mean.toFixed(5)),
      lower: parseFloat((mean - 2 * std).toFixed(5)),
      bandwidth: parseFloat(((4 * std) / mean * 100).toFixed(3))
    };
  }

  // Price momentum
  const momentum10 = ((closes[closes.length - 1] - closes[closes.length - 11]) / closes[closes.length - 11] * 100).toFixed(4);

  // Recent high/low ranges
  const recentBars = bars.slice(-20);
  const recentHigh = Math.max(...recentBars.map(b => b.high));
  const recentLow = Math.min(...recentBars.map(b => b.low));
  const currentPrice = closes[closes.length - 1];
  const rangePosition = ((currentPrice - recentLow) / (recentHigh - recentLow) * 100).toFixed(1);

  return {
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    rsi14: rsi(closes, 14),
    bollingerBands: bollingerBands(closes, 20),
    atr14: calculateATR(bars, 14),
    momentum10: parseFloat(momentum10),
    recentHigh,
    recentLow,
    currentPrice,
    rangePosition: parseFloat(rangePosition),
    volume: bars[bars.length - 1].volume,
    avgVolume: Math.round(bars.slice(-20).reduce((s, b) => s + b.volume, 0) / 20)
  };
}

/**
 * Core Claude AI analysis — regime detection + signal generation
 */
async function analyzeWithClaude(symbol, multiTFData) {
  const systemPrompt = `You are Aethelgard, an elite quantitative trading intelligence engine. 
You analyze multi-timeframe market data and generate high-conviction trading signals.
Your analysis must be precise, data-driven, and strictly follow risk management principles.
Always respond in valid JSON only — no markdown, no explanation outside the JSON structure.`;

  const userPrompt = `Analyze ${symbol} across multiple timeframes and generate a trading signal.

MULTI-TIMEFRAME DATA:
${JSON.stringify(multiTFData, null, 2)}

Respond with this exact JSON structure:
{
  "symbol": "${symbol}",
  "direction": "BUY" | "SELL" | "HOLD",
  "confidence": 0.0-1.0,
  "regime": "TRENDING_BULL" | "TRENDING_BEAR" | "RANGING" | "HIGH_VOLATILITY" | "BREAKOUT",
  "regime_detail": {
    "description": "brief description",
    "strength": 0.0-1.0,
    "timeframe_alignment": "aligned" | "mixed" | "conflicted"
  },
  "entry_zone": {
    "ideal": price,
    "aggressive": price,
    "conservative": price
  },
  "risk_assessment": {
    "stop_loss_pips": number,
    "reward_risk_ratio": number,
    "expected_value_score": 0.0-1.0
  },
  "sentiment_score": -1.0 to 1.0,
  "rationale": "2-3 sentence technical rationale",
  "invalidation": "what would invalidate this signal",
  "timeframe_primary": "M15" | "H1" | "H4"
}

Rules:
- Only generate BUY/SELL if confidence > 0.65
- HOLD if signals conflict across timeframes or confidence is low
- Stop loss must be ATR-based (1.5x ATR minimum)
- Reward:Risk must be >= 1.8 to generate BUY/SELL
- Be conservative — protecting capital beats chasing trades`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    });

    const text = response.content[0].text.trim();
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (e) {
    await log("error", "signalEngine", `Claude analysis failed for ${symbol}: ${e.message}`);
    return null;
  }
}

/**
 * Generate signals for a single pair
 */
async function generateSignalForPair(symbol) {
  try {
    const multiTFData = {};

    for (const tf of TIMEFRAMES) {
      const bars = await fetchOHLCV(symbol, tf, 100);
      if (bars && bars.length > 50) {
        const indicators = calculateIndicators(bars);
        multiTFData[tf] = {
          bars_count: bars.length,
          latest_close: bars[bars.length - 1].close,
          latest_open: bars[bars.length - 1].open,
          indicators
        };
      }
    }

    if (Object.keys(multiTFData).length === 0) {
      await log("warning", "signalEngine", `No data available for ${symbol} — bridge may be offline`);
      return null;
    }

    const analysis = await analyzeWithClaude(symbol, multiTFData);
    if (!analysis) return null;

    if (analysis.direction === "HOLD") {
      await log("info", "signalEngine", `${symbol}: HOLD signal (confidence: ${analysis.confidence})`);
      return null;
    }

    // Calculate precise SL/TP from H1 indicators
    const h1 = multiTFData["H1"];
    const atr = h1?.indicators?.atr14;
    const currentPrice = h1?.indicators?.currentPrice;

    let stopLoss, takeProfit, stopPips;

    if (atr && currentPrice) {
      const sl = calculateStopLoss({
        direction: analysis.direction,
        entryPrice: currentPrice,
        atr,
        symbol,
        multiplier: 1.5
      });
      stopLoss = sl.stopLoss;
      stopPips = sl.stopPips;
      takeProfit = calculateTakeProfit({
        direction: analysis.direction,
        entryPrice: currentPrice,
        stopLoss,
        rrRatio: Math.max(analysis.risk_assessment?.reward_risk_ratio || 2.0, 1.8)
      });
    }

    const signal = {
      symbol,
      direction: analysis.direction,
      entry_price: currentPrice,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      confidence: analysis.confidence,
      regime: analysis.regime,
      regime_detail: analysis.regime_detail,
      sentiment_score: analysis.sentiment_score,
      timeframe: analysis.timeframe_primary || "H1",
      rationale: analysis.rationale,
      status: "pending",
      expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString() // 4hr expiry
    };

    const { data, error } = await supabaseAdmin
      .from("signals")
      .insert(signal)
      .select()
      .single();

    if (error) throw error;

    await log("info", "signalEngine",
      `✅ Signal generated: ${analysis.direction} ${symbol} @ ${currentPrice} | Confidence: ${analysis.confidence} | Regime: ${analysis.regime}`
    );

    return data;
  } catch (e) {
    await log("error", "signalEngine", `Signal generation failed for ${symbol}: ${e.message}`);
    return null;
  }
}

/**
 * Generate signals for all configured pairs
 */
async function generateSignalsForAllPairs() {
  const signals = [];
  for (const pair of PAIRS) {
    const signal = await generateSignalForPair(pair);
    if (signal) signals.push(signal);
    // Small delay between pairs
    await new Promise(r => setTimeout(r, 2000));
  }
  return signals;
}

module.exports = {
  generateSignalForPair,
  generateSignalsForAllPairs,
  getAndClearCommands,
  acknowledgeCommand
};
