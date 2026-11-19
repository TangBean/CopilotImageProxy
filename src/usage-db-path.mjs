import { homedir } from 'node:os';
import path from 'node:path';

export function resolveUsageDatabasePath({ sqliteDbPath, env = process.env, apiHome = env.COPILOT_API_HOME, cwd = process.cwd() } = {}) {
  const override = sqliteDbPath ?? env.COPILOT_API_SQLITE_DB_PATH;
  if (override != null) {
    // An empty SQLite filename and :memory: both name a process-private database.
    if (override === '') return ':memory:';
    if (override === ':memory:' || override.startsWith('file:')) return override;
    return path.resolve(cwd, override);
  }
  return path.resolve(cwd, apiHome || path.join(homedir(), '.local', 'share', 'copilot-api'), 'copilot-api.sqlite');
}
