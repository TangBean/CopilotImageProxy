import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildSupervisor } from '../scripts/build-supervisor.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const timeout = 15_000;
const supported = process.platform === 'win32';
let executable;
if (supported) executable = buildSupervisor();

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function until(check, description, milliseconds = 7000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(30);
  }
  throw new Error(`Timed out: ${description}`);
}

async function control(pipe, token, verb = 'ping', argument) {
  return new Promise((resolveResult, reject) => {
    const client = net.connect(`\\\\.\\pipe\\${pipe}`);
    let text = '';
    client.setTimeout(3000, () => client.destroy(new Error('Control pipe timeout')));
    client.once('connect', () => client.write(`${verb} ${token}${argument === undefined ? '' : ` ${argument}`}\n`));
    client.on('data', (chunk) => {
      text += chunk;
      if (text.includes('\n')) {
        try { resolveResult(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); }
        client.destroy();
      }
    });
    client.on('error', reject);
    client.once('end', () => { if (!text.includes('\n')) reject(new Error('No control response')); });
  });
}

const fixture = `
import net from 'node:net';
import { spawn } from 'node:child_process';
const spec = JSON.parse(process.env.CIP_RUN_SPEC);
delete process.env.CIP_RUN_SPEC;
const role = process.argv[2] || 'managed';
const server = net.createServer(socket => socket.end('fixture'));
server.listen(0, role === 'grandchild' ? '::1' : '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({role,pid:process.pid,port:server.address().port,hostPid:process.env.CIP_JOB_HOST_PID,specMarker:spec.marker})+'\\n');
  if (role !== 'grandchild') spawn(process.execPath,[process.argv[1],role==='managed'?'child':'grandchild'], {
    stdio:['ignore','inherit','inherit'],env:{...process.env,CIP_RUN_SPEC:JSON.stringify(spec)}
  });
  if (role === 'managed' && spec.exitAfterMs) setTimeout(() => process.exit(spec.exitCode || 0), spec.exitAfterMs);
});
process.on('SIGBREAK', () => process.exit(0));
if (role === 'managed' && spec.stdinEcho) process.stdin.once('data', chunk => process.stdout.write(JSON.stringify({role:'stdin',pid:process.pid,value:chunk.toString()})+'\\n'));
`;

