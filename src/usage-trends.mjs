// Injected into the upstream dashboard's scope by usage-viewer.mjs.
function formatModelTrendValue(value) {
  return value === null ? '\u2014' : value.toLocaleString('en-US', {
    maximumSignificantDigits: 6, useGrouping: false,
  });
}

function modelTrendColor(model) {
  const palette = ['blue', 'green', 'aqua', 'yellow', 'purple', 'orange', 'red', 'gray'];
  let hash = 2166136261;
  for (const char of model) hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0;
  return `var(--color-${palette[hash % palette.length]}-accent)`;
}

function handleModelDailyTrendClick(event) {
  if (!(event.target instanceof Element)) return;
  for (const key of ['output-speed', 'cost']) {
    const selection = modelDailyTrendState[key];
    const all = event.target.closest(`[data-${key}-all]`);
    const metric = event.target.closest(`[data-${key}-metric]`);
    const day = event.target.closest(`[data-${key}-day]`);
    if (all) selection.metric = null;
    else if (metric) selection.metric = metric.getAttribute(`data-${key}-metric`);
    else if (day) selection.day = day.getAttribute(`data-${key}-day`);
    else continue;
    render();
    return;
  }
}

function renderModelDailyTrend(dailySummary, error, { key, title, valueOf }) {
  if (state.tokenUsagePeriod === 'today') return '';
  const days = dailySummary?.days || [];
  const rows = days.map((day) => new Map((day.byModel || []).map((row) => [row.model, row])));
  const models = [...new Set([
    ...(dailySummary?.byModel || []).map((row) => row.model),
    ...rows.flatMap((day) => [...day.keys()]),
  ])].filter((model) => typeof model === 'string').sort();
  const selection = modelDailyTrendState[key];
  if (dailySummary && !error) {
    if (!models.includes(selection.metric)) selection.metric = null;
    if (!days.some((day) => day.date === selection.day)) selection.day = null;
  }
  const series = models.map((model) => ({
    model, color: modelTrendColor(model), values: rows.map((day) => {
      const value = valueOf(day.get(model));
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }),
  }));
  const visible = selection.metric === null ? series : series.filter(({ model }) => model === selection.metric);
  const buttons = [{ model: null, color: 'var(--color-fg-lightest)' }, ...series].map(({ model, color }) => {
    const active = selection.metric === model;
    return `<button type="button" ${model === null ? `data-${key}-all` : `data-${key}-metric="${escapeHtml(model)}"`}
      aria-pressed="${active}" class="pill-button inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold max-w-full text-left"
      style="background-color: ${active ? 'rgba(37, 99, 235, 0.1)' : 'var(--color-bg)'}; border-color: ${active ? 'rgba(37, 99, 235, 0.28)' : 'var(--color-bg-light-2)'}; color: ${active ? 'var(--color-blue)' : 'var(--color-fg-medium)'};">
      <span class="h-2 w-2 rounded-full shrink-0" style="background-color: ${color};"></span>
      <span style="overflow-wrap:anywhere;min-width:0">${escapeHtml(model === null ? 'All' : model)}</span>
    </button>`;
  }).join('');

  let body;
  if (error) body = `<div class="p-4">${renderError(error, 'Daily model trend failed')}</div>`;
  else if (state.isTokenUsageLoading && !dailySummary) {
    body = '<div class="p-4 min-h-[14rem] text-sm animate-pulse" style="color: var(--color-gray);">Loading...</div>';
  } else if (!days.length || !models.length) {
    body = renderEmptyState('No daily model data for the selected period.');
  } else {
    body = renderModelDailyTrendChart(days, series, visible, selection.day, key);
  }
  return `<section data-${key}-panel class="mt-3 grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_304px] gap-3">
    <div class="panel min-w-0">
      <div class="panel-header"><div>
        <p id="${key}-title" class="panel-title">${title}</p>
        <p class="panel-meta">${escapeHtml(renderTokenUsageRangeText(state.tokenUsagePeriod, dailySummary?.range || null))}</p>
      </div></div>
      ${body}
    </div>
    <aside class="panel min-w-0">
      <div class="panel-header"><div><p class="panel-title">Filters</p><p class="panel-meta">Applied to the trend chart</p></div></div>
      <div class="p-4 space-y-4"><div><div class="field-label">Metric</div>
        <div class="flex flex-wrap gap-2">${buttons}</div>
      </div></div>
    </aside>
  </section>`;
}

