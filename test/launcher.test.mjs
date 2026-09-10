import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInvocation } from '../src/index.mjs';
import { launchContextDigest } from '../src/launch-context.mjs';
import { mkdtempSync, symlinkSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('empty invocation preserves the requested default start --proxy-env', () => {
  assert.deepEqual(parseInvocation([]).argv, ['start', '--proxy-env']);
});

test('separator preserves all original command arguments without shell interpretation', () => {
  const args = ['auth', 'keys', '--add', 'a b"&|<>%中文\\tail', '', '--config', 'upstream-config'];
  const result = parseInvocation(['--config', 'proxy.json', '--', ...args], 'C:\\scratch');
  assert.deepEqual(result.argv, args);
  assert.equal(result.configPath, 'C:\\scratch\\proxy.json');
  assert.equal(result.explicitConfig, true);
});

test('direct commands and official help pass through; proxy options must precede command', () => {
  for (const args of [['--help'], ['start', '--help'], ['debug', '--json'], ['mcp'], ['future', '--config', 'upstream']]) {
    assert.deepEqual(parseInvocation(args).argv, args);
  }
  assert.throws(() => parseInvocation(['--config']));
});

test('start identity distinguishes cwd, binding and inherited proxy environment without storing secrets', () => {
  const args = ['start', '--proxy-env'];
  const base = launchContextDigest(args, 'C:\\a', {});
  assert.equal(base, launchContextDigest(args, 'c:\\a', {}));
  assert.notEqual(base, launchContextDigest(args, 'C:\\b', {}));
  assert.notEqual(base, launchContextDigest(args, 'C:\\a', { HOST: '::1' }));
  assert.notEqual(base, launchContextDigest(args, 'C:\\a', { HTTPS_PROXY: 'http://example.invalid' }));
  assert.match(base, /^[a-f0-9]{64}$/);
});

test('npm-link style junction entry executes the CLI rather than silently returning', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'cip-linked-entry-'));
  const alias = join(temporary, 'linked-project');
  try {
    symlinkSync(fileURLToPath(new URL('..', import.meta.url)), alias, 'junction');
    const result = spawnSync(process.execPath, [join(alias,'src','index.mjs'),'--proxy-help'], {encoding:'utf8',timeout:10000});
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /official latest copilot-api/);
  } finally { try { unlinkSync(alias); } finally { rmdirSync(temporary); } }
});
