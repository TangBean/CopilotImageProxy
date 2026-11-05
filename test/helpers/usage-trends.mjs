import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { usageTrendScript } from '../../src/usage-trends.mjs';

const upstream = readFileSync(new URL('../fixtures/usage-viewer.upstream.html', import.meta.url), 'utf8');
const helpers = [
  'escapeHtml', 'getCostAmount', 'formatChartDate', 'formatRangeDate', 'formatRangeText',
  'renderTokenUsageRangeText', 'renderEmptyState', 'renderError',
].map((name) => {
  const start = upstream.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing upstream helper: ${name}`);
  const end = upstream.indexOf('\n        }', start);
  assert.ok(end > start, `Unterminated upstream helper: ${name}`);
  return upstream.slice(start, end + '\n        }'.length);
}).join('\n');

class Element {
  constructor(attributes) { this.attributes = attributes; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  closest(selector) { return this.hasAttribute(selector.slice(1, -1)) ? this : null; }
}

export function viewer(period = 'last_7_days', source = usageTrendScript) {
  const context = {
    state: { tokenUsagePeriod: period, isTokenUsageLoading: false },
    Element,
    render() {},
  };
  runInNewContext(`${helpers}\n${source}`, context);
  context.click = (chart, kind, value = '') => {
    context.handleModelDailyTrendClick({ target: new Element({ [`data-${chart}-${kind}`]: value }) });
  };
  return context;
}

export const tooltips = (html) => [...html.matchAll(/<title>([\s\S]*?)<\/title>/g)]
  .map(([, title]) => title);

export const count = (html, marker) => html.split(marker).length - 1;

export function groups(html, key = 'output-speed') {
  return [...html.matchAll(new RegExp(`<g data-${key}-model="([^"]*)">([\\s\\S]*?)<\\/g>`, 'g'))]
    .map(([, model, body]) => ({
      model, body, path: body.match(/<path d="([^"]*)"/)?.[1],
      color: body.match(/stroke="([^"]*)"/)?.[1],
      dots: [...body.matchAll(/<circle cx="([^"]*)" cy="([^"]*)" r="([^"]*)"/g)]
        .map(([, x, y, radius]) => ({ x: Number(x), y: Number(y), radius: Number(radius) })),
    }));
}

export function activeValues(html, key = 'output-speed') {
  return html.match(new RegExp(`<div[^>]*data-${key}-values[^>]*>([\\s\\S]*?)<\\/div>`))?.[1] ?? '';
}
