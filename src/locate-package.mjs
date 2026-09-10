import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = '@jeffreycao/copilot-api';
export const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export const MARKER_ENV = 'COPILOT_IMAGE_PROXY_LOCATOR_MARKER';
export const VERSION_ENV = 'COPILOT_IMAGE_PROXY_PACKAGE_VERSION';

export function environmentPath(env) {
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path');
  return key ? env[key] : '';
}

function isWithin(directory, filename) {
  const relative = path.relative(directory, filename);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Locate metadata and a bin file; never import or execute the downloaded package. */
export async function locateInstalledPackage({ version, env = process.env, nodePath = process.execPath } = {}) {
  if (typeof version !== 'string' || version.trim() !== version || !VERSION_PATTERN.test(version)) throw new Error('Invalid exact package version.');
  for (const item of String(environmentPath(env)).split(path.delimiter)) {
    const directory = item.startsWith('"') && item.endsWith('"') ? item.slice(1, -1) : item;
    if (!directory || !path.isAbsolute(directory)) continue;
    const binDirectory = path.resolve(directory);
    if (path.basename(binDirectory).toLowerCase() !== '.bin' ||
        path.basename(path.dirname(binDirectory)).toLowerCase() !== 'node_modules') continue;
    const packageDirectory = path.join(path.dirname(binDirectory), '@jeffreycao', 'copilot-api');
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw new Error('Cannot read candidate copilot-api package metadata.');
    }
    if (manifest.name !== PACKAGE_NAME || manifest.version !== version) continue;
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['copilot-api'];
    if (typeof bin !== 'string' || !bin || path.isAbsolute(bin)) {
      throw new Error('The requested package does not expose a supported copilot-api bin.');
    }
    const packageRoot = await realpath(packageDirectory);
    const binPath = await realpath(path.resolve(packageDirectory, bin));
    if (!isWithin(packageRoot, binPath) || !(await stat(binPath)).isFile()) {
      throw new Error('The copilot-api bin must be a file inside its package directory.');
    }
    return { version, binPath, nodePath: await realpath(nodePath), binDirectory: await realpath(binDirectory) };
  }
  throw new Error('The exact copilot-api package version was not found on the npm execution PATH.');
}

async function main() {
  const marker = process.env[MARKER_ENV];
  if (!/^CIP_LOCATOR_[a-f0-9]{32}$/.test(marker ?? '')) throw new Error('Invalid locator marker.');
  const location = await locateInstalledPackage({ version: process.env[VERSION_ENV] });
  process.stdout.write(`${marker}:${JSON.stringify(location)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Unable to locate the exact copilot-api package entry point.\n');
    process.exitCode = 1;
  });
}
