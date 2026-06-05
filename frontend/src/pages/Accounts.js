import React, { useState, useEffect } from "react";
import api from "../lib/api";

const PAIRS = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY"];

const EMPTY = {
  label: "", login: "", server: "XMTrading-MT5", password: "",
  account_type: "demo", risk_percent: 1.0,
  max_daily_loss: 5.0, max_trades: 5,
  allowed_pairs: ["XAUUSD","EURUSD","GBPUSD","USDJPY"]
};

export default function Accounts() {
  const [accounts, setAccounts] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    const r = await api.get("/api/accounts");
    setAccounts(r.data.accounts || []);
  };

  useEffect(() => { load(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      await api.post("/api/accounts", form);
      setShowModal(false); setForm(EMPTY);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || "Failed to add account");
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (id, current) => {
    await api.put(`/api/accounts/${id}`, { is_active: !current });
    await load();
  };

  const togglePair = (pair) => {
    setForm(f => ({
      ...f,
      allowed_pairs: f.allowed_pairs.includes(pair)
        ? f.allowed_pairs.filter(p => p !== pair)
        : [...f.allowed_pairs, pair]
    }));
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">MT5 Accounts</div>
          <div className="page-subtitle">MANAGE TRADING ACCOUNTS · {accounts.length} REGISTERED</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>
          + ADD ACCOUNT
        </button>
      </div>

      <div className="page-body">
        {accounts.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">⬡</div>
            <div className="empty-text">No accounts added yet. Add your first MT5 account.</div>
          </div>
        ) : (
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Login</th>
                  <th>Server</th>
                  <th>Type</th>
                  <th>Balance</th>
                  <th>Equity</th>
                  <th>P&L</th>
                  <th>Risk %</th>
                  <th>Status</th>
                  <th>Last Sync</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {accounts.map(acc => (
                  <tr key={acc.id}>
                    <td style={{ fontWeight: 700, color: "var(--text-primary)" }}>{acc.label}</td>
                    <td className="mono">{acc.login}</td>
                    <td className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>{acc.server}</td>
                    <td>
                      <span className={`badge ${acc.account_type === "live" ? "bear" : "blue"}`}>
                        {acc.account_type.toUpperCase()}
                      </span>
                    </td>
                    <td className="mono">${(acc.balance || 0).toFixed(2)}</td>
                    <td className="mono">${(acc.equity || 0).toFixed(2)}</td>
                    <td>
                      <span className={(acc.profit || 0) >= 0 ? "pnl-pos" : "pnl-neg"}>
                        {(acc.profit || 0) >= 0 ? "+" : ""}{(acc.profit || 0).toFixed(2)}
                      </span>
                    </td>
                    <td className="mono">{acc.risk_percent}%</td>
                    <td>
                      <div style={{ display: "flex", gap: 6 }}>
                        <span className={`badge ${acc.is_connected ? "bull" : "muted"}`}>
                          {acc.is_connected ? "LIVE" : "OFFLINE"}
                        </span>
                        <span className={`badge ${acc.is_active ? "accent" : "muted"}`}>
                          {acc.is_active ? "ON" : "OFF"}
                        </span>
                      </div>
                    </td>
                    <td className="mono" style={{ fontSize: 10, color: "var(--text-muted)" }}>
                      {acc.last_sync ? new Date(acc.last_sync).toLocaleString() : "Never"}
                    </td>
                    <td>
                      <button
                        className={`btn btn-sm ${acc.is_active ? "btn-ghost" : "btn-primary"}`}
                        onClick={() => toggleActive(acc.id, acc.is_active)}
                      >
                        {acc.is_active ? "DISABLE" : "ENABLE"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Bridge instructions */}
        <div className="card" style={{ marginTop: 20, borderColor: "var(--accent-glow)" }}>
          <div className="card-header">
            <span className="card-title">Bridge Setup</span>
            <span className="badge accent">REQUIRED</span>
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-secondary)", lineHeight: 2 }}>
            <div>1. Ensure MetaTrader 5 is running on your Windows machine</div>
            <div>2. Edit <span style={{ color: "var(--accent)" }}>python-bridge/.env</span> with your backend URL and bridge secret</div>
            <div>3. Run: <span style={{ color: "var(--accent)" }}>pip install -r requirements.txt</span></div>
            <div>4. Start bridge: <span style={{ color: "var(--accent)" }}>python bridge.py</span></div>
            <div>5. Account status will change to LIVE within 30 seconds</div>
          </div>
        </div>
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Add MT5 Account</div>
            {error && <div className="alert alert-error">{error}</div>}
            <form onSubmit={submit}>
              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">Label</label>
                  <input className="form-input" value={form.label}
                    onChange={e => setForm({...form, label: e.target.value})}
                    placeholder="My XM Demo" required />
                </div>
                <div className="form-group">
                  <label className="form-label">Account Type</label>
                  <select className="form-select" value={form.account_type}
                    onChange={e => setForm({...form, account_type: e.target.value})}>
                    <option value="demo">Demo</option>
                    <option value="live">Live</option>
                  </select>
                </div>
              </div>
              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">MT5 Login Number</label>
                  <input className="form-input" value={form.login}
                    onChange={e => setForm({...form, login: e.target.value})}
                    placeholder="12345678" required />
                </div>
                <div className="form-group">
                  <label className="form-label">Password</label>
                  <input className="form-input" type="password" value={form.password}
                    onChange={e => setForm({...form, password: e.target.value})}
                    placeholder="MT5 password" required />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Server</label>
                <input className="form-input" value={form.server}
                  onChange={e => setForm({...form, server: e.target.value})}
                  placeholder="XMTrading-MT5" required />
              </div>
              <div className="grid-3">
                <div className="form-group">
                  <label className="form-label">Risk Per Trade %</label>
                  <input className="form-input" type="number" step="0.1" min="0.1" max="5"
                    value={form.risk_percent}
                    onChange={e => setForm({...form, risk_percent: parseFloat(e.target.value)})} />
                </div>
                <div className="form-group">
                  <label className="form-label">Max Daily Loss %</label>
                  <input className="form-input" type="number" step="0.5" min="1" max="20"
                    value={form.max_daily_loss}
                    onChange={e => setForm({...form, max_daily_loss: parseFloat(e.target.value)})} />
                </div>
                <div className="form-group">
                  <label className="form-label">Max Open Trades</label>
                  <input className="form-input" type="number" min="1" max="20"
                    value={form.max_trades}
                    onChange={e => setForm({...form, max_trades: parseInt(e.target.value)})} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Allowed Pairs</label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {PAIRS.map(pair => (
                    <button key={pair} type="button"
                      className={`btn btn-sm ${form.allowed_pairs.includes(pair) ? "btn-primary" : "btn-ghost"}`}
                      onClick={() => togglePair(pair)}>
                      {pair}
                    </button>
                  ))}
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-ghost" onClick={() => setShowModal(false)}>CANCEL</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? "SAVING..." : "ADD ACCOUNT"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
