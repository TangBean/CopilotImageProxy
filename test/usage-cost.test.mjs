import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { usageTrendScript } from '../src/usage-trends.mjs';

const upstream = readFileSync(new URL('./fixtures/usage-viewer.upstream.html', import.meta.url), 'utf8');
const start = upstream.indexOf('function getCostAmount(cost) {');
assert.ok(start >= 0);
const getter = upstream.slice(start, upstream.indexOf('\n        }', start) + '\n        }'.length);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

function viewer(period = 'last_7_days', source = usageTrendScript) {
  const context = {
    state: { tokenUsagePeriod: period }, escapeHtml,
    renderError: (message, title) => `<p role="alert">${escapeHtml(title)}: ${escapeHtml(message)}</p>`,
  };
  runInNewContext(`${getter}\n${source}`, context);
  return context;
}
const usd = (amount) => ({ currency: 'USD', amount });
const day = (date, costs) => ({ date, byModel: Object.entries(costs).map(([model, costs]) => ({ model, costs })) });
const summary = (...days) => ({ days, byModel: [] });
const titles = (html) => [...html.matchAll(/<title>([\s\S]*?)<\/title>/g)].map(([, text]) => text);
const series = (html, key = 'cost') => [...html.matchAll(new RegExp(`<g data-${key}-model="([^"]*)">([\\s\\S]*?)<\\/g>`, 'g'))]
  .map(([, model, body]) => ({ model, body, color: body.match(/stroke="([^"]*)"/)?.[1] }));

test('cost uses upstream amount precedence and nanos fallback without converting other currencies', () => {
  const view = viewer();
  const html = view.renderCostTrend(summary(day('2026-11-03', {
    amount: [{ currency: 'USD', amount: 0.125, total_cost_nanos: 9000000000 }],
    nano: [{ currency: 'USD', total_cost_nanos: 1 }],
    zero: [usd(0)],
    eur: [{ currency: 'EUR', amount: 8 }],
    mixed: [{ currency: 'EUR', amount: 999 }, usd(0.25)],
    missing: [],
    invalid: [usd(NaN)],
  })));
  assert.deepEqual(titles(html), [
    '2026-11-03\namount: 0.125 USD\neur: — USD\ninvalid: — USD\nmissing: — USD\nmixed: 0.25 USD\nnano: 0.000000001 USD\nzero: 0 USD',
  ]);
  assert.equal((html.match(/<circle /g) || []).length, 4);
  assert.doesNotMatch(html, /data-cost-model="All"|>All<|NaN|Infinity/);
  assert.doesNotMatch(titles(html).join('\n'), /999 USD/);
  assert.match(html, /<text[^>]*>0<\/text>/);
});

test('unknown USD days break the line and explicit zero remains a measured dot', () => {
  const html = viewer().renderCostTrend(summary(
    day('2026-11-01', { alpha: [usd(1)] }),
    day('2026-11-02', { alpha: null }),
    day('2026-11-03', { alpha: [usd(0)] }),
    day('2026-11-04', { alpha: [{ currency: 'EUR', amount: 4 }] }),
    day('2026-11-05', { alpha: [usd(2)] }),
  ));
  const path = series(html)[0].body.match(/<path d="([^"]*)"/)[1];
  assert.equal((path.match(/M/g) || []).length, 3);
  assert.doesNotMatch(path, /L/);
  assert.equal((html.match(/<circle /g) || []).length, 3);
  assert.match(titles(html)[1], /alpha: — USD/);
  assert.match(titles(html)[2], /alpha: 0 USD/);
  assert.match(titles(html)[3], /alpha: — USD/);
});

test('tiny USD values and a single point remain visible without rounding to zero', () => {
  for (const amount of [0, 1e-9, 1e-12, 0.000000123456]) {
    const html = viewer('-34day').renderCostTrend(summary(day('2026-10-01', { alpha: [usd(amount)] })));
    assert.equal((html.match(/<circle /g) || []).length, 1);
    assert.match(html, /r="3"/);
    if (amount > 0) assert.doesNotMatch(titles(html)[0], /alpha: 0 USD/);
    assert.match(html, /aria-label="Cost \(USD\) by model in USD"/);
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
  assert.equal(titles(cost).length, 366);
  assert.match(titles(cost)[181], /rare: 1000000000000 USD/);
  assert.match(cost, /1\.000e\+12/);
  assert.equal((series(cost)[1].body.match(/<circle /g) || []).length, 1);
  assert.deepEqual(series(cost).map(({ model, color }) => ({ model, color })),
    series(speed, 'output-speed').map(({ model, color }) => ({ model, color })));
});

test('cost escapes model names in attributes, legends and tooltip text', () => {
  const model = 'model"><img src=x onerror="alert(1)">&\' </script> 中文';
  const html = viewer().renderCostTrend(summary(day('2026-11-03', { [model]: [usd(0.5)] })));
  assert.doesNotMatch(html, /<img|<\/script>/);
  assert.equal(series(html)[0].model, escapeHtml(model));
  assert.deepEqual(titles(html), [escapeHtml(`2026-11-03\n${model}: 0.5 USD`)]);
});

test('cost hides Today and handles empty data and errors without drawing stale values', () => {
  const data = summary(day('2026-11-03', { alpha: [usd(123)] }));
  assert.equal(viewer('today').renderCostTrend(data), '');
  for (const empty of [null, summary(), summary(day('2026-11-03', {}))]) {
    assert.match(viewer().renderCostTrend(empty), /— No daily model data/);
  }
  const html = viewer().renderCostTrend(data, '<failed>');
  assert.match(html, /Cost \(USD\) failed: &lt;failed&gt;/);
  assert.doesNotMatch(html, /<circle|data-cost-chart/);
});

test('non-UTF-8 pages retain missing USD markers and caption characters after script decoding', () => {
  const source = new TextDecoder('windows-1252').decode(Buffer.from(usageTrendScript, 'utf8'));
  const view = viewer('last_7_days', source);
  const html = view.renderCostTrend(summary(day('2026-11-03', { alpha: [] })));
  assert.deepEqual(titles(html), ['2026-11-03\nalpha: — USD']);
  assert.match(html, /USD · per model · daily/);
  assert.match(view.renderCostTrend(summary()), /— No daily model data/);
});
