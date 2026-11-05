import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { parseRelativeDayPeriod, UsageRangeError } from '../src/usage-range.mjs';
import { rewriteUsageViewer, UsageViewerError } from '../src/usage-viewer.mjs';

const original = readFileSync(new URL('./fixtures/usage-viewer.upstream.html', import.meta.url));
// Synthetic measurements in the daily response shape of copilot-api v2.7.43.
const dailyFixture = JSON.parse(readFileSync(new URL('./fixtures/usage-daily.json', import.meta.url)));
const viewerConfig = { host: '127.0.0.1', port: 43000 };
const html = rewriteUsageViewer(original, viewerConfig).toString();
const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));

function page() {
  const cells = [];
  const body = {};
  let callback;
  let pending = [];
  let writes = 0;
  const notify = (record) => { if (callback) pending.push(record); };
  const addCell = (text) => {
    let node;
    const cell = {
      get firstChild() { return node; },
      get textContent() { return node.data; },
      set textContent(value) { node = { data: value, parentElement: cell }; writes++; notify({ type: 'childList', target: cell }); },
      set innerHTML(_) { assert.fail('Titles must be written as text'); },
      closest(selector) { assert.equal(selector, 'td'); return cell; },
    };
    node = { data: text, parentElement: cell };
    cells.push(cell);
    notify({ type: 'childList', target: body });
    return cell;
  };
  return {
    addCell,
    changeTextNode(cell, value) {
      cell.firstChild.data = value;
      notify({ type: 'characterData', target: cell.firstChild });
    },
    get writes() { return writes; },
    get observing() { return Boolean(callback); },
    flush() {
      for (let count = 0; pending.length && count < 10; count++) {
        const records = pending;
        pending = [];
        callback(records);
      }
      assert.equal(pending.length, 0, 'MutationObserver must stop writing after titles are applied');
    },
    async run(fetch) {
      await runInNewContext(script, {
        fetch,
        document: { body, querySelectorAll: (selector) => {
          assert.equal(selector, 'td');
          return cells;
        } },
        MutationObserver: class {
          constructor(update) { callback = update; }
          observe(target, options) {
            assert.equal(target, body);
            assert.equal(options.childList, true);
            assert.equal(options.characterData, true);
            assert.equal(options.subtree, true);
            assert.ok(!options.attributes);
          }
        },
      });
    },
  };
}

test('usage viewer labels existing, added and reused cells safely without observer loops', async () => {
  const view = page();
  const first = view.addCell('  thread-a  ');
  const unknown = view.addCell('subagent-thread');
  const partial = view.addCell('prefix-thread-a');
  const htmlTitle = '</script><img src=x onerror=alert(1)> 中文';
  await view.run(async (url) => {
    assert.equal(url, '/__session-titles');
    return { ok: true, json: async () => ({ 'thread-a': htmlTitle, 'thread-b': '第二个标题' }) };
  });
  assert.equal(first.textContent, htmlTitle);
  assert.equal(first.title, 'thread-a');
  assert.equal(unknown.textContent, 'subagent-thread');
  assert.equal(partial.textContent, 'prefix-thread-a');
  assert.ok(!html.includes(htmlTitle));
  assert.equal(view.observing, true);

  const added = view.addCell('thread-b');
  view.flush();
  assert.equal(added.textContent, '第二个标题');
  assert.equal(added.title, 'thread-b');
  const writes = view.writes;
  view.flush();
  assert.equal(view.writes, writes);

  first.textContent = 'thread-b';
  view.flush();
  assert.equal(first.textContent, '第二个标题');
  assert.equal(first.title, 'thread-b');
});

test('a title equal to another known id stays a title after subsequent mutations', async () => {
  const view = page();
  const cell = view.addCell('thread-a');
  await view.run(async () => ({ ok: true, json: async () => ({ 'thread-a': ' thread-b ', 'thread-b': 'other title' }) }));
  view.addCell('unrelated');
  view.flush();
  assert.equal(cell.textContent, ' thread-b ');
  assert.equal(cell.title, 'thread-a');
});