async function launch(t, options = {}) {
  const tempRoot = join(projectRoot, 'test', '.tmp');
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(join(tempRoot, 'job-host-'));
  const entry = join(directory, 'fixture.mjs');
  await writeFile(entry, fixture);
  const pipe = `cip-test-${randomUUID()}`;
  const token = randomUUID();
  const spec = { marker: 'job-host-test', ...options.spec };
  const host = spawn(executable, ['--parent-pid', String(options.parentPid || process.pid), '--node', process.execPath, '--entry', entry], {
    env: { ...process.env, CIP_JOB_PIPE: pipe, CIP_JOB_TOKEN: token, CIP_RUN_SPEC: JSON.stringify(spec) },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let stderr = '', stdout = '', remainder = '';
  const rows = [];
  host.stdout.on('data', (chunk) => {
    stdout += chunk; remainder += chunk;
    const lines = remainder.split('\n'); remainder = lines.pop();
    for (const line of lines) { try { rows.push(JSON.parse(line)); } catch {} }
  });
  host.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = once(host, 'exit').then(([code, signal]) => ({ code, signal }));
  t.after(async () => {
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
    await exit;
    await until(() => rows.every((row) => !alive(row.pid)), 'test descendants cleanup');
    // directory is generated directly beneath this test's workspace-only temp root.
    const resolved = resolve(directory);
    assert.ok(resolved.startsWith(resolve(tempRoot) + '\\'));
    await rm(resolved, { recursive: true, force: true });
  });
  await until(() => {
    if (host.exitCode !== null || host.signalCode !== null) throw new Error(`JobHost exited during fixture startup: ${stderr}`);
    return rows.length === 3;
  }, 'three fixture generations started');
  assert.equal(new Set(rows.map((row) => row.pid)).size, 3);
  return { host, rows, pipe, token, exit, logs: () => ({ stderr, stdout }) };
}

test('JobHost authenticates its pipe and preserves child environment and stdio', { timeout, skip: !supported }, async (t) => {
  const env = await launch(t);
  const ping = await control(env.pipe, env.token);
  assert.equal(ping.ok, true);
  assert.equal(ping.pid, env.host.pid);
  assert.equal(ping.childPid, env.rows.find((row) => row.role === 'managed').pid);
  assert.equal(ping.parentPid, process.pid);
  assert.match(ping.startTimeUtcTicks, /^\d+$/);
  assert.ok(env.rows.every((row) => row.hostPid === String(env.host.pid) && row.specMarker === 'job-host-test'));
  const denied = await control(env.pipe, 'invalid-token', 'stop');
  assert.equal(denied.ok, false);
  assert.ok(alive(env.host.pid));
  assert.ok(!JSON.stringify(env.logs()).includes(env.token));
});

test('normal managed process exit propagates its exit code and cleans all descendants', { timeout, skip: !supported }, async (t) => {
  const env = await launch(t, { spec: { exitAfterMs: 1500, exitCode: 23 } });
  const result = await env.exit;
  assert.equal(result.code, 23);
  await until(() => env.rows.every((row) => !alive(row.pid)), 'descendants exited after normal managed exit');
});

test('inherits usable standard input for interactive upstream authentication', { timeout, skip: !supported }, async (t) => {
  const env = await launch(t, { spec: { stdinEcho: true } });
  env.host.stdin.write('test-input-through-job-host\n');
  await until(() => env.rows.some((row) => row.role === 'stdin'), 'inherited stdin reaches managed Node');
  assert.equal(env.rows.find((row) => row.role === 'stdin').value, 'test-input-through-job-host\n');
});

test('hard killing JobHost makes Windows kill every managed generation', { timeout, skip: !supported }, async (t) => {
  const env = await launch(t);
  env.host.kill('SIGKILL');
  await env.exit;
  await until(() => env.rows.every((row) => !alive(row.pid)), 'Job kill-on-close after helper hard kill');
});

test('hard killing managed Node cleans its children and exits JobHost', { timeout, skip: !supported }, async (t) => {
  const env = await launch(t);
  process.kill(env.rows.find((row) => row.role === 'managed').pid, 'SIGKILL');
  await env.exit;
  await until(() => env.rows.every((row) => !alive(row.pid)), 'descendants exited after managed hard kill');
});

test('outer parent death closes the job and terminates all managed descendants', { timeout, skip: !supported }, async (t) => {
  const parent = spawn(process.execPath, ['-e', 'setInterval(()=>{},10000)'], { stdio: 'ignore', windowsHide: true });
  const parentExit = once(parent, 'exit');
  t.after(async () => { if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL'); await parentExit; });
  const env = await launch(t, { parentPid: parent.pid });
  parent.kill('SIGKILL');
  assert.equal((await env.exit).code, 1);
  await until(() => env.rows.every((row) => !alive(row.pid)), 'descendants exited after outer parent hard kill');
});

test('authenticated stop acknowledges and terminates the complete job', { timeout, skip: !supported }, async (t) => {
  const env = await launch(t);
  assert.deepEqual(await control(env.pipe, env.token, 'stop'), { ok: true });
  assert.equal((await env.exit).code, 0);
  await until(() => env.rows.every((row) => !alive(row.pid)), 'descendants exited after stop');
});

test('owns-port validates IPv4 and IPv6 descendants and rejects external or mixed owners', { timeout, skip: !supported }, async (t) => {
  const env = await launch(t);
  for (const row of env.rows) {
    const result = await control(env.pipe, env.token, 'owns-port', row.port);
    assert.equal(result.ok, true);
    assert.equal(result.owned, true, row.role);
    assert.ok(result.pids.includes(row.pid));
  }
  const outside = net.createServer();
  outside.listen(0, '127.0.0.1'); await once(outside, 'listening');
  t.after(() => new Promise((resolveClose) => outside.close(resolveClose)));
  const external = await control(env.pipe, env.token, 'owns-port', outside.address().port);
  assert.equal(external.owned, false);
  assert.ok(external.pids.includes(process.pid));
  const unused = net.createServer();
  unused.listen(0, '127.0.0.1'); await once(unused, 'listening');
  const unusedPort = unused.address().port; await new Promise((resolveClose) => unused.close(resolveClose));
  assert.deepEqual(await control(env.pipe, env.token, 'owns-port', unusedPort), { ok: true, owned: false, pids: [] });
  const managed = env.rows.find((row) => row.role === 'managed');
  const mixed = net.createServer();
  mixed.listen(managed.port, '127.0.0.2'); await once(mixed, 'listening');
  t.after(() => new Promise((resolveClose) => mixed.close(resolveClose)));
  const result = await control(env.pipe, env.token, 'owns-port', managed.port);
  assert.equal(result.owned, false);
  assert.ok(result.pids.includes(managed.pid) && result.pids.includes(process.pid));
});

test('invalid startup fails without leaking command tokens', { timeout, skip: !supported }, async () => {
  const sentinel = `SECRET-${randomUUID()}`;
  const child = spawn(executable, ['--bad', sentinel], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.ok(stderr.includes('JobHost:'));
  assert.ok(!stderr.includes(sentinel));
});
