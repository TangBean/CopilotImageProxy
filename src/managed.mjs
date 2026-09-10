import { readFile, writeFile, mkdir, rename, unlink, open, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import http from 'node:http';
import { loadConfig, validateConfig } from './config.mjs';
import { classifyCopilotArgs, resolveBinding, resolveLatestPackage } from './upstream.mjs';
import { controlRequest, pipePath } from './control.mjs';
import { VERSION } from './version.mjs';
import { launchContextDigest } from './launch-context.mjs';

const spec = JSON.parse(process.env.CIP_RUN_SPEC || 'null');
const jobPipe = process.env.CIP_JOB_PIPE;
const token = process.env.CIP_JOB_TOKEN;
const managerPid = Number(process.env.CIP_JOB_HOST_PID);
for (const name of ['CIP_RUN_SPEC', 'CIP_JOB_PIPE', 'CIP_JOB_TOKEN', 'CIP_JOB_HOST_PID']) delete process.env[name];
if (!spec || !jobPipe || !token || !Number.isInteger(managerPid) || managerPid < 1) {
  process.stderr.write('The managed entry must be started by the native supervisor.\n'); process.exit(1);
}
const log = (entry) => process.stderr.write(JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n');
const mode = classifyCopilotArgs(spec.argv);
let server, appControl, child, lockHandle, statePath, lockPath, state;
let stopping = false;
const aborter = new AbortController();
const appPipe = jobPipe + '-app';

async function releaseState() {
  if (statePath) {
    try { const current = JSON.parse(await readFile(statePath, 'utf8')); if (current.runId === spec.runId) await unlink(statePath); } catch {}
  }
  if (lockHandle) {
    await lockHandle.close(); lockHandle = null;
    try { const current = JSON.parse(await readFile(lockPath, 'utf8')); if (current.runId === spec.runId) await unlink(lockPath); } catch {}
  }
}

async function shutdown(code = 0) {
  if (stopping) return; stopping = true;
  aborter.abort();
  if (mode.managed) log({ event: 'stopping' });
  if (server) {
    await Promise.race([new Promise((r) => server.close(r)), new Promise((r) => setTimeout(r, 3000))]);
    server.closeAllConnections();
  }
  appControl?.close();
  await releaseState();
  process.exit(code); // JobHost observes this exit and terminates the owned descendants.
}

function canBind(host, port) {
  return new Promise((accept, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`Port ${port} is occupied or unavailable; no existing process was stopped.`)));
    probe.listen({ host, port, exclusive: true }, () => probe.close(accept));
  });
}

