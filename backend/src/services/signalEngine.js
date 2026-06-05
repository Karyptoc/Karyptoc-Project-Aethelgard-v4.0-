/**
 * AETHELGARD SIGNAL ENGINE v3
 * Upgraded with:
 * - SMC/ICT entry logic (BOS, Order Blocks, FVG)
 * - Intermarket correlation (DXY context)
 * - Extended indicator suite (MACD, Stochastic, Ichimoku)
 * - Statistical regime classifier
 * - Feedback loop (learns from past trade outcomes)
 * - All new pairs: US30, SP500, GER40, BTCUSD
 */

const Anthropic = require("@anthropic-ai/sdk");
const { supabaseAdmin, log } = require("./supabase");
const { calculateATR, calculateStopLoss, calculateTakeProfit } = require("./riskEngine");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PAIRS = ["GOLD", "EURUSD", "GBPUSD", "USDJPY", "US30Cash", "SPX500Cash", "GER40Cash", "BTCUSD"];
const TIMEFRAMES = ["M15", "H1", "H4"];

// Pip sizes per instrument
const PIP_SIZES = {
  GOLD: 0.01, EURUSD: 0.0001, GBPUSD: 0.0001, USDJPY: 0.01,
  US30Cash: 1.0, SPX500Cash: 0.1, GER40Cash: 1.0, BTCUSD: 1.0
};

// Command queue
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

// ── Technical Indicators ──────────────────────────────────────────────────────

function ema(data, period) {
  const k = 2 / (period + 1);
  let val = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    val = data[i] * k + val * (1 - k);
  }
  return parseFloat(val.toFixed(6));
}

function rsi(data, period = 14) {
  let gains = 0, losses = 0;
  const slice = data.slice(-period - 1);
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
  const ema12 = ema(data, 12);
  const ema26 = ema(data, 26);
  const macdLine = ema12 - ema26;
  // Signal line approximation
  const recentMacd = data.slice(-35).map((_, i, arr) => {
    if (i < 25) return 0;
    return ema(arr.slice(0, i + 1), 12) - ema(arr.slice(0, i + 1), 26);
  }).filter(v => v !== 0);
  const signal = ema(recentMacd, 9);
  const histogram = macdLine - signal;
  return {
    macd: parseFloat(macdLine.toFixed(6)),
    signal: parseFloat(signal.toFixed(6)),
    histogram: parseFloat(histogram.toFixed(6)),
    bullish: histogram > 0 && macdLine > 0,
    bearish: histogram < 0 && macdLine < 0
  };
}

function stochastic(bars, kPeriod = 14, dPeriod = 3) {
  const recent = bars.slice(-kPeriod);
  const high = Math.max(...recent.map(b => b.high));
  const low = Math.min(...recent.map(b => b.low));
  const close = bars[bars.length - 1].close;
  const k = ((close - low) / (high - low)) * 100;
  // D is 3-period SMA of K
  const kValues = [];
  for (let i = bars.length - dPeriod; i < bars.length; i++) {
    const sl = bars.slice(i - kPeriod + 1, i + 1);
    const h = Math.max(...sl.map(b => b.high));
    const l = Math.min(...sl.map(b => b.low));
    kValues.push(((bars[i].close - l) / (h - l)) * 100);
  }
  const d = kValues.reduce((a, b) => a + b, 0) / dPeriod;
  return {
    k: parseFloat(k.toFixed(2)),
    d: parseFloat(d.toFixed(2)),
    overbought: k > 80,
    oversold: k < 20,
    bullCross: k > d && k < 80,
    bearCross: k < d && k > 20
  };
}