test('a colliding title does not hide a new id when the cell is reused', async () => {
  for (const mode of ['replace-node', 'character-data', 'character-data-and-tooltip']) {
    const view = page();
    const cell = view.addCell('thread-a');
    await view.run(async () => ({ ok: true, json: async () => ({ 'thread-a': 'thread-b', 'thread-b': 'Title for B' }) }));
    assert.equal(cell.textContent, 'thread-b');
    if (mode === 'replace-node') cell.textContent = 'thread-b';
    else {
      view.changeTextNode(cell, 'thread-b');
      if (mode === 'character-data-and-tooltip') cell.title = 'thread-b';
    }
    view.flush();
    assert.equal(cell.textContent, 'Title for B');
    assert.equal(cell.title, 'thread-b');
  }
});

test('unavailable or unreadable title responses leave the dashboard usable', async () => {
  for (const fetch of [
    async () => { throw new Error('offline'); },
    async () => ({ ok: false, json: () => assert.fail('Do not decode an error response') }),
    async () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } }),
  ]) {
    const view = page();
    const cell = view.addCell('thread-a');
    await view.run(fetch);
    view.flush();
    assert.equal(cell.textContent, 'thread-a');
    assert.equal(view.writes, 0);
  }
});

const tokenUsagePaths = ['/token-usage', '/token-usage/daily', '/token-usage/events', '/token-usage/sessions'];

async function dashboardPage(path, source = html, initialDaily = null) {
  const requests = [];
  const history = { pushed: [], replaced: [] };
  const elements = new Map();
  class Element {
    constructor(id = '', attributes = {}) {
      Object.assign(this, { id, value: '', innerHTML: '', style: {}, dataset: {}, attributes,
        classList: { toggle() {} }, listeners: new Map() });
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    matches(selector) { return Object.hasOwn(this.attributes, selector.slice(1, -1)); }
    closest(selector) { return this.matches(selector) ? this : null; }
    addEventListener(type, handler) {
      this.listeners.set(type, [...this.listeners.get(type) || [], handler]);
    }
    dispatch(type, event = {}) {
      for (const handler of this.listeners.get(type) || []) handler(event);
    }
  }
  class HTMLSelectElement extends Element {}
  const element = (id) => {
    const node = id === 'token-usage-period' ? new HTMLSelectElement(id) : new Element(id);
    elements.set(id, node);
    return node;
  };
  for (const id of ['endpoint-form', 'endpoint-url', 'x-api-key', 'token-usage-period', 'content-area',
    'page-tabs', 'usage-tab', 'subscriptions-tab', 'models-tab', 'token-usage-period-field', 'fetch-button']) element(id);
  elements.get('fetch-button').querySelector = () => ({ textContent: '' });
  for (const tab of ['usage', 'subscriptions', 'models']) elements.get(`${tab}-tab`).dataset.tab = tab;

  const select = elements.get('token-usage-period');
  const selectHtml = source.match(/<select\s+id="token-usage-period"[\s\S]*?<\/select>/)?.[0];
  assert.ok(selectHtml, 'Fixture must retain the real upstream period select');
  select.options = [...selectHtml.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)]
    .map(([, value, textContent]) => ({ value, textContent }));
  let selected = select.options[0].value;
  Object.defineProperty(select, 'value', {
    get: () => selected,
    set(value) { selected = select.options.some((option) => option.value === value) ? value : ''; },
  });
  select.add = (option) => select.options.push(option);

  const storage = new Map();
  const window = {
    location: new URL(path, 'http://127.0.0.1:43000/usage-viewer'),
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    history: {
      replaceState(_data, _title, url) {
        window.location = new URL(url, window.location);
        history.replaced.push(window.location.href);
      },
      pushState(_data, _title, url) {
        window.location = new URL(url, window.location);
        history.pushed.push(window.location.href);
      },
    },
  };
  const range = { start_ms: 1793635200000, end_ms: 1793721600000, display_label: 'server-resolved date' };
  let daily = initialDaily;
  const emptyTotals = { costs: [], input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0, request_count: 0, total_nano_aiu: null, total_tokens: 0 };
  let ready;
  const sandbox = {
    URL, URLSearchParams, window, Element, HTMLSelectElement,
    document: {
      addEventListener(type, callback) {
        assert.equal(type, 'DOMContentLoaded');
        ready = callback;
      },
      getElementById(id) {
        assert.ok(elements.has(id), `Unexpected DOM lookup: ${id}`);
        return elements.get(id);
      },
      createElement(tag) {
        assert.equal(tag, 'option');
        return { value: '', textContent: '' };
      },
    },
    fetch: async (input) => {
      const url = new URL(input, window.location);
      requests.push(url);
      assert.ok(['/usage', '/models', ...tokenUsagePaths].includes(url.pathname), url.href);
      const empty = {
        range, totals: emptyTotals, byModel: [], days: [], items: [],
        page: Number(url.searchParams.get('page') || 1), total: 0, total_pages: 1,
      };
      const payload = url.pathname === '/usage' ? { quota_snapshots: {} } : url.pathname === '/models' ? { data: [] }
        : url.pathname === '/token-usage/daily' && daily ? daily : empty;
      return { ok: true, json: async () => payload };
    },
    console: { warn() {}, error() {} },
  };
  const upstreamScript = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(upstreamScript?.includes('        init();'), 'Fixture must execute the real upstream init');
  const instrumented = upstreamScript.replace('        init();', `
        globalThis.viewer = {
          state, normalizePeriod, getSelectedPeriod, syncUrlState, resolveUsageUrl, deriveEndpointUrl,
          buildTokenUsageSummaryUrl, buildTokenUsageDailyUrl, buildTokenUsageEventsUrl,
          fetchTokenUsageEventsPage, fetchTokenUsageSessionsPage,
          renderTokenUsageRangeText, renderError, escapeHtml, getCostAmount, render,
        };
        init();`);
  runInNewContext(instrumented, sandbox);
  ready();
  const settle = () => new Promise(setImmediate);
  await settle();
  return {
    requests, history, select, viewer: sandbox.viewer,
    get state() { return sandbox.viewer.state; },
    get url() { return window.location; },
    get rendered() { return elements.get('content-area').innerHTML; },
    get periodHidden() { return elements.get('token-usage-period-field').hidden; },
    setDaily(data) { daily = structuredClone(data); },
    changeTrendModel(model) {
      const target = new HTMLSelectElement('', { 'data-token-usage-trend-model': '' });
      target.value = model;
      elements.get('content-area').dispatch('change', { target });
    },
    clickTrendMetric(metric) {
      const target = new Element('', { 'data-trend-metric': metric });
      elements.get('content-area').dispatch('click', { target });
    },
    clickNewChartDay(date, chart = 'output-speed') {
      const target = new Element('', { [`data-${chart}-day`]: date });
      elements.get('content-area').dispatch('click', { target });
    },
    async selectTab(tab) {
      elements.get('page-tabs').dispatch('click', { target: { closest(selector) {
        assert.equal(selector, '[data-tab]');
        return elements.get(`${tab}-tab`);
      } } });
      await settle();
      assert.equal(elements.get(`${tab}-tab`).attributes['aria-selected'], 'true');
    },
    async selectPeriod(period) {
      select.value = period;
      select.dispatch('change');
      await settle();
    },
    setEndpoint(endpoint) {
      elements.get('endpoint-url').value = endpoint;
      elements.get('endpoint-url').dispatch('change');
    },
    async submit() {
      elements.get('endpoint-form').dispatch('submit', { preventDefault() {} });
      await settle();
    },
  };
}

