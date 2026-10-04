const express = require("express");
const router = express.Router();
const { supabaseAdmin } = require("../services/supabase");
const { verifyToken } = require("../middleware/auth");
const core = require("../services/signalCore");
const perf = require("../services/performanceMetrics");

router.use(verifyToken);

// GET /api/dashboard/overview
router.get("/overview", async (req, res) => {
  try {
    const [accounts, openTrades, recentSignals, recentLogs, clients] = await Promise.all([
      supabaseAdmin.from("mt5_accounts").select("*").eq("is_active", true),
      supabaseAdmin.from("trades").select("*").eq("status", "open"),
      supabaseAdmin.from("signals").select("*").order("created_at", { ascending: false }).limit(10),
      supabaseAdmin.from("system_logs").select("*").order("created_at", { ascending: false }).limit(20),
      supabaseAdmin.from("clients").select("*").eq("status", "active")
    ]);

    const accountData = accounts.data || [];
    const totalBalance = accountData.reduce((s, a) => s + (a.balance || 0), 0);
    const totalEquity = accountData.reduce((s, a) => s + (a.equity || 0), 0);
    const totalProfit = accountData.reduce((s, a) => s + (a.profit || 0), 0);
    const connectedAccounts = accountData.filter(a => a.is_connected).length;

    res.json({
      summary: {
        total_balance: totalBalance,
        total_equity: totalEquity,
        total_profit: totalProfit,
        total_accounts: accountData.length,
        connected_accounts: connectedAccounts,
        open_trades: (openTrades.data || []).length,
        active_clients: (clients.data || []).length
      },
      accounts: accountData,
      open_trades: openTrades.data || [],
      recent_signals: recentSignals.data || [],
      recent_logs: recentLogs.data || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/dashboard/equity-curve/:accountId?days=30&before=ISO&after=ISO
router.get("/equity-curve/:accountId", async (req, res) => {
  try {
    // FIX (confirmed via matching frontend symptom - equity curve stopping
    // mid-August while "today" was September): this had NO date filtering
    // and ordered ascending with limit(500), so it always returned the
    // OLDEST 500 snapshots regardless of what the user wanted - the exact
    // same bug class fixed earlier in fetchCachedBars (backend/src/routes/
    // backtest.js). Once an account passes 500 hourly snapshots (~20.8
    // days), "today" can never appear again. Now accepts days/before/after
    // and actually returns the requested window, ordered ascending
    // (correct for a chronological chart) with a generous safety cap.
    const { days, before, after } = req.query;

    let query = supabaseAdmin
      .from("account_snapshots")
      .select("*")
      .eq("account_id", req.params.accountId)
      .order("snapshot_time", { ascending: true })
      .limit(3000); // generous enough for 90 days of hourly snapshots (~2160) plus headroom

    if (after) query = query.gte("snapshot_time", after);
    if (before) query = query.lte("snapshot_time", before);

    // Fallback for callers that don't pass before/after (e.g. an older
    // frontend build, or a direct API call): default to the most recent
    // `days` (or 30 if not specified) instead of silently defaulting to
    // the oldest available data.
    if (!after && !before) {
      const windowDays = parseInt(days) || 30;
      const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
      query = query.gte("snapshot_time", cutoff);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ snapshots: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/dashboard/performance
router.get("/performance", async (req, res) => {
  try {
    const { data: trades } = await supabaseAdmin
      .from("trades")
      .select("*")
      .eq("status", "closed")
      .order("close_time", { ascending: false })
      .limit(200);

    if (!trades || trades.length === 0) {
      return res.json({ trades: [], stats: null });
    }

    const winners = trades.filter(t => (t.profit || 0) > 0);
    const losers = trades.filter(t => (t.profit || 0) < 0);
    const totalPnL = trades.reduce((s, t) => s + (t.profit || 0), 0);
    const grossProfit = winners.reduce((s, t) => s + (t.profit || 0), 0);
    const grossLoss = Math.abs(losers.reduce((s, t) => s + (t.profit || 0), 0));

    // NEW (Oct 4 — Roadmap Phase 2 item 7): same expectancy/R-multiple/
    // Sharpe/Sortino metrics now in backtest.js, computed here for LIVE
    // closed trades instead of a backtest replay. pipValuePerLot uses the
    // same per-symbol convention as backtest.js's ASSUMED_SPREAD_PIPS
    // table (index-style instruments priced in whole points, forex pairs
    // priced per pip) so R-multiples mean the same thing in both places.
    const pipValuePerLotFor = (symbol) =>
      ({ GOLD: 1, BTCUSD: 1, US30Cash: 1, GER40Cash: 1 }[symbol] || 10);

    const normalizedTrades = trades.map(t => perf.normalizeTradeForMetrics(
      { profit: t.profit, open_price: t.open_price, stop_loss: t.stop_loss, volume: t.volume },
      core.PIP_SIZES[t.symbol] || 0.0001,
      pipValuePerLotFor(t.symbol)
    ));
    // balance isn't tracked per-trade for live trades (unlike the backtest
    // replay, which recomputes it every step) - account balance at trade
    // time isn't reconstructable from this table alone, so Sharpe/Sortino
    // use profit as a fraction of the CURRENT total account balance as an
    // approximation rather than the true balance-at-the-time. Flagged
    // explicitly in the response rather than silently treated as exact.
    const { data: accountsForBalance } = await supabaseAdmin
      .from("mt5_accounts").select("balance").eq("is_active", true);
    const approxBalance = (accountsForBalance || []).reduce((s, a) => s + (a.balance || 0), 0) || 1000;
    const returns = trades.map(t => (t.profit || 0) / approxBalance);
    const times = trades.map(t => t.close_time || t.open_time);
    const riskAdjusted = perf.buildRiskAdjustedSummary({ normalizedTrades, returns, times });

    const stats = {
      total_trades: trades.length,
      win_rate: trades.length > 0 ? (winners.length / trades.length * 100).toFixed(1) : 0,
      total_pnl: totalPnL.toFixed(2),
      gross_profit: grossProfit.toFixed(2),
      gross_loss: grossLoss.toFixed(2),
      profit_factor: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "∞",
      avg_win: winners.length > 0 ? (grossProfit / winners.length).toFixed(2) : 0,
      avg_loss: losers.length > 0 ? (grossLoss / losers.length).toFixed(2) : 0,
      best_trade: trades.reduce((max, t) => Math.max(max, t.profit || 0), 0).toFixed(2),
      worst_trade: trades.reduce((min, t) => Math.min(min, t.profit || 0), 0).toFixed(2),
      expectancy_dollars: riskAdjusted.expectancy_dollars,
      expectancy_r: riskAdjusted.expectancy_r,
      r_multiple: riskAdjusted.r_multiple,
      sharpe_ratio: riskAdjusted.sharpe_ratio,
      sortino_ratio: riskAdjusted.sortino_ratio,
      annualization_trades_per_year: riskAdjusted.annualization_trades_per_year,
      risk_adjusted_note: riskAdjusted.note
        || "Sharpe/Sortino use each trade's P&L against current total account balance (not the true balance at the time of that trade, which isn't stored) — a reasonable approximation for a roughly-stable account, less so after a large deposit/withdrawal or big equity swing.",
    };

    res.json({ trades, stats });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/dashboard/settings
router.get("/settings", async (req, res) => {
  try {
    const { data } = await supabaseAdmin.from("platform_settings").select("*");
    const settings = {};
    (data || []).forEach(s => { settings[s.key] = s.value; });
    res.json({ settings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/dashboard/settings
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

module.exports = router;