function bollingerBands(data, period = 20) {
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

function ichimoku(bars) {
  const last = bars.length - 1;
  const tenkanHigh = Math.max(...bars.slice(last - 9, last + 1).map(b => b.high));
  const tenkanLow = Math.min(...bars.slice(last - 9, last + 1).map(b => b.low));
  const kijunHigh = Math.max(...bars.slice(last - 25, last + 1).map(b => b.high));
  const kijunLow = Math.min(...bars.slice(last - 25, last + 1).map(b => b.low));
  const tenkan = (tenkanHigh + tenkanLow) / 2;
  const kijun = (kijunHigh + kijunLow) / 2;
  const senkouA = (tenkan + kijun) / 2;
  const close = bars[last].close;
  return {
    tenkan: parseFloat(tenkan.toFixed(6)),
    kijun: parseFloat(kijun.toFixed(6)),
    senkouA: parseFloat(senkouA.toFixed(6)),
    priceAboveCloud: close > senkouA,
    tka_cross_bull: tenkan > kijun,
    bullish: close > senkouA && tenkan > kijun
  };
}

// ── SMC/ICT Analysis ──────────────────────────────────────────────────────────

function detectBreakOfStructure(bars) {
  const len = bars.length;
  if (len < 20) return null;

  const recent = bars.slice(-20);
  let lastHigh = -Infinity, lastLow = Infinity;
  let bos = null;

  for (let i = 1; i < recent.length - 1; i++) {
    const prev = recent[i - 1];
    const curr = recent[i];
    const next = recent[i + 1];

    // Swing high
    if (curr.high > prev.high && curr.high > next.high) {
      if (curr.high > lastHigh) {
        lastHigh = curr.high;
      }
    }

    // Swing low
    if (curr.low < prev.low && curr.low < next.low) {
      if (curr.low < lastLow) {
        lastLow = curr.low;
      }
    }
  }

  const currentClose = bars[len - 1].close;
  if (currentClose > lastHigh && lastHigh > -Infinity) {
    bos = { type: "BULLISH_BOS", level: lastHigh, strength: "strong" };
  } else if (currentClose < lastLow && lastLow < Infinity) {
    bos = { type: "BEARISH_BOS", level: lastLow, strength: "strong" };
  }

  return bos;
}

function detectOrderBlocks(bars) {
  const len = bars.length;
  if (len < 10) return [];

  const orderBlocks = [];
  for (let i = len - 10; i < len - 2; i++) {
    const bar = bars[i];
    const nextBar = bars[i + 1];
    const barRange = bar.high - bar.low;

    // Bullish OB: bearish candle followed by strong bullish move
    if (bar.close < bar.open && nextBar.close > nextBar.open) {
      const move = nextBar.close - nextBar.open;
      if (move > barRange * 1.5) {
        orderBlocks.push({
          type: "BULLISH_OB",
          high: bar.high,
          low: bar.low,
          index: i,
          strength: move / barRange
        });
      }
    }

    // Bearish OB: bullish candle followed by strong bearish move
    if (bar.close > bar.open && nextBar.close < nextBar.open) {
      const move = nextBar.open - nextBar.close;
      if (move > barRange * 1.5) {
        orderBlocks.push({
          type: "BEARISH_OB",
          high: bar.high,
          low: bar.low,
          index: i,
          strength: move / barRange
        });
      }
    }
  }
  return orderBlocks.slice(-3); // Last 3 OBs
}

function detectFairValueGaps(bars) {
  const len = bars.length;
  if (len < 3) return [];

  const fvgs = [];
  for (let i = len - 10; i < len - 2; i++) {
    const prev = bars[i - 1];
    const curr = bars[i];
    const next = bars[i + 1];

    // Bullish FVG: gap between prev high and next low
    if (next.low > prev.high) {
      fvgs.push({
        type: "BULLISH_FVG",
        high: next.low,
        low: prev.high,
        size: next.low - prev.high,
        index: i
      });
    }

    // Bearish FVG: gap between next high and prev low
    if (next.high < prev.low) {
      fvgs.push({
        type: "BEARISH_FVG",
        high: prev.low,
        low: next.high,
        size: prev.low - next.high,
        index: i
      });
    }
  }
  return fvgs.slice(-3);
}

function detectLiquidityZones(bars) {
  const len = bars.length;
  const highs = bars.slice(-50).map(b => b.high);
  const lows = bars.slice(-50).map(b => b.low);

  // Equal highs = buy-side liquidity
  const recentHigh = Math.max(...highs.slice(-20));
  const allTimeHigh50 = Math.max(...highs);
  const recentLow = Math.min(...lows.slice(-20));

  return {
    buyLiquidity: parseFloat(recentHigh.toFixed(6)),
    sellLiquidity: parseFloat(recentLow.toFixed(6)),
    majorResistance: parseFloat(allTimeHigh50.toFixed(6)),
    currentPrice: bars[len - 1].close
  };
}

// ── Statistical Regime Classifier ────────────────────────────────────────────

function classifyRegimeStatistically(bars) {
  const closes = bars.map(b => b.close);
  const len = closes.length;

  // ADX approximation
  const trValues = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
    trValues.push(tr);
  }
  const atr = trValues.slice(-14).reduce((a, b) => a + b, 0) / 14;

  // Directional movement
  let plusDM = 0, minusDM = 0;
  for (let i = 1; i < Math.min(15, bars.length); i++) {
    const upMove = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    if (upMove > downMove && upMove > 0) plusDM += upMove;
    if (downMove > upMove && downMove > 0) minusDM += downMove;
  }
  const adxApprox = Math.abs(plusDM - minusDM) / (plusDM + minusDM + 0.0001) * 100;

  // Price vs EMAs
  const close = closes[len - 1];
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, Math.min(50, len - 1));

  // Volatility
  const returns = closes.slice(-20).map((c, i, arr) => i > 0 ? (c - arr[i-1]) / arr[i-1] : 0).slice(1);
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / returns.length;
  const volatility = Math.sqrt(variance) * 100;

  let regime, strength;
  if (adxApprox > 25 && close > ema20 && ema20 > ema50) {
    regime = "TRENDING_BULL"; strength = Math.min(adxApprox / 50, 1);
  } else if (adxApprox > 25 && close < ema20 && ema20 < ema50) {
    regime = "TRENDING_BEAR"; strength = Math.min(adxApprox / 50, 1);
  } else if (volatility > 0.3) {
    regime = "HIGH_VOLATILITY"; strength = Math.min(volatility / 0.6, 1);
  } else if (adxApprox < 20) {
    regime = "RANGING"; strength = 1 - adxApprox / 20;
  } else {
    regime = "BREAKOUT"; strength = 0.6;
  }

  return { regime, strength: parseFloat(strength.toFixed(3)), adx: parseFloat(adxApprox.toFixed(2)), volatility: parseFloat(volatility.toFixed(4)) };
}

