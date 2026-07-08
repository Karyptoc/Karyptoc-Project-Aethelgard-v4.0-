import React, { useState, useEffect } from "react";
import api from "../lib/api";

function StatCard({ label, value, sub, color = "accent", icon }) {
  return (
    <div className={`stat-card ${color}`}>
      {icon && <span className="stat-icon">{icon}</span>}
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${color}`}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export default function Trades() {
  const [trades, setTrades] = useState([]);
  const [stats, setStats] = useState(null);
  const [status, setStatus] = useState("all");
  const [symbol, setSymbol] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState(0);
  const PAGE_SIZE = 200;
  const [analyzing, setAnalyzing] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState(null);
  const [showAnalysis, setShowAnalysis] = useState(false);

  const buildQuery = (offset) => {
    const params = [`limit=${PAGE_SIZE}`, `offset=${offset}`];
    if (status !== "all") params.push(`status=${status}`);
    if (symbol) params.push(`symbol=${symbol}`);
    return params.join("&");
  };

  const load = async () => {
    setLoading(true);
    try {
      const [tradesR, perfR] = await Promise.all([
        api.get(`/api/trades?${buildQuery(0)}`),
        api.get("/api/dashboard/performance")
      ]);
      setTrades(tradesR.data.trades || []);
      setTotal(tradesR.data.total || 0);
      setStats(perfR.data.stats);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const r = await api.get(`/api/trades?${buildQuery(trades.length)}`);
      setTrades(prev => [...prev, ...(r.data.trades || [])]);
    } catch (e) { console.error(e); }
    finally { setLoadingMore(false); }
  };

  useEffect(() => { load(); }, [status, symbol]);

  const requestAiAnalysis = async () => {
    setAnalyzing(true);
    try {
      const r = await api.post("/api/trades/analyze", { trades: trades.slice(0, 20) });
      setAiAnalysis(r.data.analysis);
      setShowAnalysis(true);
    } catch (e) {
      console.error(e);
    } finally { setAnalyzing(false); }
  };

  const SYMBOLS = ["GOLD", "EURUSD", "GBPUSD", "USDJPY", "US30Cash", "SPX500Cash", "GER40Cash", "BTCUSD"];

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Trade Journal</div>
          <div className="page-subtitle">EXECUTION LOG & PERFORMANCE ANALYTICS</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={requestAiAnalysis} disabled={analyzing || trades.length === 0}>
            {analyzing ? "🤖 Analyzing..." : "🤖 AI Analysis"}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={load}>↻ Refresh</button>
        </div>
      </div>

      <div className="page-body">
        {/* Performance Stats */}
        {stats && (
          <div className="stats-grid" style={{ marginBottom: 20 }}>
            <StatCard icon="📊" label="Total Trades" value={stats.total_trades} color="accent" />
            <StatCard icon="🎯" label="Win Rate" value={`${stats.win_rate}%`} color={parseFloat(stats.win_rate) >= 50 ? "bull" : "bear"} />
            <StatCard icon="💰" label="Total P&L" value={`$${stats.total_pnl}`} color={parseFloat(stats.total_pnl) >= 0 ? "bull" : "bear"} />
            <StatCard icon="⚖️" label="Profit Factor" value={stats.profit_factor} color={parseFloat(stats.profit_factor) >= 1.5 ? "bull" : "warn"} sub="gross profit / gross loss" />
            <StatCard icon="✅" label="Avg Win" value={`$${stats.avg_win}`} color="bull" />
            <StatCard icon="❌" label="Avg Loss" value={`$${stats.avg_loss}`} color="bear" />
            <StatCard icon="🏆" label="Best Trade" value={`$${stats.best_trade}`} color="bull" />
            <StatCard icon="💔" label="Worst Trade" value={`$${stats.worst_trade}`} color="bear" />
          </div>
        )}

        {/* Filters */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6 }}>
            {[["all","All"],["open","Open"],["closed","Closed"]].map(([v,l]) => (
              <button key={v} className={`btn btn-sm ${status === v ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setStatus(v)}>{l}</button>
            ))}
          </div>
          <select className="form-select" style={{ width: 150, padding: "6px 12px", fontSize: 13 }}
            value={symbol} onChange={e => setSymbol(e.target.value)}>
            <option value="">All Pairs</option>
            {SYMBOLS.map(s => <option key={s}>{s}</option>)}
          </select>
        </div>

        {/* AI Analysis Panel */}
        {showAnalysis && aiAnalysis && (
          <div className="card" style={{ marginBottom: 16, borderColor: "var(--accent)", borderWidth: 2 }}>
            <div className="card-header">
              <span className="card-title">🤖 AI Trade Analysis</span>
              <button className="btn btn-ghost btn-xs" onClick={() => setShowAnalysis(false)}>✕</button>
            </div>
            <div style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.8, whiteSpace: "pre-wrap" }}>
              {aiAnalysis}
            </div>
          </div>
        )}

        {/* Trades Table */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Trade History</span>
            <span className="badge accent">
              {trades.length}{total > trades.length ? ` of ${total}` : ""} records
            </span>
          </div>
          {loading ? (
            <div style={{ padding: 24, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>Loading...</div>
          ) : trades.length === 0 ? (
            <div className="empty-state"><div className="empty-icon">◆</div><div className="empty-text">No trades found</div></div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ticket</th><th>Symbol</th><th>Dir</th><th>Vol</th>
                    <th>Open</th><th>Close</th><th>SL</th><th>TP</th>
                    <th>P&L</th><th>Status</th><th>Opened</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map(t => (
                    <tr key={t.id}>
                      <td className="mono" style={{ color: "var(--text-muted)", fontSize: 11 }}>{t.ticket || "—"}</td>
                      <td style={{ fontWeight: 700, color: "var(--text-primary)" }}>{t.symbol}</td>
                      <td><span className={`badge ${t.direction === "BUY" ? "bull" : "bear"}`}>{t.direction}</span></td>
                      <td className="mono">{t.volume}</td>
                      <td className="mono">{t.open_price || "—"}</td>
                      <td className="mono">{t.close_price || "—"}</td>
                      <td className="mono" style={{ color: "var(--bear)" }}>{t.stop_loss || "—"}</td>
                      <td className="mono" style={{ color: "var(--bull)" }}>{t.take_profit || "—"}</td>
                      <td>
                        <span className={(t.profit || 0) >= 0 ? "pnl-pos" : "pnl-neg"}>
                          {(t.profit || 0) >= 0 ? "+" : ""}{(t.profit || 0).toFixed(2)}
                        </span>
                      </td>
                      <td>
                        <span className={`badge ${t.status === "open" ? "accent" : t.status === "closed" && (t.profit||0) > 0 ? "bull" : t.status === "closed" ? "bear" : "muted"}`}>
                          {t.status?.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}>
                        {t.open_time ? new Date(t.open_time).toLocaleString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!loading && trades.length < total && (
            <div style={{ display: "flex", justifyContent: "center", padding: 16 }}>
              <button className="btn btn-ghost btn-sm" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading..." : `Load More (${total - trades.length} remaining)`}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
