import React, { useState, useEffect, useCallback } from "react";
import api from "../lib/api";

function StatusIndicator({ online, label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{
        width: 10, height: 10, borderRadius: "50%",
        background: online ? "var(--bull)" : "var(--bear)",
        boxShadow: online ? "0 0 8px var(--bull)" : "none",
        animation: online ? "pulse-dot 2s infinite" : "none"
      }} />
      <span style={{ fontSize: 13, fontWeight: 600, color: online ? "var(--bull)" : "var(--bear)" }}>
        {label}
      </span>
    </div>
  );
}

function ControlToggle({ label, desc, value, onChange, danger }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "16px 0", borderBottom: "1px solid var(--border)"
    }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{label}</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{desc}</div>
      </div>
      <button
        onClick={onChange}
        style={{
          width: 52, height: 28, borderRadius: 14, border: "none", cursor: "pointer",
          background: value ? (danger ? "var(--bear)" : "var(--bull)") : "var(--border)",
          position: "relative", transition: "background 0.2s", flexShrink: 0
        }}>
        <div style={{
          width: 22, height: 22, borderRadius: "50%", background: "white",
          position: "absolute", top: 3,
          left: value ? 26 : 4,
          transition: "left 0.2s",
          boxShadow: "0 1px 3px rgba(0,0,0,0.2)"
        }} />
      </button>
    </div>
  );
}

