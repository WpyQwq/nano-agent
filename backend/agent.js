'use strict';

const { randomUUID } = require('node:crypto');
const {
  createAgent,
  createMiddleware,
  DynamicStructuredTool,
  HumanMessage,
  AIMessage,
  ToolMessage
} = require('langchain');

const DEFAULT_MAX_STEPS = 12;
const MAX_STEPS = 40;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_TIMEOUT_MS = 60000;

// Tools that mutate the workspace or the desktop. Read-only runs never execute these.
const ASK_TOOLS = new Set(['write_file', 'run_command', 'computer_action']);
const ALWAYS_APPROVAL_TOOLS = new Set(['trash_file']);
const PROTECTED_TOOLS = new Set([...ASK_TOOLS, ...ALWAYS_APPROVAL_TOOLS]);
const PERMISSION_MODES = new Set(['ask', 'full', 'read']);
// There is deliberately no path to permanent deletion. Files must go through trash_file.
const PERMANENT_DELETE_TOOLS = new Set([
  'delete_file',
  'delete_files',
  'delete_directory',
  'delete_folder',
  'permanent_delete',
  'permanently_delete',
  'remove_file',
  'rm_file',
  'unlink_file'
]);
const PERMANENT_DELETE_PATTERN = /^(?:delete|remove|del|rm|unlink|permanent|permanently)(?:_|$)/i;
const MUTATING_TOOL_PATTERN = /^(?:write|edit|create|delete|remove|move|rename|mkdir|mkdirp|trash|run|exec|shell|computer_action|apply_patch|patch_file)\b/i;

function abortError(message = 'Run cancelled') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function isAbortError(error, signal) {
  return Boolean(
    signal?.aborted
    || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR'
    || /aborted|cancell?ed|已取消|操作已取消/i.test(String(error?.message || ''))
  );
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function errorMessage(error) {
  if (!error) return 'Unknown error';
  return String(error.message || error);
}

function isPermanentDelete(name) {
  const normalized = String(name || '').toLowerCase();
  return PERMANENT_DELETE_TOOLS.has(normalized) || PERMANENT_DELETE_PATTERN.test(normalized);
}

function isProtectedTool(name, definition) {
  const normalized = String(name || '');
  return Boolean(definition?.requiresApproval)
    || PROTECTED_TOOLS.has(normalized)
    || MUTATING_TOOL_PATTERN.test(normalized);
}

// Tools that still require confirmation even with full permission. MCP tools can
// opt in through requiresApproval; trash_file can never be permanently bypassed.
function requiresApprovalInFullMode(name, definition) {
  return ALWAYS_APPROVAL_TOOLS.has(name) || Boolean(definition?.requiresApproval);
}

function normalizeToolCalls(toolCalls = []) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((call) => {
    if (!call || typeof call !== 'object') return null;
    if (call.function && typeof call.function === 'object') {
      let args = call.function.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args || '{}'); } catch { args = {}; }
      }
      return {
        name: call.function.name || call.name || 'unknown',
        args: args && typeof args === 'object' ? args : {},
        id: call.id || `call_${randomUUID()}`,
        type: 'tool_call'
      };
    }
    const args = call.args ?? call.input ?? {};
    return {
      name: call.name || 'unknown',
      args: args && typeof args === 'object' ? args : {},
      id: call.id || `call_${randomUUID()}`,
      type: 'tool_call'
    };
  }).filter(Boolean);
}

function contentToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        if (typeof part.text === 'string') return part.text;
        if (part.type === 'text' && typeof part.content === 'string') return part.content;
      }
      return '';
    }).join('');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  try { return JSON.stringify(content); } catch { return String(content); }
}

const REASONING_BLOCK_TYPES = new Set([
  'reasoning',
  'reasoning_text',
  'reasoning_content',
  'thinking',
  'redacted_thinking'
]);
const REASONING_METADATA_KEYS = ['reasoning_content', 'reasoning', 'thinking'];

function isReasoningBlock(part) {
  return Boolean(part && typeof part === 'object'
    && REASONING_BLOCK_TYPES.has(String(part.type || '').toLowerCase()));
}

function reasoningBlockText(part) {
  if (!isReasoningBlock(part)) return '';
  if (typeof part.text === 'string') return part.text;
  if (typeof part.reasoning === 'string') return part.reasoning;
  if (typeof part.thinking === 'string') return part.thinking;
  if (Array.isArray(part.summary)) {
    return part.summary.map((item) => (
      item && typeof item === 'object' && typeof item.text === 'string' ? item.text : ''
    )).join('');
  }
  return '';
}