function assertTokenUsageRequests(requests, period, paths = tokenUsagePaths) {
  const tokenRequests = requests.filter((url) => tokenUsagePaths.includes(url.pathname));
  assert.deepEqual(tokenRequests.map((url) => url.pathname).sort(), [...paths].sort());
  for (const url of tokenRequests) {
    assert.equal(url.searchParams.get('period'), period, url.href);
    const paginated = url.pathname.endsWith('/events') || url.pathname.endsWith('/sessions');
    assert.deepEqual([...url.searchParams.keys()].sort(), paginated ? ['page', 'page_size', 'period'] : ['period']);
  }
  for (const url of requests) {
    assert.equal(url.searchParams.has('from'), false, url.href);
    assert.equal(url.searchParams.has('to'), false, url.href);
  }
}

test('pinned upstream page reproduces fallback to Today before rewriting', async () => {
  const view = await dashboardPage('?period=-1%20Day&endpoint=%2Fusage', original.toString());
  assert.equal(view.state.tokenUsagePeriod, 'today');
  assert.equal(view.select.value, 'today');
  assertTokenUsageRequests(view.requests, 'today');
});

test('arbitrary relative days and accepted spellings survive upstream initialization and fetch builders', async () => {
  for (const day of [1, 2, 10, 11, 34, 365, 20000]) {
    for (const suffix of ['d', 'D', ' d', '_D', 'day', ' Day', '_DAY']) {
      const period = `-${day}${suffix}`;
      const canonical = `-${day}day`;
      assert.equal(parseRelativeDayPeriod(period), canonical, period);
      const view = await dashboardPage(`?period=${encodeURIComponent(period)}&endpoint=%2Fusage`);
      assert.equal(view.state.tokenUsagePeriod, canonical, period);
      assert.equal(view.select.value, canonical, period);
      assert.equal(view.url.searchParams.get('period'), canonical, period);
      assert.equal(view.select.options.filter((option) => option.value === canonical).length, 1);
      assert.equal(view.select.options.find((option) => option.value === canonical).textContent, `-${day} Day`);
      assertTokenUsageRequests(view.requests, canonical);
    }
  }
});

