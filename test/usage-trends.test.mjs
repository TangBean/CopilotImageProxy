import assert from 'node:assert/strict';
import test from 'node:test';
import { usageTrendScript } from '../src/usage-trends.mjs';
import { activeValues, count, groups, tooltips, viewer } from './helpers/usage-trends.mjs';

const day = (date, values) => ({
  date, byModel: Object.entries(values).map(([model, speed]) => ({ model, output_tokens_per_second: speed })),
});
const summary = (...days) => ({ days, byModel: [] });

test('speed matches the original chart layout with Metric-only Filters and title-only units', () => {
  const data = summary(day('2026-11-03', { alpha: 14.5, beta: 22 }));
  const today = viewer('today');
  assert.equal(today.renderOutputSpeedTrend(data), '');
  assert.equal(today.renderOutputSpeedTrend(data, 'Daily request failed'), '');
  for (const period of ['this_week', 'last_7_days', 'this_month', 'last_30_days', 'lifetime', '-1day', '-34day']) {
    const html = viewer(period).renderOutputSpeedTrend(data);
    assert.equal(count(html, 'data-output-speed-panel'), 1, period);
    assert.equal(count(html, 'data-output-speed-chart'), 1, period);
    assert.match(html, /Output speed \(tokens\/s\)/);
    assert.equal(count(html, 'tokens/s'), 1);
    assert.match(html, /xl:grid-cols-\[minmax\(0,1fr\)_304px\]/);
    assert.match(html, /<svg[^>]*class="w-full h-56"[^>]*viewBox="0 0 720 220"/);
    assert.match(html, /<aside class="panel(?: [^"]*)?">[\s\S]*>Filters<\/p>/);
    assert.match(html, />Metric<\/div>/);
    assert.match(html, /data-output-speed-all/);
    assert.match(html, /data-output-speed-metric="alpha"/);
    assert.doesNotMatch(html, /<select|data-trend-day|data-trend-metric|data-token-usage-trend-model|min-width:640px/);
    assert.ok(html.indexOf('data-output-speed-legend') > html.indexOf('</svg>'));
    assert.ok(html.indexOf('data-output-speed-values') > html.indexOf('data-output-speed-legend'));
  }
});

test('speed series come from all daily models and never from aggregate totals', () => {
  const data = {
    byModel: [{ model: 'alpha', output_tokens_per_second: 999999 }],
    totals: { output_tokens_per_second: 123456789 },
    days: [
      { ...day('2026-11-02', { alpha: 12 }), totals: { output_tokens_per_second: 1000000 } },
      { ...day('2026-11-03', { alpha: 18, 'day-only-model': 3 }), totals: { output_tokens_per_second: 2000000 } },
    ],
  };
  const view = viewer();
  const html = view.renderOutputSpeedTrend(data);
  assert.deepEqual(groups(html).map((group) => group.model), ['alpha', 'day-only-model']);
  assert.doesNotMatch(html, /data-output-speed-model="All"|123456789|999999|2000000/);
  assert.deepEqual(tooltips(html), ['11/02\nalpha: 12\nday-only-model: —', '11/03\nalpha: 18\nday-only-model: 3']);
  data.totals.output_tokens_per_second = 0;
  data.days.forEach((value) => { value.totals.output_tokens_per_second = 0; });
  assert.equal(view.renderOutputSpeedTrend(data), html, 'Aggregate changes must not affect model lines or scales');
});

test('Metric selects one model, rescales to its values, and All restores every series', () => {
  const view = viewer();
  const data = summary(day('2026-11-02', { alpha: 1, beta: 100 }), day('2026-11-03', { alpha: 2, beta: 200 }));
  const initial = view.renderOutputSpeedTrend(data);
  view.click('output-speed', 'metric', 'alpha');
  const selected = view.renderOutputSpeedTrend(data);
  assert.deepEqual(groups(selected).map(({ model }) => model), ['alpha']);
  assert.match(selected, /data-output-speed-metric="alpha"\s+aria-pressed="true"/);
  assert.match(selected, /data-output-speed-all\s+aria-pressed="false"/);
  assert.ok(groups(selected)[0].dots[1].y < groups(initial)[0].dots[1].y);
  assert.deepEqual(tooltips(selected), ['11/02\nalpha: 1', '11/03\nalpha: 2']);
  assert.match(selected, /data-output-speed-legend[\s\S]*beta/);
  assert.doesNotMatch(activeValues(selected), /beta/);
  view.click('output-speed', 'all');
  assert.deepEqual(groups(view.renderOutputSpeedTrend(data)), groups(initial));
});

