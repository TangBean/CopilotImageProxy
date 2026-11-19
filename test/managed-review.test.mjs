import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, copyFile, access } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { controlRequest } from '../src/control.mjs';
import { buildSupervisor } from '../scripts/build-supervisor.mjs';
import { createUpstreamPackageFixture } from './helpers/upstream-package.mjs';
import { createUsageDb } from './helpers/usage-db.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('background start resolves an absolute config before validation from a different working directory', {
  skip: process.platform !== 'win32', timeout: 15000,
}, async (t) => {
  const tempRoot = join(projectRoot, 'test', '.tmp');
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, 'absolute-config-review-'));
  t.after(async () => {
    const target = resolve(directory);
    assert.ok(target.startsWith(resolve(tempRoot) + '\\'));
    await rm(target, { recursive: true, force: true });
  });
  const configPath = join(directory, '绝对 config.json');
  // Deliberately invalid: start.ps1 must stop in its initial configuration query,
  // before any lifecycle lock, npm operation, supervisor, or service is started.
  await writeFile(configPath, JSON.stringify({ port: -1 }));
  const result = spawnSync('pwsh.exe', [
    '-NoProfile', '-NonInteractive', '-File', join(projectRoot, 'scripts', 'start.ps1'), '-Config', configPath,
  ], { cwd: directory, encoding: 'utf8', windowsHide: true, shell: false, timeout: 10000 });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /Missing proxy config:/);
  assert.match(result.stderr, /port must be an integer between 1 and 65535/);
});

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function until(check, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error(`Timed out: ${description}`);
}

