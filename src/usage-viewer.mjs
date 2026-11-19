import { isUtf8 } from 'node:buffer';
import { parse as parseScript } from 'acorn';
import { full, simple as walk } from 'acorn-walk';
import { parse as parseHtml } from 'parse5';
import { usageTrendScript } from './usage-trends.mjs';
import { createUsageViewerClient } from './usage-viewer-client.mjs';
import { dashboardEndpoint, installUsageViewer, prepareUsageLocation } from './usage-viewer-page.mjs';

export class UsageViewerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageViewerError';
    this.status = 502;
    this.code = 'proxy_usage_viewer_incompatible';
  }
}

function one(nodes, label) {
  if (nodes.length !== 1) {
    throw new UsageViewerError(`Upstream usage viewer is incompatible: ${label} is ${nodes.length ? 'duplicated' : 'missing'}.`);
  }
  return nodes[0];
}

function nodesIn(root, type, matches) {
  const found = [];
  walk(root, { [type](node) { if (matches(node)) found.push(node); } });
  return found;
}

const member = (node, object, property) => node?.type === 'MemberExpression' && !node.computed &&
  node.object.name === object && node.property.name === property;

function dashboardScript(body) {
  // HTML offsets in this single-byte view are byte offsets in the original response.
  const html = parseHtml(body.toString('latin1'), { sourceCodeLocationInfo: true });
  const scripts = [], selects = [];
  function visit(node) {
    if (node.tagName === 'select' && node.attrs.some(a => a.name === 'id' && a.value === 'token-usage-period')) selects.push(node);
    const type = node.tagName === 'script' && node.attrs.find(a => a.name === 'type')?.value.trim().toLowerCase();
    if (node.tagName === 'script' && (!type || type === 'text/javascript' || type === 'application/javascript') &&
        !node.attrs.some(a => a.name === 'src')) {
      const location = node.sourceCodeLocation;
      if (location?.endTag) {
        const start = location.startTag.endOffset, end = location.endTag.startOffset;
        const bytes = body.subarray(start, end);
        if (bytes.includes('tokenUsagePeriodSelect')) {
          const encoding = isUtf8(bytes) ? 'utf8' : 'latin1';
          const source = bytes.toString(encoding);
          let script;
          try { script = parseScript(source, { ecmaVersion: 'latest' }); }
          catch { throw new UsageViewerError('Upstream usage viewer contains an invalid dashboard script.'); }
          for (const statement of script.body) {
            const call = statement.expression;
            if (call?.type !== 'CallExpression' || !member(call.callee, 'document', 'addEventListener') ||
                call.arguments[0]?.value !== 'DOMContentLoaded') continue;
            const block = call.arguments[1]?.body;
            if (block?.type === 'BlockStatement' && block.body.some(s => s.type === 'FunctionDeclaration' && s.id.name === 'init')) {
              scripts.push({ source, start, end, encoding, block });
            }
          }
        }
      }
    }
    for (const child of node.childNodes ?? []) visit(child);
  }
  visit(html);
  one(selects, 'period select');
  return one(scripts, 'dashboard initializer');
}

function variableIn(block, name) {
  const declarations = block.body.filter(s => s.type === 'VariableDeclaration').flatMap(s => s.declarations);
  return one(declarations.filter(d => d.id.name === name), name);
}

function initializerIn(block, name) {
  const expression = variableIn(block, name).init;
  if (!expression) throw new UsageViewerError(`Upstream usage viewer is missing the initializer for ${name}.`);
  return expression;
}

const clientScript = [usageTrendScript, prepareUsageLocation, createUsageViewerClient, installUsageViewer,
  'return { ...installUsageViewer(createUsageViewerClient), prepareUsageLocation };'].join('\n');

