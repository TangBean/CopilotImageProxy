import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig, validateConfig } from '../src/config.mjs';

test('configuration preserves defaults and validates quality and routing before startup', () => {
  assert.deepEqual(validateConfig(), DEFAULT_CONFIG);
  assert.equal(validateConfig({ jpegQuality: 90 }).jpegQuality, 90);
  assert.equal(validateConfig().logLevel, 'info');
  for (const logLevel of ['debug', 'info', 'warn', 'error', 'silent']) {
    assert.equal(validateConfig({ logLevel }).logLevel, logLevel);
  }
  for (const invalid of [{ jpegQuality: 101 }, { maxEdge: 0 }, { imageConcurrency: 0 },
    { maxOutputMiB: 0 }, { maxInputMiB: Infinity }, { cacheMiB: -1 }, { port: 4141 },
    { host: '0.0.0.0' }, { upstream: 'http://example.com' }, { upstream: 'http://secret@localhost:4141' },
    { upstream: 'http://localhost:4142' }, { typoQuality: 90 }, { logLevel: 'verbose' },
    { logLevel: null }, { logLevel: 0 }, null, []]) {
    assert.throws(() => validateConfig(invalid));
  }
});

test('missing explicit configuration fails; default lookup may use defaults; UTF8 BOM works', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-image-proxy-config-'));
  try {
    const path = join(dir, 'config.json');
    assert.throws(() => loadConfig(path));
    assert.deepEqual(loadConfig(path, { allowMissing: true }), DEFAULT_CONFIG);
    writeFileSync(path, '\ufeff{"jpegQuality":90}');
    assert.equal(loadConfig(path).jpegQuality, 90);
    writeFileSync(path, '{ invalid');
    assert.throws(() => loadConfig(path), /invalid JSON/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('managed startup validates the derived upstream instead of an ignored configured endpoint', () => {
  const initial = validateConfig({port:4141}, {skipUpstream:true});
  const effective = validateConfig({...initial,upstream:'http://127.0.0.1:4143'}, {managedUpstream:true});
  assert.equal(effective.port,4141);
  assert.equal(effective.upstream,'http://127.0.0.1:4143');
  assert.throws(()=>validateConfig({...initial,upstream:'http://127.0.0.1:4141'},{managedUpstream:true}));
});

test('session index configuration allows the default or an explicit path without requiring a file', () => {
  assert.equal(validateConfig().sessionIndexPath, null);
  const path = join(tmpdir(), 'copilot-image-proxy-missing-index', 'session_index.jsonl');
  assert.equal(validateConfig({ sessionIndexPath: path }).sessionIndexPath, path);
  assert.equal(validateConfig({ sessionIndexPath: './session_index.jsonl' }).sessionIndexPath, './session_index.jsonl');
  for (const sessionIndexPath of ['', ' \t\n', 0, false, [], {}, undefined]) {
    assert.throws(() => validateConfig({ sessionIndexPath }), /sessionIndexPath/);
    assert.throws(() => validateConfig({ sessionIndexPath }, { skipUpstream: true }), /sessionIndexPath/);
  }
});

test('usage range config accepts lazy database paths and fixed offsets only', () => {
  assert.equal(validateConfig().sqliteDbPath, null);
  assert.equal(validateConfig().usageTimezone, '+08:00');
  assert.equal(validateConfig({ sqliteDbPath: './missing.sqlite' }).sqliteDbPath, './missing.sqlite');
  for (const usageTimezone of ['Z', '+00:00', '-03:30', '+14:00', '-14:00']) {
    assert.equal(validateConfig({ usageTimezone }).usageTimezone, usageTimezone);
  }
  for (const sqliteDbPath of ['', ' \t', false, 1, [], {}, undefined]) {
    assert.throws(() => validateConfig({ sqliteDbPath }), /sqliteDbPath/);
  }
  for (const usageTimezone of ['', '+0800', 'Asia/Singapore', '+14:01', '-15:00', '+01:60', null, 8]) {
    assert.throws(() => validateConfig({ usageTimezone }), /usageTimezone/);
    assert.throws(() => validateConfig({ usageTimezone }, { skipUpstream: true }), /usageTimezone/);
  }
});
