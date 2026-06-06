/**
 * AETHELGARD - System Control Routes
 * Dashboard controls for engine, bridge, trading
 */

const express = require("express");
const router = express.Router();
const { supabaseAdmin, log } = require("../services/supabase");
const { getSystemStatus } = require("../services/keepAlive");
const { generateMonthlyReport, generateAllMonthlyReports } = require("../services/reportGenerator");
const { verifyToken } = require("../middleware/auth");

router.use(verifyToken);

// GET /api/system/status — full system health
router.get("/status", async (req, res) => {
  try {
    const status = await getSystemStatus();
    res.json({ status });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/system/trading/toggle — enable/disable auto trading
router.post("/trading/toggle", async (req, res) => {
  try {
    const { enabled } = req.body;
    await supabaseAdmin
      .from("platform_settings")
      .upsert({ key: "trading_enabled", value: enabled }, { onConflict: "key" });

    await log("info", "system",
      `Auto-trading ${enabled ? "ENABLED" : "DISABLED"} by admin`
    );
    res.json({ ok: true, trading_enabled: enabled });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/system/emergency-stop — halt everything
router.post("/emergency-stop", async (req, res) => {
  try {
    await supabaseAdmin
      .from("platform_settings")
      .upsert({ key: "trading_enabled", value: false }, { onConflict: "key" });

    await log("critical", "system", "EMERGENCY STOP triggered by admin — all trading halted");
    res.json({ ok: true, message: "Emergency stop activated" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/system/settings — get all platform settings
router.get("/settings", async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from("platform_settings").select("*");
    const settings = {};
    (data || []).forEach(s => { settings[s.key] = s.value; });
    res.json({ settings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/system/settings — update a setting
router.put("/settings", async (req, res) => {
  try {
    const { key, value } = req.body;
    await supabaseAdmin
      .from("platform_settings")
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/system/reports/generate — manually trigger report
router.post("/reports/generate", async (req, res) => {
  try {
    const { client_id, month, year, all } = req.body;

    if (all) {
      // Generate for all clients (async)
      generateAllMonthlyReports().catch(e =>
        log("error", "reports", `Bulk report error: ${e.message}`)
      );
      return res.json({ ok: true, message: "Generating reports for all clients..." });
    }

    if (!client_id) return res.status(400).json({ error: "client_id required" });

    const now = new Date();
    const targetMonth = month || now.getMonth() || 12;
    const targetYear = year || (month === 12 ? now.getFullYear() - 1 : now.getFullYear());

    const result = await generateMonthlyReport(client_id, targetMonth, targetYear);
    res.json({ ok: true, report: result.report, stats: result.stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/system/reports — list all reports
router.get("/reports", async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from("monthly_reports")
      .select("*, clients(full_name, email)")
      .order("created_at", { ascending: false })
      .limit(50);
    res.json({ reports: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/system/reports/:id — get report HTML
router.get("/reports/:id", async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from("monthly_reports")
      .select("*")
      .eq("id", req.params.id)
      .single();
    if (!data) return res.status(404).json({ error: "Report not found" });
    res.json({ report: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/system/accounts/disconnect — mark account offline
router.post("/accounts/disconnect/:id", async (req, res) => {
  try {
    await supabaseAdmin
      .from("mt5_accounts")
      .update({ is_connected: false })
      .eq("id", req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
