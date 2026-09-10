import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = process.argv[2];
if (!reportPath) { process.stderr.write('Usage: node scripts/validate-cli.mjs report.json\n'); process.exit(1); }
const checks = [];
async function run(args, { mcp = false } = {}) {
  const start = Date.now();
  return new Promise((resolveCheck, reject) => {
    const child = spawn(process.execPath, [resolve(root, 'src/index.mjs'), '--', ...args], { cwd: root, stdio: ['pipe','pipe','pipe'], shell: false, windowsHide: true });
    let stdout = ''; let stderr = ''; let initialized = false; let timeout = false;
    const timer = setTimeout(() => { timeout = true; child.kill(); }, 120000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (mcp && !initialized) {
        for (const line of stdout.split('\n').filter(Boolean)) {
          let response; try { response = JSON.parse(line); } catch { continue; }
          if (response.id === 1 && response.result?.capabilities) {
            initialized = true;
            child.stdin.end(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
            // A stdio MCP session is long-lived; ending its client is intentional.
            setTimeout(() => { if (child.exitCode === null) child.kill(); }, 300).unref();
          }
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      try {
        const result = {command:args.join(' '),exitCode:code,durationMs:Date.now()-start,stdoutBytes:Buffer.byteLength(stdout),stderrBytes:Buffer.byteLength(stderr),timeout};
        if (mcp) {
          const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
          result.stdoutIsOnlyJsonRpc = lines.every(line => JSON.parse(line).jsonrpc === '2.0');
          result.initialized = initialized;
          result.pass = initialized && result.stdoutIsOnlyJsonRpc && !timeout;
        } else if (args[0] === 'debug') {
          result.stdoutIsJson = typeof JSON.parse(stdout) === 'object';
          result.pass = code === 0 && result.stdoutIsJson && !timeout;
        } else { result.pass = code === 0 && stdout.includes('USAGE copilot-api') && !timeout; }
        process.stdout.write(JSON.stringify(result)+'\n'); resolveCheck(result);
      } catch { reject(new Error('CLI stdout did not preserve the expected protocol. Output was not printed to avoid exposing configuration.')); }
    });
    if (mcp) child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'CopilotImageProxy-acceptance',version:'2.0.0'}}})+'\n');
    else child.stdin.end();
  });
}
let failure;
try {
  for (const args of [['--help'],['debug','--json']]) { const result=await run(args); checks.push(result); if (!result.pass) throw new Error('CLI check failed: '+args.join(' ')); }
  const result=await run(['mcp'],{mcp:true}); checks.push(result); if(!result.pass)throw new Error('MCP check failed');
} catch(error) { failure=error.message; process.exitCode=1; }
await mkdir(dirname(resolve(reportPath)),{recursive:true});
await writeFile(reportPath,JSON.stringify({finishedAt:new Date().toISOString(),pass:!failure,checks,failure},null,2)+'\n');
if(failure)process.stderr.write(failure+'\n');
