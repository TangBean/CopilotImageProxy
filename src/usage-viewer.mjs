const defaultEndpoint = 'const DEFAULT_ENDPOINT = "http://localhost:4141/usage";';

const usageRangeScript = `<script id="copilot-usage-range">
(() => {
  const originalFetch = globalThis.fetch.bind(globalThis);
  const routes = new Set(['/token-usage', '/token-usage/daily', '/token-usage/events', '/token-usage/sessions']);
  globalThis.fetch = async (input, init) => {
    const params = new URLSearchParams(location.search);
    if (!params.has('from') && !params.has('to')) return originalFetch(input, init);
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    let url;
    try { url = new URL(isRequest ? input.url : input, document.baseURI); }
    catch { return originalFetch(input, init); }
    if (url.origin !== location.origin || !routes.has(url.pathname)) return originalFetch(input, init);
    for (const key of ['from', 'to']) {
      if (params.has(key)) url.searchParams.set(key, params.get(key));
    }
    return originalFetch(isRequest ? new Request(url, input) : url, init);
  };
})();
</script>`;

const sessionTitlesScript = `<script>
fetch('/__session-titles')
  .then((response) => response.ok ? response.json() : {})
  .then((titles) => {
    const processed = new WeakMap();
    const update = () => {
      for (const cell of document.querySelectorAll('td')) {
        const previous = processed.get(cell);
        if (previous && previous.node === cell.firstChild && previous.title === cell.textContent && previous.id === cell.title) continue;
        const id = cell.textContent.trim();
        if (!Object.hasOwn(titles, id)) continue;
        const title = titles[id];
        cell.textContent = title;
        cell.title = id;
        processed.set(cell, { node: cell.firstChild, title, id });
      }
    };
    update();
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData') {
          const cell = record.target.parentElement?.closest('td');
          if (cell) processed.delete(cell);
        }
      }
      update();
    }).observe(document.body, {
      childList: true, characterData: true, subtree: true,
    });
  })
  .catch(() => {});
</script>`;

function replaceBytes(body, marker, replacement) {
  const start = body.indexOf(marker);
  return Buffer.concat([body.subarray(0, start), Buffer.from(replacement), body.subarray(start + marker.length)]);
}

function rewriteRangeDisplay(body) {
  const dailyMarker = 'state.tokenUsagePeriod,\n                        dailySummary?.range || null';
  const dailyMatch = body.includes(dailyMarker) ? dailyMarker : dailyMarker.replace('\n', '\r\n');
  const replacements = [
    ['const label = labels[period] || labels.today;', 'const label = period === "custom" ? "Custom" : labels[period] || labels.today;'],
    ['renderTokenUsageRangeText(state.tokenUsagePeriod, activeRange)',
      'renderTokenUsageRangeText(summary?.period || dailySummary?.period || eventsPage?.period || sessionsPage?.period || state.tokenUsagePeriod, activeRange)'],
    [dailyMatch, dailyMatch.replace('state.tokenUsagePeriod,', 'dailySummary?.period || state.tokenUsagePeriod,')],
    ['if (state.tokenUsagePeriod === "today") {', 'if (state.tokenUsagePeriod === "today" && dailySummary?.period !== "custom") {'],
  ];
  // Apply this version-specific display adjustment only when every expected marker is unique.
  if (!replacements.every(([marker]) => body.indexOf(marker) >= 0 && body.indexOf(marker) === body.lastIndexOf(marker))) return body;
  for (const [marker, replacement] of replacements) body = replaceBytes(body, marker, replacement);
  return body;
}

export function rewriteUsageViewer(body, { host, port }) {
  const endpointStart = body.indexOf(defaultEndpoint);
  const scriptStart = body.indexOf('<script');
  if (endpointStart < 0 || scriptStart < 0 || !body.includes('</body>')) return null;
  const authority = host === '::1' ? `[${host}]:${port}` : `${host}:${port}`;
  let html = replaceBytes(body, defaultEndpoint, `const DEFAULT_ENDPOINT = "http://${authority}/usage";`);
  html = rewriteRangeDisplay(html);
  html = Buffer.concat([html.subarray(0, scriptStart), Buffer.from(usageRangeScript), html.subarray(scriptStart)]);
  const bodyEnd = html.lastIndexOf('</body>');
  return Buffer.concat([html.subarray(0, bodyEnd), Buffer.from(sessionTitlesScript), html.subarray(bodyEnd)]);
}
