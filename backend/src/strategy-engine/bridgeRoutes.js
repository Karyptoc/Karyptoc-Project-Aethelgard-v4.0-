'use strict';
/**
 * Strategy bridge API — mounted in backend/src/index.js at /api/strategy-bridge.
 * Used only by python-bridge/strategy_bridge.py (the separate HFM bridge).
 * Authenticated with the same x-bridge-secret header as the existing bridge.
 */

const express = require('express');
const { supabaseAdmin: db, log } = require('../services/supabase');
const { getCalendarEvents } = require('../services/economicCalendar');
const { loadSettings } = require('./adminRoutes');
const { INSTRUMENTS, BROKER_PROFILES } = require('./config/instruments');
const clock = require('./sessionClock');
const rt = require('./runtime');

const router = express.Router();
router.use(express.json({ limit: '10mb' }));
router.use((req, res, next) => {
  const secret = req.headers['x-bridge-secret'];
  if (!secret || secret !== process.env.BRIDGE_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  return next();
});

const NOISE = ['A', 'B'];
const profileCache = new Map(); // `${strategy}|${id}|${dateKey}` -> profile

function serverModeOf(settings) {
  return (BROKER_PROFILES[settings.global.brokerProfile] || {}).serverTime || 'ny_close';
}

function strategiesFor(id) {
  return NOISE.filter((s) => INSTRUMENTS[id].strategies.includes(s));
}

/** Today's session date for a strategy/instrument, in the session's own time zone. */
function sessionDateKey(strategy, id, settings, nowMs) {
  const session = rt.sessionFor(strategy, id, settings);
  return clock.zonedParts(new Date(nowMs), session.tz).dateKey;
}

async function loadProfiles(settings, ids, nowMs) {
  const out = {};
  const missing = [];
  for (const id of ids) {
    for (const s of strategiesFor(id)) {
      const dk = sessionDateKey(s, id, settings, nowMs);
      const ck = `${s}|${id}|${dk}`;
      if (profileCache.has(ck)) out[`${s}|${id}`] = profileCache.get(ck);
      else missing.push({ s, id, dk, ck });
    }
  }
  if (missing.length) {
    const { data } = await db.from('daily_profiles').select('*')
      .in('instrument', [...new Set(missing.map((m) => m.id))])
      .in('session_date', [...new Set(missing.map((m) => m.dk))]);
    for (const m of missing) {
      const row = (data || []).find((r) => r.instrument === m.id && r.strategy_id === m.s && r.session_date === m.dk);
      if (row) {
        const prof = { sigma: row.sigma, lookback: row.lookback, prevClose: Number(row.prev_close), dailyVol: Number(row.daily_vol) };
        profileCache.set(m.ck, prof);
        out[`${m.s}|${m.id}`] = prof;
      }
    }
  }
  return out;
}

/** Track start-of-day / start-of-week / peak equity for loss limits (UTC days, ISO weeks). */
async function accountState(acc) {
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
  const weekKey = monday.toISOString().slice(0, 10);
  const login = String(acc.login);
  const { data: row } = await db.from('strategy_account_state').select('*').eq('login', login).maybeSingle();
  const st = row || { login, day_key: dayKey, start_of_day_equity: acc.equity, week_key: weekKey, start_of_week_equity: acc.equity, peak_equity: acc.equity };
  if (st.day_key !== dayKey) { st.day_key = dayKey; st.start_of_day_equity = acc.equity; }
  if (st.week_key !== weekKey) { st.week_key = weekKey; st.start_of_week_equity = acc.equity; }
  st.peak_equity = Math.max(Number(st.peak_equity), acc.equity);
  await db.from('strategy_account_state').upsert({ ...st, updated_at: now.toISOString() });
  return {
    login, tradeModeDemo: acc.trade_mode === 0, equity: acc.equity, marginUsed: acc.margin || 0,
    startOfDayEquity: Number(st.start_of_day_equity), startOfWeekEquity: Number(st.start_of_week_equity), peakEquity: Number(st.peak_equity),
  };
}

/** Rebuild the trade journal from MT5 deals (the broker's own record). */
async function upsertTrades(login, deals, serverMode) {
  const ours = (deals || []).filter((d) => rt.STRATEGY_OF_MAGIC[d.magic]);
  if (!ours.length) return;
  const byPos = new Map();
  for (const d of ours) {
    if (!byPos.has(d.position_id)) byPos.set(d.position_id, []);
    byPos.get(d.position_id).push(d);
  }
  const keys = [...new Set(ours.filter((d) => d.entry === 0).map((d) => d.comment).filter(Boolean))];
  const { data: evs } = keys.length ? await db.from('evaluations').select('order_key, price, strategy_version').in('order_key', keys) : { data: [] };
  const rows = [];
  for (const [pos, list] of byPos) {
    const inD = list.find((d) => d.entry === 0);
    const outs = list.filter((d) => d.entry === 1 || d.entry === 3);
    if (!inD) continue;
    const side = inD.type === 0 ? 1 : -1;
    const ev = (evs || []).find((e) => e.order_key === inD.comment);
    const closedVol = outs.reduce((a, d) => a + d.volume, 0);
    const closed = closedVol >= inD.volume - 1e-9;
    const lastOut = outs.sort((a, b) => a.time - b.time)[outs.length - 1];
    rows.push({
      account_login: login, position_id: pos, strategy_id: rt.STRATEGY_OF_MAGIC[inD.magic], strategy_version: ev ? ev.strategy_version : null,
      broker_symbol: inD.symbol, side: side === 1 ? 'buy' : 'sell', lots: inD.volume, order_key: inD.comment || null,
      requested_price: ev ? Number(ev.price) : null, open_price: inD.price,
      open_time: new Date(rt.serverEpochToUtcMs(inD.time, serverMode)).toISOString(),
      slippage_price: ev ? side * (inD.price - Number(ev.price)) : null,
      status: closed ? 'closed' : 'open',
      close_price: lastOut ? lastOut.price : null,
      close_time: lastOut ? new Date(rt.serverEpochToUtcMs(lastOut.time, serverMode)).toISOString() : null,
      close_reason: lastOut ? ({ 4: 'stop_loss', 5: 'take_profit', 6: 'stop_out' }[lastOut.reason] || 'strategy_exit') : null,
      profit: list.reduce((a, d) => a + (d.profit || 0), 0),
      swap: list.reduce((a, d) => a + (d.swap || 0), 0),
      commission: list.reduce((a, d) => a + (d.commission || 0) + (d.fee || 0), 0),
      updated_at: new Date().toISOString(),
    });
  }
  if (rows.length) {
    const { error } = await db.from('strategy_trades').upsert(rows, { onConflict: 'account_login,position_id' });
    if (error) await log('error', 'strategy-bridge', `strategy_trades upsert failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------- config
router.get('/config', async (req, res) => {
  try {
    const settings = await loadSettings();
    const { data: map } = await db.from('symbol_map').select('instrument, broker_symbol').eq('broker_profile', settings.global.brokerProfile);
    const instruments = Object.keys(INSTRUMENTS).filter((id) => strategiesFor(id).length).map((id) => {
      const sym = settings.symbols[id] || {};
      const active = sym.enabled && strategiesFor(id).some((s) => settings.strategies[s].mode !== 'off' && sym.strategies.includes(s));
      return { id, needBars: !!active, override: sym.brokerSymbol || (map || []).find((m) => m.instrument === id)?.broker_symbol || null };
    });
    res.json({
      brokerProfile: settings.global.brokerProfile, serverTime: serverModeOf(settings), accountType: settings.global.accountType,
      instruments, magics: Object.values(rt.MAGIC), barsPerTick: 600, historyBars: 30000,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------- tick
router.post('/tick', async (req, res) => {
  try {
    const nowMs = Date.now();
    const { account: acc, positions = [], deals = [], instruments = {} } = req.body || {};
    if (!acc || typeof acc.equity !== 'number') return res.status(400).json({ error: 'account missing' });
    const settings = await loadSettings();
    const serverMode = serverModeOf(settings);
    const account = await accountState(acc);

    // normalise instrument payloads: spec values come from MT5's own profit calculator (see strategy_bridge.py)
    const inst = {};
    for (const [id, v] of Object.entries(instruments)) {
      if (!INSTRUMENTS[id]) continue;
      inst[id] = { brokerSymbol: v.brokerSymbol, bars: v.bars || [], spreadPoints: v.spreadPoints,
        spec: { ...v.spec, tick_size: 1, tick_value: v.spec.value_per_point_per_lot } };
    }
    const profiles = await loadProfiles(settings, Object.keys(inst), nowMs);
    const since = new Date(nowMs - 20 * 3600 * 1000).toISOString();
    const { data: evRows } = await db.from('evaluations').select('order_key').in('strategy_id', NOISE).gte('eval_time', since);
    const evaluatedKeys = new Set((evRows || []).map((r) => r.order_key).filter(Boolean));
    const events = await getCalendarEvents();
    const { data: commands } = await db.from('strategy_admin_commands').select('*').eq('status', 'pending');

    const out = rt.step({ nowMs, settings, brokerServerMode: serverMode, account, positions, instruments: inst, profiles, evaluatedKeys, events, commands: commands || [] });

    // persist evaluations first; a unique-key conflict means another tick already handled it -> drop its orders
    const evalIds = {};
    const dropped = new Set();
    for (const e of out.evaluations) {
      const { data, error } = await db.from('evaluations').insert({
        strategy_id: e.strategy, strategy_version: e.paramsVersion, instrument: e.instrument, eval_time: new Date(e.evalTimeMs).toISOString(),
        checkpoint_minute: e.checkpoint, price: e.price, ub: e.ub, lb: e.lb, vwap: e.vwap, position_before: e.positionBefore,
        target: e.target, action: e.action, reason: e.reason, order_key: e.key, mode: e.mode,
      }).select('id').single();
      if (error) { dropped.add(e.key); continue; }
      evalIds[e.key] = data.id;
    }
    const orders = out.orders.filter((o) => !(o.evaluationKey && dropped.has(o.evaluationKey)) && !(o.action === 'open' && dropped.has(o.key)));
    if (out.riskDecisions.length) {
      await db.from('risk_decisions').insert(out.riskDecisions.filter((r) => !dropped.has(r.evaluationKey)).map((r) => ({
        strategy_id: r.strategy, symbol: r.symbol, desired_lots: r.desiredLots ?? null, final_lots: r.finalLots ?? null,
        approved: r.approved, shadow: settings.strategies[r.strategy].mode === 'shadow', skip_reason: r.skipReason, steps: r.steps,
        evaluation_id: evalIds[r.evaluationKey] || null,
      })));
    }
    for (const id of out.commandsDone) {
      await db.from('strategy_admin_commands').update({ status: 'done', done_at: new Date().toISOString() }).eq('id', id);
    }
    for (const l of out.logs) await log(l.level, 'strategy-engine', l.msg);
    for (const o of orders) await log('info', 'strategy-engine', `ORDER ${o.action} ${o.side} ${o.lots} ${o.symbol} (${o.strategy}) — ${o.reason}`, { order: o });

    await upsertTrades(account.login, deals, serverMode);
    if (new Date(nowMs).getUTCMinutes() % 15 === 0) {
      await db.from('reconciliations').insert({
        broker_positions: positions.filter((p) => rt.STRATEGY_OF_MAGIC[p.magic]), virtual_positions: [],
        mismatch: out.logs.some((l) => /expected at most 1/.test(l.msg)), details: `login ${account.login}, equity ${account.equity}`,
      });
    }
    const need = [...new Set(out.needHistory.map((n) => n.instrument))];
    res.json({ orders, needHistory: need, serverTimeMs: nowMs });
  } catch (e) {
    await log('error', 'strategy-bridge', `tick failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------- history -> today's profiles
router.post('/history', async (req, res) => {
  try {
    const nowMs = Date.now();
    const { instrument: id, bars = [] } = req.body || {};
    if (!INSTRUMENTS[id]) return res.status(400).json({ error: 'unknown instrument' });
    const settings = await loadSettings();
    const serverMode = serverModeOf(settings);
    const built = [];
    for (const s of strategiesFor(id)) {
      const session = rt.sessionFor(s, id, settings);
      const todayKey = clock.zonedParts(new Date(nowMs), session.tz).dateKey;
      const lookback = settings.strategies[s].params.lookback || 14;
      const prof = rt.buildProfileFromHistory(rt.localiseBars(bars, serverMode, session.tz), session, todayKey, lookback);
      if (!prof) { built.push({ strategy: s, ok: false }); continue; }
      const row = { instrument: id, session_date: todayKey, strategy_id: s, open_price: null, prev_close: prof.prevClose,
        sigma: prof.sigma, lookback, daily_vol: prof.dailyVol, data_hash: `${bars.length}:${prof.sessionsUsed.join(',')}` };
      const { error } = await db.from('daily_profiles').upsert(row, { onConflict: 'instrument,session_date,strategy_id' });
      if (error) throw error;
      profileCache.set(`${s}|${id}|${todayKey}`, { sigma: prof.sigma, lookback, prevClose: prof.prevClose, dailyVol: prof.dailyVol });
      built.push({ strategy: s, ok: true, sessions: prof.sessionsUsed.length });
    }
    await log('info', 'strategy-engine', `Profiles for ${id}: ${JSON.stringify(built)}`);
    res.json({ built });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------- order results from the bridge
router.post('/order-result', async (req, res) => {
  try {
    const r = req.body || {};
    await log(r.ok ? 'info' : 'error', 'strategy-bridge',
      `${r.ok ? 'FILLED' : 'FAILED'} ${r.action} ${r.symbol} ${r.lots ?? ''} key=${r.key} retcode=${r.retcode} ${r.message || ''}`, r);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
