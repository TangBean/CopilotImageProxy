import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile, copyFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { controlRequest } from '../src/control.mjs';
import { buildSupervisor } from '../scripts/build-supervisor.mjs';

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

test('stop script safely reclaims its verified JobHost when control authentication fails', {
  skip: process.platform !== 'win32', timeout: 20000,
}, async (t) => {
  const tempRoot = join(projectRoot, 'test', '.tmp');
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, 'stop-fallback-review-'));
  for (const child of ['scripts', 'src', 'bin', '.run']) await mkdir(join(directory, child));
  const managerPath = join(directory, 'bin', 'JobHost.exe');
  const entryPath = join(directory, 'src', 'fixture.mjs');
  await Promise.all([
    copyFile(buildSupervisor(), managerPath),
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
