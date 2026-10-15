'use strict';
/**
 * Admin controls: the settings the dashboard can change, their defaults, the
 * hard ceilings the dashboard can NEVER exceed, and the governance rules.
 * All validation runs here on the server; the dashboard is only a client.
 */

const { INSTRUMENTS, BROKER_PROFILES } = require('./config/instruments');

const STRATEGY_MODES = ['off', 'shadow', 'demo', 'live'];

/** Hard limits. Changing these requires a code change + deploy, not a click. */
const CEILINGS = Object.freeze({
  'risk.perTradeRiskPct': [0.1, 1.5],
  'risk.dailyLossPct': [0.5, 3],
  'risk.weeklyLossPct': [1, 6],
  'risk.maxDrawdownPct': [3, 15],
  'risk.accountOpenRiskPct': [0.25, 3],
  'risk.maxMarginPct': [5, 35],
  'strategies.*.riskBudgetPct': [0, 1.5],
  'clusters.*': [0, 1.0],
  'strategies.A.params.lookback': [5, 90],
  'strategies.B.params.lookback': [5, 90],
  'strategies.A.params.vm': [0.5, 2.0],
  'strategies.B.params.vm': [0.5, 2.0],
  'strategies.C.params.portfolioVolTarget': [0.02, 0.15],
  'global.newsBlackoutBeforeMin': [0, 60],
  'global.newsBlackoutAfterMin': [0, 120],
  'symbols.*.maxSpreadPoints': [0, 100000],
});

function defaultSettings() {
  const symbols = {};
  for (const [id, ins] of Object.entries(INSTRUMENTS)) {
    symbols[id] = { enabled: true, strategies: [...ins.strategies], brokerSymbol: null, maxSpreadPoints: null };
  }
  return {
    version: 1,
    global: {
      killSwitch: false,
      killMode: 'freeze',            // freeze = no new entries; flatten = also close everything
      brokerProfile: 'XM',
      accountType: 'demo',           // demo | live — must match the connected MT5 account
      newsBlackoutBeforeMin: 5,
      newsBlackoutAfterMin: 15,
      displayTz: 'Africa/Nairobi',
    },
    strategies: {
      A: { mode: 'shadow', riskBudgetPct: 0.75, liveApproved: false, approvalRef: null, paramsVersion: 1, params: { lookback: 14, vm: 1.0, useVwapTrail: true } },
      B: { mode: 'off', riskBudgetPct: 0.5, liveApproved: false, approvalRef: null, paramsVersion: 1, params: { lookback: 14, vm: 1.0, useVwapTrail: true, anchor: 'COMEX_DAY' } },
      C: { mode: 'shadow', riskBudgetPct: 1.0, liveApproved: false, approvalRef: null, paramsVersion: 1, params: { portfolioVolTarget: 0.10 } },
    },
    risk: {
      perTradeRiskPct: 1.0,
      dailyLossPct: 2,
      weeklyLossPct: 4,
      maxDrawdownPct: 10,
      accountOpenRiskPct: 2,
      maxMarginPct: 25,
    },
    clusters: { US_EQUITY: 0.5, EU_EQUITY: 0.25, GOLD: 0.5, CRYPTO: 0.5, USD: 0.75 },
    symbols,
  };
}

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, p, out); else out[p] = v;
  }
  return out;
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) { if (o[keys[i]] == null) o[keys[i]] = {}; o = o[keys[i]]; }
  o[keys[keys.length - 1]] = value;
}

function ceilingFor(path) {
  if (CEILINGS[path]) return CEILINGS[path];
  for (const [pat, lim] of Object.entries(CEILINGS)) {
    if (!pat.includes('*')) continue;
    const re = new RegExp(`^${pat.replace(/\./g, '\\.').replace('*', '[^.]+')}$`);
    if (re.test(path)) return lim;
  }
  return null;
}

/**
 * Apply a patch (list of { path, value }) from an admin.
 * Returns { ok, next, errors, audit, notices }. Never mutates `current`.
 */
