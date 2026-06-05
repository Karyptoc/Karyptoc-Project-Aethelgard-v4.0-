import React, { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import api from "../lib/api";

function PnL({ value }) {
  const v = parseFloat(value) || 0;
  const cls = v > 0 ? "pnl-pos" : v < 0 ? "pnl-neg" : "pnl-zero";
  return <span className={cls}>{v > 0 ? "+" : ""}{v.toFixed(2)}</span>;
}

function ConfBar({ value }) {
  const pct = Math.round((value || 0) * 100);
  const color = pct >= 75 ? "var(--bull)" : pct >= 60 ? "var(--warn)" : "var(--bear)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div className="conf-bar">
        <div className="conf-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}>{pct}%</span>
    </div>
  );
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const load = async () => {
    try {
      const r = await api.get("/api/dashboard/overview");
      setData(r.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, []);

  const generateSignals = async () => {
    setGenerating(true);
    try {
      await api.post("/api/signals/generate", {});
      await load();
    } catch (e) {
      console.error(e);
    } finally {
      setGenerating(false);
    }
  };

  if (loading) return (
    <div style={{ padding: 28 }}>
      <div style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)", fontSize: 12 }}>
        Loading dashboard...
      </div>
    </div>
  );

  const s = data?.summary || {};

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Mission Control</div>
          <div className="page-subtitle">REAL-TIME PORTFOLIO OVERVIEW · {new Date().toUTCString()}</div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn-ghost btn-sm" onClick={load}>↻ REFRESH</button>
          <button
            className="btn btn-primary btn-sm"
            onClick={generateSignals}
            disabled={generating}
          >
            {generating ? "⚡ GENERATING..." : "⚡ GENERATE SIGNALS"}
          </button>
        </div>
      </div>

      <div className="page-body">
        {/* Stats */}
        <div className="stats-grid">
          <div className="stat-card accent">
            <div className="stat-label">Total Balance</div>
            <div className="stat-value accent">${(s.total_balance || 0).toFixed(2)}</div>
            <div className="stat-sub">across {s.total_accounts || 0} accounts</div>
          </div>
          <div className="stat-card bull">
            <div className="stat-label">Open P&L</div>
            <div className={`stat-value ${(s.total_profit || 0) >= 0 ? "bull" : "bear"}`}>
              {(s.total_profit || 0) >= 0 ? "+" : ""}{(s.total_profit || 0).toFixed(2)}
            </div>
            <div className="stat-sub">floating profit</div>
          </div>
          <div className="stat-card blue">
            <div className="stat-label">Open Trades</div>
            <div className="stat-value blue">{s.open_trades || 0}</div>
            <div className="stat-sub">active positions</div>
          </div>
          <div className="stat-card warn">
            <div className="stat-label">Connected</div>
            <div className="stat-value" style={{ color: "var(--warn)" }}>{s.connected_accounts || 0}/{s.total_accounts || 0}</div>
            <div className="stat-sub">accounts online</div>
          </div>
          <div className="stat-card accent">
            <div className="stat-label">Active Clients</div>
            <div className="stat-value accent">{s.active_clients || 0}</div>
            <div className="stat-sub">subscriptions</div>
          </div>
        </div>

        {/* Grid: accounts + signals */}
        <div className="grid-2" style={{ gap: 16, marginBottom: 16 }}>
          {/* Live Accounts */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Live Accounts</span>
              <span className="badge accent">{(data?.accounts || []).length} TOTAL</span>
            </div>
            {(data?.accounts || []).length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">⬡</div>
                <div className="empty-text">No accounts connected yet</div>
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Balance</th>
                      <th>P&L</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.accounts || []).map(acc => (
                      <tr key={acc.id}>
                        <td>
                          <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{acc.label}</div>
                          <div className="mono" style={{ fontSize: 10, color: "var(--text-muted)" }}>{acc.login}</div>
                        </td>
                        <td className="mono">${(acc.balance || 0).toFixed(2)}</td>
                        <td><PnL value={acc.profit} /></td>
                        <td>
                          <span className={`badge ${acc.is_connected ? "bull" : "bear"}`}>
                            {acc.is_connected ? "LIVE" : "OFFLINE"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Recent Signals */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Recent Signals</span>
              <span className="badge accent">{(data?.recent_signals || []).length}</span>
            </div>
            {(data?.recent_signals || []).length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">⚡</div>
                <div className="empty-text">No signals yet — click Generate Signals</div>
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Pair</th>
                      <th>Direction</th>
                      <th>Confidence</th>
                      <th>Regime</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.recent_signals || []).slice(0, 8).map(sig => (
                      <tr key={sig.id}>
                        <td style={{ fontWeight: 700, color: "var(--text-primary)" }}>{sig.symbol}</td>
                        <td>
                          <span className={`badge ${sig.direction === "BUY" ? "bull" : sig.direction === "SELL" ? "bear" : "muted"}`}>
                            {sig.direction}
                          </span>
                        </td>
                        <td><ConfBar value={sig.confidence} /></td>
                        <td>
                          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}>
                            {(sig.regime || "").replace(/_/g, " ")}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Open Trades */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span className="card-title">Open Positions</span>
            <span className="badge blue">{(data?.open_trades || []).length} OPEN</span>
          </div>
          {(data?.open_trades || []).length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">◆</div>
              <div className="empty-text">No open positions</div>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ticket</th>
                    <th>Symbol</th>
                    <th>Direction</th>
                    <th>Volume</th>
                    <th>Open Price</th>
                    <th>SL</th>
                    <th>TP</th>
                    <th>P&L</th>
                    <th>Opened</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.open_trades || []).map(t => (
                    <tr key={t.id}>
                      <td className="mono">{t.ticket}</td>
                      <td style={{ fontWeight: 700, color: "var(--text-primary)" }}>{t.symbol}</td>
                      <td><span className={`badge ${t.direction === "BUY" ? "bull" : "bear"}`}>{t.direction}</span></td>
                      <td className="mono">{t.volume}</td>
                      <td className="mono">{t.open_price}</td>
                      <td className="mono" style={{ color: "var(--bear)" }}>{t.stop_loss || "—"}</td>
                      <td className="mono" style={{ color: "var(--bull)" }}>{t.take_profit || "—"}</td>
                      <td><PnL value={t.profit} /></td>
                      <td className="mono" style={{ fontSize: 10, color: "var(--text-muted)" }}>
                        {t.open_time ? new Date(t.open_time).toLocaleTimeString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* System Logs */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">System Log</span>
          </div>
          <div style={{ maxHeight: 200, overflowY: "auto" }}>
            {(data?.recent_logs || []).map(log => (
              <div key={log.id} style={{
                padding: "6px 8px", borderBottom: "1px solid var(--border)",
                display: "flex", gap: 12, alignItems: "flex-start"
              }}>
                <span style={{
                  fontFamily: "var(--font-mono)", fontSize: 9,
                  color: {
                    info: "var(--text-muted)",
                    warning: "var(--warn)",
                    error: "var(--bear)",
                    critical: "var(--bear)"
                  }[log.level] || "var(--text-muted)",
                  minWidth: 48, textTransform: "uppercase", letterSpacing: 1
                }}>{log.level}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--accent)", minWidth: 80 }}>
                  [{log.source}]
                </span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)", flex: 1 }}>
                  {log.message}
                </span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--text-muted)", flexShrink: 0 }}>
                  {new Date(log.created_at).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
