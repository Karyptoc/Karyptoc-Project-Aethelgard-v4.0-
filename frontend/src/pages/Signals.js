import React, { useState, useEffect, useCallback } from "react";
import api from "../lib/api";

const PAIRS = ["GOLD","EURUSD","GBPUSD","USDJPY","US30Cash","GER40Cash","BTCUSD"];

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

function formatTelegramMessage(sig) {
  const isBuy = sig.direction === "BUY";
  const emoji = isBuy ? "🟢" : "🔴";
  const dp = ["GOLD","US30Cash","GER40Cash","BTCUSD"].includes(sig.symbol) ? 2 : 5;
  const rd = sig.regime_detail || {};
  const grade = rd.confluence_grade || "B";
  const session = rd.session || "";
  const htf = rd.htf_bias || "";
  const score = rd.confluence_score || 0;

  return `${emoji} *AETHELGARD SIGNAL* ${emoji}

*${sig.symbol}* — ${sig.direction} | Grade ${grade}
📊 ${(sig.regime || "").replace(/_/g, " ")} | ${session}
🧠 HTF Bias: ${htf.toUpperCase()} | SMC: ${score}/100
🎯 Confidence: ${Math.round((sig.confidence || 0) * 100)}%

💰 *Entry:* \`${sig.entry_price ? parseFloat(sig.entry_price).toFixed(dp) : "MARKET"}\`
🛑 *Stop Loss:* \`${sig.stop_loss ? parseFloat(sig.stop_loss).toFixed(dp) : "—"}\`
✅ *Take Profit:* \`${sig.take_profit ? parseFloat(sig.take_profit).toFixed(dp) : "—"}\`

📝 ${sig.rationale || "AI-generated signal"}

⚠️ _Risk 1-2% max. Past performance ≠ future results._
🤖 Aethelgard Engine v5 | Karyptoc Solutions`;
}