// Only provider-returned reasoning blocks are surfaced; nothing is derived or
// reconstructed from hidden chain-of-thought.
function reasoningTextFromContent(content) {
  if (!Array.isArray(content)) return '';
  return content.map(reasoningBlockText).join('');
}

// Visible text for message.delta. Thinking blocks are deliberately excluded so
// reasoning can never be duplicated into the assistant message.
function visibleContentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object' || isReasoningBlock(part)) return '';
      if (typeof part.text === 'string') return part.text;
      if (part.type === 'text' && typeof part.content === 'string') return part.content;
      return '';
    }).join('');
  }
  if (isReasoningBlock(content)) return '';
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return contentToText(content);
}

function reasoningTextFromMetadata(additional = {}) {
  if (!additional || typeof additional !== 'object') return '';
  const pieces = [];
  for (const key of REASONING_METADATA_KEYS) {
    const value = additional[key];
    if (typeof value === 'string') pieces.push(value);
    else if (value && typeof value === 'object') {
      if (typeof value.text === 'string') pieces.push(value.text);
      else if (typeof value.reasoning === 'string') pieces.push(value.reasoning);
    }
  }
  if (Array.isArray(additional.reasoning_details)) {
    for (const item of additional.reasoning_details) {
      if (item && typeof item === 'object' && typeof item.text === 'string') pieces.push(item.text);
    }
  }
  // Some providers repeat the same reasoning under several keys.
  return [...new Set(pieces)].join('');
}

// Providers either stream incremental reasoning or resend a growing snapshot.
// Emit only the not-yet-streamed suffix so reasoning is never duplicated across
// content blocks and additional_kwargs. Content blocks are already deltas.
function planReasoningDelta(state, text, snapshot = false) {
  if (!text) return '';
  const previous = String(state.value || '');
  if (!previous) {
    state.value = text;
    return text;
  }
  if (!snapshot) {
    if (text === previous) return '';
    state.value = previous + text;
    return text;
  }
  if (text === previous) return '';
  if (text.startsWith(previous)) {
    state.value = text;
    return text.slice(previous.length);
  }
  if (previous.endsWith(text)) return '';
  state.value = previous + text;
  return text;
}

function usageFromChatModelOutput(output) {
  const metadata = output?.usage_metadata;
  if (metadata) {
    const inputTokens = Number(metadata.input_tokens || 0);
    const outputTokens = Number(metadata.output_tokens || 0);
    return {
      inputTokens,
      outputTokens,
      totalTokens: Number(metadata.total_tokens || 0) || inputTokens + outputTokens,
      ...(metadata.input_token_details?.cache_read != null ? { cachedTokens:Number(metadata.input_token_details.cache_read) } : {})
    };
  }
  const response = output?.response_metadata || {};
  const raw = response.tokenUsage || response.usage || response.usage_metadata;
  if (!raw || typeof raw !== 'object') return null;
  const inputTokens = Number(raw.input_tokens ?? raw.promptTokens ?? raw.prompt_tokens ?? 0);
  const outputTokens = Number(raw.output_tokens ?? raw.completionTokens ?? raw.completion_tokens ?? 0);
  const totalTokens = Number(raw.total_tokens ?? raw.totalTokens ?? 0) || inputTokens + outputTokens;
  if (!inputTokens && !outputTokens && !totalTokens) return null;
  const cached=raw.prompt_tokens_details?.cached_tokens ?? raw.input_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens;
  return { inputTokens, outputTokens, totalTokens, ...(cached != null ? {cachedTokens:Number(cached)} : {}) };
}

function toolContent(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output?.content)) return output.content;
  try { return JSON.stringify(output ?? null); } catch { return String(output); }
}

