import React, { useCallback, useEffect, useState } from "react";
import api from "../lib/api";

/**
 * Strategy Control — admin page for the new strategy engine (Strategies A, B, C).
 * Talks to /api/strategy-admin; the backend enforces every limit and rule below,
 * so this page cannot push a setting past its hard ceiling.
 */

const MODES = ["off", "shadow", "demo", "live"];
const MODE_HELP = {
  off: "Not running",
  shadow: "Runs and logs decisions, sends no orders",
  demo: "Sends orders only to a demo account",
  live: "Sends real orders (needs approval)",
};
const STRATEGY_NAMES = {
  A: "A — Index intraday momentum",
  B: "B — Gold intraday momentum",
  C: "C — Daily trend ensemble",
};
const RISK_FIELDS = [
  ["perTradeRiskPct", "Max loss per trade (to emergency stop)"],
  ["dailyLossPct", "Daily loss limit"],
  ["weeklyLossPct", "Weekly loss limit"],
  ["maxDrawdownPct", "Account drawdown limit"],
  ["accountOpenRiskPct", "Total open risk"],
  ["maxMarginPct", "Max margin used"],
];

const row = { display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", margin: "8px 0" };
const lbl = { minWidth: 280, color: "var(--text-secondary)" };
const small = { color: "var(--text-muted)", fontSize: 12 };
const numInput = { width: 90 };
const errMsg = (e) => {
  const d = e.response?.data;
  return d?.errors ? d.errors.join("\n") : d?.error || e.message;
};

export default function StrategyControl() {
  const [settings, setSettings] = useState(null);
  const [ceilings, setCeilings] = useState({});
  const [pending, setPending] = useState({});
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState(null);
  const [audit, setAudit] = useState([]);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [s, a, st] = await Promise.all([
        api.get("/api/strategy-admin/settings"),
        api.get("/api/strategy-admin/audit"),
        api.get("/api/strategy-admin/status"),
      ]);
      setSettings(s.data.settings);
      setCeilings(s.data.ceilings || {});
      setAudit(a.data.audit || []);
      setStatus(st.data);
      setPending({});
    } catch (e) {
      setMsg({ type: "error", text: errMsg(e) });
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const get = (path) => (path in pending ? pending[path] : path.split(".").reduce((o, k) => (o == null ? o : o[k]), settings));
  const set = (path, value) => setPending((p) => ({ ...p, [path]: value }));
  const limit = (path) =>
    ceilings[path] ||
    ceilings[path.replace(/^strategies\.[ABC]\.riskBudgetPct$/, "strategies.*.riskBudgetPct")] ||
    ceilings[path.replace(/^clusters\.[A-Z_]+$/, "clusters.*")];

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const changes = Object.entries(pending).map(([path, value]) => ({ path, value }));
      const r = await api.post("/api/strategy-admin/settings", { changes, reason });
      setMsg({ type: "ok", text: ["Saved.", ...(r.data.notices || [])].join(" ") });
      setReason("");
      await reload();
    } catch (e) { setMsg({ type: "error", text: errMsg(e) }); }
    setBusy(false);
  }

  async function kill(on, mode = "freeze") {
    if (on && mode === "flatten" && !window.confirm("Close ALL open positions from the strategy engine and stop trading?")) return;
    setBusy(true); setMsg(null);
    try {
      await api.post("/api/strategy-admin/kill", { on, mode, reason });
      setMsg({ type: "ok", text: on ? `Kill switch ON (${mode}).` : "Kill switch OFF." });
      setReason("");
      await reload();
    } catch (e) { setMsg({ type: "error", text: errMsg(e) }); }
    setBusy(false);
  }

  async function flatten(strategy) {
    if (!window.confirm(`Close all positions of strategy ${strategy}?`)) return;
    try {
      await api.post("/api/strategy-admin/flatten", { strategy, reason });
      setMsg({ type: "ok", text: `Close-all for strategy ${strategy} queued.` });
    } catch (e) { setMsg({ type: "error", text: errMsg(e) }); }
  }

  // Render helper (not a component) so inputs keep focus while typing.
  const numberField = (path, label, step = 0.05) => {
    const lim = limit(path);
    const v = get(path);
    return (
      <label key={path} style={row}>
        <span style={lbl}>{label}</span>
        <input className="form-input" type="number" style={numInput} step={step} min={lim?.[0]} max={lim?.[1]}
          value={v ?? ""} onChange={(e) => set(path, e.target.value === "" ? null : Number(e.target.value))} />
        {lim && <span style={small}>allowed {lim[0]}–{lim[1]}</span>}
      </label>
    );
  };

  if (!settings) {
    return (
      <>
        <div className="page-header"><div><div className="page-title">Strategy Control</div></div></div>
        <div className="page-body">{msg ? <pre style={{ whiteSpace: "pre-wrap", color: "var(--bear)" }}>{msg.text}</pre> : "Loading…"}</div>
      </>
    );
  }

  const killed = settings.global.killSwitch;
  const nPending = Object.keys(pending).length;

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Strategy Control</div>
          <div className="page-subtitle">STRATEGIES A · B · C · RISK LIMITS · INSTRUMENTS · SETTINGS v{settings.version}</div>
        </div>
      </div>

      <div className="page-body" style={{ display: "grid", gap: 16, maxWidth: 1000 }}>
        {msg && (
          <pre style={{ whiteSpace: "pre-wrap", margin: 0, padding: 12, borderRadius: 8,
            background: msg.type === "error" ? "var(--bear-dim)" : "var(--bull-dim)",
            color: msg.type === "error" ? "var(--bear)" : "var(--bull)" }}>{msg.text}</pre>
        )}

        <div className="card" style={{ borderColor: killed ? "var(--bear)" : undefined }}>
          <div className="card-header"><div className="card-title">Kill switch — {killed ? `ON (${settings.global.killMode})` : "off"}</div></div>
          <div style={row}>
            {!killed ? (
              <>
                <button className="btn btn-ghost" disabled={busy} onClick={() => kill(true, "freeze")}>Stop new trades</button>
                <button className="btn btn-danger" disabled={busy} onClick={() => kill(true, "flatten")}>Stop and close everything</button>
              </>
            ) : (
              <button className="btn btn-success" disabled={busy || !reason.trim()} onClick={() => kill(false)}>Resume trading (write a reason below first)</button>
            )}
          </div>
          <div style={small}>Applies to the new strategy engine only. The old engine is controlled from the System page.</div>
        </div>

        <div className="card">
          <div className="card-header"><div className="card-title">Account</div></div>
          <label style={row}>
            <span style={lbl}>Broker profile</span>
            <select className="form-select" value={get("global.brokerProfile")} onChange={(e) => set("global.brokerProfile", e.target.value)}>
              {["XM", "HFM", "EXNESS", "PEPPERSTONE"].map((b) => <option key={b}>{b}</option>)}
            </select>
          </label>
          <label style={row}>
            <span style={lbl}>Connected account type</span>
            <select className="form-select" value={get("global.accountType")} onChange={(e) => set("global.accountType", e.target.value)}>
              <option value="demo">demo</option><option value="live">live</option>
            </select>
          </label>
          {numberField("global.newsBlackoutBeforeMin", "News blackout before release (min)", 1)}
          {numberField("global.newsBlackoutAfterMin", "News blackout after release (min)", 1)}
        </div>

        <div className="card">
          <div className="card-header"><div className="card-title">Strategies</div></div>
          {["A", "B", "C"].map((id) => {
            const s = settings.strategies[id];
            const mode = get(`strategies.${id}.mode`);
            return (
              <div key={id} style={{ borderTop: "1px solid var(--border)", paddingTop: 10, marginTop: 10 }}>
                <div style={row}>
                  <strong style={{ minWidth: 280 }}>{STRATEGY_NAMES[id]}</strong>
                  <select className="form-select" value={mode} onChange={(e) => set(`strategies.${id}.mode`, e.target.value)}>
                    {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <span style={small}>{MODE_HELP[mode]}</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => flatten(id)}>Close {id} positions</button>
                </div>
                <div style={small}>Parameters v{s.paramsVersion} · {s.liveApproved ? `approved for live (${s.approvalRef})` : "not approved for live"}</div>
                {numberField(`strategies.${id}.riskBudgetPct`, "Risk budget (% of equity)")}
                {id !== "C" && numberField(`strategies.${id}.params.lookback`, "Lookback (sessions) — changing creates a new version", 1)}
                {id !== "C" && numberField(`strategies.${id}.params.vm`, "Volatility multiplier — changing creates a new version", 0.1)}
                {id === "C" && numberField("strategies.C.params.portfolioVolTarget", "Portfolio volatility target — changing creates a new version", 0.01)}
                <label style={row}>
                  <span style={lbl}>Live approval (validation report link)</span>
                  <input className="form-input" style={{ width: 280 }} value={get(`strategies.${id}.approvalRef`) || ""}
                    onChange={(e) => set(`strategies.${id}.approvalRef`, e.target.value)} />
                  <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input type="checkbox" checked={!!get(`strategies.${id}.liveApproved`)} onChange={(e) => set(`strategies.${id}.liveApproved`, e.target.checked)} />
                    approved
                  </label>
                </label>
              </div>
            );
          })}
        </div>

        <div className="card">
          <div className="card-header"><div className="card-title">Risk limits (% of equity)</div></div>
          {RISK_FIELDS.map(([k, label]) => numberField(`risk.${k}`, label))}
          <div className="card-title" style={{ marginTop: 16 }}>Correlation cluster budgets</div>
          {Object.keys(settings.clusters).map((c) => numberField(`clusters.${c}`, c))}
        </div>

        <div className="card">
          <div className="card-header"><div className="card-title">Instruments</div></div>
          <div className="table-wrap">
            <table style={{ width: "100%" }}>
              <thead>
                <tr><th align="left">Instrument</th><th>On</th><th>A</th><th>B</th><th>C</th><th align="left">Broker symbol override</th><th>Max spread (pts)</th></tr>
              </thead>
              <tbody>
                {Object.keys(settings.symbols).map((id) => {
                  const strats = get(`symbols.${id}.strategies`) || [];
                  const toggle = (sid) => set(`symbols.${id}.strategies`, strats.includes(sid) ? strats.filter((x) => x !== sid) : [...strats, sid]);
                  return (
                    <tr key={id}>
                      <td>{id}</td>
                      <td align="center"><input type="checkbox" checked={!!get(`symbols.${id}.enabled`)} onChange={(e) => set(`symbols.${id}.enabled`, e.target.checked)} /></td>
                      {["A", "B", "C"].map((sid) => (
                        <td key={sid} align="center"><input type="checkbox" checked={strats.includes(sid)} onChange={() => toggle(sid)} /></td>
                      ))}
                      <td><input className="form-input" style={{ width: 140 }} placeholder="auto" value={get(`symbols.${id}.brokerSymbol`) || ""}
                        onChange={(e) => set(`symbols.${id}.brokerSymbol`, e.target.value || null)} /></td>
                      <td align="center"><input className="form-input" type="number" style={numInput} placeholder="auto" value={get(`symbols.${id}.maxSpreadPoints`) ?? ""}
                        onChange={(e) => set(`symbols.${id}.maxSpreadPoints`, e.target.value === "" ? null : Number(e.target.value))} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={small}>A strategy can only be switched on for instruments it was designed for; the server rejects anything else.</div>
        </div>

        <div className="card" style={{ position: "sticky", bottom: 0, zIndex: 2 }}>
          <div style={row}>
            <input className="form-input" style={{ flex: 1, minWidth: 220 }} placeholder="Reason for this change (saved in the audit log)"
              value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="btn btn-primary" disabled={!nPending || busy} onClick={save}>Save {nPending || ""} change(s)</button>
            <button className="btn btn-ghost" disabled={!nPending || busy} onClick={() => setPending({})}>Discard</button>
          </div>
        </div>

        {status && (
          <div className="card">
            <div className="card-header"><div className="card-title">Health</div></div>
            <div>Last reconciliation: {status.lastReconciliation
              ? `${new Date(status.lastReconciliation.created_at).toLocaleString()} — ${status.lastReconciliation.mismatch ? "MISMATCH" : "ok"}`
              : "none yet"}</div>
            <div className="card-title" style={{ marginTop: 12 }}>Recent skipped signals</div>
            {status.recentSkips.length === 0 ? <div style={small}>None yet.</div> : (
              <ul>{status.recentSkips.slice(0, 15).map((s, i) => (
                <li key={i}>{new Date(s.created_at).toLocaleString()} · {s.strategy_id} {s.symbol}: {s.skip_reason}</li>
              ))}</ul>
            )}
          </div>
        )}

        <div className="card">
          <div className="card-header"><div className="card-title">Audit log</div></div>
          {audit.length === 0 ? <div style={small}>No changes yet.</div> : (
            <ul className="mono" style={{ fontSize: 12 }}>{audit.slice(0, 50).map((a) => (
              <li key={a.id}>{new Date(a.created_at).toLocaleString()} · {a.actor} · {a.path}: {JSON.stringify(a.old_value)} → {JSON.stringify(a.new_value)}{a.reason ? ` — ${a.reason}` : ""}</li>
            ))}</ul>
          )}
        </div>
      </div>
    </>
  );
}
