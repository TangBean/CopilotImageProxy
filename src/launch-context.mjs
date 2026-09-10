import { createHash } from 'node:crypto';
import path from 'node:path';
import { resolveBinding } from './upstream.mjs';

export function launchContextDigest(argv, cwd, env = process.env) {
  const relevant = Object.entries(env).filter(([key]) => /^(?:HOST|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|COPILOT_API_.*|GITHUB_TOKEN|GH_TOKEN|NODE_EXTRA_CA_CERTS|NODE_USE_SYSTEM_CA|NPM_CONFIG_(?:REGISTRY|PROXY|HTTPS_PROXY|USERCONFIG))$/i.test(key))
    .map(([key, value]) => [key.toUpperCase(), value]).sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify({ cwd: path.resolve(cwd).toLowerCase(), binding: resolveBinding(argv, env), environment: relevant })).digest('hex');
}
