// routes/accounts.js
const express = require("express");
const router = express.Router();
const { supabaseAdmin } = require("../services/supabase");
const { verifyToken } = require("../middleware/auth");

router.use(verifyToken);

router.get("/", async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("mt5_accounts").select("*").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ accounts: data });
});

router.post("/", async (req, res) => {
  const { label, login, server, account_type, risk_percent, max_daily_loss, max_trades, allowed_pairs } = req.body;
  const { data, error } = await supabaseAdmin.from("mt5_accounts").insert({
    owner_id: req.user.id,
    label, login, server,
    account_type: account_type || "demo",
    risk_percent: risk_percent || 1.0,
    max_daily_loss: max_daily_loss || 5.0,
    max_trades: max_trades || 5,
    allowed_pairs: allowed_pairs || ["XAUUSD","EURUSD","GBPUSD","USDJPY"]
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ account: data });
});

router.put("/:id", async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("mt5_accounts").update(req.body).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ account: data });
});

router.delete("/:id", async (req, res) => {
  const { error } = await supabaseAdmin.from("mt5_accounts").update({ is_active: false }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
