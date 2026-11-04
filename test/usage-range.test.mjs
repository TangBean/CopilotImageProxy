import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createUsageRangeReader, parseUsageTimestamp, UsageRangeError } from '../src/usage-range.mjs';
import { createUsageDb } from './helpers/usage-db.mjs';

const DAY = 86400000;
const start = Date.parse('2026-01-01T16:00:00Z');
const end = start + 2 * DAY;
const query = (extra = {}) => new URLSearchParams({ from: '20260102000000', to: '20260104000000', ...extra });
const invalidRequest = (error) => error instanceof UsageRangeError && error.status === 400 && error.type === 'invalid_request_error';

async function fixture(t) {
  const result = await createUsageDb(t, [
    { created_at_ms: start - 1, total_tokens: 10000, model: 'outside', session_id: 'outside' },
    { created_at_ms: start, model: 'model-a', session_id: 'a', input_tokens: 10, output_tokens: 2,
      cache_read_input_tokens: 3, cache_creation_input_tokens: 4, total_tokens: 99,
      cost_currency: 'USD', total_cost_nanos: 100000000, cost_source: 'price',
      request_id: 'request-a', first_token_ms: 100, duration_ms: 1100, request_outcome: 'completed' },
    { created_at_ms: start + 1000, model: 'model-b', session_id: 'b', input_tokens: 20, output_tokens: 3,
      total_nano_aiu: 5, cost_currency: 'EUR', total_cost_nanos: 2000000000, cost_source: 'price',
      request_id: 'request-b', first_token_ms: 200, duration_ms: 2200, request_outcome: 'completed' },
    { created_at_ms: start + DAY - 1, model: 'model-a', session_id: 'a', input_tokens: 30, output_tokens: 5,
      total_nano_aiu: 7, cost_currency: 'USD', total_cost_nanos: 300000000, cost_source: 'price' },
    { created_at_ms: start + DAY, model: 'model-b', session_id: '', input_tokens: 40, output_tokens: 7,
      cost_currency: 'USD', total_cost_nanos: 600000000, cost_source: 'price' },
    { created_at_ms: end, total_tokens: 20000, model: 'outside', session_id: 'outside' },
  ]);
  return { ...result, read: createUsageRangeReader({ sqliteDbPath: result.path }, { now: () => end }) };
}

test('compact timestamps validate calendar fields and use configured or explicit UTC offsets', () => {
  assert.equal(parseUsageTimestamp('20260102000000'), start);
  assert.equal(parseUsageTimestamp('20260101160000Z'), start);
  assert.equal(parseUsageTimestamp('20260102000000+0800'), start);
  assert.equal(parseUsageTimestamp('20260101110000-0500'), start);
  assert.equal(parseUsageTimestamp('20260101213000', '+05:30'), start);
  assert.equal(parseUsageTimestamp('20260101020000-1400'), start);
  assert.equal(parseUsageTimestamp('20240229010101Z'), Date.parse('2024-02-29T01:01:01Z'));
  assert.equal(new Date(parseUsageTimestamp('00990228000000Z')).toISOString(), '0099-02-28T00:00:00.000Z');
  for (const value of ['', ' ', '20260101', '20260102000000.000Z', '20260102000000+08:00',
    '20230229000000', '20260230000000', '20261301000000', '20260001000000', '20260100000000',
    '20260101240000', '20260101006000', '20260101000060', '20260102000000+1460',
    '20260102000000-1401', '20260102000000+1500', '20260102000000Zjunk']) {
    assert.throws(() => parseUsageTimestamp(value), invalidRequest, value);
  }
});

test('explicit invalid boundaries fail before opening the database', async () => {
  const read = createUsageRangeReader({ sqliteDbPath: 'unused-missing-db.sqlite' }, { now: () => end });
  for (const params of [query({ from: '' }), query({ to: '' }), query({ from: '20260104000000' }),
    query({ from: '20260105000000' }), query({ from: '20240101000000' }),
    new URLSearchParams('from=invalid'), new URLSearchParams('to=invalid')]) {
    await assert.rejects(read('/token-usage', params), invalidRequest);
  }
});

test('totals, costs, model ordering and timing match upstream while range overrides period', async (t) => {
  const { read } = await fixture(t);
  const result = await read('/token-usage', query({ period: 'today' }));
  assert.equal(result.period, 'custom');
  assert.deepEqual(result.range, {
    start_ms: start, end_ms: end,
    start_utc: '2026-01-01T16:00:00.000Z', end_utc: '2026-01-03T16:00:00.000Z',
  });
  assert.equal(result.data_start_ms, start - 1);
  assert.deepEqual(result.totals, {
    request_count: 4, input_tokens: 100, output_tokens: 17, cache_read_input_tokens: 3,
    cache_creation_input_tokens: 4, total_tokens: 204, total_nano_aiu: 12,
    costs: [
      { amount: 2, currency: 'EUR', total_cost_nanos: 2000000000 },
      { amount: 1, currency: 'USD', total_cost_nanos: 1000000000 },
    ],
  });
  assert.deepEqual(result.byModel.map((model) => [model.model, model.total_tokens, model.average_first_token_ms,
    model.output_tokens_per_second]), [['model-a', 134, 100, 2], ['model-b', 70, 200, 1.5]]);
  assert.deepEqual(result.byModel[0].costs, [{ amount: 0.4, currency: 'USD', total_cost_nanos: 400000000 }]);
});

