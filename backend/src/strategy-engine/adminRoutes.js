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
    const [skips, recon] = await Promise.all([
      supabase.from('risk_decisions').select('strategy_id, symbol, skip_reason, created_at').eq('approved', false).order('created_at', { ascending: false }).limit(50),
      supabase.from('reconciliations').select('*').order('created_at', { ascending: false }).limit(1),
    ]);
    res.json({ recentSkips: skips.data || [], lastReconciliation: (recon.data || [])[0] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.loadSettings = loadSettings;
