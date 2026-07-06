import React, { useState, useEffect, useCallback } from "react";
import api from "../lib/api";

const PAIRS = ["GOLD","EURUSD","GBPUSD","USDJPY","AUDUSD","USDCAD","USDCHF","NZDUSD","GBPJPY","EURJPY","US30Cash","GER40Cash","BTCUSD"];

function StatCard({ label, value, color, sub }) {
  return (
    <div style={{ background: "var(--bg-elevated)", borderRadius: "var(--radius)", padding: "14px 16px" }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 2, color: "var(--text-muted)", marginBottom: 6 }}>
        {label.toUpperCase()}
      </div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 700, color: color || "var(--text-primary)" }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

function MiniEquityCurve({ data, width = 300, height = 60 }) {
  if (!data || data.length < 2) return null;
  const equities = data.map(d => d.equity);
  const min = Math.min(...equities);
  const max = Math.max(...equities);
  const range = max - min || 1;
  const points = equities.map((e, i) => {
    const x = (i / (equities.length - 1)) * width;
    const y = height - ((e - min) / range) * height;
    return `${x},${y}`;
  }).join(" ");
  const isProfit = equities[equities.length-1] >= equities[0];
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <polyline points={points} fill="none"
        stroke={isProfit ? "var(--bull)" : "var(--bear)"} strokeWidth="2" />
    </svg>
  );
}

