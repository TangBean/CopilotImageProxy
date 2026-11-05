import assert from 'node:assert/strict';
import test from 'node:test';
import { usageTrendScript } from '../src/usage-trends.mjs';
import { activeValues, count, groups, tooltips, viewer } from './helpers/usage-trends.mjs';

const usd = (amount) => ({ currency: 'USD', amount });
const day = (date, costs) => ({ date, byModel: Object.entries(costs).map(([model, costs]) => ({ model, costs })) });
const summary = (...days) => ({ days, byModel: [] });

test('cost uses upstream amount precedence and nanos fallback without converting other currencies', () => {
  const html = viewer().renderCostTrend(summary(day('2026-11-03', {
    amount: [{ currency: 'USD', amount: 0.125, total_cost_nanos: 9000000000 }],
    nano: [{ currency: 'USD', total_cost_nanos: 1 }],
    zero: [usd(0)],
    eur: [{ currency: 'EUR', amount: 8 }],
    mixed: [{ currency: 'EUR', amount: 999 }, usd(0.25)],
    missing: [],
    invalid: [usd(NaN)],
  })));
  assert.deepEqual(tooltips(html), ['11/03\nTotal: —\namount: 0.125\neur: —\ninvalid: —\nmissing: —\nmixed: 0.25\nnano: 0.000000001\nzero: 0']);
  assert.equal(count(html, '<circle '), 4);
  assert.doesNotMatch(html, /data-cost-model="All"|NaN|Infinity/);
  assert.doesNotMatch(tooltips(html).join('\n'), /999/);
  assert.match(html, /<text[^>]*>0<\/text>/);
});

test('cost has title-only USD units and independent Metric filtering', () => {
  const data = summary(day('2026-11-03', { alpha: [usd(0.1)], beta: [usd(20)] }));
  data.days[0].byModel.forEach((row) => { row.output_tokens_per_second = 15; });
  const view = viewer();
  const cost = view.renderCostTrend(data);
  const speed = view.renderOutputSpeedTrend(data);
  assert.match(cost, /Cost \(USD\)/);
  assert.equal(count(cost, 'USD'), 1);
  assert.match(cost, /data-cost-all/);
  assert.doesNotMatch(cost, /<select/);
  view.click('cost', 'metric', 'alpha');
  const selected = view.renderCostTrend(data);
  assert.deepEqual(groups(selected, 'cost').map(({ model }) => model), ['alpha']);
  assert.deepEqual(tooltips(selected), ['11/03\nalpha: 0.1']);
  assert.match(activeValues(selected, 'cost'), /alpha: 0.1/);
  assert.doesNotMatch(activeValues(selected, 'cost'), /beta|USD/);
  assert.equal(view.renderOutputSpeedTrend(data), speed);
  view.click('cost', 'all');
  assert.deepEqual(groups(view.renderCostTrend(data), 'cost'), groups(cost, 'cost'));
});

test('unknown USD days break the line and explicit zero remains a measured dot', () => {
  const html = viewer().renderCostTrend(summary(
    day('2026-11-01', { alpha: [usd(1)] }),
    day('2026-11-02', { alpha: null }),
    day('2026-11-03', { alpha: [usd(0)] }),
    day('2026-11-04', { alpha: [{ currency: 'EUR', amount: 4 }] }),
    day('2026-11-05', { alpha: [usd(2)] }),
  ));
  const [line] = groups(html, 'cost');
  assert.equal(count(line.path, 'M'), 3);
  assert.doesNotMatch(line.path, /L/);
  assert.equal(line.dots.length, 3);
  assert.match(tooltips(html)[1], /alpha: —$/);
  assert.match(tooltips(html)[2], /alpha: 0$/);
  assert.match(tooltips(html)[3], /alpha: —$/);
});

test('tiny USD values and a single point remain visible without rounding to zero', () => {
  for (const amount of [0, 1e-9, 1e-12, 0.000000123456]) {
    const html = viewer('-34day').renderCostTrend(summary(day('2026-10-01', { alpha: [usd(amount)] })));
    const [line] = groups(html, 'cost');
    assert.equal(line.dots.length, 1);
    assert.equal(line.dots[0].radius, 2.5);
    if (amount > 0) assert.doesNotMatch(tooltips(html)[0], /alpha: 0$/);
    assert.doesNotMatch(tooltips(html)[0], /USD/);
    assert.match(html, /viewBox="0 0 720 220"/);
  }
});

test('cost retains rare lifetime models and outliers and shares speed colors', () => {
  const days = Array.from({ length: 366 }, (_, index) => {
    const data = day(new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
      index === 181 ? { frequent: [usd(0.1)], rare: [usd(1e12)] } : { frequent: [usd(0.1)] });
    data.byModel.forEach((row) => { row.output_tokens_per_second = 15; });
    return data;
  });
  const data = { byModel: [{ model: 'frequent' }], days };
  const view = viewer('lifetime');
  const cost = view.renderCostTrend(data);
  const speed = view.renderOutputSpeedTrend(data);
  assert.equal(tooltips(cost).length, 366);
  assert.match(tooltips(cost)[181], /rare: 1000000000000$/);
  assert.match(cost, /1(?:\.0+)?e\+12/);
  assert.equal(groups(cost, 'cost')[1].dots.length, 1);
  assert.deepEqual(groups(cost, 'cost').map(({ model, color }) => ({ model, color })),
    groups(speed).map(({ model, color }) => ({ model, color })));
});

