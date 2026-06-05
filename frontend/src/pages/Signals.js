import React, { useState, useEffect, useCallback } from "react";
import api from "../lib/api";

function ConfBar({ value }) {
  const pct = Math.round((value || 0) * 100);
  const color = pct >= 75 ? "var(--bull)" : pct >= 60 ? "var(--warn)" : "var(--bear)";
  return (
    <div className="conf-bar-wrap">
      <div className="conf-bar">
        <div className="conf-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)", minWidth: 30 }}>{pct}%</span>
    </div>
  );
}

function SignalCard({ sig, onShare }) {
  const isBuy = sig.direction === "BUY";
  const regime = (sig.regime || "").replace(/_/g, " ");
  const time = sig.created_at ? new Date(sig.created_at).toLocaleString() : "—";

  return (
    <div className={`signal-card ${isBuy ? "buy" : "sell"}`}>
      <div className="signal-header">
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span className="signal-pair">{sig.symbol}</span>
            <span className={`badge ${isBuy ? "bull" : "bear"}`} style={{ fontSize: 12, padding: "4px 12px" }}>
              {sig.direction}
            </span>
            <span className={`badge ${sig.status === "executed" ? "bull" : sig.status === "pending" ? "warn" : "muted"}`}>
              {sig.status?.toUpperCase()}
            </span>
          </div>
          <div className="signal-time">{time}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginBottom: 4 }}>REGIME</div>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 600 }}>{regime}</div>
        </div>
      </div>

      {/* Entry / SL / TP levels */}
      <div className="signal-levels">
        <div className="signal-level entry">
          <div className="signal-level-label">ENTRY</div>
          <div className="signal-level-value">{sig.entry_price ? parseFloat(sig.entry_price).toFixed(sig.symbol === "GOLD" ? 2 : 5) : "MKT"}</div>
        </div>
        <div className="signal-level sl">
          <div className="signal-level-label">STOP LOSS</div>
          <div className="signal-level-value">{sig.stop_loss ? parseFloat(sig.stop_loss).toFixed(sig.symbol === "GOLD" ? 2 : 5) : "—"}</div>
        </div>
        <div className="signal-level tp">
          <div className="signal-level-label">TAKE PROFIT</div>
          <div className="signal-level-value">{sig.take_profit ? parseFloat(sig.take_profit).toFixed(sig.symbol === "GOLD" ? 2 : 5) : "—"}</div>
        </div>
      </div>

      {/* Confidence + timeframe */}
      <div className="signal-meta">
        <ConfBar value={sig.confidence} />
        {sig.timeframe && (
          <span className="badge blue">{sig.timeframe}</span>
        )}
        {sig.sentiment_score != null && (
          <span className={`badge ${sig.sentiment_score > 0 ? "bull" : sig.sentiment_score < 0 ? "bear" : "muted"}`}>
            SENTIMENT {sig.sentiment_score > 0 ? "+" : ""}{parseFloat(sig.sentiment_score).toFixed(2)}
          </span>
        )}
      </div>

      {/* AI Rationale */}
      {sig.rationale && (
        <div className="signal-rationale">
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 2, color: "var(--text-muted)" }}>AI RATIONALE · </span>
          {sig.rationale}
        </div>
      )}

      {/* Actions */}
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

function formatSignalMessage(sig) {
  const isBuy = sig.direction === "BUY";
  const emoji = isBuy ? "🟢" : "🔴";
  const dp = sig.symbol === "GOLD" ? 2 : 5;
  return `${emoji} *AETHELGARD SIGNAL*

*${sig.symbol}* — ${sig.direction}
📊 Regime: ${(sig.regime || "").replace(/_/g, " ")}
🎯 Confidence: ${Math.round((sig.confidence || 0) * 100)}%

💰 Entry: \`${sig.entry_price ? parseFloat(sig.entry_price).toFixed(dp) : "MARKET"}\`
🛑 Stop Loss: \`${sig.stop_loss ? parseFloat(sig.stop_loss).toFixed(dp) : "—"}\`
✅ Take Profit: \`${sig.take_profit ? parseFloat(sig.take_profit).toFixed(dp) : "—"}\`

📝 ${sig.rationale || "AI-generated signal"}

⏱ TF: ${sig.timeframe || "H1"} | 🤖 Aethelgard Engine`;
}

