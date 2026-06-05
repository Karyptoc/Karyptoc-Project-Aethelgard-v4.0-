/**
 * AETHELGARD - Pesapal Payment Service
 * Handles M-Pesa, Visa, Mastercard payments via Pesapal API v3
 */

const axios = require("axios");
const { supabaseAdmin, log } = require("./supabase");

// Pesapal API endpoints
const PESAPAL_BASE = process.env.PESAPAL_ENV === "live"
  ? "https://pay.pesapal.com/v3"
  : "https://cybqa.pesapal.com/pesapalv3";

const CONSUMER_KEY = process.env.PESAPAL_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.PESAPAL_CONSUMER_SECRET;
const CALLBACK_URL = process.env.PESAPAL_CALLBACK_URL || `${process.env.BACKEND_URL}/api/payments/callback`;

let cachedToken = null;
let tokenExpiry = null;

/**
 * Get Pesapal OAuth token
 */
async function getAuthToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  try {
    const response = await axios.post(
      `${PESAPAL_BASE}/api/Auth/RequestToken`,
      { consumer_key: CONSUMER_KEY, consumer_secret: CONSUMER_SECRET },
      { headers: { "Content-Type": "application/json", "Accept": "application/json" } }
    );

    cachedToken = response.data.token;
    tokenExpiry = Date.now() + (4 * 60 * 60 * 1000); // 4 hours
    return cachedToken;
  } catch (e) {
    await log("error", "pesapal", `Auth token failed: ${e.message}`);
    throw new Error("Pesapal authentication failed");
  }
}

/**
 * Register IPN (Instant Payment Notification) URL
 * Must be done once before accepting payments
 */
async function registerIPN() {
  try {
    const token = await getAuthToken();
    const response = await axios.post(
      `${PESAPAL_BASE}/api/URLSetup/RegisterIPN`,
      {
        url: `${process.env.BACKEND_URL}/api/payments/ipn`,
        ipn_notification_type: "GET"
      },
      {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "Accept": "application/json"
        }
      }
    );
    await log("info", "pesapal", `IPN registered: ${response.data.ipn_id}`);
    return response.data.ipn_id;
  } catch (e) {
    await log("error", "pesapal", `IPN registration failed: ${e.message}`);
    throw e;
  }
}

/**
 * Get or create IPN ID (stored in platform settings)
 */
async function getIPNId() {
  const { data } = await supabaseAdmin
    .from("platform_settings")
    .select("value")
    .eq("key", "pesapal_ipn_id")
    .single();

  if (data?.value) return data.value;

  const ipnId = await registerIPN();
  await supabaseAdmin
    .from("platform_settings")
    .upsert({ key: "pesapal_ipn_id", value: ipnId }, { onConflict: "key" });

  return ipnId;
}

/**
 * Submit payment order — returns payment URL for client
 */
async function submitOrder({ invoiceId, amount, currency = "KES", description, clientName, clientEmail, clientPhone }) {
  try {
    const token = await getAuthToken();
    const ipnId = await getIPNId();

    const orderData = {
      id: invoiceId,
      currency,
      amount: parseFloat(amount).toFixed(2),
      description,
      callback_url: `${CALLBACK_URL}?invoice_id=${invoiceId}`,
      notification_id: ipnId,
      billing_address: {
        email_address: clientEmail,
        phone_number: clientPhone || "",
        first_name: clientName.split(" ")[0] || clientName,
        last_name: clientName.split(" ").slice(1).join(" ") || "",
        line_1: "Nairobi",
        city: "Nairobi",
        state: "",
        postal_code: "",
        zip_code: "",
        country_code: "KE"
      }
    };

    const response = await axios.post(
      `${PESAPAL_BASE}/api/Transactions/SubmitOrderRequest`,
      orderData,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "Accept": "application/json"
        }
      }
    );

    await log("info", "pesapal", `Order submitted: ${invoiceId} | ${amount} ${currency}`);
    return {
      order_tracking_id: response.data.order_tracking_id,
      merchant_reference: response.data.merchant_reference,
      redirect_url: response.data.redirect_url
    };
  } catch (e) {
    await log("error", "pesapal", `Submit order failed: ${e.message}`);
    throw e;
  }
}

/**
 * Check payment status
 */
async function getTransactionStatus(orderTrackingId) {
  try {
    const token = await getAuthToken();
    const response = await axios.get(
      `${PESAPAL_BASE}/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`,
      {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json"
        }
      }
    );
    return response.data;
  } catch (e) {
    await log("error", "pesapal", `Status check failed: ${e.message}`);
    throw e;
  }
}

module.exports = {
  submitOrder,
  getTransactionStatus,
  registerIPN,
  getIPNId
};