function normalizeMessages(inputMessages, systemPrompt) {
  const messages = [];
  const systemParts = [];
  if (systemPrompt) systemParts.push(String(systemPrompt));

  for (const rawInput of Array.isArray(inputMessages) ? inputMessages : []) {
    if (!rawInput) continue;
    if (typeof rawInput._getType === 'function') {
      const type = rawInput._getType();
      if (type === 'system') {
        const text = contentToText(rawInput.content);
        if (text) systemParts.push(text);
      } else {
        messages.push(rawInput);
      }
      continue;
    }
    // Accept BaseMessage.toDict() output as well as plain role based history.
    const raw = rawInput.data && typeof rawInput.data === 'object' && !rawInput.role && rawInput.type
      ? { role: rawInput.type === 'human' ? 'user' : rawInput.type, ...rawInput.data }
      : rawInput;
    const role = String(raw.role || raw.type || 'user').toLowerCase();
    const content = raw.content ?? '';
    if (role === 'system' || role === 'developer') {
      const text = contentToText(content);
      if (text) systemParts.push(text);
      continue;
    }
    if (role === 'assistant' || role === 'ai') {
      const toolCalls = normalizeToolCalls(raw.tool_calls || raw.toolCalls || raw.additional_kwargs?.tool_calls || []);
      messages.push(new AIMessage({
        content,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...(raw.id ? { id: raw.id } : {})
      }));
      continue;
    }
    if (role === 'tool') {
      messages.push(new ToolMessage({
        content: Array.isArray(content) || typeof content === 'string' ? content : toolContent(content),
        tool_call_id: raw.tool_call_id || raw.toolCallId || '',
        ...(raw.name ? { name: raw.name } : {}),
        ...(raw.id ? { id: raw.id } : {})
      }));
      continue;
    }
    messages.push(new HumanMessage({
      content,
      ...(raw.id ? { id: raw.id } : {})
    }));
  }

  return { messages, prompt: systemParts.filter(Boolean).join('\n\n') };
}

function messageToPlain(message) {
  const type = typeof message?._getType === 'function' ? message._getType() : '';
  if (type === 'ai') {
    const toolCalls = normalizeToolCalls(message.tool_calls || []);
    return {
      role: 'assistant',
      content: message.content,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      ...(message.id ? { id: message.id } : {})
    };
  }
  if (type === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.tool_call_id || '',
      ...(message.name ? { name: message.name } : {}),
      ...(message.id ? { id: message.id } : {})
    };
  }
  if (type === 'system') return { role: 'system', content: message.content, ...(message.id ? { id: message.id } : {}) };
  if (type === 'human') return { role: 'user', content: message.content, ...(message.id ? { id: message.id } : {}) };
  return { role: type || 'user', content: message?.content ?? '' };
}

function historyFromMessages(messages) {
  const plain = (Array.isArray(messages) ? messages : []).map((message) => {
    if (typeof message?.toDict === 'function') return messageToPlain(message);
    if (message && typeof message === 'object' && message.role) return message;
    return { role: 'user', content: contentToText(message) };
  });
  // A cancelled call may have no tool result. Close every pending call before
  // persisting so the next provider request cannot contain an orphan tool call.
  const balanced = [];
  for (let index = 0; index < plain.length; index++) {
    const message = plain[index];
    balanced.push(message);
    if (message.role !== 'assistant' || !message.tool_calls?.length) continue;
    const results = [];
    while (plain[index + 1]?.role === 'tool') results.push(plain[++index]);
    const byId = new Map(results.map(result => [result.tool_call_id, result]));
    for (const call of message.tool_calls) balanced.push(byId.get(call.id) || {
      role: 'tool', tool_call_id: call.id, name: call.name,
      content: JSON.stringify({ ok: false, cancelled: true, error: '操作中断，未获得执行结果；不要假定操作已完成。' })
    });
  }
  return balanced.filter((message, index) => message.role !== 'tool' || balanced.slice(0,index).some(m => m.role === 'assistant' && m.tool_calls?.some(c => c.id === message.tool_call_id)));
}

function rawHistoryFromMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    if (typeof message?.toDict === 'function') return message.toDict();
    return message;
  });
}

function usageFromMessages(messages) {
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const message of Array.isArray(messages) ? messages : []) {
    const metadata = message?.usage_metadata;
    if (!metadata) continue;
    usage.inputTokens += Number(metadata.input_tokens || 0);
    usage.outputTokens += Number(metadata.output_tokens || 0);
    usage.totalTokens += Number(metadata.total_tokens || 0);
  }
  if (!usage.totalTokens) usage.totalTokens = usage.inputTokens + usage.outputTokens;
  return usage;
}

function normalizeToolDefinitions(definitions) {
  const normalized = [];
  for (const definition of Array.isArray(definitions) ? definitions : []) {
    if (!definition || typeof definition !== 'object') continue;
    const fn = definition.function && typeof definition.function === 'object' ? definition.function : definition;
    const name = String(fn.name || definition.name || '').trim();
    if (!name) continue;
    let parameters = fn.parameters || fn.schema || definition.parameters || { type: 'object', properties: {} };
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
      parameters = { type: 'object', properties: {} };
    } else if (!parameters.type) {
      parameters = { type: 'object', ...parameters };
    }
    normalized.push({
      name,
      description: String(fn.description || definition.description || `${name} tool`),
      parameters,
      requiresApproval: Boolean(definition.requiresApproval || fn.requiresApproval)
    });
  }
  return normalized;
}

