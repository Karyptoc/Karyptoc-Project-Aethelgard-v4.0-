const express = require("express");
const router = express.Router();
const { supabaseAdmin } = require("../services/supabase");
const { verifyToken } = require("../middleware/auth");

router.use(verifyToken);

router.get("/", async (req, res) => {
  const { status, account_id } = req.query;
  let query = supabaseAdmin.from("trades").select("*, mt5_accounts(label, login)").order("created_at", { ascending: false }).limit(100);
  if (status) query = query.eq("status", status);
  if (account_id) query = query.eq("account_id", account_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ trades: data });
});

router.get("/auth", async (req, res) => {
  res.json({ ok: true, user: req.user });
});

module.exports = router;
