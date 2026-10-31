import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlaintextCollaboration, UPSTREAM_NAMESPACE } from '../src/collaboration-plaintext.mjs';
import { validateConfig } from '../src/config.mjs';

const actions = ['spawn_agent', 'send_message', 'followup_task'];
const text = '读取 probe.txt，保留 "引号"、λ 和换行。\n第二行';
const argumentsText = JSON.stringify({ message: text, target: '/root/reader' });
function tools() {
  return [{ type: 'namespace', name: 'collaboration', description: 'Keep collaboration.spawn_agent in prose.', tools: [
    ...actions.map((name) => ({ type: 'function', name, parameters: { type: 'object', properties: {
      message: { type: 'string', encrypted: true, description: 'Task' }, model: { type: 'string' }, target: { type: 'string', encrypted: true },
    } } })), { type: 'function', name: 'wait_agent', parameters: { type: 'object' } },
  ] }];
}
function call(extra = {}) {
  return { type: 'function_call', namespace: UPSTREAM_NAMESPACE, name: 'send_message', call_id: 'call_1', id: 'fc_1', arguments: argumentsText, ...extra };
}

test('model opt-ins are independent, immutable, exact and disabled by default', () => {
  const config = validateConfig();
  assert.deepEqual(config.plaintextCollaborationModels, []);
  assert.deepEqual(config.earlyResponseErrorModels, []);
  const input = ['gpt-6-astra'];
  const enabled = validateConfig({ plaintextCollaborationModels: input });
  input.push('gpt-6.1-sol');
  assert.deepEqual(enabled.plaintextCollaborationModels, ['gpt-6-astra']);
  assert.ok(Object.isFrozen(enabled.plaintextCollaborationModels));
  for (const key of ['plaintextCollaborationModels', 'earlyResponseErrorModels']) {
    for (const value of [null, true, 'gpt-6-astra', ['*'], ['GPT-6-astra'], ['gpt-6-luna'], [null]]) {
      assert.throws(() => validateConfig({ [key]: value }));
    }
  }
});

