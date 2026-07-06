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

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(""), 3500); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get("/api/pairs/controls");
      setPairs(r.data.controls || []);
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
      await api.put(`/api/pairs/controls/${symbol}`, { enabled: true, auto_halted: false, auto_halt_reason: null });
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

  const haltedCount = pairs.filter(p => !p.enabled || p.auto_halted).length;
  const activeCount = pairs.length - haltedCount;
  const totalPnl = pairs.reduce((s, p) => s + parseFloat(p.total_pnl || 0), 0);

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Pair Controls</div>
          <div className="page-subtitle">HALT · RESUME · PER-PAIR RISK LIMITS · {pairs.length} PAIRS</div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>
          {loading ? "⟳" : "↻"} Refresh
        </button>
      </div>

      {toast && (
        <div style={{ position: "fixed", top: 20, right: 20, zIndex: 9999 }}>
          <div className="alert alert-info" style={{ margin: 0, minWidth: 260 }}>{toast}</div>
        </div>
      )}

      <div className="page-body">

        {/* Stats */}
        <div className="grid-4" style={{ marginBottom: 16, gap: 12 }}>
          {[
            ["Active Pairs", activeCount, "var(--bull)"],
            ["Halted Pairs", haltedCount, haltedCount > 0 ? "var(--bear)" : "var(--text-muted)"],
            ["Portfolio P&L", `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`, totalPnl >= 0 ? "var(--bull)" : "var(--bear)"],
            ["Total Pairs", pairs.length, "var(--accent)"],
          ].map(([label, value, color]) => (
            <div key={label} style={{ background: "var(--bg-elevated)", borderRadius: "var(--radius)", padding: "14px 16px" }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 2, color: "var(--text-muted)", marginBottom: 6 }}>
                {label.toUpperCase()}
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 22, fontWeight: 700, color }}>
                {value}
              </div>
            </div>
          ))}
        </div>

        {haltedCount > 0 && (
          <div className="alert alert-warn" style={{ marginBottom: 16, fontSize: 13 }}>
            ⚠️ <strong>{haltedCount} pair{haltedCount > 1 ? "s" : ""} halted.</strong> EURUSD halted due to 0% win rate and -$11.64 cumulative loss. Re-enable only after diagnosing the root cause.
          </div>
        )}

        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Pair</th>
                  <th>Status</th>
                  <th>Win Rate</th>
                  <th>Total P&L</th>
                  <th>Daily Loss Limit</th>
                  <th>Max Trades/Day</th>
                  <th>Auto-Halt Reason</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {pairs.map(p => {
                  const isHalted = !p.enabled || p.auto_halted;
                  const isEditing = editing?.symbol === p.symbol;
                  const isActing = acting === p.symbol;
                  const pnl = parseFloat(p.total_pnl || 0);
                  const wr = parseFloat(p.win_rate_pct || 0);

                  return (
                    <tr key={p.symbol} style={{ opacity: isHalted ? 0.65 : 1 }}>

                      {/* Pair */}
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700 }}>
                          <span style={{ fontSize: 18 }}>{PAIR_FLAGS[p.symbol] || "💱"}</span>
                          {p.symbol}
                        </div>
                      </td>

                      {/* Status */}
                      <td>
                        {p.auto_halted
                          ? <span className="badge bear">AUTO-HALTED</span>
                          : p.enabled
                            ? <span className="badge bull">ACTIVE</span>
                            : <span className="badge warn">HALTED</span>
                        }
                      </td>

                      {/* Win Rate */}
                      <td className="mono">
                        <span style={{ color: wr >= 50 ? "var(--bull)" : wr > 0 ? "var(--warn)" : "var(--text-muted)", fontWeight: 700 }}>
                          {wr.toFixed(0)}%
                        </span>
                      </td>

                      {/* Total P&L */}
                      <td className="mono">
                        <span className={pnl >= 0 ? "pnl-pos" : "pnl-neg"}>
                          {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                        </span>
                      </td>

                      {/* Daily Loss Limit */}
                      <td className="mono">
                        {isEditing
                          ? <input className="form-input" type="number" style={{ width: 80, padding: "4px 8px", fontSize: 12 }}
                              value={editing.max_daily_loss_usd}
                              onChange={e => setEditing({ ...editing, max_daily_loss_usd: parseFloat(e.target.value) })} />
                          : `$${parseFloat(p.max_daily_loss_usd).toFixed(2)}`
                        }
                      </td>

                      {/* Max Trades */}
                      <td className="mono">
                        {isEditing
                          ? <input className="form-input" type="number" style={{ width: 60, padding: "4px 8px", fontSize: 12 }}
                              value={editing.max_trades_per_day}
                              onChange={e => setEditing({ ...editing, max_trades_per_day: parseInt(e.target.value) })} />
                          : p.max_trades_per_day
                        }
                      </td>

                      {/* Auto-Halt Reason */}
                      <td style={{ maxWidth: 200 }}>
                        {p.auto_halted && p.auto_halt_reason
                          ? <span style={{ fontSize: 11, color: "var(--bear)", fontStyle: "italic" }}>{p.auto_halt_reason}</span>
                          : !p.enabled
                            ? <span style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic" }}>Manually halted</span>
                            : isEditing
                              ? <input className="form-input" type="text" placeholder="Notes..." style={{ width: 160, padding: "4px 8px", fontSize: 12 }}
                                  value={editing.notes || ""}
                                  onChange={e => setEditing({ ...editing, notes: e.target.value })} />
                              : <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{p.notes || "—"}</span>
                        }
                      </td>

                      {/* Actions */}
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
                                  </button>
                              }
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div style={{ marginTop: 12, fontSize: 12, color: "var(--text-muted)" }}>
          Changes take effect immediately — no restart required. The signal engine checks pair status before every signal generation cycle.
        </div>
      </div>
    </>
  );
}