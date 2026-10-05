/**
 * AETHELGARD - Bridge Routes v2
 * Fix: reads max_concurrent_trades, default_risk_percent, circuit_breaker_daily_loss_pct
 * from platform_settings table — dashboard changes take effect immediately
 */

const express = require("express");
const router = express.Router();
const { supabaseAdmin, log } = require("../services/supabase");
const signalEngine = require("../services/signalEngine");
// FIX (Oct 4 audit): checkCorrelation and checkCurrencyExposure were fully
// implemented in riskEngine.js, exported, and never imported or called
// anywhere in the codebase — dead safeguards. 3 of the 5 losing trades
// reviewed in the diagnostic report's Section 2 were a concentrated,
// correlated bet (GER40Cash + US30Cash, a pair CORRELATION_GROUPS already
// names) that checkCorrelation was specifically built to catch. Now wired
// into the same per-account gate sequence as checkCircuitBreaker, below.
const { checkCircuitBreaker, calculatePositionSize, checkCorrelation, checkCurrencyExposure, getEquityCurveMultiplier, checkConsecutiveLossProtection } = require("../services/riskEngine");
const { sendTelegramMessage, isConfigured: isTelegramConfigured } = require("../services/telegram");
const { updatePOIZones } = require("../services/poiZoneEngine");
const { checkPyramiding } = require("../services/pyramiding");

