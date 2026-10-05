import React, { useState, useEffect, useCallback } from "react";
import api from "../lib/api";

const PAIR_FLAGS = {
  GOLD: "🥇", EURUSD: "🇪🇺", GBPUSD: "🇬🇧", USDJPY: "🇯🇵",
  AUDUSD: "🇦🇺", USDCAD: "🇨🇦", USDCHF: "🇨🇭", NZDUSD: "🇳🇿",
  GBPJPY: "🇬🇧", EURJPY: "🇪🇺", US30Cash: "🇺🇸", GER40Cash: "🇩🇪",
  BTCUSD: "₿",
};

export default function PairControls() {
  const [pairs, setPairs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(null);
  const [haltReasons, setHaltReasons] = useState({});
  const [editing, setEditing] = useState(null);
  const [toast, setToast] = useState("");
  const [filter, setFilter] = useState("all"); // all | active | halted
  const [asOf, setAsOf] = useState(null);
  const [statsError, setStatsError] = useState(null);

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(""), 3500); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get("/api/pairs/controls");
      setPairs(r.data.controls || []);
      setAsOf(r.data.as_of ? new Date(r.data.as_of) : new Date());
      setStatsError(r.data.stats_error || null);
    } catch (e) {
      showToast("❌ " + (e.response?.data?.error || e.message));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, [load]);

  const haltPair = async (symbol) => {
    setActing(symbol);
    try {
      await api.put(`/api/pairs/controls/${symbol}`, { enabled: false });
      showToast(`⏸ ${symbol} halted`);
    } catch (e) {
      showToast("❌ " + (e.response?.data?.error || e.message));
    }
    setHaltReasons(r => ({ ...r, [symbol]: "" }));
    await load();
    setActing(null);
  };

  const resumePair = async (symbol) => {
    setActing(symbol);
    try {
      await api.put(`/api/pairs/controls/${symbol}`, { enabled: true, auto_halted: false, auto_halt_reason: null, auto_halted_at: null });
      showToast(`✅ ${symbol} resumed`);
    } catch (e) {
      showToast("❌ " + (e.response?.data?.error || e.message));
    }
    await load();
    setActing(null);
  };

  const saveEdit = async (pair) => {
    try {
      await api.put(`/api/pairs/controls/${pair.symbol}`, {
        max_daily_loss_usd: pair.max_daily_loss_usd,
        max_trades_per_day: pair.max_trades_per_day,
        notes: pair.notes
      });
      showToast(`✅ ${pair.symbol} settings saved`);
    } catch (e) {
      showToast("❌ " + (e.response?.data?.error || e.message));
    }
    setEditing(null);
    await load();
  };

  const isHaltedPair = p => !p.enabled || p.auto_halted;
  const haltedCount = pairs.filter(isHaltedPair).length;
  const activeCount = pairs.length - haltedCount;
  const num = v => parseFloat(v) || 0;
  const totalPnl = pairs.reduce((s, p) => s + num(p.total_pnl), 0);
  const todayPnl = pairs.reduce((s, p) => s + num(p.today_pnl), 0);
  const openCount = pairs.reduce((s, p) => s + (p.open_trades || 0), 0);
  const closedCount = pairs.reduce((s, p) => s + (p.total_trades || 0), 0);
  const winsTotal = pairs.reduce((s, p) => s + (p.wins || 0), 0);
  const overallWr = closedCount ? (winsTotal / closedCount * 100) : null;
  const visiblePairs = pairs.filter(p =>
    filter === "all" ? true : filter === "halted" ? isHaltedPair(p) : !isHaltedPair(p));
  const money = v => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
  const pnlColor = v => v > 0 ? "var(--bull)" : v < 0 ? "var(--bear)" : "var(--text-muted)";

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Pair Controls</div>
          <div className="page-subtitle">HALT · RESUME · PER-PAIR RISK LIMITS · {pairs.length} PAIRS</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {asOf && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}
              title="Figures are recalculated from your trades table on every refresh (auto every 30s)">
              UPDATED {asOf.toLocaleTimeString()}
            </span>
          )}
          <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>
            {loading ? "⟳" : "↻"} Refresh
          </button>
        </div>
      </div>

      {toast && (
        <div style={{ position: "fixed", top: 20, right: 20, zIndex: 9999 }}>
          <div className="alert alert-info" style={{ margin: 0, minWidth: 260 }}>{toast}</div>
        </div>
      )}

      <div className="page-body">

        {/* Stats — an explicit responsive grid (the old "grid-4" class stacked
            the four cards into one tall column) */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 16 }}>
          {[
            ["Active Pairs", activeCount, "var(--bull)", `of ${pairs.length}`],
            ["Halted Pairs", haltedCount, haltedCount > 0 ? "var(--bear)" : "var(--text-muted)", haltedCount > 0 ? "not trading" : "none"],
            ["Today P&L", money(todayPnl), pnlColor(todayPnl), "closed trades today"],
            ["All-time P&L", money(totalPnl), pnlColor(totalPnl), `${closedCount} closed trades`],
            ["Win Rate", overallWr === null ? "—" : `${overallWr.toFixed(0)}%`, overallWr === null ? "var(--text-muted)" : overallWr >= 50 ? "var(--bull)" : "var(--warn)", "all pairs"],
            ["Open Now", openCount, openCount > 0 ? "var(--accent)" : "var(--text-muted)", "positions"],
          ].map(([label, value, color, sub]) => (
            <div key={label} style={{ background: "var(--bg-elevated)", borderRadius: "var(--radius)", padding: "14px 16px", border: "1px solid var(--border)" }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 2, color: "var(--text-muted)", marginBottom: 6 }}>
                {label.toUpperCase()}
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 22, fontWeight: 700, color }}>{value}</div>
              <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 3 }}>{sub}</div>
            </div>
          ))}
        </div>

        {statsError && (
          <div className="alert alert-warn" style={{ marginBottom: 12, fontSize: 12 }}>
            ⚠️ Couldn't read trade statistics ({statsError}) — P&L, win rate and today's usage may be missing.
          </div>
        )}

        {haltedCount > 0 && (() => {
          // FIX: this banner used to hardcode one pair's name and stale
          // numbers ("EURUSD halted due to 0% win rate and -$11.64") no
          // matter which pairs were actually halted or why — a GOLD
          // auto-halt from a real daily-loss trip would still show the
          // old EURUSD sentence. Now it lists the actual halted pairs and
          // each one's real reason straight from pair_controls.
          const halted = pairs.filter(p => !p.enabled || p.auto_halted);
          return (
            <div className="alert alert-warn" style={{ marginBottom: 16, fontSize: 13 }}>
              ⚠️ <strong>{haltedCount} pair{haltedCount > 1 ? "s" : ""} halted:</strong>{" "}
              {halted.map((p, i) => (
                <span key={p.symbol}>
                  {i > 0 && ", "}
                  <strong>{p.symbol}</strong> ({p.auto_halted ? (p.auto_halt_reason || "auto-halted") : "manually halted"})
                </span>
              ))}
              . Re-enable only after diagnosing the root cause.
            </div>
          );
        })()}

        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {[["all", `All (${pairs.length})`], ["active", `Active (${activeCount})`], ["halted", `Halted (${haltedCount})`]].map(([v, l]) => (
            <button key={v} className={`btn btn-sm ${filter === v ? "btn-primary" : "btn-ghost"}`} onClick={() => setFilter(v)}>{l}</button>
          ))}
        </div>

        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Pair</th>
                  <th>Status</th>
                  <th>Closed</th>
                  <th>Win Rate</th>
                  <th>All-time P&L</th>
                  <th>Today P&L</th>
                  <th>Today's Limits</th>
                  <th>Reason / Notes</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {visiblePairs.length === 0 && (
                  <tr><td colSpan={9} style={{ textAlign: "center", color: "var(--text-muted)", padding: 24 }}>No pairs in this view.</td></tr>
                )}
                {visiblePairs.map(p => {
                  const isHalted = isHaltedPair(p);
                  const isEditing = editing?.symbol === p.symbol;
                  const isActing = acting === p.symbol;
                  const pnl = num(p.total_pnl), todayP = num(p.today_pnl);
                  const closed = p.total_trades || 0;
                  const wr = p.win_rate_pct;
                  const maxLoss = num(p.max_daily_loss_usd), maxTr = p.max_trades_per_day || 0;
                  const lossUsed = Math.max(0, -todayP);
                  const lossPct = maxLoss > 0 ? Math.min(100, lossUsed / maxLoss * 100) : 0;
                  const trPct = maxTr > 0 ? Math.min(100, (p.today_trades || 0) / maxTr * 100) : 0;
                  const bar = (pct, hot) => (
                    <div style={{ width: 70, height: 4, background: "var(--border)", borderRadius: 2, overflow: "hidden" }}>
                      <div style={{ width: `${pct}%`, height: "100%", background: hot ? "var(--bear)" : "var(--accent)" }} />
                    </div>
                  );

                  return (
                    <tr key={p.symbol} style={{ opacity: isHalted ? 0.7 : 1 }}>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
                          <span style={{ fontSize: 18 }}>{PAIR_FLAGS[p.symbol] || "💱"}</span>
                          {p.symbol}
                        </div>
                      </td>

                      <td>
                        {p.auto_halted
                          ? <span className="badge bear">AUTO-HALTED</span>
                          : p.enabled
                            ? <span className="badge bull">ACTIVE</span>
                            : <span className="badge warn">HALTED</span>}
                        {(p.open_trades || 0) > 0 && (
                          <div style={{ fontSize: 10, color: "var(--accent)", marginTop: 3 }}>{p.open_trades} open</div>
                        )}
                      </td>

                      <td className="mono">
                        {closed > 0
                          ? <>{closed}<div style={{ fontSize: 10, color: "var(--text-muted)" }}>{p.wins}W / {p.losses}L</div></>
                          : <span style={{ color: "var(--text-muted)" }} title="No closed trades yet">—</span>}
                      </td>

                      <td className="mono">
                        {wr === null || wr === undefined
                          ? <span style={{ color: "var(--text-muted)" }}>—</span>
                          : <span style={{ color: wr >= 50 ? "var(--bull)" : wr > 0 ? "var(--warn)" : "var(--bear)", fontWeight: 700 }}>{wr.toFixed(0)}%</span>}
                      </td>

                      <td className="mono">
                        {closed > 0
                          ? <span className={pnl >= 0 ? "pnl-pos" : "pnl-neg"}>{money(pnl)}</span>
                          : <span style={{ color: "var(--text-muted)" }}>—</span>}
                      </td>

                      <td className="mono">
                        {(p.today_trades || 0) > 0 || todayP !== 0
                          ? <span className={todayP >= 0 ? "pnl-pos" : "pnl-neg"}>{money(todayP)}</span>
                          : <span style={{ color: "var(--text-muted)" }}>—</span>}
                      </td>

                      {/* Limits: live usage against the caps the risk engine enforces */}
                      <td className="mono" style={{ fontSize: 11 }}>
                        {isEditing ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ width: 62, color: "var(--text-muted)" }}>Loss $</span>
                              <input className="form-input" type="number" style={{ width: 80, padding: "4px 8px", fontSize: 12 }}
                                value={editing.max_daily_loss_usd}
                                onChange={e => setEditing({ ...editing, max_daily_loss_usd: parseFloat(e.target.value) })} />
                            </label>
                            <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ width: 62, color: "var(--text-muted)" }}>Trades</span>
                              <input className="form-input" type="number" style={{ width: 80, padding: "4px 8px", fontSize: 12 }}
                                value={editing.max_trades_per_day}
                                onChange={e => setEditing({ ...editing, max_trades_per_day: parseInt(e.target.value) })} />
                            </label>
                          </div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                            <div>
                              <div>Trades {p.today_trades || 0}/{maxTr}</div>
                              {bar(trPct, trPct >= 100)}
                            </div>
                            <div>
                              <div>Loss ${lossUsed.toFixed(2)}/${maxLoss.toFixed(2)}</div>
                              {bar(lossPct, lossPct >= 100)}
                            </div>
                          </div>
                        )}
                      </td>

                      <td style={{ maxWidth: 200 }}>
                        {isEditing
                          ? <input className="form-input" type="text" placeholder="Notes..." style={{ width: 160, padding: "4px 8px", fontSize: 12 }}
                              value={editing.notes || ""}
                              onChange={e => setEditing({ ...editing, notes: e.target.value })} />
                          : p.auto_halted && p.auto_halt_reason
                            ? <span style={{ fontSize: 11, color: "var(--bear)", fontStyle: "italic" }}>{p.auto_halt_reason}</span>
                            : !p.enabled
                              ? <span style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>Manually halted{p.notes ? ` · ${p.notes}` : ""}</span>
                              : <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{p.notes || "—"}</span>}
                      </td>

                      <td>
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {isEditing ? (
                            <>
                              <button className="btn btn-primary btn-xs" onClick={() => saveEdit(editing)}>Save</button>
                              <button className="btn btn-ghost btn-xs" onClick={() => setEditing(null)}>Cancel</button>
                            </>
                          ) : (
                            <>
                              <button className="btn btn-ghost btn-xs" onClick={() => setEditing({ ...p })}>Edit</button>
                              {isHalted
                                ? <button className="btn btn-success btn-xs" disabled={isActing} onClick={() => resumePair(p.symbol)}>
                                    {isActing ? "..." : "Resume"}
                                  </button>
                                : <button className="btn btn-danger btn-xs" disabled={isActing} onClick={() => haltPair(p.symbol)}>
                                    {isActing ? "..." : "Halt"}
                                  </button>}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {visiblePairs.length > 0 && (() => {
                const vClosed = visiblePairs.reduce((s, p) => s + (p.total_trades || 0), 0);
                const vWins = visiblePairs.reduce((s, p) => s + (p.wins || 0), 0);
                const vPnl = visiblePairs.reduce((s, p) => s + num(p.total_pnl), 0);
                const vToday = visiblePairs.reduce((s, p) => s + num(p.today_pnl), 0);
                return (
                  <tfoot>
                    <tr style={{ fontWeight: 700, borderTop: "2px solid var(--border)" }}>
                      <td>Total ({visiblePairs.length})</td>
                      <td />
                      <td className="mono">{vClosed}</td>
                      <td className="mono">{vClosed ? `${(vWins / vClosed * 100).toFixed(0)}%` : "—"}</td>
                      <td className="mono"><span style={{ color: pnlColor(vPnl) }}>{money(vPnl)}</span></td>
                      <td className="mono"><span style={{ color: pnlColor(vToday) }}>{money(vToday)}</span></td>
                      <td colSpan={3} />
                    </tr>
                  </tfoot>
                );
              })()}
            </table>
          </div>
        </div>

        <div style={{ marginTop: 12, fontSize: 12, color: "var(--text-muted)" }}>
          Changes take effect immediately — no restart required. Figures are recalculated from your trades on every refresh; "today" uses the same day boundary the risk engine enforces limits against.
        </div>
      </div>
    </>
  );
}