// ── Feedback Loop ─────────────────────────────────────────────────────────────

async function getRecentPerformanceContext(symbol) {
  try {
    const { data: recentTrades } = await supabaseAdmin
      .from("trades")
      .select("direction, profit, open_price, close_price, symbol")
      .eq("symbol", symbol)
      .eq("status", "closed")
      .order("close_time", { ascending: false })
      .limit(10);

    if (!recentTrades || recentTrades.length === 0) return null;

    const winners = recentTrades.filter(t => (t.profit || 0) > 0);
    const losers = recentTrades.filter(t => (t.profit || 0) < 0);
    const winRate = winners.length / recentTrades.length;
    const avgProfit = winners.length > 0
      ? winners.reduce((s, t) => s + t.profit, 0) / winners.length : 0;
    const avgLoss = losers.length > 0
      ? Math.abs(losers.reduce((s, t) => s + t.profit, 0) / losers.length) : 0;

    const recentDirections = recentTrades.slice(0, 5).map(t => t.direction);
    const recentOutcomes = recentTrades.slice(0, 5).map(t => t.profit > 0 ? "WIN" : "LOSS");

    return {
      total: recentTrades.length,
      win_rate: parseFloat((winRate * 100).toFixed(1)),
      avg_profit: parseFloat(avgProfit.toFixed(2)),
      avg_loss: parseFloat(avgLoss.toFixed(2)),
      profit_factor: avgLoss > 0 ? parseFloat((avgProfit / avgLoss).toFixed(2)) : null,
      recent_directions: recentDirections,
      recent_outcomes: recentOutcomes,
      on_losing_streak: recentOutcomes.slice(0, 3).every(o => o === "LOSS"),
      on_winning_streak: recentOutcomes.slice(0, 3).every(o => o === "WIN")
    };
  } catch (e) {
    return null;
  }
}

// ── Full Indicator Suite ──────────────────────────────────────────────────────