test('plus decoding, select changes, form refresh, tabs, pagination and reload retain an arbitrary relative period', async () => {
  const view = await dashboardPage('?period=-34+D&endpoint=%2Fusage&other=keep#fragment');
  assert.equal(view.url.searchParams.get('period'), '-34day');
  assert.equal(view.history.replaced.length, 1);
  assert.equal(view.history.pushed.length, 0);

  view.requests.length = 0;
  await view.selectPeriod('this_week');
  assert.equal(view.state.tokenUsagePeriod, 'this_week');
  assert.equal(view.url.searchParams.get('period'), 'this_week');
  assertTokenUsageRequests(view.requests, 'this_week');
  assert.equal(view.requests.some((url) => url.pathname === '/usage'), false);

  view.requests.length = 0;
  await view.selectPeriod('-34day');
  assert.equal(view.select.value, '-34day');
  assertTokenUsageRequests(view.requests, '-34day');
  assert.equal(view.url.searchParams.get('period'), '-34day');
  assert.equal(view.url.searchParams.get('other'), 'keep');
  assert.equal(view.url.hash, '#fragment');
  assert.equal(view.history.pushed.length, 2);

  view.requests.length = 0;
  await view.submit();
  assertTokenUsageRequests(view.requests, '-34day');
  assert.equal(view.requests.filter((url) => url.pathname === '/usage').length, 0,
    'v2.7.43 loads account allowances separately in the Subscriptions tab');

  view.requests.length = 0;
  await view.selectTab('models');
  assert.equal(view.state.activeTab, 'models');
  assert.equal(view.periodHidden, true);
  assert.deepEqual(view.requests.map((url) => url.pathname), ['/models']);
  assert.equal(view.state.tokenUsagePeriod, '-34day');
  assert.equal(view.select.value, '-34day');
  assert.equal(view.url.searchParams.get('period'), '-34day');
  view.requests.length = 0;
  await view.submit();
  assert.deepEqual(view.requests.map((url) => url.pathname), ['/models']);
  assert.equal(view.url.searchParams.get('period'), '-34day');
  await view.selectTab('usage');
  assert.equal(view.state.activeTab, 'usage');
  assert.equal(view.periodHidden, false);
  assert.equal(view.state.tokenUsagePeriod, '-34day');
  assert.equal(view.select.value, '-34day');
  assert.equal(view.url.searchParams.get('period'), '-34day');
  assert.match(view.rendered, /server-resolved date/);

  view.requests.length = 0;
  await view.viewer.fetchTokenUsageEventsPage(2);
  await view.viewer.fetchTokenUsageSessionsPage(2);
  assertTokenUsageRequests(view.requests, '-34day', ['/token-usage/events', '/token-usage/sessions']);
  assert.deepEqual(view.requests.map((url) => url.searchParams.get('page')), ['2', '2']);

  const reloaded = await dashboardPage(view.url.href);
  assert.equal(reloaded.state.tokenUsagePeriod, '-34day');
  assert.equal(reloaded.select.value, '-34day');
  assertTokenUsageRequests(reloaded.requests, '-34day');
});

test('relative URLs without an endpoint retain the selected option until the user refreshes', async () => {
  const view = await dashboardPage('?period=-10_Day');
  assert.equal(view.state.tokenUsagePeriod, '-10day');
  assert.equal(view.select.value, '-10day');
  assert.equal(view.url.searchParams.get('period'), '-10day');
  assert.equal(view.requests.length, 0);
  await view.submit();
  assertTokenUsageRequests(view.requests, '-10day');
  assert.equal(view.requests.find((url) => url.pathname === '/token-usage').origin, 'http://127.0.0.1:43000');
});