function renderModelDailyTrendChart(days, series, visible, selectedDay, key) {
  const width = 720, height = 220;
  const padding = { bottom: 34, left: 58, right: 16, top: 16 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  let maximum = 0;
  let latestIndex = days.length - 1;
  for (let index = 0; index < days.length; index += 1) {
    for (const { values } of visible) {
      if (values[index] === null) continue;
      maximum = Math.max(maximum, values[index]);
      latestIndex = index;
    }
  }
  const selectedIndex = days.findIndex((day) => day.date === selectedDay);
  const activeIndex = selectedIndex >= 0 ? selectedIndex : latestIndex;
  const activeDay = days[activeIndex];
  const ceiling = maximum || 1;
  const x = (index) => days.length === 1 ? padding.left + plotWidth / 2 : padding.left + index / (days.length - 1) * plotWidth;
  const y = (value) => padding.top + plotHeight - Math.max(0, value) / ceiling * plotHeight;
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = ceiling * (index / 4);
    const formatted = formatModelTrendValue(value);
    const label = formatted.length > 7 ? value.toExponential(2) : formatted;
    return `<line x1="${padding.left}" x2="${width - padding.right}" y1="${y(value)}" y2="${y(value)}" stroke="var(--color-bg-light-2)" stroke-width="1" />
      <text x="${padding.left - 8}" y="${y(value) + 4}" text-anchor="end" font-size="11" fill="var(--color-gray-accent)">${label}</text>`;
  }).join('');
  const labelEvery = Math.max(1, Math.ceil(days.length / 6));
  const labels = days.map((day, index) => index % labelEvery && index !== days.length - 1 ? '' :
    `<text x="${x(index)}" y="${height - 10}" text-anchor="middle" font-size="11" fill="var(--color-gray-accent)">${escapeHtml(formatChartDate(day.date))}</text>`).join('');
  const lines = visible.map(({ model, color, values }) => {
    let connected = false;
    const path = values.map((value, index) => {
      if (value === null) { connected = false; return ''; }
      const command = connected ? 'L' : 'M';
      connected = true;
      return `${command}${x(index)},${y(value)}`;
    }).join(' ');
    const dots = values.map((value, index) => value === null ? '' :
      `<circle cx="${x(index)}" cy="${y(value)}" r="2.5" fill="${color}" />`).join('');
    return `<g data-${key}-model="${escapeHtml(model)}"><path d="${path}" fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.25" />${dots}</g>`;
  }).join('');
  const marker = `<line data-${key}-active-day="${escapeHtml(activeDay.date)}" x1="${x(activeIndex)}" x2="${x(activeIndex)}"
    y1="${padding.top}" y2="${padding.top + plotHeight}" stroke="var(--color-bg-light-4)" stroke-dasharray="4 4" stroke-width="1" />`;
  const hitWidth = days.length === 1 ? plotWidth : plotWidth / (days.length - 1);
  const hover = days.map((day, index) => {
    const start = Math.max(padding.left, x(index) - hitWidth / 2);
    const end = Math.min(width - padding.right, x(index) + hitWidth / 2);
    const tooltip = [formatChartDate(day.date), ...visible.map(({ model, values }) =>
      `${model}: ${formatModelTrendValue(values[index])}`)].join('\n');
    return `<rect data-${key}-day="${escapeHtml(day.date)}" x="${start}" y="${padding.top}" width="${end - start}" height="${plotHeight}" fill="transparent" style="cursor: pointer;"><title>${escapeHtml(tooltip)}</title></rect>`;
  }).join('');
  const legend = series.map(({ model, color }) => `<span class="inline-flex items-center gap-1.5 text-xs font-medium max-w-full" style="color: var(--color-gray);">
    <span class="h-2 w-2 rounded-full shrink-0" style="background-color: ${color};"></span>
    <span style="overflow-wrap:anywhere;min-width:0">${escapeHtml(model)}</span></span>`).join('');
  const activeValues = visible.map(({ model, values }) =>
    `<span style="overflow-wrap:anywhere;min-width:0">${escapeHtml(model)}: ${formatModelTrendValue(values[activeIndex])}</span>`).join('');
  return `<div class="p-4 ${state.isTokenUsageLoading ? 'opacity-60' : ''}">
    <svg data-${key}-chart class="w-full h-56" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="${key}-title">
      ${grid}${labels}${marker}${lines}${hover}
    </svg>
    <div data-${key}-legend class="mt-2 flex flex-wrap gap-5">${legend}</div>
    <div data-${key}-values class="mt-2 flex flex-wrap gap-3 px-3 py-2 text-xs" style="background-color: var(--color-bg-soft); color: var(--color-fg-dark);">
      <span class="font-semibold" style="color: var(--color-fg-lightest);">${escapeHtml(formatChartDate(activeDay.date))}</span>${activeValues}
    </div>
  </div>`;
}

function renderOutputSpeedTrend(dailySummary, error) {
  return renderModelDailyTrend(dailySummary, error, {
    key: 'output-speed', title: 'Output speed (tokens/s)',
    valueOf: (row) => row?.output_tokens_per_second,
  });
}

function renderCostTrend(dailySummary, error) {
  return renderModelDailyTrend(dailySummary, error, {
    key: 'cost', title: 'Cost (USD)',
    valueOf: (row) => getCostAmount(row?.costs?.find((cost) => cost.currency === 'USD')),
  });
}

export const usageTrendScript = `const modelDailyTrendState = {
  'output-speed': { metric: null, day: null }, cost: { metric: null, day: null },
};\n` + [formatModelTrendValue, modelTrendColor, handleModelDailyTrendClick, renderModelDailyTrend,
  renderModelDailyTrendChart, renderOutputSpeedTrend, renderCostTrend].map(String).join('\n');
