import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import axios from "axios";

// FIX: this used to fall back to a hardcoded Render URL if
// REACT_APP_API_URL wasn't set. That made sense while Render was the
// backend, but after any future migration (e.g. to Railway) it becomes
// actively wrong — silently talking to a decommissioned backend instead
// of failing visibly. No fallback now; missing config surfaces as a
// clear error below instead.
const API_BASE = process.env.REACT_APP_API_URL;
const REFRESH_MS = 60000;

function api(token) {
  return axios.create({
    baseURL: API_BASE,
    headers: { "x-portal-token": token, "Content-Type": "application/json" }
  });
}

// ── Formatting helpers ───────────────────────────────────────────────────────

const num = v => parseFloat(v) || 0;
const sign = v => (num(v) > 0 ? "+" : num(v) < 0 ? "-" : "");
const pnlColor = v => (num(v) > 0 ? "var(--bull)" : num(v) < 0 ? "var(--bear)" : "var(--text-muted)");

function makeMoney(currency) {
  const prefix = !currency || currency === "USD" ? "$" : `${currency} `;
  const abs = v => `${prefix}${Math.abs(num(v)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return {
    plain: v => abs(v),
    signed: v => `${sign(v)}${abs(v)}`,
  };
}

const price = v => (v === null || v === undefined || v === "" ? "—" : String(parseFloat(v)));

function ago(iso) {
  if (!iso) return "—";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

const when = iso => (iso ? new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

// How a trade ended — wording for a client, not for an engineer.
const OUTCOME = {
  tp:       { label: "Take profit hit",        short: "TP hit",    cls: "bull" },
  sl:       { label: "Stop loss hit",          short: "SL hit",    cls: "bear" },
  stop_out: { label: "Closed by broker (margin)", short: "Stop-out", cls: "bear" },
  manual:   { label: "Closed manually",        short: "Closed",    cls: "muted" },
};
function outcomeOf(t) {
  if (t.status === "open") return { label: "Open", short: "Open", cls: "accent" };
  return OUTCOME[t.close_reason] || { label: "Closed", short: "Closed", cls: "muted" };
}

const ZONE_LABEL = {
  OB_BULL:  "Bullish order block",
  OB_BEAR:  "Bearish order block",
  FVG_BULL: "Bullish fair value gap",
  FVG_BEAR: "Bearish fair value gap",
};

// ── Small pieces ─────────────────────────────────────────────────────────────

function DirectionBadge({ direction }) {
  return <span className={`badge ${direction === "BUY" ? "bull" : "bear"}`}>{direction}</span>;
}

function Empty({ title, children }) {
  return (
    <div style={{ padding: "34px 24px", textAlign: "center" }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>{title}</div>
      {children && <div style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: 420, margin: "0 auto", lineHeight: 1.5 }}>{children}</div>}
    </div>
  );
}

function Section({ title, aside, children, flush, className = "" }) {
  return (
    <section className={`cp-section ${className}`.trim()}>
      <div className="cp-section-head">
        <h2>{title}</h2>
        {aside && <div className="cp-aside">{aside}</div>}
      </div>
      <div className={flush ? "" : "cp-section-body"}>{children}</div>
    </section>
  );
}

// Equity over the history window, rebuilt by walking back from today's equity
// through each day's net result. The curve is the portal's centrepiece, so it
// is large and can be inspected: hover (or touch) to read any day.
function EquityCurve({ history, equityNow, money }) {
  const [hover, setHover] = useState(null);
  const series = useMemo(() => {
    if (!history || history.length < 2) return [];
    const total = history.reduce((s, d) => s + num(d.net_pnl), 0);
    let run = num(equityNow) - total;
    return history.map(d => { run += num(d.net_pnl); return { date: d.date, v: run }; });
  }, [history, equityNow]);

  if (series.length < 2) {
    return (
      <div className="cp-curve cp-curve-empty">
        <svg viewBox="0 0 800 160" preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" x2="800" y1="100" y2="100" stroke="rgba(255,255,255,.22)" strokeDasharray="4 6" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>
        <p>Your equity curve appears here after your first full trading day.</p>
      </div>
    );
  }

  const W = 800, H = 160, top = 28, bottom = 10;
  const vals = series.map(p => p.v);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (max - min < 1e-9) { min -= 1; max += 1; }
  const padv = (max - min) * 0.12; min -= padv; max += padv;
  const n = series.length;
  const x = i => (i / (n - 1)) * W;
  const y = v => top + (1 - (v - min) / (max - min)) * (H - top - bottom);
  const line = series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const up = series[n - 1].v >= series[0].v;
  const color = up ? "var(--cp-gain)" : "var(--cp-loss)";

  const pick = clientX => {
    const r = document.getElementById("cp-curve-box")?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    setHover(Math.round(ratio * (n - 1)));
  };
  const h = hover === null ? null : series[hover];

  return (
    <div className="cp-curve" id="cp-curve-box"
      onMouseMove={e => pick(e.clientX)} onMouseLeave={() => setHover(null)}
      onTouchStart={e => pick(e.touches[0].clientX)} onTouchMove={e => pick(e.touches[0].clientX)} onTouchEnd={() => setHover(null)}
      role="img" aria-label={`Account equity over the last ${n} days, from ${money.plain(series[0].v)} to ${money.plain(series[n - 1].v)}`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="cp-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={up ? "#5BD6A6" : "#FF8F85"} stopOpacity="0.28" />
            <stop offset="1" stopColor={up ? "#5BD6A6" : "#FF8F85"} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${line} L${W},${H} L0,${H} Z`} fill="url(#cp-area)" />
        <path d={line} fill="none" stroke={color} strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      {h && (
        <>
          <div className="cp-curve-rule" style={{ left: `${(hover / (n - 1)) * 100}%` }} />
          <div className="cp-curve-dot" style={{ left: `${(hover / (n - 1)) * 100}%`, top: `${(y(h.v) / H) * 100}%`, background: color }} />
          <div className="cp-curve-tip" style={{ left: `${(hover / (n - 1)) * 100}%`, transform: `translateX(${hover > n * 0.7 ? "-105%" : "8px"})` }}>
            <strong>{money.plain(h.v)}</strong>
            <span>{new Date(h.date).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}</span>
          </div>
        </>
      )}
      <div className="cp-curve-axis">
        <span>{new Date(series[0].date).toLocaleDateString([], { day: "numeric", month: "short" })}</span>
        <span>Today</span>
      </div>
    </div>
  );
}

