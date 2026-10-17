'use strict';
/**
 * Strategy admin API — mounted in backend/src/index.js at /api/strategy-admin.
 * Uses Aethelgard's existing auth (verifyToken) and only lets users whose
 * profiles.role = 'admin' through, so copy-trading clients can never reach it.
 */

const express = require('express');
const { supabaseAdmin: supabase, log } = require('../services/supabase');
const { verifyToken } = require('../middleware/auth');
const { applyAdminChange, defaultSettings, CEILINGS } = require('./adminSettings');
const journal = require('./journalStats');

async function loadSettings() {
  const { data, error } = await supabase.from('strategy_admin_settings').select('settings, version').eq('id', 1).maybeSingle();
  if (error) throw error;
  if (!data) {
    const settings = defaultSettings();
    const ins = await supabase.from('strategy_admin_settings').insert({ id: 1, settings, version: settings.version });
    if (ins.error) throw ins.error;
    return settings;
  }
  return data.settings;
}

async function saveSettings(prevVersion, next, audit) {
  // optimistic lock: only update if nobody else saved in between
  const { data, error } = await supabase.from('strategy_admin_settings')
    .update({ settings: next, version: next.version, updated_at: new Date().toISOString() })
    .eq('id', 1).eq('version', prevVersion).select('version');
  if (error) throw error;
  if (!data || data.length === 0) return false;
  if (audit.length) {
    const rows = audit.map((a) => ({ path: a.path, old_value: a.from, new_value: a.to, actor: a.actor, reason: a.reason, settings_version: next.version }));
    const r = await supabase.from('strategy_admin_audit').insert(rows);
    if (r.error) throw r.error;
  }
  return true;
}

