import React, { useEffect, useState, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
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
    <div className="conf-bar-wrap">
      <div className="conf-bar">
        <div className="conf-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}>{pct}%</span>
    </div>
  );
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 14px", fontSize: 12 }}>
      <div style={{ color: "var(--text-muted)", marginBottom: 4 }}>{new Date(label).toLocaleString()}</div>
      <div style={{ color: "var(--accent)", fontWeight: 700 }}>Equity: ${parseFloat(payload[0]?.value || 0).toFixed(2)}</div>
    </div>
  );
};

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [equityCurve, setEquityCurve] = useState([]);

  const load = useCallback(async () => {
    try {
      const r = await api.get("/api/dashboard/overview");
      setData(r.data);
      // Load equity curve for first account
      if (r.data.accounts?.length > 0) {
        try {
          const eq = await api.get(`/api/dashboard/equity-curve/${r.data.accounts[0].id}`);
          setEquityCurve((eq.data.snapshots || []).map(s => ({
            time: s.snapshot_time,
            equity: parseFloat(s.equity)
          })));
        } catch {}
      }
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const iv = setInterval(load, 15000); return () => clearInterval(iv); }, [load]);

  const generateSignals = async () => {
    setGenerating(true);
    try { await api.post("/api/signals/generate", {}); await load(); }
    catch (e) { console.error(e); }
    finally { setGenerating(false); }
  };

  if (loading) return (
    <div style={{ padding: 28 }}>
      <div style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)", fontSize: 12 }}>Loading...</div>
    </div>
  );

  const s = data?.summary || {};
  const profitPos = (s.total_profit || 0) >= 0;

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Mission Control</div>
          <div className="page-subtitle">LIVE PORTFOLIO OVERVIEW · {new Date().toUTCString()}</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={load}>↻ Refresh</button>
          <button className="btn btn-primary btn-sm" onClick={generateSignals} disabled={generating}>
            {generating ? "⚡ Generating..." : "⚡ Generate Signals"}
          </button>
        </div>
      </div>

      <div className="page-body">
        {/* Stats */}
        <div className="stats-grid">
          <div className="stat-card accent">
            <span className="stat-icon">💼</span>
            <div className="stat-label">Total Balance</div>
            <div className="stat-value accent">${(s.total_balance || 0).toFixed(2)}</div>
            <div className="stat-sub">{s.total_accounts || 0} account{s.total_accounts !== 1 ? "s" : ""}</div>
          </div>
          <div className={`stat-card ${profitPos ? "bull" : "bear"}`}>
            <span className="stat-icon">{profitPos ? "📈" : "📉"}</span>
            <div className="stat-label">Floating P&L</div>
            <div className={`stat-value ${profitPos ? "bull" : "bear"}`}>
              {profitPos ? "+" : ""}{(s.total_profit || 0).toFixed(2)}
            </div>
            <div className="stat-sub">open positions</div>
          </div>
          <div className="stat-card warn">
            <span className="stat-icon">⚡</span>
            <div className="stat-label">Open Trades</div>
            <div className="stat-value warn">{s.open_trades || 0}</div>
            <div className="stat-sub">active positions</div>
          </div>
          <div className="stat-card bull">
            <span className="stat-icon">🔗</span>
            <div className="stat-label">Connected</div>
            <div className="stat-value bull">{s.connected_accounts || 0}/{s.total_accounts || 0}</div>
            <div className="stat-sub">accounts online</div>
          </div>
          <div className="stat-card gold">
            <span className="stat-icon">👥</span>
            <div className="stat-label">Clients</div>
            <div className="stat-value gold">{s.active_clients || 0}</div>
            <div className="stat-sub">active subscriptions</div>
          </div>
        </div>

        {/* Equity Curve + Signals */}
        <div className="grid-2" style={{ marginBottom: 16, gap: 16 }}>
          <div className="card">
            <div className="card-header">
              <span className="card-title">Equity Curve</span>
              {data?.accounts?.[0] && <span className="badge accent">{data.accounts[0].label}</span>}
            </div>
            {equityCurve.length > 1 ? (
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={equityCurve}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="time" hide />
                  <YAxis domain={["auto","auto"]} tick={{ fontSize: 10, fill: "var(--text-muted)" }} width={60} />
                  <Tooltip content={<CustomTooltip />} />
                  <Line type="monotone" dataKey="equity" stroke="var(--accent)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="empty-state" style={{ padding: 32 }}>
                <div className="empty-icon">📊</div>
                <div className="empty-text">Equity curve builds over time</div>
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">Recent Signals</span>
              <span className="badge accent">{(data?.recent_signals || []).length}</span>
            </div>
            {(data?.recent_signals || []).length === 0 ? (
              <div className="empty-state" style={{ padding: 32 }}>
                <div className="empty-icon">⚡</div>
                <div className="empty-text">Click Generate Signals to start</div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {(data?.recent_signals || []).slice(0, 5).map(sig => (
                  <div key={sig.id} style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "10px 12px", background: "var(--bg-elevated)",
                    borderRadius: "var(--radius)", borderLeft: `3px solid ${sig.direction === "BUY" ? "var(--bull)" : "var(--bear)"}`
                  }}>
                    <span style={{ fontWeight: 800, fontSize: 14, minWidth: 60 }}>{sig.symbol}</span>
                    <span className={`badge ${sig.direction === "BUY" ? "bull" : "bear"}`}>{sig.direction}</span>
                    <ConfBar value={sig.confidence} />
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}>
                      {(sig.regime || "").replace(/_/g, " ")}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Live Accounts */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span className="card-title">Live Accounts</span>
            <span className="badge accent">{(data?.accounts || []).length} TOTAL</span>
          </div>
          {(data?.accounts || []).length === 0 ? (
            <div className="empty-state"><div className="empty-icon">⬡</div><div className="empty-text">No accounts added</div></div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Account</th><th>Balance</th><th>Equity</th><th>P&L</th><th>Risk</th><th>Status</th><th>Last Sync</th></tr></thead>
                <tbody>
                  {(data?.accounts || []).map(acc => (
                    <tr key={acc.id}>
                      <td>
                        <div style={{ fontWeight: 700, color: "var(--text-primary)" }}>{acc.label}</div>
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}>{acc.login}</div>
                      </td>
                      <td className="mono">${(acc.balance || 0).toFixed(2)}</td>
                      <td className="mono">${(acc.equity || 0).toFixed(2)}</td>
                      <td><PnL value={acc.profit} /></td>
                      <td className="mono">{acc.risk_percent}%</td>
                      <td>
                        <div style={{ display: "flex", gap: 5 }}>
                          <span className={`badge ${acc.is_connected ? "bull" : "muted"}`}>{acc.is_connected ? "LIVE" : "OFFLINE"}</span>
                          <span className={`badge ${acc.account_type === "live" ? "bear" : "blue"}`}>{acc.account_type?.toUpperCase()}</span>
                        </div>
                      </td>
                      <td style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}>
                        {acc.last_sync ? new Date(acc.last_sync).toLocaleTimeString() : "Never"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Open Positions */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span className="card-title">Open Positions</span>
            <span className="badge warn">{(data?.open_trades || []).length} OPEN</span>
          </div>
          {(data?.open_trades || []).length === 0 ? (
            <div className="empty-state"><div className="empty-icon">◆</div><div className="empty-text">No open positions</div></div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Ticket</th><th>Symbol</th><th>Dir</th><th>Vol</th><th>Open</th><th>SL</th><th>TP</th><th>P&L</th><th>Time</th></tr></thead>
                <tbody>
                  {(data?.open_trades || []).map(t => (
                    <tr key={t.id}>
                      <td className="mono" style={{ color: "var(--text-muted)" }}>{t.ticket}</td>
                      <td style={{ fontWeight: 700, color: "var(--text-primary)" }}>{t.symbol}</td>
                      <td><span className={`badge ${t.direction === "BUY" ? "bull" : "bear"}`}>{t.direction}</span></td>
                      <td className="mono">{t.volume}</td>
                      <td className="mono">{t.open_price}</td>
                      <td className="mono" style={{ color: "var(--bear)" }}>{t.stop_loss || "—"}</td>
                      <td className="mono" style={{ color: "var(--bull)" }}>{t.take_profit || "—"}</td>
                      <td><PnL value={t.profit} /></td>
                      <td style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}>
                        {t.open_time ? new Date(t.open_time).toLocaleTimeString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* System Log */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">System Log</span>
            <span className="badge muted">{(data?.recent_logs || []).length} entries</span>
          </div>
          <div style={{ maxHeight: 220, overflowY: "auto" }}>
            {(data?.recent_logs || []).map(log => (
              <div key={log.id} className="log-entry">
                <span className={`log-level ${log.level}`}>{log.level}</span>
                <span className="log-source">[{log.source}]</span>
                <span className="log-msg">{log.message}</span>
                <span className="log-time">{new Date(log.created_at).toLocaleTimeString()}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