test('cost escapes model names in attributes, legends, buttons and tooltip text', () => {
  const model = 'model"><img src=x onerror="alert(1)">&\' </script> 中文';
  const view = viewer();
  const html = view.renderCostTrend(summary(day('2026-11-03', { [model]: [usd(0.5)] })));
  assert.doesNotMatch(html, /<img|<\/script>/);
  assert.equal(groups(html, 'cost')[0].model, view.escapeHtml(model));
  assert.deepEqual(tooltips(html), [view.escapeHtml(`11/03\nTotal: —\n${model}: 0.5`)]);
  assert.ok(html.includes(`data-cost-metric="${view.escapeHtml(model)}"`));
});

test('cost hides Today and handles empty data and errors without drawing stale values', () => {
  const data = summary(day('2026-11-03', { alpha: [usd(123)] }));
  assert.equal(viewer('today').renderCostTrend(data), '');
  for (const empty of [null, summary(), summary(day('2026-11-03', {}))]) {
    assert.match(viewer().renderCostTrend(empty), /No daily model data/);
  }
  const html = viewer().renderCostTrend(data, '<failed>');
  assert.match(html, /role="alert"/);
  assert.match(html, /&lt;failed&gt;/);
  assert.doesNotMatch(html, /<circle|data-cost-chart|data-cost-values/);
});

test('non-UTF-8 pages retain missing USD markers after script decoding', () => {
  const source = new TextDecoder('windows-1252').decode(Buffer.from(usageTrendScript, 'utf8'));
  const html = viewer('last_7_days', source).renderCostTrend(summary(day('2026-11-03', { alpha: [] })));
  assert.deepEqual(tooltips(html), ['11/03\nTotal: —\nalpha: —']);
  assert.match(html, /Cost \(USD\)/);
  assert.equal(count(html, 'USD'), 1);
});

test('Total uses daily USD totals, shares the original Total color and can be selected independently', () => {
  const view = viewer();
  const data = {
    totals: { costs: [usd(999)] },
    days: [
      { ...day('2026-11-01', { alpha: [usd(2)] }), totals: { costs: [{ currency: 'USD', amount: 10, total_cost_nanos: 9000000000 }] } },
      { ...day('2026-11-02', { alpha: [usd(3)] }), totals: { costs: [{ currency: 'USD', total_cost_nanos: 1 }] } },
      { ...day('2026-11-03', { alpha: [usd(4)] }), totals: { costs: [{ currency: 'EUR', amount: 7 }] } },
      { ...day('2026-11-04', { alpha: [usd(5)] }), totals: { costs: [usd(0)] } },
      day('2026-11-05', { alpha: [usd(6)] }),
    ],
  };
  const all = view.renderCostTrend(data);
  assert.match(all, /data-cost-total\s+aria-pressed="false"/);
  assert.match(all, /<g data-cost-total-series><path[^>]*stroke="var\(--color-fg-lightest\)"/);
  assert.match(all, /data-cost-total[\s\S]*?background-color: var\(--color-fg-lightest\);/);
  assert.match(all, /data-cost-legend[\s\S]*?>Total</);
  assert.equal(groups(all, 'cost').length, 1);
  assert.deepEqual(tooltips(all).map((text) => text.split('\n')[1]), [
    'Total: 10', 'Total: 0.000000001', 'Total: —', 'Total: 0', 'Total: —',
  ]);
  view.click('cost', 'total');
  const selected = view.renderCostTrend(data);
  assert.match(selected, /data-cost-total\s+aria-pressed="true"/);
  assert.equal(groups(selected, 'cost').length, 0);
  assert.equal(count(selected, '<circle '), 3);
  assert.match(activeValues(selected, 'cost'), /11\/04[\s\S]*Total: 0/);
  assert.doesNotMatch(activeValues(selected, 'cost'), /alpha|USD/);
  assert.deepEqual(tooltips(selected), [
    '11/01\nTotal: 10', '11/02\nTotal: 0.000000001', '11/03\nTotal: —', '11/04\nTotal: 0', '11/05\nTotal: —',
  ]);
  const totalPath = selected.match(/data-cost-total-series><path d="([^"]*)"/)?.[1];
  assert.equal(count(totalPath, 'M'), 2);
  assert.equal(count(totalPath, 'L'), 1);
  view.click('cost', 'all');
  assert.equal(groups(view.renderCostTrend(data), 'cost').length, 1);
  assert.doesNotMatch(view.renderOutputSpeedTrend(data), /data-output-speed-total/);
});

test('Total remains available without model rows and does not collide with a model named Total', () => {
  const view = viewer();
  const data = summary({ ...day('2026-11-03', { Total: [usd(3)] }), totals: { costs: [usd(5)] } });
  view.renderCostTrend(data);
  view.click('cost', 'metric', 'Total');
  const model = view.renderCostTrend(data);
  assert.match(model, /data-cost-model="Total"/);
  assert.doesNotMatch(model, /data-cost-total-series/);
  assert.deepEqual(tooltips(model), ['11/03\nTotal: 3']);
  view.click('cost', 'total');
  const total = view.renderCostTrend(data);
  assert.doesNotMatch(total, /data-cost-model="Total"/);
  assert.deepEqual(tooltips(total), ['11/03\nTotal: 5']);
  for (const amount of [0, 1e-9, 8]) {
    const onlyTotal = view.renderCostTrend(summary({ date: '2026-11-04', totals: { costs: [usd(amount)] } }));
    assert.match(onlyTotal, /data-cost-total\s+aria-pressed="true"/);
    assert.match(onlyTotal, /data-cost-chart/);
    assert.equal(count(onlyTotal, '<circle '), 1);
    assert.equal(groups(onlyTotal, 'cost').length, 0);
  }
});
