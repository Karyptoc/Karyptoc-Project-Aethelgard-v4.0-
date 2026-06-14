// routes/signals.js
const express = require("express");
const router = express.Router();
const { supabaseAdmin } = require("../services/supabase");
const { verifyToken } = require("../middleware/auth");
const signalEngine = require("../services/signalEngine");

router.use(verifyToken);

router.get("/", async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("signals").select("*").order("created_at", { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ signals: data });
});

router.post("/generate", async (req, res) => {
  const { symbol } = req.body;
  try {
    const signal = symbol
      ? await signalEngine.generateSignalForPair(symbol)
      : await signalEngine.generateSignalsForAllPairs();
    res.json({ signal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/signals/:id/expire — bridge calls this after max retry attempts
router.post("/:id/expire", async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from("signals")
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .eq("id", id)
      .in("status", ["pending", "sent"])
      .select()
      .single();
    if (error) throw error;
    if (!data) return res.json({ ok: true, note: "Signal not found or already closed" });
    res.json({ ok: true, signal: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/signals/expire-stale — expire all stuck pending signals older than N minutes
router.post("/expire-stale", async (req, res) => {
  try {
    const cutoffMinutes = req.body?.minutes || 120;
    const cutoff = new Date(Date.now() - cutoffMinutes * 60 * 1000).toISOString();
    const { data, error } = await supabaseAdmin
      .from("signals")
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .in("status", ["pending", "sent"])
      .lt("created_at", cutoff)
      .select("id, symbol, direction, created_at");
    if (error) throw error;
    res.json({ ok: true, expired: data?.length || 0, signals: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
