import { readFileSync } from 'node:fs';
import { LOG_LEVELS } from './logging.mjs';

export const DEFAULT_CONFIG = Object.freeze({
  host: '127.0.0.1', port: 4142, upstream: 'http://127.0.0.1:4141',
  maxEdge: 1280, jpegQuality: 80, maxOutputMiB: 24, maxInputMiB: 128,
  cacheMiB: 64, imageConcurrency: 2, connectTimeoutMs: 10000,
  upstreamStartupTimeoutMs: 180000,
  maxImageQueueMiB: 256,
  logLevel: 'info',
  sessionIndexPath: null,
  sqliteDbPath: null,
  usageTimezone: '+08:00',
  plaintextCollaborationModels: Object.freeze([]),
  earlyResponseErrorModels: Object.freeze([]),
});

const loopback = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function validateConfig(overrides = {}, { managedUpstream = false, skipUpstream = false } = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new Error('Configuration must be a JSON object.');
  }
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new Error(`Unknown configuration key: ${key}`);
  }
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const supportedModels = new Set(['gpt-6-astra', 'gpt-6.1-sol']);
  for (const key of ['plaintextCollaborationModels', 'earlyResponseErrorModels']) {
    if (!Array.isArray(config[key]) || config[key].some((model) => !supportedModels.has(model))) {
      throw new Error(`${key} must contain only gpt-6-astra or gpt-6.1-sol model IDs.`);
    }
    config[key] = Object.freeze([...new Set(config[key])]);
  }
  if (!LOG_LEVELS.includes(config.logLevel)) throw new Error(`logLevel must be one of: ${LOG_LEVELS.join(', ')}.`);
  for (const key of ['sessionIndexPath', 'sqliteDbPath']) {
    if (config[key] !== null && (typeof config[key] !== 'string' || !config[key].trim())) {
      throw new Error(`${key} must be null or a non-empty path string.`);
    }
  }
  if (typeof config.usageTimezone !== 'string' ||
      !/^(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/.test(config.usageTimezone)) {
    throw new Error('usageTimezone must be Z or a fixed UTC offset between -14:00 and +14:00 (±HH:mm).');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) throw new Error('host must be a loopback address.');
  const integer = (key, min, max) => {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) {
      throw new Error(`${key} must be an integer between ${min} and ${max}.`);
    }
  };
  integer('port', 1, 65535);
  integer('maxEdge', 32, 16384);
  integer('jpegQuality', 1, 100);
  integer('imageConcurrency', 1, 16);
  integer('connectTimeoutMs', 1, 300000);
  integer('upstreamStartupTimeoutMs', 1000, 900000);
  for (const key of ['maxInputMiB', 'maxOutputMiB', 'cacheMiB', 'maxImageQueueMiB']) {
    if (typeof config[key] !== 'number' || !Number.isFinite(config[key]) ||
        config[key] < (key === 'cacheMiB' ? 0 : 1 / 1048576) || config[key] > 4096) {
      throw new Error(`${key} must be a finite MiB value ${key === 'cacheMiB' ? '>= 0' : '> 0'} and <= 4096.`);
    }
  }
  if (skipUpstream) return Object.freeze(config);
  let upstream;
  try { upstream = new URL(config.upstream); } catch { throw new Error('upstream must be a valid HTTP URL.'); }
  if (!['http:', 'https:'].includes(upstream.protocol) || (!managedUpstream && !loopback.has(upstream.hostname)) ||
      upstream.username || upstream.password || upstream.search || upstream.hash) {
    throw new Error('upstream must be a fixed loopback HTTP(S) URL without credentials, query or fragment.');
  }
  const upstreamPort = Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80));
  if (upstreamPort === config.port) throw new Error('upstream cannot use the proxy listening port.');
  return Object.freeze(config);
}

export function loadConfig(path, { allowMissing = false, managedStart = false } = {}) {
  let contents;
  try { contents = readFileSync(path, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' && allowMissing) return validateConfig({}, { skipUpstream: managedStart });
    throw new Error('Cannot read the configuration file.');
  }
  let parsed;
  try { parsed = JSON.parse(contents.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Configuration contains invalid JSON.'); }
  return validateConfig(parsed, { skipUpstream: managedStart });
}
