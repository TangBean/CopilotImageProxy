export const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error', 'silent']);

function enabled(level, minimum) {
  return minimum !== 'silent' && LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(minimum);
}

const eventLevels = Object.freeze({
  'upstream-package': 'debug', ready: 'info', stopping: 'info',
  upstream_exited: 'error', startup_error: 'error',
});

export function createLogger({ level = 'info', write = (entry) => {
  process.stderr.write(JSON.stringify(entry) + '\n');
} } = {}) {
  return (entry) => {
    try {
      const request = entry.event === 'request';
      const severity = request ? requestLevel(entry) : entry.level || eventLevels[entry.event] || 'info';
      if (!enabled(severity, level)) return;
      const fields = request && level !== 'debug' ? compactRequest(entry) : entry;
      write({ time: new Date().toISOString(), ...fields, level: severity });
    }
    catch { /* Logging must not interrupt service operation. */ }
  };
}

function requestLevel(entry) {
  if (entry.abortSource === 'upstream' || entry.abortSource === 'proxy' || entry.status >= 500) return 'error';
  if (entry.status >= 400) return 'warn';
  return entry.error ? 'error' : 'debug';
}

// Keep the full metadata record only when explicitly requested. Failed requests
// remain visible at normal levels without serializing the image/cache counters.
function compactRequest(entry) {
  const compact = { event: entry.event };
  for (const key of ['requestId', 'method', 'route', 'status', 'error', 'abortSource',
    'aborted', 'durationMs', 'upstreamRequests', 'inputBytes', 'decodedInputBytes', 'outputBytes',
    'plaintextCollaboration', 'earlyResponseError']) {
    if (entry[key] !== undefined) compact[key] = entry[key];
  }
  return compact;
}