test('model names cannot collide with All or object-property names', () => {
  const view = viewer();
  const names = ['', '__all__', '__proto__', 'constructor'];
  const data = summary(day('2026-11-03', Object.fromEntries(names.map((name, index) => [name, index + 1]))));
  view.renderOutputSpeedTrend(data);
  for (const model of names) {
    view.click('output-speed', 'metric', model);
    const html = view.renderOutputSpeedTrend(data);
    assert.deepEqual(groups(html).map((group) => group.model), [model]);
  }
  view.click('output-speed', 'all');
  assert.equal(groups(view.renderOutputSpeedTrend(data)).length, names.length);
});

test('active date follows visible measurements until selected and falls back when removed', () => {
  const view = viewer();
  const data = summary(
    day('2026-11-01', { alpha: 0, beta: 1 }),
    day('2026-11-02', { alpha: null, beta: 8 }),
    day('2026-11-03', { alpha: null, beta: null }),
  );
  const active = (source) => source.match(/data-output-speed-active-day="([^"]*)"/)?.[1];
  assert.equal(active(view.renderOutputSpeedTrend(data)), '2026-11-02');
  view.click('output-speed', 'metric', 'alpha');
  assert.equal(active(view.renderOutputSpeedTrend(data)), '2026-11-01', 'Zero is a valid measurement');
  view.click('output-speed', 'day', '2026-11-03');
  const selected = view.renderOutputSpeedTrend(data);
  assert.equal(active(selected), '2026-11-03');
  assert.match(activeValues(selected), /alpha: —/);
  assert.equal(active(view.renderOutputSpeedTrend(summary(...data.days.slice(0, 2)))), '2026-11-01');
  const unavailable = summary(day('2026-11-04', { alpha: null }), day('2026-11-05', { alpha: null }));
  assert.equal(active(view.renderOutputSpeedTrend(unavailable)), '2026-11-05');
});

test('null and missing speeds break lines while actual zero remains a measured point', () => {
  const values = [2, null, 3, undefined, 0, NaN, Infinity, -Infinity, 4, 5];
  const html = viewer().renderOutputSpeedTrend(summary(...values.map((speed, index) =>
    day(`2026-11-${String(index + 1).padStart(2, '0')}`, { alpha: speed }))));
  const [line] = groups(html);
  assert.equal(line.dots.length, 5);
  assert.equal(count(line.path, 'M'), 4, 'Each segment after unavailable data starts a new path');
  assert.equal(count(line.path, 'L'), 1, 'Only adjacent measurements are connected');
  assert.ok(line.dots.every(({ x, y, radius }) => Number.isFinite(x) && Number.isFinite(y) && radius === 2.5));
  const titles = tooltips(html);
  for (const index of [1, 3, 5, 6, 7]) assert.match(titles[index], /alpha: —$/);
  assert.match(titles[4], /alpha: 0$/);
  assert.equal(line.dots[2].y, Math.max(...line.dots.map(({ y }) => y)));
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test('single speed measurements have visible centered dots, including zero and tiny values', () => {
  for (const speed of [0, 0.000000001, 12.75]) {
    const html = viewer('-1day').renderOutputSpeedTrend(summary(day('2026-11-03', { alpha: speed })));
    const [line] = groups(html);
    assert.equal(line.dots.length, 1);
    assert.equal(line.dots[0].radius, 2.5);
    assert.equal(count(line.path, 'M'), 1);
    assert.equal(count(line.path, 'L'), 0);
    const gridLine = html.match(/<line x1="([^"]*)" x2="([^"]*)"/);
    assert.equal(line.dots[0].x, (Number(gridLine[1]) + Number(gridLine[2])) / 2);
    assert.match(html, /<text[^>]*>0<\/text>/);
    if (speed !== 0) assert.doesNotMatch(tooltips(html)[0], /alpha: 0$/);
  }
});

test('empty data and unavailable speeds stay visibly unavailable instead of becoming zero', () => {
  for (const data of [undefined, summary(), summary(day('2026-11-03', {}))]) {
    const html = viewer().renderOutputSpeedTrend(data);
    assert.equal(count(html, 'data-output-speed-panel'), 1);
    assert.match(html, /No daily model data/);
    assert.equal(groups(html).length, 0);
    assert.doesNotMatch(html, /<circle/);
  }
  const html = viewer().renderOutputSpeedTrend(summary(day('2026-11-03', { alpha: null })));
  const [line] = groups(html);
  assert.equal(line.path.trim(), '');
  assert.equal(line.dots.length, 0);
  assert.deepEqual(tooltips(html), ['11/03\nalpha: —']);
  assert.match(activeValues(html), /alpha: —/);
});

test('non-UTF-8 pages preserve missing-value characters after script decoding', () => {
  const source = new TextDecoder('windows-1252').decode(Buffer.from(usageTrendScript, 'utf8'));
  const view = viewer('last_7_days', source);
  const html = view.renderOutputSpeedTrend(summary(day('2026-11-03', { alpha: null })));
  assert.deepEqual(tooltips(html), ['11/03\nalpha: —']);
  assert.match(html, /Output speed \(tokens\/s\)/);
});

test('a daily fetch error is shown inside the speed panel without stale points', () => {
  const html = viewer().renderOutputSpeedTrend(summary(day('2026-11-03', { alpha: 123 })), '<bad response>');
  assert.equal(count(html, 'data-output-speed-panel'), 1);
  assert.match(html, /role="alert"/);
  assert.match(html, /&lt;bad response&gt;/);
  assert.doesNotMatch(html, /<bad response>|data-output-speed-chart|<circle|data-output-speed-values/);
});

test('lifetime retains every day, rare models and extreme measured speeds', () => {
  const days = Array.from({ length: 366 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10);
    return day(date, index === 181 ? { frequent: 5, rare: 1e12 } : { frequent: 5 });
  });
  const html = viewer('lifetime').renderOutputSpeedTrend({ byModel: [{ model: 'frequent' }], days });
  const lines = groups(html);
  assert.deepEqual(lines.map((line) => line.model), ['frequent', 'rare']);
  assert.equal(lines[0].dots.length, 366);
  assert.equal(lines[1].dots.length, 1);
  assert.equal(tooltips(html).length, 366);
  assert.match(tooltips(html)[181], /rare: 1000000000000$/);
  assert.ok(lines[1].dots[0].y < lines[0].dots[181].y);
  assert.ok(lines.every((line) => line.dots.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))));
});

