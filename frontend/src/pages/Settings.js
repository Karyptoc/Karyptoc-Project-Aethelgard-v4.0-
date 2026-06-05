import React, { useState, useEffect } from "react";
import api from "../lib/api";

export default function Settings() {
  const [settings, setSettings] = useState({});
  const [saved, setSaved] = useState(false);
  const [tgForm, setTgForm] = useState(() => JSON.parse(localStorage.getItem("tg_config") || "{}"));
  const [testing, setTesting] = useState(false);

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

  const saveTelegram = () => {
    localStorage.setItem("tg_config", JSON.stringify(tgForm));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const testTelegram = async () => {
    setTesting(true);
    try {
      const r = await fetch(`https://api.telegram.org/bot${tgForm.bot_token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: tgForm.chat_id,
          text: "✅ *Aethelgard* connected successfully! Trading signals will be sent here.",
          parse_mode: "Markdown"
        })
      });
      const data = await r.json();
      if (data.ok) alert("✅ Test message sent to Telegram!");
      else alert("❌ Failed: " + data.description);
    } catch (e) {
      alert("❌ Error: " + e.message);
    } finally { setTesting(false); }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Settings</div>
          <div className="page-subtitle">PLATFORM CONFIGURATION</div>
        </div>
        {saved && <span className="badge bull">✓ SAVED</span>}
      </div>

      <div className="page-body">
        <div style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 16 }}>

          {/* Trading Engine */}
          <div className="card">
            <div className="card-header"><span className="card-title">Trading Engine</span></div>

            <div className="toggle-wrap">
              <div className="toggle-info">
                <div className="toggle-label">Auto-Trading Enabled</div>
                <div className="toggle-desc">Allow system to automatically execute signals on connected accounts</div>
              </div>
              <button className={`toggle ${settings["trading_enabled"] ? "on" : ""}`}
                onClick={() => toggle("trading_enabled")} />
            </div>

            <div style={{ padding: "12px 0", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Signal Interval</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>How often to generate new signals</div>
              </div>
              <select className="form-select" style={{ width: 110 }}
                value={settings["signal_interval_minutes"] || 15}
                onChange={e => { setSettings(s => ({ ...s, signal_interval_minutes: parseInt(e.target.value) })); save("signal_interval_minutes", parseInt(e.target.value)); }}>
                {[5, 10, 15, 30, 60].map(v => <option key={v} value={v}>{v} min</option>)}
              </select>
            </div>

            <div style={{ padding: "12px 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Max Concurrent Trades</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Maximum open positions at once</div>
              </div>
              <input type="number" className="form-input" style={{ width: 80 }} min={1} max={20}
                value={settings["max_concurrent_trades"] || 5}
                onChange={e => setSettings(s => ({ ...s, max_concurrent_trades: parseInt(e.target.value) }))}
                onBlur={e => save("max_concurrent_trades", parseInt(e.target.value))} />
            </div>
          </div>

          {/* Risk Management */}
          <div className="card">
            <div className="card-header"><span className="card-title">Risk Management</span></div>
            {[
              { key: "default_risk_percent", label: "Default Risk Per Trade (%)", desc: "% of balance risked per trade", min: 0.1, max: 5, step: 0.1 },
              { key: "circuit_breaker_daily_loss_pct", label: "Daily Loss Circuit Breaker (%)", desc: "Halt trading if daily loss exceeds this", min: 1, max: 20, step: 0.5 },
            ].map(({ key, label, desc, min, max, step }) => (
              <div key={key} style={{ padding: "12px 0", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{label}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{desc}</div>
                </div>
                <input type="number" className="form-input" style={{ width: 90 }}
                  min={min} max={max} step={step}
                  value={settings[key] || ""}
                  onChange={e => setSettings(s => ({ ...s, [key]: parseFloat(e.target.value) }))}
                  onBlur={e => save(key, parseFloat(e.target.value))} />
              </div>
            ))}
          </div>

          {/* Telegram Integration */}
          <div className="card">
            <div className="card-header">
              <span className="card-title">Telegram Alerts</span>
              {tgForm.bot_token && <span className="tg-badge">✈️ Connected</span>}
            </div>
            <div className="alert alert-info" style={{ fontSize: 12, marginBottom: 16 }}>
              <strong>Setup:</strong> Message @BotFather → /newbot → copy token. Add bot to your channel/group. Get chat ID from @userinfobot.
            </div>
            <div className="form-group">
              <label className="form-label">Bot Token</label>
              <input className="form-input" placeholder="1234567890:AAFxxx..." value={tgForm.bot_token || ""}
                onChange={e => setTgForm({ ...tgForm, bot_token: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Chat ID / Channel</label>
              <input className="form-input" placeholder="-1001234567890 or @channel" value={tgForm.chat_id || ""}
                onChange={e => setTgForm({ ...tgForm, chat_id: e.target.value })} />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-primary" onClick={saveTelegram}>Save Config</button>
              <button className="btn btn-ghost" onClick={testTelegram} disabled={testing || !tgForm.bot_token}>
                {testing ? "Sending..." : "Send Test Message"}
              </button>
            </div>
          </div>

          {/* Danger Zone */}
          <div className="card" style={{ borderColor: "var(--bear)", borderWidth: 1 }}>
            <div className="card-header">
              <span className="card-title" style={{ color: "var(--bear)" }}>Danger Zone</span>
            </div>
            <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 14 }}>
              Emergency controls — these actions affect all connected accounts immediately.
            </div>
            <button className="btn btn-danger" onClick={() => { if(window.confirm("Halt all trading?")) save("trading_enabled", false); }}>
              ⛔ Halt All Trading
            </button>
          </div>

        </div>
      </div>
    </>
  );
}