export default function Backtest() {
  // FIX: the backend backtest engine was rebuilt to share the exact same
  // strategy logic as live trading (see signalCore.js). It always uses
  // H4 + D1 + W1 internally now (that's the point — matching live's real
  // multi-timeframe HTF alignment), and confluence thresholds are now
  // derived dynamically from ICT sequence quality rather than a single
  // fixed number. timeframe/min_confluence/kill_zone_only are no longer
  // accepted by the backend and have been removed from this form.
  const [form, setForm] = useState({
    symbol: "GOLD", days: 30,
    initial_balance: 1000, risk_percent: 1.0,
  });
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [availability, setAvailability] = useState([]);
  const [activeTab, setActiveTab] = useState("summary");

  const loadAvailability = useCallback(async () => {
    try {
      const r = await api.get("/api/backtest/availability");
      setAvailability(r.data.availability || []);
    } catch {}
  }, []);

  useEffect(() => { loadAvailability(); }, [loadAvailability]);

  const run = async () => {
    setRunning(true);
    setError("");
    setResult(null);
    try {
      // Longer timeout than the api.js default (20s) — walking months of
      // H4 bars through the full strategy pipeline genuinely takes longer
      // than a typical API call, especially for 60-90 day ranges.
      const r = await api.post("/api/backtest/run", form, { timeout: 90000 });
      setResult(r.data);
      setActiveTab("summary");
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setRunning(false);
    }
  };

  const pnlColor = (v) => parseFloat(v) >= 0 ? "var(--bull)" : "var(--bear)";
  const pnlSign = (v) => parseFloat(v) >= 0 ? "+" : "";

  // Backend always uses H4 as primary now — check H4 availability specifically
  const dataAvail = availability.find(a => a.symbol === form.symbol && a.timeframe === "H4");

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Backtesting</div>
          <div className="page-subtitle">ICT/SMC STRATEGY REPLAY · NO API COST</div>
        </div>
      </div>

      <div className="page-body">
        {/* Config Panel */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header"><span className="card-title">Backtest Configuration</span></div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12, marginBottom: 16 }}>
            <div>
              <label className="form-label">Pair</label>
              <select className="form-select" value={form.symbol}
                onChange={e => setForm({...form, symbol: e.target.value})}>
                {PAIRS.map(p => <option key={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="form-label">Days Back</label>
              <select className="form-select" value={form.days}
                onChange={e => setForm({...form, days: parseInt(e.target.value)})}>
                {[7,14,30,60,90].map(d => <option key={d} value={d}>{d} days</option>)}
              </select>
            </div>
            <div>
              <label className="form-label">Initial Balance ($)</label>
              <input className="form-input" type="number" value={form.initial_balance}
                onChange={e => setForm({...form, initial_balance: parseFloat(e.target.value)})} />
            </div>
            <div>
              <label className="form-label">Risk Per Trade (%)</label>
              <input className="form-input" type="number" step="0.1" min="0.1" max="5" value={form.risk_percent}
                onChange={e => setForm({...form, risk_percent: parseFloat(e.target.value)})} />
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>
              Always uses H4 primary structure with D1/W1 HTF alignment and kill-zone gating — same as live trading, not configurable here anymore.
            </span>

            {dataAvail ? (
              <span style={{ fontSize: 11, color: "var(--bull)", fontFamily: "var(--font-mono)" }}>
                ✅ {dataAvail.count} bars available ({dataAvail.symbol} {dataAvail.timeframe})
              </span>
            ) : (
              <span style={{ fontSize: 11, color: "var(--warn)", fontFamily: "var(--font-mono)" }}>
                ⚠️ No H4 data yet — run bridge first to collect OHLCV data
              </span>
            )}

            <button className="btn btn-primary" onClick={run} disabled={running} style={{ marginLeft: "auto" }}>
              {running ? "⟳ Running..." : "▶ Run Backtest"}
            </button>
          </div>

          {error && (
            <div className="alert alert-error" style={{ marginTop: 12 }}>{error}</div>
          )}
        </div>

        {result && (
          <>
            {/* Summary Stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
              <StatCard label="Total Trades" value={result.summary.total_trades} color="var(--accent)" />
              <StatCard label="Win Rate" value={`${result.summary.win_rate}%`}
                color={result.summary.win_rate >= 50 ? "var(--bull)" : "var(--bear)"}
                sub={`${result.summary.winners}W / ${result.summary.losers}L`} />
              <StatCard label="Total P&L" value={`${pnlSign(result.summary.total_pnl)}$${result.summary.total_pnl}`}
                color={pnlColor(result.summary.total_pnl)} />
              <StatCard label="Profit Factor"
                value={result.summary.profit_factor ? result.summary.profit_factor : "∞"}
                color={result.summary.profit_factor >= 1.5 ? "var(--bull)" : "var(--bear)"} />
              <StatCard label="Max Drawdown" value={`${result.summary.max_drawdown_pct}%`}
                color={result.summary.max_drawdown_pct < 10 ? "var(--bull)" : "var(--bear)"} />
              <StatCard label="Final Balance" value={`$${result.summary.final_balance}`}
                color={pnlColor(result.summary.total_pnl)} sub={`from $${result.summary.initial_balance}`} />
              <StatCard label="Avg Win" value={`$${result.summary.avg_win}`} color="var(--bull)" />
              <StatCard label="Avg Loss" value={`-$${result.summary.avg_loss}`} color="var(--bear)" />
              <StatCard label="HTF Aligned WR" value={`${result.summary.htf_aligned_win_rate ?? "—"}%`}
                color="var(--accent)" sub={`${result.summary.htf_aligned_trades} trades w/ full H4+D1+W1 alignment`} />
              <StatCard label="Spread Cost" value={`$${result.summary.total_spread_cost}`}
                color="var(--warn)" sub="total across all trades" />
              <StatCard label="Best Trade" value={`$${result.summary.best_trade}`} color="var(--bull)" />
              <StatCard label="Worst Trade" value={`$${result.summary.worst_trade}`} color="var(--bear)" />
              <StatCard label="Bars Used" value={result.bars_used} color="var(--text-muted)"
                sub={`${result.days} days, ${result.timeframe} primary`} />
            </div>

            {/* Equity Curve */}
            {result.equity_curve?.length > 1 && (
              <div className="card" style={{ marginBottom: 16 }}>
                <div className="card-header"><span className="card-title">Equity Curve</span></div>
                <div style={{ overflowX: "auto" }}>
                  <svg width="100%" height="120" viewBox={`0 0 ${Math.max(result.equity_curve.length * 4, 600)} 120`}
                    preserveAspectRatio="none" style={{ display: "block" }}>
                    {(() => {
                      const equities = result.equity_curve.map(d => d.equity);
                      const min = Math.min(...equities);
                      const max = Math.max(...equities);
                      const range = max - min || 1;
                      const w = Math.max(result.equity_curve.length * 4, 600);
                      const h = 120;
                      const pts = equities.map((e, i) =>
                        `${(i / (equities.length - 1)) * w},${h - ((e - min) / range) * (h - 10) - 5}`
                      ).join(" ");
                      const isProfit = equities[equities.length-1] >= equities[0];
                      return (
                        <>
                          <line x1="0" y1={h - ((result.summary.initial_balance - min) / range) * (h-10) - 5}
                            x2={w} y2={h - ((result.summary.initial_balance - min) / range) * (h-10) - 5}
                            stroke="var(--border)" strokeDasharray="4,4" strokeWidth="1" />
                          <polyline points={pts} fill="none"
                            stroke={isProfit ? "var(--bull)" : "var(--bear)"} strokeWidth="2" />
                        </>
                      );
                    })()}
                  </svg>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", padding: "4px 0" }}>
                  <span>${result.summary.initial_balance} start</span>
                  <span>${result.summary.final_balance} end ({pnlSign(result.summary.total_pnl)}${result.summary.total_pnl})</span>
                </div>
              </div>
            )}

            {/* Tabs */}
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              {["summary","trades","sessions","grades"].map(tab => (
                <button key={tab} className={`btn btn-sm ${activeTab === tab ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => setActiveTab(tab)}>
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>

            {/* By Session */}
            {activeTab === "sessions" && (
              <div className="card">
                <div className="card-header"><span className="card-title">Performance by Session</span></div>
                <table>
                  <thead>
                    <tr><th>Session</th><th>Trades</th><th>Win Rate</th><th>P&L</th></tr>
                  </thead>
                  <tbody>
                    {Object.entries(result.by_session || {}).map(([session, data]) => (
                      <tr key={session}>
                        <td style={{ fontWeight: 600 }}>{session}</td>
                        <td className="mono">{data.trades}</td>
                        <td className="mono">
                          <span style={{ color: data.wins/data.trades >= 0.5 ? "var(--bull)" : "var(--bear)", fontWeight: 700 }}>
                            {data.trades > 0 ? (data.wins/data.trades*100).toFixed(0) : 0}%
                          </span>
                        </td>
                        <td className="mono">
                          <span className={data.pnl >= 0 ? "pnl-pos" : "pnl-neg"}>
                            {pnlSign(data.pnl)}${data.pnl.toFixed(2)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* By Grade */}
            {activeTab === "grades" && (
              <div className="card">
                <div className="card-header"><span className="card-title">Performance by Signal Grade</span></div>
                <table>
                  <thead>
                    <tr><th>Grade</th><th>Trades</th><th>Win Rate</th><th>P&L</th></tr>
                  </thead>
                  <tbody>
                    {Object.entries(result.by_grade || {}).sort(([a],[b]) => a.localeCompare(b)).map(([grade, data]) => (
                      <tr key={grade}>
                        <td><span className={`badge ${grade === "A" ? "bull" : grade === "B" ? "accent" : grade === "C" ? "warn" : "bear"}`}>Grade {grade}</span></td>
                        <td className="mono">{data.trades}</td>
                        <td className="mono">
                          <span style={{ color: data.wins/data.trades >= 0.5 ? "var(--bull)" : "var(--bear)", fontWeight: 700 }}>
                            {data.trades > 0 ? (data.wins/data.trades*100).toFixed(0) : 0}%
                          </span>
                        </td>
                        <td className="mono">
                          <span className={data.pnl >= 0 ? "pnl-pos" : "pnl-neg"}>
                            {pnlSign(data.pnl)}${data.pnl.toFixed(2)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Trade List */}
            {activeTab === "trades" && (
              <div className="card">
                <div className="card-header">
                  <span className="card-title">Trade History</span>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Last 100 trades</span>
                </div>
                <div className="table-wrap" style={{ maxHeight: 500, overflowY: "auto" }}>
                  <table>
                    <thead>
                      <tr><th>Time</th><th>Dir</th><th>Entry</th><th>Exit</th><th>SL</th><th>TP</th><th>P&L</th><th>Grade</th><th>Session</th><th>Result</th></tr>
                    </thead>
                    <tbody>
                      {[...(result.trades || [])].reverse().map((t, i) => (
                        <tr key={i}>
                          <td className="mono" style={{ fontSize: 10 }}>{new Date(t.entry_time).toLocaleString()}</td>
                          <td><span className={`badge ${t.direction === "BUY" ? "bull" : "bear"}`}>{t.direction}</span></td>
                          <td className="mono" style={{ fontSize: 11 }}>{t.entry_price}</td>
                          <td className="mono" style={{ fontSize: 11 }}>{t.exit_price}</td>
                          <td className="mono" style={{ fontSize: 11, color: "var(--bear)" }}>{t.stop_loss}</td>
                          <td className="mono" style={{ fontSize: 11, color: "var(--bull)" }}>{t.take_profit}</td>
                          <td className="mono">
                            <span className={t.pnl >= 0 ? "pnl-pos" : "pnl-neg"}>
                              {pnlSign(t.pnl)}${t.pnl}
                            </span>
                          </td>
                          <td><span className={`badge ${t.grade === "A" ? "bull" : t.grade === "B" ? "accent" : "warn"}`}>{t.grade}</span></td>
                          <td style={{ fontSize: 10, color: "var(--text-muted)" }}>{t.session}</td>
                          <td><span className={`badge ${t.outcome === "WIN" ? "bull" : "bear"}`}>{t.outcome}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Summary insights */}
            {activeTab === "summary" && (
              <div className="card">
                <div className="card-header"><span className="card-title">Strategy Insights</span></div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
                  <div style={{ padding: "10px 14px", background: "var(--bg-elevated)", borderRadius: "var(--radius)", borderLeft: `3px solid ${result.summary.profit_factor >= 1.5 ? "var(--bull)" : "var(--bear)"}` }}>
                    <strong>Profit Factor: {result.summary.profit_factor || "∞"}</strong> — {result.summary.profit_factor >= 2.0 ? "Excellent — strategy has strong edge" : result.summary.profit_factor >= 1.5 ? "Good — strategy is profitable" : result.summary.profit_factor >= 1.0 ? "Marginal — needs refinement" : "Poor — strategy loses money"}
                  </div>
                  <div style={{ padding: "10px 14px", background: "var(--bg-elevated)", borderRadius: "var(--radius)", borderLeft: `3px solid ${result.summary.htf_aligned_win_rate >= 55 ? "var(--bull)" : "var(--warn)"}` }}>
                    <strong>HTF-Aligned Win Rate: {result.summary.htf_aligned_win_rate ?? "—"}%</strong> ({result.summary.htf_aligned_trades} trades) vs {result.summary.htf_not_aligned_win_rate ?? "—"}% when H4/D1/W1 don't fully agree — {result.summary.htf_aligned_win_rate > result.summary.htf_not_aligned_win_rate ? "full multi-timeframe alignment is meaningfully improving results, as designed" : "alignment isn't showing a clear edge yet — worth investigating once more D1/W1 history accumulates"}
                  </div>
                  <div style={{ padding: "10px 14px", background: "var(--bg-elevated)", borderRadius: "var(--radius)", borderLeft: `3px solid ${result.summary.max_drawdown_pct < 10 ? "var(--bull)" : "var(--bear)"}` }}>
                    <strong>Max Drawdown: {result.summary.max_drawdown_pct}%</strong> — {result.summary.max_drawdown_pct < 5 ? "Excellent risk control" : result.summary.max_drawdown_pct < 10 ? "Acceptable drawdown" : result.summary.max_drawdown_pct < 20 ? "High drawdown — reduce risk per trade" : "Dangerous drawdown — reduce position size immediately"}
                  </div>
                  {result.summary.win_rate < 45 && (
                    <div style={{ padding: "10px 14px", background: "var(--bg-elevated)", borderRadius: "var(--radius)", borderLeft: "3px solid var(--bear)" }}>
                      <strong>⚠️ Win Rate {result.summary.win_rate}% is below 45%</strong> — the confluence threshold now adapts automatically to ICT sequence quality rather than a fixed number you can tune here; check the By Grade tab to see whether lower-grade setups are dragging the average down
                    </div>
                  )}
                  {result.summary.total_trades < 10 && (
                    <div style={{ padding: "10px 14px", background: "var(--bg-elevated)", borderRadius: "var(--radius)", borderLeft: "3px solid var(--warn)" }}>
                      <strong>⚠️ Only {result.summary.total_trades} trades</strong> — Increase date range to 60-90 days for more statistically significant results
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {/* How it works note */}
        {!result && (
          <div className="card">
            <div className="card-header"><span className="card-title">How Backtesting Works</span></div>
            <div style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.8 }}>
              <p>The backtester walks real historical H4 bars through the exact same strategy code the live engine uses — multi-timeframe H4/D1/W1 HTF bias, ICT sweep/displacement/retest sequence detection, confluence scoring, and the PURE_MATH decision engine. This is the same code, not a separate simulation, so results here reflect what the live strategy would actually have done.</p>
              <p><strong>No Claude API cost</strong> — uses pure mathematical signal detection without AI narrative generation.</p>
              <p><strong>Data collection:</strong> The bridge saves H4/D1/W1 OHLCV bars automatically. D1/W1 history builds up more slowly than H4 (one bar per day/week respectively) — expect HTF alignment stats to become more meaningful after a few weeks of bridge uptime.</p>
              <p><strong>Simulated execution:</strong> Position sizing uses your real per-instrument pip values and confluence-grade risk scaling. Exits simulate your actual breakeven/trailing/partial-close logic rather than a simple stop-or-target check, and a spread cost estimate is deducted from every trade.</p>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
