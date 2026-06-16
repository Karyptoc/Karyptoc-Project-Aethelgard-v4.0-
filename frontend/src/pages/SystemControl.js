import React, { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@supabase/supabase-js";
import api from "../lib/api";

const supabase = createClient(
  process.env.REACT_APP_SUPABASE_URL,
  process.env.REACT_APP_SUPABASE_ANON_KEY
);

function StatusDot({ online }) {
  return (
    <div style={{
      width: 10, height: 10, borderRadius: "50%", flexShrink: 0,
      background: online ? "var(--bull)" : "var(--bear)",
      boxShadow: online ? "0 0 8px var(--bull)" : "none"
    }} />
  );
}

export default function SystemControl() {
  const [status, setStatus] = useState(null);
  const [settings, setSettings] = useState({
    trading_enabled: false,
    signal_interval_minutes: 15
  });
  const [reports, setReports] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [toast, setToast] = useState("");
  const [selectedReport, setSelectedReport] = useState(null);
  const [genForm, setGenForm] = useState({
    client_id: "",
    month: new Date().getMonth() === 0 ? 12 : new Date().getMonth(),
    year: new Date().getFullYear()
  });

  // Prevents interval re-fetch from overwriting in-progress toggle changes
  const pendingChange = useRef(false);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(""), 4000); };

  const loadSettings = useCallback(async () => {
    if (pendingChange.current) return; // block re-fetch during toggle
    const { data } = await supabase
      .from("platform_settings")
      .select("key, value");
    if (data) {
      const s = {};
      data.forEach(row => { s[row.key] = row.value; });
      setSettings({
        trading_enabled: s["trading_enabled"] === true || s["trading_enabled"] === "true",
        signal_interval_minutes: parseInt(s["signal_interval_minutes"]) || 15,
        ...s
      });
    }
  }, []);

  const loadClients = useCallback(async () => {
    const { data } = await supabase.from("clients").select("*").eq("status", "active");
    if (data) setClients(data);
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const r = await api.get("/api/system/status");
      setStatus(r.data.status);
    } catch (e) { console.error(e); }
  }, []);

  const loadReports = useCallback(async () => {
    try {
      const r = await api.get("/api/system/reports");
      setReports(r.data.reports || []);
    } catch (e) {}
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadSettings(), loadClients(), loadStatus(), loadReports()]);
    setLoading(false);
  }, [loadSettings, loadClients, loadStatus, loadReports]);

  useEffect(() => {
    load();
    const iv = setInterval(() => {
      loadStatus();
      loadSettings(); // blocked by pendingChange during toggle
    }, 30000);
    return () => clearInterval(iv);
  }, [load, loadStatus, loadSettings]);

  const saveSetting = async (key, value) => {
    pendingChange.current = true;
    // Optimistic update immediately
    setSettings(s => ({ ...s, [key]: value }));
    await supabase
      .from("platform_settings")
      .upsert({ key, value }, { onConflict: "key" });
    // Keep blocked for 3s to survive any in-flight interval poll
    setTimeout(() => { pendingChange.current = false; }, 3000);
  };

  const toggleTrading = async () => {
    const newVal = !settings.trading_enabled;
    await saveSetting("trading_enabled", newVal);
    showToast(`Auto-trading ${newVal ? "✅ enabled" : "⏸ paused"}`);
  };

  const setInterval_ = async (minutes) => {
    await saveSetting("signal_interval_minutes", minutes);
    showToast(`Signal interval set to ${minutes} minutes`);
  };

  const emergencyStop = async () => {
    if (!window.confirm("⛔ EMERGENCY STOP — halt all trading immediately?")) return;
    await saveSetting("trading_enabled", false);
    showToast("⛔ Emergency stop — all trading halted");
  };

  const generateReport = async (e) => {
    e.preventDefault();
    if (!genForm.client_id) { showToast("Please select a client"); return; }
    setGenerating(true);
    try {
      const r = await api.post("/api/system/reports/generate", genForm);
      showToast(`✅ Report generated: ${r.data.stats?.period}`);
      await loadReports();
    } catch (e) {
      showToast("❌ " + (e.response?.data?.error || e.message));
    } finally { setGenerating(false); }
  };

  const generateAllReports = async () => {
    if (!window.confirm("Generate monthly reports for ALL active clients?")) return;
    await api.post("/api/system/reports/generate", { all: true });
    showToast("✅ Generating reports for all clients...");
  };

  const tradingEnabled = settings.trading_enabled === true || settings.trading_enabled === "true";
  const signalInterval = parseInt(settings.signal_interval_minutes) || 15;

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
        <div className="grid-2" style={{ marginBottom: 16, gap: 16 }}>
          {/* Live Status */}
          <div className="card">
            <div className="card-header"><span className="card-title">Live Status</span></div>
            {status ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <StatusDot online={status.bridge_healthy} />
                  <span style={{ fontWeight: 600, color: status.bridge_healthy ? "var(--bull)" : "var(--bear)" }}>
                    {status.bridge_healthy ? "Bridge Online" : "Bridge Offline"}
                  </span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <StatusDot online={tradingEnabled} />
                  <span style={{ fontWeight: 600, color: tradingEnabled ? "var(--bull)" : "var(--warn)" }}>
                    {tradingEnabled ? "Auto-Trading Active" : "Auto-Trading Paused"}
                  </span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 4 }}>
                  {[
                    ["Accounts", `${status.connected_accounts}/${status.total_accounts}`],
                    ["Open Trades", status.open_trades],
                    ["Uptime", `${status.uptime_minutes}min`],
                    ["Last Signal", status.last_signal_minutes_ago != null ? `${status.last_signal_minutes_ago}min ago` : "None"],
                  ].map(([label, value]) => (
                    <div key={label} style={{ background: "var(--bg-elevated)", borderRadius: "var(--radius)", padding: "10px 12px" }}>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 2, color: "var(--text-muted)", marginBottom: 4 }}>{label.toUpperCase()}</div>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 16, fontWeight: 700 }}>{value}</div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {loading ? "Loading..." : "Status unavailable"}
              </div>
            )}
          </div>

          {/* Engine Controls */}
          <div className="card">
            <div className="card-header"><span className="card-title">Engine Controls</span></div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 0", borderBottom: "1px solid var(--border)" }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>Auto-Trading</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Execute signals automatically on connected accounts</div>
              </div>
              <button onClick={toggleTrading} style={{
                width: 52, height: 28, borderRadius: 14, border: "none", cursor: "pointer",
                background: tradingEnabled ? "var(--bull)" : "var(--border)",
                position: "relative", transition: "background 0.2s", flexShrink: 0
              }}>
                <div style={{
                  width: 22, height: 22, borderRadius: "50%", background: "white",
                  position: "absolute", top: 3, left: tradingEnabled ? 26 : 4,
                  transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)"
                }} />
              </button>
            </div>

            <div style={{ padding: "14px 0" }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Signal Interval</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {[5, 10, 15, 30, 60].map(v => (
                  <button key={v}
                    className={`btn btn-sm ${signalInterval === v ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setInterval_(v)}>
                    {v}m
                  </button>
                ))}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, fontFamily: "var(--font-mono)" }}>
                Current: every {signalInterval} minutes
              </div>
            </div>
          </div>
        </div>

        {/* Bridge Setup */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span className="card-title">Bridge Setup (Windows)</span>
            <span className="badge accent">Run on your PC</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Manual Start</div>
              <div style={{ background: "var(--bg-elevated)", borderRadius: "var(--radius)", padding: 12, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--accent)", lineHeight: 2 }}>
                cd python-bridge<br />python bridge.py
              </div>
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Auto-Start (Recommended)</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                Double-click <strong>start_bridge.bat</strong> in python-bridge folder.<br />
                Restarts automatically if it crashes.
              </div>
            </div>
          </div>
          <div style={{ marginTop: 12, padding: "10px 14px", background: "var(--warn-dim)", borderRadius: "var(--radius)", fontSize: 12, color: "var(--warn)" }}>
            💡 <strong>UptimeRobot:</strong> uptimerobot.com → Add Monitor → HTTP(s) → <code>https://aethelgard-backend-uff7.onrender.com/ping</code> → 5 min interval
          </div>
        </div>

        {/* Monthly Reports */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Monthly Reports</span>
            <button className="btn btn-ghost btn-sm" onClick={generateAllReports}>📊 Generate All</button>
          </div>

          <div style={{ background: "var(--bg-elevated)", borderRadius: "var(--radius)", padding: 16, marginBottom: 16 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12 }}>Generate Report</div>
            <form onSubmit={generateReport} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div>
                <label className="form-label">Client</label>
                <select className="form-select" style={{ width: 180 }}
                  value={genForm.client_id}
                  onChange={e => setGenForm({ ...genForm, client_id: e.target.value })} required>
                  <option value="">Select client...</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.full_name}</option>)}
                </select>
              </div>
              <div>
                <label className="form-label">Month</label>
                <select className="form-select" style={{ width: 130 }}
                  value={genForm.month}
                  onChange={e => setGenForm({ ...genForm, month: parseInt(e.target.value) })}>
                  {Array.from({ length: 12 }, (_, i) => (
                    <option key={i+1} value={i+1}>
                      {new Date(2026, i).toLocaleString("en", { month: "long" })}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="form-label">Year</label>
                <input className="form-input" type="number" style={{ width: 90 }}
                  value={genForm.year}
                  onChange={e => setGenForm({ ...genForm, year: parseInt(e.target.value) })} />
              </div>
              <button type="submit" className="btn btn-primary btn-sm" disabled={generating}>
                {generating ? "Generating..." : "📊 Generate"}
              </button>
            </form>
          </div>

          {reports.length === 0 ? (
            <div className="empty-state" style={{ padding: 32 }}>
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
                      <td><span className={parseFloat(r.stats?.total_pnl) >= 0 ? "pnl-pos" : "pnl-neg"}>
                        {parseFloat(r.stats?.total_pnl) >= 0 ? "+" : ""}${r.stats?.total_pnl}
                      </span></td>
                      <td className="mono">{r.stats?.win_rate}%</td>
                      <td style={{ fontWeight: 700, color: "var(--bull)" }}>${r.stats?.split_amount}</td>
                      <td><span className={`badge ${r.status === "sent" ? "bull" : "accent"}`}>{r.status?.toUpperCase()}</span></td>
                      <td><button className="btn btn-ghost btn-xs" onClick={() => setSelectedReport(r)}>👁 View</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {selectedReport && (
        <div className="modal-overlay" onClick={() => setSelectedReport(null)}>
          <div className="modal" style={{ width: 700, maxHeight: "85vh" }} onClick={e => e.stopPropagation()}>
            <div className="modal-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>{selectedReport.period_label} – {selectedReport.clients?.full_name}</span>
              <button className="btn btn-ghost btn-xs" onClick={() => setSelectedReport(null)}>✕</button>
            </div>
            <iframe srcDoc={selectedReport.html_content}
              style={{ width: "100%", height: 500, border: "1px solid var(--border)", borderRadius: "var(--radius)" }}
              title="Report Preview" />
          </div>
        </div>
      )}
    </>
  );
}