export default function SystemControl() {
  const [status, setStatus] = useState(null);
  const [settings, setSettings] = useState({});
  const [reports, setReports] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [toast, setToast] = useState("");
  const [selectedReport, setSelectedReport] = useState(null);
  const [genForm, setGenForm] = useState({ client_id: "", month: new Date().getMonth() || 12, year: new Date().getFullYear() });

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(""), 4000); };

  const load = useCallback(async () => {
    try {
      const [statusR, settingsR, reportsR, clientsR] = await Promise.all([
        api.get("/api/system/status"),
        api.get("/api/system/settings"),
        api.get("/api/system/reports"),
        api.get("/api/clients")
      ]);
      setStatus(statusR.data.status);
      setSettings(settingsR.data.settings);
      setReports(reportsR.data.reports || []);
      setClients(clientsR.data.clients || []);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const iv = setInterval(load, 15000); return () => clearInterval(iv); }, [load]);

  const toggleSetting = async (key, current) => {
    const newVal = !current;
    setSettings(s => ({ ...s, [key]: newVal }));
    await api.post("/api/system/trading/toggle", { enabled: newVal });
    showToast(`Auto-trading ${newVal ? "enabled" : "disabled"}`);
  };

  const emergencyStop = async () => {
    if (!window.confirm("⛔ EMERGENCY STOP — halt all trading immediately?")) return;
    await api.post("/api/system/emergency-stop");
    setSettings(s => ({ ...s, trading_enabled: false }));
    showToast("⛔ Emergency stop activated — all trading halted");
    await load();
  };

  const generateReport = async (e) => {
    e.preventDefault();
    setGenerating(true);
    try {
      const r = await api.post("/api/system/reports/generate", genForm);
      showToast(`✅ Report generated for ${r.data.stats?.period}`);
      await load();
    } catch (e) {
      showToast("❌ " + (e.response?.data?.error || e.message));
    } finally { setGenerating(false); }
  };

  const generateAllReports = async () => {
    if (!window.confirm("Generate monthly reports for ALL active clients?")) return;
    await api.post("/api/system/reports/generate", { all: true });
    showToast("✅ Generating reports for all clients...");
  };

  const tradingEnabled = settings["trading_enabled"] === true || settings["trading_enabled"] === "true";

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">System Control</div>
          <div className="page-subtitle">ENGINE STATUS · CONTROLS · REPORTS</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={load}>↻ Refresh</button>
          <button className="btn btn-danger btn-sm" onClick={emergencyStop}>⛔ Emergency Stop</button>
        </div>
      </div>

      {toast && (
        <div style={{ position: "fixed", top: 20, right: 20, zIndex: 9999, maxWidth: 360 }}>
          <div className={`alert ${toast.startsWith("❌") ? "alert-error" : toast.startsWith("⛔") ? "alert-warn" : "alert-success"}`} style={{ margin: 0 }}>
            {toast}
          </div>
        </div>
      )}

      <div className="page-body">
        {/* System Status */}
        <div className="grid-2" style={{ marginBottom: 16, gap: 16 }}>
          <div className="card">
            <div className="card-header"><span className="card-title">Live Status</span></div>
            {status ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <StatusIndicator online={status.bridge_healthy} label={status.bridge_healthy ? "Bridge Online" : "Bridge Offline"} />
                <StatusIndicator online={tradingEnabled} label={tradingEnabled ? "Auto-Trading Active" : "Auto-Trading Paused"} />
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 8 }}>
                  {[
                    ["Connected Accounts", `${status.connected_accounts}/${status.total_accounts}`],
                    ["Open Trades", status.open_trades],
                    ["System Uptime", `${status.uptime_minutes}min`],
                    ["Last Signal", status.last_signal_minutes_ago != null ? `${status.last_signal_minutes_ago}min ago` : "None"],
                  ].map(([label, value]) => (
                    <div key={label} style={{ background: "var(--bg-elevated)", borderRadius: "var(--radius)", padding: "10px 12px" }}>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 2, color: "var(--text-muted)", marginBottom: 4 }}>
                        {label.toUpperCase()}
                      </div>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>
                        {value}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>Loading...</div>
            )}
          </div>

          {/* Engine Controls */}
          <div className="card">
            <div className="card-header"><span className="card-title">Engine Controls</span></div>
            <ControlToggle
              label="Auto-Trading"
              desc="Execute signals automatically on all connected accounts"
              value={tradingEnabled}
              onChange={() => toggleSetting("trading_enabled", tradingEnabled)}
            />
            <ControlToggle
              label="Signal Generation"
              desc="Generate AI signals every 15 minutes via Claude"
              value={settings["trading_enabled"] !== false}
              onChange={() => toggleSetting("trading_enabled", settings["trading_enabled"] !== false)}
            />
            <div style={{ padding: "14px 0" }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Signal Interval</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                {[5, 10, 15, 30, 60].map(v => (
                  <button key={v}
                    className={`btn btn-sm ${(settings["signal_interval_minutes"] || 15) == v ? "btn-primary" : "btn-ghost"}`}
                    onClick={async () => {
                      setSettings(s => ({ ...s, signal_interval_minutes: v }));
                      await api.put("/api/system/settings", { key: "signal_interval_minutes", value: v });
                      showToast(`Signal interval set to ${v} minutes`);
                    }}>
                    {v}m
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Bridge Setup Guide */}
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--accent-dim)" }}>
          <div className="card-header">
            <span className="card-title">Bridge Setup (Windows)</span>
            <span className="badge accent">Run Once</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Manual Start</div>
              <div style={{ background: "var(--bg-elevated)", borderRadius: "var(--radius)", padding: 12, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--accent)", lineHeight: 2 }}>
                cd python-bridge<br />
                python bridge.py
              </div>
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Auto-Start (Recommended)</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                Double-click <strong>start_bridge.bat</strong> in python-bridge folder.<br />
                Or add it to Windows Task Scheduler to run on startup automatically.
              </div>
            </div>
          </div>
          <div style={{ marginTop: 14, padding: "10px 14px", background: "var(--warn-dim)", borderRadius: "var(--radius)", fontSize: 12, color: "var(--warn)" }}>
            💡 <strong>UptimeRobot Setup:</strong> Go to uptimerobot.com → Add Monitor → HTTP(s) → URL: https://aethelgard-backend-uff7.onrender.com/ping → Interval: 5 min. This prevents Render from sleeping.
          </div>
        </div>

        {/* Monthly Reports */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span className="card-title">Monthly Reports</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-ghost btn-sm" onClick={generateAllReports}>
                📊 Generate All
              </button>
            </div>
          </div>

          {/* Generate single report form */}
          <div style={{ background: "var(--bg-elevated)", borderRadius: "var(--radius)", padding: 16, marginBottom: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12 }}>Generate Report for Client</div>
            <form onSubmit={generateReport} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div>
                <label className="form-label">Client</label>
                <select className="form-select" style={{ width: 180 }} value={genForm.client_id}
                  onChange={e => setGenForm({ ...genForm, client_id: e.target.value })} required>
                  <option value="">Select client...</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.full_name}</option>)}
                </select>
              </div>
              <div>
                <label className="form-label">Month</label>
                <select className="form-select" style={{ width: 120 }} value={genForm.month}
                  onChange={e => setGenForm({ ...genForm, month: parseInt(e.target.value) })}>
                  {Array.from({ length: 12 }, (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      {new Date(2026, i).toLocaleString("en", { month: "long" })}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="form-label">Year</label>
                <input className="form-input" type="number" style={{ width: 90 }}
                  value={genForm.year} onChange={e => setGenForm({ ...genForm, year: parseInt(e.target.value) })} />
              </div>
              <button type="submit" className="btn btn-primary btn-sm" disabled={generating}>
                {generating ? "Generating..." : "📊 Generate"}
              </button>
            </form>
          </div>

          {/* Reports list */}
          {reports.length === 0 ? (
            <div className="empty-state" style={{ padding: 24 }}>
              <div className="empty-icon">📊</div>
              <div className="empty-text">No reports generated yet</div>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Client</th><th>Period</th><th>P&L</th><th>Win Rate</th><th>Split Due</th><th>Status</th><th></th></tr>
                </thead>
                <tbody>
                  {reports.map(r => (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 600 }}>{r.clients?.full_name}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{r.period_label}</td>
                      <td>
                        <span className={parseFloat(r.stats?.total_pnl) >= 0 ? "pnl-pos" : "pnl-neg"}>
                          {parseFloat(r.stats?.total_pnl) >= 0 ? "+" : ""}${r.stats?.total_pnl}
                        </span>
                      </td>
                      <td className="mono">{r.stats?.win_rate}%</td>
                      <td className="mono" style={{ color: "var(--bull)", fontWeight: 700 }}>
                        ${r.stats?.split_amount}
                      </td>
                      <td><span className={`badge ${r.status === "sent" ? "bull" : "accent"}`}>{r.status?.toUpperCase()}</span></td>
                      <td>
                        <button className="btn btn-ghost btn-xs" onClick={() => setSelectedReport(r)}>
                          👁 View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* System Logs */}
        {status?.recent_logs?.length > 0 && (
          <div className="card">
            <div className="card-header"><span className="card-title">Recent System Events</span></div>
            <div style={{ maxHeight: 200, overflowY: "auto" }}>
              {status.recent_logs.map(l => (
                <div key={l.id} className="log-entry">
                  <span className={`log-level ${l.level}`}>{l.level}</span>
                  <span className="log-source">[{l.source}]</span>
                  <span className="log-msg">{l.message}</span>
                  <span className="log-time">{new Date(l.created_at).toLocaleTimeString()}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Report Preview Modal */}
      {selectedReport && (
        <div className="modal-overlay" onClick={() => setSelectedReport(null)}>
          <div className="modal" style={{ width: 700, maxHeight: "85vh" }} onClick={e => e.stopPropagation()}>
            <div className="modal-title" style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Report: {selectedReport.period_label} — {selectedReport.clients?.full_name}</span>
              <button className="btn btn-ghost btn-xs" onClick={() => setSelectedReport(null)}>✕</button>
            </div>
            <iframe
              srcDoc={selectedReport.html_content}
              style={{ width: "100%", height: 500, border: "1px solid var(--border)", borderRadius: "var(--radius)" }}
              title="Report Preview"
            />
          </div>
        </div>
      )}
    </>
  );
}
