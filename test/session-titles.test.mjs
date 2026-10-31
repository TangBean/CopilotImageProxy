import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionTitleReader } from '../src/session-titles.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'copilot-image-proxy-session-titles-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'session_index.jsonl');
  return { path, read: createSessionTitleReader(path) };
}

function row(id, thread_name, updated_at = '2026-10-31T00:00:00Z') {
  return JSON.stringify({ id, thread_name, updated_at });
}

test('session titles select the latest timestamp and skip corrupt or invalid records', async (t) => {
  const { path, read } = await fixture(t);
  await writeFile(path, [
    row('one', '最新标题', '2026-10-31T01:00:00Z'),
    row('one', '旧标题', '2026-10-31T00:00:00Z'),
    row('one', '无效时间', 'not-a-date'),
    row('two', ' 保留标题空格 <b>&</b> '),
    row('empty', '旧标题'),
    row('empty', ' \t', '2026-10-31T01:00:00Z'),
    row('tie', '前一行'),
    row('tie', '后一行'),
    '{broken', 'null', '[]', 'true', '{}',
    row('', '没有 ID'), row(' \t', '空白 ID'), row(4, '数字 ID'),
    row('invalid-title', null), row('invalid-time', '标题', 123),
    '',
  ].join('\r\n'));
  assert.deepEqual(await read(), {
    one: '最新标题', two: ' 保留标题空格 <b>&</b> ', tie: '后一行',
  });
});

test('session titles preserve prototype-like IDs as ordinary JSON properties', async (t) => {
  const { path, read } = await fixture(t);
  await writeFile(path, [row('__proto__', '普通标题'), row('constructor', '另一个标题')].join('\n'));
  const titles = await read();
  assert.equal(Object.getPrototypeOf(titles), Object.prototype);
  assert.equal(Object.hasOwn(titles, '__proto__'), true);
  assert.equal(JSON.parse(JSON.stringify(titles)).__proto__, '普通标题');
  assert.equal(titles.constructor, '另一个标题');
});

test('session titles preserve timestamp precision, compare offsets and reject normalized invalid dates', async (t) => {
  const { path, read } = await fixture(t);
  await writeFile(path, [
    row('precise', 'newer', '2026-10-31T10:00:00.000900Z'),
    row('precise', 'older', '2026-10-31T10:00:00.000100Z'),
    row('long-fraction', 'newer', '2026-10-31T10:00:00.200000000000Z'),
    row('long-fraction', 'older', '2026-10-31T10:00:00.089451857324Z'),
    row('zeros', 'first', '2026-10-31T10:00:00.123400Z'),
    row('zeros', 'same instant, later line', '2026-10-31T11:00:00.1234+01:00'),
    row('offset', 'newer', '2026-10-31T10:00:00.00001Z'),
    row('offset', '   ', '2026-10-31T11:00:00.000009+01:00'),
    row('invalid', 'valid title', '2026-02-28T00:00:00Z'),
    row('invalid', 'bad calendar date', '2026-02-30T00:00:00Z'),
    row('invalid', 'bad calendar date', '2026-02-31T00:00:00Z'),
    row('invalid', 'bad hour', '2026-03-01T24:00:00Z'),
    row('invalid', 'date without time', '2026-03-02'),
    row('leap', 'valid leap day', '2024-02-29T00:00:00Z'),
  ].join('\n'));
  assert.deepEqual(await read(), {
    precise: 'newer', 'long-fraction': 'newer', zeros: 'same instant, later line',
    offset: 'newer', invalid: 'valid title', leap: 'valid leap day',
  });
});

test('session title cache rereads when mtime or size changes and reuses an unchanged file', async (t) => {
  const { path, read } = await fixture(t);
  const firstTime = new Date('2026-01-01T00:00:00Z');
  const nextTime = new Date('2026-01-02T00:00:00Z');
  await writeFile(path, row('one', 'first'));
  await utimes(path, firstTime, firstTime);
  assert.deepEqual(await read(), { one: 'first' });
  const firstSize = (await stat(path)).size;

  await writeFile(path, row('one', 'other'));
  await utimes(path, firstTime, firstTime);
  assert.equal((await stat(path)).size, firstSize);
  assert.deepEqual(await read(), { one: 'first' });

  await utimes(path, nextTime, nextTime);
  assert.deepEqual(await read(), { one: 'other' });

  await writeFile(path, row('one', 'a longer title'));
  await utimes(path, nextTime, nextTime);
  assert.notEqual((await stat(path)).size, firstSize);
  assert.deepEqual(await read(), { one: 'a longer title' });
});

test('session titles return empty data on missing or unreadable files and recover without writes', async (t) => {
  const { path, read } = await fixture(t);
  assert.deepEqual(await read(), {});
  const contents = row('one', '标题');
  await writeFile(path, contents);
  assert.deepEqual(await read(), { one: '标题' });
  assert.equal(await readFile(path, 'utf8'), contents);

  await unlink(path);
  assert.deepEqual(await read(), {});
  await mkdir(path);
  assert.deepEqual(await read(), {});
  await rmdir(path);
  await writeFile(path, contents);
  assert.deepEqual(await read(), { one: '标题' });
});