test('missing endpoints use the oldest event and one captured now, with earlier starts allowed', async (t) => {
  const { read } = await fixture(t);
  const until = await read('/token-usage', new URLSearchParams({ to: '20260104000000' }));
  assert.equal(until.range.start_ms, start - 1);
  assert.equal(until.totals.request_count, 5);
  const since = await read('/token-usage', new URLSearchParams({ from: '20260102000000' }));
  assert.equal(since.range.end_ms, end);
  assert.equal(since.totals.request_count, 4);
  const earlier = await read('/token-usage', query({ from: '20260101000000' }));
  assert.equal(earlier.range.start_ms, start - DAY);
  assert.equal(earlier.data_start_ms, start - 1);
  assert.equal(earlier.totals.request_count, 5);
  await assert.rejects(read('/token-usage', new URLSearchParams({ to: '20260101000000' })), invalidRequest);
});

test('daily buckets use configured civil days, preserve empty days and clip both edges', async (t) => {
  const { read } = await fixture(t);
  const result = await read('/token-usage/daily', query({ from: '20260102235958', to: '20260104000001' }));
  assert.deepEqual(result.days.map((day) => [day.date, day.start_ms, day.end_ms, day.totals.request_count]), [
    ['2026-01-02', start + DAY - 2000, start + DAY, 1],
    ['2026-01-03', start + DAY, end, 1],
    ['2026-01-04', end, end + 1000, 1],
  ]);
  const empty = await read('/token-usage/daily', query({ from: '20260105010203', to: '20260107040506' }));
  assert.deepEqual(empty.days.map((day) => [day.date, day.totals.request_count, day.byModel]), [
    ['2026-01-05', 0, []], ['2026-01-06', 0, []], ['2026-01-07', 0, []],
  ]);
  assert.equal(empty.totals.total_nano_aiu, null);
  assert.deepEqual(empty.totals.costs, []);
  const explicitUtc = await read('/token-usage/daily', query({ from: '20260101160000Z', to: '20260102160000Z' }));
  assert.deepEqual(explicitUtc.days.map((day) => day.date), ['2026-01-02']);
});

test('daily grouping follows a non-default configured offset independently of input suffixes', async (t) => {
  const { path } = await fixture(t);
  const read = createUsageRangeReader({ sqliteDbPath: path, usageTimezone: '-05:00' });
  const result = await read('/token-usage/daily', query({ from: '20260102040000Z', to: '20260102060000Z' }));
  assert.deepEqual(result.days.map((day) => [day.date, day.start_ms, day.end_ms]), [
    ['2026-01-01', Date.parse('2026-01-02T04:00:00Z'), Date.parse('2026-01-02T05:00:00Z')],
    ['2026-01-02', Date.parse('2026-01-02T05:00:00Z'), Date.parse('2026-01-02T06:00:00Z')],
  ]);
});

test('event pages preserve descending time/id order, fields, pagination and exclusive end', async (t) => {
  const { read, insert } = await fixture(t);
  insert({ created_at_ms: start + DAY, model: 'tie', total_tokens: 1, user_id: 'user', user_agent: 'test-agent',
    provider_name: 'provider', trace_id: 'specific-trace', endpoint: '/chat/completions' });
  const page = await read('/token-usage/events', query({ page: '2', page_size: '2' }));
  assert.equal(page.total, 5);
  assert.equal(page.total_pages, 3);
  assert.equal(page.page, 2);
  assert.equal(page.page_size, 2);
  assert.deepEqual(page.items.map((row) => row.id), [4, 3]);
  assert.deepEqual(page.items[1].cost, { amount: 2, currency: 'EUR', total_cost_nanos: 2000000000, source: 'price' });
  assert.equal(page.items[1].output_tokens_per_second, 1.5);
  const first = await read('/token-usage/events', query({ page_size: '2' }));
  assert.deepEqual(first.items.map((row) => row.id), [7, 5]);
  assert.equal(first.items[0].user_agent, 'test-agent');
  assert.equal(first.items[0].provider_name, 'provider');
  assert.equal(first.items[0].trace_id, 'specific-trace');
  assert.equal(first.items[0].cost, null);
  assert.equal(first.items[0].output_tokens_per_second, null);
});

