const express = require("express");
const router = express.Router();
const { supabaseAdmin } = require("../services/supabase");
const { verifyToken } = require("../middleware/auth");

router.use(verifyToken);

// ── CSV helpers ──────────────────────────────────────────────────────────
// Free-text fields (rationale, entry_logic, sl_reasoning...) will contain
// commas, quotes, and newlines - a naive join(",") would silently corrupt
// the file. This escapes properly per standard CSV rules.
function csvEscape(val) {
  if (val === null || val === undefined) return "";
  let s = typeof val === "object" ? JSON.stringify(val) : String(val);
  if (/[",\n\r]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCSV(rows) {
  if (!rows || rows.length === 0) return "";
  // Union of all keys across all rows - different signal types (PURE_MATH
  // vs AI) may have slightly different fields present, so a fixed header
  // list would silently drop columns for some rows. This guarantees every
  // field that appears anywhere gets its own column.
  const keySet = new Set();
  rows.forEach(r => Object.keys(r).forEach(k => keySet.add(k)));
  const keys = Array.from(keySet);
  const header = keys.map(csvEscape).join(",");
  const lines = rows.map(r => keys.map(k => csvEscape(r[k])).join(","));
  return [header, ...lines].join("\r\n");
}

function sendCSV(res, filename, rows) {
  const csv = toCSV(rows);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
}

function prefixKeys(obj, prefix) {
  if (!obj) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[`${prefix}${k}`] = v;
  return out;
}

// ── GET /api/export/trades ──────────────────────────────────────────────
// Every trade, joined with the full reasoning from the signal that
// generated it (confluence score, HTF bias, ICT sequence status,
// rationale, entry logic, SL/TP reasoning, regime, confidence, mode).
// Optional query params: from, to (ISO dates), symbol, account_id.
router.get("/trades", async (req, res) => {
  try {
    const { from, to, symbol, account_id, limit } = req.query;
    const rowLimit = Math.min(parseInt(limit) || 2000, 5000);

    // FIX (confirmed via real error banner): "opened_at" doesn't exist -
    // the real column is "open_time", confirmed against what Trades.js
    // itself already renders for this field.
    let query = supabaseAdmin.from("trades").select("*").order("open_time", { ascending: false }).limit(rowLimit);
    if (from) query = query.gte("open_time", from);
    if (to) query = query.lte("open_time", to);
    if (symbol) query = query.eq("symbol", symbol);
    if (account_id) query = query.eq("account_id", account_id);

    const { data: trades, error: tErr } = await query;
    if (tErr) throw tErr;
    if (!trades?.length) return sendCSV(res, "trades_export.csv", []);

    const signalIds = [...new Set(trades.map(t => t.signal_id).filter(Boolean))];
    let signalMap = {};
    if (signalIds.length) {
      // FIX (likely real cause of "export trades does nothing"): this used
      // to be one .in("id", signalIds) call with potentially 1000+ IDs at
      // once (trades table has 1100+ rows) - a well-known practical limit
      // with PostgREST/Supabase, since IN-clause filters are encoded in
      // the request URL for GET requests and can hit length/row limits
      // silently. Chunked into batches of 150 instead.
      const CHUNK = 150;
      for (let i = 0; i < signalIds.length; i += CHUNK) {
        const batch = signalIds.slice(i, i + CHUNK);
        const { data: signals, error: sErr } = await supabaseAdmin
          .from("signals").select("*").in("id", batch);
        if (sErr) throw sErr;
        (signals || []).forEach(s => { signalMap[s.id] = s; });
      }
    }

    const merged = trades.map(t => ({
      ...t,
      ...prefixKeys(signalMap[t.signal_id], "signal_"),
      has_matching_signal: !!signalMap[t.signal_id],
    }));

    sendCSV(res, `trades_with_reasoning_${new Date().toISOString().slice(0,10)}.csv`, merged);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/export/signals ─────────────────────────────────────────────
// Every signal ever generated, regardless of whether it became a real
// trade - includes ones that expired unfilled, got skipped, or are still
// pending. This is the fuller picture: not just "what we traded" but
// "everything the engine considered".
// Optional query params: from, to (ISO dates), symbol, status.
router.get("/signals", async (req, res) => {
  try {
    const { from, to, symbol, status } = req.query;

    let query = supabaseAdmin.from("signals").select("*").order("created_at", { ascending: false });
    if (from) query = query.gte("created_at", from);
    if (to) query = query.lte("created_at", to);
    if (symbol) query = query.eq("symbol", symbol);
    if (status) query = query.eq("status", status);

    const { data: signals, error } = await query;
    if (error) throw error;

    sendCSV(res, `signals_export_${new Date().toISOString().slice(0,10)}.csv`, signals || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
