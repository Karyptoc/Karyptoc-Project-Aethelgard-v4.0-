require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const cron = require("node-cron");

const { supabaseAdmin, log } = require("./services/supabase");
const signalEngine = require("./services/signalEngine");

// Routes
const authRoutes = require("./routes/auth");
const accountRoutes = require("./routes/accounts");
const clientRoutes = require("./routes/clients");
const signalRoutes = require("./routes/signals");
const tradeRoutes = require("./routes/trades");
const bridgeRoutes = require("./routes/bridge");
const dashboardRoutes = require("./routes/dashboard");
const paymentRoutes = require("./routes/payments");
const clientPortalRoutes = require("./routes/clientPortal");

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({
  origin: [
    process.env.FRONTEND_URL || "http://localhost:3000",
    /\.netlify\.app$/,
    /\.vercel\.app$/
  ],
  credentials: true
}));

app.use(express.json({ limit: "10mb" }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500 });
app.use("/api/", limiter);

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/accounts", accountRoutes);
app.use("/api/clients", clientRoutes);
app.use("/api/signals", signalRoutes);
app.use("/api/trades", tradeRoutes);
app.use("/api/bridge", bridgeRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/client-portal", clientPortalRoutes);

app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "2.0.0", timestamp: new Date().toISOString() });
});

// Cron: signal generation every 15 min
cron.schedule("*/15 * * * *", async () => {
  try {
    const { data: settings } = await supabaseAdmin
      .from("platform_settings").select("value").eq("key", "trading_enabled").single();
    if (settings?.value === true || settings?.value === "true") {
      await log("info", "cron", "Running signal generation cycle");
      await signalEngine.generateSignalsForAllPairs();
    }
  } catch (e) {
    await log("error", "cron", `Signal generation failed: ${e.message}`);
  }
});

// Cron: hourly snapshots
cron.schedule("0 * * * *", async () => {
  try {
    const { data: accounts } = await supabaseAdmin
      .from("mt5_accounts").select("*").eq("is_active", true).eq("is_connected", true);
    if (!accounts) return;
    for (const account of accounts) {
      await supabaseAdmin.from("account_snapshots").insert({
        account_id: account.id, balance: account.balance,
        equity: account.equity, profit: account.profit, open_trades: 0
      });
    }
  } catch (e) {
    await log("error", "cron", `Snapshot failed: ${e.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════╗`);
  console.log(`║  AETHELGARD BACKEND v2.0.0       ║`);
  console.log(`║  Port: ${PORT}                       ║`);
  console.log(`╚══════════════════════════════════╝\n`);
  log("info", "server", `Aethelgard backend started on port ${PORT}`);
});

module.exports = app;