test('managed usage HTTP requests read the database in the child CLI home', {
  skip: process.platform !== 'win32', timeout: 20000,
}, async t => {
  const f = await createUpstreamPackageFixture(t);
  const day = 86400000;
  const midnight = Math.floor(Date.now() / day) * day;
  async function home(model) {
    const rows = [midnight - day, midnight].map(created_at_ms => ({
      created_at_ms, model, input_tokens: 10, output_tokens: 20,
      request_id: String(created_at_ms), first_token_ms: 500, duration_ms: 1500, request_outcome: 'completed',
    }));
    const db = await createUsageDb(t, rows);
    return dirname(db.path);
  }
  const [inheritedHome, cliHome] = await Promise.all([home('inherited-model'), home('cli-model')]);
  const listeners = [net.createServer(), net.createServer()];
  let proxyPort, upstreamPort;
  try {
    await Promise.all(listeners.map(s => once(s.listen(0, '127.0.0.1'), 'listening')));
    [proxyPort, upstreamPort] = listeners.map(s => s.address().port);
  } finally {
    await Promise.all(listeners.filter(s => s.listening).map(s => new Promise(resolve => s.close(resolve))));
  }
  const configPath = join(f.cwd, 'config.json');
  await writeFile(configPath, JSON.stringify({ port: proxyPort, usageTimezone: 'Z' }));
  await writeFile(f.binPath, `
    const http = require('node:http');
    const range = { start_ms: ${midnight}, end_ms: ${midnight + day} };
    http.createServer((req, res) => {
      if (req.url === '/token-usage/events?period=today&page_size=1') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ period: 'today', range, items: [] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    }).listen(Number(process.argv.at(-1)), '127.0.0.1');
  `);
  const managerPath = buildSupervisor();
  const spec = { argv: ['start', '--host', '127.0.0.1', '--api-home', relative(f.cwd, cliHome), '--port', String(upstreamPort)],
    cwd: f.cwd, projectRoot: f.cwd, configPath, explicitConfig: true, managerPath, launcherPid: process.pid, runId: randomUUID() };
  const env = { ...f.env, USERPROFILE: f.root, HOME: f.root, COPILOT_API_HOME: inheritedHome,
    CIP_JOB_PIPE: `cip-usage-${randomUUID()}`, CIP_JOB_TOKEN: randomUUID(), CIP_RUN_SPEC: JSON.stringify(spec) };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'COPILOT_API_SQLITE_DB_PATH') delete env[key];
  }
  const manager = spawn(managerPath, ['--parent-pid', String(process.pid), '--node', process.execPath, '--entry', join(projectRoot, 'src', 'managed.mjs')], {
    cwd: f.cwd, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostics = '';
  manager.stderr.on('data', chunk => { diagnostics += chunk; });
  const exited = once(manager, 'exit');
  try {
    await until(() => {
      if (manager.exitCode !== null) throw new Error(`Fixture startup failed: ${diagnostics}`);
      return diagnostics.includes('"event":"ready"');
    }, 'managed usage fixture is ready');
    const read = async route => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}${route}`);
      assert.equal(response.status, 200);
      return response.json();
    };
    const [daily, hourly] = await Promise.all([read('/token-usage?period=-1d'), read('/token-usage/hourly?period=today')]);
    assert.deepEqual(daily.byModel.map(row => row.model), ['cli-model']);
    assert.deepEqual(hourly.hours[0].byModel, [{ model: 'cli-model', output_tokens_per_second: 20 }]);
  } finally {
    if (manager.exitCode === null && manager.signalCode === null) manager.kill('SIGKILL');
    await exited;
  }
});

test('stop script safely reclaims its verified JobHost when control authentication fails', {
  skip: process.platform !== 'win32', timeout: 20000,
}, async (t) => {
  for (const versioned of [false, true]) {
    await t.test(versioned ? 'hashed executable' : 'legacy executable', async t => {
      const tempRoot = join(projectRoot, 'test', '.tmp');
      await mkdir(tempRoot, { recursive: true });
      const directory = await mkdtemp(join(tempRoot, 'stop-fallback-review-'));
      for (const child of ['scripts', 'src', 'bin', '.run']) await mkdir(join(directory, child));
      const binary = buildSupervisor();
      const managerPath = join(directory, 'bin', versioned ? basename(binary) : 'JobHost.exe');
      const entryPath = join(directory, 'src', 'fixture.mjs');
      await Promise.all([
        copyFile(binary, managerPath),
        copyFile(join(projectRoot, 'scripts', 'stop.ps1'), join(directory, 'scripts', 'stop.ps1')),
        copyFile(join(projectRoot, 'src', 'control.mjs'), join(directory, 'src', 'control.mjs')),
        writeFile(entryPath, `
    import { spawn } from 'node:child_process';
    const role = process.argv[2] || 'root';
    process.stdout.write(JSON.stringify({ role, pid: process.pid }) + '\\n');
    if (role === 'root') spawn(process.execPath, [process.argv[1], 'child'], { stdio: 'inherit', shell: false });
    setInterval(() => {}, 1000);
    `),
      ]);
      const pipe = `cip-review-${randomUUID()}`;
      const actualToken = randomUUID();
      const manager = spawn(managerPath, ['--parent-pid', String(process.pid), '--node', process.execPath, '--entry', entryPath], {
        cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
        env: { ...process.env, CIP_JOB_PIPE: pipe, CIP_JOB_TOKEN: actualToken },
      });
      let remainder = '';
      const descendants = [];
      manager.stdout.on('data', (chunk) => {
        remainder += chunk;
        const lines = remainder.split('\n'); remainder = lines.pop();
        for (const line of lines) descendants.push(JSON.parse(line));
      });
      manager.stderr.resume();
      const exited = once(manager, 'exit');
      t.after(async () => {
        if (manager.exitCode === null && manager.signalCode === null) manager.kill('SIGKILL');
        await exited;
        await until(() => descendants.every((child) => !alive(child.pid)), 'fixture descendants exit');
        const target = resolve(directory);
        assert.ok(target.startsWith(resolve(tempRoot) + '\\'));
        await rm(target, { recursive: true, force: true });
      });
      await until(() => descendants.length === 2, 'fixture parent and child start');
      const ping = await controlRequest(pipe, 'ping', actualToken);
      assert.equal(ping.ok, true);
      const statePath = join(directory, '.run', 'service.json');
      await writeFile(statePath, JSON.stringify({
        managerPath, managerPid: manager.pid, managerStartTimeUtcTicks: ping.startTimeUtcTicks,
        runId: randomUUID(), jobPipe: pipe, appPipe: `${pipe}-unused`, controlToken: 'intentionally-invalid-fixture-token',
      }));
      const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', join(directory, 'scripts', 'stop.ps1')], {
        cwd: directory, encoding: 'utf8', windowsHide: true, shell: false, timeout: 15000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /recorded process identity does not match/);
      await exited;
      await until(() => descendants.every((child) => !alive(child.pid)), 'fallback terminates the complete fixture Job');
      await assert.rejects(access(statePath), { code: 'ENOENT' });
    });
  }
});