function SignalCard({ sig, onShare, compact = false }) {
  const isBuy = sig.direction === "BUY";
  const rd = sig.regime_detail || {};
  const grade = rd.confluence_grade || "B";
  const session = rd.session || "";
  const htfBias = rd.htf_bias || "";
  const score = rd.confluence_score || 0;
  const dp = ["GOLD","US30Cash","GER40Cash","BTCUSD"].includes(sig.symbol) ? 2 : 5;

  if (compact) {
    return (
      <div className={`signal-card ${isBuy ? "buy" : "sell"}`} style={{ padding: "12px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span className="signal-pair" style={{ fontSize: 16 }}>{sig.symbol}</span>
          <span className={`badge ${isBuy ? "bull" : "bear"}`}>{sig.direction}</span>
          <GradeBadge grade={grade} />
          <span className={`badge ${sig.status === "executed" ? "bull" : "warn"}`} style={{ marginLeft: "auto" }}>
            {sig.status?.toUpperCase()}
          </span>
        </div>
        <div className="signal-levels" style={{ gap: 6 }}>
          <div className="signal-level entry">
            <div className="signal-level-label">ENTRY</div>
            <div className="signal-level-value" style={{ fontSize: 11 }}>
              {sig.entry_price ? parseFloat(sig.entry_price).toFixed(dp) : "MKT"}
            </div>
          </div>
          <div className="signal-level sl">
            <div className="signal-level-label">SL</div>
            <div className="signal-level-value" style={{ fontSize: 11 }}>
              {sig.stop_loss ? parseFloat(sig.stop_loss).toFixed(dp) : "—"}
            </div>
          </div>
          <div className="signal-level tp">
            <div className="signal-level-label">TP</div>
            <div className="signal-level-value" style={{ fontSize: 11 }}>
              {sig.take_profit ? parseFloat(sig.take_profit).toFixed(dp) : "—"}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
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
            <span className={`badge ${isBuy ? "bull" : "bear"}`} style={{ fontSize: 12, padding: "4px 12px" }}>
              {sig.direction}
            </span>
            <GradeBadge grade={grade} />
            <span className={`badge ${sig.status === "executed" ? "bull" : sig.status === "pending" ? "warn" : "muted"}`}>
              {sig.status?.toUpperCase()}
            </span>
          </div>
          <div className="signal-time">{new Date(sig.created_at).toLocaleString()}</div>
        </div>
        <div style={{ textAlign: "right", fontSize: 12 }}>
          <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 9, marginBottom: 4 }}>SESSION</div>
          <div style={{ fontWeight: 600, color: "var(--accent)" }}>{session}</div>
          {htfBias && (
            <div style={{ marginTop: 4 }}>
              <span className={`badge ${htfBias === "bullish" ? "bull" : htfBias === "bearish" ? "bear" : "muted"}`} style={{ fontSize: 9 }}>
                HTF: {htfBias.toUpperCase()}
              </span>
            </div>
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
        <span className="badge muted">SMC: {score}/100</span>
        {sig.sentiment_score != null && (
          <span className={`badge ${sig.sentiment_score > 0 ? "bull" : "bear"}`}>
            SENT {sig.sentiment_score > 0 ? "+" : ""}{parseFloat(sig.sentiment_score).toFixed(2)}
          </span>
        )}
      </div>

      {sig.rationale && (
        <div className="signal-rationale">{sig.rationale}</div>
      )}

      <div className="signal-actions">
        <button className="btn btn-ghost btn-xs" onClick={() => onShare(sig, "telegram")}>
          📱 Telegram
        </button>
        <button className="btn btn-ghost btn-xs" onClick={() => onShare(sig, "copy")}>
          📋 Copy
        </button>
      </div>
    </div>
  );
}

export default function Signals() {
  const [signals, setSignals] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [genSymbol, setGenSymbol] = useState("");
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState("cards"); // cards | compact
  const [toast, setToast] = useState("");
  const [autoSend, setAutoSend] = useState(() => localStorage.getItem("tg_auto_send") === "true");
  const [tgConfig, setTgConfig] = useState(() => JSON.parse(localStorage.getItem("tg_config") || "{}"));
  const [showTgModal, setShowTgModal] = useState(false);
  const [tgForm, setTgForm] = useState({ bot_token: tgConfig.bot_token || "", chat_id: tgConfig.chat_id || "" });
  const sentSignals = React.useRef(new Set());

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(""), 3500); };

  const load = useCallback(async () => {
    const r = await api.get("/api/signals");
    const newSignals = r.data.signals || [];
    setSignals(newSignals);

    // Auto-send new executed signals to Telegram
    if (autoSend && tgConfig.bot_token && tgConfig.chat_id) {
      const newExecuted = newSignals.filter(s =>
        s.status === "executed" && !sentSignals.current.has(s.id)
      );
      for (const sig of newExecuted.slice(0, 3)) {
        sentSignals.current.add(sig.id);
        await sendToTelegram(formatTelegramMessage(sig));
      }
    }
  }, [autoSend, tgConfig]);

  useEffect(() => { load(); const iv = setInterval(load, 15000); return () => clearInterval(iv); }, [load]);

  const sendToTelegram = async (text) => {
    if (!tgConfig.bot_token || !tgConfig.chat_id) return false;
    try {
      const r = await fetch(`https://api.telegram.org/bot${tgConfig.bot_token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: tgConfig.chat_id, text, parse_mode: "Markdown" })
      });
      const data = await r.json();
      return data.ok;
    } catch { return false; }
  };

  const handleShare = async (sig, type) => {
    const msg = formatTelegramMessage(sig);
    if (type === "telegram") {
      if (!tgConfig.bot_token) { setShowTgModal(true); return; }
      const ok = await sendToTelegram(msg);
      showToast(ok ? "✅ Sent to Telegram!" : "❌ Telegram failed");
    } else {
      navigator.clipboard.writeText(msg);
      showToast("✅ Copied to clipboard!");
    }
  };

  const generate = async () => {
    setGenerating(true);
    try {
      await api.post("/api/signals/generate", genSymbol ? { symbol: genSymbol } : {});
      await load();
      showToast("⚡ Signal generation triggered");
    } catch (e) { showToast("❌ " + (e.response?.data?.error || e.message)); }
    finally { setGenerating(false); }
  };

  const saveTg = () => {
    localStorage.setItem("tg_config", JSON.stringify(tgForm));
    setTgConfig(tgForm);
    setShowTgModal(false);
    showToast("✅ Telegram configured!");
  };

  const toggleAutoSend = () => {
    const newVal = !autoSend;
    setAutoSend(newVal);
    localStorage.setItem("tg_auto_send", newVal.toString());
    showToast(newVal ? "✅ Auto-send enabled" : "⏸ Auto-send disabled");
  };

  const filtered = signals.filter(s => {
    if (filter === "buy") return s.direction === "BUY";
    if (filter === "sell") return s.direction === "SELL";
    if (filter === "executed") return s.status === "executed";
    if (filter === "grade_a") return (s.regime_detail?.confluence_grade || "C") === "A";
    return true;
  });

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Signals</div>
          <div className="page-subtitle">ICT/SMC AI SIGNALS · {signals.length} TOTAL</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {tgConfig.bot_token ? (
            <button
              className={`btn btn-sm ${autoSend ? "btn-success" : "btn-ghost"}`}
              onClick={toggleAutoSend}
              title="Auto-send new signals to Telegram"
            >
              {autoSend ? "📱 Auto ON" : "📱 Auto OFF"}
            </button>
          ) : (
            <button className="btn btn-ghost btn-sm" onClick={() => setShowTgModal(true)}>
              📱 Setup Telegram
            </button>
          )}
          <button className={`btn btn-ghost btn-sm ${view === "compact" ? "btn-primary" : ""}`}
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
        {/* Filters */}
        <div style={{ display: "flex", gap: 6, marginBottom: 20, flexWrap: "wrap" }}>
          {[["all","All"],["buy","BUY Only"],["sell","SELL Only"],["grade_a","Grade A Only"],["executed","Executed"]].map(([v,l]) => (
            <button key={v} className={`btn btn-sm ${filter === v ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setFilter(v)}>{l}</button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">⚡</div>
            <div className="empty-text">No signals — click Generate to analyze markets</div>
          </div>
        ) : (
          <div style={{
            display: "grid",
            gridTemplateColumns: view === "compact"
              ? "repeat(auto-fill, minmax(300px, 1fr))"
              : "repeat(auto-fill, minmax(420px, 1fr))",
            gap: 14
          }}>
            {filtered.map(sig => (
              <SignalCard key={sig.id} sig={sig} onShare={handleShare} compact={view === "compact"} />
            ))}
          </div>
        )}
      </div>

      {/* Telegram Modal */}
      {showTgModal && (
        <div className="modal-overlay" onClick={() => setShowTgModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">📱 Telegram Setup</div>
            <div className="alert alert-info" style={{ fontSize: 12, marginBottom: 16 }}>
              1. Message <strong>@BotFather</strong> → /newbot → copy token<br />
              2. Add bot to your channel/group as admin<br />
              3. Get chat ID from <strong>@userinfobot</strong><br />
              4. For channels: prefix ID with -100
            </div>
            <div className="form-group">
              <label className="form-label">Bot Token</label>
              <input className="form-input" placeholder="1234567890:AAF..." value={tgForm.bot_token}
                onChange={e => setTgForm({ ...tgForm, bot_token: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Chat ID</label>
              <input className="form-input" placeholder="-1001234567890 or @channel" value={tgForm.chat_id}
                onChange={e => setTgForm({ ...tgForm, chat_id: e.target.value })} />
            </div>
            <div className="toggle-wrap">
              <div className="toggle-info">
                <div className="toggle-label">Auto-send executed signals</div>
                <div className="toggle-desc">Automatically send to Telegram when signal executes</div>
              </div>
              <button className={`toggle ${autoSend ? "on" : ""}`} onClick={toggleAutoSend} />
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setShowTgModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveTg}>Save & Connect</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
