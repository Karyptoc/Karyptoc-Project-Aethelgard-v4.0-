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
    <div style={{ padding: "28px 20px", textAlign: "center" }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>{title}</div>
      {children && <div style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: 420, margin: "0 auto", lineHeight: 1.5 }}>{children}</div>}
    </div>
  );
}

function Section({ title, aside, children, flush }) {
  return (
    <section className="cp-section">
      <div className="cp-section-head">
        <h2>{title}</h2>
        {aside && <div className="cp-aside">{aside}</div>}
      </div>
      <div className={flush ? "" : "cp-section-body"}>{children}</div>
    </section>
  );
}

// Cumulative net P&L over the history window, drawn as one quiet line.
function PnlLine({ history, color }) {
  if (!history || history.length < 2) return null;
  let run = 0;
  const pts = history.map(d => (run += num(d.net_pnl)));
  const min = Math.min(0, ...pts), max = Math.max(0, ...pts);
  const range = max - min || 1;
  const W = 400, H = 70, pad = 4;
  const x = i => (i / (pts.length - 1)) * W;
  const y = v => pad + (1 - (v - min) / range) * (H - pad * 2);
  const line = pts.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const zeroY = y(0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
      aria-label="Cumulative profit and loss, last 30 days" style={{ width: "100%", height: 70, display: "block" }}>
      <line x1="0" x2={W} y1={zeroY} y2={zeroY} stroke="var(--border-bright)" strokeDasharray="3 4" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      <path d={`${line} L${W},${zeroY} L0,${zeroY} Z`} fill={color} opacity="0.10" />
      <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function MT5ConnectForm({ token, onConnected }) {
  const [form, setForm] = useState({ mt5_login: "", mt5_password: "", mt5_server: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    if (!form.mt5_login || !form.mt5_password || !form.mt5_server) {
      return setError("Enter your MT5 login, password and server.");
    }
    setLoading(true);
    setError("");
    try {
      await api(token).post("/api/copy-trading/portal/connect-mt5", form);
      onConnected();
    } catch (e) {
      setError(e.response?.data?.error || "Couldn't connect. Check the details and try again.");
    } finally {
      setLoading(false);
    }
  };

  const downloadBridge = () => {
    window.open(`${API_BASE}/api/copy-trading/portal/bridge-script?token=${token}`, "_blank");
  };

  return (
    <div style={{ maxWidth: 520 }}>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "0 0 14px", lineHeight: 1.5 }}>
        Choose how to connect your MetaTrader 5 account so trades can be copied to it.
      </p>
      <div className="cp-two">
        <div style={{ border: "2px solid var(--accent)", borderRadius: "var(--radius)", padding: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Enter your login details</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.45 }}>Your broker account is connected from our server. Fill in the form below.</div>
        </div>
        <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Run a script on your PC</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.45 }}>MT5 stays on your computer.</div>
          <button className="btn btn-ghost btn-xs" style={{ marginTop: 8 }} onClick={downloadBridge}>Download script</button>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
        <div>
          <label className="form-label" htmlFor="mt5l">MT5 login number</label>
          <input id="mt5l" className="form-input" placeholder="e.g. 334414473" inputMode="numeric"
            value={form.mt5_login} onChange={e => setForm({ ...form, mt5_login: e.target.value })} />
        </div>
        <div>
          <label className="form-label" htmlFor="mt5p">MT5 password</label>
          <input id="mt5p" className="form-input" type="password" autoComplete="off"
            value={form.mt5_password} onChange={e => setForm({ ...form, mt5_password: e.target.value })} />
        </div>
        <div>
          <label className="form-label" htmlFor="mt5s">MT5 server</label>
          <input id="mt5s" className="form-input" placeholder="e.g. XMGlobal-MT5 9"
            value={form.mt5_server} onChange={e => setForm({ ...form, mt5_server: e.target.value })} />
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginTop: 12 }}>{error}</div>}

      <button className="btn btn-primary" style={{ width: "100%", marginTop: 14 }} onClick={handleSubmit} disabled={loading}>
        {loading ? "Connecting…" : "Connect MT5 account"}
      </button>
      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
        Your login details are encrypted and used only to place and monitor trades on your account.
      </p>
    </div>
  );
}

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
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--bg-base)", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: "var(--accent)" }}>Æ</div>
      <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading your account…</div>
    </div>
  );

  if (error || !data) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--bg-base)", flexDirection: "column", gap: 10, padding: 24, textAlign: "center" }}>
      <div style={{ fontSize: 18, fontWeight: 700 }}>We can't open this page</div>
      <div style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: 380, lineHeight: 1.5 }}>{error}</div>
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
    ? `${M.plain(account.fixed_fee_amount)} per month, charged whether or not trades win`
    : `${account.performance_fee_pct}% of the profit on each winning trade (you keep ${(100 - num(account.performance_fee_pct)).toFixed(0)}%)`;
  const pendingInvoices = invoices.filter(i => i.status === "pending");
  const paidInvoices = invoices.filter(i => i.status === "paid");

  const dayKey = d => new Date(d).toISOString().slice(0, 10);
  const weekStart = dayKey(Date.now() - 6 * 86400000);
  const weekPnl = history.filter(d => dayKey(d.date) >= weekStart).reduce((s, d) => s + num(d.net_pnl), 0);
  const monthPnl = history.reduce((s, d) => s + num(d.net_pnl), 0);
  const totalReturn = num(account.total_return_pct);

  const attention = [];
  if (!account.is_connected) attention.push({ key: "conn", text: "Your MT5 account isn't connected, so trades can't be copied.", action: "Connect now", tab: "account" });
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
      <style>{`
        .cp-root { min-height: 100vh; background: var(--bg-base); color: var(--text-primary); font-family: var(--font-main); }
        .cp-root * { box-sizing: border-box; }
        .cp-top { background: var(--bg-surface); border-bottom: 1px solid var(--border); }
        .cp-top-in { max-width: 1040px; margin: 0 auto; padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
        .cp-wrap { max-width: 1040px; margin: 0 auto; padding: 20px 20px 40px; }
        .cp-hero { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 28px; align-items: end; padding: 8px 0 20px; }
        .cp-hero h1 { margin: 0; font-size: 13px; font-weight: 500; color: var(--text-secondary); }
        .cp-big { font-family: var(--font-mono); font-size: 40px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.1; margin: 4px 0 6px; font-variant-numeric: tabular-nums; }
        .cp-sub { font-size: 13px; color: var(--text-secondary); }
        .cp-strip { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-lg); margin-bottom: 18px; }
        .cp-strip > div { padding: 12px 16px; border-left: 1px solid var(--border); min-width: 0; }
        .cp-strip > div:first-child { border-left: 0; }
        .cp-strip dt { font-size: 12px; color: var(--text-muted); margin: 0 0 3px; }
        .cp-strip dd { margin: 0; font-family: var(--font-mono); font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
        .cp-attn { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 11px 14px; border-radius: var(--radius); background: var(--warn-dim); border-left: 3px solid var(--warn); margin-bottom: 10px; font-size: 13px; }
        .cp-tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); margin-bottom: 18px; overflow-x: auto; }
        .cp-tab { appearance: none; background: none; border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px; padding: 10px 14px; font: inherit; font-size: 13px; font-weight: 500; color: var(--text-secondary); cursor: pointer; white-space: nowrap; }
        .cp-tab:hover { color: var(--text-primary); }
        .cp-tab[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
        .cp-tab:focus-visible, .cp-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
        .cp-section { background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-lg); margin-bottom: 16px; overflow: hidden; }
        .cp-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
        .cp-section-head h2 { margin: 0; font-size: 15px; font-weight: 600; }
        .cp-aside { font-size: 12px; color: var(--text-muted); }
        .cp-section-body { padding: 16px 18px; }
        .cp-chips { display: flex; gap: 6px; flex-wrap: wrap; }
        .cp-chip { appearance: none; border: 1px solid var(--border); background: var(--bg-surface); color: var(--text-secondary); border-radius: 999px; padding: 4px 12px; font: inherit; font-size: 12px; cursor: pointer; }
        .cp-chip[aria-pressed="true"] { background: var(--accent-dim); border-color: var(--accent); color: var(--accent); font-weight: 600; }
        .cp-table th { font-family: var(--font-main); font-size: 12px; font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--text-muted); text-align: left; white-space: nowrap; }
        .cp-table .r { text-align: right; }
        .cp-table .num { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
        .cp-two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .cp-cols { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 16px; align-items: start; }
        .cp-feed { list-style: none; margin: 0; padding: 0; }
        .cp-feed li { display: flex; gap: 10px; justify-content: space-between; align-items: center; padding: 11px 18px; border-top: 1px solid var(--border); font-size: 13px; }
        .cp-feed li:first-child { border-top: 0; }
        .cp-feed small { display: block; color: var(--text-muted); font-size: 12px; margin-top: 1px; }
        @media (max-width: 860px) {
          .cp-hero { grid-template-columns: 1fr; gap: 14px; }
          .cp-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .cp-strip > div:nth-child(odd) { border-left: 0; }
          .cp-strip > div:nth-child(n+3) { border-top: 1px solid var(--border); }
          .cp-cols, .cp-two { grid-template-columns: 1fr; }
          .cp-big { font-size: 32px; }
        }
        @media (prefers-reduced-motion: reduce) { .cp-root * { transition: none !important; } }
      `}</style>

      {/* Header */}
      <header className="cp-top">
        <div className="cp-top-in">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: "var(--accent)" }}>Æ</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.2 }}>Aethelgard</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Client portal</div>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{account.name}</div>
            <div style={{ fontSize: 12, color: account.is_connected ? "var(--bull)" : "var(--warn)" }}>
              {account.is_connected ? "Account connected" : "Account not connected"}
              {updatedAt && <span style={{ color: "var(--text-muted)" }}> · updated {updatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
            </div>
          </div>
        </div>
      </header>

      <main className="cp-wrap">
        {/* Account value */}
        <div className="cp-hero">
          <div>
            <h1>Account equity</h1>
            <div className="cp-big">{M.plain(account.equity)}</div>
            <div className="cp-sub">
              <span style={{ color: pnlColor(totalReturn), fontWeight: 600 }}>{M.signed(account.total_pnl)} ({sign(totalReturn)}{Math.abs(totalReturn)}%)</span>
              {" "}since you started with {M.plain(account.starting_balance)}
            </div>
          </div>
          <div>
            <PnlLine history={history} color={monthPnl >= 0 ? "var(--bull)" : "var(--bear)"} />
            <div className="cp-sub" style={{ marginTop: 4, fontSize: 12, color: "var(--text-muted)" }}>
              Profit and loss after fees, last 30 days: <strong style={{ color: pnlColor(monthPnl) }}>{M.signed(monthPnl)}</strong>
            </div>
          </div>
        </div>

        <dl className="cp-strip" style={{ margin: "0 0 18px" }}>
          <div><dt>Balance</dt><dd>{M.plain(account.balance)}</dd></div>
          <div><dt>Today</dt><dd style={{ color: pnlColor(today.net_pnl) }}>{M.signed(today.net_pnl)}</dd></div>
          <div><dt>Last 7 days</dt><dd style={{ color: pnlColor(weekPnl) }}>{M.signed(weekPnl)}</dd></div>
          <div><dt>Win rate</dt><dd>{derived.winRate === null ? "—" : `${derived.winRate}%`}</dd></div>
          <div><dt>Open trades</dt><dd>{derived.open.length}</dd></div>
          <div><dt>Fees owed</dt><dd style={{ color: num(account.pending_fee) > 0 ? "var(--warn)" : undefined }}>{M.plain(account.pending_fee)}</dd></div>
        </dl>

        {attention.map(a => (
          <div className="cp-attn" key={a.key}>
            <span>{a.text}</span>
            <button className="btn btn-primary btn-sm" onClick={() => setActiveTab(a.tab)}>{a.action}</button>
          </div>
        ))}

        {/* Tabs */}
        <div className="cp-tabs" role="tablist" aria-label="Portal sections" style={{ marginTop: attention.length ? 8 : 0 }}>
          {TABS.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={activeTab === id} className="cp-tab" onClick={() => setActiveTab(id)}>
              {label}
              {id === "billing" && pendingInvoices.length > 0 && <span className="badge warn" style={{ marginLeft: 6 }}>{pendingInvoices.length}</span>}
              {id === "trades" && derived.open.length > 0 && <span className="badge accent" style={{ marginLeft: 6 }}>{derived.open.length}</span>}
            </button>
          ))}
        </div>

        {/* Overview */}
        {activeTab === "overview" && (
          <>
            <Section title="Open trades" aside={`${derived.open.length} running`} flush>
              {derived.open.length === 0
                ? <Empty title="No trades open right now">New trades from the engine appear here as soon as they are placed on your account.</Empty>
                : <TradeTable rows={derived.open} compact />}
            </Section>

            <div className="cp-cols">
              <Section title="Recent results" aside="Latest closed trades" flush>
                {derived.recentCloses.length === 0
                  ? <Empty title="No closed trades yet">When a trade reaches its take profit or stop loss, it is listed here.</Empty>
                  : (
                    <ul className="cp-feed">
                      {derived.recentCloses.map(t => {
                        const o = outcomeOf(t);
                        return (
                          <li key={t.id}>
                            <div>
                              <span className={`badge ${o.cls}`}>{o.short}</span>{" "}
                              <strong>{t.symbol}</strong> <span style={{ color: "var(--text-muted)" }}>{t.direction === "BUY" ? "buy" : "sell"}</span>
                              <small>{o.label} · {ago(t.close_time)}</small>
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
                              <small>{ago(s.created_at)}{s.grade ? ` · grade ${s.grade}` : ""}</small>
                            </div>
                            <span className={`badge ${st.cls}`} title={st.label}>{st.short}</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
              </Section>
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
              <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "minmax(120px, 200px) 1fr", gap: "10px 16px", fontSize: 13 }}>
                <dt style={{ color: "var(--text-muted)" }}>Name</dt><dd style={{ margin: 0 }}>{account.name}</dd>
                <dt style={{ color: "var(--text-muted)" }}>MT5 connection</dt>
                <dd style={{ margin: 0, color: account.is_connected ? "var(--bull)" : "var(--warn)" }}>{account.is_connected ? "Connected" : "Not connected"}</dd>
                <dt style={{ color: "var(--text-muted)" }}>Trade copying</dt>
                <dd style={{ margin: 0 }}>{account.copy_enabled ? "On" : "Paused"}</dd>
                <dt style={{ color: "var(--text-muted)" }}>Last update from your account</dt>
                <dd style={{ margin: 0 }}>{account.last_sync ? `${ago(account.last_sync)} (${when(account.last_sync)})` : "No update received yet"}</dd>
                <dt style={{ color: "var(--text-muted)" }}>{fixedFee ? "Fixed fee" : "Profit split"}</dt><dd style={{ margin: 0 }}>{feeSummaryText}</dd>
              </dl>
            </Section>

            <Section title={account.is_connected ? "Reconnect your MT5 account" : "Connect your MT5 account"}>
              <MT5ConnectForm token={token} onConnected={loadData} />
            </Section>

            <Section title="How copy trading works">
              <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13, lineHeight: 1.55, color: "var(--text-secondary)" }}>
                <div><strong style={{ color: "var(--text-primary)" }}>Automatic.</strong> When the engine places a trade, your account opens the same trade. You don't need to do anything.</div>
                <div><strong style={{ color: "var(--text-primary)" }}>Sized to your account.</strong> Lot sizes follow your balance, so a smaller account trades smaller lots than a larger one.</div>
                <div><strong style={{ color: "var(--text-primary)" }}>Protected.</strong> Your account has its own daily loss and trade-count limits. A trade can be skipped when a limit has been reached.</div>
                <div><strong style={{ color: "var(--text-primary)" }}>Transparent.</strong> Every trade, with its entry, stop loss, take profit and result, is listed under Trades.</div>
              </div>
            </Section>
          </>
        )}

        <p style={{ marginTop: 24, fontSize: 12, color: "var(--text-muted)", textAlign: "center", lineHeight: 1.6 }}>
          Trading involves risk, and you can lose money. Past performance does not guarantee future results.
        </p>
      </main>
    </div>
  );
}
