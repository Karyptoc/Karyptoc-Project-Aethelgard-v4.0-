import React, { useState, useEffect } from "react";
import api from "../lib/api";

function ConfBar({ value }) {
  const pct = Math.round((value || 0) * 100);
  const color = pct >= 75 ? "var(--bull)" : pct >= 60 ? "var(--warn)" : "var(--bear)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div className="conf-bar">
        <div className="conf-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}>{pct}%</span>
    </div>
  );
}

export default function Signals() {
  const [signals, setSignals] = useState([]);
  const [selected, setSelected] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [genSymbol, setGenSymbol] = useState("");

  const load = async () => {
    const r = await api.get("/api/signals");
    setSignals(r.data.signals || []);
  };

  useEffect(() => { load(); }, []);

  const generate = async (symbol) => {
    setGenerating(true);
    try {
      await api.post("/api/signals/generate", symbol ? { symbol } : {});
      await load();
    } finally { setGenerating(false); }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Signals</div>
          <div className="page-subtitle">AI-GENERATED TRADING SIGNALS · {signals.length} TOTAL</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <select className="form-select" style={{ width: 140 }} value={genSymbol} onChange={e => setGenSymbol(e.target.value)}>
            <option value="">All Pairs</option>
            {["GOLD","EURUSD","GBPUSD","USDJPY","US30Cash","GER40Cash","BTCUSD"].map(p => <option key={p}>{p}</option>)}
          </select>
          <button className="btn btn-primary" onClick={() => generate(genSymbol)} disabled={generating}>
            {generating ? "⚡ GENERATING..." : "⚡ GENERATE"}
          </button>
        </div>
      </div>
      <div className="page-body">
        <div style={{ display: "grid", gridTemplateColumns: selected ? "1fr 340px" : "1fr", gap: 16 }}>
          <div className="card">
            {signals.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">⚡</div>
                <div className="empty-text">No signals generated yet</div>
              </div>
            ) : (
              <table>
                <thead>
                  <tr><th>Time</th><th>Pair</th><th>Direction</th><th>Entry</th><th>SL</th><th>TP</th><th>Confidence</th><th>Regime</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {signals.map(sig => (
                    <tr key={sig.id} onClick={() => setSelected(sig)} style={{ cursor: "pointer" }}>
                      <td className="mono" style={{ fontSize: 10 }}>{new Date(sig.created_at).toLocaleString()}</td>
                      <td style={{ fontWeight: 700, color: "var(--text-primary)" }}>{sig.symbol}</td>
                      <td><span className={`badge ${sig.direction === "BUY" ? "bull" : sig.direction === "SELL" ? "bear" : "muted"}`}>{sig.direction}</span></td>
                      <td className="mono">{sig.entry_price || "—"}</td>
                      <td className="mono" style={{ color: "var(--bear)" }}>{sig.stop_loss || "—"}</td>
                      <td className="mono" style={{ color: "var(--bull)" }}>{sig.take_profit || "—"}</td>
                      <td><ConfBar value={sig.confidence} /></td>
                      <td><span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--text-muted)" }}>{(sig.regime || "").replace(/_/g, " ")}</span></td>
                      <td><span className={`badge ${sig.status === "executed" ? "bull" : sig.status === "pending" ? "warn" : "muted"}`}>{sig.status?.toUpperCase()}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {selected && (
            <div className="card" style={{ position: "sticky", top: 0, alignSelf: "start" }}>
              <div className="card-header">
                <span className="card-title">Signal Detail</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setSelected(null)}>✕</button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 22, fontWeight: 700 }}>{selected.symbol}</span>
                  <span className={`badge ${selected.direction === "BUY" ? "bull" : "bear"}`} style={{ fontSize: 14, padding: "6px 12px" }}>{selected.direction}</span>
                </div>
                <div style={{ background: "var(--bg-elevated)", borderRadius: 6, padding: 12 }}>
                  {[
                    ["Entry Price", selected.entry_price],
                    ["Stop Loss", selected.stop_loss],
                    ["Take Profit", selected.take_profit],
                    ["Confidence", `${Math.round((selected.confidence || 0) * 100)}%`],
                    ["Regime", (selected.regime || "").replace(/_/g, " ")],
                    ["Timeframe", selected.timeframe],
                    ["Sentiment", selected.sentiment_score],
                  ].map(([k, v]) => v && (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}>{k}</span>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-primary)" }}>{v}</span>
                    </div>
                  ))}
                </div>
                {selected.rationale && (
                  <div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--text-muted)", letterSpacing: 2, marginBottom: 6 }}>RATIONALE</div>
                    <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>{selected.rationale}</div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
