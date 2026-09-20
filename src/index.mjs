#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { loadConfig } from './config.mjs';
import { controlRequest } from './control.mjs';
import { classifyCopilotArgs } from './upstream.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function parseInvocation(args, cwd = process.cwd()) {
  let configPath = resolve(root, 'config.json'); let explicitConfig = false;
  const rest = [...args];
  while (rest.length) {
    if (rest[0] === '--') { rest.shift(); break; }
    if (rest[0] === '--config') {
      rest.shift(); const value = rest.shift(); if (!value) throw new Error('--config requires a path');
      configPath = resolve(cwd, value); explicitConfig = true; continue;
    }
    if (rest[0].startsWith('--config=')) {
      const value = rest.shift().slice(9); if (!value) throw new Error('--config requires a path');
      configPath = resolve(cwd, value); explicitConfig = true; continue;
    }
    break;
  }
  return { configPath, explicitConfig, argv: rest.length ? rest : ['start', '--proxy-env'], cwd };
}

async function run() {
  if (process.argv[2] === '--proxy-help') {
    process.stdout.write('CopilotImageProxy: official latest copilot-api with managed image compression.\n\n' +
      'copilot-image-proxy [--config FILE] [-- COPILOT_API_ARGS...]\n' +
      'No arguments: start --proxy-env. Use -- --help for the official CLI help.\n' +
      'Windows background lifecycle: scripts/start.ps1 and scripts/stop.ps1.\n');
    return;
  }
  if (process.platform !== 'win32') throw new Error('Managed lifecycle currently requires Windows.');
  const invocation = parseInvocation(process.argv.slice(2));
  if (classifyCopilotArgs(invocation.argv).managed) loadConfig(invocation.configPath, { allowMissing: !invocation.explicitConfig, managedStart: true });
  const { buildSupervisor } = await import('../scripts/build-supervisor.mjs');
  const helper = buildSupervisor();
  const jobPipe = `copilot-image-proxy-${randomUUID()}`;
  const token = randomBytes(32).toString('hex');
  const spec = { ...invocation, projectRoot: root, managerPath: helper, launcherPid: process.pid, runId: randomUUID() };
  const child = spawn(helper, ['--parent-pid', String(process.pid), '--node', process.execPath,
    '--entry', resolve(root, 'src/managed.mjs')], {
    cwd: invocation.cwd, stdio: 'inherit', windowsHide: false, shell: false,
    env: { ...process.env, CIP_RUN_SPEC: JSON.stringify(spec), CIP_JOB_PIPE: jobPipe, CIP_JOB_TOKEN: token },
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    try { await controlRequest(jobPipe, 'stop', token); }
    catch { child.kill(); }
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGBREAK', stop);
  await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => { process.exitCode = code ?? 1; resolveExit(); });
  });
}

let directEntry = false;
try { directEntry = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch {}
if (directEntry) {
  run().catch((error) => { process.stderr.write(`CopilotImageProxy: ${error.message}\n`); process.exitCode = 1; });
}
