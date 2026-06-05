const express = require("express");
const router = express.Router();
const Anthropic = require("@anthropic-ai/sdk");
const { supabaseAdmin } = require("../services/supabase");
const { verifyToken } = require("../middleware/auth");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

router.use(verifyToken);

router.get("/", async (req, res) => {
  const { status, account_id, symbol } = req.query;
  let query = supabaseAdmin
    .from("trades")
    .select("*, mt5_accounts(label, login)")
    .order("created_at", { ascending: false })
    .limit(200);
  if (status && status !== "all") query = query.eq("status", status);
  if (account_id) query = query.eq("account_id", account_id);
  if (symbol) query = query.eq("symbol", symbol);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ trades: data });
});

// POST /api/trades/analyze — AI post-trade analysis
router.post("/analyze", async (req, res) => {
  const { trades } = req.body;
  if (!trades || trades.length === 0) {
    return res.json({ analysis: "No trades to analyze yet." });
  }

  try {
    const summary = {
      total: trades.length,
      closed: trades.filter(t => t.status === "closed").length,
      open: trades.filter(t => t.status === "open").length,
      winners: trades.filter(t => (t.profit || 0) > 0).length,
      losers: trades.filter(t => (t.profit || 0) < 0).length,
      totalPnL: trades.reduce((s, t) => s + (t.profit || 0), 0).toFixed(2),
      bySymbol: {},
      byDirection: { BUY: 0, SELL: 0 }
    };

    trades.forEach(t => {
      if (!summary.bySymbol[t.symbol]) {
        summary.bySymbol[t.symbol] = { trades: 0, pnl: 0, wins: 0 };
      }
      summary.bySymbol[t.symbol].trades++;
      summary.bySymbol[t.symbol].pnl += (t.profit || 0);
      if ((t.profit || 0) > 0) summary.bySymbol[t.symbol].wins++;
      summary.byDirection[t.direction] = (summary.byDirection[t.direction] || 0) + 1;
    });

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 800,
      system: `You are an elite trading performance analyst for the Aethelgard quant system. 
Analyze trade data and provide actionable insights. Be concise, specific, and honest.
Format your response as plain text with clear sections. No markdown.`,
      messages: [{
        role: "user",
        content: `Analyze this trading performance data and provide insights:

${JSON.stringify(summary, null, 2)}

Provide:
1. Overall performance assessment (2-3 sentences)
2. Best and worst performing pairs with reasons
3. Buy vs Sell bias analysis
4. 2-3 specific actionable recommendations to improve performance
5. Risk management assessment

Be direct and specific. Total response under 400 words.`
      }]
    });

    res.json({ analysis: response.content[0].text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