function normalizeOpenAIBaseUrl(baseUrl) {
  let value = String(baseUrl || 'https://api.openai.com/v1').trim();
  value = value.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  try {
    const url = new URL(value);
    let pathname = url.pathname.replace(/\/+$/, '');
    if (!pathname) pathname = '/v1';
    url.pathname = pathname;
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value || 'https://api.openai.com/v1';
  }
}

function normalizeAnthropicBaseUrl(baseUrl) {
  let value = String(baseUrl || 'https://api.anthropic.com').trim();
  value = value.replace(/\/+$/, '');
  // The Anthropic SDK appends /v1/messages itself, so accept either form from settings.
  value = value.replace(/\/v1(?:\/messages)?$/i, '');
  return value.replace(/\/+$/, '') || 'https://api.anthropic.com';
}

function createModel(config = {}) {
  const provider = String(config.provider || 'openai').toLowerCase();
  if (provider === 'demo') {
    const error = new Error('演示模式：尚未配置模型。请在设置中填写 Base URL、API Key 和模型名称。');
    error.code = 'DEMO_MODE';
    throw error;
  }
  const model = String(config.model || '').trim();
  if (!model) throw new Error('尚未配置模型名称（config.model）。');

  const maxRetries = clampInteger(config.maxRetries, DEFAULT_MAX_RETRIES, 0, 3);
  const timeout = clampInteger(config.timeout ?? config.timeoutMs, DEFAULT_TIMEOUT_MS, 5000, 300000);
  const maxTokens = config.maxOutputTokens || config.maxTokens;

  if (provider === 'anthropic') {
    const { ChatAnthropic } = require('@langchain/anthropic');
    return new ChatAnthropic({
      model,
      apiKey: config.apiKey,
      anthropicApiUrl: normalizeAnthropicBaseUrl(config.baseUrl),
      temperature: config.temperature ?? 0.2,
      ...(maxTokens ? { maxTokens } : {}),
      ...(config.outputConfig ? { outputConfig: config.outputConfig } : {}),
      streaming: true,
      clientOptions: { maxRetries, timeout }
    });
  }

  if (provider === 'openai') {
    const { ChatOpenAI } = require('@langchain/openai');
    const baseURL = normalizeOpenAIBaseUrl(config.baseUrl);
    return new ChatOpenAI({
      model,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      temperature: config.temperature ?? 0.2,
      ...(maxTokens ? { maxTokens } : {}),
      ...(config.reasoningEffort && config.reasoningEffort !== 'default' && /^(?:o[1-9]|gpt-5|gpt-6)/i.test(model) ? { reasoning: { effort: config.reasoningEffort } } : {}),
      ...(config.reasoningEffort && config.reasoningEffort !== 'default' && config.forceReasoningEffort && !/^(?:o[1-9]|gpt-5|gpt-6)/i.test(model) ? { modelKwargs: { reasoning_effort:config.reasoningEffort } } : {}),
      streaming: true,
      timeout,
      configuration: { baseURL, maxRetries, timeout }
    });
  }

  throw new Error(`不支持的模型提供方：${provider}`);
}

function buildPermissionDecision(ctx, name, definition) {
  const mode = String(ctx.payload.permissionMode || 'ask').toLowerCase();
  if (isPermanentDelete(name)) {
    return { action: 'reject', message: `永久删除被禁止，请使用 trash_file 移入回收站：${name}` };
  }
  const protectedTool = isProtectedTool(name, definition);
  if (mode === 'read') {
    if (protectedTool) return { action: 'reject', message: `只读模式不允许执行受保护工具：${name}` };
    return { action: 'allow' };
  }
  if (mode === 'full') {
    if (ALWAYS_APPROVAL_TOOLS.has(name) || definition?.requiresApproval) {
      return { action: 'approval', reason: `工具 ${name} 始终需要用户确认` };
    }
    return { action: 'allow' };
  }
  if (ALWAYS_APPROVAL_TOOLS.has(name)) {
    return { action: 'approval', reason: `工具 ${name} 会移动文件，始终需要用户确认` };
  }
  if (protectedTool) {
    return { action: 'approval', reason: `工具 ${name} 需要用户授权后才能执行` };
  }
  return { action: 'allow' };
}

