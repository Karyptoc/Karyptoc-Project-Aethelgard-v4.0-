/**
 * AETHELGARD - Monthly Report Generator
 * Generates performance reports and emails to clients
 */

const Anthropic = require("@anthropic-ai/sdk");
const { supabaseAdmin, log } = require("./supabase");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Generate monthly report for a client
 */
async function generateMonthlyReport(clientId, month, year) {
  try {
    // Get client details
    const { data: client } = await supabaseAdmin
      .from("clients")
      .select("*")
      .eq("id", clientId)
      .single();

    if (!client) throw new Error("Client not found");

    // Get period dates
    const periodStart = new Date(year, month - 1, 1);
    const periodEnd = new Date(year, month, 0);

    // Get trades for this period
    const { data: trades } = await supabaseAdmin
      .from("trades")
      .select("*")
      .eq("status", "closed")
      .gte("close_time", periodStart.toISOString())
      .lte("close_time", periodEnd.toISOString());

    // Get account snapshots
    const { data: snapshots } = await supabaseAdmin
      .from("account_snapshots")
      .select("*")
      .gte("snapshot_time", periodStart.toISOString())
      .lte("snapshot_time", periodEnd.toISOString())
      .order("snapshot_time", { ascending: true });

    // Get signals for period
    const { data: signals } = await supabaseAdmin
      .from("signals")
      .select("*")
      .gte("created_at", periodStart.toISOString())
      .lte("created_at", periodEnd.toISOString());

    // Calculate stats
    const closedTrades = trades || [];
    const winners = closedTrades.filter(t => (t.profit || 0) > 0);
    const losers = closedTrades.filter(t => (t.profit || 0) < 0);
    const totalPnL = closedTrades.reduce((s, t) => s + (t.profit || 0), 0);
    const grossProfit = winners.reduce((s, t) => s + (t.profit || 0), 0);
    const grossLoss = Math.abs(losers.reduce((s, t) => s + (t.profit || 0), 0));

    const startBalance = snapshots?.[0]?.balance || 0;
    const endBalance = snapshots?.[snapshots.length - 1]?.balance || 0;
    const startEquity = snapshots?.[0]?.equity || 0;
    const endEquity = snapshots?.[snapshots.length - 1]?.equity || 0;

    // By symbol breakdown
    const bySymbol = {};
    closedTrades.forEach(t => {
      if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { trades: 0, pnl: 0, wins: 0 };
      bySymbol[t.symbol].trades++;
      bySymbol[t.symbol].pnl += (t.profit || 0);
      if ((t.profit || 0) > 0) bySymbol[t.symbol].wins++;
    });

    const stats = {
      period: `${periodStart.toLocaleDateString("en-US", { month: "long", year: "numeric" })}`,
      total_trades: closedTrades.length,
      winners: winners.length,
      losers: losers.length,
      win_rate: closedTrades.length > 0 ? (winners.length / closedTrades.length * 100).toFixed(1) : 0,
      total_pnl: totalPnL.toFixed(2),
      gross_profit: grossProfit.toFixed(2),
      gross_loss: grossLoss.toFixed(2),
      profit_factor: grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : "∞",
      start_balance: startBalance.toFixed(2),
      end_balance: endBalance.toFixed(2),
      balance_change: (endBalance - startBalance).toFixed(2),
      signals_generated: (signals || []).length,
      split_amount: ((totalPnL * client.profit_split_percent) / 100).toFixed(2),
      split_percent: client.profit_split_percent,
      by_symbol: bySymbol
    };

    // Generate AI narrative
    const narrative = await generateAINarrative(stats, client.full_name);

    // Build HTML report
    const htmlReport = buildHTMLReport(stats, narrative, client);

    // Save report to database
    const { data: report } = await supabaseAdmin
      .from("monthly_reports")
      .insert({
        client_id: clientId,
        month,
        year,
        period_label: stats.period,
        stats,
        html_content: htmlReport,
        status: "generated"
      })
      .select()
      .single();

    await log("info", "reports", `Report generated for ${client.full_name} — ${stats.period}`);
    return { report, stats, htmlReport };

  } catch (e) {
    await log("error", "reports", `Report generation failed: ${e.message}`);
    throw e;
  }
}