function calculateFullIndicators(bars) {
  if (!bars || bars.length < 50) return null;

  const closes = bars.map(b => b.close);
  const len = bars.length;

  // Core indicators
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, Math.min(50, len - 1));
  const ema200 = len > 200 ? ema(closes, 200) : null;
  const rsi14 = rsi(closes, 14);
  const bb = bollingerBands(closes, 20);
  const atr14 = calculateATR(bars, 14);
  const macdData = closes.length >= 35 ? macd(closes) : null;
  const stoch = bars.length >= 17 ? stochastic(bars) : null;
  const ichi = bars.length >= 30 ? ichimoku(bars) : null;

  // SMC/ICT
  const bos = detectBreakOfStructure(bars);
  const orderBlocks = detectOrderBlocks(bars);
  const fvgs = detectFairValueGaps(bars);
  const liquidity = detectLiquidityZones(bars);

  // Statistical regime
  const regimeStats = classifyRegimeStatistically(bars);

  // Price context
  const currentPrice = closes[len - 1];
  const prevClose = closes[len - 2];
  const priceChange = ((currentPrice - prevClose) / prevClose * 100).toFixed(4);
  const recentHigh = Math.max(...bars.slice(-20).map(b => b.high));
  const recentLow = Math.min(...bars.slice(-20).map(b => b.low));
  const rangePosition = ((currentPrice - recentLow) / (recentHigh - recentLow) * 100).toFixed(1);

  // Volume analysis
  const avgVolume = Math.round(bars.slice(-20).reduce((s, b) => s + b.volume, 0) / 20);
  const currentVolume = bars[len - 1].volume;
  const volumeRatio = parseFloat((currentVolume / avgVolume).toFixed(2));

  // Trend strength
  const bullishCandles = bars.slice(-10).filter(b => b.close > b.open).length;
  const trendConsistency = bullishCandles / 10;

  return {
    // Core
    ema20, ema50, ema200,
    rsi14,
    bollingerBands: bb,
    atr14,
    macd: macdData,
    stochastic: stoch,
    ichimoku: ichi,
    // SMC/ICT
    breakOfStructure: bos,
    orderBlocks: orderBlocks.slice(-2),
    fairValueGaps: fvgs.slice(-2),
    liquidityZones: liquidity,
    // Regime
    regimeClassification: regimeStats,
    // Price context
    currentPrice,
    priceChange: parseFloat(priceChange),
    recentHigh,
    recentLow,
    rangePosition: parseFloat(rangePosition),
    // Volume
    volumeRatio,
    highVolume: volumeRatio > 1.5,
    // Trend
    trendConsistency: parseFloat(trendConsistency.toFixed(2)),
    bullishBias: ema20 > ema50,
    priceAboveEMA20: currentPrice > ema20,
    priceAboveEMA50: currentPrice > ema50
  };
}

// ── Claude Analysis v3 ────────────────────────────────────────────────────────

async function analyzeWithClaudeV3(symbol, multiTFData, performanceContext) {
  const pipSize = PIP_SIZES[symbol] || 0.0001;
  const isIndex = ["US30Cash", "SPX500Cash", "GER40Cash"].includes(symbol);
  const isCrypto = symbol === "BTCUSD";

  const systemPrompt = `You are Aethelgard, an elite quantitative trading engine combining SMC/ICT methodology with multi-timeframe technical analysis.

Your analysis framework:
1. STRUCTURE: Identify market structure (BOS, CHoCH, swing highs/lows)
2. LIQUIDITY: Where are buy/sell-side liquidity pools?
3. ORDER BLOCKS: Identify institutional order blocks for entries
4. FVG: Fair Value Gaps as potential entry/target zones
5. CONFLUENCE: Only trade when multiple factors align
6. REGIME: Statistical regime guides strategy type

Asset context: ${isIndex ? "Index CFD — higher volatility, gap risk on open" : isCrypto ? "Crypto — 24/7 market, extreme volatility possible" : "Forex/Commodity — session-based liquidity"}

Respond ONLY in valid JSON. No markdown.`;

  const userPrompt = `Analyze ${symbol} with full SMC/ICT + Technical confluence.

MULTI-TIMEFRAME DATA:
${JSON.stringify(multiTFData, null, 2)}

${performanceContext ? `RECENT PERFORMANCE FEEDBACK (last ${performanceContext.total} trades):
- Win Rate: ${performanceContext.win_rate}%
- Profit Factor: ${performanceContext.profit_factor}
- Recent: ${performanceContext.recent_outcomes?.join(", ")}
- On losing streak: ${performanceContext.on_losing_streak}
- Note: ${performanceContext.on_losing_streak ? "BE MORE CONSERVATIVE — reduce position sizing recommendation" : "Normal confidence levels apply"}
` : "No trade history yet for this pair."}

Required JSON response:
{
  "symbol": "${symbol}",
  "direction": "BUY" | "SELL" | "HOLD",
  "confidence": 0.0-1.0,
  "regime": "TRENDING_BULL" | "TRENDING_BEAR" | "RANGING" | "HIGH_VOLATILITY" | "BREAKOUT",
  "regime_detail": {
    "description": "one sentence",
    "strength": 0.0-1.0,
    "timeframe_alignment": "aligned" | "mixed" | "conflicted"
  },
  "smc_context": {
    "structure": "bullish" | "bearish" | "consolidating",
    "order_block_active": true | false,
    "fvg_present": true | false,
    "liquidity_target": "description of nearest liquidity pool",
    "bos_confirmed": true | false
  },
  "entry_logic": "specific entry reason combining SMC + technical confluence",
  "entry_zone": { "ideal": price, "aggressive": price, "conservative": price },
  "risk_assessment": {
    "stop_loss_pips": number,
    "reward_risk_ratio": number,
    "expected_value_score": 0.0-1.0,
    "key_invalidation_level": price
  },
  "sentiment_score": -1.0 to 1.0,
  "rationale": "2-3 sentence explanation referencing specific indicators and SMC levels",
  "invalidation": "specific price level that invalidates this setup",
  "timeframe_primary": "M15" | "H1" | "H4",
  "position_size_modifier": 0.5-1.5
}

Rules:
- BUY/SELL only if confidence > 0.65
- Require at least 2 confluences (e.g. OB + BOS + EMA alignment)
- RR must be >= 2.0 for indices/crypto, >= 1.8 for forex
- If on losing streak, set confidence 15% lower and position_size_modifier to 0.5
- HOLD if timeframes conflict or setup is unclear`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    });

    const text = response.content[0].text.trim();
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (e) {
    await log("error", "signalEngine", `Claude v3 failed for ${symbol}: ${e.message}`);
    return null;
  }
}

