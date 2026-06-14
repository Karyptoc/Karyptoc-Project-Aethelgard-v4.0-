import React, { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import axios from "axios";

const API_BASE = process.env.REACT_APP_API_URL || "https://aethelgard-backend-uff7.onrender.com";

function api(token) {
  return axios.create({
    baseURL: API_BASE,
    headers: { "x-portal-token": token, "Content-Type": "application/json" }
  });
}

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{ background: "var(--bg-elevated)", borderRadius: "var(--radius)", padding: "14px 16px" }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 2, color: "var(--text-muted)", marginBottom: 6 }}>
        {label.toUpperCase()}
      </div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 22, fontWeight: 700, color: color || "var(--text-primary)" }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function MT5ConnectForm({ token, onConnected }) {
  const [form, setForm] = useState({ mt5_login: "", mt5_password: "", mt5_server: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    if (!form.mt5_login || !form.mt5_password || !form.mt5_server) {
      return setError("All fields required");
    }
    setLoading(true);
    setError("");
    try {
      await api(token).post("/api/copy-trading/portal/connect-mt5", form);
      onConnected();
    } catch (e) {
      setError(e.response?.data?.error || "Connection failed");
    } finally {
      setLoading(false);
    }
  };

  const downloadBridge = () => {
    window.open(`${API_BASE}/api/copy-trading/portal/bridge-script?token=${token}`, "_blank");
  };

  return (
    <div className="card" style={{ maxWidth: 480, margin: "0 auto" }}>
      <div className="card-header"><span className="card-title">Connect your MT5 account</span></div>
      <div style={{ marginBottom: 20 }}>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16 }}>
          Choose how to connect your MetaTrader 5 account to start copy trading.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
          <div style={{ border: "2px solid var(--accent)", borderRadius: "var(--radius)", padding: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Option A — Credentials</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Enter your MT5 login below. Your broker handles execution on our server.</div>
          </div>
          <div style={{ border: "0.5px solid var(--border)", borderRadius: "var(--radius)", padding: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Option B — Local bridge</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Run a small script on your PC. MT5 stays on your machine.</div>
            <button className="btn btn-ghost btn-xs" style={{ marginTop: 8 }} onClick={downloadBridge}>
              Download script
            </button>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <label className="form-label">MT5 Login number</label>
            <input className="form-input" placeholder="e.g. 334414473"
              value={form.mt5_login} onChange={e => setForm({...form, mt5_login: e.target.value})} />
          </div>
          <div>
            <label className="form-label">MT5 Password</label>
            <input className="form-input" type="password" placeholder="Your MT5 password"
              value={form.mt5_password} onChange={e => setForm({...form, mt5_password: e.target.value})} />
          </div>
          <div>
            <label className="form-label">MT5 Server</label>
            <input className="form-input" placeholder="e.g. XMGlobal-MT5 9"
              value={form.mt5_server} onChange={e => setForm({...form, mt5_server: e.target.value})} />
          </div>
        </div>

        {error && <div className="alert alert-error" style={{ marginTop: 10 }}>{error}</div>}

        <button className="btn btn-primary" style={{ width: "100%", marginTop: 14 }}
          onClick={handleSubmit} disabled={loading}>
          {loading ? "Connecting..." : "Connect MT5 Account"}
        </button>
        <p style={{ fontSize: 11, color: "var(--text-muted)", textAlign: "center", marginTop: 8 }}>
          Your credentials are encrypted and used only for trade execution.
        </p>
      </div>
    </div>
  );
}

export default function ClientPortalPublic() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);
  const [trades, setTrades] = useState([]);
  const [activeTab, setActiveTab] = useState("overview");
  const [showConnect, setShowConnect] = useState(false);

  const loadData = async () => {
    if (!token) { setError("No access token provided"); setLoading(false); return; }
    try {
      const [meRes, tradesRes] = await Promise.all([
        api(token).get("/api/copy-trading/portal/me"),
        api(token).get("/api/copy-trading/portal/trades")
      ]);
      setData(meRes.data);
      setTrades(tradesRes.data.trades || []);
    } catch (e) {
      setError(e.response?.data?.error || "Invalid or expired access link");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, [token]);

  if (loading) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--bg-primary)", flexDirection: "column", gap: 12 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 20, color: "var(--accent)" }}>Æ</div>
      <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading your account...</div>
    </div>
  );

  if (error) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--bg-primary)", flexDirection: "column", gap: 16 }}>
      <div style={{ fontSize: 32 }}>🔒</div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>Access denied</div>
      <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{error}</div>
    </div>
  );

  const { account, today, history } = data;
  const pnlColor = (v) => parseFloat(v) >= 0 ? "var(--bull)" : "var(--bear)";
  const pnlSign = (v) => parseFloat(v) >= 0 ? "+" : "";

  const totalReturn = account.total_return_pct;
  const weekPnl = history.slice(-7).reduce((s, d) => s + d.net_pnl, 0);
  const monthPnl = history.reduce((s, d) => s + d.net_pnl, 0);

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-primary)", color: "var(--text-primary)",
      fontFamily: "var(--font-sans)" }}>
      {/* Header */}
      <div style={{ borderBottom: "0.5px solid var(--border)", padding: "12px 24px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        background: "var(--bg-elevated)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 18, fontWeight: 700, color: "var(--accent)" }}>Æ</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700 }}>Aethelgard</div>
            <div style={{ fontSize: 10, color: "var(--text-muted)" }}>QUANT ENGINE — CLIENT PORTAL</div>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{account.name}</div>
          <div style={{ fontSize: 10, color: account.is_connected ? "var(--bull)" : "var(--warn)" }}>
            {account.is_connected ? "● CONNECTED" : "○ DISCONNECTED"}
          </div>
        </div>
      </div>

      <div style={{ padding: "20px 24px", maxWidth: 960, margin: "0 auto" }}>
        {/* Connection banner */}
        {!account.is_connected && !showConnect && (
          <div className="alert alert-warn" style={{ marginBottom: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>⚡ Your MT5 account is not connected. Connect now to start copy trading.</span>
            <button className="btn btn-primary btn-sm" onClick={() => setShowConnect(true)}>Connect MT5</button>
          </div>
        )}

        {showConnect && (
          <div style={{ marginBottom: 20 }}>
            <MT5ConnectForm token={token} onConnected={() => { setShowConnect(false); loadData(); }} />
          </div>
        )}

        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10, marginBottom: 20 }}>
          <StatCard label="Account balance" value={`$${parseFloat(account.balance || 0).toFixed(2)}`} />
          <StatCard label="Equity" value={`$${parseFloat(account.equity || 0).toFixed(2)}`} />
          <StatCard label="Total return"
            value={`${pnlSign(totalReturn)}${totalReturn}%`}
            color={pnlColor(totalReturn)}
            sub={`$${pnlSign(account.total_pnl)}${parseFloat(account.total_pnl||0).toFixed(2)}`} />
          <StatCard label="Today P&L"
            value={`${pnlSign(today.net_pnl)}$${parseFloat(today.net_pnl||0).toFixed(2)}`}
            color={pnlColor(today.net_pnl)}
            sub={`${today.trades_count} trades`} />
          <StatCard label="This week"
            value={`${pnlSign(weekPnl)}$${weekPnl.toFixed(2)}`}
            color={pnlColor(weekPnl)} />
          <StatCard label="This month"
            value={`${pnlSign(monthPnl)}$${monthPnl.toFixed(2)}`}
            color={pnlColor(monthPnl)} />
          <StatCard label="Today win rate"
            value={today.trades_count > 0
              ? `${Math.round(today.winning_trades / today.trades_count * 100)}%`
              : "—"}
            sub={`${today.winning_trades}W / ${today.losing_trades}L`}
            color="var(--accent)" />
          <StatCard label="Performance fee"
            value={`$${parseFloat(account.pending_fee||0).toFixed(2)}`}
            sub={`${account.performance_fee_pct}% of profits`}
            color="var(--text-muted)" />
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          {["overview","history","trades"].map(tab => (
            <button key={tab} className={`btn btn-sm ${activeTab === tab ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setActiveTab(tab)}>
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Overview */}
        {activeTab === "overview" && (
          <div className="card">
            <div className="card-header"><span className="card-title">How copy trading works</span></div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 13 }}>
              <div style={{ padding: "10px 14px", background: "var(--bg-elevated)", borderRadius: "var(--radius)", borderLeft: "3px solid var(--accent)" }}>
                <strong>Automatic execution</strong> — When the Aethelgard engine generates a signal, your account executes the same trade proportionally to your capital. No action needed from you.
              </div>
              <div style={{ padding: "10px 14px", background: "var(--bg-elevated)", borderRadius: "var(--radius)", borderLeft: "3px solid var(--bull)" }}>
                <strong>Proportional sizing</strong> — Lot sizes are calculated based on your balance relative to the master account. A $5,000 account trades 5x smaller lots than a $25,000 account.
              </div>
              <div style={{ padding: "10px 14px", background: "var(--bg-elevated)", borderRadius: "var(--radius)", borderLeft: "3px solid var(--warn)" }}>
                <strong>Performance fee</strong> — {account.performance_fee_pct}% of net profits. Only charged on winning trades. Calculated daily and collected monthly.
              </div>
              <div style={{ padding: "10px 14px", background: "var(--bg-elevated)", borderRadius: "var(--radius)", borderLeft: "3px solid var(--text-muted)" }}>
                <strong>Transparency</strong> — You can see every trade taken on your account, which pairs were traded, the result, and your P&L updated in real time.
              </div>
            </div>
          </div>
        )}

        {/* History */}
        {activeTab === "history" && (
          <div className="card">
            <div className="card-header"><span className="card-title">Daily P&L — last 30 days</span></div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Date</th><th>Trades</th><th>Win/Loss</th><th>Gross P&L</th><th>Fee ({account.performance_fee_pct}%)</th><th>Net P&L</th></tr>
                </thead>
                <tbody>
                  {history.length === 0 && (
                    <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--text-muted)", padding: 24 }}>No history yet</td></tr>
                  )}
                  {[...history].reverse().map((day, i) => (
                    <tr key={i}>
                      <td className="mono" style={{ fontSize: 12 }}>{new Date(day.date).toLocaleDateString()}</td>
                      <td className="mono">{day.trades_count}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{day.winning_trades}W / {day.losing_trades}L</td>
                      <td className="mono"><span className={day.gross_pnl >= 0 ? "pnl-pos" : "pnl-neg"}>{pnlSign(day.gross_pnl)}${parseFloat(day.gross_pnl||0).toFixed(2)}</span></td>
                      <td className="mono" style={{ color: "var(--text-muted)" }}>-${parseFloat(day.performance_fee||0).toFixed(2)}</td>
                      <td className="mono"><span className={day.net_pnl >= 0 ? "pnl-pos" : "pnl-neg"}>{pnlSign(day.net_pnl)}${parseFloat(day.net_pnl||0).toFixed(2)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Trades */}
        {activeTab === "trades" && (
          <div className="card">
            <div className="card-header">
              <span className="card-title">Trade history</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Pair and result shown — exact prices withheld</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Time</th><th>Pair</th><th>Direction</th><th>Lots</th><th>Result</th><th>P&L</th></tr>
                </thead>
                <tbody>
                  {trades.length === 0 && (
                    <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--text-muted)", padding: 24 }}>No trades yet</td></tr>
                  )}
                  {trades.map((t, i) => (
                    <tr key={i}>
                      <td className="mono" style={{ fontSize: 11 }}>{new Date(t.open_time).toLocaleString()}</td>
                      <td style={{ fontWeight: 700 }}>{t.symbol}</td>
                      <td><span className={`badge ${t.direction === "BUY" ? "bull" : "bear"}`}>{t.direction}</span></td>
                      <td className="mono">{t.lot_size}</td>
                      <td><span className={`badge ${t.status === "closed" ? (t.profit >= 0 ? "bull" : "bear") : "warn"}`}>{t.status === "closed" ? (t.profit >= 0 ? "WIN" : "LOSS") : "OPEN"}</span></td>
                      <td className="mono">{t.status === "closed" ? <span className={t.profit >= 0 ? "pnl-pos" : "pnl-neg"}>{pnlSign(t.profit)}${parseFloat(t.profit||0).toFixed(2)}</span> : <span style={{ color: "var(--text-muted)" }}>—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div style={{ marginTop: 24, fontSize: 11, color: "var(--text-muted)", textAlign: "center" }}>
          Aethelgard Quant Engine · Trading involves risk · Past performance does not guarantee future results
        </div>
      </div>
    </div>
  );
}