async function generateAINarrative(stats, clientName) {
  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `Write a professional monthly trading report narrative for ${clientName}.

Stats: ${JSON.stringify(stats, null, 2)}

Write 3 short paragraphs:
1. Overall performance summary (mention key numbers)
2. Best performing pairs and what drove results
3. Outlook and strategy notes for next month

Tone: Professional, confident, honest. Under 200 words total.`
      }]
    });
    return response.content[0].text;
  } catch (e) {
    return `Performance report for ${stats.period}. Total P&L: $${stats.total_pnl}. Win rate: ${stats.win_rate}%. Profit factor: ${stats.profit_factor}.`;
  }
}

function buildHTMLReport(stats, narrative, client) {
  const monthName = stats.period;
  const pnlColor = parseFloat(stats.total_pnl) >= 0 ? "#00875a" : "#de350b";
  const pnlSign = parseFloat(stats.total_pnl) >= 0 ? "+" : "";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: 'Helvetica Neue', Arial, sans-serif; margin: 0; padding: 0; background: #f0f4f8; color: #1a202c; }
  .container { max-width: 640px; margin: 0 auto; background: white; }
  .header { background: linear-gradient(135deg, #0066ff, #0052cc); padding: 40px 32px; color: white; }
  .logo { font-size: 28px; font-weight: 800; letter-spacing: 3px; }
  .logo-sub { font-size: 11px; letter-spacing: 2px; opacity: 0.7; margin-top: 4px; }
  .header-title { font-size: 20px; font-weight: 600; margin-top: 24px; opacity: 0.9; }
  .header-period { font-size: 32px; font-weight: 800; margin-top: 4px; }
  .body { padding: 32px; }
  .greeting { font-size: 16px; color: #4a5568; margin-bottom: 24px; line-height: 1.6; }
  .stats-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin: 24px 0; }
  .stat-box { background: #f7fafc; border-radius: 10px; padding: 16px; text-align: center; }
  .stat-label { font-size: 10px; letter-spacing: 2px; color: #a0aec0; text-transform: uppercase; margin-bottom: 6px; }
  .stat-value { font-size: 22px; font-weight: 800; }
  .stat-value.green { color: #00875a; }
  .stat-value.red { color: #de350b; }
  .stat-value.blue { color: #0066ff; }
  .narrative { background: #f7fafc; border-left: 4px solid #0066ff; border-radius: 4px; padding: 20px; margin: 24px 0; font-size: 14px; line-height: 1.8; color: #4a5568; }
  .section-title { font-size: 13px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: #a0aec0; margin: 28px 0 14px; }
  .symbol-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .symbol-table th { text-align: left; padding: 8px 10px; background: #f7fafc; color: #a0aec0; font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; }
  .symbol-table td { padding: 10px; border-bottom: 1px solid #e2e8f0; }
  .split-box { background: linear-gradient(135deg, #f0fff4, #c6f6d5); border: 1px solid #9ae6b4; border-radius: 10px; padding: 20px; margin: 24px 0; }
  .split-title { font-size: 13px; font-weight: 700; color: #276749; margin-bottom: 8px; }
  .split-amount { font-size: 28px; font-weight: 800; color: #276749; }
  .split-note { font-size: 12px; color: #48bb78; margin-top: 4px; }
  .footer { background: #f7fafc; padding: 24px 32px; text-align: center; font-size: 12px; color: #a0aec0; border-top: 1px solid #e2e8f0; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="logo">AETHELGARD</div>
    <div class="logo-sub">QUANT ENGINE v4.0 · KARYPTOC SOLUTIONS</div>
    <div class="header-title">Monthly Performance Report</div>
    <div class="header-period">${monthName}</div>
  </div>

  <div class="body">
    <div class="greeting">Dear ${client.full_name},<br><br>
    Please find your monthly trading performance summary below. All figures are calculated from closed trades during the period.</div>

    <div class="stats-grid">
      <div class="stat-box">
        <div class="stat-label">Total P&L</div>
        <div class="stat-value" style="color:${pnlColor}">${pnlSign}$${stats.total_pnl}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Win Rate</div>
        <div class="stat-value blue">${stats.win_rate}%</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Profit Factor</div>
        <div class="stat-value green">${stats.profit_factor}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Total Trades</div>
        <div class="stat-value blue">${stats.total_trades}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Winners</div>
        <div class="stat-value green">${stats.winners}</div>
      </div>
      <div class="stat-box">
        <div class="stat-label">Losers</div>
        <div class="stat-value red">${stats.losers}</div>
      </div>
    </div>

    <div class="narrative">${narrative.replace(/\n/g, "<br>")}</div>

    ${Object.keys(stats.by_symbol).length > 0 ? `
    <div class="section-title">Performance by Pair</div>
    <table class="symbol-table">
      <thead><tr><th>Symbol</th><th>Trades</th><th>Win Rate</th><th>P&L</th></tr></thead>
      <tbody>
        ${Object.entries(stats.by_symbol).map(([sym, data]) => `
        <tr>
          <td><strong>${sym}</strong></td>
          <td>${data.trades}</td>
          <td>${data.trades > 0 ? (data.wins / data.trades * 100).toFixed(0) : 0}%</td>
          <td style="color:${data.pnl >= 0 ? "#00875a" : "#de350b"};font-weight:600">
            ${data.pnl >= 0 ? "+" : ""}$${data.pnl.toFixed(2)}
          </td>
        </tr>`).join("")}
      </tbody>
    </table>` : ""}

    ${parseFloat(stats.total_pnl) > 0 ? `
    <div class="split-box">
      <div class="split-title">💰 Profit Split Due</div>
      <div class="split-amount">$${stats.split_amount}</div>
      <div class="split-note">${stats.split_percent}% of $${stats.total_pnl} gross profit</div>
    </div>` : ""}

    <div style="font-size:13px;color:#718096;line-height:1.7;margin-top:24px;">
      Account balance moved from <strong>$${stats.start_balance}</strong> to <strong>$${stats.end_balance}</strong> during this period.
      The engine generated <strong>${stats.signals_generated} signals</strong> this month.
    </div>
  </div>

  <div class="footer">
    Aethelgard Quant Engine · Karyptoc Solutions · Nairobi, Kenya<br>
    This report is generated automatically. Past performance does not guarantee future results.<br>
    Trading involves significant risk. Only trade with capital you can afford to lose.
  </div>
</div>
</body>
</html>`;
}

/**
 * Send report via email using Resend (free tier: 3000 emails/month)
 */
async function sendReportEmail(clientEmail, clientName, htmlReport, period) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    await log("warning", "reports", "No RESEND_API_KEY — email not sent");
    return false;
  }

  try {
    const axios = require("axios");
    const response = await axios.post(
      "https://api.resend.com/emails",
      {
        from: process.env.REPORT_FROM_EMAIL || "reports@karyptoc.com",
        to: clientEmail,
        subject: `Aethelgard Trading Report — ${period}`,
        html: htmlReport
      },
      {
        headers: {
          "Authorization": `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    await log("info", "reports", `Email sent to ${clientEmail} for ${period}`);
    return true;
  } catch (e) {
    await log("error", "reports", `Email failed for ${clientEmail}: ${e.message}`);
    return false;
  }
}

/**
 * Auto-generate reports for all active clients
 * Runs on the 1st of each month
 */
async function generateAllMonthlyReports() {
  const now = new Date();
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const month = lastMonth.getMonth() + 1;
  const year = lastMonth.getFullYear();

  await log("info", "reports", `Generating monthly reports for ${month}/${year}`);

  const { data: clients } = await supabaseAdmin
    .from("clients")
    .select("*")
    .eq("status", "active");

  if (!clients?.length) {
    await log("info", "reports", "No active clients for reports");
    return;
  }

  for (const client of clients) {
    try {
      const { report, stats, htmlReport } = await generateMonthlyReport(client.id, month, year);

      // Send email
      await sendReportEmail(client.email, client.full_name, htmlReport, stats.period);

      // Create invoice if profit was made
      if (parseFloat(stats.total_pnl) > 0) {
        const invoiceId = `AE-AUTO-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
        await supabaseAdmin.from("invoices").insert({
          invoice_number: invoiceId,
          client_id: client.id,
          period_start: new Date(year, month - 1, 1).toISOString().split("T")[0],
          period_end: new Date(year, month, 0).toISOString().split("T")[0],
          gross_profit: parseFloat(stats.total_pnl),
          split_percent: client.profit_split_percent,
          amount_due: parseFloat(stats.split_amount),
          currency: "USD",
          status: "pending",
          notes: `Auto-generated: ${stats.period} profit split`
        });
        await log("info", "reports", `Auto-invoice created for ${client.full_name}: $${stats.split_amount}`);
      }

      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      await log("error", "reports", `Report failed for ${client.full_name}: ${e.message}`);
    }
  }
}

module.exports = {
  generateMonthlyReport,
  generateAllMonthlyReports,
  sendReportEmail,
  buildHTMLReport
};