// ── Main Signal Generation ────────────────────────────────────────────────────

async function generateSignalFromOHLCV(symbol, ohlcvData) {
  try {
    const multiTFData = {};

    for (const [tf, bars] of Object.entries(ohlcvData)) {
      if (bars && bars.length > 50) {
        const indicators = calculateFullIndicators(bars);
        if (indicators) {
          multiTFData[tf] = {
            bars_count: bars.length,
            latest_close: bars[bars.length - 1].close,
            latest_open: bars[bars.length - 1].open,
            latest_high: bars[bars.length - 1].high,
            latest_low: bars[bars.length - 1].low,
            indicators
          };
        }
      }
    }

    if (Object.keys(multiTFData).length === 0) {
      await log("warning", "signalEngine", `Empty OHLCV for ${symbol}`);
      return null;
    }

    // Get performance feedback
    const perfContext = await getRecentPerformanceContext(symbol);

    // Claude analysis
    const analysis = await analyzeWithClaudeV3(symbol, multiTFData, perfContext);
    if (!analysis || analysis.direction === "HOLD") {
      await log("info", "signalEngine", `${symbol}: HOLD or no analysis`);
      return null;
    }

    // Calculate SL/TP
    const h1 = multiTFData["H1"] || multiTFData["M15"];
    const atr = h1?.indicators?.atr14;
    const currentPrice = h1?.indicators?.currentPrice;

    let stopLoss, takeProfit;
    if (atr && currentPrice) {
      const sl = calculateStopLoss({
        direction: analysis.direction,
        entryPrice: currentPrice,
        atr, symbol, multiplier: 1.5
      });
      stopLoss = sl.stopLoss;
      takeProfit = calculateTakeProfit({
        direction: analysis.direction,
        entryPrice: currentPrice,
        stopLoss,
        rrRatio: Math.max(analysis.risk_assessment?.reward_risk_ratio || 2.0,
          ["US30Cash","SPX500Cash","GER40Cash","BTCUSD"].includes(symbol) ? 2.0 : 1.8)
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
      regime_detail: {
        ...analysis.regime_detail,
        smc_context: analysis.smc_context,
        entry_logic: analysis.entry_logic,
        position_size_modifier: analysis.position_size_modifier || 1.0
      },
      sentiment_score: analysis.sentiment_score,
      timeframe: analysis.timeframe_primary || "H1",
      rationale: `${analysis.entry_logic} | ${analysis.rationale}`,
      status: "pending",
      expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
    };

    const { data, error } = await supabaseAdmin
      .from("signals").insert(signal).select().single();
    if (error) throw error;

    await log("info", "signalEngine",
      `Signal: ${analysis.direction} ${symbol} @ ${currentPrice} | Conf: ${analysis.confidence} | ${analysis.regime} | SMC: ${analysis.smc_context?.structure}`
    );

    return data;
  } catch (e) {
    await log("error", "signalEngine", `generateSignalFromOHLCV v3 failed for ${symbol}: ${e.message}`);
    return null;
  }
}

async function generateSignalForPair(symbol) {
  return generateSignalFromOHLCV(symbol, {});
}

async function generateSignalsForAllPairs() {
  const signals = [];
  for (const pair of PAIRS) {
    const signal = await generateSignalFromOHLCV(pair, {});
    if (signal) signals.push(signal);
    await new Promise(r => setTimeout(r, 2000));
  }
  return signals;
}

module.exports = {
  generateSignalForPair,
  generateSignalsForAllPairs,
  generateSignalFromOHLCV,
  getAndClearCommands,
  acknowledgeCommand,
  PAIRS
};