function waitForApproval(ctx, approvalId, name, input, reason, definition) {
  return new Promise((resolve, reject) => {
    const signal = ctx.controller.signal;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      ctx.pendingApprovals.delete(approvalId);
      cleanup();
      reject(abortError());
    };
    const pending = {
      approvalId,
      name,
      input,
      definition,
      resolve: (value) => { cleanup(); resolve(value); },
      reject: (error) => { cleanup(); reject(error); }
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    ctx.pendingApprovals.set(approvalId, pending);
    signal.addEventListener('abort', onAbort, { once: true });
    ctx.emitEvent({
      type: 'approval.required',
      approvalId,
      name,
      input,
      reason
    }).catch(() => {});
  });
}

function resolvePendingApproval(ctx, approvalId, approved, reason) {
  const pending = ctx.pendingApprovals.get(approvalId);
  if (!pending) return false;
  ctx.pendingApprovals.delete(approvalId);
  ctx.emitEvent({
    type: 'approval.resolved',
    approvalId,
    name: pending.name,
    approved: Boolean(approved),
    ...(reason ? { reason } : {})
  }).catch(() => {});
  pending.resolve({ approved: Boolean(approved), ...(reason ? { reason } : {}) });
  return true;
}

function withAbort(promise, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => reject(abortError());
    signal.addEventListener('abort', listener, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    if (listener) signal.removeEventListener('abort', listener);
  });
}

async function invokeTool(ctx, definition, input, runConfig) {
  const name = definition.name;
  const callId = runConfig?.toolCall?.id || `call_${ctx.nextCallId()}`;
  const safeInput = input && typeof input === 'object' ? input : {};

  await ctx.emitEvent({ type: 'tool.started', callId, name, input: safeInput });

  const decision = buildPermissionDecision(ctx, name, definition);
  if (decision.action === 'reject') {
    await ctx.emitEvent({ type: 'tool.error', callId, name, error: decision.message });
    return toolContent({ ok: false, rejected: true, error: decision.message });
  }

  if (decision.action === 'approval') {
    const approvalId = `approval_${ctx.runId}_${ctx.nextApprovalId()}`;
    const resolution = await waitForApproval(ctx, approvalId, name, safeInput, decision.reason, definition);
    if (!resolution?.approved) {
      const output = {
        ok: false,
        rejected: true,
        error: resolution?.reason || `用户拒绝了工具 ${name} 的执行`
      };
      await ctx.emitEvent({ type: 'tool.completed', callId, name, output });
      return toolContent(output);
    }
  }

  if (ctx.controller.signal.aborted) throw abortError();

  try {
    const result = await withAbort(
      Promise.resolve(ctx.executeTool(name, safeInput, ctx.payload, { signal: ctx.controller.signal })),
      ctx.controller.signal
    );
    await ctx.emitEvent({ type: 'tool.completed', callId, name, output: result });
    return toolContent(result);
  } catch (error) {
    if (isAbortError(error, ctx.controller.signal)) throw abortError();
    const message = errorMessage(error);
    await ctx.emitEvent({ type: 'tool.error', callId, name, error: message });
    // Returning a tool result (instead of throwing) lets the model recover and explain the failure.
    return toolContent({ ok: false, error: message });
  }
}

class AgentRuntime {
  constructor(options = {}) {
    this.toolDefinitions = normalizeToolDefinitions(options.toolDefinitions);
    this.executeTool = typeof options.executeTool === 'function'
      ? options.executeTool
      : async () => { throw new Error('AgentRuntime.executeTool 未配置'); };
    this.modelFactory = typeof options.modelFactory === 'function' ? options.modelFactory : null;
    this.runs = new Map();
    this.activeTasks = new Map();
    this.usedRunIds = new Set();
  }

