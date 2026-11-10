'use strict';

const { randomUUID } = require('node:crypto');
const { AgentRuntime } = require('./agent');

const PERMISSION_MODES = new Set(['ask', 'read', 'full']);
// Recursive delegation and parent-owned interactive tools have separate
// lifecycles; don't let a child bypass those controls or overwrite its plan.
const EXCLUDED_TOOLS = new Set(['spawn_agent', 'delegate_task', 'ask_user', 'update_plan']);

function abortError() {
  const error = new Error('父任务已取消');
  error.name = 'AbortError';
  return error;
}

function definitionName(definition) {
  return definition?.function?.name || definition?.name;
}

/**
 * Owns short-lived child runtimes. The parent must pass its actual run payload,
 * abort signal and event emitter; model-supplied input never selects permissions,
 * tools, project, model credentials or parent identifiers.
 */
class SubagentManager {
  constructor({ toolDefinitions = [], executeTool, modelFactory, maxConcurrent = 3, runtimeFactory } = {}) {
    if (typeof executeTool !== 'function') throw new TypeError('缺少子智能体工具执行器');
    this.definitions = toolDefinitions.filter((definition) => !EXCLUDED_TOOLS.has(definitionName(definition)));
    this.executeTool = executeTool;
    this.modelFactory = modelFactory;
    this.runtimeFactory = runtimeFactory || ((options) => new AgentRuntime(options));
    this.maxConcurrent = Math.max(1, Math.min(8, Math.trunc(Number(maxConcurrent) || 3)));
    this.active = new Map();
    this.parents = new Map();
    this.queue = [];
  }

  /** Await the child result. `context` is supplied explicitly by the parent. */
  async run(parent, request, { signal, emit = () => {} } = {}) {
    if (!parent || !parent.runId || !parent.taskId || !parent.config) throw new Error('缺少父任务上下文');
    if (!signal || typeof signal.addEventListener !== 'function') throw new Error('缺少父任务取消信号');
    if (signal.aborted) throw abortError();
    const instruction = String(request?.instruction || '').trim();
    if (!instruction || instruction.length > 20000) throw new Error('子任务描述不能为空或超过 20000 字符');
    const context = String(request?.context || '').slice(0, 60000);
    const name = String(request?.name || '子任务').trim().slice(0, 80) || '子任务';
    const childId = `child_${randomUUID()}`;
    const parentId = String(parent.runId);
    const parentPermission = this.parents.get(parentId)?.permission || parent.permissionMode || 'ask';
    if (!PERMISSION_MODES.has(parentPermission)) throw new Error('无效的父任务权限');
    const parentState = this.parents.get(parentId) || { permission: parentPermission, children: new Set() };
    this.parents.set(parentId, parentState);
    parentState.children.add(childId);

    let resolveSlot, rejectSlot;
    const slot = new Promise((resolve, reject) => { resolveSlot = resolve; rejectSlot = reject; });
    const job = { childId, parentId, taskId: parent.taskId, name, parent, request: { instruction, context }, signal, emit,
      permission: parentState.permission, resolveSlot, rejectSlot, started: false, runtime: null };
    const onAbort = () => {
      if (job.started) job.runtime?.cancel(childId);
      else {
        const index = this.queue.indexOf(job);
        if (index >= 0) this.queue.splice(index, 1);
        rejectSlot(abortError());
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    this.queue.push(job);
    try {
      await this.#emit(job, { type: 'subagent.queued' });
      this.#dispatch();
      await slot;
      if (signal.aborted) throw abortError();
      const runPayload = {
        runId: childId,
        taskId: `${parent.taskId}:${childId}`,
        projectPath: parent.projectPath,
        mode: parent.mode,
        permissionMode: parent.mode === 'plan' ? 'read' : job.permission,
        config: { ...parent.config, systemPrompt: `${parent.config.systemPrompt || ''}\n你是受委派的子智能体。只完成分配的任务，将证据、变更、验证和未完成事项简明返回。不要创建其他子智能体。` },
        messages: [{ role: 'user', content: context ? `${instruction}\n\n父任务提供的上下文：\n${context}` : instruction }]
      };
      // Shared project tools still record changes under the original task, while
      // model and approval state retain their own unique child run identifiers.
      const runtime = this.runtimeFactory({
        toolDefinitions: this.definitions,
        modelFactory: this.modelFactory,
        executeTool: (tool, input, child, options) => this.executeTool(tool, input, {
          ...child, taskId: parent.taskId, parentRunId: parent.runId, childRunId: childId
        }, options)
      });
      job.runtime = runtime;
      await this.#emit(job, { type: 'subagent.started' });
      if (signal.aborted) throw abortError();
      runPayload.permissionMode = parent.mode === 'plan' ? 'read' : job.permission;
      const result = await runtime.run(runPayload, (event) => this.#emit(job, {
        type: 'subagent.event', event: { ...event, taskId: parent.taskId }
      }));
      const summary = (result.history || []).filter((message) => message.role === 'assistant' && message.content)
        .map((message) => typeof message.content === 'string' ? message.content : '')
        .filter(Boolean).join('\n').slice(-30000);
      await this.#emit(job, { type: 'subagent.completed', status: result.status, summary, error: result.error });
      return { id: childId, name, status: result.status, summary, ...(result.error ? { error: result.error } : {}) };
    } catch (error) {
      const cancelled = signal.aborted || error?.name === 'AbortError';
      await this.#emit(job, { type: 'subagent.completed', status: cancelled ? 'cancelled' : 'error', error: error.message });
      return { id: childId, name, status: cancelled ? 'cancelled' : 'error', summary: '', error: error.message };
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.active.delete(childId);
      parentState.children.delete(childId);
      if (!parentState.children.size) this.parents.delete(parentId);
      this.#dispatch();
    }
  }

  approve(parentRunId, childId, approvalId, approved) {
    const job = this.active.get(String(childId));
    if (!job || job.parentId !== String(parentRunId) || !job.runtime) return false;
    return job.runtime.approve({ runId: job.childId, approvalId, approved: Boolean(approved) });
  }

  setPermission(parentRunId, mode) {
    const parentId = String(parentRunId);
    const parent = this.parents.get(parentId);
    if (!parent || !PERMISSION_MODES.has(mode)) return false;
    parent.permission = mode;
    for (const job of this.queue) if (job.parentId === parentId) job.permission = mode;
    for (const job of this.active.values()) {
      if (job.parentId !== parentId) continue;
      job.permission = mode;
      job.runtime?.setPermission(job.childId, mode);
    }
    return true;
  }

  cancel(parentRunId, childId) {
    const parentId = String(parentRunId);
    const job = this.active.get(String(childId));
    if (!job || job.parentId !== parentId || !job.runtime) return false;
    return job.runtime.cancel(job.childId);
  }

  #dispatch() {
    while (this.active.size < this.maxConcurrent && this.queue.length) {
      const job = this.queue.shift();
      if (job.signal.aborted) { job.rejectSlot(abortError()); continue; }
      job.started = true;
      this.active.set(job.childId, job);
      job.resolveSlot();
    }
  }

  async #emit(job, data) {
    try { await job.emit({ ...data, runId: job.parentId, taskId: job.taskId, childId: job.childId, name: job.name }); }
    catch { /* A closed renderer must not leave child work blocked. */ }
  }
}

module.exports = { SubagentManager };
