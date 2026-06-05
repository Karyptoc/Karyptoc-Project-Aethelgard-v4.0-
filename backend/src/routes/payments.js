/**
 * AETHELGARD - Payments & Invoices Routes
 * Profit split billing via Pesapal (M-Pesa + Cards)
 */

const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const { supabaseAdmin, log } = require("../services/supabase");
const pesapal = require("../services/pesapal");
const { verifyToken } = require("../middleware/auth");

// ── Admin Routes (protected) ──────────────────────────────────────────────────

// GET all invoices
router.get("/", verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("invoices")
      .select("*, clients(full_name, email, phone)")
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ invoices: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET invoices for a specific client
router.get("/client/:clientId", verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("invoices")
      .select("*")
      .eq("client_id", req.params.clientId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ invoices: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST create invoice (admin creates profit split invoice)
router.post("/create", verifyToken, async (req, res) => {
  const {
    client_id,
    period_start,
    period_end,
    gross_profit,
    split_percent,
    currency = "KES",
    notes
  } = req.body;

  try {
    // Get client details
    const { data: client, error: clientError } = await supabaseAdmin
      .from("clients")
      .select("*")
      .eq("id", client_id)
      .single();
    if (clientError || !client) throw new Error("Client not found");

    // Calculate split amount
    const splitAmount = parseFloat(((gross_profit * split_percent) / 100).toFixed(2));

    // Create invoice record
    const invoiceId = `AE-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
    const { data: invoice, error } = await supabaseAdmin
      .from("invoices")
      .insert({
        invoice_number: invoiceId,
        client_id,
        period_start,
        period_end,
        gross_profit: parseFloat(gross_profit),
        split_percent: parseFloat(split_percent),
        amount_due: splitAmount,
        currency,
        status: "pending",
        notes
      })
      .select()
      .single();
    if (error) throw error;

    // Submit to Pesapal
    const order = await pesapal.submitOrder({
      invoiceId: invoice.id,
      amount: splitAmount,
      currency,
      description: `Aethelgard Profit Split - ${period_start} to ${period_end}`,
      clientName: client.full_name,
      clientEmail: client.email,
      clientPhone: client.phone
    });

    // Update invoice with Pesapal tracking ID and payment URL
    await supabaseAdmin
      .from("invoices")
      .update({
        pesapal_tracking_id: order.order_tracking_id,
        payment_url: order.redirect_url
      })
      .eq("id", invoice.id);

    await log("info", "payments", `Invoice created: ${invoiceId} | ${splitAmount} ${currency} for ${client.full_name}`);

    res.json({
      invoice: { ...invoice, pesapal_tracking_id: order.order_tracking_id },
      payment_url: order.redirect_url
    });
  } catch (e) {
    await log("error", "payments", `Create invoice failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// POST check payment status
router.post("/check/:invoiceId", verifyToken, async (req, res) => {
  try {
    const { data: invoice } = await supabaseAdmin
      .from("invoices")
      .select("*")
      .eq("id", req.params.invoiceId)
      .single();

    if (!invoice?.pesapal_tracking_id) {
      return res.status(404).json({ error: "Invoice not found or no tracking ID" });
    }

    const status = await pesapal.getTransactionStatus(invoice.pesapal_tracking_id);

    // Update invoice status if paid
    if (status.payment_status_description === "Completed") {
      await supabaseAdmin
        .from("invoices")
        .update({
          status: "paid",
          paid_at: new Date().toISOString(),
          payment_method: status.payment_method || "mpesa"
        })
        .eq("id", req.params.invoiceId);
    }

    res.json({ status, invoice });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE cancel invoice
router.delete("/:invoiceId", verifyToken, async (req, res) => {
  try {
    await supabaseAdmin
      .from("invoices")
      .update({ status: "cancelled" })
      .eq("id", req.params.invoiceId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Pesapal Webhooks (public) ─────────────────────────────────────────────────

// GET payment callback (user redirected here after payment)
router.get("/callback", async (req, res) => {
  const { invoice_id, OrderTrackingId, OrderMerchantReference } = req.query;

  try {
    if (OrderTrackingId) {
      const status = await pesapal.getTransactionStatus(OrderTrackingId);

      if (status.payment_status_description === "Completed") {
        await supabaseAdmin
          .from("invoices")
          .update({
            status: "paid",
            paid_at: new Date().toISOString(),
            pesapal_tracking_id: OrderTrackingId
          })
          .eq("id", invoice_id);

        await log("info", "payments", `Payment confirmed: ${OrderTrackingId}`);
      }
    }

    // Redirect to client portal
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    res.redirect(`${frontendUrl}/client/payment-success?invoice=${invoice_id}`);
  } catch (e) {
    await log("error", "payments", `Callback error: ${e.message}`);
    res.redirect(`${process.env.FRONTEND_URL}/client/payment-failed`);
  }
});

// GET IPN notification
router.get("/ipn", async (req, res) => {
  const { orderTrackingId, orderMerchantReference } = req.query;
  try {
    if (orderTrackingId) {
      const status = await pesapal.getTransactionStatus(orderTrackingId);
      if (status.payment_status_description === "Completed") {
        await supabaseAdmin
          .from("invoices")
          .update({ status: "paid", paid_at: new Date().toISOString() })
          .eq("pesapal_tracking_id", orderTrackingId);
        await log("info", "payments", `IPN: payment confirmed ${orderTrackingId}`);
      }
    }
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Client Portal Routes ───────────────────────────────────────────────────────

// GET client's own invoices (client auth)
router.get("/my-invoices", verifyToken, async (req, res) => {
  try {
    // Find client linked to this user
    const { data: client } = await supabaseAdmin
      .from("clients")
      .select("*")
      .eq("user_id", req.user.id)
      .single();

    if (!client) return res.json({ invoices: [] });

    const { data } = await supabaseAdmin
      .from("invoices")
      .select("*")
      .eq("client_id", client.id)
      .order("created_at", { ascending: false });

    res.json({ invoices: data || [], client });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
