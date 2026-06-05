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

module.exports = router;
