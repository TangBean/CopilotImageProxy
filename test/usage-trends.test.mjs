import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { usageTrendScript } from '../src/usage-trends.mjs';

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

function viewer(period = 'last_7_days', source = usageTrendScript) {
  const context = {
    state: { tokenUsagePeriod: period }, escapeHtml,
    renderError: (message, title) => `<p role="alert">${escapeHtml(title)}: ${escapeHtml(message)}</p>`,
  };
  runInNewContext(source, context);
  return {
    state: context.state,
    render: (summary, error) => context.renderOutputSpeedTrend(summary, error),
  };
}

const day = (date, values) => ({
  date, byModel: Object.entries(values).map(([model, speed]) => ({ model, output_tokens_per_second: speed })),
});
const summary = (...days) => ({ days, byModel: [] });
const groups = (html) => [...html.matchAll(/<g data-output-speed-model="([^"]*)">([\s\S]*?)<\/g>/g)]
  .map(([, model, body]) => ({
    model, path: body.match(/<path d="([^"]*)"/)?.[1],
    color: body.match(/stroke="([^"]*)"/)?.[1],
    dots: [...body.matchAll(/<circle cx="([^"]*)" cy="([^"]*)" r="([^"]*)"/g)]
      .map(([, x, y, radius]) => ({ x: Number(x), y: Number(y), radius: Number(radius) })),
  }));
const tooltips = (html) => [...html.matchAll(/<title>([\s\S]*?)<\/title>/g)].map(([, title]) => title);
const count = (html, marker) => html.split(marker).length - 1;

test('output speed is hidden for Today and shown once for native and relative periods', () => {
  const data = summary(day('2026-11-03', { alpha: 14.5, beta: 22 }));
  const today = viewer('today');
  assert.equal(today.render(data), '');
  assert.equal(today.render(data, 'Daily request failed'), '');
  for (const period of ['this_week', 'last_7_days', 'this_month', 'last_30_days', 'lifetime', '-1day', '-34day']) {
    const html = viewer(period).render(data);
    assert.equal(count(html, 'data-output-speed-panel'), 1, period);
    assert.equal(count(html, 'data-output-speed-chart'), 1, period);
    assert.match(html, /Output speed/);
    assert.match(html, /tokens\/s/);
    assert.doesNotMatch(html, /data-trend-day|data-trend-metric|data-token-usage-trend-model/);
  }
});

test('speed series come from all daily models and never from the aggregate totals', () => {
  const data = {
    byModel: [{ model: 'alpha', output_tokens_per_second: 999999 }],
    totals: { output_tokens_per_second: 123456789 },
    days: [
      { ...day('2026-11-02', { alpha: 12 }), totals: { output_tokens_per_second: 1000000 } },
      { ...day('2026-11-03', { alpha: 18, 'day-only-model': 3 }), totals: { output_tokens_per_second: 2000000 } },
    ],
  };
  const view = viewer();
  const html = view.render(data);
  assert.deepEqual(groups(html).map((group) => group.model), ['alpha', 'day-only-model']);
  assert.doesNotMatch(html, /data-output-speed-model="All"|>All<|123456789|999999|2000000/);
  assert.deepEqual(tooltips(html), [
    '2026-11-02\nalpha: 12 tokens/s\nday-only-model: — tokens/s',
    '2026-11-03\nalpha: 18 tokens/s\nday-only-model: 3 tokens/s',
  ]);
  data.totals.output_tokens_per_second = 0;
  data.days.forEach((value) => { value.totals.output_tokens_per_second = 0; });
  assert.equal(view.render(data), html, 'Aggregate changes must not affect model speed lines or scales');
});

