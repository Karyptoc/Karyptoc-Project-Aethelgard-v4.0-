'use strict';
/**
 * Pure helpers for the strategy-engine Journal and Signals pages.
 * No database access here, so they can be unit-tested.
 */

const net = (t) => Number(t.profit || 0) + Number(t.swap || 0) + Number(t.commission || 0);
const round = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Performance summary over closed trades (net of swap and commission, account currency). */
function summarize(trades) {
  const closed = trades.filter((t) => t.status === 'closed').sort((a, b) => new Date(a.close_time) - new Date(b.close_time));
  const nets = closed.map(net);
  const wins = nets.filter((x) => x > 0);
  const losses = nets.filter((x) => x <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  let cum = 0; let peak = 0; let maxDd = 0;
  const curve = closed.map((t, i) => {
    cum += nets[i]; peak = Math.max(peak, cum); maxDd = Math.min(maxDd, cum - peak);
    return { t: t.close_time, v: round(cum) };
  });
  const slips = trades.map((t) => t.slippage_price).filter((x) => x != null).map(Number);
  const holdMins = closed.filter((t) => t.open_time && t.close_time).map((t) => (new Date(t.close_time) - new Date(t.open_time)) / 60000);
  return {
    closedTrades: closed.length,
    openTrades: trades.filter((t) => t.status === 'open').length,
    netPnl: round(nets.reduce((a, b) => a + b, 0)),
    winRate: closed.length ? round((wins.length / closed.length) * 100, 1) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
    avgWin: wins.length ? round(grossWin / wins.length) : null,
    avgLoss: losses.length ? round(-grossLoss / losses.length) : null,
    expectancy: closed.length ? round(nets.reduce((a, b) => a + b, 0) / closed.length) : null,
    best: nets.length ? round(Math.max(...nets)) : null,
    worst: nets.length ? round(Math.min(...nets)) : null,
    maxDrawdown: round(maxDd),
    avgSlippage: slips.length ? round(slips.reduce((a, b) => a + b, 0) / slips.length, 4) : null,
    avgHoldMinutes: holdMins.length ? Math.round(holdMins.reduce((a, b) => a + b, 0) / holdMins.length) : null,
    costs: round(closed.reduce((a, t) => a + Number(t.swap || 0) + Number(t.commission || 0), 0)),
    curve,
  };
}

/** Same summary split by a key (strategy_id or broker_symbol). */
function breakdown(trades, key) {
  const groups = {};
  for (const t of trades) (groups[t[key]] = groups[t[key]] || []).push(t);
  return Object.entries(groups).map(([k, list]) => {
    const { curve, ...s } = summarize(list); // eslint-disable-line no-unused-vars
    return { key: k, ...s };
  }).sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

const CSV_COLS = ['strategy_id', 'broker_symbol', 'side', 'lots', 'open_time', 'open_price', 'requested_price', 'slippage_price',
  'close_time', 'close_price', 'close_reason', 'profit', 'swap', 'commission', 'net', 'status', 'entry_reason', 'note', 'tags', 'position_id', 'account_login', 'order_key'];

function toCsv(rows) {
  const esc = (v) => {
    if (v == null) return '';
    const s = Array.isArray(v) ? v.join('|') : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLS.join(','), ...rows.map((r) => CSV_COLS.map((c) => esc(c === 'net' ? round(net(r)) : r[c])).join(','))].join('\n');
}

/** Latest evaluation per strategy+instrument (the current state of each market the engine watches). */
function latestByMarket(evaluations) {
  const seen = new Map();
  for (const e of evaluations) {
    const k = `${e.strategy_id}|${e.instrument}`;
    if (!seen.has(k) || new Date(e.eval_time) > new Date(seen.get(k).eval_time)) seen.set(k, e);
  }
  return [...seen.values()].sort((a, b) => a.instrument.localeCompare(b.instrument));
}

module.exports = { net, summarize, breakdown, toCsv, latestByMarket, CSV_COLS };
