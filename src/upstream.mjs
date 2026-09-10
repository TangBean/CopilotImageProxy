import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_NAME, VERSION_PATTERN, MARKER_ENV, VERSION_ENV } from './locate-package.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const LOCATOR_PATH = fileURLToPath(new URL('./locate-package.mjs', import.meta.url));
const MAX_COMMAND_OUTPUT = 2 * 1024 * 1024;

function failure(code, message, details = {}) {
  const error = new Error(message);
  Object.assign(error, { code, ...details });
  return error;
}

function checkArgv(argv) {
  if (!Array.isArray(argv) || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw failure('UPSTREAM_INVALID_ARGV', 'copilot-api arguments must be strings without NUL characters.');
  }
}

function commandIndex(argv) {
  // citty 0.1.6 resolves commands from raw argv, not its parsed positional list.
  // Leading --api-home=PATH works; --api-home PATH instead treats PATH as the
  // command. Preserve that upstream behavior instead of silently rewriting argv.
  return argv.findIndex((arg) => !arg.startsWith('-'));
}

export function classifyCopilotArgs(argv) {
  checkArgv(argv);
  if (argv[commandIndex(argv)] !== 'start') return { managed: false };
  // citty checks raw argv for help before parsing, even after a `--` delimiter.
  // `--version` is special only as the sole root argument, not after `start`.
  return { managed: !argv.some((arg) => arg === '--help' || arg === '-h') };
}

// Mirrors the relevant citty 0.1.6 / mri behavior without changing argv. Repeated
// string options produce arrays; aliases are synchronized in insertion order.
// copilot-api applies parseInt to the resulting port, so the first value wins.
function bindingOptions(argv) {
  const values = new Map();
  const add = (key, value) => {
    if (!['host', 'port', 'p'].includes(key)) return;
    const normalized = value === undefined || value === true ? '' : String(value);
    if (!values.has(key)) values.set(key, normalized);
    else values.set(key, Array.isArray(values.get(key)) ? [...values.get(key), normalized] : [values.get(key), normalized]);
  };
  // Upstream passes only tokens AFTER the selected command to the start parser;
  // a leading --port=... is a root option and does not set the server port.
  const start = commandIndex(argv);
  for (let index = start < 0 ? argv.length : start + 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') break;
    const dashCount = /^-*/.exec(token)[0].length;
    if (dashCount === 0) continue;
    if (token.slice(dashCount, dashCount + 3) === 'no-') {
      const key = token.slice(dashCount + 3);
      if (['host', 'port', 'p'].includes(key)) values.set(key, false);
      continue;
    }
    let equals = token.indexOf('=', dashCount + 1);
    if (equals < 0) equals = token.length;
    const name = token.slice(dashCount, equals);
    let value = token.slice(equals + 1);
    if (!value) {
      if (index + 1 === argv.length || argv[index + 1].startsWith('-')) value = true;
      else value = argv[++index];
    }
    const names = dashCount === 2 ? [name] : [...name];
    for (let part = 0; part < names.length; part += 1) add(names[part], part + 1 < names.length || value);
  }
  const firstPortKey = [...values.keys()].find((key) => key === 'port' || key === 'p');
  return { host: values.get('host'), port: firstPortKey === undefined ? '4141' : values.get(firstPortKey) };
}

export function resolveBinding(argv, env = process.env) {
  checkArgv(argv);
  const parsed = bindingOptions(argv);
  let host = parsed.host === undefined ? (env.HOST?.trim() || '127.0.0.1') : parsed.host;
  if (typeof host !== 'string') {
    throw failure('UPSTREAM_INVALID_BINDING', 'The host option must have one string value; repeated --host is not supported by copilot-api.');
  }
  host = host.trim();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host || /[\s/?#]/.test(host)) throw failure('UPSTREAM_INVALID_BINDING', 'Invalid copilot-api host option.');
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw failure('UPSTREAM_INVALID_BINDING', 'The effective copilot-api port must be between 1 and 65535. Use --port VALUE or -p VALUE.');
  }
  // Current upstream resolveClientHostname also maps both wildcard forms to
  // IPv4 loopback; its IPv6 wildcard socket is dual-stack by default.
  const connectHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.toLowerCase();
  return { host, port, connectHost };
}