async function requireAdmin(req, res, next) {
  try {
    const { data } = await supabase.from('profiles').select('role').eq('id', req.user.id).maybeSingle();
    if (data?.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    return next();
  } catch (e) { return res.status(500).json({ error: e.message }); }
}

const router = express.Router();
router.use(verifyToken, requireAdmin);

const actorOf = (req) => req.user.email || req.user.id;

async function change(req, res, changes, reason) {
  const current = await loadSettings();
  const result = applyAdminChange(current, changes, { actor: actorOf(req), reason });
  if (!result.ok) return res.status(400).json({ errors: result.errors });
  const saved = await saveSettings(current.version, result.next, result.audit);
  if (!saved) return res.status(409).json({ error: 'Settings were changed by someone else; reload and retry.' });
  await log('info', 'strategy-admin', `Settings v${result.next.version} by ${actorOf(req)}: ${changes.map((c) => c.path).join(', ')}`);
  return res.json({ settings: result.next, notices: result.notices });
}

router.get('/settings', async (req, res) => {
  try { res.json({ settings: await loadSettings(), ceilings: CEILINGS }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/settings', async (req, res) => {
  try {
    const { changes, reason = '' } = req.body || {};
    if (!Array.isArray(changes) || changes.length === 0) return res.status(400).json({ error: 'changes must be a non-empty array' });
    await change(req, res, changes, reason);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One-click kill switch. Turning ON never needs a reason; turning OFF does.
router.post('/kill', async (req, res) => {
  try {
    const { on, mode = 'freeze', reason = '' } = req.body || {};
    const changes = [{ path: 'global.killSwitch', value: !!on }];
    if (on) changes.push({ path: 'global.killMode', value: mode });
    if (on && mode === 'flatten') {
      await supabase.from('strategy_admin_commands').insert({ command: 'flatten_all', requested_by: actorOf(req), reason });
    }
    await change(req, res, changes, reason || (on ? 'kill switch' : ''));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Close one strategy's positions without changing settings.
router.post('/flatten', async (req, res) => {
  try {
    const { strategy = null, symbol = null, reason = '' } = req.body || {};
    const { error } = await supabase.from('strategy_admin_commands').insert({ command: 'flatten', strategy, symbol, requested_by: actorOf(req), reason });
    if (error) throw error;
    res.json({ queued: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/audit', async (req, res) => {
  try {
    const { data, error } = await supabase.from('strategy_admin_audit').select('*').order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    res.json({ audit: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/status', async (req, res) => {
  try {
    const [skips, recon, evals, trades, acct] = await Promise.all([
      supabase.from('risk_decisions').select('strategy_id, symbol, skip_reason, created_at').eq('approved', false).order('created_at', { ascending: false }).limit(50),
      supabase.from('reconciliations').select('*').order('created_at', { ascending: false }).limit(1),
      supabase.from('evaluations').select('strategy_id, instrument, eval_time, price, ub, lb, vwap, position_before, target, action, reason, mode').order('eval_time', { ascending: false }).limit(30),
      supabase.from('strategy_trades').select('*').order('open_time', { ascending: false }).limit(30),
      supabase.from('strategy_account_state').select('*').order('updated_at', { ascending: false }).limit(1),
    ]);
    res.json({
      recentSkips: skips.data || [], lastReconciliation: (recon.data || [])[0] || null,
      recentEvaluations: evals.data || [], recentTrades: trades.data || [], bridge: (acct.data || [])[0] || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ------------------------------------------------------------------ journal
// Strategy-engine trades, rebuilt by the bridge from MT5's own deal history (strategy_trades),
// joined with the evaluation that opened each one and any operator note.
async function loadJournal(q) {
  let query = supabase.from('strategy_trades').select('*').order('open_time', { ascending: false }).limit(Math.min(Number(q.limit) || 2000, 5000));
  if (q.strategy) query = query.eq('strategy_id', q.strategy);
  if (q.status && q.status !== 'all') query = query.eq('status', q.status);
  if (q.symbol) query = query.eq('broker_symbol', q.symbol);
  if (q.account) query = query.eq('account_login', q.account);
  if (q.from) query = query.gte('open_time', q.from);
  if (q.to) query = query.lte('open_time', q.to);
  const { data: trades, error } = await query;
  if (error) throw error;
  const keys = [...new Set((trades || []).map((t) => t.order_key).filter(Boolean))];
  const evs = [];
  for (let i = 0; i < keys.length; i += 200) {
    const { data } = await supabase.from('evaluations').select('order_key, reason, action, price, ub, lb, vwap, checkpoint_minute').in('order_key', keys.slice(i, i + 200));
    evs.push(...(data || []));
  }
  // notes table arrives with supabase_migration_strategy_journal.sql; the journal still works before it is run
  const { data: notes } = await supabase.from('strategy_trade_notes').select('*');
  const evByKey = new Map(evs.map((e) => [e.order_key, e]));
  const noteByPos = new Map((notes || []).map((n) => [`${n.account_login}|${n.position_id}`, n]));
  return (trades || []).map((t) => {
    const ev = evByKey.get(t.order_key);
    const n = noteByPos.get(`${t.account_login}|${t.position_id}`);
    return { ...t, entry_reason: ev ? ev.reason : null, entry_action: ev ? ev.action : null,
      entry_levels: ev ? { price: ev.price, ub: ev.ub, lb: ev.lb, vwap: ev.vwap, checkpoint: ev.checkpoint_minute } : null,
      note: n ? n.note : '', tags: n ? n.tags || [] : [] };
  });
}

router.get('/journal', async (req, res) => {
  try {
    const rows = await loadJournal(req.query);
    const { data: acct } = await supabase.from('strategy_account_state').select('*').order('updated_at', { ascending: false }).limit(1);
    const offset = Number(req.query.offset) || 0;
    const pageSize = Math.min(Number(req.query.pageSize) || 100, 500);
    res.json({
      summary: journal.summarize(rows),
      byStrategy: journal.breakdown(rows, 'strategy_id'),
      bySymbol: journal.breakdown(rows, 'broker_symbol'),
      trades: rows.slice(offset, offset + pageSize),
      total: rows.length,
      currency: acct && acct[0] ? acct[0].currency || null : null,
      symbols: [...new Set(rows.map((r) => r.broker_symbol))].sort(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/journal.csv', async (req, res) => {
  try {
    const rows = await loadJournal({ ...req.query, limit: 5000 });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="strategy_journal_${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(journal.toCsv(rows));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/journal/note', async (req, res) => {
  try {
    const { account_login, position_id, note = '', tags = [] } = req.body || {};
    if (!account_login || !position_id) return res.status(400).json({ error: 'account_login and position_id required' });
    const cleanTags = (Array.isArray(tags) ? tags : String(tags).split(',')).map((t) => String(t).trim()).filter(Boolean).slice(0, 10);
    const { error } = await supabase.from('strategy_trade_notes').upsert({
      account_login: String(account_login), position_id: Number(position_id), note: String(note).slice(0, 4000), tags: cleanTags,
      updated_by: actorOf(req), updated_at: new Date().toISOString(),
    }, { onConflict: 'account_login,position_id' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ------------------------------------------------------------------ signals
// Every checkpoint evaluation the engine made, with the risk layer's decision for it.
router.get('/signals', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    let q = supabase.from('evaluations').select('*').order('eval_time', { ascending: false }).limit(limit);
    if (req.query.strategy) q = q.eq('strategy_id', req.query.strategy);
    if (req.query.instrument) q = q.eq('instrument', req.query.instrument);
    if (req.query.actionable === '1') q = q.not('action', 'in', '("none","hold")');
    if (req.query.from) q = q.gte('eval_time', req.query.from);
    const { data: evals, error } = await q;
    if (error) throw error;
    const ids = (evals || []).map((e) => e.id);
    const decisions = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await supabase.from('risk_decisions').select('evaluation_id, approved, shadow, skip_reason, desired_lots, final_lots, steps').in('evaluation_id', ids.slice(i, i + 200));
      decisions.push(...(data || []));
    }
    const decByEval = new Map(decisions.map((d) => [d.evaluation_id, d]));
    const signals = (evals || []).map((e) => ({ ...e, decision: decByEval.get(e.id) || null }));

    // current state per market: latest evaluation in the last 24 hours
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: recent } = await supabase.from('evaluations').select('*').gte('eval_time', since).order('eval_time', { ascending: false }).limit(2000);
    const counts = {};
    for (const e of recent || []) counts[e.action] = (counts[e.action] || 0) + 1;
    res.json({ signals, markets: journal.latestByMarket(recent || []), last24h: counts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.loadSettings = loadSettings;
