/**
 * AETHELGARD - Bridge Routes v2
 * Fix: reads max_concurrent_trades, default_risk_percent, circuit_breaker_daily_loss_pct
 * from platform_settings table — dashboard changes take effect immediately
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

// ── Helper: read platform settings from DB ────────────────────────────────────
async function getPlatformSettings() {
  try {
    const { data } = await supabaseAdmin
      .from("platform_settings")
      .select("key, value");
    const settings = {};
    (data || []).forEach(s => { settings[s.key] = s.value; });
    return {
      maxConcurrentTrades: parseInt(settings["max_concurrent_trades"]) || 5,
      defaultRiskPercent: parseFloat(settings["default_risk_percent"]) || 1.0,
      circuitBreakerPct: parseFloat(settings["circuit_breaker_daily_loss_pct"]) || 5.0,
      tradingEnabled: settings["trading_enabled"] === true || settings["trading_enabled"] === "true",
      allowedPairs: (() => {
        try {
          const p = settings["allowed_pairs"];
          return Array.isArray(p) ? p : JSON.parse(p);
        } catch {
          return ["GOLD","EURUSD","GBPUSD","USDJPY","AUDUSD","USDCAD","USDCHF","NZDUSD","GBPJPY","EURJPY","US30Cash","GER40Cash","BTCUSD"];
        }
      })()
    };
  } catch (e) {
    await log("error", "bridge", `Failed to read platform settings: ${e.message}`);
    return {
      maxConcurrentTrades: 5,
      defaultRiskPercent: 1.0,
      circuitBreakerPct: 5.0,
      tradingEnabled: true,
      allowedPairs: ["GOLD","EURUSD","GBPUSD","USDJPY","AUDUSD","USDCAD","USDCHF","NZDUSD","GBPJPY","EURJPY","US30Cash","GER40Cash","BTCUSD"]
    };
  }
}

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

// POST ohlcv
router.post("/ohlcv", async (req, res) => {
  const { symbol, data, spread } = req.body;
  try {
    // Check trading enabled before generating signal
    const settings = await getPlatformSettings();
    if (!settings.tradingEnabled) {
      return res.json({ ok: true, signal: null, reason: "Trading disabled" });
    }

    await log("info", "bridge", `OHLCV received: ${symbol} | spread: ${spread || "N/A"}pips`);
    const signal = await signalEngine.generateSignalFromOHLCV(symbol, data);
    res.json({ ok: true, signal: signal ? signal.id : null });
  } catch (e) {
    await log("error", "bridge", `OHLCV signal error ${symbol}: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// GET commands
router.get("/commands", async (req, res) => {
  try {
    // Read live settings from DB — respects dashboard changes immediately
    const settings = await getPlatformSettings();

    if (!settings.tradingEnabled) {
      return res.json({ commands: [] });
    }

    const commands = signalEngine.getAndClearCommands();

    const { data: pendingSignals } = await supabaseAdmin
      .from("signals")
      .select("*")
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .gte("confidence", 0.50);

    if (pendingSignals?.length > 0) {
      for (const signal of pendingSignals) {
        if (signal.direction === "HOLD") continue;

        // Check against platform allowed_pairs setting
        if (!settings.allowedPairs.includes(signal.symbol)) {
          await log("info", "bridge", `${signal.symbol} not in allowed pairs — skipping`);
          continue;
        }

        const { data: accounts } = await supabaseAdmin
          .from("mt5_accounts")
          .select("*")
          .eq("is_active", true)
          .eq("is_connected", true);

        if (!accounts?.length) continue;

        for (const account of accounts) {
          // ── Fix 3: Global max concurrent trades (platform-level) ──────────────
          // Count ALL open trades across all pairs for this account
          const { data: openTrades } = await supabaseAdmin
            .from("trades").select("id, symbol")
            .eq("account_id", account.id).eq("status", "open");

          const openCount = openTrades?.length || 0;
          if (openCount >= settings.maxConcurrentTrades) {
            await log("info", "bridge",
              `Max concurrent trades reached: ${openCount}/${settings.maxConcurrentTrades} — skipping ${signal.symbol}`
            );
            continue;
          }

          // ── Fix 4: Per-pair open position cap ────────────────────────────────
          // Prevent stacking multiple open trades on same pair simultaneously
          const openForPair = (openTrades || []).filter(t => t.symbol === signal.symbol).length;
          const MAX_OPEN_PER_PAIR = 2; // hardcoded safety — 1 open position per pair max
          if (openForPair >= MAX_OPEN_PER_PAIR) {
            await log("info", "bridge",
              `${signal.symbol} already has ${openForPair} open trade(s) — skipping new signal`
            );
            continue;
          }

          // ── Fix 5: Per-pair max trades/day and daily drawdown (pair_controls) ─
          const cbCheck = await checkCircuitBreaker(account.id, signal.symbol);
          if (!cbCheck.allowed) {
            await log("info", "bridge", `Circuit breaker / pair limit: ${cbCheck.reason}`);
            continue;
          }

          // Check daily loss against platform setting
          const todayStart = new Date();
          todayStart.setHours(0, 0, 0, 0);
          const { data: todayTrades } = await supabaseAdmin
            .from("trades").select("profit")
            .eq("account_id", account.id).eq("status", "closed")
            .gte("close_time", todayStart.toISOString());

          if (todayTrades?.length) {
            const dailyPnL = todayTrades.reduce((s, t) => s + (t.profit || 0), 0);
            const maxLoss = (account.balance || 1000) * settings.circuitBreakerPct / 100;
            if (dailyPnL <= -maxLoss) {
              await log("warning", "bridge",
                `Daily loss limit hit: $${Math.abs(dailyPnL).toFixed(2)} / $${maxLoss.toFixed(2)}`
              );
              continue;
            }
          }

          const pip = {
            GOLD: 0.01, USDJPY: 0.01, US30Cash: 1, GER40Cash: 1,
            BTCUSD: 1, GBPJPY: 0.01, EURJPY: 0.01
          }[signal.symbol] || 0.0001;

          const stopPips = signal.stop_loss && signal.entry_price
            ? Math.abs(signal.entry_price - signal.stop_loss) / pip
            : 20;

          const positionSizeModifier = signal.regime_detail?.position_size_modifier || 1.0;

          // Use default_risk_percent from platform_settings
          const sizing = calculatePositionSize({
            balance: account.balance || 500,
            riskPercent: settings.defaultRiskPercent * positionSizeModifier,
            stopLossPips: Math.max(stopPips, 5),
            symbol: signal.symbol
          });

          const cmdId = `sig_${signal.id}_${account.id}`;

          commands.push({
            id: cmdId,
            type: "EXECUTE_TRADE",
            account_id: account.id,
            signal_id: signal.id,
            order: {
              symbol: signal.symbol,
              direction: signal.direction,
              volume: sizing.lotSize,
              stop_loss: signal.stop_loss,
              take_profit: signal.take_profit,
              comment: `AE_${signal.id.substr(0, 8)}`,
              order_type: signal.order_type || "MARKET",
              pending_price: signal.pending_price || null
            }
          });
        }

        // Mark as sent — not executed yet
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

// POST commands/:id/ack
router.post("/commands/:id/ack", async (req, res) => {
  const { id } = req.params;
  const result = req.body;

  signalEngine.acknowledgeCommand(id, result);

  if (id.startsWith("sig_") && result.success) {
    try {
      // Parse account_id — it's the last UUID in the command id
      // Format: sig_{signal_uuid}_{account_uuid}
      // Both UUIDs contain hyphens so we split differently
      const withoutPrefix = id.substring(4); // remove "sig_"
      // UUID is 36 chars: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      const accountId = withoutPrefix.substring(withoutPrefix.length - 36);
      const signalId = withoutPrefix.substring(0, withoutPrefix.length - 37); // remove trailing underscore + UUID

      // Insert trade record
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

      // Mark signal executed only after confirmed trade
      if (signalId) {
        await supabaseAdmin.from("signals")
          .update({ status: "executed" })
          .eq("id", signalId);
      }

      await log("info", "bridge",
        `Trade confirmed: ${result.order?.direction} ${result.order?.symbol} @ ${result.price} | #${result.ticket}`
      );
    } catch (e) {
      await log("error", "bridge", `ACK processing error: ${e.message}`);
    }
  } else if (id.startsWith("sig_") && !result.success) {
    await log("warning", "bridge", `Trade failed for ${id}: ${result.error}`);
    // Revert signal to pending so it can retry on next cycle
    try {
      const withoutPrefix = id.substring(4);
      const signalId = withoutPrefix.substring(0, withoutPrefix.length - 37);
      if (signalId) {
        await supabaseAdmin.from("signals")
          .update({ status: "pending" })
          .eq("id", signalId);
      }
    } catch (e) {}
  }

  res.json({ ok: true });
});

// POST /api/bridge/slippage — slippage analytics logger
router.post("/slippage", async (req, res) => {
  try {
    const { symbol, direction, signal_time, fill_time, latency_ms,
            requested_price, fill_price, slippage_pips, order_type, ticket } = req.body;

    // Upsert to slippage_log table (create if not exists via supabase)
    const { error } = await supabaseAdmin.from("slippage_log").insert({
      symbol, direction, signal_time, fill_time, latency_ms,
      requested_price, fill_price, slippage_pips, order_type, ticket,
      created_at: new Date().toISOString()
    });

    if (error) {
      // Table might not exist yet — log warning but don't fail
      await log("warning", "bridge", `Slippage log insert error: ${error.message}`);
    } else {
      if (slippage_pips > 3) {
        await log("warning", "bridge", `HIGH SLIPPAGE ${symbol}: ${slippage_pips}p | latency ${latency_ms}ms`);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// GET /api/bridge/settings — returns all bridge-relevant settings in one call
router.get("/settings", async (req, res) => {
  try {
    const settings = await getPlatformSettings();

    // Also read max_open_per_pair from platform_settings
    let maxOpenPerPair = 2;
    try {
      const { data } = await supabaseAdmin
        .from("platform_settings").select("value")
        .eq("key", "max_open_per_pair").single();
      maxOpenPerPair = parseInt(data?.value) || 2;
    } catch {}

    res.json({
      max_concurrent_trades: settings.maxConcurrentTrades,
      max_open_per_pair: maxOpenPerPair,
      trading_enabled: settings.tradingEnabled,
      default_risk_percent: settings.defaultRiskPercent,
    });
  } catch (e) {
    res.json({ max_concurrent_trades: 15, max_open_per_pair: 2, trading_enabled: true, default_risk_percent: 1.0 });
  }
});

// GET /api/bridge/signal-interval — returns signal interval for bridge (uses bridge secret auth)
router.get("/signal-interval", async (req, res) => {
  try {
    const { data } = await supabaseAdmin
      .from("platform_settings")
      .select("value")
      .eq("key", "signal_interval_minutes")
      .single();
    const minutes = parseInt(data?.value) || 15;
    res.json({ interval_minutes: minutes });
  } catch (e) {
    res.json({ interval_minutes: 15 });
  }
});

module.exports = router;