test('built-in periods and legacy aliases keep their upstream selection and request behavior', async () => {
  for (const [period, canonical] of [
    ['today', 'today'], ['this_week', 'this_week'], ['last_7_days', 'last_7_days'],
    ['this_month', 'this_month'], ['last_30_days', 'last_30_days'], ['lifetime', 'lifetime'],
    ['day', 'today'], ['week', 'last_7_days'], ['month', 'last_30_days'],
  ]) {
    const view = await dashboardPage(`?period=${period}&endpoint=%2Fusage`);
    assert.equal(view.state.tokenUsagePeriod, canonical, period);
    assert.equal(view.select.value, canonical, period);
    assertTokenUsageRequests(view.requests, canonical);
  }
});

test('invalid relative selectors and duplicate periods show an error without fetching Today', async () => {
  for (const period of ['-0d', '-0day', '-01d', '-01day', '-1days', '-1  day', '-1__day', '-1-day',
    ' -1day', '-1day ', '-1day\n', '-1\tday', '-1day\0', '-1', '-1.5d', '-1.0day', '-xd',
    '-1e2d', '-1dextra', '-9007199254740992d', `-${'9'.repeat(400)}day`]) {
    assert.throws(() => parseRelativeDayPeriod(period), (error) =>
      error instanceof UsageRangeError && error.status === 400, JSON.stringify(period));
    const view = await dashboardPage(`?period=${encodeURIComponent(period)}&endpoint=%2Fusage`);
    assert.equal(view.requests.length, 0, JSON.stringify(period));
    assert.match(view.state.error, /Relative-day period must be -Nd or -Nday/);
    assert.match(view.rendered, /role="alert"/);
    assert.match(view.rendered, /Relative-day period must be -Nd or -Nday/);
  }
  const duplicate = await dashboardPage('?period=-1Day&period=today&endpoint=%2Fusage');
  assert.equal(duplicate.requests.length, 0);
  assert.match(duplicate.rendered, /period must be specified once/);
});

test('prototype-like period names retain the upstream Today fallback without interrupting initialization', async () => {
  for (const period of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    for (const source of [original.toString(), html]) {
      const view = await dashboardPage(`?period=${period}&endpoint=%2Fusage`, source);
      assert.equal(view.state.tokenUsagePeriod, 'today', period);
      assert.equal(view.select.value, 'today', period);
      assertTokenUsageRequests(view.requests, 'today');
    }
  }
});

test('explicit dates in page and nested endpoint URLs are rejected visibly before fetching', async () => {
  for (const dates of ['from=', 'to=2026-11-03', 'from=2026-11-03&to=2026-11-04', '%66rom=2026-11-03']) {
    for (const query of [
      `period=-1day&endpoint=%2Fusage&${dates}`,
      `period=-1day&endpoint=${encodeURIComponent(`/usage?${dates}`)}`,
    ]) {
      const view = await dashboardPage(`?${query}`);
      assert.equal(view.requests.length, 0, query);
      assert.match(view.rendered, /role="alert"/);
      assert.match(view.rendered, /from and to are not supported/);
    }
  }
  const edited = await dashboardPage('?period=-1day');
  edited.setEndpoint('/usage?to=2026-11-03');
  await edited.submit();
  assert.equal(edited.requests.length, 0);
  assert.match(edited.rendered, /from and to are not supported/);
  assert.throws(() => edited.viewer.deriveEndpointUrl('/usage?from=', 'token-usage'), /from and to are not supported/);
});

test('range text uses the server display label and never labels a pending relative range Today', async () => {
  const view = await dashboardPage('?period=-34d');
  const { renderTokenUsageRangeText } = view.viewer;
  assert.equal(renderTokenUsageRangeText('-34day', { start_ms: 0, end_ms: 1, display_label: '2026-10-01 (-34 Day)' }),
    '2026-10-01 (-34 Day)');
  assert.equal(renderTokenUsageRangeText('-34day', null), '-34day');
  assert.equal(renderTokenUsageRangeText('this_week', null), 'This week');
});

function outputSpeedPanel(rendered) {
  return rendered.match(/<section class="panel mt-3" data-output-speed-panel>[\s\S]*?<\/section>/)?.[0] ?? '';
}

function costPanel(rendered) {
  return rendered.match(/<section class="panel mt-3" data-cost-panel>[\s\S]*?<\/section>/)?.[0] ?? '';
}