test('projects only declared identities and message annotations, preserving history and arguments', () => {
  const oldCipher = { type: 'agent_message', author: '/root', content: [{ type: 'encrypted_content', encrypted_content: 'opaque-old' }] };
  const reasoning = { type: 'reasoning', encrypted_content: 'opaque-reasoning' };
  const payload = { model: 'gpt-6-astra', reasoning: { effort: 'ultra' }, input: [
    { role: 'user', content: 'Use collaboration.send_message; never replace this prose.' },
    call({ namespace: 'collaboration' }), oldCipher, reasoning,
    { type: 'compaction', encrypted_content: 'opaque-compaction' },
    { type: 'additional_tools', tools: tools() }, { type: 'tool_search_output', tools: tools() },
  ], tools: tools(), tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', namespace: 'collaboration', name: 'send_message' }] } };
  const original = structuredClone(payload);
  const adapter = createPlaintextCollaboration(payload);
  const projected = adapter.payload;
  assert.deepEqual(payload, original);
  assert.equal(projected.store, false);
  assert.equal(projected.model, payload.model);
  assert.deepEqual(projected.reasoning, payload.reasoning);
  assert.equal(projected.tools[0].name, UPSTREAM_NAMESPACE);
  assert.equal(projected.tools[0].description, payload.tools[0].description);
  for (const tool of projected.tools[0].tools.slice(0, 3)) {
    assert.equal(Object.hasOwn(tool.parameters.properties.message, 'encrypted'), false);
    assert.equal(tool.parameters.properties.target.encrypted, true);
  }
  assert.equal(projected.input[0].content, original.input[0].content);
  assert.equal(projected.input[1].namespace, UPSTREAM_NAMESPACE);
  assert.equal(projected.input[1].arguments, argumentsText);
  assert.deepEqual(projected.input.slice(2, 5), original.input.slice(2, 5));
  assert.equal(projected.input[5].tools[0].name, UPSTREAM_NAMESPACE);
  assert.equal(projected.input[6].tools[0].name, UPSTREAM_NAMESPACE);
  assert.equal(projected.tool_choice.tools[0].namespace, UPSTREAM_NAMESPACE);
});

for (const inventory of ['additional_tools', 'tool_search_output']) test(`${inventory} can activate without top-level tools`, () => {
  const adapter = createPlaintextCollaboration({ input: [{ type: inventory, tools: tools() }] });
  assert.ok(adapter);
  assert.equal(adapter.payload.input[0].tools[0].name, UPSTREAM_NAMESPACE);
});

test('unrecognized schemas do not activate or restrict ordinary requests', () => {
  for (const change of [
    (t) => { t[0].name = 'ordinary'; },
    (t) => { t[0].tools.forEach((x) => { if (x.parameters.properties?.message) x.parameters.properties.message.encrypted = false; }); },
    (t) => { t[0].tools = [{ type: 'custom', name: 'spawn_agent', parameters: { properties: { message: { type: 'string', encrypted: true } } } }]; },
  ]) {
    const value = tools(); change(value);
    assert.equal(createPlaintextCollaboration({ tools: value, store: true, previous_response_id: 'r' }), undefined);
  }
});

test('stateless and alias guards reject before any upstream operation', () => {
  for (const extra of [{ store: true }, { store: null }, { previous_response_id: 'r' }, { conversation: 'c' }, { conversation: { id: 'c' } }]) {
    assert.throws(() => createPlaintextCollaboration({ tools: tools(), ...extra }), { status: 400, code: 'proxy_collaboration_stateful_request' });
  }
  assert.ok(createPlaintextCollaboration({ tools: tools(), store: false, previous_response_id: null, conversation: '' }));
  assert.throws(() => createPlaintextCollaboration({ tools: [...tools(), { type: 'namespace', name: UPSTREAM_NAMESPACE }] }), { code: 'proxy_collaboration_alias_conflict' });
  assert.throws(() => createPlaintextCollaboration({ tools: tools(), input: [call()] }), { code: 'proxy_collaboration_alias_conflict' });
});

for (const separator of ['.', '__']) test(`qualified ${separator} identities and tool choices round-trip`, () => {
  const adapter = createPlaintextCollaboration({ tools: tools(), input: [{ ...call(), namespace: undefined, name: `collaboration${separator}send_message` }],
    tool_choice: { type: 'function', name: `collaboration${separator}send_message` } });
  assert.equal(adapter.payload.tool_choice.name, `${UPSTREAM_NAMESPACE}${separator}send_message`);
  assert.equal(adapter.payload.input[0].name, 'send_message');
  const result = adapter.restoreResponse({ output: [call({ namespace: undefined, name: `${UPSTREAM_NAMESPACE}${separator}send_message` })] });
  assert.equal(result.output[0].namespace, 'collaboration');
  assert.equal(result.output[0].name, 'send_message');
  assert.equal(result.output[0].arguments, argumentsText);
  assert.deepEqual(result.output[0].encrypted_function_args, []);
});

test('JSON restoration selects only message function calls and preserves unrelated metadata', () => {
  const adapter = createPlaintextCollaboration({ tools: tools() });
  const input = { output: [call(), call({ name: 'wait_agent', call_id: 'call_wait', encrypted_function_args: ['unchanged'] }),
    call({ type: 'custom_tool_call', call_id: 'call_custom', encrypted_function_args: ['unchanged'] }),
    { type: 'reasoning', encrypted_content: 'old' }], usage: { total_tokens: 42 }, provider: { keep: true }, tools: adapter.payload.tools };
  const original = structuredClone(input);
  const result = adapter.restoreResponse(input);
  assert.deepEqual(input, original);
  assert.deepEqual(result.output[0].encrypted_function_args, []);
  assert.equal(result.output[0].call_id, 'call_1');
  assert.equal(result.output[0].arguments, argumentsText);
  assert.deepEqual(result.output[1].encrypted_function_args, ['unchanged']);
  assert.deepEqual(result.output[2].encrypted_function_args, ['unchanged']);
  assert.deepEqual(result.usage, input.usage);
  assert.deepEqual(result.provider, input.provider);
  assert.deepEqual(result.output[3], input.output[3]);
  assert.equal(result.tools[0].name, 'collaboration');
  assert.equal(adapter.stats.restoredCalls, 1);
});

test('sparse SSE identities remain tied to the same output index', () => {
  const adapter = createPlaintextCollaboration({ tools: tools() });
  const added = adapter.restoreEvent({ type: 'response.output_item.added', output_index: 1, item: call({ arguments: '' }) });
  assert.deepEqual(added.item.encrypted_function_args, []);
  const argsDone = adapter.restoreEvent({ type: 'response.function_call_arguments.done', output_index: 1, name: null, namespace: '', arguments: argumentsText });
  assert.equal(argsDone.namespace, 'collaboration');
  assert.equal(argsDone.name, 'send_message');
  assert.equal(argsDone.call_id, 'call_1');
  const itemDone = adapter.restoreEvent({ type: 'response.output_item.done', output_index: 1, item: { type: null, namespace: null, name: '', call_id: '', arguments: argumentsText } });
  assert.equal(itemDone.item.type, 'function_call');
  assert.equal(itemDone.item.namespace, 'collaboration');
  assert.deepEqual(itemDone.item.encrypted_function_args, []);
  const completed = adapter.restoreEvent({ type: 'response.completed', response: { output: [{ type: 'reasoning' }, call()] } });
  assert.equal(completed.response.output[1].namespace, 'collaboration');
  assert.equal(adapter.stats.restoredCalls, 1);
});

test('separate requests never share stream identity', () => {
  const first = createPlaintextCollaboration({ tools: tools() });
  first.restoreEvent({ type: 'response.output_item.added', output_index: 0, item: call() });
  const second = createPlaintextCollaboration({ tools: tools() });
  const ordinary = { type: 'response.output_item.done', output_index: 0, item: { type: 'message', content: [] } };
  assert.equal(second.restoreEvent(ordinary), ordinary);
});

test('identity and encryption conflicts fail instead of pretending ciphertext is plaintext', () => {
  for (const extra of [{ namespace: 'other' }, { name: 'spawn_agent' }, { call_id: 'different' }, { type: 'custom_tool_call' }]) {
    const adapter = createPlaintextCollaboration({ tools: tools() });
    adapter.restoreEvent({ type: 'response.output_item.added', output_index: 0, item: call() });
    assert.throws(() => adapter.restoreEvent({ type: 'response.output_item.done', output_index: 0, item: call(extra) }), { status: 502, code: 'proxy_collaboration_identity_conflict' });
  }
  for (const value of [null, ['message'], {}, 'message']) {
    const adapter = createPlaintextCollaboration({ tools: tools() });
    assert.throws(() => adapter.restoreResponse({ output: [call({ encrypted_function_args: value })] }), { code: 'proxy_collaboration_encrypted_arguments' });
  }
  assert.throws(() => createPlaintextCollaboration({ tools: tools(), input: [call({ namespace: 'other', name: 'collaboration.send_message' })] }), { status: 400 });
});

test('non-collaboration output identity cannot change into a collaboration call', () => {
  const adapter = createPlaintextCollaboration({ tools: tools() });
  adapter.restoreEvent({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', namespace: 'ordinary', name: 'read', call_id: 'other' } });
  assert.throws(() => adapter.restoreEvent({ type: 'response.output_item.done', output_index: 0, item: call() }), { code: 'proxy_collaboration_identity_conflict' });
});

test('conflicting message declarations fail before upstream access', () => {
  const history = tools();
  history[0].tools[0].parameters.properties.message.encrypted = false;
  assert.throws(() => createPlaintextCollaboration({ tools: tools(), input: [{type:'additional_tools',tools:history}] }), { status: 400, code: 'proxy_collaboration_schema_conflict' });
});

test('argument deltas validate identity and retain the exact parameter fragment', () => {
  const adapter = createPlaintextCollaboration({ tools: tools() });
  adapter.restoreEvent({ type: 'response.output_item.added', output_index: 0, item: call() });
  const event = { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"message":"λ', namespace: null, name: '' };
  const result = adapter.restoreEvent(event);
  assert.equal(result.delta, event.delta);
  assert.equal(result.namespace, 'collaboration');
  assert.equal(result.name, 'send_message');
  assert.equal(result.encrypted_function_args, undefined);
  assert.throws(() => adapter.restoreEvent({ ...event, call_id: 'different' }), { code: 'proxy_collaboration_identity_conflict' });
});

test('a complete alias call cannot guess missing identity without a prior event', () => {
  const adapter = createPlaintextCollaboration({ tools: tools() });
  assert.throws(() => adapter.restoreResponse({output:[call({name:null})]}), {code:'proxy_collaboration_incomplete_identity'});
  const sparse = createPlaintextCollaboration({ tools: tools() });
  sparse.restoreEvent({type:'response.output_item.added',output_index:0,item:call({name:null,call_id:null})});
  const restored=sparse.restoreEvent({type:'response.output_item.done',output_index:0,item:call()});
  assert.equal(restored.item.namespace,'collaboration');
  assert.deepEqual(restored.item.encrypted_function_args,[]);
});

test('ordinary sparse events remain unchanged while their identity is tracked', () => {
  const adapter = createPlaintextCollaboration({ tools: tools() });
  adapter.restoreEvent({type:'response.output_item.added',output_index:0,item:{type:'function_call',namespace:'ordinary',name:'read',call_id:'ordinary_1'}});
  const delta={type:'response.function_call_arguments.delta',output_index:0,namespace:null,name:'',delta:'{}',keep:42};
  assert.equal(adapter.restoreEvent(delta),delta);
  const done={type:'response.output_item.done',output_index:0,item:{type:null,namespace:null,name:'',arguments:'{}'}};
  assert.equal(adapter.restoreEvent(done),done);
});

test('function argument events cannot attach to an output of a different type', () => {
  const adapter = createPlaintextCollaboration({ tools: tools() });
  adapter.restoreEvent({type:'response.output_item.added',output_index:0,item:{type:'message'}});
  assert.throws(()=>adapter.restoreEvent({type:'response.function_call_arguments.delta',output_index:0,delta:'{}'}),{code:'proxy_collaboration_identity_conflict'});
});
