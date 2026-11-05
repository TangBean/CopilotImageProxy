// Injected into the upstream dashboard's scope by usage-viewer.mjs.
function renderModelDailyTrend(dailySummary, error, { key, title, unit, valueOf }) {
  if (state.tokenUsagePeriod === 'today') return '';
  const days = dailySummary?.days || [];
  const rows = days.map((day) => new Map((day.byModel || []).map((row) => [row.model, row])));
  const models = [...new Set([
    ...(dailySummary?.byModel || []).map((row) => row.model),
    ...rows.flatMap((day) => [...day.keys()]),
  ])].filter((model) => typeof model === 'string').sort();
  const palette = ['blue', 'green', 'aqua', 'yellow', 'purple', 'orange', 'red', 'gray'];
  const colorOf = (model) => {
    let hash = 2166136261;
    for (const char of model) hash = Math.imul(hash ^ char.codePointAt(0), 16777619) >>> 0;
    return `var(--color-${palette[hash % palette.length]}-accent)`;
  };
  const formatValue = (value) => value === null ? '\u2014' : value.toLocaleString('en-US', {
    maximumSignificantDigits: 6, useGrouping: false,
  });
  let maximum = 0;
  const series = models.map((model) => ({
    model, color: colorOf(model), values: rows.map((day) => {
      const value = valueOf(day.get(model));
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      maximum = Math.max(maximum, value);
      return value;
    }),
  }));
  const heading = `<div class="panel-header"><p class="panel-title">${title}</p>
    <p class="panel-meta">${unit} \u00b7 per model \u00b7 daily</p></div>`;
  const panel = (body) => `<section class="panel mt-3" data-${key}-panel>${heading}${body}</section>`;
  if (error) return panel(`<div class="p-4">${renderError(error, `${title} failed`)}</div>`);
  if (!days.length || !models.length) return panel('<p class="p-4" style="color:var(--color-gray)">\u2014 No daily model data.</p>');

  const left = 96, right = 932, top = 28, bottom = 236;
  const ceiling = maximum || 1;
  const x = (index) => days.length === 1 ? (left + right) / 2 : left + index / (days.length - 1) * (right - left);
  const y = (value) => bottom - value / ceiling * (bottom - top);
  const legend = series.map(({ model, color }) => `<span style="display:inline-flex;align-items:center;gap:6px;max-width:100%;min-width:0">
    <span style="width:18px;flex-shrink:0;border-top:3px solid ${color}"></span>
    <span style="overflow-wrap:anywhere">${escapeHtml(model)}</span></span>`).join('');
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = ceiling * (index / 4);
    const label = value >= 1e9 || (value > 0 && value < 1e-6) ? value.toExponential(3) : formatValue(value);
    return `<line x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}" stroke="var(--color-bg-light-2)" />
      <text x="${left - 10}" y="${y(value) + 4}" text-anchor="end">${label}</text>`;
  }).join('');
  const lines = series.map(({ model, color, values }) => {
    let connected = false;
    const path = values.map((value, index) => {
      if (value === null) { connected = false; return ''; }
      const command = connected ? 'L' : 'M';
      connected = true;
      return `${command}${x(index)},${y(value)}`;
    }).join(' ');
    const dots = values.map((value, index) => value === null ? '' :
      `<circle cx="${x(index)}" cy="${y(value)}" r="3" fill="${color}" />`).join('');
    return `<g data-${key}-model="${escapeHtml(model)}"><path d="${path}" fill="none" stroke="${color}" stroke-width="2" />${dots}</g>`;
  }).join('');
  const labels = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])].map((index) =>
    `<text x="${x(index)}" y="260" text-anchor="${days.length === 1 ? 'middle' : index === 0 ? 'start' : index === days.length - 1 ? 'end' : 'middle'}">${escapeHtml(days[index].date)}</text>`).join('');
  const hover = days.map((day, index) => {
    const start = index === 0 ? left : (x(index - 1) + x(index)) / 2;
    const end = index === days.length - 1 ? right : (x(index) + x(index + 1)) / 2;
    const tooltip = [day.date, ...series.map(({ model, values }) =>
      `${model}: ${formatValue(values[index])} ${unit}`)].join('\n');
    return `<rect data-${key}-day="${escapeHtml(day.date)}" x="${start}" y="${top}" width="${end - start}" height="${bottom - top}" fill="transparent"><title>${escapeHtml(tooltip)}</title></rect>`;
  }).join('');
  return panel(`<div class="p-4">
    <div data-${key}-legend style="display:flex;flex-wrap:wrap;gap:8px 18px;font-size:12px;margin-bottom:12px">${legend}</div>
    <div style="overflow-x:auto"><svg data-${key}-chart viewBox="0 0 960 280" role="img" aria-label="${title} by model in ${unit}"
      style="width:100%;min-width:640px;display:block;font-size:12px;fill:var(--color-gray)">
      <text x="${left}" y="16">${unit}</text>${grid}${lines}${labels}${hover}
    </svg></div></div>`);
}

function renderOutputSpeedTrend(dailySummary, error) {
  return renderModelDailyTrend(dailySummary, error, {
    key: 'output-speed', title: 'Output speed', unit: 'tokens/s',
    valueOf: (row) => row?.output_tokens_per_second,
  });
}

function renderCostTrend(dailySummary, error) {
  return renderModelDailyTrend(dailySummary, error, {
    key: 'cost', title: 'Cost (USD)', unit: 'USD',
    valueOf: (row) => getCostAmount(row?.costs?.find((cost) => cost.currency === 'USD')),
  });
}

export const usageTrendScript = [renderModelDailyTrend, renderOutputSpeedTrend, renderCostTrend].map(String).join('\n');