function Icon({ name }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
  if (name === "lock") return <svg {...common}><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;
  if (name === "check") return <svg {...common}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
  if (name === "monitor") return <svg {...common}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>;
  if (name === "cloud") return <svg {...common}><path d="M7 18a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 8.5a4.5 4.5 0 0 1 .5 9H7z" /></svg>;
  return null;
}

// Browsers aggressively autofill a text + password pair with the user's saved
// sign-in, which here is the admin's own email and password. The two hidden
// decoy fields absorb that autofill, the real password field is marked
// "new-password", and no <form> element is used so the browser never offers to
// save these as a login.
function MT5ConnectForm({ token, onConnected }) {
  const [method, setMethod] = useState("login");
  const [form, setForm] = useState({ mt5_login: "", mt5_password: "", mt5_server: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    if (!form.mt5_login || !form.mt5_password || !form.mt5_server) {
      return setError("Enter your MT5 login number, password and server.");
    }
    setLoading(true);
    setError("");
    try {
      await api(token).post("/api/copy-trading/portal/connect-mt5", form);
      onConnected();
    } catch (e) {
      setError(e.response?.data?.error || "We couldn't connect. Check the login number, password and server, then try again.");
    } finally {
      setLoading(false);
    }
  };
  const submitOnEnter = e => { if (e.key === "Enter") handleSubmit(); };

  const downloadBridge = () => {
    window.open(`${API_BASE}/api/copy-trading/portal/bridge-script?token=${token}`, "_blank");
  };

  const Method = ({ id, icon, title, text }) => (
    <button type="button" role="radio" aria-checked={method === id} className="cp-method" onClick={() => setMethod(id)}>
      <span className="cp-method-icon"><Icon name={icon} /></span>
      <span>
        <strong>{title}</strong>
        <small>{text}</small>
      </span>
      <span className="cp-method-tick"><Icon name="check" /></span>
    </button>
  );

  return (
    <div style={{ maxWidth: 560 }}>
      <div className="cp-methods" role="radiogroup" aria-label="How to connect">
        <Method id="login" icon="cloud" title="Enter your login details" text="We connect to your broker account from our server." />
        <Method id="script" icon="monitor" title="Run a script on your PC" text="MT5 stays on your own computer." />
      </div>

      {method === "login" ? (
        <div className="cp-fields">
          {/* Decoys that soak up browser autofill — never submitted or shown. */}
          <input type="text" name="username" autoComplete="username" tabIndex={-1} aria-hidden="true" className="cp-decoy" />
          <input type="password" name="password" autoComplete="current-password" tabIndex={-1} aria-hidden="true" className="cp-decoy" />

          <div>
            <label className="cp-label" htmlFor="cp-mt5-login">MT5 login number</label>
            <input id="cp-mt5-login" name="mt5-account-number" className="form-input" placeholder="For example 334414473"
              inputMode="numeric" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              data-lpignore="true" data-1p-ignore="true" data-form-type="other"
              value={form.mt5_login} onKeyDown={submitOnEnter}
              onChange={e => setForm({ ...form, mt5_login: e.target.value.replace(/\D/g, "") })} />
            <div className="cp-help">The number of your trading account, shown at the top of MetaTrader 5. It is not an email address.</div>
          </div>
          <div>
            <label className="cp-label" htmlFor="cp-mt5-pass">MT5 trading password</label>
            <input id="cp-mt5-pass" name="mt5-trading-secret" className="form-input" type="password"
              autoComplete="new-password" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              data-lpignore="true" data-1p-ignore="true" data-form-type="other"
              value={form.mt5_password} onKeyDown={submitOnEnter}
              onChange={e => setForm({ ...form, mt5_password: e.target.value })} />
            <div className="cp-help">Use your trading password. The read-only investor password can't place trades.</div>
          </div>
          <div>
            <label className="cp-label" htmlFor="cp-mt5-server">MT5 server</label>
            <input id="cp-mt5-server" name="mt5-server-name" className="form-input" placeholder="For example XMGlobal-MT5 9"
              autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              data-lpignore="true" data-1p-ignore="true" data-form-type="other"
              value={form.mt5_server} onKeyDown={submitOnEnter}
              onChange={e => setForm({ ...form, mt5_server: e.target.value })} />
            <div className="cp-help">Shown on your broker's login screen, next to your account number.</div>
          </div>

          {error && <div className="alert alert-error">{error}</div>}

          <button type="button" className="btn btn-primary cp-cta" onClick={handleSubmit} disabled={loading}>
            {loading ? "Connecting" : "Connect MT5 account"}
          </button>
          <div className="cp-trust"><Icon name="lock" /><span>Your login details are encrypted and used only to place and monitor trades on your account.</span></div>
        </div>
      ) : (
        <div className="cp-fields">
          <p className="cp-help" style={{ margin: 0, fontSize: 13 }}>
            The script runs on the computer where MetaTrader 5 is installed and sends your account updates to us. Your login stays on your computer.
          </p>
          <button type="button" className="btn btn-primary cp-cta" onClick={downloadBridge}>Download the script</button>
          <div className="cp-trust"><Icon name="monitor" /><span>MetaTrader 5 and the script must stay running for trades to be copied.</span></div>
        </div>
      )}
    </div>
  );
}

// Portal styling. Page chrome (surfaces, borders, text) follows the app theme so
// dark mode works; the hero panel is a fixed deep navy in both themes.
const PORTAL_CSS = `
  .cp-root { --cp-vault: #0E1C30; --cp-vault-line: rgba(255,255,255,.10); --cp-gold: #C8A24A; --cp-gain: #5BD6A6; --cp-loss: #FF8F85;
    min-height: 100vh; background: var(--bg-base); color: var(--text-primary); font-family: var(--font-main); -webkit-font-smoothing: antialiased; }
  .cp-root * { box-sizing: border-box; }
  .cp-center { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; text-align: center; background: var(--bg-base); color: var(--text-muted); font-size: 13px; font-family: var(--font-main); }
  .cp-center h1 { margin: 0; font-size: 18px; font-weight: 700; color: var(--text-primary); }
  .cp-center p { margin: 0; max-width: 380px; line-height: 1.55; }
  .cp-mark { width: 36px; height: 36px; border-radius: 10px; background: #0E1C30; color: #C8A24A; display: grid; place-items: center; font-weight: 700; font-size: 19px; letter-spacing: -.02em; flex: none; box-shadow: inset 0 0 0 1px rgba(200,162,74,.4); }
  .cp-pulse { animation: cp-pulse 1.4s ease-in-out infinite; }
  @keyframes cp-pulse { 50% { opacity: .45; } }

  .cp-top { background: var(--bg-surface); border-bottom: 1px solid var(--border); }
  .cp-top-in { max-width: 1040px; margin: 0 auto; padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .cp-brand { display: flex; align-items: center; gap: 11px; }
  .cp-brand b { display: block; font-size: 15px; font-weight: 700; letter-spacing: -.01em; line-height: 1.15; }
  .cp-brand small { display: block; font-size: 12px; color: var(--text-muted); }
  .cp-who { display: flex; align-items: center; gap: 12px; }
  .cp-who-name { font-size: 14px; font-weight: 600; text-align: right; }
  .cp-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px; white-space: nowrap; }
  .cp-pill i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
  .cp-pill.ok { color: var(--bull); background: var(--bull-dim); }
  .cp-pill.warn { color: var(--warn); background: var(--warn-dim); }

  .cp-wrap { max-width: 1040px; margin: 0 auto; padding: 20px 20px 44px; }

  .cp-hero { background: var(--cp-vault); color: #fff; border-radius: 20px; overflow: hidden; margin-bottom: 18px; box-shadow: 0 14px 34px -20px rgba(14,28,48,.6); }
  .cp-hero-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 26px 28px 0; }
  .cp-hero-label { font-size: 13px; color: rgba(255,255,255,.62); margin-bottom: 4px; }
  .cp-big { font-size: 54px; font-weight: 500; letter-spacing: -.035em; line-height: 1.05; font-variant-numeric: tabular-nums; }
  .cp-chg { margin-top: 12px; font-size: 13px; color: rgba(255,255,255,.66); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .cp-delta { font-weight: 600; padding: 3px 10px; border-radius: 999px; font-size: 13px; font-variant-numeric: tabular-nums; }
  .cp-delta.up { background: rgba(91,214,166,.14); color: var(--cp-gain); }
  .cp-delta.down { background: rgba(255,143,133,.14); color: var(--cp-loss); }
  .cp-delta.flat { background: rgba(255,255,255,.10); color: rgba(255,255,255,.82); }
  .cp-updated { font-size: 12px; color: rgba(255,255,255,.5); white-space: nowrap; padding-top: 4px; }

  .cp-curve { position: relative; height: 176px; margin-top: 4px; cursor: crosshair; touch-action: pan-y; }
  .cp-curve svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .cp-curve-axis { position: absolute; left: 28px; right: 28px; bottom: 8px; display: flex; justify-content: space-between; font-size: 12px; color: rgba(255,255,255,.45); pointer-events: none; }
  .cp-curve-empty { cursor: default; }
  .cp-curve-empty p { position: absolute; left: 28px; right: 28px; bottom: 16px; margin: 0; font-size: 13px; color: rgba(255,255,255,.62); }
  .cp-curve-rule { position: absolute; top: 0; bottom: 0; width: 1px; background: rgba(255,255,255,.28); pointer-events: none; }
  .cp-curve-dot { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; border: 2px solid var(--cp-vault); pointer-events: none; }
  .cp-curve-tip { position: absolute; top: 8px; background: #fff; color: #0E1C30; border-radius: 10px; padding: 7px 11px; font-size: 12px; display: flex; flex-direction: column; gap: 1px; box-shadow: 0 8px 20px -8px rgba(0,0,0,.5); pointer-events: none; white-space: nowrap; }
  .cp-curve-tip strong { font-size: 14px; font-variant-numeric: tabular-nums; }
  .cp-curve-tip span { color: #5B6779; }

  .cp-hero-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0; border-top: 1px solid var(--cp-vault-line); }
  .cp-hero-stats > div { padding: 16px 28px; border-left: 1px solid var(--cp-vault-line); min-width: 0; }
  .cp-hero-stats > div:first-child { border-left: 0; }
  .cp-hero-stats dt { font-size: 12px; color: rgba(255,255,255,.58); margin: 0 0 4px; }
  .cp-hero-stats dd { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: -.01em; font-variant-numeric: tabular-nums; }
  .cp-hero-stats .up { color: var(--cp-gain); }
  .cp-hero-stats .down { color: var(--cp-loss); }

  .cp-setup { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 14px; padding: 20px 22px 22px; margin-bottom: 18px; }
  .cp-setup h2 { margin: 0 0 4px; font-size: 16px; font-weight: 600; }
  .cp-setup > p { margin: 0 0 16px; font-size: 13px; color: var(--text-secondary); max-width: 62ch; line-height: 1.5; }
  .cp-steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .cp-step { border: 1px solid var(--border); border-radius: 12px; padding: 14px; display: flex; gap: 12px; align-items: flex-start; background: var(--bg-base); }
  .cp-step-n { flex: none; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center; font-size: 13px; font-weight: 600; border: 1.5px solid var(--border-bright); color: var(--text-muted); }
  .cp-step-n svg { width: 14px; height: 14px; }
  .cp-step[data-state="done"] .cp-step-n { background: var(--bull); border-color: var(--bull); color: #fff; }
  .cp-step[data-state="current"] { border-color: var(--accent); background: var(--bg-surface); box-shadow: 0 0 0 3px var(--accent-dim); }
  .cp-step[data-state="current"] .cp-step-n { border-color: var(--accent); color: var(--accent); }
  .cp-step strong { display: block; font-size: 14px; font-weight: 600; margin-bottom: 2px; }
  .cp-step small { display: block; font-size: 12.5px; color: var(--text-muted); line-height: 1.45; }
  .cp-step .btn { margin-top: 10px; }

  .cp-attn { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 12px 16px; border-radius: 12px; background: var(--warn-dim); border-left: 3px solid var(--warn); margin-bottom: 12px; font-size: 13px; }

  .cp-tabs-wrap { position: sticky; top: 0; z-index: 20; background: var(--bg-base); margin: 0 -20px 18px; padding: 0 20px; border-bottom: 1px solid var(--border); }
  .cp-tabs { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; }
  .cp-tabs::-webkit-scrollbar { display: none; }
  .cp-tab { appearance: none; background: none; border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; padding: 12px 14px; font: inherit; font-size: 14px; font-weight: 500; color: var(--text-secondary); cursor: pointer; white-space: nowrap; transition: color .15s, border-color .15s; }
  .cp-tab:hover { color: var(--text-primary); }
  .cp-tab[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
  .cp-tab:focus-visible, .cp-chip:focus-visible, .cp-method:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }

  .cp-section { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 14px; margin-bottom: 16px; overflow: hidden; }
  .cp-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 15px 20px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .cp-section-head h2 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -.005em; }
  .cp-aside { font-size: 12.5px; color: var(--text-muted); }
  .cp-section-body { padding: 18px 20px; }
  .cp-plan { box-shadow: inset 0 3px 0 var(--cp-gold); }
  .cp-kv { margin: 0; display: grid; grid-template-columns: 1fr auto; column-gap: 0; }
  .cp-kv dt, .cp-kv dd { margin: 0; padding: 11px 0; border-top: 1px solid var(--border); font-size: 13px; }
  .cp-kv dt:first-of-type, .cp-kv dt:first-of-type + dd { border-top: 0; padding-top: 0; }
  .cp-kv dt { color: var(--text-muted); }
  .cp-kv dd { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; padding-left: 16px; }
  .cp-note { margin: 14px 0 0; font-size: 12.5px; line-height: 1.55; color: var(--text-secondary); }

  .cp-chips { display: flex; gap: 6px; flex-wrap: wrap; }
  .cp-chip { appearance: none; border: 1px solid var(--border); background: var(--bg-surface); color: var(--text-secondary); border-radius: 999px; padding: 5px 13px; font: inherit; font-size: 12.5px; cursor: pointer; transition: background .15s, border-color .15s; }
  .cp-chip:hover { border-color: var(--border-bright); }
  .cp-chip[aria-pressed="true"] { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); font-weight: 600; }

  .cp-section .table-wrap { overflow-x: auto; }
  .cp-table th { background: var(--bg-elevated); font-family: var(--font-main); font-size: 12px; font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--text-muted); text-align: left; white-space: nowrap; padding: 10px 14px; }
  .cp-table td { padding: 12px 14px; font-size: 13px; }
  .cp-table tbody tr:hover { background: var(--bg-hover); }
  .cp-table .r { text-align: right; }
  .cp-table .num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }

  .cp-cols { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 16px; align-items: start; }
  .cp-side { position: sticky; top: 64px; }
  .cp-feed { list-style: none; margin: 0; padding: 0; }
  .cp-feed li { display: flex; gap: 10px; justify-content: space-between; align-items: center; padding: 12px 20px; border-top: 1px solid var(--border); font-size: 13px; }
  .cp-feed li:first-child { border-top: 0; }
  .cp-feed small { display: block; color: var(--text-muted); font-size: 12.5px; margin-top: 2px; }

  .cp-methods { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
  .cp-method { position: relative; display: flex; gap: 12px; align-items: flex-start; text-align: left; font: inherit; color: inherit; background: var(--bg-surface); border: 1.5px solid var(--border); border-radius: 12px; padding: 14px 40px 14px 14px; cursor: pointer; transition: border-color .15s, box-shadow .15s; }
  .cp-method:hover { border-color: var(--border-bright); }
  .cp-method[aria-checked="true"] { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-dim); }
  .cp-method strong { display: block; font-size: 14px; font-weight: 600; margin-bottom: 2px; }
  .cp-method small { display: block; font-size: 12.5px; color: var(--text-muted); line-height: 1.45; }
  .cp-method-icon { flex: none; width: 32px; height: 32px; border-radius: 9px; background: var(--bg-elevated); display: grid; place-items: center; color: var(--text-secondary); }
  .cp-method[aria-checked="true"] .cp-method-icon { background: var(--accent-dim); color: var(--accent); }
  .cp-method-tick { position: absolute; top: 12px; right: 12px; width: 20px; height: 20px; border-radius: 50%; background: var(--accent); color: #fff; display: none; place-items: center; }
  .cp-method-tick svg { width: 12px; height: 12px; }
  .cp-method[aria-checked="true"] .cp-method-tick { display: grid; }
  .cp-fields { display: flex; flex-direction: column; gap: 18px; }
  .cp-label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: var(--text-primary); }
  .cp-help { font-size: 12.5px; color: var(--text-muted); margin-top: 6px; line-height: 1.5; }
  .cp-decoy { position: absolute !important; opacity: 0; height: 0; width: 0; padding: 0; border: 0; pointer-events: none; }
  .cp-cta { width: 100%; padding: 12px 16px; font-size: 14px; }
  .cp-trust { display: flex; gap: 9px; align-items: flex-start; font-size: 12.5px; color: var(--text-muted); line-height: 1.5; }
  .cp-trust svg { flex: none; margin-top: 2px; }
  .cp-tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .cp-tile { border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; font-size: 13px; line-height: 1.55; color: var(--text-secondary); }
  .cp-tile strong { display: block; color: var(--text-primary); font-size: 14px; margin-bottom: 2px; }
  .cp-foot { margin: 28px 0 0; font-size: 12.5px; color: var(--text-muted); text-align: center; line-height: 1.6; }

  @media (max-width: 860px) {
    .cp-hero-top { padding: 22px 20px 0; flex-direction: column; gap: 10px; }
    .cp-updated { padding-top: 0; order: -1; }
    .cp-big { font-size: 42px; }
    .cp-curve { height: 150px; }
    .cp-curve-axis, .cp-curve-empty p { left: 20px; right: 20px; }
    .cp-hero-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .cp-hero-stats > div { padding: 14px 20px; }
    .cp-hero-stats > div:nth-child(odd) { border-left: 0; }
    .cp-hero-stats > div:nth-child(n+3) { border-top: 1px solid var(--cp-vault-line); }
    .cp-cols, .cp-methods, .cp-steps, .cp-tiles { grid-template-columns: 1fr; }
    .cp-side { position: static; }
    .cp-who-name { display: none; }
  }
  @media (prefers-reduced-motion: reduce) { .cp-root *, .cp-pulse { transition: none !important; animation: none !important; } }
`;

// ── Page ─────────────────────────────────────────────────────────────────────

const TABS = [
  ["overview", "Overview"],
  ["trades", "Trades"],
  ["signals", "Signals"],
  ["zones", "Zones"],
  ["results", "Daily results"],
  ["billing", "Billing"],
  ["account", "Account"],
];

export default function ClientPortalPublic() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [data, setData] = useState(null);
  const [trades, setTrades] = useState([]);
  const [signals, setSignals] = useState([]);
  const [zones, setZones] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [activeTab, setActiveTab] = useState("overview");
  const [tradeFilter, setTradeFilter] = useState("all"); // all | open | tp | sl | other
  const [zoneSymbol, setZoneSymbol] = useState("all");

  const loadData = useCallback(async () => {
    if (!API_BASE) {
      setError("This page isn't configured correctly (the server address is missing). Please contact support.");
      setLoading(false);
      return;
    }
    if (!token) { setError("This link is missing its access token. Use the full link you were sent."); setLoading(false); return; }
    try {
      const c = api(token);
      // Account + trades are essential; everything else is isolated so one
      // failing feed can never blank the portal.
      const [meRes, tradesRes] = await Promise.all([
        c.get("/api/copy-trading/portal/me"),
        c.get("/api/copy-trading/portal/trades"),
      ]);
      setData(meRes.data);
      setTrades(tradesRes.data.trades || []);
      const [sig, zn, inv] = await Promise.allSettled([
        c.get("/api/copy-trading/portal/signals"),
        c.get("/api/copy-trading/portal/zones"),
        c.get("/api/copy-trading/portal/fee-invoices"),
      ]);
      if (sig.status === "fulfilled") setSignals(sig.value.data.signals || []);
      if (zn.status === "fulfilled") setZones(zn.value.data.zones || []);
      if (inv.status === "fulfilled") setInvoices(inv.value.data.invoices || []);
      setUpdatedAt(new Date());
      setError("");
    } catch (e) {
      // A refresh failing after a successful first load keeps the last good view.
      setData(prev => { if (!prev) setError(e.response?.data?.error || "This link is invalid or has expired. Ask your account manager for a new one."); return prev; });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadData();
    const iv = setInterval(loadData, REFRESH_MS);
    return () => clearInterval(iv);
  }, [loadData]);

  const derived = useMemo(() => {
    const open = trades.filter(t => t.status === "open");
    const closed = trades.filter(t => t.status === "closed");
    const wins = closed.filter(t => num(t.profit) > 0).length;
    const recentCloses = closed
      .slice()
      .sort((a, b) => new Date(b.close_time || 0) - new Date(a.close_time || 0))
      .slice(0, 6);
    return { open, closed, wins, winRate: closed.length ? Math.round((wins / closed.length) * 100) : null, recentCloses };
  }, [trades]);

  if (loading) return (
    <div className="cp-root">
      <style>{PORTAL_CSS}</style>
      <div className="cp-center"><div className="cp-mark cp-pulse">Æ</div><div>Loading your account</div></div>
    </div>
  );

  if (error || !data) return (
    <div className="cp-root">
      <style>{PORTAL_CSS}</style>
      <div className="cp-center">
        <div className="cp-mark">Æ</div>
        <h1>We can't open this page</h1>
        <p>{error}</p>
      </div>
    </div>
  );

  const { account, today, history } = data;
  const M = makeMoney(account.currency);
  // Fee arrangement: a share of each winning trade ("profit_split") or a fixed
  // monthly amount ("fixed_fee"). Accounts created before the option existed
  // have no fee_model and are profit-split.
  const fixedFee = account.fee_model === "fixed_fee";
  const feeName = fixedFee ? "monthly fee" : "performance fee";
  const feeSummaryText = fixedFee
    ? `${M.plain(account.fixed_fee_amount)} per month`
    : `${num(account.performance_fee_pct)}% of profit, you keep ${(100 - num(account.performance_fee_pct)).toFixed(0)}%`;
  const pendingInvoices = invoices.filter(i => i.status === "pending");
  const paidInvoices = invoices.filter(i => i.status === "paid");

  const dayKey = d => new Date(d).toISOString().slice(0, 10);
  const weekStart = dayKey(Date.now() - 6 * 86400000);
  const weekPnl = history.filter(d => dayKey(d.date) >= weekStart).reduce((s, d) => s + num(d.net_pnl), 0);
  const monthPnl = history.reduce((s, d) => s + num(d.net_pnl), 0);
  const totalReturn = num(account.total_return_pct);

  // New-client setup guide: shown until the first trade has been copied.
  const stepDone = [!!account.is_connected, !!account.is_connected && !!account.copy_enabled, trades.length > 0];
  const currentStep = stepDone.findIndex(d => !d);
  const showSetup = trades.length === 0 && currentStep !== -1;
  const stepInfo = [
    { title: "Connect your MT5 account", text: stepDone[0] ? "Your account is connected." : "Add your login so trades can be copied to it." },
    { title: "Trade copying switched on", text: stepDone[1] ? "Copying is on." : account.is_connected ? "Copying is paused. Ask your account manager to turn it on." : "Turns on once your account is connected." },
    { title: "Your first trade", text: stepDone[2] ? "Your first trade has been copied." : "It appears here when the engine next places a trade." },
  ];
  const deltaClass = num(account.total_pnl) > 0 ? "up" : num(account.total_pnl) < 0 ? "down" : "flat";

  const attention = [];
  if (!account.is_connected && trades.length > 0) attention.push({ key: "conn", text: "Your MT5 account isn't connected, so new trades can't be copied.", action: "Reconnect", tab: "account" });
  if (pendingInvoices.length > 0) attention.push({
    key: "inv",
    text: `You have ${pendingInvoices.length} unpaid fee invoice${pendingInvoices.length > 1 ? "s" : ""} (${pendingInvoices.map(i => `${i.currency || ""} ${num(i.amount_due).toFixed(2)}`.trim()).join(" + ")}).`,
    action: "View and pay", tab: "billing",
  });

  const tradeRows = trades.filter(t => {
    if (tradeFilter === "all") return true;
    if (tradeFilter === "open") return t.status === "open";
    if (tradeFilter === "tp") return t.close_reason === "tp";
    if (tradeFilter === "sl") return t.close_reason === "sl";
    return t.status === "closed" && t.close_reason !== "tp" && t.close_reason !== "sl";
  });
  const tradeCounts = {
    all: trades.length,
    open: derived.open.length,
    tp: trades.filter(t => t.close_reason === "tp").length,
    sl: trades.filter(t => t.close_reason === "sl").length,
  };

  const zoneSymbols = [...new Set(zones.map(z => z.symbol))].sort();
  const zoneRows = zones.filter(z => zoneSymbol === "all" || z.symbol === zoneSymbol);

  const signalStatus = s => {
    if (s.taken) return outcomeOf({ status: s.outcome === "open" ? "open" : "closed", close_reason: s.outcome });
    if (s.status === "pending") return { label: "Waiting for entry", short: "Pending", cls: "warn" };
    return { label: "Not taken on your account", short: "Not taken", cls: "muted" };
  };

  const TradeTable = ({ rows, compact }) => (
    <div className="table-wrap">
      <table className="cp-table">
        <thead>
          <tr>
            <th>Pair</th><th>Side</th>
            <th className="r">Lots</th><th className="r">Entry</th><th className="r">Stop loss</th><th className="r">Take profit</th>
            {!compact && <th className="r">Exit</th>}
            <th>Result</th><th className="r">Profit / loss</th><th>{compact ? "Opened" : "Opened → closed"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(t => {
            const o = outcomeOf(t);
            return (
              <tr key={t.id}>
                <td style={{ fontWeight: 700 }}>{t.symbol}</td>
                <td><DirectionBadge direction={t.direction} /></td>
                <td className="r num">{t.lot_size}</td>
                <td className="r num">{price(t.open_price)}</td>
                <td className="r num" style={{ color: "var(--text-secondary)" }}>{price(t.stop_loss)}</td>
                <td className="r num" style={{ color: "var(--text-secondary)" }}>{price(t.take_profit)}</td>
                {!compact && <td className="r num">{t.status === "closed" ? price(t.close_price) : "—"}</td>}
                <td><span className={`badge ${o.cls}`} title={o.label}>{o.short}</span></td>
                <td className="r num" style={{ color: pnlColor(t.profit), fontWeight: 600 }}>
                  {t.status === "closed" ? M.signed(t.profit) : <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>—</span>}
                </td>
                <td style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                  {when(t.open_time)}{!compact && t.status === "closed" ? ` → ${when(t.close_time)}` : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="cp-root">
      <style>{PORTAL_CSS}</style>

      <header className="cp-top">
        <div className="cp-top-in">
          <div className="cp-brand">
            <div className="cp-mark">Æ</div>
            <div><b>Aethelgard</b><small>Client portal</small></div>
          </div>
          <div className="cp-who">
            <div className="cp-who-name">{account.name}</div>
            <span className={`cp-pill ${account.is_connected ? "ok" : "warn"}`}><i />{account.is_connected ? "Connected" : "Not connected"}</span>
          </div>
        </div>
      </header>

      <main className="cp-wrap">
        <section className="cp-hero" aria-label="Account summary">
          <div className="cp-hero-top">
            <div>
              <div className="cp-hero-label">Account equity</div>
              <div className="cp-big">{M.plain(account.equity)}</div>
              <div className="cp-chg">
                <span className={`cp-delta ${deltaClass}`}>{M.signed(account.total_pnl)} ({sign(totalReturn)}{Math.abs(totalReturn)}%)</span>
                <span>since you started with {M.plain(account.starting_balance)}</span>
              </div>
            </div>
            {updatedAt && <div className="cp-updated">Updated {updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>}
          </div>

          <EquityCurve history={history} equityNow={account.equity} money={M} />

          <dl className="cp-hero-stats">
            <div><dt>Today</dt><dd className={num(today.net_pnl) > 0 ? "up" : num(today.net_pnl) < 0 ? "down" : ""}>{M.signed(today.net_pnl)}</dd></div>
            <div><dt>Last 7 days</dt><dd className={weekPnl > 0 ? "up" : weekPnl < 0 ? "down" : ""}>{M.signed(weekPnl)}</dd></div>
            <div><dt>Win rate</dt><dd>{derived.winRate === null ? "No trades yet" : `${derived.winRate}%`}</dd></div>
            <div><dt>Open trades</dt><dd>{derived.open.length}</dd></div>
          </dl>
        </section>

        {showSetup && (
          <section className="cp-setup" aria-label="Account setup">
            <h2>{currentStep === 0 ? "Set up your account" : "You're nearly there"}</h2>
            <p>
              {currentStep === 0
                ? "Connect your MetaTrader 5 account and the engine's trades will be copied to it automatically. Setup takes about a minute."
                : "Your account is ready. The next trade the engine places will be copied and appear here."}
            </p>
            <ol className="cp-steps">
              {stepInfo.map((s, i) => {
                const state = stepDone[i] ? "done" : i === currentStep ? "current" : "todo";
                return (
                  <li key={s.title} className="cp-step" data-state={state}>
                    <span className="cp-step-n">{stepDone[i] ? <Icon name="check" /> : i + 1}</span>
                    <div>
                      <strong>{s.title}</strong>
                      <small>{s.text}</small>
                      {i === 0 && state === "current" && <button className="btn btn-primary btn-sm" onClick={() => setActiveTab("account")}>Connect now</button>}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {attention.map(a => (
          <div className="cp-attn" key={a.key}>
            <span>{a.text}</span>
            <button className="btn btn-primary btn-sm" onClick={() => setActiveTab(a.tab)}>{a.action}</button>
          </div>
        ))}

        <div className="cp-tabs-wrap">
          <div className="cp-tabs" role="tablist" aria-label="Portal sections">
            {TABS.map(([id, label]) => (
              <button key={id} role="tab" aria-selected={activeTab === id} className="cp-tab" onClick={() => setActiveTab(id)}>
                {label}
                {id === "billing" && pendingInvoices.length > 0 && <span className="badge warn" style={{ marginLeft: 6 }}>{pendingInvoices.length}</span>}
                {id === "trades" && derived.open.length > 0 && <span className="badge accent" style={{ marginLeft: 6 }}>{derived.open.length}</span>}
              </button>
            ))}
          </div>
        </div>

        {/* Overview */}
        {activeTab === "overview" && (
          <>
            <Section title="Open trades" aside={`${derived.open.length} running`} flush>
              {derived.open.length === 0
                ? <Empty title="No trades open right now">
                    {account.is_connected
                      ? "New trades from the engine appear here as soon as they are placed on your account."
                      : "Connect your MT5 account and trades appear here the moment the engine places them."}
                  </Empty>
                : <TradeTable rows={derived.open} compact />}
            </Section>

            <div className="cp-cols">
              <div>
                <Section title="Recent results" aside="Latest closed trades" flush>
                  {derived.recentCloses.length === 0
                    ? <Empty title="No closed trades yet">When a trade reaches its take profit or stop loss, it is listed here with the result.</Empty>
                    : (
                      <ul className="cp-feed">
                        {derived.recentCloses.map(t => {
                          const o = outcomeOf(t);
                          return (
                            <li key={t.id}>
                              <div>
                                <span className={`badge ${o.cls}`}>{o.short}</span>{" "}
                                <strong>{t.symbol}</strong> <span style={{ color: "var(--text-muted)" }}>{t.direction === "BUY" ? "buy" : "sell"}</span>
                                <small>{o.label}, {ago(t.close_time)}</small>
                              </div>
                              <div className="num" style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: pnlColor(t.profit) }}>{M.signed(t.profit)}</div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                </Section>

                <Section title="Latest signals" aside="From the engine" flush>
                  {signals.length === 0
                    ? <Empty title="No recent signals">Signals from the last 14 days appear here.</Empty>
                    : (
                      <ul className="cp-feed">
                        {signals.slice(0, 6).map(s => {
                          const st = signalStatus(s);
                          return (
                            <li key={s.id}>
                              <div>
                                <strong>{s.symbol}</strong> <DirectionBadge direction={s.direction} />
                                <small>{ago(s.created_at)}{s.grade ? `, grade ${s.grade}` : ""}</small>
                              </div>
                              <span className={`badge ${st.cls}`} title={st.label}>{st.short}</span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                </Section>
              </div>

              <div className="cp-side">
                <Section title="Your plan" className="cp-plan">
                  <dl className="cp-kv">
                    <dt>Fee type</dt><dd>{fixedFee ? "Fixed monthly fee" : "Profit split"}</dd>
                    {fixedFee ? (
                      <>
                        <dt>Monthly fee</dt><dd>{M.plain(account.fixed_fee_amount)}</dd>
                        {account.fixed_fee_next_due && <><dt>Next fee due</dt><dd>{new Date(account.fixed_fee_next_due).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}</dd></>}
                      </>
                    ) : (
                      <>
                        <dt>You keep</dt><dd>{(100 - num(account.performance_fee_pct)).toFixed(0)}% of profit</dd>
                        <dt>Our share</dt><dd>{num(account.performance_fee_pct)}% of profit</dd>
                      </>
                    )}
                    <dt>Fees owed</dt><dd style={{ color: num(account.pending_fee) > 0 ? "var(--warn)" : undefined }}>{M.plain(account.pending_fee)}</dd>
                    <dt>Balance</dt><dd>{M.plain(account.balance)}</dd>
                  </dl>
                  <p className="cp-note">
                    {fixedFee
                      ? "The monthly fee is charged whether or not trades win. Nothing is taken from individual trades."
                      : "Our share is taken from each winning trade as it closes. Losing trades carry no fee."}
                  </p>
                  <button className="btn btn-ghost btn-sm" style={{ marginTop: 12 }} onClick={() => setActiveTab("billing")}>View billing</button>
                </Section>
              </div>
            </div>
          </>
        )}

        {/* Trades */}
        {activeTab === "trades" && (
          <Section title="Your trades" aside={
            <div className="cp-chips">
              {[["all", "All"], ["open", "Open"], ["tp", "Take profit"], ["sl", "Stop loss"], ["other", "Other closes"]].map(([id, label]) => (
                <button key={id} className="cp-chip" aria-pressed={tradeFilter === id} onClick={() => setTradeFilter(id)}>
                  {label}{tradeCounts[id] !== undefined ? ` (${tradeCounts[id]})` : ""}
                </button>
              ))}
            </div>
          } flush>
            {tradeRows.length === 0
              ? <Empty title={trades.length === 0 ? "No trades yet" : "No trades match this filter"}>
                  {trades.length === 0 ? "Once the engine places a trade on your account, you'll see it here with its entry, stop loss, take profit and result." : "Choose a different filter above."}
                </Empty>
              : <TradeTable rows={tradeRows} />}
            {trades.length >= 300 && <div style={{ padding: "10px 18px", fontSize: 12, color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}>Showing your most recent 300 trades.</div>}
          </Section>
        )}

        {/* Signals */}
        {activeTab === "signals" && (
          <Section title="Signals" aside="Last 14 days" flush>
            {signals.length === 0
              ? <Empty title="No signals in the last 14 days">Signals are published when the engine finds a trade setup.</Empty>
              : (
                <div className="table-wrap">
                  <table className="cp-table">
                    <thead>
                      <tr>
                        <th>Time</th><th>Pair</th><th>Side</th><th>Order</th>
                        <th className="r">Entry</th><th className="r">Stop loss</th><th className="r">Take profit</th>
                        <th>Grade</th><th>On your account</th>
                      </tr>
                    </thead>
                    <tbody>
                      {signals.map(s => {
                        const st = signalStatus(s);
                        return (
                          <tr key={s.id}>
                            <td style={{ fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{when(s.created_at)}</td>
                            <td style={{ fontWeight: 700 }}>{s.symbol}</td>
                            <td><DirectionBadge direction={s.direction} /></td>
                            <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>{String(s.order_type || "MARKET").replace("_", " ").toLowerCase()}</td>
                            <td className="r num">{price(s.entry_price)}</td>
                            <td className="r num" style={{ color: "var(--text-secondary)" }}>{price(s.stop_loss)}</td>
                            <td className="r num" style={{ color: "var(--text-secondary)" }}>{price(s.take_profit)}</td>
                            <td>{s.grade ? <span className="badge accent">{s.grade}</span> : <span style={{ color: "var(--text-muted)" }}>—</span>}</td>
                            <td>
                              <span className={`badge ${st.cls}`} title={st.label}>{st.short}</span>
                              {s.taken && s.result_pnl !== null && s.result_pnl !== undefined && (
                                <span className="num" style={{ marginLeft: 8, fontFamily: "var(--font-mono)", fontSize: 12, color: pnlColor(s.result_pnl) }}>{M.signed(s.result_pnl)}</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            <div style={{ padding: "10px 18px", fontSize: 12, color: "var(--text-muted)", borderTop: "1px solid var(--border)" }}>
              A signal can be skipped on your account, for example when your own risk limits or the market conditions at the time didn't allow the entry.
            </div>
          </Section>
        )}

        {/* Zones */}
        {activeTab === "zones" && (
          <Section title="Zones the engine is watching" aside={
            zoneSymbols.length > 1 && (
              <div className="cp-chips">
                <button className="cp-chip" aria-pressed={zoneSymbol === "all"} onClick={() => setZoneSymbol("all")}>All pairs</button>
                {zoneSymbols.map(sym => (
                  <button key={sym} className="cp-chip" aria-pressed={zoneSymbol === sym} onClick={() => setZoneSymbol(sym)}>{sym}</button>
                ))}
              </div>
            )
          } flush>
            {zoneRows.length === 0
              ? <Empty title="No zones to show right now">Zones appear when the engine marks an area where price may react.</Empty>
              : (
                <div className="table-wrap">
                  <table className="cp-table">
                    <thead>
                      <tr><th>Pair</th><th>Zone</th><th className="r">From</th><th className="r">To</th><th>Status</th><th>Marked</th></tr>
                    </thead>
                    <tbody>
                      {zoneRows.map(z => (
                        <tr key={z.id}>
                          <td style={{ fontWeight: 700 }}>{z.symbol}</td>
                          <td>
                            <span style={{ color: z.zone_type.endsWith("BULL") ? "var(--bull)" : "var(--bear)", fontWeight: 600 }}>{ZONE_LABEL[z.zone_type] || z.zone_type}</span>
                          </td>
                          <td className="r num">{price(z.zone_low)}</td>
                          <td className="r num">{price(z.zone_high)}</td>
                          <td>{z.status === "touched"
                            ? <span className="badge warn" title={`Price reached this zone ${ago(z.touched_at)}`}>Price reached it</span>
                            : <span className="badge accent">Watching</span>}</td>
                          <td style={{ fontSize: 12, color: "var(--text-muted)" }}>{ago(z.detected_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            <div style={{ padding: "10px 18px", fontSize: 12, color: "var(--text-muted)", borderTop: "1px solid var(--border)", lineHeight: 1.5 }}>
              Zones are areas where the engine expects price to react. They are not trade instructions: a trade is only placed when the engine issues a signal.
            </div>
          </Section>
        )}

        {/* Daily results */}
        {activeTab === "results" && (
          <Section title="Daily results" aside="Last 30 days" flush>
            {history.length === 0
              ? <Empty title="No results yet">Your daily results appear here once trades have closed.</Empty>
              : (
                <div className="table-wrap">
                  <table className="cp-table">
                    <thead>
                      <tr>
                        <th>Date</th><th className="r">Trades</th><th>Wins / losses</th>
                        <th className="r">{fixedFee ? "Profit" : "Profit before fee"}</th><th className="r">{fixedFee ? "Fee" : `Fee (${account.performance_fee_pct}%)`}</th><th className="r">{fixedFee ? "Profit (no per-trade fee)" : "Profit after fee"}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...history].reverse().map((d, i) => (
                        <tr key={i}>
                          <td>{new Date(d.date).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}</td>
                          <td className="r num">{d.trades_count}</td>
                          <td style={{ fontSize: 12 }}>{d.winning_trades} won · {d.losing_trades} lost</td>
                          <td className="r num" style={{ color: pnlColor(d.gross_pnl) }}>{d.gross_pnl !== undefined ? M.signed(d.gross_pnl) : "—"}</td>
                          <td className="r num" style={{ color: "var(--text-muted)" }}>{fixedFee || d.performance_fee === undefined ? "—" : `-${M.plain(d.performance_fee)}`}</td>
                          <td className="r num" style={{ color: pnlColor(d.net_pnl), fontWeight: 600 }}>{M.signed(d.net_pnl)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </Section>
        )}

        {/* Billing */}
        {activeTab === "billing" && (
          <>
            <Section title="Fees to pay" aside={`Accrued fee ${M.plain(account.pending_fee)}`} flush>
              {pendingInvoices.length === 0 ? (
                <Empty title="You have no unpaid invoices">
                  {num(account.pending_fee) > 0
                    ? `Your accrued ${feeName} is ${M.plain(account.pending_fee)}. An invoice with a payment link appears here when it's issued.`
                    : "Nothing is due right now."}
                </Empty>
              ) : pendingInvoices.map(inv => (
                <div key={inv.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "16px 18px", borderTop: "1px solid var(--border)" }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 16 }}>{inv.currency || "USD"} {num(inv.amount_due).toFixed(2)}</div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                      {inv.notes || "Fee"} · issued {inv.created_at ? new Date(inv.created_at).toLocaleDateString() : "—"} · {inv.invoice_number}
                    </div>
                  </div>
                  {inv.payment_url
                    ? <a href={inv.payment_url} target="_blank" rel="noreferrer" className="btn btn-primary btn-sm">Pay now (M-Pesa or card)</a>
                    : <span className="badge muted">Payment link not ready yet</span>}
                </div>
              ))}
            </Section>

            <Section title="Payment history" flush>
              {paidInvoices.length === 0
                ? <Empty title="No payments yet" />
                : (
                  <div className="table-wrap">
                    <table className="cp-table">
                      <thead><tr><th>Invoice</th><th className="r">Amount</th><th>Paid on</th></tr></thead>
                      <tbody>
                        {paidInvoices.map(inv => (
                          <tr key={inv.id}>
                            <td className="num">{inv.invoice_number}</td>
                            <td className="r num" style={{ fontWeight: 600 }}>{inv.currency || "USD"} {num(inv.amount_due).toFixed(2)}</td>
                            <td style={{ fontSize: 12, color: "var(--text-muted)" }}>{inv.paid_at ? new Date(inv.paid_at).toLocaleDateString() : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </Section>

            <Section title="How fees work">
              <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6 }}>
                {fixedFee ? (
                  <>
                    Your fee is a fixed {M.plain(account.fixed_fee_amount)} per month, whether or not trades win. Nothing is taken from
                    individual trades, so your daily results show your full profit and loss.
                    {account.fixed_fee_next_due ? ` Your next monthly fee is due ${new Date(account.fixed_fee_next_due).toLocaleDateString()}.` : ""} Each fee is invoiced for payment.
                  </>
                ) : (
                  <>
                    You keep {(100 - num(account.performance_fee_pct)).toFixed(0)}% of your profits and the fee is {account.performance_fee_pct}% of the profit on each winning trade.
                    Losing trades carry no fee. Fees build up as trades close and are invoiced for payment; your daily results show the fee taken from each day's profit.
                  </>
                )}
              </p>
            </Section>
          </>
        )}

        {/* Account */}
        {activeTab === "account" && (
          <>
            <Section title="Your account">
              <dl className="cp-kv">
                <dt>Name</dt><dd>{account.name}</dd>
                <dt>MT5 connection</dt>
                <dd style={{ color: account.is_connected ? "var(--bull)" : "var(--warn)" }}>{account.is_connected ? "Connected" : "Not connected"}</dd>
                <dt>Trade copying</dt><dd>{account.copy_enabled ? "On" : "Paused"}</dd>
                <dt>Last update from your account</dt>
                <dd>{account.last_sync ? `${ago(account.last_sync)}` : "No update yet"}</dd>
                <dt>{fixedFee ? "Fixed fee" : "Profit split"}</dt>
                <dd>{feeSummaryText}</dd>
              </dl>
            </Section>

            <Section title={account.is_connected ? "Reconnect your MT5 account" : "Connect your MT5 account"}>
              <MT5ConnectForm token={token} onConnected={loadData} />
            </Section>

            <Section title="How copy trading works">
              <div className="cp-tiles">
                <div className="cp-tile"><strong>Automatic</strong>When the engine places a trade, your account opens the same trade. You don't need to do anything.</div>
                <div className="cp-tile"><strong>Sized to your account</strong>Lot sizes follow your balance, so a smaller account trades smaller lots than a larger one.</div>
                <div className="cp-tile"><strong>Protected</strong>Your account has its own daily loss and trade-count limits. A trade can be skipped when a limit has been reached.</div>
                <div className="cp-tile"><strong>Transparent</strong>Every trade, with its entry, stop loss, take profit and result, is listed under Trades.</div>
              </div>
            </Section>
          </>
        )}

        <p className="cp-foot">
          Trading involves risk, and you can lose money. Past performance does not guarantee future results.
        </p>
      </main>
    </div>
  );
}
