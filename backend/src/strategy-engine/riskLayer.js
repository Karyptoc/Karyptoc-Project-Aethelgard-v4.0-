'use strict';
/**
 * Portfolio and risk layer. Every new or increased position passes through
 * sizeOrder(); closing or reducing a position never needs approval.
 * Every step is returned so it can be stored in risk_decisions.
 */

/** Value of a 1.0 price move for 1 lot, in account currency. */
function valuePerUnit(spec) {
  return spec.tick_value / spec.tick_size;
}

function roundDownToStep(lots, spec) {
  const step = spec.volume_step;
  const n = Math.floor((Math.abs(lots) + 1e-9) / step);
  const out = Number((n * step).toFixed(8));
  return Math.min(out, spec.volume_max || Infinity);
}

/** Open risk (loss to stop) of one position, account currency. */
function positionRisk(p) {
  return Math.abs(p.entry - p.stop) * p.valuePerUnit * Math.abs(p.lots);
}

/** Strategy A/B sizing: volatility target, then capped leverage (paper used 2% / 4x; we halve). */
function volTargetLots({ equity, dailyVol, price, spec, target = 0.01, maxLeverage = 2 }) {
  if (!dailyVol || dailyVol <= 0) return 0;
  const notional = equity * Math.min(maxLeverage, target / dailyVol);
  return notional / (price * valuePerUnit(spec));
}

function lossLimitBreach(account, settings) {
  const r = settings.risk;
  const day = (account.startOfDayEquity - account.equity) / account.startOfDayEquity;
  const week = (account.startOfWeekEquity - account.equity) / account.startOfWeekEquity;
  const dd = (account.peakEquity - account.equity) / account.peakEquity;
  if (dd >= r.maxDrawdownPct / 100) return { scope: 'all', reason: `account drawdown ${(dd * 100).toFixed(2)}% >= ${r.maxDrawdownPct}%` };
  if (week >= r.weeklyLossPct / 100) return { scope: 'all', reason: `weekly loss ${(week * 100).toFixed(2)}% >= ${r.weeklyLossPct}%` };
  if (day >= r.dailyLossPct / 100) return { scope: 'intraday', reason: `daily loss ${(day * 100).toFixed(2)}% >= ${r.dailyLossPct}%` };
  return null;
}

/**
 * request: { strategy, symbol, cluster, desiredLots (>0), entry, stop, spec }
 * account: { equity, startOfDayEquity, startOfWeekEquity, peakEquity, marginUsed }
 * openPositions: [{ strategy, symbol, cluster, lots, entry, stop, valuePerUnit }]
 * settings: admin settings (see adminSettings.js)
 */
function sizeOrder(request, account, openPositions, settings) {
  const steps = [];
  const reject = (reason) => ({ approved: false, lots: 0, skipReason: reason, steps });
  const { strategy, symbol, cluster, entry, stop, spec } = request;
  const s = settings.strategies[strategy];
  const eq = account.equity;
  const vpu = valuePerUnit(spec);
  let lots = Math.abs(request.desiredLots);
  steps.push({ step: 'desired', lots });

  if (settings.global.killSwitch) return reject('kill switch on');
  if (!s || s.mode === 'off') return reject(`strategy ${strategy} is off`);
  const sym = settings.symbols[symbol];
  if (!sym || !sym.enabled) return reject(`symbol ${symbol} disabled`);
  if (!sym.strategies.includes(strategy)) return reject(`${symbol} not enabled for ${strategy}`);

  const breach = lossLimitBreach(account, settings);
  if (breach && (breach.scope === 'all' || strategy !== 'C')) return reject(breach.reason);

  const stopDist = Math.abs(entry - stop);
  if (!(stopDist > 0)) return reject('no valid stop distance');
  if (spec.trade_stops_level && stopDist < spec.trade_stops_level * spec.point) return reject('stop closer than broker minimum');

  // per-trade cap: loss to emergency stop
  const perTradeCap = (settings.risk.perTradeRiskPct / 100) * eq;
  lots = Math.min(lots, perTradeCap / (stopDist * vpu));
  steps.push({ step: 'per_trade_cap', cap: perTradeCap, lots });

  const used = (filter) => openPositions.filter(filter).reduce((a, p) => a + positionRisk(p), 0);
  const budgets = [
    ['strategy_budget', (s.riskBudgetPct / 100) * eq - used((p) => p.strategy === strategy)],
    ['cluster_budget', ((settings.clusters[cluster] ?? 0) / 100) * eq - used((p) => p.cluster === cluster)],
    ['account_budget', (settings.risk.accountOpenRiskPct / 100) * eq - used(() => true)],
  ];
  for (const [name, remaining] of budgets) {
    const maxLots = Math.max(0, remaining) / (stopDist * vpu);
    lots = Math.min(lots, maxLots);
    steps.push({ step: name, remaining, lots });
  }

  if (spec.margin_per_lot) {
    const freeMargin = (settings.risk.maxMarginPct / 100) * eq - (account.marginUsed || 0);
    lots = Math.min(lots, Math.max(0, freeMargin) / spec.margin_per_lot);
    steps.push({ step: 'margin', freeMargin, lots });
  }

  const rounded = roundDownToStep(lots, spec);
  steps.push({ step: 'round_down', lots: rounded });
  if (rounded < spec.volume_min) return reject(`below minimum lot (${lots.toFixed(4)} < ${spec.volume_min})`);

  return { approved: true, lots: rounded, shadow: s.mode === 'shadow', riskAmount: rounded * stopDist * vpu, steps };
}

module.exports = { valuePerUnit, roundDownToStep, positionRisk, volTargetLots, lossLimitBreach, sizeOrder };