  async run(payload = {}, emit = () => {}) {
    const runId = String(payload.runId || `run_${randomUUID()}`);
    const taskId = payload.taskId ?? null;
    const config = payload.config && typeof payload.config === 'object' ? payload.config : {};

    if (this.usedRunIds.has(runId)) {
      return { ok: false, status: 'error', error: `重复的 runId：${runId}`, runId };
    }
    if (taskId != null && this.activeTasks.has(taskId)) {
      return { ok: false, status: 'error', error: `任务 ${taskId} 已有运行中的智能体，请先取消或等待完成`, runId };
    }

    const ctx = {
      runId,
      taskId,
      payload,
      config,
      executeTool: this.executeTool,
      startedAt: Date.now(),
      controller: new AbortController(),
      pendingApprovals: new Map(),
      reasoningStates: new Map(),
      steering: [],
      approvalSequence: 0,
      callSequence: 0,
      terminal: false,
      history: historyFromMessages(normalizeMessages(payload.messages).messages),
      rawHistory: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      nextApprovalId: () => ++ctx.approvalSequence,
      nextCallId: () => ++ctx.callSequence,
      emitEvent: async (event) => {
        if (typeof emit !== 'function') return;
        await emit({ ...event, runId, taskId });
      }
    };

    this.usedRunIds.add(runId);
    this.runs.set(runId, ctx);
    if (taskId != null) this.activeTasks.set(taskId, runId);

    try {
      await ctx.emitEvent({ type: 'run.started' });
      if (ctx.controller.signal.aborted) return await this.#finish(ctx, 'cancelled');

      if (String(config.provider || '').toLowerCase() === 'demo') {
        return await this.#finish(ctx, 'success', await this.#demoResult(ctx));
      }

      const model = await this.#createRunModel(ctx);
      const tools = this.#buildTools(ctx);
      const { messages, prompt } = normalizeMessages(payload.messages, config.systemPrompt);
      const maxSteps = clampInteger(config.maxSteps, DEFAULT_MAX_STEPS, 1, MAX_STEPS);
      const recursionLimit = maxSteps * 2 + 2;

      const agent = createAgent({
        model,
        tools,
        middleware: [createMiddleware({
          name: 'NanoStepLimit',
          beforeModel: async () => {
            ctx.modelCalls = (ctx.modelCalls || 0) + 1;
            if (ctx.modelCalls > maxSteps) throw new Error(`智能体超过最大步骤数（maxSteps=${maxSteps}）`);
            const messages = ctx.steering.splice(0);
            for (const item of messages) await ctx.emitEvent({ type: 'steer.applied', id: item.id, content: item.content });
            if (messages.length) {
              const incoming = messages.map(item => new HumanMessage({ content: item.content, id: item.id }));
              collected.push(...incoming);
              return { messages: incoming };
            }
          }
        })],
        ...(prompt ? { systemPrompt: prompt } : {})
      });

      let finalState = null;
      let inputMessages = messages;
      let collected = [];
      let streamedUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      const preparingWrites = new Set();

      try {
        do {
        finalState = null;
        collected = [];
        const stream = agent.streamEvents(
          { messages: inputMessages },
          {
            version: 'v2',
            signal: ctx.controller.signal,
            recursionLimit,
            configurable: { thread_id: runId }
          }
        );

        for await (const event of stream) {
          if (event.event === 'on_chat_model_stream') {
            const chunk = event.data?.chunk;
            const messageId = event.run_id || chunk?.id || `message_${ctx.callSequence + 1}`;
            const calls=[...(chunk?.tool_call_chunks || []),...(chunk?.tool_calls || []),...(chunk?.additional_kwargs?.tool_calls || [])];
            for(const call of calls){const name=call.name || call.function?.name;if(name==='write_file'){const key=`${messageId}:${call.index ?? 0}`;if(!preparingWrites.has(key)){preparingWrites.add(key);await ctx.emitEvent({type:'tool.preparing',name:'write_file',messageId,preparationId:key});}}}
            const reasoningState = ctx.reasoningStates.get(messageId) || { value: '' };
            const blockReasoning = planReasoningDelta(
              reasoningState,
              reasoningTextFromContent(chunk?.content)
            );
            if (blockReasoning) {
              await ctx.emitEvent({
                type: 'reasoning.delta',
                content: blockReasoning,
                messageId
              });
            }
            const metadataReasoning = planReasoningDelta(
              reasoningState,
              reasoningTextFromMetadata(chunk?.additional_kwargs),
              true
            );
            if (metadataReasoning) {
              await ctx.emitEvent({
                type: 'reasoning.delta',
                content: metadataReasoning,
                messageId
              });
            }
            ctx.reasoningStates.set(messageId, reasoningState);

            const text = visibleContentText(chunk?.content);
            if (text) {
              await ctx.emitEvent({
                type: 'message.delta',
                content: text,
                messageId
              });
            }
            continue;
          }

          if (event.event === 'on_chat_model_end') {
            const output = event.data?.output;
            if (output) collected.push(output);
            // Per-call usage: the latest call already contains the whole context,
            // so it is reported as-is and never summed with the previous call.
            const callUsage = usageFromChatModelOutput(output);
            if (callUsage) {
              streamedUsage.inputTokens += callUsage.inputTokens;
              streamedUsage.outputTokens += callUsage.outputTokens;
              streamedUsage.totalTokens += callUsage.totalTokens;
              await ctx.emitEvent({
                type: 'usage.updated',
                messageId: event.run_id || output?.id || `message_${ctx.callSequence + 1}`,
                inputTokens: callUsage.inputTokens,
                outputTokens: callUsage.outputTokens,
                totalTokens: callUsage.totalTokens,
                ...(callUsage.cachedTokens != null ? {cachedTokens:callUsage.cachedTokens} : {}),
                cumulative: { ...streamedUsage }
              });
            }
            continue;
          }

          if (event.event === 'on_tool_end') {
            const output = event.data?.output;
            if (output) collected.push(output);
            continue;
          }

          if (event.event === 'on_chain_end' && event.data?.output?.messages) {
            const output = event.data.output;
            if (!finalState || output.messages.length >= finalState.messages.length) finalState = output;
          }

          if (event.event === 'on_chain_end' && event.name === 'LangGraph' && event.data?.output?.messages) {
            finalState = event.data.output;
          }
        }
        inputMessages = finalState?.messages?.length ? finalState.messages : [...inputMessages, ...collected];
        } while (ctx.steering.length && !ctx.controller.signal.aborted);
      } catch (error) {
        if (ctx.controller.signal.aborted || isAbortError(error, ctx.controller.signal)) {
          const partial = [...inputMessages, ...collected];
          return await this.#finish(ctx, 'cancelled', {
            history: historyFromMessages(partial),
            rawHistory: rawHistoryFromMessages(partial),
            usage: usageFromMessages(partial)
          });
        }
        const partial = [...inputMessages, ...collected];
        ctx.history = historyFromMessages(partial);
        ctx.rawHistory = rawHistoryFromMessages(partial);
        throw error;
      }