function assertTrendPanelOrder(rendered) {
  assert.equal((rendered.match(/data-output-speed-panel/g) || []).length, 1);
  assert.equal((rendered.match(/data-output-speed-chart/g) || []).length, 1);
  assert.equal((rendered.match(/data-cost-panel/g) || []).length, 1);
  assert.equal((rendered.match(/data-cost-chart/g) || []).length, 1);
  const originalIndex = rendered.indexOf('Token Usage Over Time');
  const speedIndex = rendered.indexOf('data-output-speed-panel');
  const costIndex = rendered.indexOf('data-cost-panel');
  const breakdownIndex = rendered.indexOf('Model Breakdown');
  assert.ok(originalIndex >= 0 && speedIndex > originalIndex && costIndex > speedIndex && costIndex < breakdownIndex);
  for (const panel of [outputSpeedPanel(rendered), costPanel(rendered)]) {
    assert.doesNotMatch(panel, /data-trend-day|data-trend-metric|data-token-usage-trend-model/);
  }
}

test('real v2.7.43 render flow places independent speed and cost panels after the original for native and relative periods', async () => {
  for (const period of ['this_week', 'last_7_days', 'this_month', 'last_30_days', 'lifetime', '-1d', '-34day']) {
    const view = await dashboardPage(`?period=${period}&endpoint=%2Fusage`, html, dailyFixture);
    assertTrendPanelOrder(view.rendered);
    const panel = outputSpeedPanel(view.rendered);
    assert.match(panel, /data-output-speed-model="model-alpha"/);
    assert.match(panel, /data-output-speed-model="model-beta"/);
    assert.doesNotMatch(panel, /data-output-speed-model="(?:All|__all__)"/);
    assert.match(panel, /model-alpha: — tokens\/s/);
    assert.match(panel, /model-beta: 0 tokens\/s/);
    assert.match(panel, /model-beta: 1000000 tokens\/s/);
    const cost = costPanel(view.rendered);
    assert.match(cost, /Cost \(USD\)/);
    assert.match(cost, /data-cost-model="model-alpha"/);
    assert.match(cost, /data-cost-model="model-beta"/);
    assert.doesNotMatch(cost, /data-cost-model="(?:All|__all__)"/);
    assert.match(cost, /model-alpha: 0\.000000001 USD/);
    assert.match(cost, /model-alpha: — USD/);
    assert.match(cost, /model-beta: 0 USD/);
    assert.match(cost, /model-beta: — USD/, 'An EUR-only day cannot be interpreted as USD');
    assert.match(cost, /model-beta: 0\.00004 USD/);
    assert.doesNotMatch(cost, /EUR/);
  }
  const today = await dashboardPage('?period=today&endpoint=%2Fusage', html, dailyFixture);
  assert.doesNotMatch(today.rendered, /Token Usage Over Time|data-output-speed-panel|data-cost-panel/);
});

test('actual upstream model and metric handlers re-render without filtering either new panel', async () => {
  const view = await dashboardPage('?period=last_7_days&endpoint=%2Fusage', html, dailyFixture);
  const firstRender = view.rendered;
  const panel = outputSpeedPanel(firstRender);
  const cost = costPanel(firstRender);
  view.requests.length = 0;
  view.changeTrendModel('model-beta');
  assert.equal(view.state.tokenUsageTrendModel, 'model-beta');
  assert.notEqual(view.rendered, firstRender, 'Original model selector must actually render');
  assert.equal(outputSpeedPanel(view.rendered), panel);
  assert.equal(costPanel(view.rendered), cost);
  assertTrendPanelOrder(view.rendered);
  const modelRender = view.rendered;
  view.clickTrendMetric('input_tokens');
  assert.equal(view.state.tokenUsageTrendMetric, 'input_tokens');
  assert.notEqual(view.rendered, modelRender, 'Original metric buttons must actually render');
  assert.equal(outputSpeedPanel(view.rendered), panel);
  assert.equal(costPanel(view.rendered), cost);
  assertTrendPanelOrder(view.rendered);
  const selectedDay = view.state.tokenUsageTrendDay;
  for (const chart of ['output-speed', 'cost']) {
    view.clickNewChartDay('2026-11-01', chart);
    assert.equal(view.state.tokenUsageTrendDay, selectedDay, `${chart} hover areas cannot invoke the original day selection`);
  }
  assert.equal(view.requests.length, 0, 'Chart filters do not fetch or alter the shared period');
});