export default function Signals() {
  const [signals, setSignals] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [genSymbol, setGenSymbol] = useState("");
  const [filter, setFilter] = useState("all");
  const [toast, setToast] = useState("");
  const [tgConfig, setTgConfig] = useState(() => JSON.parse(localStorage.getItem("tg_config") || "{}"));
  const [showTgModal, setShowTgModal] = useState(false);
  const [tgForm, setTgForm] = useState({ bot_token: tgConfig.bot_token || "", chat_id: tgConfig.chat_id || "" });

  const load = useCallback(async () => {
    const r = await api.get("/api/signals");
    setSignals(r.data.signals || []);
  }, []);

  useEffect(() => { load(); const iv = setInterval(load, 15000); return () => clearInterval(iv); }, [load]);

  const generate = async () => {
    setGenerating(true);
    try {
      await api.post("/api/signals/generate", genSymbol ? { symbol: genSymbol } : {});
      await load();
      showToast("Signal generation triggered!");
    } catch (e) {
      showToast("Generation failed: " + (e.response?.data?.error || e.message));
    } finally { setGenerating(false); }
  };

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  };

  const saveTgConfig = () => {
    localStorage.setItem("tg_config", JSON.stringify(tgForm));
    setTgConfig(tgForm);
    setShowTgModal(false);
    showToast("Telegram configured!");
  };

  const sendToTelegram = async (text) => {
    if (!tgConfig.bot_token || !tgConfig.chat_id) {
      setShowTgModal(true);
      return;
    }
    try {
      const r = await fetch(`https://api.telegram.org/bot${tgConfig.bot_token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: tgConfig.chat_id, text, parse_mode: "Markdown" })
      });
      const data = await r.json();
      if (data.ok) showToast("✅ Sent to Telegram!");
      else showToast("❌ Telegram error: " + data.description);
    } catch (e) {
      showToast("❌ Telegram failed: " + e.message);
    }
  };

  const handleShare = async (sig, type) => {
    const msg = formatSignalMessage(sig);
    if (type === "telegram") {
      await sendToTelegram(msg);
    } else {
      navigator.clipboard.writeText(msg);
      showToast("✅ Copied to clipboard!");
    }
  };

  const filtered = signals.filter(s => {
    if (filter === "buy") return s.direction === "BUY";
    if (filter === "sell") return s.direction === "SELL";
    if (filter === "executed") return s.status === "executed";
    return true;
  });

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Signals</div>
          <div className="page-subtitle">AI-GENERATED TRADING SIGNALS · {signals.length} TOTAL</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {tgConfig.bot_token ? (
            <span className="tg-badge" onClick={() => setShowTgModal(true)} style={{ cursor: "pointer" }}>
              ✈️ Telegram Active
            </span>
          ) : (
            <button className="btn btn-ghost btn-sm" onClick={() => setShowTgModal(true)}>
              📱 Setup Telegram
            </button>
          )}
          <select className="form-select" style={{ width: 130, padding: "8px 12px", fontSize: 13 }}
            value={genSymbol} onChange={e => setGenSymbol(e.target.value)}>
            <option value="">All Pairs</option>
            {["GOLD","EURUSD","GBPUSD","USDJPY"].map(p => <option key={p}>{p}</option>)}
          </select>
          <button className="btn btn-primary btn-sm" onClick={generate} disabled={generating}>
            {generating ? "⚡ Generating..." : "⚡ Generate"}
          </button>
        </div>
      </div>

      {toast && (
        <div style={{ position: "fixed", top: 20, right: 20, zIndex: 9999 }}>
          <div className="alert alert-info" style={{ margin: 0, minWidth: 280 }}>{toast}</div>
        </div>
      )}

      <div className="page-body">
        {/* Filter tabs */}
        <div style={{ display: "flex", gap: 6, marginBottom: 20 }}>
          {[["all","All"], ["buy","Buy Only"], ["sell","Sell Only"], ["executed","Executed"]].map(([v, l]) => (
            <button key={v} className={`btn btn-sm ${filter === v ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setFilter(v)}>{l}</button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">⚡</div>
            <div className="empty-text">No signals yet — click Generate to analyze markets</div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(420px, 1fr))", gap: 16 }}>
            {filtered.map(sig => (
              <SignalCard key={sig.id} sig={sig} onShare={handleShare} />
            ))}
          </div>
        )}
      </div>

      {/* Telegram Setup Modal */}
      {showTgModal && (
        <div className="modal-overlay" onClick={() => setShowTgModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">📱 Telegram Setup</div>
            <div className="alert alert-info" style={{ fontSize: 12 }}>
              <strong>How to set up:</strong><br/>
              1. Message <strong>@BotFather</strong> on Telegram → /newbot → copy the token<br/>
              2. Add your bot to your channel/group<br/>
              3. Get Chat ID: message @userinfobot or use @getidsbot<br/>
              4. For channels, prefix chat ID with -100
            </div>
            <div className="form-group">
              <label className="form-label">Bot Token</label>
              <input className="form-input" placeholder="1234567890:AAF..." value={tgForm.bot_token}
                onChange={e => setTgForm({ ...tgForm, bot_token: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Chat ID / Channel ID</label>
              <input className="form-input" placeholder="-1001234567890 or @yourchannel" value={tgForm.chat_id}
                onChange={e => setTgForm({ ...tgForm, chat_id: e.target.value })} />
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setShowTgModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveTgConfig}>Save & Connect</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