function applyAdminChange(current, changes, { actor, reason = '' } = {}) {
  const next = JSON.parse(JSON.stringify(current));
  const errors = []; const notices = []; const audit = [];
  const before = flatten(current);
  const anyLive = () => Object.values(next.strategies).some((s) => s.mode === 'live');

  for (const { path, value } of changes) {
    const known = Object.prototype.hasOwnProperty.call(before, path) || /^symbols\.[A-Z0-9]+\.(brokerSymbol|maxSpreadPoints)$/.test(path);
    if (!known) { errors.push(`${path}: unknown setting`); continue; }
    if (path === 'version' || /paramsVersion$/.test(path)) { errors.push(`${path}: managed by the system`); continue; }

    const lim = ceilingFor(path);
    if (lim && value != null && (typeof value !== 'number' || value < lim[0] || value > lim[1])) {
      errors.push(`${path}: must be a number between ${lim[0]} and ${lim[1]}`); continue;
    }
    if (/^strategies\.[ABC]\.mode$/.test(path) && !STRATEGY_MODES.includes(value)) { errors.push(`${path}: invalid mode`); continue; }
    if (path === 'global.brokerProfile' && !BROKER_PROFILES[value]) { errors.push(`${path}: unknown broker profile`); continue; }
    if (path === 'global.accountType' && !['demo', 'live'].includes(value)) { errors.push(`${path}: must be demo or live`); continue; }
    if (path === 'global.killMode' && !['freeze', 'flatten'].includes(value)) { errors.push(`${path}: must be freeze or flatten`); continue; }
    if (/^symbols\.[A-Z0-9]+\.strategies$/.test(path)) {
      const id = path.split('.')[1];
      if (!Array.isArray(value) || value.some((s) => !INSTRUMENTS[id].strategies.includes(s))) {
        errors.push(`${path}: allowed strategies for ${id} are ${INSTRUMENTS[id].strategies.join(', ')}`); continue;
      }
    }
    setPath(next, path, value);
    audit.push({ path, from: before[path] ?? null, to: value, actor, reason, at: new Date().toISOString() });
  }

  // ---- governance rules on the resulting state ----
  for (const [id, s] of Object.entries(next.strategies)) {
    const prev = current.strategies[id];
    if (s.liveApproved && !prev.liveApproved && !(s.approvalRef && String(s.approvalRef).trim())) {
      errors.push(`strategies.${id}.liveApproved: needs approvalRef (link to the validation report)`);
    }
    if (s.mode === 'live' && prev.mode !== 'live') {
      if (!s.liveApproved) errors.push(`strategies.${id}.mode: live requires liveApproved after passing validation`);
      if (next.global.accountType !== 'live') errors.push(`strategies.${id}.mode: live requires global.accountType = live`);
    }
    if (JSON.stringify(s.params) !== JSON.stringify(prev.params)) {
      s.paramsVersion = prev.paramsVersion + 1;
      s.liveApproved = false; s.approvalRef = null;
      if (s.mode === 'live' || s.mode === 'demo') {
        s.mode = 'shadow';
        notices.push(`Strategy ${id}: parameters changed, so it was moved to shadow and must be re-approved (new version ${s.paramsVersion}). Log it as a new trial.`);
      }
    }
  }
  if (current.global.killSwitch && !next.global.killSwitch && !reason.trim()) {
    errors.push('global.killSwitch: turning the kill switch off requires a reason');
  }
  if (next.global.brokerProfile !== current.global.brokerProfile && anyLive()) {
    errors.push('global.brokerProfile: cannot switch broker while a strategy is live');
  }
  if (next.global.accountType === 'live' && current.global.accountType !== 'live' && !reason.trim()) {
    errors.push('global.accountType: switching to live requires a reason');
  }

  if (errors.length) return { ok: false, next: current, errors, audit: [], notices: [] };
  next.version = current.version + 1;
  return { ok: true, next, errors, audit, notices };
}

/** Is a strategy allowed to send real orders right now? */
function canSendOrders(settings, strategy) {
  const s = settings.strategies[strategy];
  if (settings.global.killSwitch) return false;
  if (s.mode === 'demo') return settings.global.accountType === 'demo';
  if (s.mode === 'live') return settings.global.accountType === 'live' && s.liveApproved;
  return false; // off or shadow
}

module.exports = { STRATEGY_MODES, CEILINGS, defaultSettings, applyAdminChange, canSendOrders, flatten };
