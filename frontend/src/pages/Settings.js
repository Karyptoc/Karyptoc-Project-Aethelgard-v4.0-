import React, { useState, useEffect } from "react";
import api from "../lib/api";

export default function Settings() {
  const [settings, setSettings] = useState({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get("/api/dashboard/settings").then(r => setSettings(r.data.settings || {}));
  }, []);

  const save = async (key, value) => {
    await api.put("/api/dashboard/settings", { key, value });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const toggle = (key) => {
    const newVal = !settings[key];
    setSettings(s => ({ ...s, [key]: newVal }));
    save(key, newVal);
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Platform Settings</div>
          <div className="page-subtitle">SYSTEM CONFIGURATION</div>
        </div>
        {saved && <span className="badge bull">✓ SAVED</span>}
      </div>
      <div className="page-body">
        <div style={{ maxWidth: 600, display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card">
            <div className="card-title" style={{ marginBottom: 16 }}>Trading Engine</div>
            {[
              { key: "trading_enabled", label: "Auto-Trading Enabled", desc: "Allow system to automatically execute signals" },
            ].map(({ key, label, desc }) => (
              <div key={key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: "1px solid var(--border)" }}>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{label}</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}>{desc}</div>
                </div>
                <button
                  className={`btn btn-sm ${settings[key] ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => toggle(key)}
                >
                  {settings[key] ? "ENABLED" : "DISABLED"}
                </button>
              </div>
            ))}
            <div style={{ padding: "12px 0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Signal Interval</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}>How often to generate new signals (minutes)</div>
                </div>
                <select className="form-select" style={{ width: 100 }}
                  value={settings["signal_interval_minutes"] || 15}
                  onChange={e => { setSettings(s => ({...s, signal_interval_minutes: parseInt(e.target.value)})); save("signal_interval_minutes", parseInt(e.target.value)); }}>
                  {[5, 10, 15, 30, 60].map(v => <option key={v} value={v}>{v} min</option>)}
                </select>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 16 }}>Risk Defaults</div>
            {[
              { key: "default_risk_percent", label: "Default Risk Per Trade (%)", min: 0.1, max: 5, step: 0.1 },
              { key: "circuit_breaker_daily_loss_pct", label: "Daily Loss Circuit Breaker (%)", min: 1, max: 20, step: 0.5 },
              { key: "max_concurrent_trades", label: "Max Concurrent Trades", min: 1, max: 20, step: 1 },
            ].map(({ key, label, min, max, step }) => (
              <div key={key} style={{ padding: "12px 0", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 600 }}>{label}</div>
                <input type="number" className="form-input" style={{ width: 100 }}
                  min={min} max={max} step={step}
                  value={settings[key] || ""}
                  onChange={e => setSettings(s => ({...s, [key]: parseFloat(e.target.value)}))}
                  onBlur={e => save(key, parseFloat(e.target.value))} />
              </div>
            ))}
          </div>

          <div className="card" style={{ borderColor: "rgba(248,81,73,0.3)" }}>
            <div className="card-title" style={{ marginBottom: 12, color: "var(--bear)" }}>Danger Zone</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)", marginBottom: 12 }}>
              Emergency controls — use with caution
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-danger" onClick={() => save("trading_enabled", false)}>
                ⛔ HALT ALL TRADING
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
