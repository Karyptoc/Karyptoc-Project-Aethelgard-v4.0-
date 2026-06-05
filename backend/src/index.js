require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const cron = require("node-cron");

const { supabaseAdmin, log } = require("./services/supabase");
const signalEngine = require("./services/signalEngine");
const riskEngine = require("./services/riskEngine");

// Routes
const authRoutes = require("./routes/auth");
const accountRoutes = require("./routes/accounts");
const clientRoutes = require("./routes/clients");
const signalRoutes = require("./routes/signals");
const tradeRoutes = require("./routes/trades");
const bridgeRoutes = require("./routes/bridge");
const dashboardRoutes = require("./routes/dashboard");

const app = express();
const PORT = process.env.PORT || 4000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || "http://localhost:3000",
    /\.netlify\.app$/,
    /\.vercel\.app$/
  ],
  credentials: true
}));

app.use(express.json({ limit: "10mb" }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { error: "Too many requests" }
});
app.use("/api/", limiter);

// ── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/accounts", accountRoutes);
app.use("/api/clients", clientRoutes);
app.use("/api/signals", signalRoutes);
app.use("/api/trades", tradeRoutes);
app.use("/api/bridge", bridgeRoutes);
app.use("/api/dashboard", dashboardRoutes);

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    version: "1.0.0",
    timestamp: new Date().toISOString()
  });
});

// ── Scheduled Jobs ────────────────────────────────────────────────────────────

// Generate signals every 15 minutes
cron.schedule("*/15 * * * *", async () => {
  try {
    const { data: settings } = await supabaseAdmin
      .from("platform_settings")
      .select("value")
      .eq("key", "trading_enabled")
      .single();

    if (settings?.value === true || settings?.value === "true") {
      log("info", "cron", "Running signal generation cycle");
      await signalEngine.generateSignalsForAllPairs();
    }
  } catch (e) {
    log("error", "cron", `Signal generation failed: ${e.message}`);
  }
});

// Take account snapshots every hour
cron.schedule("0 * * * *", async () => {
  try {
    const { data: accounts } = await supabaseAdmin
      .from("mt5_accounts")
      .select("*")
      .eq("is_active", true)
      .eq("is_connected", true);

    if (!accounts) return;

    for (const account of accounts) {
      await supabaseAdmin.from("account_snapshots").insert({
        account_id: account.id,
        balance: account.balance,
        equity: account.equity,
        profit: account.profit,
        open_trades: 0
      });
    }
    log("info", "cron", `Snapshots taken for ${accounts.length} accounts`);
  } catch (e) {
    log("error", "cron", `Snapshot failed: ${e.message}`);
  }
});

// ── Start Server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║   AETHELGARD BACKEND v1.0.0           ║
║   Running on port ${PORT}               ║
║   Environment: ${process.env.NODE_ENV || "development"}           ║
╚═══════════════════════════════════════╝
  `);
  log("info", "server", `Aethelgard backend started on port ${PORT}`);
});

module.exports = app;
