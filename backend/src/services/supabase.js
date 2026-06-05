const { createClient } = require("@supabase/supabase-js");

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const supabaseAnon = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function log(level, source, message, metadata = null) {
  try {
    await supabaseAdmin.from("system_logs").insert({
      level,
      source,
      message,
      metadata
    });
  } catch (e) {
    console.error(`[LOG ERROR] ${e.message}`);
  }
  const emoji = { info: "ℹ️", warning: "⚠️", error: "❌", critical: "🚨" }[level] || "📝";
  console.log(`${emoji} [${source}] ${message}`);
}

module.exports = { supabaseAdmin, supabaseAnon, log };
