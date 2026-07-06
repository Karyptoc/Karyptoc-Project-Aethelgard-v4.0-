/**
 * AETHELGARD - Copy Trading Routes
 * backend/src/routes/copyTrading.js
 *
 * Admin endpoints: manage clients, view all P&L
 * Client endpoints: view own P&L, trades, account (via portal token)
 * Bridge endpoint: execute copy trades on client accounts
 */

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { supabaseAdmin, log } = require("../services/supabase");
const { verifyToken } = require("../middleware/auth");
const { encryptSecret, decryptSecret } = require("../services/crypto");

// ── Helpers ───────────────────────────────────────────────────────────────────

function generatePortalToken() {
  return crypto.randomBytes(32).toString("hex");
}

// Calculate lot size for client based on their balance vs master balance
function calculateClientLot(masterLot, clientBalance, masterBalance, clientRiskPct = 1.0, masterRiskPct = 1.0) {
  if (!clientBalance || !masterBalance || masterBalance <= 0) return 0.01;
  const balanceRatio = clientBalance / masterBalance;
  const riskRatio = clientRiskPct / masterRiskPct;
  const scaledLot = masterLot * balanceRatio * riskRatio;
  return Math.max(0.01, parseFloat(scaledLot.toFixed(2)));
}

// ── Middleware: verify bridge secret ─────────────────────────────────────────
function verifyBridgeSecret(req, res, next) {
  const secret = req.headers["x-bridge-secret"];
  if (!secret || secret !== process.env.BRIDGE_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ── Middleware: verify client portal token ────────────────────────────────────
async function verifyPortalToken(req, res, next) {
  const token = req.headers["x-portal-token"] || req.query.token;
  if (!token) return res.status(401).json({ error: "Portal token required" });

  const { data: client } = await supabaseAdmin
    .from("client_accounts")
    .select("*")
    .eq("portal_token", token)
    .eq("status", "active")
    .single();

  if (!client) return res.status(401).json({ error: "Invalid or expired token" });
  req.client = client;
  next();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES (requires admin auth)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/copy-trading/clients — list all clients
router.get("/clients", verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("client_accounts")
      .select("id, name, email, phone, balance, equity, starting_balance, currency, copy_enabled, is_connected, last_sync, performance_fee_pct, pending_fee, high_water_mark, status, connection_type, lot_multiplier, risk_percent, created_at")
      .order("created_at", { ascending: false });
    if (error) throw error;

    // Enrich with today's P&L
    const today = new Date().toISOString().slice(0, 10);
    const { data: todayPnl } = await supabaseAdmin
      .from("client_daily_pnl")
      .select("*")
      .eq("date", today);

    const pnlMap = {};
    (todayPnl || []).forEach(p => { pnlMap[p.client_id] = p; });

    const enriched = (data || []).map(c => ({
      ...c,
      today_pnl: pnlMap[c.id]?.net_pnl || 0,
      today_trades: pnlMap[c.id]?.trades_count || 0,
      total_pnl: c.equity - c.starting_balance,
    }));

    res.json({ clients: enriched });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/copy-trading/clients — add new client
router.post("/clients", verifyToken, async (req, res) => {
  try {
    const {
      name, email, phone, mt5_login, mt5_password, mt5_server,
      starting_balance, currency = "USD", leverage = 100,
      risk_percent = 1.0, performance_fee_pct = 20.0,
      connection_type = "credentials", notes
    } = req.body;

    if (!name || !email) return res.status(400).json({ error: "name and email required" });

    const portalToken = generatePortalToken();
    const portalUrl = `${process.env.FRONTEND_URL}/client-portal?token=${portalToken}`;

    // FIX: mt5_password was stored in plaintext. Encrypted at rest now —
    // see services/crypto.js. Decrypted only where the bridge needs the
    // actual password to log into MT5 (bridge/accounts, bridge/lot-sizes).
    const { data, error } = await supabaseAdmin
      .from("client_accounts")
      .insert({
        name, email, phone,
        mt5_login, mt5_password: encryptSecret(mt5_password), mt5_server,
        starting_balance: starting_balance || 0,
        balance: starting_balance || 0,
        equity: starting_balance || 0,
        high_water_mark: starting_balance || 0,
        currency, leverage, risk_percent, performance_fee_pct,
        connection_type, notes,
        portal_token: portalToken,
        status: "active"
      })
      .select()
      .single();

    if (error) throw error;
    if (data) delete data.mt5_password; // never echo even the encrypted form back to the admin UI

    await log("info", "copyTrading", `New client added: ${name} (${email})`);
    res.json({ ok: true, client: data, portal_url: portalUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/copy-trading/clients/:id — update client
router.put("/clients/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body, updated_at: new Date().toISOString() };
    // Don't allow updating portal_token via this endpoint
    delete updates.portal_token;
    // FIX: encrypt mt5_password if this update is changing it
    if (updates.mt5_password) {
      updates.mt5_password = encryptSecret(updates.mt5_password);
    }

    const { data, error } = await supabaseAdmin
      .from("client_accounts")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    if (data) delete data.mt5_password;
    res.json({ ok: true, client: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/copy-trading/clients/:id — remove client (soft delete)
router.delete("/clients/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabaseAdmin
      .from("client_accounts")
      .update({ status: "suspended", copy_enabled: false, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
    await log("info", "copyTrading", `Client suspended: ${id}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/copy-trading/clients/:id/regenerate-token — new portal link
router.post("/clients/:id/regenerate-token", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const newToken = generatePortalToken();
    const { error } = await supabaseAdmin
      .from("client_accounts")
      .update({ portal_token: newToken, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
    const portalUrl = `${process.env.FRONTEND_URL}/client-portal?token=${newToken}`;
    res.json({ ok: true, portal_url: portalUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/copy-trading/clients/:id/trades — admin view of client trades
router.get("/clients/:id/trades", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from("client_trades")
      .select("*")
      .eq("client_id", id)
      .order("open_time", { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json({ trades: data || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/copy-trading/overview — admin overview of all clients
router.get("/overview", verifyToken, async (req, res) => {
  try {
    const { data: clients } = await supabaseAdmin
      .from("client_accounts")
      .select("id, name, balance, equity, starting_balance, is_connected, copy_enabled, status, pending_fee");

    const today = new Date().toISOString().slice(0, 10);
    const { data: todayPnl } = await supabaseAdmin
      .from("client_daily_pnl")
      .select("client_id, net_pnl, trades_count")
      .eq("date", today);

    const pnlMap = {};
    (todayPnl || []).forEach(p => { pnlMap[p.client_id] = p; });

    const totalAUM = (clients || []).reduce((s, c) => s + (c.equity || 0), 0);
    const totalTodayPnl = Object.values(pnlMap).reduce((s, p) => s + (p.net_pnl || 0), 0);
    const totalPendingFees = (clients || []).reduce((s, c) => s + (c.pending_fee || 0), 0);
    const connectedCount = (clients || []).filter(c => c.is_connected && c.copy_enabled).length;

    res.json({
      summary: {
        total_clients: (clients || []).length,
        active_clients: (clients || []).filter(c => c.status === "active").length,
        connected_clients: connectedCount,
        total_aum: parseFloat(totalAUM.toFixed(2)),
        today_pnl: parseFloat(totalTodayPnl.toFixed(2)),
        pending_fees: parseFloat(totalPendingFees.toFixed(2)),
      },
      clients: (clients || []).map(c => ({
        ...c,
        today_pnl: pnlMap[c.id]?.net_pnl || 0,
        today_trades: pnlMap[c.id]?.trades_count || 0,
        total_pnl: (c.equity || 0) - (c.starting_balance || 0),
      }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/copy-trading/fees/collect — mark fees as collected
router.post("/fees/collect/:clientId", verifyToken, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { data: client } = await supabaseAdmin
      .from("client_accounts").select("pending_fee, name").eq("id", clientId).single();

    await supabaseAdmin
      .from("client_accounts")
      .update({ pending_fee: 0, updated_at: new Date().toISOString() })
      .eq("id", clientId);

    await log("info", "copyTrading", `Fee collected: $${client?.pending_fee?.toFixed(2)} from ${client?.name}`);
    res.json({ ok: true, collected: client?.pending_fee });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BRIDGE ROUTES (copy trade execution from Python bridge)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/copy-trading/bridge/accounts — bridge gets all client credentials
router.get("/bridge/accounts", verifyBridgeSecret, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("client_accounts")
      .select("id, name, mt5_login, mt5_password, mt5_server, balance, risk_percent, lot_multiplier, copy_enabled, connection_type")
      .eq("status", "active")
      .eq("copy_enabled", true)
      .eq("connection_type", "credentials");
    if (error) throw error;
    // FIX: mt5_password is now encrypted at rest — decrypt here, since
    // this endpoint is bridge-secret-protected and the bridge genuinely
    // needs the plaintext password to call mt5.login(). This is the ONLY
    // place besides bridge/lot-sizes that should ever see plaintext.
    const accounts = (data || []).map(acc => ({
      ...acc,
      mt5_password: decryptSecret(acc.mt5_password),
    }));
    res.json({ accounts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/copy-trading/bridge/sync — bridge updates client account stats
router.post("/bridge/sync", verifyBridgeSecret, async (req, res) => {
  try {
    const { client_id, balance, equity, profit, is_connected } = req.body;

    await supabaseAdmin
      .from("client_accounts")
      .update({
        balance, equity, is_connected,
        last_sync: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq("id", client_id);

    // Update today's P&L record
    const today = new Date().toISOString().slice(0, 10);
    const { data: existing } = await supabaseAdmin
      .from("client_daily_pnl")
      .select("*")
      .eq("client_id", client_id)
      .eq("date", today)
      .single();

    if (!existing) {
      const { data: client } = await supabaseAdmin
        .from("client_accounts").select("starting_balance, performance_fee_pct").eq("id", client_id).single();
      await supabaseAdmin.from("client_daily_pnl").insert({
        client_id, date: today,
        starting_equity: equity,
        ending_equity: equity,
        gross_pnl: 0, performance_fee: 0, net_pnl: 0
      });
    } else {
      await supabaseAdmin.from("client_daily_pnl")
        .update({ ending_equity: equity })
        .eq("client_id", client_id)
        .eq("date", today);
    }

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/copy-trading/bridge/execute — bridge reports copy trade execution
router.post("/bridge/execute", verifyBridgeSecret, async (req, res) => {
  try {
    const {
      client_id, master_signal_id, master_ticket, client_ticket,
      symbol, direction, lot_size, open_price, stop_loss, take_profit
    } = req.body;

    await supabaseAdmin.from("client_trades").insert({
      client_id, master_signal_id, master_ticket, client_ticket,
      symbol, direction, lot_size, open_price, stop_loss, take_profit,
      status: "open", open_time: new Date().toISOString()
    });

    // Update daily trade count
    const today = new Date().toISOString().slice(0, 10);
    await supabaseAdmin.from("client_daily_pnl")
      .update({ trades_count: supabaseAdmin.rpc("increment", { x: 1 }) })
      .eq("client_id", client_id)
      .eq("date", today);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/copy-trading/bridge/close — bridge reports trade close
router.post("/bridge/close", verifyBridgeSecret, async (req, res) => {
  try {
    const { client_ticket, close_price, profit } = req.body;

    const { data: trade } = await supabaseAdmin
      .from("client_trades")
      .select("client_id, master_signal_id")
      .eq("client_ticket", client_ticket)
      .eq("status", "open")
      .single();

    if (!trade) return res.json({ ok: true, note: "Trade not found" });

    await supabaseAdmin.from("client_trades")
      .update({ close_price, profit, status: "closed", close_time: new Date().toISOString() })
      .eq("client_ticket", client_ticket);

    // Update daily P&L
    const today = new Date().toISOString().slice(0, 10);
    const { data: client } = await supabaseAdmin
      .from("client_accounts")
      .select("performance_fee_pct, high_water_mark, equity")
      .eq("id", trade.client_id)
      .single();

    const grossPnl = profit;
    const fee = profit > 0 ? profit * ((client?.performance_fee_pct || 20) / 100) : 0;
    const netPnl = grossPnl - fee;

    const { data: dayRecord } = await supabaseAdmin
      .from("client_daily_pnl")
      .select("gross_pnl, performance_fee, net_pnl, winning_trades, losing_trades")
      .eq("client_id", trade.client_id)
      .eq("date", today)
      .single();

    await supabaseAdmin.from("client_daily_pnl").update({
      gross_pnl: (dayRecord?.gross_pnl || 0) + grossPnl,
      performance_fee: (dayRecord?.performance_fee || 0) + fee,
      net_pnl: (dayRecord?.net_pnl || 0) + netPnl,
      winning_trades: (dayRecord?.winning_trades || 0) + (profit > 0 ? 1 : 0),
      losing_trades: (dayRecord?.losing_trades || 0) + (profit < 0 ? 1 : 0),
    }).eq("client_id", trade.client_id).eq("date", today);

    // Update pending fee and high water mark
    if (profit > 0) {
      await supabaseAdmin.from("client_accounts").update({
        pending_fee: (client?.pending_fee || 0) + fee,
        high_water_mark: Math.max(client?.high_water_mark || 0, client?.equity || 0),
        updated_at: new Date().toISOString()
      }).eq("id", trade.client_id);
    }

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/copy-trading/bridge/lot-sizes — get scaled lot sizes for a signal
router.post("/bridge/lot-sizes", verifyBridgeSecret, async (req, res) => {
  try {
    const { signal_id, master_lot, master_balance } = req.body;

    const { data: clients } = await supabaseAdmin
      .from("client_accounts")
      .select("id, name, balance, risk_percent, lot_multiplier, mt5_login, mt5_password, mt5_server")
      .eq("status", "active")
      .eq("copy_enabled", true)
      .eq("is_connected", true)
      .eq("connection_type", "credentials");

    const lotSizes = (clients || []).map(client => ({
      client_id: client.id,
      client_name: client.name,
      mt5_login: client.mt5_login,
      // FIX: decrypt here — this is bridge-secret-protected and the
      // bridge needs the real password to place the copy trade.
      mt5_password: decryptSecret(client.mt5_password),
      mt5_server: client.mt5_server,
      lot_size: calculateClientLot(master_lot, client.balance, master_balance, client.risk_percent, 1.0),
    }));

    res.json({ lot_sizes: lotSizes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLIENT PORTAL ROUTES (via portal token — no admin auth required)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/copy-trading/portal/me — client gets their own data
router.get("/portal/me", verifyPortalToken, async (req, res) => {
  try {
    const client = req.client;
    const today = new Date().toISOString().slice(0, 10);

    // Today's P&L
    const { data: todayPnl } = await supabaseAdmin
      .from("client_daily_pnl")
      .select("*")
      .eq("client_id", client.id)
      .eq("date", today)
      .single();

    // Last 30 days P&L history
    const thirtyDaysAgo = new Date(Date.now() - 30*24*60*60*1000).toISOString().slice(0,10);
    const { data: history } = await supabaseAdmin
      .from("client_daily_pnl")
      .select("date, net_pnl, trades_count, winning_trades, losing_trades")
      .eq("client_id", client.id)
      .gte("date", thirtyDaysAgo)
      .order("date", { ascending: true });

    res.json({
      account: {
        name: client.name,
        balance: client.balance,
        equity: client.equity,
        starting_balance: client.starting_balance,
        total_pnl: (client.equity || 0) - (client.starting_balance || 0),
        total_return_pct: client.starting_balance > 0
          ? parseFloat((((client.equity - client.starting_balance) / client.starting_balance) * 100).toFixed(2))
          : 0,
        currency: client.currency,
        is_connected: client.is_connected,
        copy_enabled: client.copy_enabled,
        performance_fee_pct: client.performance_fee_pct,
        pending_fee: client.pending_fee,
        last_sync: client.last_sync,
      },
      today: todayPnl || { gross_pnl: 0, net_pnl: 0, trades_count: 0, winning_trades: 0, losing_trades: 0 },
      history: history || [],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/copy-trading/portal/trades — client sees their trades (partial view)
router.get("/portal/trades", verifyPortalToken, async (req, res) => {
  try {
    const client = req.client;
    const { data, error } = await supabaseAdmin
      .from("client_trades")
      .select("id, symbol, direction, lot_size, profit, status, open_time, close_time")
      .eq("client_id", client.id)
      .order("open_time", { ascending: false })
      .limit(50);

    if (error) throw error;

    // Partial view: show symbol and direction but not exact prices
    const partialTrades = (data || []).map(t => ({
      id: t.id,
      symbol: t.symbol,
      direction: t.direction,
      lot_size: t.lot_size,
      profit: t.profit,
      status: t.status,
      open_time: t.open_time,
      close_time: t.close_time,
      // prices hidden from client portal
    }));

    res.json({ trades: partialTrades });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/copy-trading/portal/connect-mt5 — client submits MT5 credentials
router.post("/portal/connect-mt5", verifyPortalToken, async (req, res) => {
  try {
    const client = req.client;
    const { mt5_login, mt5_password, mt5_server } = req.body;

    if (!mt5_login || !mt5_password || !mt5_server) {
      return res.status(400).json({ error: "MT5 login, password and server required" });
    }

    await supabaseAdmin.from("client_accounts").update({
      mt5_login, mt5_password: encryptSecret(mt5_password), mt5_server,
      connection_type: "credentials",
      updated_at: new Date().toISOString()
    }).eq("id", client.id);

    await log("info", "copyTrading", `Client ${client.name} submitted MT5 credentials`);
    res.json({ ok: true, message: "MT5 credentials saved. Bridge will connect on next cycle." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/copy-trading/portal/bridge-script — download bridge script for client
router.get("/portal/bridge-script", verifyPortalToken, async (req, res) => {
  try {
    const client = req.client;
    const script = generateClientBridgeScript(client.id, client.portal_token);
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Content-Disposition", `attachment; filename="aethelgard_bridge_${client.name.replace(/\s/g,'_')}.py"`);
    res.send(script);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function generateClientBridgeScript(clientId, portalToken) {
  return `"""
Aethelgard Copy Trading Bridge
Client ID: ${clientId}
Run this on your Windows PC with MT5 open.
Requirements: pip install MetaTrader5 requests python-dotenv
"""

import MetaTrader5 as mt5
import requests
import time
import os

BACKEND_URL = "${process.env.BACKEND_URL || 'https://aethelgard-backend-uff7.onrender.com'}"
CLIENT_ID   = "${clientId}"
PORTAL_TOKEN = "${portalToken}"

headers = {"x-portal-token": PORTAL_TOKEN, "Content-Type": "application/json"}

MT5_LOGIN    = int(input("Enter your MT5 login: "))
MT5_PASSWORD = input("Enter your MT5 password: ")
MT5_SERVER   = input("Enter your MT5 server: ")

if not mt5.initialize(login=MT5_LOGIN, password=MT5_PASSWORD, server=MT5_SERVER):
    print("MT5 connection failed:", mt5.last_error())
    exit()

print("Connected to MT5. Registering with Aethelgard...")

r = requests.post(f"{BACKEND_URL}/api/copy-trading/portal/connect-mt5",
    headers=headers,
    json={"mt5_login": str(MT5_LOGIN), "mt5_password": MT5_PASSWORD, "mt5_server": MT5_SERVER})
print("Registered:", r.json())

print("Bridge running. Keep this window open.")
while True:
    info = mt5.account_info()
    if info:
        requests.post(f"{BACKEND_URL}/api/copy-trading/bridge/sync",
            headers={"x-bridge-secret": "client_bridge", "Content-Type": "application/json"},
            json={"client_id": CLIENT_ID, "balance": info.balance,
                  "equity": info.equity, "profit": info.profit, "is_connected": True})
    time.sleep(30)
`;
}

module.exports = router;
module.exports.calculateClientLot = calculateClientLot;
