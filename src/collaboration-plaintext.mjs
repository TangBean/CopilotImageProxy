export const CLIENT_NAMESPACE = 'collaboration';
export const UPSTREAM_NAMESPACE = 'codex_collaboration_plaintext';
const messageTools = new Set(['spawn_agent', 'send_message', 'followup_task']);
const inventories = new Set(['additional_tools', 'tool_search_output']);
const calls = new Set(['function_call', 'custom_tool_call']);
const callHistory = new Set([...calls, 'function_call_output', 'custom_tool_call_output']);
const identityKeys = ['type', 'namespace', 'name', 'call_id'];
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sequence = (value) => Array.isArray(value) ? value : [];
const present = (value) => typeof value === 'string' && value.length > 0;

export class CollaborationError extends Error {
  constructor(status, code, message) {
    super(message);
    Object.assign(this, { name: 'CollaborationError', status, code });
  }
}

const requestError = (code, message) => new CollaborationError(400, code, message);
const responseError = (code, message) => new CollaborationError(502, code, message);

function* toolLists(payload) {
  if (Array.isArray(payload.tools)) yield payload.tools;
  for (const item of sequence(payload.input)) {
    if (record(item) && inventories.has(item.type) && Array.isArray(item.tools)) yield item.tools;
  }
}

function messageSchema(tool) {
  if (!record(tool) || tool.type !== 'function' || !messageTools.has(tool.name)) return undefined;
  const message = tool.parameters?.properties?.message;
  return record(message) && message.type === 'string' ? message : undefined;
}

function mapArray(value, visit) {
  if (!Array.isArray(value)) return value;
  const mapped = value.map(visit);
  return mapped.some((item, index) => item !== value[index]) ? mapped : value;
}

function replace(value, fields) {
  return Object.entries(fields).some(([key, field]) => value[key] !== field) ? { ...value, ...fields } : value;
}

// Qualified names and namespace fields must describe the same registered tool.
function mapIdentity(value, from, to, fail) {
  if (!record(value)) return value;
  const namespace = value.namespace;
  const name = value.name;
  for (const known of [CLIENT_NAMESPACE, UPSTREAM_NAMESPACE]) {
    for (const separator of ['.', '__']) {
      if (!present(name) || !name.startsWith(known + separator)) continue;
      if (present(namespace) && namespace !== known) {
        throw fail('proxy_collaboration_identity_conflict', '协作工具的 namespace 与名称不一致。');
      }
      if (known === from) {
        const shortName = name.slice(known.length + separator.length);
        if (!shortName) throw fail('proxy_collaboration_identity_conflict', '协作工具名称为空。');
        return replace(value, { namespace: to, name: shortName });
      }
    }
  }
  return namespace === from ? replace(value, { namespace: to }) : value;
}

function mapChoice(choice, from, to, fail) {
  if (!record(choice)) return choice;
  if (choice.type === 'namespace' && choice.name === from) return { ...choice, name: to };
  if (choice.type === 'allowed_tools') return replace(choice, { tools: mapArray(choice.tools, (item) => mapChoice(item, from, to, fail)) });
  const result = mapIdentity(choice, from, to, fail);
  if (result !== choice && !Object.hasOwn(choice, 'namespace') && present(choice.name)) {
    const separator = choice.name.startsWith(from + '__') ? '__' : '.';
    return { ...choice, name: `${to}${separator}${result.name}` };
  }
  return result;
}

function mapTools(tools, from, to, actions) {
  return mapArray(tools, (tool) => {
    if (!record(tool) || tool.type !== 'namespace' || tool.name !== from) return tool;
    const children = mapArray(tool.tools, (child) => {
      const message = messageSchema(child);
      if (!message || !actions.has(child.name)) return child;
      const updated = { ...message };
      if (from === CLIENT_NAMESPACE) delete updated.encrypted;
      else updated.encrypted = true;
      return { ...child, parameters: { ...child.parameters, properties: { ...child.parameters.properties, message: updated } } };
    });
    return { ...tool, name: to, ...(Array.isArray(children) ? { tools: children } : {}) };
  });
}

function hasAliasReference(value) {
  if (!record(value)) return false;
  if (value.namespace === UPSTREAM_NAMESPACE || value.name === UPSTREAM_NAMESPACE) return true;
  if (present(value.name) && ['.', '__'].some((separator) => value.name.startsWith(UPSTREAM_NAMESPACE + separator))) return true;
  return value.type === 'allowed_tools' && sequence(value.tools).some(hasAliasReference);
}

