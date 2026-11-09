import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createUsageHourlyReader, UsageRangeError } from '../src/usage-range.mjs';
import { createUsageDb } from './helpers/usage-db.mjs';

const HOUR = 3600000;
const start = Date.parse('2026-11-08T16:00:00Z');
const end = start + 11.5 * HOUR;
const range = { start_ms: start, end_ms: end };
const completed = { first_token_ms: 100, duration_ms: 1100, request_outcome: 'completed', output_tokens: 10 };
const unavailable = (error) => error instanceof UsageRangeError && error.status === 501 && error.type === 'usage_range_unavailable';

test('hourly speeds weight complete requests and assign cross-hour usage to its last record', async (t) => {
  const { path } = await createUsageDb(t, [
    { ...completed, created_at_ms: start, request_id: 'midnight' },
    { ...completed, created_at_ms: start + 11 * HOUR - 1, request_id: 'multi' },
    { ...completed, created_at_ms: start + 11 * HOUR + 1, request_id: 'multi',
      output_tokens: 20, first_token_ms: 200, duration_ms: 2200 },
    { ...completed, created_at_ms: start + 11 * HOUR, request_id: 'single', output_tokens: 20 },
    { ...completed, created_at_ms: end - 1, request_id: 'other', model: 'model-b', output_tokens: 5 },
    { ...completed, created_at_ms: end, request_id: 'at-cutoff', model: 'future' },
    { ...completed, created_at_ms: start + 12 * HOUR, request_id: 'future', model: 'future' },
  ]);
  const result = await createUsageHourlyReader({ sqliteDbPath: path, usageTimezone: '-05:00' })(range);
  assert.equal(result.period, 'today');
  assert.equal(result.range.start_ms, start);
  assert.equal(result.range.end_ms, end);
  assert.equal(result.range.start_utc, '2026-11-08T16:00:00.000Z');
  assert.equal(result.hours.length, 24);
  assert.deepEqual(result.hours.map((hour) => hour.hour), Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`));
  assert.deepEqual(result.byModel, [{ model: 'model-a' }, { model: 'model-b' }]);
  assert.deepEqual(result.hours[0].byModel, [{ model: 'model-a', output_tokens_per_second: 10 }]);
  assert.deepEqual(result.hours[11].byModel, [
    { model: 'model-a', output_tokens_per_second: 50 / 3 },
    { model: 'model-b', output_tokens_per_second: 5 },
  ]);
  assert.equal(result.hours[23].start_ms, start + 23 * HOUR);
  assert.equal(result.hours[23].end_ms, start + 24 * HOUR);
  for (const [index, hour] of result.hours.entries()) {
    if (![0, 11].includes(index)) assert.deepEqual(hour.byModel, [], `empty hour ${index}`);
  }
});

test('hourly aggregation excludes partial Today requests and invalid timing without inventing zero speeds', async (t) => {
  const rows = [
    { ...completed, created_at_ms: start, request_id: 'valid' },
    { ...completed, created_at_ms: start - 1, request_id: 'before' },
    { ...completed, created_at_ms: start, request_id: 'before' },
    { ...completed, created_at_ms: end - 1, request_id: 'after' },
    { ...completed, created_at_ms: end, request_id: 'after' },
    ...[
      { request_id: 'cancelled', request_outcome: 'cancelled' },
      { request_id: 'outcome-missing', request_outcome: null },
      { request_id: 'first-missing', first_token_ms: null },
      { request_id: 'duration-missing', duration_ms: null },
      { request_id: 'negative', first_token_ms: -1 },
      { request_id: 'backwards', duration_ms: 50 },
      { request_id: null },
      { request_id: 'models' },
      { request_id: 'models', model: 'other' },
    ].map((row) => ({ ...completed, created_at_ms: start + HOUR, ...row })),
    { ...completed, created_at_ms: start + 2 * HOUR, request_id: 'zero', output_tokens: 0 },
    { ...completed, created_at_ms: start + 3 * HOUR, request_id: 'instant', duration_ms: 100 },
  ];
  const { path } = await createUsageDb(t, rows);
  const result = await createUsageHourlyReader({ sqliteDbPath: path })(range);
  assert.deepEqual(result.hours[0].byModel, [{ model: 'model-a', output_tokens_per_second: 10 }]);
  assert.deepEqual(result.hours[1].byModel, []);
  for (const hour of [2, 3]) {
    assert.deepEqual(result.hours[hour].byModel, [{ model: 'model-a', output_tokens_per_second: null }]);
  }
  assert.deepEqual(result.hours[11].byModel, []);
  assert.deepEqual(result.byModel, [{ model: 'model-a' }, { model: 'other' }]);
});

test('empty Today and the midnight instant retain all 24 empty hours', async (t) => {
  const { path } = await createUsageDb(t);
  const read = createUsageHourlyReader({ sqliteDbPath: path });
  for (const end_ms of [start, end, start + 24 * HOUR]) {
    const result = await read({ start_ms: start, end_ms });
    assert.deepEqual(result.byModel, []);
    assert.equal(result.hours.length, 24);
    assert.ok(result.hours.every((hour) => hour.byModel.length === 0));
  }
});

test('a complete day includes the last millisecond and excludes the next midnight', async (t) => {
  const { path } = await createUsageDb(t, [
    { ...completed, created_at_ms: start + 24 * HOUR - 1, request_id: 'last' },
    { ...completed, created_at_ms: start + 24 * HOUR, request_id: 'next', model: 'next-day' },
  ]);
  const result = await createUsageHourlyReader({ sqliteDbPath: path })({ start_ms: start, end_ms: start + 24 * HOUR });
  assert.deepEqual(result.hours[23].byModel, [{ model: 'model-a', output_tokens_per_second: 10 }]);
  assert.deepEqual(result.byModel, [{ model: 'model-a' }]);
});

test('invalid upstream Today ranges fail before opening SQLite', async () => {
  let opened = false;
  const read = createUsageHourlyReader({}, { openDatabase: () => { opened = true; throw new Error('must not open'); } });
  for (const input of [undefined, {}, { start_ms: start },
    { start_ms: String(start), end_ms: end }, { start_ms: start, end_ms: Infinity },
    { start_ms: start, end_ms: start - 1 }, { start_ms: start, end_ms: start + 24 * HOUR + 1 },
    { start_ms: start + 0.1, end_ms: end }, { start_ms: Number.MAX_SAFE_INTEGER, end_ms: Number.MAX_SAFE_INTEGER },
  ]) {
    await assert.rejects(read(input), (error) => error instanceof UsageRangeError && error.status === 502 && error.type === 'usage_hourly_unavailable');
  }
  assert.equal(opened, false);
});

test('hourly refreshes see new committed data through read-only connections without changing database or WAL bytes', async (t) => {
  const fixture = await createUsageDb(t, [], { wal: true });
  const connections = [];
  const read = createUsageHourlyReader({ sqliteDbPath: fixture.path }, {
    openDatabase(path, options) {
      assert.deepEqual(options, { readOnly: true });
      const db = new DatabaseSync(path, options);
      connections.push(db);
      return db;
    },
  });
  assert.deepEqual((await read(range)).hours[11].byModel, []);
  fixture.insert({ ...completed, created_at_ms: end - 1, request_id: 'new' });
  const before = await Promise.all([fixture.path, `${fixture.path}-wal`].map((path) => readFile(path)));
  assert.deepEqual((await read(range)).hours[11].byModel, [{ model: 'model-a', output_tokens_per_second: 10 }]);
  const after = await Promise.all([fixture.path, `${fixture.path}-wal`].map((path) => readFile(path)));
  assert.deepEqual(after, before);
  assert.ok(connections.every((db) => !db.isOpen));
});

test('hourly database errors stay recoverable and never create or migrate database files', async (t) => {
  const fixture = await createUsageDb(t);
  const missingPath = join(dirname(fixture.path), 'missing.sqlite');
  await assert.rejects(createUsageHourlyReader({ sqliteDbPath: missingPath })(range), unavailable);
  await assert.rejects(access(missingPath), { code: 'ENOENT' });
  fixture.db.exec('ALTER TABLE token_usage_events DROP COLUMN duration_ms');
  const before = await readFile(fixture.path);
  await assert.rejects(createUsageHourlyReader({ sqliteDbPath: fixture.path })(range), unavailable);
  assert.deepEqual(await readFile(fixture.path), before);
});
