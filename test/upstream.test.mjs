import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { classifyCopilotArgs, resolveBinding, resolveLatestPackage } from '../src/upstream.mjs';
import { locateInstalledPackage } from '../src/locate-package.mjs';

const MOCK_NPM = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const pathKeys = Object.keys(process.env).filter((key) => key.toLowerCase() === 'path');
fs.appendFileSync(process.env.CIP_TEST_RECORD, JSON.stringify({ args, cwd: process.cwd(), pathKeys,
  pathFirst: (process.env[pathKeys[0]] || '').split(path.delimiter)[0] }) + '\n');
const mode = process.env.CIP_TEST_MODE || 'ok';
if (args[0] === 'view') {
  if (mode === 'lookup-fail') {
    process.stderr.write(process.env.CIP_TEST_SECRET);
    process.exit(42);
  }
  if (mode === 'lookup-invalid') process.stdout.write(process.env.CIP_TEST_INVALID);
  else process.stdout.write(JSON.stringify(process.env.CIP_TEST_VERSION || '2.5.3') + '\n');
} else if (args[0] === 'exec') {
  if (mode === 'install-fail') {
    process.stderr.write(process.env.CIP_TEST_SECRET);
    process.exit(23);
  }
  if (mode === 'abort-wait') {
    setTimeout(() => process.exit(0), 10000);
  } else if (mode === 'missing-marker') {
    process.stdout.write('unrelated npm output\n{"version":"2.5.3"}\n');
  } else {
    const separator = args.indexOf('--');
    const command = args[separator + 1];
    const commandArgs = args.slice(separator + 2);
    const env = { ...process.env };
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
    const originalPath = env[pathKey] || '';
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    env[pathKey] = process.env.CIP_TEST_BIN + path.delimiter + originalPath;
    const child = spawnSync(command, commandArgs, { env, cwd: process.cwd(), encoding: 'utf8', shell: false });
    process.stdout.write('npm notice: mock preparation output\n{"version":"0.0.0","binPath":"wrong"}\n');
    let output = child.stdout || '';
    if (mode === 'wrong-version') output = output.replace('"version":"2.5.3"', '"version":"9.9.9"');
    process.stdout.write(output);
    if (mode === 'duplicate-marker') process.stdout.write(output);
    process.stderr.write(child.stderr || '');
    process.exitCode = child.status === null ? 1 : child.status;
  }
} else {
  process.exitCode = 99;
}
`;

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'copilot-upstream-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'owned project 空格 & %');
  const cacheModules = path.join(root, 'npm cache 中文 & %', 'node_modules');
  const binDirectory = path.join(cacheModules, '.bin');
  const packageDirectory = path.join(cacheModules, '@jeffreycao', 'copilot-api');
  const binPath = path.join(packageDirectory, 'dist', 'main.js');
  const npmCli = path.join(root, 'mock npm', 'npm-cli.js');
  const record = path.join(root, 'calls.jsonl');
  await Promise.all([
    mkdir(cwd, { recursive: true }), mkdir(binDirectory, { recursive: true }),
    mkdir(path.dirname(binPath), { recursive: true }), mkdir(path.dirname(npmCli), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(npmCli, MOCK_NPM),
    writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'copilot-image-proxy', private: true })),
    writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({
      name: '@jeffreycao/copilot-api', version: '2.5.3', bin: { 'copilot-api': './dist/main.js' },
    })),
    writeFile(binPath, 'throw new Error("THE_DOWNLOADED_PACKAGE_MUST_NOT_EXECUTE_DURING_RESOLUTION");\n'),
  ]);
  const env = {
    ...process.env, npm_execpath: npmCli, CIP_TEST_RECORD: record, CIP_TEST_BIN: binDirectory,
    CIP_TEST_SECRET: 'SENTINEL_NOT_FOR_LOGS', ...overrides,
  };
  return {
    root, cwd, packageDirectory, binDirectory, binPath, env,
    calls: async () => (await readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)),
  };
}

test('classifies only server starts and preserves all raw arguments', () => {
  const cases = [
    [[], false], [['start'], true], [['start', '--proxy-env'], true],
    [['auth', 'login', '--provider', 'copilot'], false], [['auth', 'keys', '--list'], false],
    [['debug', '--json'], false], [['mcp', '--name', '汉字 & | > < % "'], false],
    [['--help'], false], [['help'], false], [['--version'], false],
    [['start', '--help'], false], [['start', '-h'], false], [['start', '--', '--help'], false],
    [['future-command', '--future-option'], false], [['--api-home', 'dir', 'start'], false],
    [['start', '--version'], true],
  ];
  for (const [args, managed] of cases) {
    const frozen = Object.freeze([...args]);
    assert.deepEqual(classifyCopilotArgs(frozen), { managed });
    assert.deepEqual(frozen, args);
  }
  assert.throws(() => classifyCopilotArgs(['start', 'bad\0argument']), { code: 'UPSTREAM_INVALID_ARGV' });
});

test('resolves default, environment, IPv6, wildcard, and LAN bindings without editing argv', () => {
  assert.deepEqual(resolveBinding(['start'], {}), { host: '127.0.0.1', port: 4141, connectHost: '127.0.0.1' });
  assert.deepEqual(resolveBinding(['start'], { HOST: ' LOCALHOST ' }), { host: 'LOCALHOST', port: 4141, connectHost: 'localhost' });
  assert.deepEqual(resolveBinding(['start', '--host', '[::1]', '--port=5151'], {}), { host: '::1', port: 5151, connectHost: '::1' });
  for (const host of ['0.0.0.0', '::', '[::]']) {
    assert.equal(resolveBinding(['start', '--host', host], {}).connectHost, '127.0.0.1');
  }
  assert.deepEqual(resolveBinding(['start', '--host=192.168.1.20', '-p=5123'], {}), {
    host: '192.168.1.20', port: 5123, connectHost: '192.168.1.20',
  });
  const args = Object.freeze(['start', '--unknown', '空 格 " & | < > %', '--port', '5000']);
  assert.equal(resolveBinding(args, {}).port, 5000);
  assert.equal(args[2], '空 格 " & | < > %');
  assert.equal(resolveBinding(['start', '--', '--port', '9999'], {}).port, 4141);
});

test('classifies commands after leading globals using verified citty raw-argv semantics', () => {
  const cases = [
    [['--api-home=目录 with spaces', 'start', '--port', '5151'], true, 5151],
    [['--oauth-app=demo', '--enterprise-url=https://example.invalid', 'start', '-p=5152'], true, 5152],
    [['--api-home=start', 'auth', 'login'], false],
    [['--oauth-app=start', 'debug', '--json'], false],
    [['--enterprise-url=start', 'mcp'], false],
    [['--api-home=folder', 'future-command', 'start'], false],
    [['--api-home=folder', 'start', '--help'], false],
    [['--api-home=folder', '--help', 'start'], false],
    // Separated leading values are commands to current upstream citty. A normal
    // directory value errors upstream, whereas the literal value "start" really
    // selects the server command. Neither case is corrected or reordered here.
    [['--api-home', 'folder', 'start', '--port', '5151'], false],
    [['--oauth-app', 'demo', 'start'], false],
    [['--enterprise-url', 'https://example.invalid', 'start'], false],
    [['--api-home', 'start', '--port', '5151'], true, 5151],
    [['start', '--api-home', 'start', '--port', '5153'], true, 5153],
    [['--api-home=folder', '--port=4999', 'start'], true, 4141],
    [['--api-home=folder', '--port=4999', 'start', '--port', '5154'], true, 5154],
  ];
  for (const [input, managed, port] of cases) {
    const argv = Object.freeze([...input]);
    assert.deepEqual(classifyCopilotArgs(argv), { managed }, JSON.stringify(input));
    if (managed) assert.equal(resolveBinding(argv, {}).port, port, JSON.stringify(input));
    assert.deepEqual(argv, input);
  }
});

test('matches verified citty duplicate-option, alias, and parseInt behavior', () => {
  for (const options of [
    ['--port', '5000', '--port', '6000'], ['-p', '5000', '--port', '6000'],
    ['--port', '5000', '-p', '6000'], ['--port=5000', '--port=6000'],
    ['-p=5000'], ['--port', '5000junk'], ['--port', '5000.5'],
  ]) assert.equal(resolveBinding(['start', ...options], {}).port, 5000, JSON.stringify(options));
  for (const options of [
    ['-p5000'], ['--port'], ['--port='], ['--port', '-1'], ['--port', '0'], ['--port', '65536'],
    ['--no-port'], ['--port', '5000', '--no-port'], ['--host', 'a', '--host', 'b'],
    ['--host', 'http://127.0.0.1'], ['--host', ''],
  ]) assert.throws(() => resolveBinding(['start', ...options], {}), { code: 'UPSTREAM_INVALID_BINDING' });
});

test('resolves online latest, pins the exact package version, and ignores unrelated npm stdout', async (t) => {
  const f = await fixture(t);
  const events = [];
  const actual = await resolveLatestPackage({ cwd: f.cwd, env: f.env, log: (event) => events.push(event) });
  assert.deepEqual(actual, {
    version: '2.5.3', binPath: await realpath(f.binPath), nodePath: await realpath(process.execPath),
    binDirectory: await realpath(f.binDirectory),
  });
  const calls = await f.calls();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cwd, f.cwd);
  assert.equal(calls[1].cwd, f.cwd);
  assert.deepEqual(calls[0].args.slice(0, 4), ['view', '@jeffreycao/copilot-api@latest', 'version', '--json']);
  assert.ok(calls[0].args.includes('--prefer-online'));
  const metadataCache = calls[0].args[calls[0].args.indexOf('--cache') + 1];
  await assert.rejects(access(metadataCache));
  assert.ok(calls[1].args.includes('--package=@jeffreycao/copilot-api@2.5.3'));
  assert.ok(!calls[1].args.some((arg) => arg.includes('@latest')));
  assert.ok(!calls[1].args.includes('--cache'));
  const separator = calls[1].args.indexOf('--');
  assert.equal(calls[1].args[separator + 1], 'node');
  assert.equal(path.basename(calls[1].args[separator + 2]), 'locate-package.mjs');
  assert.equal(calls[1].args.length, separator + 3);
  for (const call of calls) {
    assert.equal(call.pathKeys.length, 1);
    assert.equal(call.pathFirst, path.dirname(await realpath(process.execPath)));
  }
  assert.deepEqual(events.map((entry) => entry.phase), ['resolve-latest', 'prepare-package', 'package-ready']);
  assert.ok(!JSON.stringify(events).includes(f.env.CIP_TEST_SECRET));
});

test('npm receives one PATH key with the exact current Node directory first', async (t) => {
  const f = await fixture(t);
  const originalPath = Object.entries(f.env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  f.env.Path = originalPath;
  f.env.PATH = path.join(f.root, 'unrelated runtime');
  const actual = await resolveLatestPackage({ cwd: f.cwd, env: f.env });
  assert.equal(actual.nodePath, await realpath(process.execPath));
  for (const call of await f.calls()) {
    assert.equal(call.pathKeys.length, 1);
    assert.equal(call.pathFirst, path.dirname(actual.nodePath));
  }
});

test('latest lookup failure never falls back to the available cached package', async (t) => {
  const f = await fixture(t, { CIP_TEST_MODE: 'lookup-fail' });
  const events = [];
  await assert.rejects(resolveLatestPackage({ cwd: f.cwd, env: f.env, log: (entry) => events.push(entry) }),
    (error) => error.code === 'UPSTREAM_NPM_FAILED' && error.exitCode === 42 && !error.message.includes(f.env.CIP_TEST_SECRET));
  const calls = await f.calls();
  assert.equal(calls.length, 1);
  await assert.rejects(access(calls[0].args[calls[0].args.indexOf('--cache') + 1]));
  assert.ok(!JSON.stringify(events).includes(f.env.CIP_TEST_SECRET));
});

test('invalid latest output is rejected before preparing a package', async (t) => {
  for (const invalid of ['not-json', '"2.5.3; echo unsafe"', '["2.5.2","2.5.3"]', '"2.5.3\\n"']) {
    await t.test(invalid, async (t) => {
      const f = await fixture(t, { CIP_TEST_MODE: 'lookup-invalid', CIP_TEST_INVALID: invalid });
      await assert.rejects(resolveLatestPackage({ cwd: f.cwd, env: f.env }), { code: 'UPSTREAM_INVALID_LATEST' });
      assert.equal((await f.calls()).length, 1);
    });
  }
});

test('package preparation failure and invalid locator output are explicit failures', async (t) => {
  for (const [mode, code] of [
    ['install-fail', 'UPSTREAM_NPM_FAILED'], ['missing-marker', 'UPSTREAM_INVALID_LOCATION'],
    ['duplicate-marker', 'UPSTREAM_INVALID_LOCATION'], ['wrong-version', 'UPSTREAM_INVALID_LOCATION'],
  ]) {
    await t.test(mode, async (t) => {
      const f = await fixture(t, { CIP_TEST_MODE: mode });
      await assert.rejects(resolveLatestPackage({ cwd: f.cwd, env: f.env }), (error) =>
        error.code === code && !error.message.includes(f.env.CIP_TEST_SECRET));
      assert.equal((await f.calls()).length, 2);
    });
  }
});

test('locator requires matching metadata and an in-package bin, without executing package code', async (t) => {
  const f = await fixture(t);
  const location = await locateInstalledPackage({ version: '2.5.3', env: { PATH: f.binDirectory } });
  assert.equal(location.binPath, await realpath(f.binPath));
  await assert.rejects(locateInstalledPackage({ version: '2.5.4', env: { PATH: f.binDirectory } }), /exact copilot-api package version/);
  await assert.rejects(locateInstalledPackage({ version: '2.5.3', env: { PATH: f.packageDirectory } }), /exact copilot-api package version/);
  const outside = path.join(path.dirname(f.packageDirectory), 'outside.js');
  await writeFile(outside, 'throw new Error("NOT_EXECUTED");');
  await writeFile(path.join(f.packageDirectory, 'package.json'), JSON.stringify({
    name: '@jeffreycao/copilot-api', version: '2.5.3', bin: { 'copilot-api': '../outside.js' },
  }));
  await assert.rejects(locateInstalledPackage({ version: '2.5.3', env: { PATH: f.binDirectory } }), /inside its package/);
});

test('pre-aborted preparation starts no npm command', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(resolveLatestPackage({ cwd: f.cwd, env: f.env, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(f.calls(), { code: 'ENOENT' });
});

test('cancelling package preparation stops the mock npm process and rejects promptly', async (t) => {
  const f = await fixture(t, { CIP_TEST_MODE: 'abort-wait' });
  const controller = new AbortController();
  const preparation = resolveLatestPackage({ cwd: f.cwd, env: f.env, signal: controller.signal });
  const rejected = assert.rejects(preparation, { name: 'AbortError' });
  const deadline = Date.now() + 3000;
  let preparing = false;
  while (Date.now() < deadline) {
    try { preparing = (await f.calls()).length === 2; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (preparing) break;
    await delay(10);
  }
  controller.abort();
  await rejected;
  assert.equal(preparing, true, 'mock npm reached the package-preparation stage before cancellation');
});