test('null and missing speeds break lines while actual zero remains a measured point', () => {
  const values = [2, null, 3, undefined, 0, NaN, Infinity, -Infinity, 4, 5];
  const html = viewer().render(summary(...values.map((speed, index) =>
    day(`2026-11-${String(index + 1).padStart(2, '0')}`, { alpha: speed }))));
  const [line] = groups(html);
  assert.equal(line.dots.length, 5);
  assert.equal(count(line.path, 'M'), 4, 'Each segment after unavailable data starts a new path');
  assert.equal(count(line.path, 'L'), 1, 'Only the last two adjacent measurements are connected');
  assert.ok(line.dots.every(({ x, y, radius }) => Number.isFinite(x) && Number.isFinite(y) && radius > 0));
  const titles = tooltips(html);
  for (const index of [1, 3, 5, 6, 7]) assert.match(titles[index], /alpha: — tokens\/s$/);
  assert.match(titles[4], /alpha: 0 tokens\/s$/);
  assert.equal(line.dots[2].y, Math.max(...line.dots.map(({ y }) => y)), 'Zero stays on the baseline');
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test('single speed measurements have visible centered dots, including zero', () => {
  for (const speed of [0, 0.000000001, 12.75]) {
    const html = viewer('-1day').render(summary(day('2026-11-03', { alpha: speed })));
    const [line] = groups(html);
    assert.equal(line.dots.length, 1);
    assert.ok(line.dots[0].radius > 0);
    assert.equal(count(line.path, 'M'), 1);
    assert.equal(count(line.path, 'L'), 0);
    const gridLine = html.match(/<line x1="([^"]*)" x2="([^"]*)"/);
    assert.equal(line.dots[0].x, (Number(gridLine[1]) + Number(gridLine[2])) / 2);
    assert.match(html, /<text[^>]*>0<\/text>/, 'The y axis starts at zero');
    if (speed !== 0) assert.doesNotMatch(tooltips(html)[0], /alpha: 0 tokens\/s/);
  }
});

test('empty data and unavailable speeds stay visibly unavailable instead of becoming zero', () => {
  for (const data of [undefined, summary(), summary(day('2026-11-03', {}))]) {
    const html = viewer().render(data);
    assert.equal(count(html, 'data-output-speed-panel'), 1);
    assert.match(html, /— No daily model data/);
    assert.equal(groups(html).length, 0);
    assert.doesNotMatch(html, /<circle/);
  }
  const html = viewer().render(summary(day('2026-11-03', { alpha: null })));
  const [line] = groups(html);
  assert.equal(line.path.trim(), '');
  assert.equal(line.dots.length, 0);
  assert.deepEqual(tooltips(html), ['2026-11-03\nalpha: — tokens/s']);
});

test('non-UTF-8 pages preserve speed missing-value and caption characters after script decoding', () => {
  const source = new TextDecoder('windows-1252').decode(Buffer.from(usageTrendScript, 'utf8'));
  const view = viewer('last_7_days', source);
  const html = view.render(summary(day('2026-11-03', { alpha: null })));
  assert.deepEqual(tooltips(html), ['2026-11-03\nalpha: — tokens/s']);
  assert.match(html, /tokens\/s · per model · daily/);
  assert.match(view.render(summary()), /— No daily model data/);
});

test('a daily fetch error is shown inside the speed panel without stale points', () => {
  const html = viewer().render(summary(day('2026-11-03', { alpha: 123 })), '<bad response>');
  assert.equal(count(html, 'data-output-speed-panel'), 1);
  assert.match(html, /role="alert"/);
  assert.match(html, /Output speed failed: &lt;bad response&gt;/);
  assert.doesNotMatch(html, /<bad response>|data-output-speed-chart|<circle/);
});

test('lifetime retains every day, rare models and extreme measured speeds', () => {
  const days = Array.from({ length: 366 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10);
    return day(date, index === 181 ? { frequent: 5, rare: 1e12 } : { frequent: 5 });
  });
  const html = viewer('lifetime').render({ byModel: [{ model: 'frequent' }], days });
  const lines = groups(html);
  assert.deepEqual(lines.map((line) => line.model), ['frequent', 'rare']);
  assert.equal(lines[0].dots.length, 366);
  assert.equal(lines[1].dots.length, 1);
  assert.equal(count(html, 'data-output-speed-day='), 366);
  assert.equal(tooltips(html).length, 366);
  assert.match(tooltips(html)[181], /rare: 1000000000000 tokens\/s/);
  assert.ok(lines[1].dots[0].y < lines[0].dots[181].y, 'The outlier must determine the scale');
  assert.ok(lines.every((line) => line.dots.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))));
});

test('model names and dates are escaped in attributes, legends and day tooltips', () => {
  const model = 'model"><img src=x onerror="alert(1)">&\' </script> 中文';
  const date = '2026-11-03"><svg onload="alert(1)">';
  const html = viewer().render(summary(day(date, { [model]: 7.5 })));
  assert.doesNotMatch(html, /<img|<script|<\/script>|<svg onload=/);
  assert.equal(groups(html)[0].model, escapeHtml(model));
  assert.ok(html.includes(`<span style="overflow-wrap:anywhere">${escapeHtml(model)}</span>`));
  assert.deepEqual(tooltips(html), [escapeHtml(`${date}\n${model}: 7.5 tokens/s`)]);
  assert.ok(html.includes(`data-output-speed-day="${escapeHtml(date)}"`));
});

test('colors stay tied to model names across input order, model additions and period changes', () => {
  const data = summary(day('2026-11-03', { beta: 1, alpha: 2 }));
  const first = groups(viewer().render(data));
  const reordered = groups(viewer('lifetime').render(summary(day('2026-11-03', { alpha: 2, gamma: 3, beta: 1 }))));
  for (const { model, color } of first) {
    assert.match(color, /^var\(--color-[a-z]+-accent\)$/);
    assert.equal(reordered.find((line) => line.model === model).color, color);
  }
});

test('original chart filters do not change speed lines, legends, tooltips or scale', () => {
  const view = viewer();
  const data = summary(day('2026-11-03', { alpha: 1, beta: 2 }));
  const initial = view.render(data);
  Object.assign(view.state, {
    tokenUsageTrendModel: 'beta', tokenUsageTrendMetric: 'input_tokens', tokenUsageTrendDay: '2026-11-01',
  });
  assert.equal(view.render(data), initial);
  view.state.tokenUsagePeriod = 'today';
  assert.equal(view.render(data), '');
  view.state.tokenUsagePeriod = '-34day';
  assert.equal(view.render(data), initial);
});

test('legends retain every long model name and wrap within the panel', () => {
  const names = Array.from({ length: 40 }, (_, index) => `provider-${index}-${'very-long-model-name-'.repeat(8)}`);
  const html = viewer().render(summary(day('2026-11-03', Object.fromEntries(names.map((name, index) => [name, index + 1])))));
  assert.equal(groups(html).length, names.length);
  assert.match(html, /data-output-speed-legend style="[^"]*flex-wrap:wrap/);
  assert.match(html, /overflow-wrap:anywhere/);
  for (const name of names) {
    assert.ok(html.includes(`<span style="overflow-wrap:anywhere">${name}</span>`));
    assert.ok(tooltips(html)[0].includes(`${name}: `));
  }
});
