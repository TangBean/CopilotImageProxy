// This factory runs inside the upstream page. Its refresh and pagination requests
// keep their native request IDs and guards when publishing data to these hooks.
export function createUsageViewerClient({
  state, render, getConnectionKey, deriveEndpointUrl, fetchJson,
  getErrorMessage, canReadTitles, buildRequestHeaders,
}) {
  const isolatedHourlyError = 'Hourly output speed is unavailable for isolated API keys.';
  let context = null;

  function connectionChanged() {
    context = null;
    state.tokenUsageHourlySummary = null;
    state.tokenUsageHourlyError = null;
  }

  function isolationChanged(isolated) {
    if (context) context.titles = null;
    state.tokenUsageHourlySummary = null;
    state.tokenUsageHourlyError = isolated && state.tokenUsagePeriod === 'today' ? isolatedHourlyError : null;
  }

  function beginRefresh(period) {
    const key = getConnectionKey();
    if (!context || context.key !== key || context.period !== period) {
      state.tokenUsageDailySummary = null;
      state.tokenUsageHourlySummary = null;
    }
    context = { key, period, titles: null };
    state.tokenUsageHourlyError = null;
  }

  async function fetchHourly(usageUrl, period) {
    const url = new URL(deriveEndpointUrl(usageUrl, 'token-usage/hourly'));
    url.searchParams.set('period', period);
    // Only the native usage endpoints determine the connection's API key isolation.
    return fetchJson(url.toString(), () => false);
  }

  function refreshFailed(message) {
    state.tokenUsageHourlySummary = null;
    state.tokenUsageHourlyError = message;
  }

  async function settle(nativeRequests, usageUrl, period, isCurrentRequest) {
    if (period !== 'today') return Promise.allSettled(nativeRequests);
    const results = await Promise.allSettled([...nativeRequests, fetchHourly(usageUrl, period)]);
    const hourly = results.pop();
    if (isCurrentRequest()) {
      if (hourly.status === 'rejected') refreshFailed(getErrorMessage(hourly.reason));
      else if (state.isolateApiKeyUsage) refreshFailed(isolatedHourlyError);
      else {
        state.tokenUsageHourlySummary = hourly.value;
        state.tokenUsageHourlyError = null;
      }
    }
    return results;
  }

  function titlesAllowed() {
    return context && context.key === getConnectionKey() && !state.isolateApiKeyUsage && canReadTitles();
  }

  async function loadTitles() {
    if (!titlesAllowed() || context.titles) return;
    const pages = [state.tokenUsageEventsPage, state.tokenUsageSessionsPage];
    if (!pages.some(page => page?.items?.some(row => row?.session_id))) return;

    const lookup = {};
    context.titles = lookup;
    try {
      const response = await fetch('/__session-titles', {
        headers: buildRequestHeaders(), mode: 'same-origin', redirect: 'error', cache: 'no-store',
      });
      if (!response.ok) return;
      const titles = await response.json();
      if (!titles || typeof titles !== 'object' || context?.titles !== lookup || !titlesAllowed()) return;
      lookup.values = titles;
      render('usage');
    } catch { /* The raw session ID remains visible until the next refresh. */ }
  }

  function sessionTitle(id) {
    const titles = context?.titles?.values;
    if (!titles || !titlesAllowed()) return id;
    return Object.hasOwn(titles, id) && typeof titles[id] === 'string' ? titles[id] : id;
  }

  return { connectionChanged, isolationChanged, beginRefresh, settle, refreshFailed, loadTitles, sessionTitle };
}