async function takeLock(runDir) {
  await mkdir(runDir, { recursive: true });
  if ((await lstat(runDir)).isSymbolicLink()) throw new Error('Refusing a redirected .run directory.');
  statePath = join(runDir, 'service.json'); lockPath = join(runDir, 'manager.lock');
  let previous;
  try { previous = JSON.parse(await readFile(statePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous?.jobPipe && previous.controlToken) {
    let alive = false;
    try { alive = (await controlRequest(previous.jobPipe, 'ping', previous.controlToken)).ok; } catch {}
    if (alive) throw new Error('Another managed proxy is already running. Stop it before restarting.');
  } else if (previous?.pid) {
    try { process.kill(previous.pid, 0); throw new Error('A previous service instance is still running.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  try { lockHandle = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previousLock = JSON.parse(await readFile(lockPath, 'utf8'));
    try { process.kill(previousLock.proxyPid, 0); throw new Error('Another proxy manager is running or its PID was reused.'); }
    catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
    await unlink(lockPath); lockHandle = await open(lockPath, 'wx');
  }
  await lockHandle.writeFile(JSON.stringify({ proxyPid: process.pid, managerPid, runId: spec.runId }));
}

function upstreamProbe(url, signal) {
  return new Promise((resolveProbe) => {
    const req = http.get(url, { signal, timeout: 1000 }, (res) => { res.resume(); resolveProbe(true); });
    req.once('timeout', () => { req.destroy(); resolveProbe(false); });
    req.once('error', () => resolveProbe(false));
  });
}

async function waitForUpstream(binding, config) {
  const deadline = Date.now() + config.upstreamStartupTimeoutMs;
  const bareHost = binding.connectHost.replace(/^\[|\]$/g, '');
  const hostname = bareHost.includes(':') ? `[${bareHost}]` : bareHost;
  const url = `http://${hostname}:${binding.port}`;
  while (Date.now() < deadline) {
    aborter.signal.throwIfAborted();
    if (child.exitCode !== null) throw new Error('copilot-api exited before becoming ready.');
    const ownership = await controlRequest(jobPipe, 'owns-port', token, binding.port);
    if (ownership.owned && await upstreamProbe(url, aborter.signal)) return url;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('copilot-api did not become ready before upstreamStartupTimeoutMs.');
}

async function startControl() {
  appControl = net.createServer((socket) => {
    let data = ''; let handled = false; socket.setTimeout(2000, () => socket.destroy());
    socket.on('data', (chunk) => {
      if (handled) return;
      data += chunk.toString('utf8'); if (data.length > 1024) return socket.destroy();
      if (!data.includes('\n')) return;
      handled = true;
      const [command, supplied] = data.trim().split(' ');
      const actual = Buffer.from(supplied || ''); const expected = Buffer.from(token);
      const valid = actual.length === expected.length && timingSafeEqual(actual, expected);
      socket.end(JSON.stringify({ ok: valid && command === 'stop' }) + '\n');
      if (valid && command === 'stop') setImmediate(() => shutdown(0));
    });
    socket.on('error', () => {});
  });
  appControl.listen(pipePath(appPipe));
  await once(appControl, 'listening');
}

async function saveState() {
  const temporary = statePath + '.' + spec.runId + '.tmp';
  await writeFile(temporary, JSON.stringify(state, null, 2) + '\n');
  await rename(temporary, statePath);
}

async function run() {
  let config;
  if (mode.managed) {
    config = loadConfig(spec.configPath, { allowMissing: !spec.explicitConfig, managedStart: true });
    await takeLock(resolve(spec.projectRoot, '.run'));
    const binding = resolveBinding(spec.argv, process.env);
    if (config.port === binding.port) throw new Error('Proxy and copilot-api cannot share the same port.');
    await canBind(config.host, config.port); await canBind(binding.host, binding.port);
    process.on('SIGINT', () => shutdown(0)); process.on('SIGTERM', () => shutdown(0)); process.on('SIGBREAK', () => shutdown(0));
    await startControl();
    const manager = await controlRequest(jobPipe, 'ping', token);
    const healthHost = config.host.includes(':') ? `[${config.host}]` : config.host;
    let configSource; try { configSource = await readFile(spec.configPath); } catch { configSource = Buffer.from('{}'); }
    state = { version: VERSION, status: 'starting', runId: spec.runId, managerPid,
      managerStartTimeUtcTicks: String(manager.startTimeUtcTicks), proxyPid: process.pid,
      launcherPid: spec.launcherPid, copilotPid: null, copilotVersion: null,
      managerPath: resolve(spec.projectRoot, 'bin/JobHost.exe'), entryPath: resolve(spec.projectRoot, 'src/index.mjs'),
      configPath: spec.configPath, configSha256: createHash('sha256').update(configSource).digest('hex').toUpperCase(),
      argsDigest: createHash('sha256').update(JSON.stringify(spec.argv)).digest('hex'),
      startupContextDigest: launchContextDigest(spec.argv, spec.cwd, process.env), callerCwd: spec.cwd,
      jobPipe, appPipe, controlToken: token, healthUrl: `http://${healthHost}:${config.port}/healthz`, upstream: null };
    await saveState();
  }
  const packageInfo = await resolveLatestPackage({ signal: aborter.signal, cwd: spec.projectRoot, env: process.env, log });
  const env = { ...process.env };
  if (packageInfo.binDirectory) {
    const existingPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    env.Path = packageInfo.binDirectory + ';' + existingPath;
  }
  child = spawn(packageInfo.nodePath || process.execPath, [packageInfo.binPath, ...spec.argv], {
    cwd: spec.cwd, env, stdio: 'inherit', shell: false, windowsHide: false,
  });
  const exitPromise = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolveExit(code ?? 1));
  });
  exitPromise.catch(() => {});
  if (!mode.managed) { process.exitCode = await exitPromise; return; }
  const binding = resolveBinding(spec.argv, env);
  const upstream = await Promise.race([waitForUpstream(binding, config), exitPromise.then((code) => {
    throw new Error(`copilot-api exited before startup completed (code ${code}).`);
  })]);
  config = validateConfig({ ...config, upstream }, { managedUpstream: true });
  const { createProxyServer } = await import('./server.mjs');
  server = createProxyServer({ config, log, managedUpstream: true });
  server.listen(config.port, config.host); await once(server, 'listening');
  server.on('error', () => shutdown(1));
  Object.assign(state, {status:'ready', copilotPid:child.pid, copilotVersion:packageInfo.version, upstream});
  await saveState();
  log({ event: 'ready', version: VERSION, proxyPort: config.port, upstreamPort: binding.port,
    managerPid, proxyPid: process.pid, copilotVersion: packageInfo.version });
  const code = await exitPromise;
  if (!stopping) { log({ event: 'upstream_exited', code }); await shutdown(code || 1); }
}

run().catch(async (error) => {
  if (stopping) return;
  log({ event: 'startup_error', message: error.message });
  await shutdown(1);
});
