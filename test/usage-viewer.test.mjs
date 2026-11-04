import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { rewriteUsageViewer, UsageViewerError } from '../src/usage-viewer.mjs';

const original = readFileSync(new URL('./fixtures/usage-viewer.upstream.html', import.meta.url));
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

async function dashboardPage(path, source = html) {
  const requests = [];
  const history = { pushed: [], replaced: [] };
  const elements = new Map();
  const element = (id) => {
    const listeners = new Map();
    const node = {
      id, value: '', innerHTML: '', style: {}, dataset: {},
      classList: { toggle() {} },
      addEventListener(type, handler) {
        listeners.set(type, [...listeners.get(type) || [], handler]);
      },
      dispatch(type, event = {}) {
        for (const handler of listeners.get(type) || []) handler(event);
      },
    };
    elements.set(id, node);
    return node;
  };
  for (const id of ['endpoint-form', 'endpoint-url', 'x-api-key', 'token-usage-period', 'content-area',
    'page-tabs', 'usage-tab', 'models-tab', 'token-usage-period-field', 'fetch-button']) element(id);
  elements.get('fetch-button').querySelector = () => ({ textContent: '' });

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

  const window = {
    location: new URL(path, 'http://127.0.0.1:43000/usage-viewer'),
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
  let ready;
  const sandbox = {
    URL, URLSearchParams, window,
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
      assert.ok(url.pathname === '/usage' || tokenUsagePaths.includes(url.pathname), url.href);
      const payload = url.pathname === '/usage' ? { quota_snapshots: {} } : {
        range, totals: {}, byModel: [], days: [], items: [],
        page: Number(url.searchParams.get('page') || 1), total: 0, total_pages: 1,
      };
      return { ok: true, json: async () => payload };
    },
    console: { warn() {}, error() {} },
    buildRequestHeaders: () => ({}),
    updateControls() {},
    migrateLegacyApiKey() {},
    syncEndpointCredential() {},
    readCollapsedSections: () => ({}),
    storeApiKey() {},
    handleTabsKeydown() {},
    handleModelsConnectionChange() {},
    handleContentAreaClick() {},
    handleContentAreaChange() {},
    handleModelsSearch() {},
    renderUsageQuotas: () => '',
    renderDetailedData: () => '',
    renderCollapseToggle: () => '',
    renderCollapseBody: (_key, body) => body,
    renderTokenUsageSection() {
      const { state, escapeHtml, renderTokenUsageRangeText, renderError } = sandbox.viewer;
      const activeRange = state.tokenUsageSummary?.range || state.tokenUsageDailySummary?.range;
      const error = state.tokenUsageSummaryError || state.tokenUsageDailyError;
      return `<p>${escapeHtml(renderTokenUsageRangeText(state.tokenUsagePeriod, activeRange))}</p>`
        + (error ? renderError(error) : '');
    },
  };
  const upstreamScript = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(upstreamScript?.includes('        init();'), 'Fixture must execute the real upstream init');
  const instrumented = upstreamScript.replace('        init();', `
        globalThis.viewer = {
          state, normalizePeriod, getSelectedPeriod, syncUrlState, resolveUsageUrl, deriveEndpointUrl,
          buildTokenUsageSummaryUrl, buildTokenUsageDailyUrl, buildTokenUsageEventsUrl,
          fetchTokenUsageEventsPage, fetchTokenUsageSessionsPage,
          renderTokenUsageRangeText, renderError, escapeHtml,
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

test('extracted upstream fixture reproduces fallback to Today before rewriting', async () => {
  const view = await dashboardPage('?period=-1%20Day&endpoint=%2Fusage', original.toString());
  assert.equal(view.state.tokenUsagePeriod, 'today');
  assert.equal(view.select.value, 'today');
  assertTokenUsageRequests(view.requests, 'today');
});

test('all ten relative days and accepted spellings survive upstream initialization and fetch builders', async () => {
  for (let day = 1; day <= 10; day++) {
    for (const suffix of ['day', ' Day', '_DAY']) {
      const period = `-${day}${suffix}`;
      const canonical = `-${day}day`;
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

test('plus decoding, select changes, form refresh, pagination and reload retain the canonical relative period', async () => {
  const view = await dashboardPage('?period=-1+Day&endpoint=%2Fusage&other=keep#fragment');
  assert.equal(view.url.searchParams.get('period'), '-1day');
  assert.equal(view.history.replaced.length, 1);
  assert.equal(view.history.pushed.length, 0);

  view.requests.length = 0;
  await view.selectPeriod('this_week');
  assert.equal(view.state.tokenUsagePeriod, 'this_week');
  assert.equal(view.url.searchParams.get('period'), 'this_week');
  assertTokenUsageRequests(view.requests, 'this_week');
  assert.equal(view.requests.some((url) => url.pathname === '/usage'), false);

  view.requests.length = 0;
  await view.selectPeriod('-1day');
  assert.equal(view.select.value, '-1day');
  assertTokenUsageRequests(view.requests, '-1day');
  assert.equal(view.url.searchParams.get('period'), '-1day');
  assert.equal(view.url.searchParams.get('other'), 'keep');
  assert.equal(view.url.hash, '#fragment');
  assert.equal(view.history.pushed.length, 2);

  view.requests.length = 0;
  await view.submit();
  assertTokenUsageRequests(view.requests, '-1day');
  assert.equal(view.requests.filter((url) => url.pathname === '/usage').length, 1);

  view.requests.length = 0;
  await view.viewer.fetchTokenUsageEventsPage(2);
  await view.viewer.fetchTokenUsageSessionsPage(2);
  assertTokenUsageRequests(view.requests, '-1day', ['/token-usage/events', '/token-usage/sessions']);
  assert.deepEqual(view.requests.map((url) => url.searchParams.get('page')), ['2', '2']);

  const reloaded = await dashboardPage(view.url.href);
  assert.equal(reloaded.state.tokenUsagePeriod, '-1day');
  assert.equal(reloaded.select.value, '-1day');
  assertTokenUsageRequests(reloaded.requests, '-1day');
});

test('relative URLs without an endpoint retain the selected option until the user refreshes', async () => {
  const view = await dashboardPage('?period=-10_Day');
  assert.equal(view.state.tokenUsagePeriod, '-10day');
  assert.equal(view.select.value, '-10day');
  assert.equal(view.url.searchParams.get('period'), '-10day');
  assert.equal(view.requests.length, 0);
  await view.submit();
  assertTokenUsageRequests(view.requests, '-10day');
  assert.equal(view.requests.find((url) => url.pathname === '/usage').href, 'http://127.0.0.1:43000/usage');
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
  for (const period of ['-0day', '-11day', '-01day', '-1days', '-1  day', '-1__day', '-1-day',
    ' -1day', '-1day ', '-1day\n', '-1\tday', '-100day', '-1day\0']) {
    const view = await dashboardPage(`?period=${encodeURIComponent(period)}&endpoint=%2Fusage`);
    assert.equal(view.requests.length, 0, JSON.stringify(period));
    assert.match(view.state.error, /Relative-day period must be -1day through -10day/);
    assert.match(view.rendered, /role="alert"/);
    assert.match(view.rendered, /Relative-day period must be -1day through -10day/);
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
  const view = await dashboardPage('?period=-1day');
  const { renderTokenUsageRangeText } = view.viewer;
  assert.equal(renderTokenUsageRangeText('-1day', { start_ms: 0, end_ms: 1, display_label: '2026-11-03 (-1 Day)' }),
    '2026-11-03 (-1 Day)');
  assert.equal(renderTokenUsageRangeText('-1day', null), '-1day');
  assert.equal(renderTokenUsageRangeText('this_week', null), 'This week');
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

test('CRLF upstream excerpts are supported and mixed-ending duplicate markers still fail', async () => {
  const rewritten = rewriteUsageViewer(Buffer.from(originalText.replaceAll('\n', '\r\n')), viewerConfig).toString();
  const view = await dashboardPage('?period=-10+Day&endpoint=%2Fusage', rewritten);
  assert.equal(view.select.value, '-10day');
  assertTokenUsageRequests(view.requests, '-10day');
  const duplicate = originalText + upstreamFunction('normalizePeriod').replaceAll('\n', '\r\n');
  assert.throws(() => rewriteUsageViewer(Buffer.from(duplicate), viewerConfig), /period normalization marker is duplicated/);
});

test('rewriting preserves arbitrary source bytes outside its ASCII edits', () => {
  const sentinel = Buffer.from([0x00, 0x80, 0xff, 0xe9, 0xc0]);
  const prefix = Buffer.from([0xff, 0x80]);
  const suffix = Buffer.from([0xfe, 0x81]);
  const placeholder = Buffer.from('SOURCE_BYTE_SENTINEL');
  const control = Buffer.from(originalText.replace('会话统计', placeholder.toString()));
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