      if (ctx.controller.signal.aborted) return await this.#finish(ctx, 'cancelled');

      const finalMessages = inputMessages;

      const usage = usageFromMessages(finalMessages);
      if (!usage.totalTokens) {
        usage.inputTokens = streamedUsage.inputTokens;
        usage.outputTokens = streamedUsage.outputTokens;
        usage.totalTokens = streamedUsage.totalTokens || usage.inputTokens + usage.outputTokens;
      }

      return await this.#finish(ctx, 'success', {
        history: historyFromMessages(finalMessages),
        rawHistory: rawHistoryFromMessages(finalMessages),
        usage
      });
    } catch (error) {
      if (ctx.controller.signal.aborted || isAbortError(error, ctx.controller.signal)) {
        return await this.#finish(ctx, 'cancelled');
      }
      let message = errorMessage(error);
      if (error?.lc_error_code === 'GRAPH_RECURSION_LIMIT') {
        message = `智能体工具循环超过最大步骤数（maxSteps=${clampInteger(config.maxSteps, DEFAULT_MAX_STEPS, 1, MAX_STEPS)}）`;
      }
      return await this.#finish(ctx, 'error', { error: message });
    } finally {
      this.#cleanup(ctx);
    }
  }

  cancel(runId) {
    const ctx = this.runs.get(runId);
    if (!ctx || ctx.terminal) return false;
    for (const [approvalId, pending] of ctx.pendingApprovals) {
      ctx.pendingApprovals.delete(approvalId);
      ctx.emitEvent({
        type: 'approval.resolved',
        approvalId,
        approved: false,
        reason: '运行已取消'
      }).catch(() => {});
      pending.reject(abortError());
    }
    ctx.controller.abort();
    return true;
  }

  steer(runId, text) {
    const ctx = this.runs.get(String(runId || ''));
    if (!ctx || ctx.terminal || ctx.controller.signal.aborted || String(ctx.config.provider || '').toLowerCase() === 'demo') return null;
    const content = typeof text === 'string' ? text.trim() : '';
    if (!content || content.length > 16000 || ctx.steering.length >= 20) return null;
    const item = { id: `steer_${randomUUID()}`, content };
    ctx.steering.push(item);
    ctx.emitEvent({ type: 'steer.received', ...item }).catch(() => {});
    return item.id;
  }

  approve({ runId, approvalId, approved } = {}) {
    const ctx = this.runs.get(runId);
    if (!ctx || ctx.terminal) return false;
    return resolvePendingApproval(ctx, approvalId, Boolean(approved));
  }

  setPermission(runId, mode) {
    const ctx = this.runs.get(String(runId ?? ''));
    const nextMode = String(mode ?? '').trim().toLowerCase();
    if (!PERMISSION_MODES.has(nextMode) || !ctx || ctx.terminal) return false;
    // Plan mode is read-only by design; permission changes are refused rather
    // than silently widening what the plan can do.
    if (String(ctx.payload?.mode || '').trim().toLowerCase() === 'plan') return false;

    const previousMode = String(ctx.payload.permissionMode || 'ask').trim().toLowerCase();
    ctx.payload.permissionMode = nextMode;

    ctx.emitEvent({
      type: 'permission.changed',
      permissionMode: nextMode,
      previousMode,
      mode: nextMode
    }).catch(() => {});

    // Already-running tool calls keep running: an abort signal only reaches
    // tools at their next await point, and the runtime never kills a tool that
    // has begun executing. Only calls still waiting for approval are settled.
    if (nextMode === 'read') {
      for (const approvalId of [...ctx.pendingApprovals.keys()]) {
        resolvePendingApproval(ctx, approvalId, false, '权限已切换为只读模式，需要授权的工具已被拒绝');
      }
    } else if (previousMode === 'ask' && nextMode === 'full') {
      for (const [approvalId, pending] of [...ctx.pendingApprovals]) {
        // Trash and MCP tools that opt into approval keep waiting even in full mode.
        if (requiresApprovalInFullMode(pending.name, pending.definition)) continue;
        resolvePendingApproval(ctx, approvalId, true, '权限已切换为完整授权，已自动批准');
      }
    }
    return true;
  }

  async #createRunModel(ctx) {
    if (this.modelFactory) {
      const model = await this.modelFactory(ctx.config, ctx);
      if (!model) throw new Error('模型工厂未返回可用的聊天模型。');
      return model;
    }
    return createModel(ctx.config);
  }

  #buildTools(ctx) {
    return this.toolDefinitions.map((definition) => new DynamicStructuredTool({
      name: definition.name,
      description: definition.description,
      schema: definition.parameters,
      func: async (input, _runManager, runConfig) => invokeTool(ctx, definition, input, runConfig)
    }));
  }

  async #demoResult(ctx) {
    if (ctx.controller.signal.aborted) throw abortError();
    const text = '当前为演示模式，尚未连接模型，不会执行任务。请在设置中填写模型名称、API 地址和密钥，再开始执行任务。';
    await ctx.emitEvent({ type: 'message.delta', content: text, messageId: `demo_${ctx.runId}` });
    if (ctx.controller.signal.aborted) throw abortError();
    const { messages } = normalizeMessages(ctx.payload.messages, ctx.config.systemPrompt);
    const history = [...historyFromMessages(messages), { role: 'assistant', content: text, id: `demo_${ctx.runId}` }];
    return {
      history,
      rawHistory: [...messages.map((message) => message.toDict()), new AIMessage({ content: text, id: `demo_${ctx.runId}` }).toDict()],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    };
  }

  async #finish(ctx, status, extra = {}) {
    if (ctx.terminal) {
      return {
        ok: status === 'success',
        status,
        ...(extra.error ? { error: extra.error } : {}),
        runId: ctx.runId,
        history: extra.history || ctx.history,
        rawHistory: extra.rawHistory || ctx.rawHistory,
        usage: extra.usage || ctx.usage,
        durationMs: Date.now() - ctx.startedAt
      };
    }
    ctx.terminal = true;
    ctx.history = extra.history || ctx.history;
    ctx.rawHistory = extra.rawHistory || ctx.rawHistory;
    ctx.usage = extra.usage || ctx.usage;
    const durationMs = Date.now() - ctx.startedAt;

    if (status === 'error') {
      await ctx.emitEvent({ type: 'run.error', message: extra.error || '智能体运行失败' });
    }
    await ctx.emitEvent({
      type: 'run.completed',
      status,
      durationMs,
      usage: ctx.usage
    });

    return {
      ok: status === 'success',
      status,
      ...(extra.error ? { error: extra.error } : {}),
      runId: ctx.runId,
      history: ctx.history,
      rawHistory: ctx.rawHistory,
      usage: ctx.usage,
      durationMs
    };
  }

  #cleanup(ctx) {
    for (const pending of ctx.pendingApprovals.values()) {
      pending.reject(abortError('Run finished'));
    }
    ctx.pendingApprovals.clear();
    ctx.reasoningStates.clear();
    this.runs.delete(ctx.runId);
    if (ctx.taskId != null && this.activeTasks.get(ctx.taskId) === ctx.runId) {
      this.activeTasks.delete(ctx.taskId);
    }
  }
}

module.exports = { AgentRuntime, createModel };