test('session pages include empty session IDs and sort by totals, then session ID', async (t) => {
  const { read, insert } = await fixture(t);
  insert({ created_at_ms: start, session_id: 'aa', total_tokens: 134 });
  const first = await read('/token-usage/sessions', query({ page_size: '2' }));
  assert.equal(first.total, 4);
  assert.equal(first.total_pages, 2);
  assert.deepEqual(first.items.map((row) => [row.session_id, row.total_tokens]), [['a', 134], ['aa', 134]]);
  assert.deepEqual(first.items[0].costs, [{ amount: 0.4, currency: 'USD', total_cost_nanos: 400000000 }]);
  const second = await read('/token-usage/sessions', query({ page_size: '2', page: '2' }));
  assert.deepEqual(second.items.map((row) => [row.session_id, row.total_tokens]), [['', 47], ['b', 23]]);
});

test('pagination follows upstream defaults and size cap, with empty out-of-range pages', async (t) => {
  const { read } = await fixture(t);
  for (const route of ['/token-usage/events', '/token-usage/sessions']) {
    const defaults = await read(route, query({ page: '-2', page_size: 'nope' }));
    assert.equal(defaults.page, 1);
    assert.equal(defaults.page_size, 20);
    const capped = await read(route, query({ page: '2extra', page_size: '200' }));
    assert.equal(capped.page, 2);
    assert.equal(capped.page_size, 100);
    assert.deepEqual(capped.items, []);
    const huge = await read(route, query({ page: '9'.repeat(100) }));
    assert.deepEqual(huge.items, []);
    const nonfinite = await read(route, query({ page: '9'.repeat(400), page_size: '9'.repeat(400) }));
    assert.equal(nonfinite.page, 1);
    assert.equal(nonfinite.page_size, 20);
  }
});

test('model timing aggregates whole completed requests but excludes boundary-spanning requests', async (t) => {
  const completed = { model: 'timed', first_token_ms: 100, duration_ms: 1100, request_outcome: 'completed' };
  const { path } = await createUsageDb(t, [
    { ...completed, created_at_ms: start, request_id: 'single', output_tokens: 10 },
    { ...completed, created_at_ms: start + 1, request_id: 'multi', output_tokens: 10 },
    { ...completed, created_at_ms: start + 2, request_id: 'multi', output_tokens: 20 },
    { ...completed, created_at_ms: start - 1, request_id: 'partial', output_tokens: 1000 },
    { ...completed, created_at_ms: start, request_id: 'partial', output_tokens: 1000 },
    { ...completed, created_at_ms: start, request_id: 'cancelled', output_tokens: 1000, request_outcome: 'cancelled' },
    { ...completed, created_at_ms: start, request_id: 'missing', output_tokens: 1000, first_token_ms: null },
    { ...completed, created_at_ms: start, request_id: 'models', output_tokens: 1000 },
    { ...completed, created_at_ms: start, request_id: 'models', output_tokens: 1000, model: 'other' },
  ]);
  const read = createUsageRangeReader({ sqliteDbPath: path });
  const result = await read('/token-usage', query());
  const timed = result.byModel.find((row) => row.model === 'timed');
  assert.equal(timed.average_first_token_ms, 100);
  assert.equal(timed.output_tokens_per_second, 20);
  const events = await read('/token-usage/events', query());
  assert.equal(events.items.find((row) => row.request_id === 'single').output_tokens_per_second, 10);
  for (const row of events.items.filter((row) => row.request_id !== 'single')) {
    assert.equal(row.output_tokens_per_second, null, row.request_id);
  }
});

test('daily timing excludes a request that crosses midnight, while range timing includes it', async (t) => {
  const common = { request_id: 'cross-day', first_token_ms: 100, duration_ms: 1100, request_outcome: 'completed', output_tokens: 10 };
  const { path } = await createUsageDb(t, [
    { ...common, created_at_ms: start + DAY - 1 }, { ...common, created_at_ms: start + DAY },
  ]);
  const result = await createUsageRangeReader({ sqliteDbPath: path })('/token-usage/daily', query());
  assert.equal(result.byModel[0].output_tokens_per_second, 20);
  assert.equal(result.byModel[0].average_first_token_ms, 100);
  for (const day of result.days) {
    assert.equal(day.byModel[0].output_tokens_per_second, null);
    assert.equal(day.byModel[0].average_first_token_ms, null);
  }
});

