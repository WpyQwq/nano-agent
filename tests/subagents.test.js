'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BaseChatModel } = require('@langchain/core/language_models/chat_models');
const { AIMessageChunk } = require('@langchain/core/messages');
const { ChatGenerationChunk } = require('@langchain/core/outputs');
const { SubagentManager } = require('../backend/subagents');

const parent = (overrides = {}) => ({ runId: 'parent-run', taskId: 'parent-task', projectPath: 'E:/test-project',
  config: { provider: 'openai', model: 'mock', systemPrompt: 'parent rules' }, permissionMode: 'ask', ...overrides });
const writeTool = { name: 'write_file', description: 'Write', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } };
const delegated = { name: 'spawn_agent', description: 'Delegate', parameters: { type: 'object', properties: {} } };

class ScriptedModel extends BaseChatModel {
  constructor(script, capture) { super({}); this.script = script; this.calls = 0; this.capture = capture; }
  _llmType() { return 'subagent-test'; }
  bindTools(tools) { this.capture.tools = tools.map((tool) => tool.name); return this; }
  async _generate(messages, options, manager) {
    const chunks = [];
    for await (const chunk of this._streamResponseChunks(messages, options, manager)) chunks.push(chunk.message);
    const message = AIMessageChunk.concat(chunks);
    return { generations: [{ text: String(message.content || ''), message }] };
  }
  async *_streamResponseChunks(messages, _options, manager) {
    this.capture.messages = messages;
    const step = this.script[this.calls++] || { text: '完成' };
    if (step.calls) yield new ChatGenerationChunk({ message: new AIMessageChunk({ content: '', tool_calls: step.calls }), text: '' });
    if (step.text) {
      await manager?.handleLLMNewToken(step.text, {}, undefined, 'text');
      yield new ChatGenerationChunk({ message: new AIMessageChunk({ content: step.text }), text: step.text });
    }
  }
}

function sink() {
  const events = [];
  return {
    events,
    emit: (event) => events.push(event),
    wait: async (predicate) => {
      for (let i = 0; i < 200; i++) { const event = events.find(predicate); if (event) return event; await new Promise(resolve => setTimeout(resolve, 5)); }
      throw new Error('等待事件超时');
    }
  };
}

test('child has isolated context, forwards events and excludes recursive delegation', async () => {
  const capture = {}, events = sink(), controller = new AbortController();
  const manager = new SubagentManager({ toolDefinitions: [writeTool, delegated], executeTool: async () => ({}),
    modelFactory: () => new ScriptedModel([{ text: '调查完成' }], capture) });
  const result = await manager.run(parent(), { name: '检查', instruction: '检查入口', context: '仅给子任务的信息' }, { signal: controller.signal, emit: events.emit });
  assert.equal(result.status, 'success'); assert.equal(result.summary, '调查完成');
  assert.deepEqual(capture.tools, ['write_file']);
  const user = capture.messages.find(message => message._getType() === 'human');
  assert.match(user.content, /检查入口/); assert.match(user.content, /仅给子任务的信息/);
  assert.ok(capture.messages.some(message => message._getType() === 'system' && JSON.stringify(message.content).includes('parent rules')));
  assert.ok(events.events.some(event => event.type === 'subagent.event' && event.event.type === 'message.delta' && event.runId === 'parent-run' && event.taskId === 'parent-task'));
  assert.equal(events.events.filter(event => event.type === 'subagent.completed').length, 1);
});

test('child writes require parent-routed approval and retain original task ownership', async () => {
  const capture = {}, events = sink(), controller = new AbortController(), calls = [];
  const manager = new SubagentManager({ toolDefinitions: [writeTool], executeTool: async (...args) => { calls.push(args); return { ok: true }; },
    modelFactory: () => new ScriptedModel([{ calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'ok' }, id: 'write-1', type: 'tool_call' }] }, { text: '写入完成' }], capture) });
  const pending = manager.run(parent(), { instruction: '修改文件' }, { signal: controller.signal, emit: events.emit });
  const request = await events.wait(event => event.type === 'subagent.event' && event.event.type === 'approval.required');
  assert.equal(calls.length, 0);
  assert.equal(manager.approve('other-parent', request.childId, request.event.approvalId, true), false);
  assert.equal(manager.approve('parent-run', request.childId, request.event.approvalId, true), true);
  const result = await pending;
  assert.equal(result.status, 'success'); assert.equal(calls.length, 1);
  assert.equal(calls[0][2].taskId, 'parent-task'); assert.equal(calls[0][2].projectPath, 'E:/test-project');
  assert.equal(calls[0][2].childRunId, request.childId);
});

test('parent permission changes propagate to a waiting child, plan cannot be widened', async () => {
  const controller = new AbortController(), events = sink(), calls = [];
  const manager = new SubagentManager({ toolDefinitions: [writeTool], executeTool: async () => { calls.push(1); return { ok: true }; },
    modelFactory: () => new ScriptedModel([{ calls: [{ name: 'write_file', args: { path: 'a', content: 'b' }, id: 'w', type: 'tool_call' }] }, { text: '完成' }], {}) });
  const pending = manager.run(parent(), { instruction: '写入' }, { signal: controller.signal, emit: events.emit });
  await events.wait(event => event.event?.type === 'approval.required');
  assert.equal(manager.setPermission('parent-run', 'read'), true);
  assert.equal((await pending).status, 'success'); assert.equal(calls.length, 0);
  const planEvents = sink();
  const planned = await manager.run(parent({ runId: 'plan', mode: 'plan', permissionMode: 'full' }), { instruction: '写入' }, { signal: controller.signal, emit: planEvents.emit });
  assert.equal(planned.status, 'success'); assert.equal(calls.length, 0);
  assert.ok(planEvents.events.some(event => event.event?.type === 'tool.error'));
});

test('concurrency is bounded and parent cancellation stops active and queued children', async () => {
  const controller = new AbortController(), events = sink(); let active = 0, highest = 0;
  const manager = new SubagentManager({ maxConcurrent: 1, toolDefinitions: [writeTool],
    executeTool: async (_name, _input, _payload, { signal }) => {
      active++; highest = Math.max(highest, active);
      try { await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); }
      finally { active--; }
    },
    modelFactory: () => new ScriptedModel([{ calls: [{ name: 'write_file', args: { path: 'a', content: 'b' }, id: 'w', type: 'tool_call' }] }], {}) });
  const first = manager.run(parent({ permissionMode: 'full' }), { instruction: '第一项' }, { signal: controller.signal, emit: events.emit });
  await events.wait(event => event.event?.type === 'tool.started');
  const second = manager.run(parent({ permissionMode: 'full' }), { instruction: '第二项' }, { signal: controller.signal, emit: events.emit });
  await events.wait(event => event.type === 'subagent.queued' && events.events.filter(e => e.type === 'subagent.queued').length === 2);
  controller.abort();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => result.status), ['cancelled', 'cancelled']); assert.equal(highest, 1);
  assert.equal(events.events.filter(event => event.type === 'subagent.started').length, 1);
  assert.equal(events.events.filter(event => event.type === 'subagent.completed').length, 2);
});

test('rejects missing parent identity, missing cancellation and invalid requests', async () => {
  const manager = new SubagentManager({ executeTool: async () => ({}) });
  await assert.rejects(manager.run({}, { instruction: 'x' }, { signal: new AbortController().signal }), /父任务上下文/);
  await assert.rejects(manager.run(parent(), { instruction: 'x' }), /取消信号/);
  await assert.rejects(manager.run(parent(), { instruction: '' }, { signal: new AbortController().signal }), /子任务描述/);
});
