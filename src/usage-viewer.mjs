import { usageTrendScript } from './usage-trends.mjs';

const defaultEndpoint = 'const DEFAULT_ENDPOINT = "http://localhost:4141/usage";';

const dailyTrendRendererMarker = 'function renderTokenUsageDailyTrend(dailySummary, error) {';
const dailyTrendCallMarker = '${renderTokenUsageDailyTrend(\n                dailySummary,\n                state.tokenUsageDailyError\n              )}';
const dailyTrendLoadingMarker = `const period = getSelectedPeriod();
          state.isTokenUsageLoading = true;
          state.tokenUsageDailySummary = null;`;
const usageFetchMarker = `const [summaryResult, dailyResult, eventsResult] =
              await Promise.allSettled([
                fetchJson(buildTokenUsageSummaryUrl(usageUrl, period)),
                fetchJson(buildTokenUsageDailyUrl(usageUrl, period)),
                fetchJson(buildTokenUsageEventsUrl(usageUrl, period, page)),
              ]);`;
const hourlyFetchScript = `let tokenUsageTrendRequestId = 0;
        function fetchTokenUsageHourly(usageUrl, period) {
          if (period !== "today") return Promise.resolve(null);
          const url = new URL(deriveEndpointUrl(usageUrl, "token-usage/hourly"));
          url.searchParams.set("period", period);
          return fetchJson(url.toString());
        }`;

const periodSelectMarker = `<select
                id="token-usage-period"
                class="select-control input-focus"
              >`;

const periodSelectBindingMarker = `const tokenUsagePeriodSelect = document.getElementById(
          "token-usage-period"
        );`;

const normalizePeriodMarker = `function normalizePeriod(value) {
          if (VALID_PERIODS.has(value)) {
            return value;
          }
          return LEGACY_PERIODS[value] || DEFAULT_TOKEN_USAGE_PERIOD;
        }`;

const relativePeriodNormalizer = `function normalizePeriod(value) {
          const relative = typeof value === "string" && /^-([1-9][0-9]*)[ _]?d(?:ay)?$/i.exec(value);
          if (relative && relative[0] === value && Number.isSafeInteger(Number(relative[1]))) {
            return "-" + relative[1] + "day";
          }
          if (/^\\s*-/.test(value || "")) {
            throw new Error("Relative-day period must be -Nd or -Nday with a positive safe integer N, no leading zeros, and one optional space or underscore before the suffix.");
          }
          if (VALID_PERIODS.has(value)) {
            return value;
          }
          return Object.hasOwn(LEGACY_PERIODS, value) ? LEGACY_PERIODS[value] : DEFAULT_TOKEN_USAGE_PERIOD;
        }`;

const resolveUsageUrlMarker = `function resolveUsageUrl(endpoint) {
          return new URL(endpoint, window.location.href).toString();
        }`;

const validatedUsageUrl = `function resolveUsageUrl(endpoint) {
          const url = new URL(endpoint, window.location.href);
          if (url.searchParams.has("from") || url.searchParams.has("to")) {
            throw new Error("from and to are not supported. Use period=-Nd or period=-Nday.");
          }
          return url.toString();
        }`;

const deriveEndpointMarker = `function deriveEndpointUrl(usageEndpoint, targetPath) {
          const url = new URL(usageEndpoint, window.location.href);`;

const periodInitializationMarker = `const periodFromUrl = normalizePeriod(urlParams.get("period"));
          const endpointFromUrl = urlParams.get("endpoint");
          const initialEndpoint = endpointFromUrl || DEFAULT_ENDPOINT;`;