test('refresh replaces speed and cost measurements and period changes remove and restore both panels', async () => {
  const view = await dashboardPage('?period=-34day&endpoint=%2Fusage', html, dailyFixture);
  const initialPanel = outputSpeedPanel(view.rendered);
  const initialCost = costPanel(view.rendered);
  const changed = structuredClone(dailyFixture);
  changed.days[0].byModel[0].output_tokens_per_second = 9876.5;
  changed.days[0].byModel[0].costs[0] = { currency: 'USD', amount: 0.123456, total_cost_nanos: 123456000 };
  view.setDaily(changed);
  view.requests.length = 0;
  await view.submit();
  assertTokenUsageRequests(view.requests, '-34day');
  assertTrendPanelOrder(view.rendered);
  assert.notEqual(outputSpeedPanel(view.rendered), initialPanel);
  assert.notEqual(costPanel(view.rendered), initialCost);
  assert.match(outputSpeedPanel(view.rendered), /model-alpha: 9876.5 tokens\/s/);
  assert.match(costPanel(view.rendered), /model-alpha: 0\.123456 USD/);
  await view.selectPeriod('today');
  assert.doesNotMatch(view.rendered, /data-output-speed-panel|data-cost-panel/);
  await view.selectPeriod('lifetime');
  assertTrendPanelOrder(view.rendered);
  assert.match(outputSpeedPanel(view.rendered), /model-alpha: 9876.5 tokens\/s/);
  assert.match(costPanel(view.rendered), /model-alpha: 0\.123456 USD/);
  await view.selectPeriod('-34day');
  assertTrendPanelOrder(view.rendered);
});

test('real page renders empty, single-day and null daily data without losing its other sections', async () => {
  for (const daily of [
    { ...dailyFixture, days: [], byModel: [] },
    { ...dailyFixture, days: [dailyFixture.days[0]] },
    { ...dailyFixture, days: [{ ...dailyFixture.days[1], byModel: [dailyFixture.days[1].byModel[0]] }] },
  ]) {
    const view = await dashboardPage('?period=-1day&endpoint=%2Fusage', html, daily);
    assert.equal((view.rendered.match(/data-output-speed-panel/g) || []).length, 1);
    assert.equal((view.rendered.match(/data-cost-panel/g) || []).length, 1);
    for (const heading of ['Model Breakdown', 'Session Breakdown', 'Request Events']) {
      assert.ok(view.rendered.includes(heading), `${heading} must still render`);
    }
    const panel = outputSpeedPanel(view.rendered);
    const cost = costPanel(view.rendered);
    if (!daily.days.length) {
      assert.match(panel, /— No daily model data/);
      assert.match(cost, /— No daily model data/);
    }
    else if (daily.days[0].byModel[0].output_tokens_per_second === null) {
      assert.match(panel, /model-alpha: — tokens\/s/);
      assert.doesNotMatch(panel, /<circle/);
      assert.match(cost, /model-alpha: — USD/);
      assert.doesNotMatch(cost, /<circle/);
    } else {
      assert.match(panel, /<circle/);
      assert.match(cost, /<circle/);
    }
  }
});

test('each model keeps the same color in speed and cost charts across re-renders', async () => {
  const view = await dashboardPage('?period=last_7_days&endpoint=%2Fusage', html, dailyFixture);
  const colors = (panel, chart) => new Map([...panel.matchAll(new RegExp(`<g data-${chart}-model="([^"]*)"><path[^>]*stroke="([^"]*)"`, 'g'))]
    .map(([, model, color]) => [model, color]));
  const speed = colors(outputSpeedPanel(view.rendered), 'output-speed');
  assert.equal(speed.size, 2);
  assert.deepEqual(colors(costPanel(view.rendered), 'cost'), speed);
  view.changeTrendModel('model-alpha');
  view.clickTrendMetric('output_tokens');
  assert.deepEqual(colors(outputSpeedPanel(view.rendered), 'output-speed'), speed);
  assert.deepEqual(colors(costPanel(view.rendered), 'cost'), speed);
  await view.selectPeriod('lifetime');
  assert.deepEqual(colors(costPanel(view.rendered), 'cost'), speed);
});

const originalText = original.toString();
function upstreamFunction(name) {
  const start = originalText.indexOf(`function ${name}(`);
  return originalText.slice(start, originalText.indexOf('\n        }', start) + '\n        }'.length);
}

