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
const { checkClientRiskCircuitBreaker } = require("../services/clientRiskEngine");
const pesapal = require("../services/pesapal");

// ── Helpers ───────────────────────────────────────────────────────────────────

function generatePortalToken() {
  return crypto.randomBytes(32).toString("hex");
}

// ── Fee terms ─────────────────────────────────────────────────────────────────
// Two ways to charge a copy-trading client:
//   profit_split  performance_fee_pct % of each winning trade's profit is
//                 accrued into pending_fee when the trade closes.
//   fixed_fee     fixed_fee_amount is accrued into pending_fee once a month
//                 (billed in arrears: the first charge is one month after
//                 the client starts), regardless of trading results.
const FEE_MODELS = ["profit_split", "fixed_fee"];

function addMonths(isoDate, n) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}

// Validates whichever fee fields are present. Returns { terms } or { error }.
function parseFeeTerms(body) {
  const terms = {};
  if (body.fee_model !== undefined && body.fee_model !== null) {
    if (!FEE_MODELS.includes(body.fee_model)) return { error: "fee_model must be profit_split or fixed_fee" };
    terms.fee_model = body.fee_model;
  }
  if (body.performance_fee_pct !== undefined && body.performance_fee_pct !== null && body.performance_fee_pct !== "") {
    const n = Number(body.performance_fee_pct);
    if (!Number.isFinite(n) || n < 0 || n > 100) return { error: "Profit share must be between 0 and 100" };
    terms.performance_fee_pct = n;
  }
  if (body.fixed_fee_amount !== undefined && body.fixed_fee_amount !== null && body.fixed_fee_amount !== "") {
    const n = Number(body.fixed_fee_amount);
    if (!Number.isFinite(n) || n < 0) return { error: "Fixed fee must be zero or more" };
    terms.fixed_fee_amount = parseFloat(n.toFixed(2));
  }
  return { terms };
}