async function resolveNpmCli(nodePath, env) {
  const candidates = [
    env.npm_execpath,
    path.join(path.dirname(nodePath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(path.dirname(nodePath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter((candidate) => typeof candidate === 'string' && path.isAbsolute(candidate) && /npm-cli\.[cm]?js$/i.test(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      if ((await stat(candidate)).isFile()) return await realpath(candidate);
    } catch { /* Try the next runtime-owned npm entry point. */ }
  }
  throw failure('UPSTREAM_NPM_NOT_FOUND', 'Cannot locate npm-cli.js beside Node.js. Install Node.js with npm before starting the proxy.');
}

function npmEnvironment(env, nodePath) {
  const output = { ...env, npm_config_offline: 'false', npm_config_prefer_online: 'true', npm_config_prefer_offline: 'false' };
  const pathKeys = Object.keys(output).filter((key) => key.toLowerCase() === 'path');
  const inheritedPath = pathKeys.length ? String(output[pathKeys[0]] || '') : '';
  for (const key of pathKeys) delete output[key];
  const nodeDirectory = path.dirname(nodePath);
  const normalize = (value) => {
    const unquoted = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
    const absolute = path.resolve(unquoted);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  const entries = inheritedPath.split(path.delimiter).filter((entry) => entry && normalize(entry) !== normalize(nodeDirectory));
  output[process.platform === 'win32' ? 'Path' : 'PATH'] = [nodeDirectory, ...entries].join(path.delimiter);
  return output;
}

function runNpm({ nodePath, npmCli, args, cwd, env, signal, phase }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    let pendingFailure;
    let outputSize = 0;
    const output = [];
    const complete = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const child = spawn(nodePath, [npmCli, ...args], {
      cwd, env, signal, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => {
      if (pendingFailure) return;
      outputSize += chunk.length;
      if (outputSize > MAX_COMMAND_OUTPUT) {
        pendingFailure = failure('UPSTREAM_NPM_OUTPUT_LIMIT', `npm ${phase} produced unexpectedly large output.`, { phase });
        child.kill();
      } else output.push(chunk);
    });
    // npm can include configuration or registry details in errors. Drain them,
    // but never expose raw subprocess output through application metadata logs.
    child.stderr.resume();
    child.once('error', (error) => {
      // The abort error can precede process exit. Wait for close before deleting
      // its temporary metadata cache, particularly on Windows with open handles.
      pendingFailure ||= signal?.aborted ? signal.reason : failure('UPSTREAM_NPM_FAILED', `Cannot run npm during ${phase}.`, { phase, cause: error });
    });
    child.once('close', (exitCode, exitSignal) => {
      if (signal?.aborted) return complete(reject, signal.reason);
      if (pendingFailure) return complete(reject, pendingFailure);
      if (exitCode !== 0) {
        return complete(reject, failure('UPSTREAM_NPM_FAILED', `npm ${phase} failed; no cached-version fallback was used.`, { phase, exitCode, exitSignal }));
      }
      complete(resolve, Buffer.concat(output).toString('utf8'));
    });
  });
}

/** cwd is the owned proxy project directory, never the caller's upstream cwd. */
export async function resolveLatestPackage({ signal, log = () => {}, cwd = PROJECT_ROOT, env = process.env } = {}) {
  signal?.throwIfAborted();
  const safeLog = (entry) => { try { log({ event: 'upstream-package', ...entry }); } catch { /* Metadata logging is optional. */ } };
  const nodePath = await realpath(process.execPath);
  const npmCli = await resolveNpmCli(nodePath, env);
  const npmCwd = path.resolve(cwd);
  const npmEnv = npmEnvironment(env, nodePath);
  // A fresh metadata cache prevents npm's stale-on-network-error behavior from
  // silently turning "latest" into an old cached version. Package installation
  // below still uses the user's normal npm cache, so tarballs remain reusable.
  const metadataCache = await mkdtemp(path.join(tmpdir(), 'copilot-image-proxy-latest-'));
  let version;
  try {
    safeLog({ phase: 'resolve-latest' });
    const result = await runNpm({ nodePath, npmCli, cwd: npmCwd, env: npmEnv, signal, phase: 'resolve-latest', args: [
      'view', `${PACKAGE_NAME}@latest`, 'version', '--json', '--prefer-online', '--offline=false',
      '--prefer-offline=false', '--cache', metadataCache,
    ] });
    try { version = JSON.parse(result.trim()); } catch { /* Validated below. */ }
    if (typeof version !== 'string' || version.trim() !== version || !VERSION_PATTERN.test(version)) {
      throw failure('UPSTREAM_INVALID_LATEST', 'The online npm latest lookup did not return one exact package version.');
    }
  } finally {
    if (path.dirname(path.resolve(metadataCache)) !== path.resolve(tmpdir()) ||
        !path.basename(metadataCache).startsWith('copilot-image-proxy-latest-')) {
      throw failure('UPSTREAM_CACHE_PATH_INVALID', 'Refusing to remove an unexpected metadata-cache directory.');
    }
    await rm(metadataCache, { recursive: true, force: true });
  }
  signal?.throwIfAborted();
  safeLog({ phase: 'prepare-package', version });
  const marker = `CIP_LOCATOR_${randomBytes(16).toString('hex')}`;
  const output = await runNpm({ nodePath, npmCli, cwd: npmCwd, signal, phase: 'prepare-package',
    env: { ...npmEnv, [MARKER_ENV]: marker, [VERSION_ENV]: version },
    // npm's Windows shell runner does not quote a command name containing spaces.
    // Use a fixed command name, with our Node directory at the front of PATH;
    // the locator result is still checked against the exact runtime below.
    args: ['exec', '--yes', '--prefer-online', '--offline=false', `--package=${PACKAGE_NAME}@${version}`, '--', 'node', LOCATOR_PATH],
  });
  const records = output.split(/\r?\n/).filter((line) => line.startsWith(`${marker}:`));
  let location;
  try {
    if (records.length !== 1) throw new Error('Ambiguous locator output');
    location = JSON.parse(records[0].slice(marker.length + 1));
  } catch {
    throw failure('UPSTREAM_INVALID_LOCATION', 'npm did not return one verified copilot-api package location.');
  }
  if (location?.version !== version || !['binPath', 'binDirectory', 'nodePath'].every((key) =>
    typeof location[key] === 'string' && path.isAbsolute(location[key]))) {
    throw failure('UPSTREAM_INVALID_LOCATION', 'The located copilot-api package does not match the requested exact version.');
  }
  if (!(await stat(location.binPath)).isFile() || !(await stat(location.binDirectory)).isDirectory() ||
      await realpath(location.nodePath) !== nodePath) {
    throw failure('UPSTREAM_INVALID_LOCATION', 'The located copilot-api entry or runtime is invalid.');
  }
  signal?.throwIfAborted();
  safeLog({ phase: 'package-ready', version });
  return { version, binPath: location.binPath, nodePath, binDirectory: location.binDirectory };
}