const relativePeriodInitialization = `const endpointFromUrl = urlParams.get("endpoint");
          const initialEndpoint = endpointFromUrl || DEFAULT_ENDPOINT;
          let periodFromUrl;
          try {
            if (urlParams.has("from") || urlParams.has("to")) {
              throw new Error("from and to are not supported. Use period=-Nd or period=-Nday.");
            }
            if (urlParams.getAll("period").length > 1) {
              throw new Error("period must be specified once.");
            }
            periodFromUrl = normalizePeriod(urlParams.get("period"));
            resolveUsageUrl(initialEndpoint);
          } catch (error) {
            state.error = getErrorMessage(error);
            state.tokenUsageSummaryError = state.error;
            render();
            return;
          }
          if (periodFromUrl.startsWith("-")) {
            const option = document.createElement("option");
            option.value = periodFromUrl;
            option.textContent = periodFromUrl.replace("day", " Day");
            tokenUsagePeriodSelect.add(option);
            const currentUrl = new URL(window.location.href);
            currentUrl.searchParams.set("period", periodFromUrl);
            window.history.replaceState({}, "", currentUrl);
          }`;

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

export class UsageViewerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageViewerError';
    this.status = 502;
    this.code = 'proxy_usage_viewer_incompatible';
  }
}

function uniqueEdit(body, name, marker, replacement) {
  const variants = marker.includes('\n') ? [marker, marker.replaceAll('\n', '\r\n')] : [marker];
  const matches = [];
  for (const variant of variants) {
    const bytes = Buffer.from(variant);
    for (let start = body.indexOf(bytes); start >= 0; start = body.indexOf(bytes, start + 1)) {
      matches.push({
        start, length: bytes.length,
        replacement: Buffer.from(variant.includes('\r\n') ? replacement.replaceAll('\n', '\r\n') : replacement),
      });
    }
  }
  if (matches.length !== 1) {
    throw new UsageViewerError(`Upstream usage viewer is incompatible: ${name} marker is ${matches.length ? 'duplicated' : 'missing'}.`);
  }
  return matches[0];
}

