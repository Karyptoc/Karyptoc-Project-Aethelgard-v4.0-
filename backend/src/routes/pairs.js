const express = require("express");
const router = express.Router();
const { supabaseAdmin } = require("../services/supabase");
const { verifyToken } = require("../middleware/auth");

router.use(verifyToken);

router.get("/controls", async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("pair_controls").select("*").order("symbol");
  if (error) return res.status(500).json({ error: error.message });
  res.json({ controls: data });
});

router.put("/controls/:symbol", async (req, res) => {
  const { symbol } = req.params;
  const { error } = await supabaseAdmin
    .from("pair_controls")
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq("symbol", symbol);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;