import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const pipePath = (name) => name.startsWith('\\\\.\\pipe\\') ? name : `\\\\.\\pipe\\${name}`;

export function controlRequest(name, command, token, argument, timeoutMs = 2000) {
  return new Promise((resolveReply, reject) => {
    const socket = net.createConnection(pipePath(name));
    let buffer = ''; let settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolveReply(value);
    };
    const timer = setTimeout(() => finish(new Error('Control channel timed out')), timeoutMs);
    socket.once('connect', () => socket.write(`${command} ${token}${argument === undefined ? '' : ` ${argument}`}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 8192) return finish(new Error('Invalid control response'));
      if (!buffer.includes('\n')) return;
      try { finish(null, JSON.parse(buffer.slice(0, buffer.indexOf('\n')))); }
      catch { finish(new Error('Invalid control response')); }
    });
    socket.once('error', () => finish(new Error('Control channel is unavailable')));
    socket.once('end', () => { if (!settled) finish(new Error('Control channel closed without a response')); });
  });
}

export async function stopManagedService(statePath) {
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const ping = await controlRequest(state.jobPipe, 'ping', state.controlToken);
  if (!ping.ok || ping.pid !== state.managerPid || String(ping.startTimeUtcTicks) !== String(state.managerStartTimeUtcTicks)) {
    throw new Error('The recorded process identity does not match this service.');
  }
  try {
    const response = await controlRequest(state.appPipe, 'stop', state.controlToken);
    if (!response.ok) throw new Error('Application stop request rejected');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      try { await controlRequest(state.jobPipe, 'ping', state.controlToken, undefined, 500); }
      catch { return; }
    }
  } catch { /* Fall back to the native supervisor when the application is unresponsive. */ }
  const response = await controlRequest(state.jobPipe, 'stop', state.controlToken);
  if (!response.ok) throw new Error('Supervisor stop request rejected');
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    try { await controlRequest(state.jobPipe, 'ping', state.controlToken, undefined, 500); }
    catch { return; }
  }
  throw new Error('The supervisor did not exit after the stop request.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, path] = process.argv.slice(2);
  try {
    if (command === 'stop' && path) { await stopManagedService(path); process.stdout.write('Stopped the managed proxy and copilot-api process group.\n'); }
    else if (command === 'status' && path) {
      const state = JSON.parse(await readFile(path, 'utf8'));
      const ping = await controlRequest(state.jobPipe, 'ping', state.controlToken);
      if (!ping.ok || ping.pid !== state.managerPid) throw new Error('Service identity check failed');
      process.stdout.write(JSON.stringify({ ok: true, status: state.status, managerPid: state.managerPid, proxyPid: state.proxyPid,
        copilotVersion: state.copilotVersion, healthUrl: state.healthUrl, argsDigest: state.argsDigest,
        startupContextDigest: state.startupContextDigest, configSha256: state.configSha256 }) + '\n');
    } else throw new Error('Usage: node src/control.mjs stop|status service.json');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
