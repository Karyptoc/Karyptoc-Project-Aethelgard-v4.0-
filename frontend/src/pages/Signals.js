import React, { useState, useEffect, useCallback } from "react";
import api from "../lib/api";

const PAIRS = ["GOLD","EURUSD","GBPUSD","USDJPY","AUDUSD","USDCAD","USDCHF","NZDUSD","GBPJPY","EURJPY","US30Cash","GER40Cash","BTCUSD"];

function GradeBadge({ grade }) {
  const colors = { A: "bull", B: "accent", C: "warn", D: "bear" };
  return <span className={`badge ${colors[grade] || "muted"}`}>Grade {grade}</span>;
}

function ConfBar({ value }) {
  const pct = Math.round((value || 0) * 100);
  const color = pct >= 75 ? "var(--bull)" : pct >= 60 ? "var(--warn)" : "var(--bear)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div className="conf-bar"><div className="conf-bar-fill" style={{ width: `${pct}%`, background: color }} /></div>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}>{pct}%</span>
    </div>
  );
}

function formatMsg(sig) {
  const isBuy = sig.direction === "BUY";
  const dp = ["GOLD","US30Cash","GER40Cash","BTCUSD","GBPJPY","EURJPY"].includes(sig.symbol) ? 2 : 5;
  const rd = sig.regime_detail || {};
  return `${isBuy ? "🟢" : "🔴"} *AETHELGARD SIGNAL*

*${sig.symbol}* — ${sig.direction} | Grade ${rd.confluence_grade || "B"}
📊 ${(sig.regime||"").replace(/_/g," ")} | ${rd.session || ""}
🧠 HTF: ${(rd.htf_bias||"").toUpperCase()} | SMC: ${rd.confluence_score||0}/100
🎯 Confidence: ${Math.round((sig.confidence||0)*100)}%

💰 *Entry:* \`${sig.entry_price ? parseFloat(sig.entry_price).toFixed(dp) : "MARKET"}\`
🛑 *Stop Loss:* \`${sig.stop_loss ? parseFloat(sig.stop_loss).toFixed(dp) : "—"}\`
✅ *Take Profit:* \`${sig.take_profit ? parseFloat(sig.take_profit).toFixed(dp) : "—"}\`

📝 ${sig.rationale || "AI-generated signal"}

⚠️ _Risk 1-2% max. Past performance ≠ future results._
🤖 Aethelgard v6 | Karyptoc Solutions`;
}

