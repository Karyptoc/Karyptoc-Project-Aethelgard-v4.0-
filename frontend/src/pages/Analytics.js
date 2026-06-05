import React, { useState, useEffect } from "react";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend
} from "recharts";
import api from "../lib/api";

const COLORS = {
  bull: "#00875a", bear: "#de350b", accent: "#0066ff",
  warn: "#ff8b00", gold: "#b8860b", blue: "#0052cc"
};

export default function Analytics() {
  const [perf, setPerf] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedAccount, setSelectedAccount] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [perfR, overviewR] = await Promise.all([
          api.get("/api/dashboard/performance"),
          api.get("/api/dashboard/overview")
        ]);
        setPerf(perfR.data);
        setAccounts(overviewR.data.accounts || []);
        if (overviewR.data.accounts?.length > 0) {
          const firstAcc = overviewR.data.accounts[0];
          setSelectedAccount(firstAcc.id);
          const snapsR = await api.get(`/api/dashboard/equity-curve/${firstAcc.id}`);
          setSnapshots(snapsR.data.snapshots || []);
        }
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    };
    load();
  }, []);

  const loadSnapshots = async (accountId) => {
    try {
      const r = await api.get(`/api/dashboard/equity-curve/${accountId}`);
      setSnapshots(r.data.snapshots || []);
      setSelectedAccount(accountId);
    } catch (e) { console.error(e); }
  };

  if (loading) return (
    <div style={{ padding: 28 }}>
      <div style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)", fontSize: 12 }}>Loading analytics...</div>
    </div>
  );

  const stats = perf?.stats;
  const trades = perf?.trades || [];

  // Prepare chart data
  const equityData = snapshots.map(s => ({
    time: new Date(s.snapshot_time).toLocaleDateString(),
    equity: parseFloat(s.equity),
    balance: parseFloat(s.balance)
  }));

  // P&L by symbol
  const bySymbol = {};
  trades.forEach(t => {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { symbol: t.symbol, pnl: 0, trades: 0, wins: 0 };
    bySymbol[t.symbol].pnl += (t.profit || 0);
    bySymbol[t.symbol].trades++;
    if ((t.profit || 0) > 0) bySymbol[t.symbol].wins++;
  });
  const symbolData = Object.values(bySymbol).map(s => ({
    ...s,
    pnl: parseFloat(s.pnl.toFixed(2)),
    winRate: s.trades > 0 ? parseFloat((s.wins / s.trades * 100).toFixed(1)) : 0
  })).sort((a, b) => b.pnl - a.pnl);

  // Win/loss pie
  const winLoseData = stats ? [
    { name: "Wins", value: Math.round(parseFloat(stats.win_rate)), fill: COLORS.bull },
    { name: "Losses", value: Math.round(100 - parseFloat(stats.win_rate)), fill: COLORS.bear }
  ] : [];

  // Daily P&L
  const dailyPnL = {};
  trades.filter(t => t.status === "closed" && t.close_time).forEach(t => {
    const day = new Date(t.close_time).toLocaleDateString();
    if (!dailyPnL[day]) dailyPnL[day] = 0;
    dailyPnL[day] += (t.profit || 0);
  });
  const dailyData = Object.entries(dailyPnL).slice(-14).map(([date, pnl]) => ({
    date, pnl: parseFloat(pnl.toFixed(2))
  }));

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
      <div style={{ background: "var(--bg-surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 12px", fontSize: 12 }}>
        <div style={{ color: "var(--text-muted)", marginBottom: 4 }}>{label}</div>
        {payload.map((p, i) => (
          <div key={i} style={{ color: p.color || "var(--text-primary)", fontWeight: 600 }}>
            {p.name}: {typeof p.value === "number" ? p.value.toFixed(2) : p.value}
          </div>
        ))}
      </div>
    );
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Analytics</div>
          <div className="page-subtitle">PERFORMANCE METRICS & TRADE STATISTICS</div>
        </div>
        {accounts.length > 1 && (
          <select className="form-select" style={{ width: 160 }}
            value={selectedAccount || ""} onChange={e => loadSnapshots(e.target.value)}>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        )}
      </div>

      <div className="page-body">
        {!stats ? (
          <div className="empty-state">
            <div className="empty-icon">📊</div>
            <div className="empty-text">No closed trades yet — analytics will appear once trades complete</div>
          </div>
        ) : (
          <>
            {/* Key metrics */}
            <div className="stats-grid" style={{ marginBottom: 20 }}>
              {[
                { label: "Total Trades", value: stats.total_trades, icon: "📊", color: "accent" },
                { label: "Win Rate", value: `${stats.win_rate}%`, icon: "🎯", color: parseFloat(stats.win_rate) >= 50 ? "bull" : "bear" },
                { label: "Profit Factor", value: stats.profit_factor, icon: "⚖️", color: parseFloat(stats.profit_factor) >= 1.5 ? "bull" : "warn" },
                { label: "Total P&L", value: `$${stats.total_pnl}`, icon: "💰", color: parseFloat(stats.total_pnl) >= 0 ? "bull" : "bear" },
                { label: "Avg Win", value: `$${stats.avg_win}`, icon: "✅", color: "bull" },
                { label: "Avg Loss", value: `$${stats.avg_loss}`, icon: "❌", color: "bear" },
              ].map(({ label, value, icon, color }) => (
                <div key={label} className={`stat-card ${color}`}>
                  <span className="stat-icon">{icon}</span>
                  <div className="stat-label">{label}</div>
                  <div className={`stat-value ${color}`} style={{ fontSize: 22 }}>{value}</div>
                </div>
              ))}
            </div>

            {/* Equity Curve */}
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-header">
                <span className="card-title">Equity Curve</span>
                <span className="badge accent">{snapshots.length} snapshots</span>
              </div>
              {equityData.length > 1 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={equityData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="time" tick={{ fontSize: 10, fill: "var(--text-muted)" }} />
                    <YAxis domain={["auto","auto"]} tick={{ fontSize: 10, fill: "var(--text-muted)" }} width={70} />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />
                    <Line type="monotone" dataKey="equity" stroke={COLORS.accent} strokeWidth={2} dot={false} name="Equity" />
                    <Line type="monotone" dataKey="balance" stroke={COLORS.bull} strokeWidth={1.5} dot={false} strokeDasharray="4 4" name="Balance" />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <div className="empty-state" style={{ padding: 32 }}>
                  <div className="empty-icon">📈</div>
                  <div className="empty-text">Equity curve builds over time with hourly snapshots</div>
                </div>
              )}
            </div>

            {/* Daily P&L + Win/Loss pie */}
            <div className="grid-2" style={{ marginBottom: 16, gap: 16 }}>
              <div className="card">
                <div className="card-header"><span className="card-title">Daily P&L (Last 14 Days)</span></div>
                {dailyData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={dailyData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis dataKey="date" tick={{ fontSize: 9, fill: "var(--text-muted)" }} />
                      <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }} width={50} />
                      <Tooltip content={<CustomTooltip />} />
                      <Bar dataKey="pnl" name="P&L ($)" fill={COLORS.accent}
                        cell={dailyData.map((d, i) => (
                          <Cell key={i} fill={d.pnl >= 0 ? COLORS.bull : COLORS.bear} />
                        ))} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="empty-state" style={{ padding: 32 }}>
                    <div className="empty-icon">📅</div>
                    <div className="empty-text">No closed trades yet</div>
                  </div>
                )}
              </div>

              <div className="card">
                <div className="card-header"><span className="card-title">Win/Loss Distribution</span></div>
                {winLoseData.length > 0 && parseFloat(stats.win_rate) > 0 ? (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 24 }}>
                    <ResponsiveContainer width={160} height={160}>
                      <PieChart>
                        <Pie data={winLoseData} dataKey="value" cx="50%" cy="50%" innerRadius={40} outerRadius={70}>
                          {winLoseData.map((entry, i) => <Cell key={i} fill={entry.fill} />)}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                      {winLoseData.map(d => (
                        <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ width: 12, height: 12, borderRadius: 3, background: d.fill }} />
                          <span style={{ fontSize: 13, fontWeight: 600 }}>{d.name}</span>
                          <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-muted)" }}>{d.value}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="empty-state" style={{ padding: 32 }}>
                    <div className="empty-icon">🥧</div>
                    <div className="empty-text">No data yet</div>
                  </div>
                )}
              </div>
            </div>

            {/* Performance by symbol */}
            {symbolData.length > 0 && (
              <div className="card">
                <div className="card-header"><span className="card-title">Performance by Pair</span></div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th>Symbol</th><th>Trades</th><th>Win Rate</th><th>Total P&L</th><th>Avg P&L</th></tr>
                    </thead>
                    <tbody>
                      {symbolData.map(s => (
                        <tr key={s.symbol}>
                          <td style={{ fontWeight: 700, color: "var(--text-primary)" }}>{s.symbol}</td>
                          <td className="mono">{s.trades}</td>
                          <td>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <div style={{ width: 60, height: 5, background: "var(--border)", borderRadius: 3, overflow: "hidden" }}>
                                <div style={{ width: `${s.winRate}%`, height: "100%", background: s.winRate >= 50 ? "var(--bull)" : "var(--bear)", borderRadius: 3 }} />
                              </div>
                              <span className="mono" style={{ fontSize: 11 }}>{s.winRate}%</span>
                            </div>
                          </td>
                          <td>
                            <span className={s.pnl >= 0 ? "pnl-pos" : "pnl-neg"}>
                              {s.pnl >= 0 ? "+" : ""}{s.pnl.toFixed(2)}
                            </span>
                          </td>
                          <td>
                            <span className={(s.pnl/s.trades) >= 0 ? "pnl-pos" : "pnl-neg"}>
                              {(s.pnl/s.trades) >= 0 ? "+" : ""}{(s.pnl/s.trades).toFixed(2)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
