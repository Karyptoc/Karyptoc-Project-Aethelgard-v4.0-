const express = require("express");
const router = express.Router();
const { supabaseAdmin } = require("../services/supabase");
const { verifyToken } = require("../middleware/auth");

router.use(verifyToken);

// Live per-pair statistics from the trades table.
//
// BUG WAS: the Pair Controls page showed pair_controls.total_pnl and
// win_rate_pct, but nothing in this codebase ever writes those two columns —
// they held whatever was last put there by hand (GOLD +$16.01 / 100%,
// EURUSD -$11.64 / 0%) and never moved, however many trades closed. Stats
// are now computed from the trades table on every request; the old columns
// are ignored. "Today" uses the same day boundary riskEngine.isPairEnabled
// uses for its max-trades and daily-loss checks, so the numbers on screen
// are the numbers the risk engine is actually enforcing against.
function buildPairStats(rows, now = new Date()) {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const out = {};
  const get = sym => (out[sym] = out[sym] || {
    total_trades: 0, wins: 0, losses: 0, total_pnl: 0,
    today_pnl: 0, today_trades: 0, open_trades: 0, last_trade_at: null,
  });
  for (const t of rows) {
    if (!t.symbol) continue;
    const s = get(t.symbol);
    const profit = parseFloat(t.profit) || 0;
    if (t.open_time && new Date(t.open_time) >= todayStart) s.today_trades++;
    if (t.status === "open") { s.open_trades++; continue; }
    if (t.status !== "closed") continue;
    s.total_trades++;
    s.total_pnl += profit;
    if (profit > 0) s.wins++; else if (profit < 0) s.losses++;
    if (t.close_time && new Date(t.close_time) >= todayStart) s.today_pnl += profit;
    if (t.close_time && (!s.last_trade_at || t.close_time > s.last_trade_at)) s.last_trade_at = t.close_time;
  }
  Object.values(out).forEach(s => {
    s.total_pnl = Math.round(s.total_pnl * 100) / 100;
    s.today_pnl = Math.round(s.today_pnl * 100) / 100;
    s.win_rate_pct = s.total_trades ? Math.round(s.wins / s.total_trades * 1000) / 10 : null;
  });
  return out;
}

async function fetchTradesForStats() {
  const rows = [], PAGE = 1000;
  for (let from = 0; from < 20000; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("trades")
      .select("symbol, profit, status, open_time, close_time")
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

router.get("/controls", async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("pair_controls").select("*").order("symbol");
  if (error) return res.status(500).json({ error: error.message });
  let stats = {}, statsError = null;
  try { stats = buildPairStats(await fetchTradesForStats()); }
  catch (e) { statsError = e.message; }
  const empty = { total_trades: 0, wins: 0, losses: 0, total_pnl: 0, today_pnl: 0, today_trades: 0, open_trades: 0, last_trade_at: null, win_rate_pct: null };
  const controls = (data || []).map(c => ({ ...c, ...(stats[c.symbol] || empty) }));
  res.json({ controls, stats_error: statsError, as_of: new Date().toISOString() });
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
module.exports.buildPairStats = buildPairStats;