export function rewriteUsageViewer(body, { host, port }) {
  const { source, start, end, encoding, block } = dashboardScript(body);
  const edits = [];
  const replace = (node, text) => edits.push({ start: node.start, end: node.end, text });
  const insert = (index, text) => edits.push({ start: index, end: index, text });
  const sourceOf = node => source.slice(node.start, node.end);
  const fn = name => one(block.body.filter(s => s.type === 'FunctionDeclaration' && s.id.name === name), name);
  const identifiers = new Set();
  full(block, node => { if (node.type === 'Identifier') identifiers.add(node.name); });
  let client = 'proxyUsage';
  while (identifiers.has(client)) client += '_';

  // Check only the bindings the installed browser code actually uses. The upstream
  // retains its listeners, request guards, paging, isolation and native rendering.
  for (const name of ['normalizePeriod', 'resolveUsageUrl', 'deriveEndpointUrl', 'syncTokenUsageConnection',
    'applyUsageIsolation', 'getConnectionKey', 'getEndpointOrigin', 'getErrorMessage',
    'fetchJson', 'buildRequestHeaders', 'renderTokenUsageRangeText', 'renderTokenUsageDailyTrend', 'formatRangeText',
    'escapeHtml', 'getCostAmount', 'formatChartDate', 'renderError', 'renderEmptyState']) fn(name);
  for (const name of ['state', 'contentArea', 'endpointUrlInput', 'currentEndpointOrigin', 'VALID_PERIODS',
    'DEFAULT_TOKEN_USAGE_PERIOD']) variableIn(block, name);
  const select = initializerIn(block, 'tokenUsagePeriodSelect');
  if (!member(select?.callee, 'document', 'getElementById') || select.arguments[0]?.value !== 'token-usage-period') {
    throw new UsageViewerError('Upstream usage viewer is missing the period select binding.');
  }
  const authority = host === '::1' ? `[${host}]:${port}` : `${host}:${port}`;
  replace(initializerIn(block, 'DEFAULT_ENDPOINT'), `(${dashboardEndpoint})(${JSON.stringify('http://' + authority + '/usage')})`);
  const initCall = one(block.body.filter(s => s.expression?.type === 'CallExpression' && s.expression.callee.name === 'init'), 'init call');
  insert(initCall.start, `const ${client} = (() => {\n${clientScript}\n})();\n`);

  const periodRead = one(fn('init').body.body.filter(s => s.type === 'VariableDeclaration' &&
    s.declarations.some(d => d.init?.callee?.name === 'normalizePeriod')), 'initial period selection');
  insert(periodRead.start, `if (!${client}.prepareUsageLocation()) return;\n`);

  const refresh = fn('fetchTokenUsageSummaryAndEvents').body;
  const dailyReset = one(refresh.body.filter(s => member(s.expression?.left, 'state', 'tokenUsageDailySummary') &&
    s.expression.right?.value === null), 'daily summary reset');
  replace(dailyReset, `${client}.beginRefresh(state.tokenUsagePeriod);`);
  const batch = one(nodesIn(refresh, 'CallExpression', n => member(n.callee, 'Promise', 'allSettled')), 'usage request batch');
  const summary = one(nodesIn(batch, 'CallExpression', n => n.callee.name === 'fetchJson' &&
    n.arguments[0]?.callee?.name === 'buildTokenUsageSummaryUrl'), 'guarded usage request');
  const requestInputs = [...summary.arguments[0].arguments, summary.arguments[1]];
  if (batch.arguments.length !== 1 || requestInputs.length !== 3 || requestInputs.some(n => n?.type !== 'Identifier')) {
    throw new UsageViewerError('Upstream usage viewer has an incompatible usage request signature.');
  }
  replace(batch, `${client}.settle(${sourceOf(batch.arguments[0])}, ${requestInputs.map(sourceOf).join(', ')})`);
  const publishesDailyError = s => member(s.expression?.left, 'state', 'tokenUsageDailyError');
  const invalidEndpoint = one(refresh.body.filter(s => s.type === 'IfStatement' &&
    s.consequent.body?.some(publishesDailyError)), 'empty endpoint handling').consequent;
  const failed = one(refresh.body.filter(s => s.type === 'TryStatement' && s.handler), 'usage error handling').handler.body;
  for (const branch of [invalidEndpoint, failed]) {
    const error = one(branch.body.filter(publishesDailyError), 'usage error publication');
    insert(error.end, `\n${client}.refreshFailed(state.tokenUsageDailyError);`);
  }

  const render = fn('render').body, section = fn('renderTokenUsageSection').body;
  const spinner = one(render.body.filter(s => s.type === 'IfStatement' && member(s.test, 'state', 'isLoading')), 'usage spinner');
  replace(spinner.test, '(state.isLoading && !state.tokenUsageDailySummary && !state.tokenUsageHourlySummary)');
  for (const condition of [initializerIn(render, 'hasContent'), initializerIn(section, 'hasTokenUsageContent')]) {
    replace(condition, `Boolean(state.tokenUsageHourlySummary || state.tokenUsageHourlyError || (${sourceOf(condition)}))`);
  }
  one(nodesIn(section, 'CallExpression', n => n.callee.name === 'renderTokenUsageDailyTrend'), 'daily trend slot');
  for (const [renderer, id] of [['renderTokenUsageModelBreakdown', 'name'], ['renderTokenUsageEventsTable', 'sessionId']]) {
    const table = fn(renderer);
    const cells = [];
    walk(table.body, { TemplateLiteral(template) {
      template.expressions.forEach((value, i) => {
        if (value.callee?.name === 'escapeHtml' && value.arguments[0]?.name === id &&
            /^\s*<\/td\s*>/i.test(template.quasis[i + 1].value.raw)) cells.push(value.arguments[0]);
      });
    } });
    let title = `${client}.sessionTitle(${id})`;
    if (id === 'name') {
      const by = table.params[1]?.left ?? table.params[1];
      if (by?.type !== 'Identifier') throw new UsageViewerError('Upstream usage viewer has no breakdown grouping argument.');
      title = `${by.name} === "session" ? ${title} : name`;
    }
    replace(one(cells, renderer + ' session cell'), title);
  }

  let cursor = 0;
  const parts = [];
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    if (edit.start < cursor) throw new UsageViewerError('Upstream usage viewer hooks overlap.');
    parts.push(source.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(source.slice(cursor));
  return Buffer.concat([body.subarray(0, start), Buffer.from(parts.join(''), encoding), body.subarray(end)]);
}
