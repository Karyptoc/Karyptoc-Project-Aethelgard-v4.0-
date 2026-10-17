'use strict';
const test = require('node:test');
const assert = require('node:assert');
const j = require('../journalStats');

const T = (id, status, profit, open, close, extra = {}) => ({ position_id: id, status, profit, swap: 0, commission: -1,
  open_time: open, close_time: close, strategy_id: 'A', broker_symbol: 'NAS100', slippage_price: 0.5, ...extra });

test('summary is net of costs and ordered by close time', () => {
  const rows = [
    T(3, 'closed', -50, '2026-10-03T13:30:00Z', '2026-10-03T15:00:00Z'),
    T(1, 'closed', 101, '2026-10-01T13:30:00Z', '2026-10-01T14:30:00Z'),
    T(2, 'closed', 31, '2026-10-02T13:30:00Z', '2026-10-02T14:00:00Z'),
    T(4, 'open', 10, '2026-10-04T13:30:00Z', null),
  ];
  const s = j.summarize(rows);
  assert.strictEqual(s.closedTrades, 3);
  assert.strictEqual(s.openTrades, 1);
  assert.strictEqual(s.netPnl, 100 + 30 - 51);
  assert.strictEqual(s.winRate, 66.7);
  assert.strictEqual(s.profitFactor, 2.55);       // 130 / 51
  assert.strictEqual(s.maxDrawdown, -51);         // peak 130 then -51
  assert.deepStrictEqual(s.curve.map((c) => c.v), [100, 130, 79]);
  assert.strictEqual(s.avgHoldMinutes, 60);       // (60 + 30 + 90) / 3
  assert.strictEqual(s.costs, -3);
});

test('empty journal gives nulls, not errors', () => {
  const s = j.summarize([]);
  assert.strictEqual(s.closedTrades, 0);
  assert.strictEqual(s.winRate, null);
  assert.strictEqual(s.profitFactor, null);
});

test('breakdown by strategy and CSV escaping', () => {
  const rows = [T(1, 'closed', 10, 'a', 'b'), T(2, 'closed', -5, 'a', 'b', { strategy_id: 'B', note: 'news, "spike"' })];
  const b = j.breakdown(rows, 'strategy_id');
  assert.deepStrictEqual(b.map((x) => [x.key, x.netPnl]), [['A', 9], ['B', -6]]);
  const csv = j.toCsv(rows).split('\n');
  assert.strictEqual(csv[0].split(',')[0], 'strategy_id');
  assert.ok(csv[2].includes('"news, ""spike"""'));
});

test('latest evaluation per market', () => {
  const ev = [
    { strategy_id: 'A', instrument: 'NAS100', eval_time: '2026-10-16T14:00:00Z', action: 'hold' },
    { strategy_id: 'A', instrument: 'NAS100', eval_time: '2026-10-16T14:30:00Z', action: 'exit' },
    { strategy_id: 'B', instrument: 'XAUUSD', eval_time: '2026-10-16T13:00:00Z', action: 'none' },
  ];
  const m = j.latestByMarket(ev);
  assert.strictEqual(m.length, 2);
  assert.strictEqual(m.find((x) => x.instrument === 'NAS100').action, 'exit');
});
