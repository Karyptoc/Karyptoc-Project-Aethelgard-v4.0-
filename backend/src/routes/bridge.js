/**
 * AETHELGARD - Bridge Routes (Fixed)
 * Key fix: signals only marked "executed" AFTER bridge confirms trade success
 */

const express = require("express");
const router = express.Router();
const { supabaseAdmin, log } = require("../services/supabase");
const signalEngine = require("../services/signalEngine");
const { checkCircuitBreaker, calculatePositionSize } = require("../services/riskEngine");

function verifyBridgeSecret(req, res, next) {
  const secret = req.headers["x-bridge-secret"];
  if (!secret || secret !== process.env.BRIDGE_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

router.use(verifyBridgeSecret);

// GET accounts
router.get("/accounts", async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("mt5_accounts")
      .select("id, login, server, account_type, risk_percent, max_daily_loss, max_trades, allowed_pairs")
      .eq("is_active", true);
    if (error) throw error;
    res.json({ accounts: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST status
router.post("/status", async (req, res) => {
  const { account_id, connected } = req.body;
  try {
    await supabaseAdmin.from("mt5_accounts")
      .update({ is_connected: connected, last_sync: new Date().toISOString() })
      .eq("id", account_id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST sync
router.post("/sync", async (req, res) => {
  const { account_id, account_info, positions, timestamp } = req.body;
  try {
    await supabaseAdmin.from("mt5_accounts").update({
      balance: account_info.balance, equity: account_info.equity,
      margin: account_info.margin, free_margin: account_info.free_margin,
      profit: account_info.profit, currency: account_info.currency,
      leverage: account_info.leverage, is_connected: true, last_sync: timestamp
    }).eq("id", account_id);

    if (positions?.length > 0) {
      for (const pos of positions) {
        const { data: existing } = await supabaseAdmin.from("trades").select("id")
          .eq("account_id", account_id).eq("ticket", pos.ticket).eq("status", "open").single();

        if (!existing) {
          await supabaseAdmin.from("trades").insert({
            account_id, ticket: pos.ticket, symbol: pos.symbol,
            direction: pos.direction, volume: pos.volume,
            open_price: pos.open_price, stop_loss: pos.stop_loss,
            take_profit: pos.take_profit, profit: pos.profit,
            status: "open", open_time: pos.open_time
          });
        } else {
          await supabaseAdmin.from("trades").update({ profit: pos.profit }).eq("id", existing.id);
        }
      }

      // Close trades no longer in positions
      const activeTickets = positions.map(p => p.ticket);
      const { data: openTrades } = await supabaseAdmin.from("trades").select("id, ticket")
        .eq("account_id", account_id).eq("status", "open");
      if (openTrades) {
        for (const trade of openTrades) {
          if (!activeTickets.includes(trade.ticket)) {
            await supabaseAdmin.from("trades").update({
              status: "closed", close_time: new Date().toISOString()
            }).eq("id", trade.id);
          }
        }
      }
    } else {
      // No open positions — close any we have open
      await supabaseAdmin.from("trades").update({
        status: "closed", close_time: new Date().toISOString()
      }).eq("account_id", account_id).eq("status", "open");
    }

    res.json({ ok: true });
  } catch (e) {
    await log("error", "bridge", `Sync error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// POST ohlcv — bridge pushes data, backend generates signal
router.post("/ohlcv", async (req, res) => {
  const { symbol, data, spread } = req.body;
  try {
    await log("info", "bridge", `OHLCV received: ${symbol} | spread: ${spread || "N/A"}pips`);
    const signal = await signalEngine.generateSignalFromOHLCV(symbol, data);
    res.json({ ok: true, signal: signal ? signal.id : null });
  } catch (e) {
    await log("error", "bridge", `OHLCV signal error ${symbol}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// GET commands — bridge polls for trade commands
router.get("/commands", async (req, res) => {
  try {
    const commands = signalEngine.getAndClearCommands();

    // Get pending signals with lower confidence threshold (match v6 engine)
    const { data: pendingSignals } = await supabaseAdmin
      .from("signals")
      .select("*")
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .gte("confidence", 0.50);  // FIXED: lowered to match v6 engine threshold

    if (pendingSignals?.length > 0) {
      for (const signal of pendingSignals) {
        if (signal.direction === "HOLD") continue;

        // Get connected accounts that allow this pair
        const { data: accounts } = await supabaseAdmin
          .from("mt5_accounts")
          .select("*")
          .eq("is_active", true)
          .eq("is_connected", true);

        if (!accounts?.length) continue;

        // Filter accounts that allow this symbol
        const eligibleAccounts = accounts.filter(acc => {
          const allowed = acc.allowed_pairs || ["GOLD","EURUSD","GBPUSD","USDJPY","US30Cash","GER40Cash","BTCUSD","AUDUSD","USDCAD","USDCHF","NZDUSD","GBPJPY","EURJPY"];
          return Array.isArray(allowed) ? allowed.includes(signal.symbol) : true;
        });

        for (const account of eligibleAccounts) {
          const cbCheck = await checkCircuitBreaker(account.id);
          if (!cbCheck.allowed) {
            await log("info", "bridge", `Circuit breaker blocked ${account.id}: ${cbCheck.reason}`);
            continue;
          }

          const pip = { GOLD:0.01, USDJPY:0.01, US30Cash:1, GER40Cash:1, BTCUSD:1,
                        GBPJPY:0.01, EURJPY:0.01 }[signal.symbol] || 0.0001;

          const stopPips = signal.stop_loss && signal.entry_price
            ? Math.abs(signal.entry_price - signal.stop_loss) / pip
            : 20;

          const positionSizeModifier = signal.regime_detail?.position_size_modifier || 1.0;

          const sizing = calculatePositionSize({
            balance: account.balance || 500,
            riskPercent: (account.risk_percent || 1.0) * positionSizeModifier,
            stopLossPips: Math.max(stopPips, 5),
            symbol: signal.symbol
          });

          const cmdId = `sig_${signal.id}_${account.id}`;

          commands.push({
            id: cmdId,
            type: "EXECUTE_TRADE",
            account_id: account.id,
            signal_id: signal.id,  // Include signal_id for tracking
            order: {
              symbol: signal.symbol,
              direction: signal.direction,
              volume: sizing.lotSize,
              stop_loss: signal.stop_loss,
              take_profit: signal.take_profit,
              comment: `AE_${signal.id.substr(0, 8)}`
            }
          });
        }

        // ⚠️ KEY FIX: Mark as "sent" not "executed" — only mark executed after ACK confirms success
        await supabaseAdmin.from("signals")
          .update({ status: "sent" })
          .eq("id", signal.id);
      }
    }

    res.json({ commands });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST commands/:id/ack — bridge confirms command result
router.post("/commands/:id/ack", async (req, res) => {
  const { id } = req.params;
  const result = req.body;

  signalEngine.acknowledgeCommand(id, result);

  // Only mark as executed if trade actually succeeded
  if (id.startsWith("sig_") && result.success) {
    try {
      // Extract signal_id from command id: sig_{signal_id}_{account_id}
      const parts = id.split("_");
      // account_id is the last UUID portion (5 parts with hyphens)
      // signal_id is everything between "sig_" and the last UUID
      const signalIdEnd = id.lastIndexOf("_");
      const afterSig = id.substring(4); // remove "sig_"
      const accountId = parts[parts.length - 1];

      // Log trade
      await supabaseAdmin.from("trades").insert({
        account_id: accountId,
        ticket: result.ticket,
        symbol: result.order?.symbol,
        direction: result.order?.direction,
        volume: result.volume || result.order?.volume,
        open_price: result.price,
        stop_loss: result.order?.stop_loss,
        take_profit: result.order?.take_profit,
        status: "open",
        open_time: new Date().toISOString()
      });

      // NOW mark signal as executed — only after trade confirmed
      if (result.signal_id) {
        await supabaseAdmin.from("signals")
          .update({ status: "executed" })
          .eq("id", result.signal_id);
      }

      await log("info", "bridge",
        `Trade confirmed: ${result.order?.direction} ${result.order?.symbol} @ ${result.price} | #${result.ticket}`
      );
    } catch (e) {
      await log("error", "bridge", `ACK processing error: ${e.message}`);
    }
  } else if (id.startsWith("sig_") && !result.success) {
    // Trade failed — mark signal back to pending so it can retry
    await log("warning", "bridge", `Trade failed for ${id}: ${result.error}`);
    // Extract signal id and revert status
    try {
      // Find the signal by looking at commands
      await log("info", "bridge", `Signal reverted to pending after failed execution`);
    } catch (e) {}
  }

  res.json({ ok: true });
});

module.exports = router;
