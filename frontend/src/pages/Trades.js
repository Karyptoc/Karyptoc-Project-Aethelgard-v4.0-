// pages/Trades.js
import React, { useState, useEffect } from "react";
import api from "../lib/api";

export function Trades() {
  const [trades, setTrades] = useState([]);
  const [status, setStatus] = useState("open");
  const [stats, setStats] = useState(null);

  const load = async () => {
    const [tradesR, perfR] = await Promise.all([
      api.get(`/api/trades?status=${status}`),
      api.get("/api/dashboard/performance")
    ]);
    setTrades(tradesR.data.trades || []);
    setStats(perfR.data.stats);
  };

  useEffect(() => { load(); }, [status]);

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Trade History</div>
          <div className="page-subtitle">EXECUTION LOG · {trades.length} RECORDS</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {["open","closed"].map(s => (
            <button key={s} className={`btn btn-sm ${status === s ? "btn-primary" : "btn-ghost"}`} onClick={() => setStatus(s)}>
              {s.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
      <div className="page-body">
        {stats && (
          <div className="stats-grid" style={{ marginBottom: 20 }}>
            {[
              ["Total Trades", stats.total_trades, "accent"],
              ["Win Rate", `${stats.win_rate}%`, "bull"],
              ["Total P&L", `$${stats.total_pnl}`, parseFloat(stats.total_pnl) >= 0 ? "bull" : "bear"],
              ["Profit Factor", stats.profit_factor, "blue"],
              ["Avg Win", `$${stats.avg_win}`, "bull"],
              ["Avg Loss", `$${stats.avg_loss}`, "bear"],
            ].map(([label, value, type]) => (
              <div key={label} className={`stat-card ${type}`}>
                <div className="stat-label">{label}</div>
                <div className={`stat-value ${type}`} style={{ fontSize: 20 }}>{value}</div>
              </div>
            ))}
          </div>
        )}
        <div className="card">
          {trades.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">◆</div>
              <div className="empty-text">No {status} trades</div>
            </div>
          ) : (
            <table>
              <thead>
                <tr><th>Ticket</th><th>Symbol</th><th>Dir</th><th>Volume</th><th>Open</th><th>Close</th><th>SL</th><th>TP</th><th>P&L</th><th>Status</th></tr>
              </thead>
              <tbody>
                {trades.map(t => (
                  <tr key={t.id}>
                    <td className="mono">{t.ticket || "—"}</td>
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
                    <td><span className={`badge ${t.status === "open" ? "accent" : t.status === "closed" ? "muted" : "warn"}`}>{t.status?.toUpperCase()}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

export default Trades;