function SignalCard({ sig, onShare, compact }) {
  const isBuy = sig.direction === "BUY";
  const rd = sig.regime_detail || {};
  const grade = rd.confluence_grade || "B";
  const dp = ["GOLD","US30Cash","GER40Cash","BTCUSD","GBPJPY","EURJPY"].includes(sig.symbol) ? 2 : 5;
  const statusColor = { executed: "bull", pending: "warn", sent: "blue", cancelled: "muted", expired: "muted" }[sig.status] || "muted";

  if (compact) {
    return (
      <div className={`signal-card ${isBuy ? "buy" : "sell"}`} style={{ padding: "10px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 800, fontSize: 14 }}>{sig.symbol}</span>
          <span className={`badge ${isBuy ? "bull" : "bear"}`}>{sig.direction}</span>
          <GradeBadge grade={grade} />
          <span className={`badge ${statusColor}`} style={{ marginLeft: "auto" }}>{sig.status?.toUpperCase()}</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 8 }}>
          {[["ENTRY", sig.entry_price, "var(--accent)"],["SL", sig.stop_loss, "var(--bear)"],["TP", sig.take_profit, "var(--bull)"]].map(([label, val, color]) => (
            <div key={label} style={{ background: "var(--bg-elevated)", borderRadius: 6, padding: "6px 8px", textAlign: "center" }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 8, color: "var(--text-muted)", marginBottom: 2 }}>{label}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, color }}>
                {val ? parseFloat(val).toFixed(dp) : "—"}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <ConfBar value={sig.confidence} />
          <button className="btn btn-ghost btn-xs" onClick={() => onShare(sig, "telegram")}>📱</button>
          <button className="btn btn-ghost btn-xs" onClick={() => onShare(sig, "copy")}>📋</button>
          <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--text-muted)" }}>
            {new Date(sig.created_at).toLocaleTimeString()}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={`signal-card ${isBuy ? "buy" : "sell"}`}>
      <div className="signal-header">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="signal-pair">{sig.symbol}</span>
            <span className={`badge ${isBuy ? "bull" : "bear"}`} style={{ fontSize: 12, padding: "4px 12px" }}>{sig.direction}</span>
            <GradeBadge grade={grade} />
            <span className={`badge ${statusColor}`}>{sig.status?.toUpperCase()}</span>
          </div>
          <div className="signal-time">{new Date(sig.created_at).toLocaleString()}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--text-muted)", marginBottom: 4 }}>SESSION</div>
          <div style={{ fontWeight: 600, color: "var(--accent)", fontSize: 12 }}>{rd.session || "—"}</div>
          {rd.htf_bias && (
            <span className={`badge ${rd.htf_bias === "bullish" ? "bull" : rd.htf_bias === "bearish" ? "bear" : "muted"}`} style={{ fontSize: 9, marginTop: 4, display: "inline-block" }}>
              HTF: {rd.htf_bias.toUpperCase()}
            </span>
          )}
        </div>
      </div>

      <div className="signal-levels">
        <div className="signal-level entry">
          <div className="signal-level-label">ENTRY</div>
          <div className="signal-level-value">{sig.entry_price ? parseFloat(sig.entry_price).toFixed(dp) : "MARKET"}</div>
        </div>
        <div className="signal-level sl">
          <div className="signal-level-label">STOP LOSS</div>
          <div className="signal-level-value">{sig.stop_loss ? parseFloat(sig.stop_loss).toFixed(dp) : "—"}</div>
        </div>
        <div className="signal-level tp">
          <div className="signal-level-label">TAKE PROFIT</div>
          <div className="signal-level-value">{sig.take_profit ? parseFloat(sig.take_profit).toFixed(dp) : "—"}</div>
        </div>
      </div>

      <div className="signal-meta">
        <ConfBar value={sig.confidence} />
        {sig.timeframe && <span className="badge blue">{sig.timeframe}</span>}
        <span className="badge muted">SMC: {rd.confluence_score || 0}/100</span>
      </div>

      {sig.rationale && <div className="signal-rationale">{sig.rationale}</div>}

      <div className="signal-actions">
        <button className="btn btn-ghost btn-xs" onClick={() => onShare(sig, "telegram")}>📱 Telegram</button>
        <button className="btn btn-ghost btn-xs" onClick={() => onShare(sig, "copy")}>📋 Copy</button>
      </div>
    </div>
  );
}

