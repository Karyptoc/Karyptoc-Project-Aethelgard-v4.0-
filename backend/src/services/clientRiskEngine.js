/**
 * AETHELGARD - Per-Client Risk Circuit Breakers
 * backend/src/services/clientRiskEngine.js
 *
 * NEW (Oct 4 — Roadmap Phase 2, "per-client risk circuit breakers for
 * managed accounts"): the copy-trading engine (copyTrading.js) had NO
 * per-client risk gate at all. POST /bridge/lot-sizes — the endpoint that
 * decides which clients get a copy of the master's next trade — returned
 * every active, copy-enabled, connected client unconditionally, with no
 * check on that client's own daily loss, trade count, or losing streak.
 * A client having a terrible day kept getting every new signal copied onto
 * their account at full size, same as a client having a great day, right
 * up until a human noticed and disabled them by hand.
 *
 * Mirrors the account-level protections already in riskEngine.js
 * (checkCircuitBreaker's daily-loss %, checkConsecutiveLossProtection's
 * losing-streak pause) but scoped to a single client's own
 * client_trades/client_daily_pnl rows instead of the master account's
 * trades table — a client's risk is their own money, sized independently
 * via calculateClientLot(), so their circuit breaker has to be independent
 * too, not inherited from however the master account happens to be doing.
 *
 * Deliberately gates ONLY at POST /bridge/lot-sizes (the point where the
 * system decides WHETHER to send a client this trade) — never at
 * POST /bridge/execute, which just RECORDS a trade the bridge already
 * placed in that client's real MT5 account. Blocking at /execute would
 * leave a real, already-placed trade untracked in our own database, which
 * is strictly worse than letting it get logged.
 */

const { supabaseAdmin, log } = require("./supabase");

async function getClientRiskSettings() {
  let maxDailyLossPct = 5.0, maxTradesPerDay = 10, maxConsecutiveLosses = 4, cooldownHours = 4;
  try {
    const { data } = await supabaseAdmin
      .from("platform_settings")
      .select("key, value")
      .in("key", [
        "client_max_daily_loss_pct",
        "client_max_trades_per_day",
        "client_max_consecutive_losses",
        "client_consecutive_loss_cooldown_hours",
      ]);
    (data || []).forEach(s => {
      if (s.key === "client_max_daily_loss_pct") maxDailyLossPct = parseFloat(s.value) || maxDailyLossPct;
      if (s.key === "client_max_trades_per_day") maxTradesPerDay = parseInt(s.value) || maxTradesPerDay;
      if (s.key === "client_max_consecutive_losses") maxConsecutiveLosses = parseInt(s.value) || maxConsecutiveLosses;
      if (s.key === "client_consecutive_loss_cooldown_hours") cooldownHours = parseFloat(s.value) || cooldownHours;
    });
  } catch {}
  return { maxDailyLossPct, maxTradesPerDay, maxConsecutiveLosses, cooldownHours };
}

/**
 * Losing-streak pause, scoped to one client's own client_trades rows.
 * Same anchor-on-cooldown-expiry design as riskEngine.js's
 * checkConsecutiveLossProtection, and for the same reason: re-judging the
 * same stale losing streak the instant the cooldown clock runs out would
 * re-trip the halt on the very next bridge poll and make the cooldown a
 * no-op. Only client_trades that close AFTER the halt's anchor point count
 * toward a fresh streak.
 */