// Accrue the monthly fixed fee for every active fixed_fee client whose
// billing date has arrived. Safe to run as often as you like: each client's
// row is advanced with a compare-and-set on fixed_fee_next_due, so two runs
// (or two server instances) can never charge the same month twice.
async function accrueFixedFees(now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const { data: due, error } = await supabaseAdmin
    .from("client_accounts")
    .select("id, name, pending_fee, fixed_fee_amount, fixed_fee_next_due")
    .eq("fee_model", "fixed_fee")
    .eq("status", "active")
    .lte("fixed_fee_next_due", today);
  if (error) throw error;

  let charged = 0;
  for (const c of due || []) {
    let next = c.fixed_fee_next_due;
    let months = 0;
    while (next <= today && months < 12) { next = addMonths(next, 1); months++; }
    const add = parseFloat(((c.fixed_fee_amount || 0) * months).toFixed(2));
    const { data: updated, error: upErr } = await supabaseAdmin
      .from("client_accounts")
      .update({
        pending_fee: parseFloat(((c.pending_fee || 0) + add).toFixed(2)),
        fixed_fee_next_due: next,
        updated_at: new Date().toISOString(),
      })
      .eq("id", c.id)
      .eq("fixed_fee_next_due", c.fixed_fee_next_due)
      .select("id");
    if (upErr) { await log("error", "copyTrading", `Fixed fee accrual failed for ${c.name}: ${upErr.message}`); continue; }
    if (updated && updated.length) {
      charged++;
      await log("info", "copyTrading", `Fixed fee accrued: $${add.toFixed(2)} (${months} month${months > 1 ? "s" : ""}) for ${c.name}; next due ${next}`);
    }
  }
  return { checked: (due || []).length, charged };
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
      .select("id, name, email, phone, balance, equity, starting_balance, currency, copy_enabled, is_connected, last_sync, performance_fee_pct, fee_model, fixed_fee_amount, fixed_fee_next_due, pending_fee, high_water_mark, status, connection_type, lot_multiplier, risk_percent, portal_token, created_at")
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
      risk_percent = 1.0,
      connection_type = "credentials", notes
    } = req.body;

    if (!name || !email) return res.status(400).json({ error: "name and email required" });

    const { terms, error: feeError } = parseFeeTerms({
      fee_model: req.body.fee_model || "profit_split",
      performance_fee_pct: req.body.performance_fee_pct ?? 20,
      fixed_fee_amount: req.body.fixed_fee_amount ?? 0,
    });
    if (feeError) return res.status(400).json({ error: feeError });
    if (terms.fee_model === "fixed_fee" && !(terms.fixed_fee_amount > 0)) {
      return res.status(400).json({ error: "Enter the fixed monthly fee amount" });
    }
    const feeNextDue = terms.fee_model === "fixed_fee"
      ? addMonths(new Date().toISOString().slice(0, 10), 1)
      : null;

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
        currency, leverage, risk_percent,
        performance_fee_pct: terms.performance_fee_pct,
        fee_model: terms.fee_model,
        fixed_fee_amount: terms.fixed_fee_amount,
        fixed_fee_next_due: feeNextDue,
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

    // Fee terms: validate, and keep the fixed-fee billing date sensible.
    const feeFieldsSent = ["fee_model", "performance_fee_pct", "fixed_fee_amount"].some(k => req.body[k] !== undefined);
    const reactivating = updates.status === "active";
    if (feeFieldsSent || reactivating) {
      const { terms, error: feeError } = parseFeeTerms(req.body);
      if (feeError) return res.status(400).json({ error: feeError });
      Object.assign(updates, terms);
      const { data: cur } = await supabaseAdmin
        .from("client_accounts")
        .select("fee_model, fixed_fee_amount, fixed_fee_next_due")
        .eq("id", id).single();
      const model = terms.fee_model || cur?.fee_model || "profit_split";
      const amount = terms.fixed_fee_amount ?? cur?.fixed_fee_amount ?? 0;
      if (model === "fixed_fee") {
        if (!(amount > 0)) return res.status(400).json({ error: "Enter the fixed monthly fee amount" });
        const today = new Date().toISOString().slice(0, 10);
        // Newly switched to fixed fee, or coming back from suspension with a
        // stale date: start a fresh month so nobody is billed for time off.
        if (!cur?.fixed_fee_next_due || (reactivating && cur.fixed_fee_next_due <= today)) {
          updates.fixed_fee_next_due = addMonths(today, 1);
        }
      } else if (terms.fee_model === "profit_split") {
        updates.fixed_fee_next_due = null;
      }
    }
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
    // portal_token is returned so the admin UI can build the link from the
    // origin it is actually running on (portal_url depends on FRONTEND_URL).
    res.json({ ok: true, portal_url: portalUrl, portal_token: newToken });
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
// MANUAL / OFFLINE RECONCILIATION ONLY (cash, bank transfer, already paid some
// other way). Zeroes pending_fee immediately with no payment verification —
// kept as an admin override. For an actual Pesapal-collected payment, use
// POST /fees/invoice/:clientId below instead, which only clears pending_fee
// once Pesapal confirms the transaction (see onInvoicePaid in payments.js).
router.post("/fees/collect/:clientId", verifyToken, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { data: client } = await supabaseAdmin
      .from("client_accounts").select("pending_fee, name").eq("id", clientId).single();

    await supabaseAdmin
      .from("client_accounts")
      .update({ pending_fee: 0, updated_at: new Date().toISOString() })
      .eq("id", clientId);

    await log("info", "copyTrading", `Fee collected (manual): $${client?.pending_fee?.toFixed(2)} from ${client?.name}`);
    res.json({ ok: true, collected: client?.pending_fee });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/copy-trading/fees/invoice/:clientId — admin triggers a real
// Pesapal payment request for a copy-trading client's pending_fee.
// Roadmap Phase 3, item 17. Mirrors payments.js's POST /create (System A)
// but targets client_accounts instead of clients, writing an invoices row
// with client_account_id set (client_id left null — see
// supabase_migration_client_account_invoices.sql). pending_fee is NOT
// touched here — it's only decremented once Pesapal confirms payment,
// via onInvoicePaid() in payments.js (callback/IPN/check all reuse it).
router.post("/fees/invoice/:clientId", verifyToken, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { data: client, error: clientError } = await supabaseAdmin
      .from("client_accounts")
      .select("id, name, email, phone, pending_fee, currency, fee_model")
      .eq("id", clientId)
      .single();
    if (clientError || !client) return res.status(404).json({ error: "Client not found" });

    const amountDue = parseFloat((client.pending_fee || 0).toFixed(2));
    if (!amountDue || amountDue <= 0) {
      return res.status(400).json({ error: "No pending fee to invoice" });
    }

    const invoiceNumber = `AE-CT-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
    const { data: invoice, error } = await supabaseAdmin
      .from("invoices")
      .insert({
        invoice_number: invoiceNumber,
        client_account_id: client.id,
        amount_due: amountDue,
        currency: client.currency || "USD",
        status: "pending",
        notes: client.fee_model === "fixed_fee" ? "Copy-trading monthly fee" : "Copy-trading performance fee"
      })
      .select()
      .single();
    if (error) throw error;

    const order = await pesapal.submitOrder({
      invoiceId: invoice.id,
      amount: amountDue,
      currency: client.currency || "USD",
      description: `Aethelgard Copy-Trading ${client.fee_model === "fixed_fee" ? "Monthly Fee" : "Performance Fee"} — ${client.name}`,
      clientName: client.name,
      clientEmail: client.email,
      clientPhone: client.phone
    });

    await supabaseAdmin
      .from("invoices")
      .update({
        pesapal_tracking_id: order.order_tracking_id,
        payment_url: order.redirect_url
      })
      .eq("id", invoice.id);

    await log("info", "copyTrading", `Fee invoice created: ${invoiceNumber} | $${amountDue} for ${client.name}`);

    res.json({
      invoice: { ...invoice, pesapal_tracking_id: order.order_tracking_id },
      payment_url: order.redirect_url
    });
  } catch (e) {
    await log("error", "copyTrading", `Fee invoice failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/copy-trading/portal/fee-invoices — client sees their own fee
// invoices + payment links (portal token, no admin auth).
router.get("/portal/fee-invoices", verifyPortalToken, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("invoices")
      .select("*")
      .eq("client_account_id", req.client.id)
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ invoices: data || [] });
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

// GET /api/copy-trading/bridge/client-sync-targets — everything the bridge
// needs to (1) keep each credential client's balance/equity current and
// (2) notice when a copied position has closed: login details plus that
// client's still-open trades. A client is included if copying is on OR they
// still have open trades (turning copying off must not strand open trades).
router.get("/bridge/client-sync-targets", verifyBridgeSecret, async (req, res) => {
  try {
    const { data: openTrades, error: tErr } = await supabaseAdmin
      .from("client_trades")
      .select("client_id, client_ticket, symbol, direction, open_price, stop_loss, take_profit")
      .eq("status", "open");
    if (tErr) throw tErr;

    const byClient = {};
    (openTrades || []).forEach(t => { (byClient[t.client_id] = byClient[t.client_id] || []).push(t); });

    const { data: clients, error: cErr } = await supabaseAdmin
      .from("client_accounts")
      .select("id, name, mt5_login, mt5_password, mt5_server, copy_enabled, connection_type, status")
      .eq("status", "active")
      .eq("connection_type", "credentials");
    if (cErr) throw cErr;

    const targets = (clients || [])
      .filter(c => c.mt5_login && c.mt5_password && (c.copy_enabled || byClient[c.id]))
      .map(c => ({
        client_id: c.id,
        client_name: c.name,
        mt5_login: c.mt5_login,
        mt5_password: decryptSecret(c.mt5_password),
        mt5_server: c.mt5_server,
        open_trades: byClient[c.id] || [],
      }));
    res.json({ targets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/copy-trading/bridge/close — bridge reports trade close
router.post("/bridge/close", verifyBridgeSecret, async (req, res) => {
  try {
    // close_reason ("tp" | "sl" | "stop_out" | "manual" | "unknown") and
    // close_time come from the bridge's reading of the client account's own
    // MT5 deal history (see reconcile_client_trades in bridge.py).
    const { client_ticket, close_price, profit, close_reason, close_time } = req.body;

    const { data: trade } = await supabaseAdmin
      .from("client_trades")
      .select("client_id, master_signal_id")
      .eq("client_ticket", client_ticket)
      .eq("status", "open")
      .single();

    if (!trade) return res.json({ ok: true, note: "Trade not found" });

    await supabaseAdmin.from("client_trades")
      .update({
        close_price, profit, status: "closed",
        close_reason: close_reason || "unknown",
        close_time: close_time || new Date().toISOString(),
      })
      .eq("client_ticket", client_ticket);

    // Update daily P&L
    const today = new Date().toISOString().slice(0, 10);
    const { data: client } = await supabaseAdmin
      .from("client_accounts")
      .select("performance_fee_pct, fee_model, pending_fee, high_water_mark, equity")
      .eq("id", trade.client_id)
      .single();

    const grossPnl = profit;
    // Profit split: a share of each winning trade. Fixed fee: nothing is taken
    // per trade (the monthly fee is accrued by accrueFixedFees instead).
    // Note: ?? not || — a 0% split is a valid arrangement, not "unset".
    const splitPct = client?.performance_fee_pct ?? 20;
    const fee = (client?.fee_model !== "fixed_fee" && profit > 0)
      ? parseFloat((profit * (splitPct / 100)).toFixed(2))
      : 0;
    const netPnl = grossPnl - fee;

    const { data: dayRecord } = await supabaseAdmin
      .from("client_daily_pnl")
      .select("gross_pnl, performance_fee, net_pnl, winning_trades, losing_trades")
      .eq("client_id", trade.client_id)
      .eq("date", today)
      .single();

    // BUG WAS: nothing ever created today's client_daily_pnl row except the
    // /bridge/sync call, and nothing calls that for credential clients — so
    // this UPDATE matched zero rows and every close's P&L, fee and win/loss
    // count was silently dropped. Create the row if it isn't there.
    if (!dayRecord) {
      await supabaseAdmin.from("client_daily_pnl").insert({
        client_id: trade.client_id, date: today,
        starting_equity: client?.equity ?? 0, ending_equity: client?.equity ?? 0,
        gross_pnl: 0, performance_fee: 0, net_pnl: 0,
        trades_count: 0, winning_trades: 0, losing_trades: 0,
      });
    }

    await supabaseAdmin.from("client_daily_pnl").update({
      gross_pnl: (dayRecord?.gross_pnl || 0) + grossPnl,
      performance_fee: (dayRecord?.performance_fee || 0) + fee,
      net_pnl: (dayRecord?.net_pnl || 0) + netPnl,
      winning_trades: (dayRecord?.winning_trades || 0) + (profit > 0 ? 1 : 0),
      losing_trades: (dayRecord?.losing_trades || 0) + (profit < 0 ? 1 : 0),
    }).eq("client_id", trade.client_id).eq("date", today);

    // Update pending fee and high water mark.
    // BUG WAS: pending_fee wasn't in the select above, so (client.pending_fee || 0)
    // was always 0 and every winning trade OVERWROTE the balance owed with just
    // that one trade's fee instead of adding to it.
    if (profit > 0) {
      await supabaseAdmin.from("client_accounts").update({
        pending_fee: parseFloat(((client?.pending_fee || 0) + fee).toFixed(2)),
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
      .select("id, name, status, copy_enabled, balance, equity, starting_balance, risk_percent, lot_multiplier, mt5_login, mt5_password, mt5_server")
      .eq("status", "active")
      .eq("copy_enabled", true)
      .eq("is_connected", true)
      .eq("connection_type", "credentials");

    // NEW (Oct 4 — Roadmap Phase 2, "per-client risk circuit breakers"):
    // this used to hand every matching client straight to the bridge with
    // no risk check of its own — a client deep in a bad day got the same
    // next trade as a client having a great one. checkClientRiskCircuitBreaker
    // (clientRiskEngine.js) gates on that client's own daily loss %, trade
    // count, and losing streak before they're included below.
    const lotSizes = [];
    for (const client of (clients || [])) {
      const riskCheck = await checkClientRiskCircuitBreaker(client);
      if (!riskCheck.allowed) {
        await log("info", "copyTrading", `${client.name} (${client.id.slice(0,8)}): skipping copy — ${riskCheck.reason}`);
        continue;
      }
      lotSizes.push({
        client_id: client.id,
        client_name: client.name,
        mt5_login: client.mt5_login,
        // FIX: decrypt here — this is bridge-secret-protected and the
        // bridge needs the real password to place the copy trade.
        mt5_password: decryptSecret(client.mt5_password),
        mt5_server: client.mt5_server,
        lot_size: calculateClientLot(master_lot, client.balance, master_balance, client.risk_percent, 1.0),
      });
    }

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
      .select("date, gross_pnl, performance_fee, net_pnl, trades_count, winning_trades, losing_trades")
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
        fee_model: client.fee_model || "profit_split",
        fixed_fee_amount: client.fixed_fee_amount || 0,
        fixed_fee_next_due: client.fee_model === "fixed_fee" ? client.fixed_fee_next_due : null,
        pending_fee: client.pending_fee,
        last_sync: client.last_sync,
      },
      today: todayPnl || { gross_pnl: 0, net_pnl: 0, trades_count: 0, winning_trades: 0, losing_trades: 0 },
      history: history || [],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Portal data: what a client may see ──────────────────────────────────────
// Everything below is scoped to the token's own client (req.client.id) or is
// deliberately public-to-clients market output (signals, zones). Fields are
// WHITELISTED, never spread from the row, so a column added to a table later
// can't leak by accident. Never exposed here: the engine's reasoning/AI text,
// regime or decision-engine tags, confluence scores, other clients, the
// master account, pair halts or risk settings, credentials, tokens.

// GET /api/copy-trading/portal/trades — the client's own trades, open and closed
router.get("/portal/trades", verifyPortalToken, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("client_trades")
      .select("id, symbol, direction, lot_size, open_price, stop_loss, take_profit, close_price, profit, status, close_reason, open_time, close_time")
      .eq("client_id", req.client.id)
      .order("open_time", { ascending: false })
      .limit(300);
    if (error) throw error;

    res.json({
      trades: (data || []).map(t => ({
        id: t.id, symbol: t.symbol, direction: t.direction, lot_size: t.lot_size,
        open_price: t.open_price, stop_loss: t.stop_loss, take_profit: t.take_profit,
        close_price: t.close_price, profit: t.profit, status: t.status,
        close_reason: t.close_reason || null,
        open_time: t.open_time, close_time: t.close_time,
      }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/copy-trading/portal/signals — recent engine signals, plus whether
// THIS client's account took each one and how that trade ended.
router.get("/portal/signals", verifyPortalToken, async (req, res) => {
  try {
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data: sigs, error } = await supabaseAdmin
      .from("signals")
      .select("id, symbol, direction, entry_price, stop_loss, take_profit, order_type, regime_detail, status, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(60);
    if (error) throw error;

    const ids = (sigs || []).map(x => x.id);
    const mine = {};
    if (ids.length) {
      const { data: ct } = await supabaseAdmin
        .from("client_trades")
        .select("master_signal_id, status, profit, close_reason")
        .eq("client_id", req.client.id)
        .in("master_signal_id", ids);
      (ct || []).forEach(t => { mine[t.master_signal_id] = t; });
    }

    res.json({
      signals: (sigs || []).map(x => {
        const t = mine[x.id];
        return {
          id: x.id, symbol: x.symbol, direction: x.direction,
          entry_price: x.entry_price, stop_loss: x.stop_loss, take_profit: x.take_profit,
          order_type: x.order_type || "MARKET",
          // Grade only — the numeric score and the reasoning stay private.
          grade: x.regime_detail?.confluence_grade || null,
          status: x.status, created_at: x.created_at,
          taken: !!t,
          outcome: t ? (t.status === "open" ? "open" : (t.close_reason || "closed")) : null,
          result_pnl: t && t.status === "closed" ? t.profit : null,
        };
      })
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/copy-trading/portal/zones — points of interest the engine is
// watching (order blocks / fair value gaps), and ones price touched recently.
router.get("/portal/zones", verifyPortalToken, async (req, res) => {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const cols = "id, symbol, timeframe, zone_type, zone_high, zone_low, status, detected_at, touched_at";
    const [activeQ, touchedQ] = await Promise.all([
      supabaseAdmin.from("poi_zones").select(cols).eq("status", "active")
        .order("detected_at", { ascending: false }).limit(60),
      supabaseAdmin.from("poi_zones").select(cols).eq("status", "touched").gte("touched_at", since)
        .order("touched_at", { ascending: false }).limit(40),
    ]);
    if (activeQ.error) throw activeQ.error;
    if (touchedQ.error) throw touchedQ.error;
    const data = [...(activeQ.data || []), ...(touchedQ.data || [])];
    res.json({
      zones: (data || []).map(z => ({
        id: z.id, symbol: z.symbol, timeframe: z.timeframe, zone_type: z.zone_type,
        zone_high: z.zone_high, zone_low: z.zone_low, status: z.status,
        detected_at: z.detected_at, touched_at: z.touched_at,
      }))
    });
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
module.exports.accrueFixedFees = accrueFixedFees;
