/**
 * BRIDGE ROUTES
 * Communication endpoints between Python MT5 bridge and backend
 */

const express = require("express");
const router = express.Router();
const { supabaseAdmin, log } = require("../services/supabase");
const signalEngine = require("../services/signalEngine");
const { checkCircuitBreaker, calculatePositionSize } = require("../services/riskEngine");

// Middleware: verify bridge secret
function verifyBridgeSecret(req, res, next) {
  const secret = req.headers["x-bridge-secret"];
  if (!secret || secret !== process.env.BRIDGE_SECRET) {
    return res.status(401).json({ error: "Unauthorized bridge request" });
  }
  next();
}

router.use(verifyBridgeSecret);

// GET /api/bridge/accounts
router.get("/accounts", async (req, res) => {
  try {
    const { data: accounts, error } = await supabaseAdmin
      .from("mt5_accounts")
      .select("id, login, server, account_type, risk_percent, max_daily_loss, max_trades, allowed_pairs")
      .eq("is_active", true);
    if (error) throw error;
    res.json({ accounts: accounts || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bridge/status
router.post("/status", async (req, res) => {
  const { account_id, connected } = req.body;
  try {
    await supabaseAdmin
      .from("mt5_accounts")
      .update({ is_connected: connected, last_sync: new Date().toISOString() })
      .eq("id", account_id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bridge/sync
router.post("/sync", async (req, res) => {
  const { account_id, account_info, positions, timestamp } = req.body;
  try {
    await supabaseAdmin
      .from("mt5_accounts")
      .update({
        balance: account_info.balance,
        equity: account_info.equity,
        margin: account_info.margin,
        free_margin: account_info.free_margin,
        profit: account_info.profit,
        currency: account_info.currency,
        leverage: account_info.leverage,
        is_connected: true,
        last_sync: timestamp
      })
      .eq("id", account_id);

    if (positions && positions.length > 0) {
      for (const pos of positions) {
        const { data: existing } = await supabaseAdmin
          .from("trades")
          .select("id")
          .eq("account_id", account_id)
          .eq("ticket", pos.ticket)
          .eq("status", "open")
          .single();

        if (!existing) {
          await supabaseAdmin.from("trades").insert({
            account_id,
            ticket: pos.ticket,
            symbol: pos.symbol,
            direction: pos.direction,
            volume: pos.volume,
            open_price: pos.open_price,
            stop_loss: pos.stop_loss,
            take_profit: pos.take_profit,
            profit: pos.profit,
            status: "open",
            open_time: pos.open_time
          });
        } else {
          await supabaseAdmin
            .from("trades")
            .update({ profit: pos.profit })
            .eq("id", existing.id);
        }
      }

      const activeTickets = positions.map(p => p.ticket);
      const { data: openTrades } = await supabaseAdmin
        .from("trades")
        .select("id, ticket")
        .eq("account_id", account_id)
        .eq("status", "open");

      if (openTrades) {
        for (const trade of openTrades) {
          if (!activeTickets.includes(trade.ticket)) {
            await supabaseAdmin
              .from("trades")
              .update({ status: "closed", close_time: new Date().toISOString() })
              .eq("id", trade.id);
          }
        }
      }
    }

    res.json({ ok: true });
  } catch (e) {
    await log("error", "bridge", `Sync error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bridge/ohlcv - bridge pushes OHLCV data, backend generates signal immediately
router.post("/ohlcv", async (req, res) => {
  const { symbol, data } = req.body;
  try {
    await log("info", "bridge", `Received OHLCV data for ${symbol}, generating signal...`);
    const signal = await signalEngine.generateSignalFromOHLCV(symbol, data);
    res.json({ ok: true, signal: signal ? signal.id : null });
  } catch (e) {
    await log("error", "bridge", `OHLCV signal error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/bridge/commands
router.get("/commands", async (req, res) => {
  try {
    const commands = signalEngine.getAndClearCommands();

    const { data: pendingSignals } = await supabaseAdmin
      .from("signals")
      .select("*")
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .gte("confidence", 0.65);

    if (pendingSignals && pendingSignals.length > 0) {
      for (const signal of pendingSignals) {
        if (signal.direction === "HOLD") continue;

        const { data: accounts } = await supabaseAdmin
          .from("mt5_accounts")
          .select("*")
          .eq("is_active", true)
          .eq("is_connected", true)
          .contains("allowed_pairs", [signal.symbol]);

        if (!accounts) continue;

        for (const account of accounts) {
          const cbCheck = await checkCircuitBreaker(account.id);
          if (!cbCheck.allowed) continue;

          const stopPips = signal.stop_loss
            ? Math.abs(signal.entry_price - signal.stop_loss) / 0.0001
            : 20;

          const sizing = calculatePositionSize({
            balance: account.balance || 500,
            riskPercent: account.risk_percent || 1.0,
            stopLossPips: stopPips,
            symbol: signal.symbol
          });

          commands.push({
            id: `sig_${signal.id}_${account.id}`,
            type: "EXECUTE_TRADE",
            account_id: account.id,
            order: {
              symbol: signal.symbol,
              direction: signal.direction,
              volume: sizing.lotSize,
              stop_loss: signal.stop_loss,
              take_profit: signal.take_profit,
              comment: `Aethelgard_${signal.id.substr(0, 8)}`
            }
          });
        }

        await supabaseAdmin
          .from("signals")
          .update({ status: "executed" })
          .eq("id", signal.id);
      }
    }

    res.json({ commands });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bridge/commands/:id/ack
router.post("/commands/:id/ack", async (req, res) => {
  const { id } = req.params;
  const result = req.body;

  signalEngine.acknowledgeCommand(id, result);

  if (id.startsWith("sig_") && result.success) {
    const parts = id.split("_");
    const accountId = parts[parts.length - 1];
    await supabaseAdmin.from("trades").insert({
      account_id: accountId,
      ticket: result.ticket,
      symbol: result.order?.symbol,
      direction: result.order?.direction,
      volume: result.volume,
      open_price: result.price,
      status: "open",
      open_time: new Date().toISOString()
    });
  }

  res.json({ ok: true });
});

module.exports = router;