// NEW (Roadmap Phase 4, TP/SL-hit notifier): fire-and-forget Telegram alert
// when a trade closes with a known reason. Mirrors the exact pattern
// signalEngine.js already uses for new-signal alerts (best-effort,
// sendTelegramMessage() never throws, a failed/absent config must never
// block or roll back the trade-close update it's reporting on).
async function notifyTradeClose(trade, closeReason) {
  if (closeReason !== "tp" && closeReason !== "sl") return; // stop_out/manual/unknown: no alert
  try {
    if (!(await isTelegramConfigured())) return;
    const label = closeReason === "tp" ? "🎯 TAKE PROFIT HIT" : "🛑 STOP LOSS HIT";
    const profit = typeof trade.profit === "number" ? trade.profit : null;
    const msg =
      `${label}\n` +
      `${trade.direction} ${trade.symbol}  (ticket #${trade.ticket})\n` +
      `Entry: ${trade.open_price}  |  Close: ${trade.close_price ?? "—"}\n` +
      (profit !== null ? `P&L: ${profit >= 0 ? "+" : ""}${profit.toFixed(2)}\n` : "");
    const tgResult = await sendTelegramMessage(msg);
    if (!tgResult.ok) {
      await log("warning", "bridge", `Trade #${trade.ticket} close alert not sent — ${tgResult.error}`);
    }
  } catch (tgErr) {
    await log("warning", "bridge", `Trade #${trade.ticket} close alert threw unexpectedly — ${tgErr.message}`);
  }
}

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
  const { account_id, account_info, positions, closed_positions, timestamp } = req.body;
  try {
    await supabaseAdmin.from("mt5_accounts").update({
      balance: account_info.balance, equity: account_info.equity,
      margin: account_info.margin, free_margin: account_info.free_margin,
      profit: account_info.profit, currency: account_info.currency,
      leverage: account_info.leverage, is_connected: true, last_sync: timestamp
    }).eq("id", account_id);

    // FIX: this used to be `positions?.length > 0`, with an else branch that
    // marked EVERY open trade closed with no real profit data. Two problems:
    // (a) when the LAST open position closed, positions was empty, so the
    // real closing result bridge.py had just fetched (closed_positions) was
    // thrown away and the trade kept a stale floating P&L; (b) a malformed
    // request with no positions field would have closed everything. An
    // empty array now goes through the same real-data close path below.
    if (Array.isArray(positions)) {
      for (const pos of positions) {
        // FIX: this used to filter by .eq("status", "open") too, meaning
        // if a row ever got marked "closed" by a transient sync glitch
        // (e.g. one cycle where MT5 briefly didn't report a still-open
        // position), this check would find nothing on the next sync that
        // saw it as active again - and insert a brand new row instead of
        // reopening the original. Confirmed live: a duplicate with a
        // 21-hour gap between the two rows, one with profit=null (the
        // prematurely-closed original) and one with the real closing
        // profit (the new row created later). Now matches by ticket+
        // account regardless of current status, same principle as the
        // ack-handler fix - the row's existence is checked independent
        // of a status field that can be wrong transiently.
        //
        // FIX (root cause of the duplicate trade rows - confirmed in a
        // 1,274-row export: 234 phantom copies, one ticket stored 68
        // times): this used .single(), which returns an ERROR (and no
        // data) as soon as MORE than one row matches. So after a ticket
        // was inserted twice, every later sync saw "no existing row" and
        // inserted ANOTHER copy, forever. Now reads an array and takes the
        // first match, so a duplicate can never beget more duplicates.
        // (The unique index in supabase_cleanup_duplicate_trades.sql makes
        // the database itself refuse them as a second line of defence.)
        const { data: existingRows } = await supabaseAdmin.from("trades").select("id, status")
          .eq("account_id", account_id).eq("ticket", pos.ticket).limit(1);
        const existing = existingRows?.[0];

        if (!existing) {
          const { error: insErr } = await supabaseAdmin.from("trades").insert({
            account_id, ticket: pos.ticket, symbol: pos.symbol,
            direction: pos.direction, volume: pos.volume,
            open_price: pos.open_price, stop_loss: pos.stop_loss,
            take_profit: pos.take_profit, profit: pos.profit,
            swap: pos.swap, commission: pos.commission,
            status: "open", open_time: pos.open_time
          });
          // 23505 = unique violation: another request inserted this ticket
          // a moment ago. Harmless - the next sync updates that row.
          if (insErr && insErr.code !== "23505") {
            await log("error", "bridge", `Trade insert failed for #${pos.ticket}: ${insErr.message}`);
          }
        } else {
          // MT5 reports this ticket as an active position right now, so
          // it must be "open" regardless of what a prior sync cycle set
          // it to - this is what correctly recovers from the premature-
          // close glitch instead of leaving a stale "closed" row behind.
          //
          // FIX (closes a real data gap - live trades were showing
          // open_price=null despite having real profit data): this update
          // never touched open_price at all, even though pos.open_price
          // is genuine, live MT5 data right here. If the ack handler ever
          // recorded a null placeholder (e.g. acking a pending order
          // before it filled), nothing downstream ever backfilled it.
          // Sync runs repeatedly and has the real value, so this gives
          // every open position a genuine chance to self-correct.
          //
          // FIX (real swap/commission tracking): both were always 0 in
          // the database across the entire trade history, confirmed
          // against MT5's own account statement showing real, nonzero
          // swap. MT5 accrues swap daily even on still-open positions -
          // now captured on every sync, not just at final close.
          await supabaseAdmin.from("trades").update({
            profit: pos.profit,
            swap: pos.swap, commission: pos.commission,
            status: "open",
            open_price: pos.open_price || undefined,
          }).eq("id", existing.id);
        }
      }

      // Close trades no longer in positions.
      // FIX (root cause of the real MT5 P&L vs database P&L discrepancy -
      // confirmed live: MT5 showed -$1,889.84 real profit across the
      // account's full history, the database showed +$2,922.73): this used
      // to just mark status="closed" with NO profit update at all - the
      // stored value stayed whatever floating P&L was last synced WHILE
      // the position was still open, never the true final realized
      // result. bridge.py now looks up each closed ticket's real deal
      // history in MT5 and sends it here as closed_positions - used when
      // available. Falls back to the old inferential close (status only,
      // no profit correction) only for tickets real data couldn't be
      // fetched for, so a lookup failure never silently blocks the close
      // from being recorded at all.
      const closedMap = Object.fromEntries((closed_positions || []).map(c => [c.ticket, c]));
      const activeTickets = positions.map(p => p.ticket);
      const { data: openTrades } = await supabaseAdmin.from("trades").select("id, ticket, direction, symbol, open_price")
        .eq("account_id", account_id).eq("status", "open");
      if (openTrades) {
        for (const trade of openTrades) {
          if (!activeTickets.includes(trade.ticket)) {
            const real = closedMap[trade.ticket];
            if (real) {
              // NEW (Roadmap Phase 4): close_reason comes from bridge.py's
              // get_real_closed_profit(), which now reads MT5's deal.reason -
              // "unknown" only if real data existed but somehow lacked it.
              const closeReason = real.close_reason || "unknown";
              await supabaseAdmin.from("trades").update({
                status: "closed",
                close_time: real.close_time || new Date().toISOString(),
                close_price: real.close_price || undefined,
                profit: real.profit,
                swap: real.swap,
                commission: real.commission,
                close_reason: closeReason,
              }).eq("id", trade.id);
              await notifyTradeClose({ ...trade, close_price: real.close_price, profit: real.profit }, closeReason);
            } else {
              await log("warning", "bridge",
                `Ticket ${trade.ticket} closed but no real MT5 profit data received - profit may be stale`);
              await supabaseAdmin.from("trades").update({
                status: "closed", close_time: new Date().toISOString(), close_reason: "unknown"
              }).eq("id", trade.id);
            }
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

    // NEW (Roadmap Phase 4, POI notifier): runs BEFORE generateSignalFromOHLCV
    // deliberately — that function has several early-exit gates (kill zone,
    // session trade cap, duplicate-signal window, news blackout) that are
    // all specific to deciding whether to open a NEW trade. None of those
    // are a reason to stop watching whether price has touched a zone
    // someone's already tracking, so zone detection/touch-checking runs
    // unconditionally on every OHLCV push instead of living inside that
    // function. Best-effort — never throws, never blocks signal generation.
    await updatePOIZones(symbol, data);

    // FIX (Oct 4 audit): spread was received here and logged, then
    // discarded — generateSignalFromOHLCV never saw it, so the dynamic
    // spread check it now performs (see signalEngine.js) needs it passed
    // through explicitly.
    const signal = await signalEngine.generateSignalFromOHLCV(symbol, data, spread);
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

        // FIX (confirmed via real log evidence): a bridge restart/reconnect
        // found 3 still-valid, non-expired MARKET signals queued from
        // earlier and fired all 3 in a 7-second burst - the broad 2-hour
        // expires_at ceiling (designed for PENDING/LIMIT orders, which
        // separately get a price-drift staleness check in bridge.py) is
        // far too long for a MARKET order, which represents "enter now".
        // If the bridge was offline and a MARKET signal has been sitting
        // for more than 20 minutes, the conditions that justified it may
        // no longer hold - skip it and close it out (not just re-check it
        // every ~10s poll for up to 2 hours until the broad expiry finally
        // catches up).
        const orderType = signal.order_type || "MARKET";
        if (orderType === "MARKET") {
          const ageMinutes = (Date.now() - new Date(signal.created_at).getTime()) / 60000;
          if (ageMinutes > 20) {
            await supabaseAdmin.from("signals").update({ status: "expired" }).eq("id", signal.id);
            await log("info", "bridge", `${signal.symbol}: MARKET signal ${signal.id.slice(0,8)} is ${ageMinutes.toFixed(0)}min old — too stale for a market order, expiring`);
            continue;
          }
        }

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
            .from("trades").select("id, symbol, direction, open_price, stop_loss, profit")
            .eq("account_id", account.id).eq("status", "open");

          const openCount = openTrades?.length || 0;
          if (openCount >= settings.maxConcurrentTrades) {
            await log("info", "bridge",
              `Max concurrent trades reached: ${openCount}/${settings.maxConcurrentTrades} — skipping ${signal.symbol}`
            );
            continue;
          }

          // ── Per-pair open position cap ────────────────────────────────────────
          // Max 3 open trades per symbol — prevents overexposure on single instrument
          // (e.g. 4x US30 BUY simultaneously averaging down on a losing move)
          const openForPair = (openTrades || []).filter(t => t.symbol === signal.symbol).length;
          const pairSettings = await supabaseAdmin
            .from("platform_settings").select("value")
            .eq("key", "max_open_per_pair").single();
          const MAX_OPEN_PER_PAIR = parseInt(pairSettings?.data?.value) || 3;
          if (openForPair >= MAX_OPEN_PER_PAIR) {
            await log("info", "bridge",
              `${signal.symbol}: ${openForPair}/${MAX_OPEN_PER_PAIR} open trades — skipping`
            );
            continue;
          }

          // ── Pyramiding gate (see services/pyramiding.js for the evidence) ─────
          // The first trade on a pair/direction always passes. Extra ones only
          // when A-grade, every existing one is in profit with its stop at
          // break-even, and price has moved to a new level. Also blocks a
          // signal re-firing while its first trade is still being filled.
          const sameDirOpen = (openTrades || []).filter(
            t => t.symbol === signal.symbol && t.direction === signal.direction);
          const inflight = commands.filter(c =>
            c.type === "EXECUTE_TRADE" && c.account_id === account.id &&
            c.order?.symbol === signal.symbol && c.order?.direction === signal.direction).length;
          const pyr = checkPyramiding({ signal, existingSameDir: sameDirOpen, inflightCount: inflight });
          if (!pyr.allowed) {
            await log("info", "bridge", `${signal.symbol}: pyramiding gate - ${pyr.reason}`);
            continue;
          }

          // ── Fix 5: Per-pair max trades/day and daily drawdown (pair_controls) ─
          const cbCheck = await checkCircuitBreaker(account.id, signal.symbol);
          if (!cbCheck.allowed) {
            await log("info", "bridge", `Circuit breaker / pair limit: ${cbCheck.reason}`);
            continue;
          }

          // ── Account-level consecutive-loss protection (new — see riskEngine.js) ─
          // Catches a losing streak spread across DIFFERENT pairs, which
          // neither checkCircuitBreaker's per-pair halt nor its %-based
          // daily/weekly/monthly limits see.
          const streakCheck = await checkConsecutiveLossProtection(account.id);
          if (!streakCheck.allowed) {
            await log("info", "bridge", `Account ${account.id}: ${streakCheck.reason}`);
            continue;
          }

          // ── Correlation gate (newly wired — see import comment above) ─────────
          const corrCheck = await checkCorrelation(signal.symbol, account.id);
          if (!corrCheck.allowed) {
            await log("info", "bridge", `${signal.symbol}: Correlation gate — ${corrCheck.reason}`);
            continue;
          }

          // ── Currency net-exposure clamp (newly wired — see import comment above) ─
          const exposureCheck = await checkCurrencyExposure(
            signal.symbol, signal.direction, account.id, account.balance || 500
          );
          if (!exposureCheck.allowed) {
            await log("info", "bridge", `${signal.symbol}: Currency exposure — ${exposureCheck.reason}`);
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
          // FIX: confluence grade was never passed here, so calculatePositionSize
          // silently defaulted every signal to grade "B" (1.0x multiplier) —
          // A-grade and D-grade setups were sized identically in live trading.
          const signalGrade = signal.regime_detail?.confluence_grade || "B";

          // FIX (Oct 4 audit): getEquityCurveMultiplier() was fully
          // implemented and exported but never called anywhere — flagged
          // as unverified in the diagnostic report's Section 8, confirmed
          // dormant here. It scales risk down after a recent equity
          // drawdown (and slightly up after a genuine winning run), which
          // is exactly the account-level protection this gate sequence is
          // otherwise missing between trades rather than within one.
          const equityCurveMultiplier = await getEquityCurveMultiplier(account.id);

          // Use default_risk_percent from platform_settings
          const sizing = calculatePositionSize({
            balance: account.balance || 500,
            riskPercent: settings.defaultRiskPercent * positionSizeModifier * equityCurveMultiplier,
            stopLossPips: Math.max(stopPips, 5),
            symbol: signal.symbol,
            signalGrade
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
      // FIX: signalId was already being parsed above (line ~319) and even
      // used below to update the signals table status - it was just never
      // actually included in this insert. This is why signal_id has been
      // null on every single trade (confirmed: 0 of 740 had it populated).
      // Fixing this is what makes grade-based analytics on closed/open
      // trades possible going forward - it doesn't change any trading
      // logic, purely a data-completeness fix.
      // FIX: this used to unconditionally INSERT a new row every time this
      // handler fired, with no check for an existing row - unlike the sync
      // logic above (lines 91-107) which correctly checks by ticket first.
      // Confirmed live: pending orders (GBPJPY BUY_LIMIT etc) get an initial
      // row inserted here with placeholder data (open_price=0), then when
      // the order actually fills and this handler fires again for the same
      // ticket, it inserted a SECOND row instead of updating the first -
      // leaving an orphaned garbage row (open_price=0, profit=null) behind
      // every time. Now checks for an existing row by ticket+account first,
      // matching the same safe pattern already used in the sync path.
      // (Same .single() duplicate trap as the sync path - see the note
      // there. Array + first match instead.)
      const { data: existingTradeRows } = await supabaseAdmin.from("trades")
        .select("id, open_price").eq("account_id", accountId).eq("ticket", result.ticket).limit(1);
      const existingTrade = existingTradeRows?.[0];

      if (existingTrade) {
        // FIX (real data gap confirmed - several live trades showed
        // open_price=null despite having real profit/close data): this
        // used to unconditionally write open_price: result.price on every
        // update, even when result.price was null/0 (e.g. an ack for a
        // pending limit order before it has actually filled). If that
        // happened after a prior call had already recorded the real fill
        // price, it would silently overwrite a correct value with a
        // missing one. Now only overwrites when result.price is actually
        // present, otherwise keeps whatever was already recorded.
        await supabaseAdmin.from("trades").update({
          signal_id: signalId || null,
          symbol: result.order?.symbol,
          direction: result.order?.direction,
          volume: result.volume || result.order?.volume,
          open_price: result.price || existingTrade.open_price,
          stop_loss: result.order?.stop_loss,
          take_profit: result.order?.take_profit,
          status: "open",
        }).eq("id", existingTrade.id);
      } else {
        await supabaseAdmin.from("trades").insert({
          account_id: accountId,
          ticket: result.ticket,
          signal_id: signalId || null,
          symbol: result.order?.symbol,
          direction: result.order?.direction,
          volume: result.volume || result.order?.volume,
          open_price: result.price,
          stop_loss: result.order?.stop_loss,
          take_profit: result.order?.take_profit,
          status: "open",
          open_time: new Date().toISOString()
        });
      }

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
    // FIX: this used to unconditionally revert status back to "pending" on
    // ANY failure - but bridge.py maintains its OWN permanent blacklist
    // once a signal hits its local max-attempts limit, and this code had
    // no awareness of that. Result: backend keeps reviving a signal
    // bridge.py has already permanently given up on, resending it every
    // poll cycle, bridge rejects it again, backend revives it again -
    // looping for hours until expires_at finally passes (confirmed live:
    // same 3 signal_ids retried continuously for 5+ hours on 2026-07-09).
    // Now recognizes bridge's own blacklist message and marks the signal
    // permanently expired instead of reviving it - other failure types
    // (network hiccup, temporary MT5 issue) still get the retry-via-
    // pending behavior, since that's legitimately useful for those.
    try {
      const withoutPrefix = id.substring(4);
      const signalId = withoutPrefix.substring(0, withoutPrefix.length - 37);
      if (signalId) {
        const isPermanentlyDead = (result.error || "").includes("blacklisted");
        await supabaseAdmin.from("signals")
          .update({ status: isPermanentlyDead ? "expired" : "pending" })
          .eq("id", signalId);
        if (isPermanentlyDead) {
          await log("info", "bridge", `${id}: bridge blacklisted this signal - marking expired instead of retrying`);
        }
      }
    } catch (e) {}
  }

  res.json({ ok: true });
});

// POST /api/bridge/reconcile — used by python-bridge/reconcile_history.py.
// Receives trades rebuilt from MT5's own deal history and makes the database
// match: updates the existing row (keeping its signal link and SL/TP), inserts
// trades the database never recorded, and removes extra rows for a ticket.
router.post("/reconcile", async (req, res) => {
  const { account_id, trades } = req.body || {};
  if (!account_id || typeof account_id !== "string" || !Array.isArray(trades) || trades.length === 0 || trades.length > 500) {
    return res.status(400).json({ error: "account_id and 1-500 trades required" });
  }
  const out = { updated: 0, inserted: 0, duplicates_removed: 0, errors: 0 };
  const num = v => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v))) ? null : Number(v);
  try {
    for (const t of trades) {
      const ticket = num(t.ticket);
      if (ticket === null || t.status !== "closed" || !t.close_time) { out.errors++; continue; }
      const fields = {
        symbol: t.symbol, direction: t.direction, volume: num(t.volume),
        open_price: num(t.open_price), close_price: num(t.close_price),
        profit: num(t.profit), swap: num(t.swap), commission: num(t.commission),
        open_time: t.open_time, close_time: t.close_time,
        close_reason: t.close_reason || "unknown", status: "closed",
      };
      const { data: rows, error: selErr } = await supabaseAdmin.from("trades").select("id")
        .eq("account_id", account_id).eq("ticket", ticket);
      if (selErr) { out.errors++; continue; }
      if (rows && rows.length > 0) {
        const { error: upErr } = await supabaseAdmin.from("trades").update(fields).eq("id", rows[0].id);
        if (upErr) { out.errors++; continue; }
        out.updated++;
        for (const extra of rows.slice(1)) {
          const { error: delErr } = await supabaseAdmin.from("trades").delete().eq("id", extra.id);
          if (delErr) out.errors++; else out.duplicates_removed++;
        }
      } else {
        const { error: insErr } = await supabaseAdmin.from("trades").insert({ account_id, ticket, ...fields });
        if (insErr) { out.errors++; } else { out.inserted++; }
      }
    }
    await log("info", "bridge", `Reconcile ${account_id}: ${JSON.stringify(out)}`);
    res.json({ ok: true, ...out });
  } catch (e) {
    await log("error", "bridge", `Reconcile error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
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