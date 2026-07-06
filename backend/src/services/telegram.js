/**
 * AETHELGARD - Telegram Notification Service
 * backend/src/services/telegram.js
 *
 * FIX: the bot token used to live in the browser (localStorage) and every
 * send happened as a direct fetch() from the frontend to api.telegram.org
 * with the token in the request body. That means the token was sitting in
 * plain text in every admin's browser storage, and anyone who could read
 * network requests or localStorage had it.
 *
 * Now: the bot token is stored encrypted in platform_settings (reusing
 * crypto.js, the same mechanism protecting MT5 passwords) and every send
 * happens server-side. The frontend only ever calls POST /api/system/
 * telegram/send with the message text — it never sees the token.
 */

const axios = require("axios");
const { supabaseAdmin, log } = require("./supabase");
const { encryptSecret, decryptSecret } = require("./crypto");

const BOT_TOKEN_KEY = "telegram_bot_token";
const CHAT_ID_KEY = "telegram_chat_id";

async function getTelegramConfig() {
  const { data } = await supabaseAdmin
    .from("platform_settings")
    .select("key, value")
    .in("key", [BOT_TOKEN_KEY, CHAT_ID_KEY]);

  const raw = {};
  (data || []).forEach(row => { raw[row.key] = row.value; });

  return {
    botToken: raw[BOT_TOKEN_KEY] ? decryptSecret(raw[BOT_TOKEN_KEY]) : null,
    chatId: raw[CHAT_ID_KEY] || null,
  };
}

async function isConfigured() {
  const { botToken, chatId } = await getTelegramConfig();
  return !!(botToken && chatId);
}

/**
 * Saves bot token (encrypted) and/or chat ID. Pass only the fields being
 * updated — omitted fields are left unchanged.
 */
async function saveTelegramConfig({ botToken, chatId }) {
  const upserts = [];
  if (botToken) {
    upserts.push(
      supabaseAdmin.from("platform_settings")
        .upsert({ key: BOT_TOKEN_KEY, value: encryptSecret(botToken), updated_at: new Date().toISOString() }, { onConflict: "key" })
    );
  }
  if (chatId) {
    upserts.push(
      supabaseAdmin.from("platform_settings")
        .upsert({ key: CHAT_ID_KEY, value: chatId, updated_at: new Date().toISOString() }, { onConflict: "key" })
    );
  }
  await Promise.all(upserts);
}

/**
 * Sends a message via the configured bot. Returns { ok, error? }.
 * Never throws — callers get a clean result object either way.
 */
async function sendTelegramMessage(text) {
  const { botToken, chatId } = await getTelegramConfig();
  if (!botToken || !chatId) {
    return { ok: false, error: "Telegram not configured — set bot token and chat ID in Settings." };
  }

  try {
    const r = await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      { chat_id: chatId, text, parse_mode: "Markdown" },
      { timeout: 10000 }
    );
    if (!r.data.ok) {
      await log("warning", "telegram", `Send rejected by Telegram: ${r.data.description}`);
      return { ok: false, error: r.data.description };
    }
    return { ok: true };
  } catch (e) {
    const msg = e.response?.data?.description || e.message;
    await log("error", "telegram", `Send failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

module.exports = { getTelegramConfig, isConfigured, saveTelegramConfig, sendTelegramMessage };
