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
