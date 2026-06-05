/**
 * AETHELGARD - Client Portal Routes
 * Clients login to view their performance and pay invoices
 */

const express = require("express");
const router = express.Router();
const { supabaseAdmin, supabaseAnon } = require("../services/supabase");
const { verifyToken } = require("../middleware/auth");

// GET client dashboard data
router.get("/dashboard", verifyToken, async (req, res) => {
  try {
    // Get client profile linked to this user
    const { data: client } = await supabaseAdmin
      .from("clients")
      .select("*, mt5_accounts(*)")
      .eq("user_id", req.user.id)
      .single();

    if (!client) {
      return res.status(404).json({ error: "No client profile found for this account" });
    }

    // Get their MT5 account data
    const accounts = client.mt5_accounts || [];
    const accountIds = accounts.map(a => a.id);

    // Get open trades
    let openTrades = [];
    let recentTrades = [];
    if (accountIds.length > 0) {
      const { data: open } = await supabaseAdmin
        .from("trades").select("*")
        .in("account_id", accountIds).eq("status", "open");
      const { data: recent } = await supabaseAdmin
        .from("trades").select("*")
        .in("account_id", accountIds).eq("status", "closed")
        .order("close_time", { ascending: false }).limit(20);
      openTrades = open || [];
      recentTrades = recent || [];
    }

    // Get recent signals
    const { data: signals } = await supabaseAdmin
      .from("signals").select("*")
      .order("created_at", { ascending: false }).limit(10);

    // Get invoices
    const { data: invoices } = await supabaseAdmin
      .from("invoices").select("*")
      .eq("client_id", client.id)
      .order("created_at", { ascending: false });

    // Performance stats
    const closedTrades = recentTrades;
    const winners = closedTrades.filter(t => (t.profit || 0) > 0);
    const totalPnL = closedTrades.reduce((s, t) => s + (t.profit || 0), 0);
    const totalBalance = accounts.reduce((s, a) => s + (a.balance || 0), 0);

    res.json({
      client,
      accounts,
      openTrades,
      recentTrades: closedTrades.slice(0, 10),
      signals: signals || [],
      invoices: invoices || [],
      stats: {
        totalBalance,
        totalPnL: parseFloat(totalPnL.toFixed(2)),
        openPositions: openTrades.length,
        totalTrades: closedTrades.length,
        winRate: closedTrades.length > 0
          ? parseFloat((winners.length / closedTrades.length * 100).toFixed(1))
          : 0,
        pendingInvoices: (invoices || []).filter(i => i.status === "pending").length,
        totalPaid: (invoices || [])
          .filter(i => i.status === "paid")
          .reduce((s, i) => s + (i.amount_due || 0), 0)
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