export default function Signals() {
  const [signals, setSignals] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [genSymbol, setGenSymbol] = useState("");
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState("cards");
  const [toast, setToast] = useState("");
  // FIX: Telegram config now lives server-side (see Settings.js + backend
  // services/telegram.js) instead of localStorage, and sending goes through
  // the backend proxy so the bot token never reaches the browser. This page
  // only needs to know WHETHER Telegram is configured, not the credentials.
  const [tgConfigured, setTgConfigured] = useState(false);
  const [autoSend, setAutoSend] = useState(() => localStorage.getItem("tg_auto_send") === "true");
  const sentRef = React.useRef(new Set());

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(""), 3500); };

  useEffect(() => {
    api.get("/api/system/telegram/config")
      .then(r => setTgConfigured(!!r.data.configured))
      .catch(() => setTgConfigured(false));
  }, []);

  const sendToTelegram = useCallback(async (text) => {
    try {
      const r = await api.post("/api/system/telegram/send", { text });
      return !!r.data.ok;
    } catch { return false; }
  }, []);

  const load = useCallback(async () => {
    const r = await api.get("/api/signals");
    const newSigs = r.data.signals || [];
    setSignals(newSigs);
    if (autoSend && tgConfigured) {
      const newExec = newSigs.filter(s => s.status === "executed" && !sentRef.current.has(s.id));
      for (const sig of newExec.slice(0, 3)) {
        sentRef.current.add(sig.id);
        await sendToTelegram(formatMsg(sig));
      }
    }
  }, [autoSend, tgConfigured, sendToTelegram]);

  useEffect(() => { load(); const iv = setInterval(load, 15000); return () => clearInterval(iv); }, [load]);

  const generate = async () => {
    setGenerating(true);
    try {
      await api.post("/api/signals/generate", genSymbol ? { symbol: genSymbol } : {});
      await load();
      showToast("⚡ Generation triggered");
    } catch (e) { showToast("❌ " + (e.response?.data?.error || e.message)); }
    finally { setGenerating(false); }
  };

  const handleShare = async (sig, type) => {
    const msg = formatMsg(sig);
    if (type === "telegram") {
      if (!tgConfigured) { showToast("⚠️ Configure Telegram in Settings first"); return; }
      const ok = await sendToTelegram(msg);
      showToast(ok ? "✅ Sent to Telegram!" : "❌ Telegram failed");
    } else {
      navigator.clipboard.writeText(msg);
      showToast("✅ Copied!");
    }
  };

  const filtered = signals.filter(s => {
    if (filter === "buy") return s.direction === "BUY";
    if (filter === "sell") return s.direction === "SELL";
    if (filter === "executed") return s.status === "executed";
    if (filter === "grade_a") return (s.regime_detail?.confluence_grade || "C") === "A";
    if (filter === "pending") return s.status === "pending";
    return true;
  });

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Signals</div>
          <div className="page-subtitle">ICT/SMC AI SIGNALS · {signals.length} TOTAL · {PAIRS.length} PAIRS</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {tgConfigured ? (
            <button className={`btn btn-sm ${autoSend ? "btn-success" : "btn-ghost"}`}
              onClick={() => { const v = !autoSend; setAutoSend(v); localStorage.setItem("tg_auto_send", v.toString()); showToast(v ? "✅ Auto-send ON" : "⏸ Auto-send OFF"); }}>
              {autoSend ? "📱 Auto ON" : "📱 Auto OFF"}
            </button>
          ) : (
            <a href="/settings" className="btn btn-ghost btn-sm" title="Configure Telegram in Settings">
              📱 Set up Telegram
            </a>
          )}
          <button className={`btn btn-sm ${view === "compact" ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setView(v => v === "cards" ? "compact" : "cards")}>
            {view === "cards" ? "⊞ Compact" : "⊟ Full"}
          </button>
          <select className="form-select" style={{ width: 130, padding: "7px 10px", fontSize: 13 }}
            value={genSymbol} onChange={e => setGenSymbol(e.target.value)}>
            <option value="">All Pairs</option>
            {PAIRS.map(p => <option key={p}>{p}</option>)}
          </select>
          <button className="btn btn-primary btn-sm" onClick={generate} disabled={generating}>
            {generating ? "⚡ Generating..." : "⚡ Generate"}
          </button>
        </div>
      </div>

      {toast && (
        <div style={{ position: "fixed", top: 20, right: 20, zIndex: 9999 }}>
          <div className="alert alert-info" style={{ margin: 0, minWidth: 260 }}>{toast}</div>
        </div>
      )}

      <div className="page-body">
        <div style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap" }}>
          {[["all","All"],["pending","Pending"],["executed","Executed"],["buy","BUY"],["sell","SELL"],["grade_a","Grade A"]].map(([v,l]) => (
            <button key={v} className={`btn btn-sm ${filter === v ? "btn-primary" : "btn-ghost"}`} onClick={() => setFilter(v)}>{l}</button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">⚡</div>
            <div className="empty-text">No signals — click Generate to analyze {PAIRS.length} pairs</div>
          </div>
        ) : (
          <div style={{
            display: "grid",
            gridTemplateColumns: view === "compact" ? "repeat(auto-fill, minmax(280px, 1fr))" : "repeat(auto-fill, minmax(420px, 1fr))",
            gap: 14
          }}>
            {filtered.map(sig => <SignalCard key={sig.id} sig={sig} onShare={handleShare} compact={view === "compact"} />)}
          </div>
        )}
      </div>
    </>
  );
}
