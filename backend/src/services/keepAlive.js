/**
 * AETHELGARD - Keep-Alive Service
 * Pings the backend every 10 minutes to prevent Render free tier sleep
 * Also monitors system health and auto-recovers
 */

const axios = require("axios");
const { supabaseAdmin, log } = require("./supabase");

const BACKEND_URL = process.env.BACKEND_URL || `https://aethelgard-backend-uff7.onrender.com`;
let pingCount = 0;
let failCount = 0;
let startTime = Date.now();

async function selfPing() {
  try {
    const r = await axios.get(`${BACKEND_URL}/health`, { timeout: 15000 });
    pingCount++;
    failCount = 0;
    const uptime = Math.round((Date.now() - startTime) / 1000 / 60);

    if (pingCount % 6 === 0) { // Log every hour
      await log("info", "keepAlive",
        `System healthy — uptime: ${uptime}min | pings: ${pingCount}`
      );
    }
    return true;
  } catch (e) {
    failCount++;
    await log("warning", "keepAlive", `Ping failed (${failCount}): ${e.message}`);

    if (failCount >= 3) {
      await log("critical", "keepAlive", "Backend unreachable for 3 consecutive pings!");
    }
    return false;
  }
}

async function checkBridgeHealth() {
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: accounts } = await supabaseAdmin
      .from("mt5_accounts")
      .select("id, label, last_sync, is_connected")
      .eq("is_active", true);

    if (!accounts?.length) return;

    for (const acc of accounts) {
      if (!acc.last_sync) continue;
      const lastSync = new Date(acc.last_sync);
      const minsAgo = (Date.now() - lastSync.getTime()) / 1000 / 60;

      if (minsAgo > 5 && acc.is_connected) {
        // Mark as disconnected if no sync in 5 min
        await supabaseAdmin
          .from("mt5_accounts")
          .update({ is_connected: false })
          .eq("id", acc.id);
        await log("warning", "keepAlive",
          `Account ${acc.label} marked offline — no sync for ${Math.round(minsAgo)}min`
        );
      }
    }
  } catch (e) {
    // Silent fail
  }
}

async function getSystemStatus() {
  try {
    const [accounts, openTrades, recentSignals, recentLogs] = await Promise.all([
      supabaseAdmin.from("mt5_accounts").select("*").eq("is_active", true),
      supabaseAdmin.from("trades").select("id").eq("status", "open"),
      supabaseAdmin.from("signals").select("id, created_at").order("created_at", { ascending: false }).limit(1),
      supabaseAdmin.from("system_logs").select("*").order("created_at", { ascending: false }).limit(5)
    ]);

    const connectedAccounts = (accounts.data || []).filter(a => a.is_connected);
    const lastSignal = recentSignals.data?.[0];
    const lastSignalMins = lastSignal
      ? Math.round((Date.now() - new Date(lastSignal.created_at).getTime()) / 1000 / 60)
      : null;

    return {
      uptime_minutes: Math.round((Date.now() - startTime) / 1000 / 60),
      ping_count: pingCount,
      fail_count: failCount,
      connected_accounts: connectedAccounts.length,
      total_accounts: (accounts.data || []).length,
      open_trades: (openTrades.data || []).length,
      last_signal_minutes_ago: lastSignalMins,
      bridge_healthy: connectedAccounts.length > 0,
      recent_logs: recentLogs.data || []
    };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { selfPing, checkBridgeHealth, getSystemStatus };
