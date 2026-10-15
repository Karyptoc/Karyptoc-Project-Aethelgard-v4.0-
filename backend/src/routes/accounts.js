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
  // Removed accounts that still have trade history are archived, not deleted, and hidden here.
  res.json({ accounts: (data || []).filter(a => a.archived !== true) });
});

// NEW: account used by the strategy engine (Strategies A/B), reported by strategy_bridge.py every minute.
// Read-only here: it is configured in python-bridge/.env.strategy, not in this table.
router.get("/strategy-engine", async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("strategy_account_state").select("*").order("updated_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ accounts: data || [] });
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

// Remove an account. Deleting a row would also delete its trades and snapshots
// (ON DELETE CASCADE), so an account with any history is archived instead:
// switched off and hidden, with its history kept for the journal and reports.
router.delete("/:id", async (req, res) => {
  const id = req.params.id;
  const [{ count: trades, error: e1 }, { count: snaps, error: e2 }] = await Promise.all([
    supabaseAdmin.from("trades").select("id", { count: "exact", head: true }).eq("account_id", id),
    supabaseAdmin.from("account_snapshots").select("id", { count: "exact", head: true }).eq("account_id", id),
  ]);
  if (e1 || e2) return res.status(500).json({ error: (e1 || e2).message });
  if ((trades || 0) === 0 && (snaps || 0) === 0) {
    const { error } = await supabaseAdmin.from("mt5_accounts").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true, removed: "deleted" });
  }
  const { error } = await supabaseAdmin.from("mt5_accounts")
    .update({ is_active: false, archived: true }).eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, removed: "archived", trades: trades || 0 });
});

module.exports = router;
