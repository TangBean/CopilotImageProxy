import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { rewriteUsageViewer } from '../src/usage-viewer.mjs';

const original = Buffer.from('<body><script>const DEFAULT_ENDPOINT = "http://localhost:4141/usage";</script></body>');
const html = rewriteUsageViewer(original, { host: '127.0.0.1', port: 43000 }).toString();
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