test('empty databases return empty summaries and empty inferred range without inventing data', async (t) => {
  const { path } = await createUsageDb(t);
  const read = createUsageRangeReader({ sqliteDbPath: path });
  for (const route of ['/token-usage', '/token-usage/daily', '/token-usage/events', '/token-usage/sessions']) {
    const result = await read(route, new URLSearchParams({ to: '20260104000000' }));
    assert.equal(result.range.start_ms, end);
    assert.equal(result.range.end_ms, end);
    assert.equal(result.data_start_ms, null);
    if (result.totals) {
      assert.equal(result.totals.request_count, 0);
      assert.deepEqual(result.byModel, []);
    } else {
      assert.deepEqual(result.items, []);
      assert.equal(result.total_pages, 1);
    }
    if (result.days) assert.deepEqual(result.days, []);
  }
});

test('366-day maximum applies to explicit and inferred ranges on every endpoint', async (t) => {
  const { path } = await createUsageDb(t, [{ created_at_ms: start }]);
  const read = createUsageRangeReader({ sqliteDbPath: path }, { now: () => start + 367 * DAY });
  for (const route of ['/token-usage', '/token-usage/daily', '/token-usage/events', '/token-usage/sessions']) {
    await assert.rejects(read(route, new URLSearchParams({ from: '20260102000000' })), invalidRequest);
    await assert.rejects(read(route, query({ to: '20270104000000' })), invalidRequest);
    await assert.rejects(read(route, new URLSearchParams({ to: '20270104000000' })), invalidRequest);
  }
  const exact = await read('/token-usage/daily', query({ to: '20270103000000' }));
  assert.equal(exact.range.end_ms - exact.range.start_ms, 366 * DAY);
  assert.equal(exact.days.length, 366);
});

test('missing database does not create a file and returns a recoverable 501', async (t) => {
  const { path } = await createUsageDb(t);
  const missing = join(dirname(path), 'missing.sqlite');
  const read = createUsageRangeReader({ sqliteDbPath: missing });
  await assert.rejects(read('/token-usage', query()), (error) =>
    error instanceof UsageRangeError && error.status === 501 && !error.message.includes(missing));
  await assert.rejects(access(missing), { code: 'ENOENT' });
  await writeFile(missing, await readFile(path));
  assert.equal((await read('/token-usage', query())).totals.request_count, 0);
});

test('incompatible schema returns 501 instead of migrating or silently changing the requested range', async (t) => {
  const { path, db } = await createUsageDb(t);
  db.exec('ALTER TABLE token_usage_events DROP COLUMN duration_ms');
  const before = await readFile(path);
  const read = createUsageRangeReader({ sqliteDbPath: path });
  await assert.rejects(read('/token-usage', query()), (error) =>
    error.status === 501 && /schema/.test(error.message));
  assert.deepEqual(await readFile(path), before);
  assert.ok(!db.prepare('PRAGMA table_info(token_usage_events)').all().some((column) => column.name === 'duration_ms'));
});

test('all endpoints leave database bytes unchanged and see committed WAL rows alongside a writer', async (t) => {
  const { path, db, insert } = await createUsageDb(t, [{ created_at_ms: start, total_tokens: 10 }], { wal: true });
  const before = await readFile(path);
  const walBefore = await readFile(`${path}-wal`);
  const read = createUsageRangeReader({ sqliteDbPath: path });
  for (const route of ['/token-usage', '/token-usage/daily', '/token-usage/events', '/token-usage/sessions']) {
    const result = await read(route, query());
    assert.equal(result.totals?.total_tokens ?? result.items[0].total_tokens, 10);
  }
  assert.deepEqual(await readFile(path), before);
  assert.deepEqual(await readFile(`${path}-wal`), walBefore);
  db.exec('BEGIN');
  insert({ created_at_ms: start + 1, total_tokens: 20 });
  assert.equal((await read('/token-usage', query())).totals.total_tokens, 10);
  db.exec('COMMIT');
  assert.equal((await read('/token-usage', query())).totals.total_tokens, 30);
});

test('database path override takes precedence over the environment, with environment resolved lazily', async (t) => {
  const first = await createUsageDb(t, [{ created_at_ms: start, total_tokens: 10 }]);
  const second = await createUsageDb(t, [{ created_at_ms: start, total_tokens: 20 }]);
  const previous = process.env.COPILOT_API_SQLITE_DB_PATH;
  t.after(() => {
    if (previous === undefined) delete process.env.COPILOT_API_SQLITE_DB_PATH;
    else process.env.COPILOT_API_SQLITE_DB_PATH = previous;
  });
  const lazy = createUsageRangeReader();
  process.env.COPILOT_API_SQLITE_DB_PATH = first.path;
  assert.equal((await lazy('/token-usage', query())).totals.total_tokens, 10);
  process.env.COPILOT_API_SQLITE_DB_PATH = second.path;
  assert.equal((await lazy('/token-usage', query())).totals.total_tokens, 20);
  const explicit = createUsageRangeReader({ sqliteDbPath: first.path });
  assert.equal((await explicit('/token-usage', query())).totals.total_tokens, 10);
});