export function rewriteUsageViewer(body, { host, port }) {
  const authority = host === '::1' ? `[${host}]:${port}` : `${host}:${port}`;
  const edits = [
    ['default endpoint', defaultEndpoint, `const DEFAULT_ENDPOINT = "http://${authority}/usage";`],
    ['period select', periodSelectMarker, periodSelectMarker],
    ['period select binding', periodSelectBindingMarker, periodSelectBindingMarker],
    ['period normalization', normalizePeriodMarker, relativePeriodNormalizer],
    ['usage endpoint validation', resolveUsageUrlMarker, validatedUsageUrl],
    ['derived endpoint validation', deriveEndpointMarker,
      'function deriveEndpointUrl(usageEndpoint, targetPath) {\n          const url = new URL(resolveUsageUrl(usageEndpoint));'],
    ['period initialization', periodInitializationMarker, relativePeriodInitialization],
    ['range label', 'const label = labels[period] || labels.today;', `if (typeof range?.display_label === "string" && range.display_label) {
            return range.display_label;
          }
          const label = labels[period] || period;`],
    ['daily trend renderer', dailyTrendRendererMarker, `${hourlyFetchScript}\n        ${usageTrendScript}\n        ${dailyTrendRendererMarker}`],
    ['cost amount reader', 'function getCostAmount(cost) {', 'function getCostAmount(cost) {'],
    ['trend range formatter', 'function renderTokenUsageRangeText(period, range) {', 'function renderTokenUsageRangeText(period, range) {'],
    ['trend date formatter', 'function formatChartDate(value) {', 'function formatChartDate(value) {'],
    ['trend empty state', 'function renderEmptyState(message) {', 'function renderEmptyState(message) {'],
    ['trend click binding', 'contentArea.addEventListener("click", handleContentAreaClick);',
      'contentArea.addEventListener("click", handleContentAreaClick);\n          contentArea.addEventListener("click", handleModelDailyTrendClick);'],
    ['trend refresh display', 'if (state.isLoading) {', 'if (state.isLoading && !state.tokenUsageDailySummary && !state.tokenUsageHourlySummary) {'],
    ['hourly content visibility', 'const hasContent = Boolean(state.isTokenUsageLoading || state.isEventsLoading',
      'const hasContent = Boolean(state.tokenUsageHourlySummary || state.tokenUsageHourlyError || state.isTokenUsageLoading || state.isEventsLoading'],
    ['hourly section visibility', 'const hasTokenUsageContent = Boolean(',
      'const hasTokenUsageContent = Boolean(state.tokenUsageHourlySummary || state.tokenUsageHourlyError ||'],
    ['trend request identity', 'async function fetchTokenUsageSummaryAndEvents(page = 1) {',
      'async function fetchTokenUsageSummaryAndEvents(page = 1) {\n          const requestId = ++tokenUsageTrendRequestId;'],
    ['hourly invalid endpoint', 'if (!endpoint) {\n            state.tokenUsageDailySummary = null;',
      'if (!endpoint) {\n            state.isTokenUsageLoading = false;\n            state.tokenUsageHourlySummary = null;\n            state.tokenUsageHourlyError = "Token usage requires a valid endpoint URL.";\n            state.tokenUsageDailySummary = null;'],
    ['trend refresh data', dailyTrendLoadingMarker, `const period = getSelectedPeriod();
          const dailyContext = JSON.stringify([endpoint, period, apiKeyInput.value.trim()]);
          if (state.tokenUsageDailyContext !== dailyContext) {
            state.tokenUsageDailySummary = null;
            state.tokenUsageHourlySummary = null;
          }
          state.tokenUsageDailyContext = dailyContext;
          state.tokenUsageHourlyError = null;
          state.isTokenUsageLoading = true;`],
    ['hourly request', usageFetchMarker, `const [summaryResult, dailyResult, eventsResult, hourlyResult] =
              await Promise.allSettled([
                fetchJson(buildTokenUsageSummaryUrl(usageUrl, period)),
                fetchJson(buildTokenUsageDailyUrl(usageUrl, period)),
                fetchJson(buildTokenUsageEventsUrl(usageUrl, period, page)),
                fetchTokenUsageHourly(usageUrl, period),
              ]);
            if (requestId !== tokenUsageTrendRequestId) return;
            state.tokenUsageHourlySummary = hourlyResult.status === "fulfilled" ? hourlyResult.value : null;
            state.tokenUsageHourlyError = hourlyResult.status === "rejected" ? getErrorMessage(hourlyResult.reason) : null;`],
    ['hourly request error', 'console.error("Token usage fetch error:", error);',
      'if (requestId !== tokenUsageTrendRequestId) return;\n            state.tokenUsageHourlySummary = null;\n            state.tokenUsageHourlyError = getErrorMessage(error);\n            console.error("Token usage fetch error:", error);'],
    ['trend request completion', 'state.isTokenUsageLoading = false;\n            render("usage");',
      'if (requestId === tokenUsageTrendRequestId) {\n              state.isTokenUsageLoading = false;\n              render("usage");\n            }'],
    ['daily trend panels', dailyTrendCallMarker,
      dailyTrendCallMarker + '\n              ${renderOutputSpeedTrend(state.tokenUsagePeriod === "today" ? state.tokenUsageHourlySummary : dailySummary, state.tokenUsagePeriod === "today" ? state.tokenUsageHourlyError : state.tokenUsageDailyError)}'
      + '\n              ${renderCostTrend(dailySummary, state.tokenUsageDailyError)}'],
    ['closing body', '</body>', `${sessionTitlesScript}</body>`],
  ].map(([name, marker, replacement]) => uniqueEdit(body, name, marker, replacement))
    .sort((left, right) => left.start - right.start);

  const chunks = [];
  let end = 0;
  for (const edit of edits) {
    if (edit.start < end) throw new UsageViewerError('Upstream usage viewer is incompatible: rewrite markers overlap.');
    chunks.push(body.subarray(end, edit.start), edit.replacement);
    end = edit.start + edit.length;
  }
  chunks.push(body.subarray(end));
  return Buffer.concat(chunks);
}