export function createPlaintextCollaboration(payload) {
  if (!record(payload)) return undefined;
  const actions = new Set();
  const lists = [...toolLists(payload)];
  for (const tools of lists) {
    for (const tool of tools) {
      if (!record(tool) || tool.type !== 'namespace' || tool.name !== CLIENT_NAMESPACE) continue;
      for (const child of sequence(tool.tools)) {
        if (messageSchema(child)?.encrypted === true) actions.add(child.name);
      }
    }
  }
  if (!actions.size) return undefined;
  for (const tools of lists) for (const tool of tools) {
    if (tool?.type !== 'namespace' || tool.name !== CLIENT_NAMESPACE) continue;
    for (const child of sequence(tool.tools)) {
      if (actions.has(child?.name) && messageSchema(child)?.encrypted !== true) {
        throw requestError('proxy_collaboration_schema_conflict', '协作消息工具的重复声明具有冲突的加密合同。');
      }
    }
  }
  if (payload.store === true || (payload.store !== undefined && payload.store !== false)
    || (payload.previous_response_id !== undefined && payload.previous_response_id !== null && payload.previous_response_id !== '')
    || (payload.conversation !== undefined && payload.conversation !== null && payload.conversation !== '')) {
    throw requestError('proxy_collaboration_stateful_request', '明文协作要求 store=false 并显式回放历史，不支持服务端隐式续接。');
  }
  if (lists.some((tools) => tools.some(hasAliasReference))
    || sequence(payload.input).some((item) => record(item) && callHistory.has(item.type) && hasAliasReference(item))
    || hasAliasReference(payload.tool_choice)) {
    throw requestError('proxy_collaboration_alias_conflict', '明文协作的固定工具别名已被占用。');
  }
  const projected = { ...payload, store: false };
  if (Object.hasOwn(payload, 'tools')) projected.tools = mapTools(payload.tools, CLIENT_NAMESPACE, UPSTREAM_NAMESPACE, actions);
  if (Object.hasOwn(payload, 'tool_choice')) projected.tool_choice = mapChoice(payload.tool_choice, CLIENT_NAMESPACE, UPSTREAM_NAMESPACE, requestError);
  if (Array.isArray(payload.input)) projected.input = payload.input.map((item) => {
    if (!record(item)) return item;
    if (inventories.has(item.type)) return replace(item, { tools: mapTools(item.tools, CLIENT_NAMESPACE, UPSTREAM_NAMESPACE, actions) });
    return callHistory.has(item.type) ? mapIdentity(item, CLIENT_NAMESPACE, UPSTREAM_NAMESPACE, requestError) : item;
  });

  const identities = new Map();
  const restoredIds = new Set();
  const stats = { restoredCalls: 0 };

  function restoreCall(value, index, argumentEvent = false, mark = true, complete = false) {
    if (!record(value)) return value;
    let canonical = mapIdentity(value, UPSTREAM_NAMESPACE, UPSTREAM_NAMESPACE, responseError);
    const known = identities.get(index);
    if (canonical.namespace === CLIENT_NAMESPACE) throw responseError('proxy_collaboration_identity_conflict', '上游返回了未声明的原生协作身份。');
    if (argumentEvent && known?.type && known.type !== 'function_call') {
      throw responseError('proxy_collaboration_identity_conflict', '函数参数事件与已知输出项类型不一致。');
    }
    const keys = argumentEvent ? identityKeys.slice(1) : identityKeys;
    const current = Object.fromEntries(keys.filter((key) => present(canonical[key])).map((key) => [key, canonical[key]]));
    for (const [key, field] of Object.entries(current)) {
      if (known?.[key] !== undefined && known[key] !== field) throw responseError('proxy_collaboration_identity_conflict', '同一输出项的协作工具身份发生冲突。');
    }
    const merged = { ...known, ...current };
    if (complete && merged.namespace === UPSTREAM_NAMESPACE && identityKeys.some((key) => !present(merged[key]))) {
      throw responseError('proxy_collaboration_incomplete_identity', '完整协作调用缺少可确定的工具身份。');
    }
    if (Number.isInteger(index) && index >= 0) identities.set(index, merged);
    if (merged.namespace !== UPSTREAM_NAMESPACE) return value;
    canonical = replace(canonical, Object.fromEntries(keys.filter((key) => merged[key] !== undefined).map((key) => [key, merged[key]])));
    const restored = mapIdentity(canonical, UPSTREAM_NAMESPACE, CLIENT_NAMESPACE, responseError);
    if (!mark || restored.namespace !== CLIENT_NAMESPACE || !actions.has(restored.name)
      || (argumentEvent ? merged.type !== 'function_call' : restored.type !== 'function_call')) return restored;
    if (Object.hasOwn(value, 'encrypted_function_args')
      && (!Array.isArray(value.encrypted_function_args) || value.encrypted_function_args.length !== 0)) {
      throw responseError('proxy_collaboration_encrypted_arguments', '上游为明文协作工具返回了冲突的加密参数标记。');
    }
    if (present(restored.call_id)) restoredIds.add(restored.call_id);
    stats.restoredCalls = restoredIds.size;
    return replace(restored, { encrypted_function_args: [] });
  }

  function restoreItem(item, index, complete = false) {
    if (!record(item)) return item;
    if (inventories.has(item.type)) return replace(item, { tools: mapTools(item.tools, UPSTREAM_NAMESPACE, CLIENT_NAMESPACE, actions) });
    return restoreCall(item, index, false, true, complete);
  }

  function restoreResponse(response) {
    if (!record(response)) throw responseError('proxy_collaboration_invalid_response', '上游 JSON 响应不是对象。');
    const fields = {};
    if (Object.hasOwn(response, 'output')) fields.output = mapArray(response.output, (item, index) => restoreItem(item, index, true));
    if (Object.hasOwn(response, 'tools')) fields.tools = mapTools(response.tools, UPSTREAM_NAMESPACE, CLIENT_NAMESPACE, actions);
    if (Object.hasOwn(response, 'tool_choice')) fields.tool_choice = mapChoice(response.tool_choice, UPSTREAM_NAMESPACE, CLIENT_NAMESPACE, responseError);
    return replace(response, fields);
  }

  function restoreEvent(event) {
    if (!record(event)) throw responseError('proxy_collaboration_invalid_response', '上游 SSE 数据不是对象。');
    const index = Number.isInteger(event.output_index) && event.output_index >= 0 ? event.output_index : undefined;
    const fields = {};
    if (Object.hasOwn(event, 'item')) fields.item = restoreItem(event.item, index, event.type === 'response.output_item.done');
    if (record(event.response)) fields.response = restoreResponse(event.response);
    const updated = replace(event, fields);
    if (event.type === 'response.function_call_arguments.done') return restoreCall(updated, index, true);
    if (event.type === 'response.function_call_arguments.delta') return restoreCall(updated, index, true, false);
    return updated;
  }

  return { payload: projected, stats, restoreResponse, restoreEvent };
}