async function checkClientConsecutiveLosses(clientId, maxLosses, cooldownHours) {
  try {
    const haltKey = `client_consecutive_loss_halt_${clientId}`;
    const { data: haltRow } = await supabaseAdmin
      .from("platform_settings").select("value").eq("key", haltKey).single();
    let halt = null;
    try { halt = haltRow?.value ? JSON.parse(haltRow.value) : null; } catch { halt = null; }

    const now = Date.now();
    let anchorCloseTime = null;

    if (halt) {
      if (now < new Date(halt.cooldownUntil).getTime()) {
        const remainingMin = Math.ceil((new Date(halt.cooldownUntil).getTime() - now) / 60000);
        return {
          allowed: false,
          reason: `${halt.streak} consecutive losses — ${remainingMin}min left in cooldown`
        };
      }
      anchorCloseTime = halt.anchorCloseTime;
    }

    let query = supabaseAdmin
      .from("client_trades").select("profit, close_time")
      .eq("client_id", clientId).eq("status", "closed")
      .order("close_time", { ascending: false })
      .limit(Math.max(maxLosses + 5, 20));
    if (anchorCloseTime) query = query.gt("close_time", anchorCloseTime);
    const { data: recentTrades } = await query;

    if (halt && (!recentTrades || recentTrades.length === 0)) {
      await supabaseAdmin.from("platform_settings").delete().eq("key", haltKey);
      return { allowed: true };
    }

    let streak = 0;
    for (const t of (recentTrades || [])) {
      if ((t.profit || 0) < 0) streak++;
      else break;
    }

    if (streak >= maxLosses) {
      const haltedNow = new Date().toISOString();
      const cooldownUntil = new Date(now + cooldownHours * 60 * 60 * 1000).toISOString();
      await supabaseAdmin.from("platform_settings").upsert({
        key: haltKey,
        value: JSON.stringify({ haltedAt: haltedNow, cooldownUntil, anchorCloseTime: recentTrades[0].close_time, streak }),
        updated_at: haltedNow
      }, { onConflict: "key" });
      return { allowed: false, reason: `${streak} consecutive losses — paused ${cooldownHours}h` };
    }

    if (halt) {
      await supabaseAdmin.from("platform_settings").delete().eq("key", haltKey);
    }
    return { allowed: true };
  } catch (e) {
    await log("error", "clientRiskEngine", `checkClientConsecutiveLosses error: ${e.message}`);
    return { allowed: true }; // fail open, same convention as every other risk gate
  }
}

/**
 * Full per-client gate: status/copy-enabled, today's loss % of equity,
 * today's trade count, and the consecutive-loss pause above. Called once
 * per active client inside POST /bridge/lot-sizes, before that client is
 * included in the response sent to the bridge.
 *
 * @param {object} client - a row from client_accounts (id, name, status,
 *   copy_enabled, equity/balance/starting_balance)
 */
async function checkClientRiskCircuitBreaker(client) {
  try {
    if (!client) return { allowed: false, reason: "Client not found" };
    if (client.status !== "active") return { allowed: false, reason: "Client not active" };
    if (!client.copy_enabled) return { allowed: false, reason: "Copy trading disabled for client" };

    const { maxDailyLossPct, maxTradesPerDay, maxConsecutiveLosses, cooldownHours } = await getClientRiskSettings();

    const today = new Date().toISOString().slice(0, 10);
    const { data: dayRecord } = await supabaseAdmin
      .from("client_daily_pnl")
      .select("net_pnl, trades_count")
      .eq("client_id", client.id).eq("date", today).single();

    if (dayRecord) {
      const equity = client.equity || client.balance || client.starting_balance || 1000;
      const lossPct = Math.abs(Math.min(0, dayRecord.net_pnl || 0)) / equity * 100;
      if (lossPct >= maxDailyLossPct) {
        return { allowed: false, reason: `daily loss ${lossPct.toFixed(1)}% >= limit ${maxDailyLossPct}%` };
      }
      if ((dayRecord.trades_count || 0) >= maxTradesPerDay) {
        return { allowed: false, reason: `max ${maxTradesPerDay} trades/day reached (${dayRecord.trades_count})` };
      }
    }

    const streakCheck = await checkClientConsecutiveLosses(client.id, maxConsecutiveLosses, cooldownHours);
    if (!streakCheck.allowed) return streakCheck;

    return { allowed: true };
  } catch (e) {
    await log("error", "clientRiskEngine", `checkClientRiskCircuitBreaker error: ${e.message}`);
    return { allowed: true }; // fail open
  }
}

module.exports = {
  getClientRiskSettings,
  checkClientConsecutiveLosses,
  checkClientRiskCircuitBreaker,
};
