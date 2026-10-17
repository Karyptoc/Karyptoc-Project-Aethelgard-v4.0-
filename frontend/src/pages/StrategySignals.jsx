import React, { useCallback, useEffect, useState } from "react";
import api from "../lib/api";

/**
 * Strategy Signals — what the strategy engine (A/B/C) decided at every checkpoint,
 * and what the risk layer did with it (sent, shadow-only, or skipped and why).
 * Refreshes every 60 seconds.
 */

const ACTION = {
  enter_long: { label: "ENTER LONG", cls: "bull" },
  enter_short: { label: "ENTER SHORT", cls: "bear" },
  reverse_long: { label: "REVERSE → LONG", cls: "bull" },
  reverse_short: { label: "REVERSE → SHORT", cls: "bear" },
  exit: { label: "EXIT", cls: "warn" },
  hold: { label: "HOLD", cls: "accent" },
  none: { label: "NO SIGNAL", cls: "muted" },
};
const POS = { 1: "LONG", "-1": "SHORT", 0: "FLAT" };
const fmt = (x, d = 2) => (x == null ? "—" : Number(x).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const when = (s) => new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const hhmm = (m) => (m == null ? "—" : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);

function ActionBadge({ action }) {
  const a = ACTION[action] || { label: (action || "—").toUpperCase(), cls: "muted" };
  return <span className={`badge ${a.cls}`}>{a.label}</span>;
}

function Decision({ s }) {
  const d = s.decision;
  if (!d) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  if (!d.approved) return <span className="badge bear" title={d.skip_reason || ""}>SKIPPED · {d.skip_reason || "no reason"}</span>;
  if (d.shadow) return <span className="badge muted">SHADOW · {d.final_lots} lots (not sent)</span>;
  return <span className="badge bull">SENT · {d.final_lots} lots</span>;
}

/** Where price sits between the lower and upper band. */
function BandGauge({ e }) {
  if (e.ub == null || e.lb == null || e.price == null) return null;
  const lb = Number(e.lb), ub = Number(e.ub), p = Number(e.price);
  const pad = (ub - lb) * 0.5 || 1;
  const lo = Math.min(lb - pad, p), hi = Math.max(ub + pad, p);
  const pct = (v) => `${(((v - lo) / (hi - lo)) * 100).toFixed(1)}%`;
  return (
    <div style={{ position: "relative", height: 18, margin: "10px 0 4px", background: "var(--bg-secondary, rgba(127,127,127,0.08))", borderRadius: 4 }}
      title={`Lower ${fmt(lb)} · Upper ${fmt(ub)} · Price ${fmt(p)}`}>
      <div style={{ position: "absolute", left: pct(lb), width: `calc(${pct(ub)} - ${pct(lb)})`, top: 0, bottom: 0, background: "rgba(127,127,127,0.25)", borderRadius: 4 }} />
      {e.vwap != null && <div style={{ position: "absolute", left: pct(Number(e.vwap)), top: 2, bottom: 2, width: 2, background: "var(--accent)" }} />}
      <div style={{ position: "absolute", left: pct(p), top: -3, bottom: -3, width: 3, marginLeft: -1, background: p > ub ? "var(--bull)" : p < lb ? "var(--bear)" : "var(--text-primary)" }} />
    </div>
  );
}

export default function StrategySignals() {
  const [strategy, setStrategy] = useState("");
  const [instrument, setInstrument] = useState("");
  const [actionable, setActionable] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [updated, setUpdated] = useState(null);

  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams({ limit: "300" });
      if (strategy) p.set("strategy", strategy);
      if (instrument) p.set("instrument", instrument);
      if (actionable) p.set("actionable", "1");
      const r = await api.get(`/api/strategy-admin/signals?${p}`);
      setData(r.data); setError(null); setUpdated(new Date());
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  }, [strategy, instrument, actionable]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 60000);
    return () => clearInterval(iv);
  }, [load]);

  const markets = data?.markets || [];
  const instruments = [...new Set(markets.map((m) => m.instrument).concat((data?.signals || []).map((s) => s.instrument)))].sort();
  const counts = data?.last24h || {};

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Strategy Signals</div>
          <div className="page-subtitle">EVERY CHECKPOINT DECISION · WHAT THE RISK LAYER DID WITH IT</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {updated && <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>updated {updated.toLocaleTimeString()}</span>}
          <button className="btn btn-ghost btn-sm" onClick={load}>↻ Refresh</button>
        </div>
      </div>

      <div className="page-body">
        {error && <div className="card" style={{ borderColor: "var(--bear)", color: "var(--bear)", padding: "10px 16px" }}>⚠ {error}</div>}

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <span className="card-title">Markets now (latest check in the last 24 hours)</span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              24h: {["enter_long", "enter_short", "exit", "hold", "none"].map((k) => `${(ACTION[k] || {}).label} ${counts[k] || 0}`).join(" · ")}
            </span>
          </div>
          {markets.length === 0 ? (
            <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>
              No checks in the last 24 hours. The engine only checks during each market's session (Nasdaq 09:30–16:00 New York,
              gold 08:20–13:30 New York) and only while the strategy bridge is running.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 }}>
              {markets.map((m) => (
                <div key={`${m.strategy_id}|${m.instrument}`} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontWeight: 800 }}>{m.instrument} <span className="badge accent">{m.strategy_id}</span></span>
                    <ActionBadge action={m.action} />
                  </div>
                  <BandGauge e={m} />
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
                    price {fmt(m.price)} · band {fmt(m.lb)} – {fmt(m.ub)}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
                    Position: <b>{POS[m.target] || "—"}</b> · {m.reason} · {when(m.eval_time)}{m.mode ? ` · ${m.mode}` : ""}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
          <select className="form-select" style={{ width: 200 }} value={strategy} onChange={(e) => setStrategy(e.target.value)}>
            <option value="">All strategies</option>
            <option value="A">A — Index momentum</option>
            <option value="B">B — Gold momentum</option>
            <option value="C">C — Daily trend</option>
          </select>
          <select className="form-select" style={{ width: 150 }} value={instrument} onChange={(e) => setInstrument(e.target.value)}>
            <option value="">All instruments</option>
            {instruments.map((x) => <option key={x}>{x}</option>)}
          </select>
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, color: "var(--text-secondary)" }}>
            <input type="checkbox" checked={actionable} onChange={(e) => setActionable(e.target.checked)} />
            Only entries, exits and reversals
          </label>
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">Signal log</span>
            <span className="badge accent">{(data?.signals || []).length} records</span>
          </div>
          {!data ? (
            <div style={{ padding: 24, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>Loading...</div>
          ) : data.signals.length === 0 ? (
            <div className="empty-state"><div className="empty-icon">⚡</div><div className="empty-text">No signals in this view</div></div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th><th>Strat</th><th>Instrument</th><th>Check</th><th>Signal</th><th>Price</th>
                    <th>Upper</th><th>Lower</th><th>VWAP</th><th>Position</th><th>Risk layer</th><th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {data.signals.map((s) => (
                    <tr key={s.id}>
                      <td className="mono" style={{ fontSize: 11 }}>{when(s.eval_time)}</td>
                      <td><span className="badge accent">{s.strategy_id}</span></td>
                      <td style={{ fontWeight: 700 }}>{s.instrument}</td>
                      <td className="mono" style={{ fontSize: 11 }} title="exchange local time">{hhmm(s.checkpoint_minute)}</td>
                      <td><ActionBadge action={s.action} /></td>
                      <td className="mono">{fmt(s.price)}</td>
                      <td className="mono" style={{ color: "var(--bull)" }}>{fmt(s.ub)}</td>
                      <td className="mono" style={{ color: "var(--bear)" }}>{fmt(s.lb)}</td>
                      <td className="mono">{fmt(s.vwap)}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{POS[s.position_before] || "—"} → {POS[s.target] || "—"}</td>
                      <td><Decision s={s} /></td>
                      <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>{s.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
