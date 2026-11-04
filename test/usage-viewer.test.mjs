import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { rewriteUsageViewer } from '../src/usage-viewer.mjs';

const original = Buffer.from('<body><script>const DEFAULT_ENDPOINT = "http://localhost:4141/usage";</script></body>');
const html = rewriteUsageViewer(original, { host: '127.0.0.1', port: 43000 }).toString();
const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
const rangeScript = html.match(/<script id="copilot-usage-range">([\s\S]*?)<\/script>/)[1];

function rangePage(search = '?from=20261101000000&to=20261103000000') {
  const calls = [];
  const location = new URL(`http://127.0.0.1:43000/usage-viewer${search}`);
  const context = {
    URL, URLSearchParams, Request, location, document: { baseURI: location.href },
    fetch: async (input, init) => { calls.push({ input, init }); return { ok: true }; },
  };
  runInNewContext(rangeScript, context);
  return { calls, context, fetch: context.fetch };
}

test('range wrapper is installed before the first upstream fetch and keeps the title script last', async () => {
  const source = '<body><script>const DEFAULT_ENDPOINT = "http://localhost:4141/usage"; fetch("/token-usage?period=today");</script></body>';
  const rewritten = rewriteUsageViewer(Buffer.from(source), { host: '127.0.0.1', port: 43000 }).toString();
  const scripts = [...rewritten.matchAll(/<script(?: id="copilot-usage-range")?>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(scripts.length, 3);
  assert.match(scripts.at(-1), /fetch\('\/__session-titles'\)/);
  const calls = [];
  const location = new URL('http://127.0.0.1:43000/usage-viewer?from=20261101000000&to=20261103000000');
  const context = { URL, URLSearchParams, Request, location, document: { baseURI: location.href }, fetch: async (url) => calls.push(url) };
  runInNewContext(scripts[0] + '\n' + scripts[1], context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.get('from'), '20261101000000');
  assert.equal(calls[0].searchParams.get('to'), '20261103000000');
  assert.equal(calls[0].searchParams.get('period'), 'today');
});

test('range wrapper covers four same-origin routes and preserves pagination and fetch options', async () => {
  const view = rangePage('?from=20261101000000%2B0800&to=20261103000000Z');
  const controller = new AbortController();
  const init = { headers: { 'x-fixture': 'value' }, signal: controller.signal, credentials: 'same-origin' };
  for (const [index, path] of ['/token-usage', '/token-usage/daily', '/token-usage/events', '/token-usage/sessions'].entries()) {
    const url = new URL(`${path}?period=lifetime&page=2&page_size=5&from=old&to=old`, view.context.location);
    await view.fetch(index % 2 ? url : url.pathname + url.search, init);
    const call = view.calls.at(-1);
    assert.equal(call.init, init);
    assert.equal(call.input.origin, view.context.location.origin);
    assert.equal(call.input.searchParams.get('from'), '20261101000000+0800');
    assert.equal(call.input.searchParams.get('to'), '20261103000000Z');
    assert.equal(call.input.searchParams.get('period'), 'lifetime');
    assert.equal(call.input.searchParams.get('page'), '2');
    assert.equal(call.input.searchParams.get('page_size'), '5');
    assert.match(call.input.search, /from=20261101000000%2B0800/);
  }
});

test('range wrapper preserves Request body, headers, method, signal and init overrides', async () => {
  const view = rangePage('?from=20261101000000');
  const controller = new AbortController();
  const request = new Request('http://127.0.0.1:43000/token-usage/events?page=3&to=20261104000000', {
    method: 'POST', headers: { 'x-fixture': 'request-header' }, body: 'fixture body',
    signal: controller.signal, credentials: 'include', cache: 'no-store', redirect: 'manual',
  });
  const init = { headers: { 'x-override': 'init-header' } };
  await view.fetch(request, init);
  const call = view.calls[0];
  assert.ok(call.input instanceof Request);
  assert.equal(call.init, init);
  assert.equal(call.input.method, 'POST');
  assert.equal(call.input.headers.get('x-fixture'), 'request-header');
  assert.equal(await call.input.text(), 'fixture body');
  assert.equal(call.input.credentials, 'include');
  assert.equal(call.input.cache, 'no-store');
  assert.equal(call.input.redirect, 'manual');
  assert.equal(new URL(call.input.url).searchParams.get('page'), '3');
  assert.equal(new URL(call.input.url).searchParams.get('to'), '20261104000000');
  controller.abort();
  assert.equal(call.input.signal.aborted, true);
});

test('range wrapper leaves ordinary requests, cross-origin endpoints and no-range pages unchanged', async () => {
  const init = { headers: { 'x-fixture': 'unchanged' } };
  const view = rangePage();
  const inputs = [
    '/usage', '/__session-titles', '/token-usage-extra', '/token-usage/events/extra',
    '/v1/token-usage', '/token-usage/', 'http://localhost:43000/token-usage',
    'https://other.invalid/token-usage/daily',
    new URL('http://127.0.0.1:43001/token-usage/events'),
    new Request('http://other.invalid/token-usage/sessions'),
  ];
  for (const input of inputs) {
    await view.fetch(input, init);
    assert.equal(view.calls.at(-1).input, input);
    assert.equal(view.calls.at(-1).init, init);
  }
  const ordinary = rangePage('?period=lifetime');
  const input = new Request('http://127.0.0.1:43000/token-usage');
  await ordinary.fetch(input, init);
  assert.equal(ordinary.calls[0].input, input);
  assert.equal(ordinary.calls[0].init, init);
});

test('range wrapper forwards empty and untrusted values as query data and tracks URL changes', async () => {
  const view = rangePage('?from=&to=%3C%2Fscript%3E');
  await view.fetch('/token-usage');
  assert.equal(view.calls[0].input.searchParams.get('from'), '');
  assert.equal(view.calls[0].input.searchParams.get('to'), '</script>');
  assert.doesNotMatch(rangeScript, /202611/);
  view.context.location.search = '?to=20261105000000';
  await view.fetch('/token-usage');
  assert.equal(view.calls[1].input.searchParams.has('from'), false);
  assert.equal(view.calls[1].input.searchParams.get('to'), '20261105000000');
});

const rangeDisplayFixture = `<body><script>
const DEFAULT_ENDPOINT = "http://localhost:4141/usage";
function renderTokenUsageRangeText(period, range) {
  const labels = { today: "Today", lifetime: "Lifetime" };
  const label = labels[period] || labels.today;
  return label;
}
function summaryTitle(summary, dailySummary, eventsPage, sessionsPage) {
  const activeRange = summary?.range || dailySummary?.range || null;
  return renderTokenUsageRangeText(state.tokenUsagePeriod, activeRange);
}
function renderTokenUsageDailyTrend(dailySummary) {
  if (state.tokenUsagePeriod === "today") {
    return "";
  }
  return renderTokenUsageRangeText(
                        state.tokenUsagePeriod,
                        dailySummary?.range || null
  );
}
</script></body>`;

test('custom response periods label the range and reveal daily charts without changing ordinary responses', () => {
  for (const newline of ['\n', '\r\n']) {
    const source = rangeDisplayFixture.replaceAll('\n', newline);
    const result = rewriteUsageViewer(Buffer.from(source), { host: '127.0.0.1', port: 43000 }).toString();
    const upstreamScript = [...result.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
    const scope = { state: { tokenUsagePeriod: 'today' } };
    runInNewContext(upstreamScript, scope);
    assert.equal(scope.summaryTitle({ period: 'custom' }), 'Custom');
    assert.equal(scope.summaryTitle(null, { period: 'custom' }), 'Custom');
    assert.equal(scope.renderTokenUsageDailyTrend({ period: 'custom' }), 'Custom');
    assert.equal(scope.summaryTitle({ period: 'today' }), 'Today');
    assert.equal(scope.renderTokenUsageDailyTrend({ period: 'today' }), '');
    scope.state.tokenUsagePeriod = 'lifetime';
    assert.equal(scope.summaryTitle({ period: 'lifetime' }), 'Lifetime');
    assert.equal(scope.renderTokenUsageDailyTrend({ period: 'lifetime' }), 'Lifetime');
  }
});

test('display rewrites require all known markers to avoid partially changing unfamiliar upstream pages', () => {
  for (const source of [
    rangeDisplayFixture.replace('const label = labels[period] || labels.today;', 'const label = labels[period] || "Today";'),
    rangeDisplayFixture.replace('function summaryTitle', '// if (state.tokenUsagePeriod === "today") {\nfunction summaryTitle'),
  ]) {
    const result = rewriteUsageViewer(Buffer.from(source), { host: '127.0.0.1', port: 43000 }).toString();
    assert.ok(result.includes('if (state.tokenUsagePeriod === "today") {'));
    assert.ok(!result.includes('dailySummary?.period !== "custom"'));
    assert.match(result, /id="copilot-usage-range"/);
  }
});

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