test('model names and dates are escaped in attributes, legends, buttons and day values', () => {
  const model = 'model"><img src=x onerror="alert(1)">&\' </script> 中文';
  const date = '2026-11-03"><svg onload="alert(1)">';
  const view = viewer();
  const html = view.renderOutputSpeedTrend(summary(day(date, { [model]: 7.5 })));
  assert.doesNotMatch(html, /<img|<script|<\/script>|<svg onload=/);
  assert.equal(groups(html)[0].model, view.escapeHtml(model));
  assert.ok(html.includes(`data-output-speed-metric="${view.escapeHtml(model)}"`));
  assert.deepEqual(tooltips(html), [view.escapeHtml(`${view.formatChartDate(date)}\n${model}: 7.5`)]);
  assert.ok(html.includes(`data-output-speed-day="${view.escapeHtml(date)}"`));
  assert.ok(activeValues(html).includes(view.escapeHtml(model)));
});

test('colors stay tied to model names across input order, model additions and period changes', () => {
  const first = groups(viewer().renderOutputSpeedTrend(summary(day('2026-11-03', { beta: 1, alpha: 2 }))));
  const reordered = groups(viewer('lifetime').renderOutputSpeedTrend(summary(day('2026-11-03', { alpha: 2, gamma: 3, beta: 1 }))));
  for (const { model, color } of first) {
    assert.match(color, /^var\(--color-[a-z]+-accent\)$/);
    assert.equal(reordered.find((line) => line.model === model).color, color);
  }
});

test('original chart filters do not change speed lines, tooltips or date selection', () => {
  const view = viewer();
  const data = summary(day('2026-11-03', { alpha: 1, beta: 2 }));
  const initial = view.renderOutputSpeedTrend(data);
  Object.assign(view.state, {
    tokenUsageTrendModel: 'beta', tokenUsageTrendMetric: 'input_tokens', tokenUsageTrendDay: '2026-11-01',
  });
  assert.equal(view.renderOutputSpeedTrend(data), initial);
  view.state.tokenUsagePeriod = 'today';
  assert.equal(view.renderOutputSpeedTrend(data), '');
  view.state.tokenUsagePeriod = '-34day';
  const relative = view.renderOutputSpeedTrend(data);
  assert.deepEqual(groups(relative), groups(initial));
  assert.deepEqual(tooltips(relative), tooltips(initial));
  assert.equal(activeValues(relative), activeValues(initial));
});

test('legends and Metric buttons retain long names and wrap within the panel', () => {
  const names = Array.from({ length: 40 }, (_, index) => `provider-${index}-${'very-long-model-name-'.repeat(8)}`);
  const html = viewer().renderOutputSpeedTrend(summary(day('2026-11-03', Object.fromEntries(names.map((name, index) => [name, index + 1])))));
  assert.equal(groups(html).length, names.length);
  assert.match(html, /flex flex-wrap/);
  assert.match(html, /overflow-wrap:\s*anywhere/);
  for (const name of names) {
    assert.ok(html.includes(`data-output-speed-metric="${name}"`));
    assert.ok(tooltips(html)[0].includes(`${name}: `));
  }
});
