/**
 * AETHELGARD - Client Portal Routes (Fixed)
 */

const express = require("express");
const router = express.Router();
const { supabaseAdmin } = require("../services/supabase");
const { verifyToken } = require("../middleware/auth");

router.get("/dashboard", verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;

    // Use supabaseAdmin (service role) to bypass RLS
    // Find client by user_id
    const { data: client, error: clientError } = await supabaseAdmin
      .from("clients")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (clientError || !client) {
      // Also try finding by email as fallback
      const { data: clientByEmail } = await supabaseAdmin
        .from("clients")
        .select("*")
        .eq("email", req.user.email)
        .single();

      if (!clientByEmail) {
        return res.status(404).json({ 
          error: "No client profile found for this account",
          debug: { userId, email: req.user.email }
        });
      }

      // Auto-link user_id if found by email
      await supabaseAdmin
        .from("clients")
        .update({ user_id: userId })
        .eq("id", clientByEmail.id);

      return handleClientData(res, { ...clientByEmail, user_id: userId });
    }

    return handleClientData(res, client);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function handleClientData(res, client) {
  try {
    // Get MT5 accounts linked to this client
    const { data: accounts } = await supabaseAdmin
      .from("mt5_accounts")
      .select("*")
      .eq("is_active", true);

    // Get open trades
    const accountIds = (accounts || []).map(a => a.id);
    let openTrades = [], recentTrades = [];

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

    // Get invoices for this client
    const { data: invoices } = await supabaseAdmin
      .from("invoices").select("*")
      .eq("client_id", client.id)
      .order("created_at", { ascending: false });

    const closedTrades = recentTrades;
    const winners = closedTrades.filter(t => (t.profit || 0) > 0);
    const totalPnL = closedTrades.reduce((s, t) => s + (t.profit || 0), 0);
    const totalBalance = (accounts || []).reduce((s, a) => s + (a.balance || 0), 0);

    res.json({
      client,
      accounts: accounts || [],
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
          ? parseFloat((winners.length / closedTrades.length * 100).toFixed(1)) : 0,
        pendingInvoices: (invoices || []).filter(i => i.status === "pending").length,
        totalPaid: (invoices || [])
          .filter(i => i.status === "paid")
          .reduce((s, i) => s + (i.amount_due || 0), 0)
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

module.exports = router;
