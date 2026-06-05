import React, { useState, useEffect } from "react";
import api from "../lib/api";

function PnL({ value }) {
  const v = parseFloat(value) || 0;
  return <span className={v > 0 ? "pnl-pos" : v < 0 ? "pnl-neg" : "pnl-zero"}>
    {v > 0 ? "+" : ""}{v.toFixed(2)}
  </span>;
}

export default function ClientPortal() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get("/api/client-portal/dashboard")
      .then(r => setData(r.data))
      .catch(e => setError(e.response?.data?.error || "Failed to load portal"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <div style={{ padding: 28 }}>
      <div style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)", fontSize: 12 }}>Loading your dashboard...</div>
    </div>
  );

  if (error) return (
    <div className="page-body">
      <div className="alert alert-error">{error}</div>
      <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 12 }}>
        Your account may not be linked to a client profile yet. Contact your account manager.
      </p>
    </div>
  );

  const { client, accounts, openTrades, recentTrades, signals, invoices, stats } = data;

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Welcome, {client?.full_name?.split(" ")[0]}</div>
          <div className="page-subtitle">YOUR TRADING ACCOUNT OVERVIEW</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {stats?.pendingInvoices > 0 && (
            <span className="badge warn">⏳ {stats.pendingInvoices} Invoice{stats.pendingInvoices > 1 ? "s" : ""} Pending</span>
          )}
        </div>
      </div>

      <div className="page-body">
        {/* Stats */}
        <div className="stats-grid" style={{ marginBottom: 20 }}>
          <div className="stat-card accent">
            <span className="stat-icon">💼</span>
            <div className="stat-label">Balance</div>
            <div className="stat-value accent">${(stats?.totalBalance || 0).toFixed(2)}</div>
          </div>
          <div className={`stat-card ${(stats?.totalPnL || 0) >= 0 ? "bull" : "bear"}`}>
            <span className="stat-icon">{(stats?.totalPnL || 0) >= 0 ? "📈" : "📉"}</span>
            <div className="stat-label">Closed P&L</div>
            <div className={`stat-value ${(stats?.totalPnL || 0) >= 0 ? "bull" : "bear"}`}>
              {(stats?.totalPnL || 0) >= 0 ? "+" : ""}{(stats?.totalPnL || 0).toFixed(2)}
            </div>
          </div>
          <div className="stat-card warn">
            <span className="stat-icon">⚡</span>
            <div className="stat-label">Open Positions</div>
            <div className="stat-value warn">{stats?.openPositions || 0}</div>
          </div>
          <div className="stat-card bull">
            <span className="stat-icon">🎯</span>
            <div className="stat-label">Win Rate</div>
            <div className="stat-value bull">{stats?.winRate || 0}%</div>
            <div className="stat-sub">{stats?.totalTrades || 0} trades</div>
          </div>
        </div>

        {/* Pending Invoices */}
        {invoices.filter(i => i.status === "pending").length > 0 && (
          <div className="card" style={{ marginBottom: 16, borderColor: "var(--warn)", borderWidth: 2 }}>
            <div className="card-header">
              <span className="card-title">⏳ Pending Payments</span>
            </div>
            {invoices.filter(i => i.status === "pending").map(inv => (
              <div key={inv.id} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "14px 0", borderBottom: "1px solid var(--border)"
              }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>
                    {inv.currency} {inv.amount_due?.toFixed(2)}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                    Profit Split: {inv.period_start} → {inv.period_end}
                    {inv.notes && ` · ${inv.notes}`}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
                    Gross profit: ${inv.gross_profit?.toFixed(2)} @ {inv.split_percent}%
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  {inv.payment_url && (
                    <a href={inv.payment_url} target="_blank" rel="noreferrer"
                      className="btn btn-primary btn-sm">
                      💳 Pay Now (M-Pesa / Card)
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Open Positions */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span className="card-title">Open Positions</span>
            <span className="badge warn">{openTrades.length} OPEN</span>
          </div>
          {openTrades.length === 0 ? (
            <div className="empty-state" style={{ padding: 24 }}>
              <div className="empty-icon">◆</div>
              <div className="empty-text">No open positions</div>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Symbol</th><th>Direction</th><th>Volume</th><th>Open Price</th><th>P&L</th></tr>
                </thead>
                <tbody>
                  {openTrades.map(t => (
                    <tr key={t.id}>
                      <td style={{ fontWeight: 700, color: "var(--text-primary)" }}>{t.symbol}</td>
                      <td><span className={`badge ${t.direction === "BUY" ? "bull" : "bear"}`}>{t.direction}</span></td>
                      <td className="mono">{t.volume}</td>
                      <td className="mono">{t.open_price}</td>
                      <td><PnL value={t.profit} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Recent Signals */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span className="card-title">Recent Signals</span>
          </div>
          {signals.length === 0 ? (
            <div className="empty-state" style={{ padding: 24 }}>
              <div className="empty-icon">⚡</div>
              <div className="empty-text">No signals yet</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {signals.slice(0, 5).map(sig => (
                <div key={sig.id} style={{
                  display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
                  background: "var(--bg-elevated)", borderRadius: "var(--radius)",
                  borderLeft: `3px solid ${sig.direction === "BUY" ? "var(--bull)" : "var(--bear)"}`
                }}>
                  <span style={{ fontWeight: 800, minWidth: 60 }}>{sig.symbol}</span>
                  <span className={`badge ${sig.direction === "BUY" ? "bull" : "bear"}`}>{sig.direction}</span>
                  <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                    {Math.round((sig.confidence || 0) * 100)}% confidence
                  </span>
                  <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginLeft: "auto" }}>
                    {new Date(sig.created_at).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Payment History */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Payment History</span>
          </div>
          {invoices.filter(i => i.status === "paid").length === 0 ? (
            <div className="empty-state" style={{ padding: 24 }}>
              <div className="empty-icon">💳</div>
              <div className="empty-text">No payments yet</div>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Invoice</th><th>Period</th><th>Amount</th><th>Method</th><th>Paid</th></tr>
                </thead>
                <tbody>
                  {invoices.filter(i => i.status === "paid").map(inv => (
                    <tr key={inv.id}>
                      <td className="mono" style={{ fontSize: 11 }}>{inv.invoice_number}</td>
                      <td style={{ fontSize: 12, color: "var(--text-muted)" }}>{inv.period_start} → {inv.period_end}</td>
                      <td style={{ fontWeight: 700 }}>{inv.currency} {inv.amount_due?.toFixed(2)}</td>
                      <td><span className="badge accent">{(inv.payment_method || "mpesa").toUpperCase()}</span></td>
                      <td style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)" }}>
                        {inv.paid_at ? new Date(inv.paid_at).toLocaleDateString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
