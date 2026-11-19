// These functions run inside the upstream page's DOMContentLoaded callback.
export function dashboardEndpoint(configured) {
  const url = new URL(configured);
  const { protocol, hostname, port } = window.location;
  if (protocol === url.protocol && port === url.port && ['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    url.hostname = hostname;
  }
  return url.href;
}

export function prepareUsageLocation() {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('from') || url.searchParams.has('to')) {
      throw new Error('from and to are not supported. Use period=-Nd or period=-Nday.');
    }
    if (url.searchParams.getAll('period').length > 1) throw new Error('period must be specified once.');
    resolveUsageUrl(url.searchParams.get('endpoint') || DEFAULT_ENDPOINT);
    const period = normalizePeriod(url.searchParams.get('period'));
    if (period.startsWith('-')) {
      const option = document.createElement('option');
      option.value = period;
      option.textContent = period.replace('day', ' Day');
      tokenUsagePeriodSelect.add(option);
      url.searchParams.set('period', period);
      window.history.replaceState({}, '', url);
    }
    return true;
  } catch (error) {
    state.error = getErrorMessage(error);
    state.tokenUsageSummaryError = state.error;
    render();
    return false;
  }
}

export function installUsageViewer(createClient) {
  const nativePeriod = normalizePeriod;
  normalizePeriod = value => {
    const relative = typeof value === 'string' && /^-([1-9][0-9]*)[ _]?d(?:ay)?$/i.exec(value);
    if (relative && relative[0] === value && Number.isSafeInteger(Number(relative[1]))) return '-' + relative[1] + 'day';
    if (/^\s*-/.test(value || '')) throw new Error('Relative-day period must be -Nd or -Nday with a positive safe integer N, no leading zeros, and one optional space or underscore before the suffix.');
    const period = nativePeriod(value);
    return typeof period === 'string' ? period : DEFAULT_TOKEN_USAGE_PERIOD;
  };
  const nativeUrl = resolveUsageUrl;
  resolveUsageUrl = endpoint => {
    const url = new URL(nativeUrl(endpoint));
    if (url.searchParams.has('from') || url.searchParams.has('to')) {
      throw new Error('from and to are not supported. Use period=-Nd or period=-Nday.');
    }
    return url.toString();
  };
  const nativeDerive = deriveEndpointUrl;
  deriveEndpointUrl = (endpoint, path) => nativeDerive(resolveUsageUrl(endpoint), path);

  const client = createClient({
    state, render, getConnectionKey, deriveEndpointUrl, fetchJson, getErrorMessage, buildRequestHeaders,
    canReadTitles: () => currentEndpointOrigin === window.location.origin &&
      getEndpointOrigin(endpointUrlInput.value.trim()) === window.location.origin,
  });
  const nativeConnection = syncTokenUsageConnection;
  syncTokenUsageConnection = () => {
    if (state.tokenUsageConnectionKey !== getConnectionKey()) client.connectionChanged();
    return nativeConnection();
  };
  const nativeIsolation = applyUsageIsolation;
  applyUsageIsolation = isolated => {
    if ((state.isolateApiKeyUsage === true) !== isolated) client.isolationChanged(isolated);
    nativeIsolation(isolated);
  };

  const nativeRender = render;
  render = (view = state.activeTab) => {
    nativeRender(view);
    if (view === 'usage' && state.activeTab === view) void client.loadTitles();
  };

  const nativeRangeText = renderTokenUsageRangeText;
  renderTokenUsageRangeText = (period, range) => {
    if (typeof range?.display_label === 'string' && range.display_label) return range.display_label;
    if (VALID_PERIODS.has(period)) return nativeRangeText(period, range);
    return range && range.end_ms > range.start_ms ? period + ': ' + formatRangeText(range) : period;
  };
  const nativeTrend = renderTokenUsageDailyTrend;
  renderTokenUsageDailyTrend = (daily, error) => {
    const today = state.tokenUsagePeriod === 'today';
    return nativeTrend(daily, error) +
      renderOutputSpeedTrend(today ? state.tokenUsageHourlySummary : daily, today ? state.tokenUsageHourlyError : error) +
      renderCostTrend(daily, error);
  };
  contentArea.addEventListener('click', handleModelDailyTrendClick);
  return client;
}