const selectStart = originalText.indexOf('<select');
const bindingStart = originalText.indexOf('const tokenUsagePeriodSelect =');
const initStart = originalText.indexOf('const periodFromUrl =');
const initEnd = 'const initialEndpoint = endpointFromUrl || DEFAULT_ENDPOINT;';
const requiredMarkers = [
  ['default endpoint', 'const DEFAULT_ENDPOINT = "http://localhost:4141/usage";'],
  ['period select', originalText.slice(selectStart, originalText.indexOf('>', selectStart) + 1)],
  ['period select binding', originalText.slice(bindingStart, originalText.indexOf(');', bindingStart) + 2)],
  ['period normalization', upstreamFunction('normalizePeriod')],
  ['usage endpoint validation', upstreamFunction('resolveUsageUrl')],
  ['derived endpoint validation', upstreamFunction('deriveEndpointUrl')],
  ['period initialization', originalText.slice(initStart, originalText.indexOf(initEnd, initStart) + initEnd.length)],
  ['range label', 'const label = labels[period] || labels.today;'],
  ['daily trend renderer', 'function renderTokenUsageDailyTrend(dailySummary, error) {'],
  ['daily trend panels', '${renderTokenUsageDailyTrend(\n                dailySummary,\n                state.tokenUsageDailyError\n              )}'],
  ['cost amount reader', 'function getCostAmount(cost) {'],
  ['closing body', '</body>'],
];

test('every required upstream marker must occur exactly once', () => {
  for (const [name, marker] of requiredMarkers) {
    assert.ok(marker.length, name);
    for (const [reason, source] of [
      ['missing', originalText.replace(marker, '')],
      ['duplicated', `${originalText}\n${marker}`],
    ]) {
      assert.throws(() => rewriteUsageViewer(Buffer.from(source), viewerConfig), (error) =>
        error instanceof UsageViewerError && error.status === 502 && error.code === 'proxy_usage_viewer_incompatible'
        && error.message.includes(name) && error.message.includes(reason), `${name}: ${reason}`);
    }
  }
});

test('a renamed period select or binding is reported as incompatible', () => {
  for (const source of [
    originalText.replace('id="token-usage-period"', 'id="renamed-period"'),
    originalText.replace('          "token-usage-period"', '          "renamed-period"'),
  ]) {
    assert.throws(() => rewriteUsageViewer(Buffer.from(source), viewerConfig), (error) =>
      error instanceof UsageViewerError && /period select.*missing/.test(error.message));
  }
});

test('CRLF upstream pages are supported and mixed-ending duplicate markers still fail', async () => {
  const rewritten = rewriteUsageViewer(Buffer.from(originalText.replaceAll('\n', '\r\n')), viewerConfig).toString();
  const view = await dashboardPage('?period=-10+Day&endpoint=%2Fusage', rewritten, dailyFixture);
  assert.equal(view.select.value, '-10day');
  assertTokenUsageRequests(view.requests, '-10day');
  assertTrendPanelOrder(view.rendered);
  for (const [name, marker] of requiredMarkers.filter(([, marker]) => marker.includes('\n'))) {
    const duplicate = originalText + marker.replaceAll('\n', '\r\n');
    assert.throws(() => rewriteUsageViewer(Buffer.from(duplicate), viewerConfig), (error) =>
      error instanceof UsageViewerError && error.message.includes(`${name} marker is duplicated`));
  }
});

test('rewriting preserves arbitrary source bytes outside its ASCII edits', () => {
  const sentinel = Buffer.from([0x00, 0x80, 0xff, 0xe9, 0xc0]);
  const prefix = Buffer.from([0xff, 0x80]);
  const suffix = Buffer.from([0xfe, 0x81]);
  const placeholder = Buffer.from('SOURCE_BYTE_SENTINEL');
  const control = Buffer.from(originalText.replace('Copilot API Dashboard', placeholder.toString()));
  const originalIndex = control.indexOf(placeholder);
  const source = Buffer.concat([prefix, control.subarray(0, originalIndex), sentinel,
    control.subarray(originalIndex + placeholder.length), suffix]);
  const saved = Buffer.from(source);
  const rewrittenControl = rewriteUsageViewer(control, viewerConfig);
  const rewrittenIndex = rewrittenControl.indexOf(placeholder);
  const expected = Buffer.concat([prefix, rewrittenControl.subarray(0, rewrittenIndex), sentinel,
    rewrittenControl.subarray(rewrittenIndex + placeholder.length), suffix]);
  assert.deepEqual(rewriteUsageViewer(source, viewerConfig), expected);
  assert.deepEqual(source, saved);
});
