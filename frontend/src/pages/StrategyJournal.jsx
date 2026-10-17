import React, { useCallback, useEffect, useState } from "react";
import api from "../lib/api";

/**
 * Strategy Journal — every trade the strategy engine (A/B/C) has made.
 * Rows come from MT5's own deal history (rebuilt by the strategy bridge), so they
 * match the broker exactly. P&L is net of swap and commission, in the account currency.
 */

const STRATEGIES = [["", "All strategies"], ["A", "A — Index momentum"], ["B", "B — Gold momentum"], ["C", "C — Daily trend"]];
const PERIODS = [["7", "7 days"], ["30", "30 days"], ["90", "90 days"], ["", "All time"]];
const CLOSE_REASON = {
  strategy_exit: { label: "STRATEGY", cls: "accent" },
  stop_loss: { label: "STOP", cls: "bear" },
  take_profit: { label: "TP", cls: "bull" },
  stop_out: { label: "STOP-OUT", cls: "bear" },
};
const PAGE = 100;
const MIN_SAMPLE = 30;

const net = (t) => Number(t.profit || 0) + Number(t.swap || 0) + Number(t.commission || 0);
const fmt = (x, d = 2) => (x == null ? "—" : Number(x).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
const when = (s) => (s ? new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const holdText = (t) => {
  if (!t.open_time || !t.close_time) return "—";
  const m = Math.round((new Date(t.close_time) - new Date(t.open_time)) / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

function StatCard({ label, value, sub, color = "accent" }) {
  return (
    <div className={`stat-card ${color}`}>
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${color}`}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function EquityCurve({ curve, currency }) {
  if (!curve || curve.length < 2) {
    return <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13 }}>The curve appears after two or more closed trades.</div>;
  }
  const W = 800, H = 180, P = 8;
  const vals = [0, ...curve.map((c) => c.v)];
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i) => P + (i / (vals.length - 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - lo) / span) * (H - 2 * P);
  const path = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = vals[vals.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H }} role="img"
      aria-label={`Cumulative net P&L, now ${fmt(last)} ${currency || ""}`}>
      <line x1={P} x2={W - P} y1={y(0)} y2={y(0)} stroke="var(--border)" strokeDasharray="4 4" />
      <path d={path} fill="none" stroke={last >= 0 ? "var(--bull)" : "var(--bear)"} strokeWidth="2" />
    </svg>
  );
}

function NoteEditor({ trade, onSaved }) {
  const [note, setNote] = useState(trade.note || "");
  const [tags, setTags] = useState((trade.tags || []).join(", "));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const save = async () => {
    setSaving(true); setErr(null);
    try {
      await api.post("/api/strategy-admin/journal/note", { account_login: trade.account_login, position_id: trade.position_id, note, tags });
      onSaved({ note, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) });
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    } finally { setSaving(false); }
  };
  return (
    <div style={{ display: "grid", gap: 8, padding: "8px 0" }}>
      {trade.entry_levels && (
        <div style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          Entry check at {trade.entry_levels.checkpoint != null ? `${String(Math.floor(trade.entry_levels.checkpoint / 60)).padStart(2, "0")}:${String(trade.entry_levels.checkpoint % 60).padStart(2, "0")} exchange time` : "—"}
          {" · "}price {fmt(trade.entry_levels.price)} · upper {fmt(trade.entry_levels.ub)} · lower {fmt(trade.entry_levels.lb)} · VWAP {fmt(trade.entry_levels.vwap)}
        </div>
      )}
      <textarea className="form-input" rows={3} placeholder="What happened on this trade? (news, slippage, anything unusual)"
        value={note} onChange={(e) => setNote(e.target.value)} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input className="form-input" style={{ maxWidth: 320 }} placeholder="Tags, comma separated (e.g. news, gap)"
          value={tags} onChange={(e) => setTags(e.target.value)} />
        <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>{saving ? "Saving..." : "Save note"}</button>
        {err && <span style={{ color: "var(--bear)", fontSize: 12 }}>⚠ {err}</span>}
      </div>
    </div>
  );
}

export default function StrategyJournal() {
  const [strategy, setStrategy] = useState("");
  const [status, setStatus] = useState("all");
  const [symbol, setSymbol] = useState("");
  const [period, setPeriod] = useState("30");
  const [data, setData] = useState(null);
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  const [exporting, setExporting] = useState(false);

  const query = useCallback((offset) => {
    const p = new URLSearchParams({ offset: String(offset), pageSize: String(PAGE) });
    if (strategy) p.set("strategy", strategy);
    if (status !== "all") p.set("status", status);
    if (symbol) p.set("symbol", symbol);
    if (period) p.set("from", new Date(Date.now() - Number(period) * 86400000).toISOString());
    return p.toString();
  }, [strategy, status, symbol, period]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await api.get(`/api/strategy-admin/journal?${query(0)}`);
      setData(r.data); setTrades(r.data.trades || []);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally { setLoading(false); }
  }, [query]);

  useEffect(() => { load(); }, [load]);

  const loadMore = async () => {
    const r = await api.get(`/api/strategy-admin/journal?${query(trades.length)}`);
    setTrades((prev) => [...prev, ...(r.data.trades || [])]);
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const r = await api.get(`/api/strategy-admin/journal.csv?${query(0)}`, { responseType: "blob" });
      const url = window.URL.createObjectURL(new Blob([r.data]));
      const a = document.createElement("a");
      a.href = url; a.download = `strategy_journal_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); window.URL.revokeObjectURL(url);
    } catch (e) {
      setError(`Export failed: ${e.message}`);
    } finally { setExporting(false); }
  };

  const s = data?.summary;
  const cur = data?.currency || "";
  const money = (v) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${fmt(v)} ${cur}`.trim());

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Strategy Journal</div>
          <div className="page-subtitle">STRATEGY ENGINE TRADES (A/B/C) · FROM MT5 DEAL HISTORY · NET OF COSTS</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={exportCsv} disabled={exporting}>{exporting ? "⬇ Exporting..." : "⬇ Export CSV"}</button>
          <button className="btn btn-ghost btn-sm" onClick={load}>↻ Refresh</button>
        </div>
      </div>

      <div className="page-body">
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          <select className="form-select" style={{ width: 200 }} value={strategy} onChange={(e) => setStrategy(e.target.value)}>
            {STRATEGIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select className="form-select" style={{ width: 150 }} value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            <option value="">All instruments</option>
            {(data?.symbols || []).map((x) => <option key={x}>{x}</option>)}
          </select>
          <div style={{ display: "flex", gap: 6 }}>
            {[["all", "All"], ["open", "Open"], ["closed", "Closed"]].map(([v, l]) => (
              <button key={v} className={`btn btn-sm ${status === v ? "btn-primary" : "btn-ghost"}`} onClick={() => setStatus(v)}>{l}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {PERIODS.map(([v, l]) => (
              <button key={v} className={`btn btn-sm ${period === v ? "btn-primary" : "btn-ghost"}`} onClick={() => setPeriod(v)}>{l}</button>
            ))}
          </div>
        </div>

        {error && <div className="card" style={{ borderColor: "var(--bear)", color: "var(--bear)", padding: "10px 16px" }}>⚠ {error}</div>}

        {s && (
          <>
            {s.closedTrades < MIN_SAMPLE && (
              <div className="card" style={{ borderColor: "var(--warn)", padding: "10px 16px", fontSize: 13, color: "var(--text-secondary)" }}>
                Only {s.closedTrades} closed trade{s.closedTrades === 1 ? "" : "s"} in this view. Fewer than {MIN_SAMPLE} trades says very little about
                whether the strategy works; judge it against the backtest only after a larger sample.
              </div>
            )}
            <div className="stats-grid" style={{ marginBottom: 16 }}>
              <StatCard label="Net P&L" value={money(s.netPnl)} color={(s.netPnl || 0) >= 0 ? "bull" : "bear"} sub="after swap and commission" />
              <StatCard label="Closed / open" value={`${s.closedTrades} / ${s.openTrades}`} />
              <StatCard label="Win rate" value={s.winRate == null ? "—" : `${s.winRate}%`} sub="the backtest wins about 40%" />
              <StatCard label="Profit factor" value={s.profitFactor ?? "—"} color={(s.profitFactor || 0) >= 1 ? "bull" : "warn"} sub="gross win / gross loss" />
              <StatCard label="Avg per trade" value={money(s.expectancy)} color={(s.expectancy || 0) >= 0 ? "bull" : "bear"} />
              <StatCard label="Avg win / loss" value={`${fmt(s.avgWin)} / ${fmt(s.avgLoss)}`} />
              <StatCard label="Max drawdown" value={money(s.maxDrawdown)} color="bear" sub="from peak of closed P&L" />
              <StatCard label="Avg slippage" value={s.avgSlippage == null ? "—" : `${fmt(s.avgSlippage, 3)} pts`} sub="positive = worse than signal price" color={(s.avgSlippage || 0) > 0 ? "warn" : "accent"} />
              <StatCard label="Costs paid" value={money(s.costs)} sub="swap + commission" />
              <StatCard label="Avg hold" value={s.avgHoldMinutes == null ? "—" : `${s.avgHoldMinutes} min`} />
            </div>

            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-header"><span className="card-title">Cumulative net P&L ({cur || "account currency"})</span></div>
              <EquityCurve curve={s.curve} currency={cur} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 16, marginBottom: 16 }}>
              {[["By strategy", data.byStrategy], ["By instrument", data.bySymbol]].map(([title, rows]) => (
                <div className="card" key={title}>
                  <div className="card-header"><span className="card-title">{title}</span></div>
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th></th><th>Trades</th><th>Win %</th><th>PF</th><th>Net</th></tr></thead>
                      <tbody>
                        {(rows || []).map((r) => (
                          <tr key={r.key}>
                            <td style={{ fontWeight: 700 }}>{r.key}</td>
                            <td className="mono">{r.closedTrades}{r.openTrades ? ` +${r.openTrades} open` : ""}</td>
                            <td className="mono">{r.winRate ?? "—"}</td>
                            <td className="mono">{r.profitFactor ?? "—"}</td>
                            <td className={(r.netPnl || 0) >= 0 ? "pnl-pos" : "pnl-neg"}>{fmt(r.netPnl)}</td>
                          </tr>
                        ))}
                        {(!rows || rows.length === 0) && <tr><td colSpan={5} style={{ color: "var(--text-muted)" }}>No trades</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="card">
          <div className="card-header">
            <span className="card-title">Trades</span>
            <span className="badge accent">{trades.length}{data && data.total > trades.length ? ` of ${data.total}` : ""} records</span>
          </div>
          {loading ? (
            <div style={{ padding: 24, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>Loading...</div>
          ) : trades.length === 0 ? (
            <div className="empty-state"><div className="empty-icon">◆</div><div className="empty-text">No strategy-engine trades in this view</div></div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Opened</th><th>Strat</th><th>Symbol</th><th>Dir</th><th>Lots</th><th>Entry</th><th>Slip</th>
                    <th>Exit</th><th>Closed by</th><th>Held</th><th>Net</th><th>Why it entered</th><th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => {
                    const key = `${t.account_login}|${t.position_id}`;
                    const r = CLOSE_REASON[t.close_reason];
                    const n = net(t);
                    return (
                      <React.Fragment key={key}>
                        <tr style={{ cursor: "pointer" }} onClick={() => setOpen(open === key ? null : key)}>
                          <td className="mono" style={{ fontSize: 11 }}>{when(t.open_time)}</td>
                          <td><span className="badge accent">{t.strategy_id}</span></td>
                          <td style={{ fontWeight: 700 }}>{t.broker_symbol}</td>
                          <td><span className={`badge ${t.side === "buy" ? "bull" : "bear"}`}>{t.side.toUpperCase()}</span></td>
                          <td className="mono">{t.lots}</td>
                          <td className="mono">{t.open_price ?? "—"}</td>
                          <td className="mono" style={{ color: (t.slippage_price || 0) > 0 ? "var(--warn)" : "var(--text-muted)" }}>{t.slippage_price == null ? "—" : fmt(t.slippage_price, 2)}</td>
                          <td className="mono">{t.status === "open" ? <span className="badge accent">OPEN</span> : (t.close_price ?? "—")}</td>
                          <td>{r ? <span className={`badge ${r.cls}`}>{r.label}</span> : <span style={{ color: "var(--text-muted)" }}>—</span>}</td>
                          <td className="mono" style={{ fontSize: 11 }}>{holdText(t)}</td>
                          <td className={n >= 0 ? "pnl-pos" : "pnl-neg"}>{n >= 0 ? "+" : ""}{fmt(n)}</td>
                          <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>{t.entry_reason || "—"}</td>
                          <td style={{ fontSize: 12 }}>
                            {t.note ? "📝 " : ""}{(t.tags || []).map((g) => <span key={g} className="badge muted" style={{ marginRight: 4 }}>{g}</span>)}
                            {!t.note && !(t.tags || []).length && <span style={{ color: "var(--text-muted)" }}>add</span>}
                          </td>
                        </tr>
                        {open === key && (
                          <tr>
                            <td colSpan={13}>
                              <NoteEditor trade={t} onSaved={(upd) => setTrades((prev) => prev.map((x) => (`${x.account_login}|${x.position_id}` === key ? { ...x, ...upd } : x)))} />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {!loading && data && trades.length < data.total && (
            <div style={{ display: "flex", justifyContent: "center", padding: 16 }}>
              <button className="btn btn-ghost btn-sm" onClick={loadMore}>Load more ({data.total - trades.length} remaining)</button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
