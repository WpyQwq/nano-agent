'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { BaseChatModel } = require('@langchain/core/language_models/chat_models');
const { AIMessageChunk } = require('@langchain/core/messages');
const { ChatGenerationChunk } = require('@langchain/core/outputs');

const { AgentRuntime, createModel } = require('../backend/agent');

class ScriptedChatModel extends BaseChatModel {
  constructor({ script = [] } = {}) {
    super({});
    this.script = script;
    this.calls = 0;
    this.boundTools = null;
  }

  _llmType() {
    return 'scripted-test-model';
  }

  bindTools(tools) {
    this.boundTools = tools;
    return this;
  }

  async _generate(messages, options, runManager) {
    const chunks = [];
    for await (const chunk of this._streamResponseChunks(messages, options, runManager)) chunks.push(chunk);
    const message = chunks.length
      ? AIMessageChunk.concat(chunks.map((chunk) => chunk.message))
      : new AIMessageChunk({ content: '' });
    return { generations: [{ text: String(message.content || ''), message }] };
  }

  async *_streamResponseChunks(messages, options, runManager) {
    this.lastMessages = messages;
    const step = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls += 1;
    if (!step) throw new Error('Test model has no scripted response');
    if (step.error) throw step.error;

    for (const piece of step.reasoning || []) {
      const message = step.reasoningChannel === 'metadata'
        ? new AIMessageChunk({ content: '', additional_kwargs: { reasoning_content: piece } })
        : new AIMessageChunk({ content: [{ type: 'reasoning', text: piece }] });
      const chunk = new ChatGenerationChunk({ message, text: '' });
      await runManager?.handleLLMNewToken(
        piece, { prompt: 0, completion: 0 }, undefined, undefined, undefined, { chunk }
      );
      yield chunk;
    }

    for (const piece of step.reasoningMetadata || []) {
      const chunk = new ChatGenerationChunk({
        message: new AIMessageChunk({ content: '', additional_kwargs: { reasoning_content: piece } }),
        text: ''
      });
      await runManager?.handleLLMNewToken(
        piece, { prompt: 0, completion: 0 }, undefined, undefined, undefined, { chunk }
      );
      yield chunk;
    }

    for (const content of step.richChunks || []) {
      const chunk = new ChatGenerationChunk({
        message: new AIMessageChunk({ content }),
        text: ''
      });
      await runManager?.handleLLMNewToken(
        '', { prompt: 0, completion: 0 }, undefined, undefined, undefined, { chunk }
      );
      yield chunk;
    }

    for (const token of step.tokens || []) {
      await runManager?.handleLLMNewToken(token, {}, undefined, 'text');
      yield new ChatGenerationChunk({
        message: new AIMessageChunk({ content: token }),
        text: token
      });
    }

    if (step.toolCalls?.length) {
      yield new ChatGenerationChunk({
        message: new AIMessageChunk({
          content: '',
          tool_calls: step.toolCalls.map((call) => ({ ...call, type: 'tool_call' }))
        }),
        text: ''
      });
    }

    if (step.usage) {
      yield new ChatGenerationChunk({
        message: new AIMessageChunk({
          content: '',
          usage_metadata: {
            input_tokens: step.usage.inputTokens,
            output_tokens: step.usage.outputTokens,
            total_tokens: step.usage.totalTokens
              ?? step.usage.inputTokens + step.usage.outputTokens
          }
        }),
        text: ''
      });
    }
  }
}

function createSink() {
  const events = [];
  const waiters = [];
  const emit = (event) => {
    events.push(event);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter.predicate(event)) continue;
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  };
  const waitFor = (predicate, timeoutMs = 3000) => {
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error('Timed out waiting for agent event'));
      }, timeoutMs);
      waiters.push({ predicate, resolve, timer });
    });
  };
  return { events, emit, waitFor };
}

const readFileTool = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a text file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  }
};

const writeFileTool = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Write a text file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content']
    }
  }
};

const trashFileTool = {
  type: 'function',
  function: {
    name: 'trash_file',
    description: 'Move a file to the recycle bin.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  }
};

const deleteFileTool = {
  type: 'function',
  function: {
    name: 'delete_file',
    description: 'Permanently delete a file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  }
};

function basePayload(overrides = {}) {
  return {
    runId: 'run-1',
    taskId: 'task-1',
    config: { provider: 'openai', model: 'test-model', maxSteps: 5, systemPrompt: 'Be careful.' },
    messages: [{ role: 'user', content: 'Start the task.' }],
    projectPath: 'C:/project',
    permissionMode: 'read',
    ...overrides
  };
}

function countTerminal(events) {
  return events.filter((event) => event.type === 'run.completed').length;
}

test('streams model tokens through a tool call and returns canonical history', { timeout: 8000 }, async () => {
  const sink = createSink();
  const toolCalls = [];
  const runtime = new AgentRuntime({
    toolDefinitions: [readFileTool, writeFileTool],
    executeTool: async (name, input, payload, options) => {
      toolCalls.push({ name, input, payload, options });
      return { path: input.path, content: 'hello world' };
    },
    modelFactory: () => new ScriptedChatModel({
      script: [
        {
          tokens: ['Reading ', 'now.'],
          toolCalls: [{ name: 'read_file', args: { path: 'notes.txt' }, id: 'call_read_1' }]
        },
        { tokens: ['Found ', 'it.'] }
      ]
    })
  });

  const result = await runtime.run(basePayload(), sink.emit);

  assert.equal(result.ok, true);
  assert.equal(result.status, 'success');
  assert.equal(result.runId, 'run-1');
  assert.equal(result.durationMs >= 0, true);
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });

  const deltas = sink.events.filter((event) => event.type === 'message.delta').map((event) => event.content).join('');
  assert.equal(deltas, 'Reading now.Found it.');

  const toolStarted = sink.events.find((event) => event.type === 'tool.started');
  assert.equal(toolStarted.name, 'read_file');
  assert.deepEqual(toolStarted.input, { path: 'notes.txt' });

  const toolCompleted = sink.events.find((event) => event.type === 'tool.completed');
  assert.deepEqual(toolCompleted.output, { path: 'notes.txt', content: 'hello world' });

  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, 'read_file');
  assert.equal(toolCalls[0].payload.projectPath, 'C:/project');
  assert.equal(toolCalls[0].options.signal instanceof AbortSignal, true);

  assert.equal(countTerminal(sink.events), 1);
  assert.equal(sink.events.at(-1).type, 'run.completed');
  assert.equal(sink.events.at(-1).status, 'success');
  for (const event of sink.events) {
    assert.equal(event.runId, 'run-1');
    assert.equal(event.taskId, 'task-1');
  }

  const assistantWithCall = result.history.find((message) => (
    message.role === 'assistant'
    && Array.isArray(message.tool_calls)
    && message.tool_calls.some((call) => call.name === 'read_file')
  ));
  assert.ok(assistantWithCall);

  const toolMessage = result.history.find((message) => message.role === 'tool');
  assert.equal(toolMessage.tool_call_id, 'call_read_1');
  assert.deepEqual(JSON.parse(toolMessage.content), { path: 'notes.txt', content: 'hello world' });
  assert.equal(result.history.at(-1).role, 'assistant');
  assert.equal(result.history.at(-1).content, 'Found it.');
  assert.ok(Array.isArray(result.rawHistory));
  assert.equal(result.rawHistory.length, result.history.length);

  // The plain history must be accepted as the next turn's input, preserving tool call IDs.
  const followUpSink = createSink();
  const followUp = new AgentRuntime({
    toolDefinitions: [readFileTool],
    executeTool: async () => ({ ok: true }),
    modelFactory: () => new ScriptedChatModel({ script: [{ tokens: ['Second ', 'answer.'] }] })
  });
  const followUpResult = await followUp.run(basePayload({
    runId: 'run-2',
    taskId: 'task-2',
    messages: result.history
  }), followUpSink.emit);
  assert.equal(followUpResult.status, 'success');
  assert.equal(followUpResult.history.at(-1).content, 'Second answer.');
});

test('ask mode waits for approval before executing a write and resumes after approval', { timeout: 8000 }, async () => {
  const sink = createSink();
  const executions = [];
  const runtime = new AgentRuntime({
    toolDefinitions: [writeFileTool],
    executeTool: async (name, input) => {
      executions.push({ name, input });
      return { ok: true, path: input.path };
    },
    modelFactory: () => new ScriptedChatModel({
      script: [
        {
          tokens: ['Writing ', 'the file.'],
          toolCalls: [{
            name: 'write_file',
            args: { path: 'created.txt', content: 'data' },
            id: 'call_write_1'
          }]
        },
        { tokens: ['Finished.'] }
      ]
    })
  });

  const runPromise = runtime.run(basePayload({
    runId: 'approve-run',
    taskId: 'approve-task',
    permissionMode: 'ask'
  }), sink.emit);

  const request = await sink.waitFor((event) => event.type === 'approval.required');
  assert.equal(request.name, 'write_file');
  assert.equal(request.runId, 'approve-run');
  assert.equal(request.taskId, 'approve-task');
  assert.deepEqual(request.input, { path: 'created.txt', content: 'data' });
  assert.ok(request.approvalId);
  assert.equal(executions.length, 0);

  assert.equal(runtime.approve({ runId: 'other-run', approvalId: request.approvalId, approved: true }), false);
  assert.equal(runtime.approve({ runId: 'approve-run', approvalId: 'wrong-approval', approved: true }), false);
  assert.equal(runtime.approve({ runId: 'approve-run', approvalId: request.approvalId, approved: true }), true);

  const result = await runPromise;
  assert.equal(result.status, 'success');
  assert.equal(result.ok, true);
  assert.equal(executions.length, 1);
  assert.deepEqual(executions[0], {
    name: 'write_file',
    input: { path: 'created.txt', content: 'data' }
  });

  const resolved = sink.events.filter((event) => event.type === 'approval.resolved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].approvalId, request.approvalId);
  assert.equal(resolved[0].approved, true);
  assert.equal(countTerminal(sink.events), 1);
  assert.equal(sink.events.at(-1).status, 'success');
});

test('rejected approval is returned as a tool result and the model recovers', { timeout: 8000 }, async () => {
  const sink = createSink();
  const executions = [];
  const runtime = new AgentRuntime({
    toolDefinitions: [writeFileTool],
    executeTool: async (name, input) => {
      executions.push({ name, input });
      return { ok: true };
    },
    modelFactory: () => new ScriptedChatModel({
      script: [
        { tokens: ['Trying.'], toolCalls: [{ name: 'write_file', args: { path: 'no.txt', content: 'x' }, id: 'call_write_2' }] },
        { tokens: ['Recovered ', 'without writing.'] }
      ]
    })
  });

  const runPromise = runtime.run(basePayload({
    runId: 'reject-run',
    taskId: 'reject-task',
    permissionMode: 'ask'
  }), sink.emit);
  const request = await sink.waitFor((event) => event.type === 'approval.required');
  assert.equal(runtime.approve({ runId: 'reject-run', approvalId: request.approvalId, approved: false }), true);

  const result = await runPromise;
  assert.equal(result.status, 'success');
  assert.equal(executions.length, 0);
  assert.equal(result.history.at(-1).content, 'Recovered without writing.');

  const toolMessage = result.history.find((message) => message.role === 'tool');
  const payload = JSON.parse(toolMessage.content);
  assert.equal(payload.rejected, true);
  assert.match(payload.error, /拒绝|rejected/i);

  const completed = sink.events.find((event) => event.type === 'tool.completed');
  assert.equal(completed.output.rejected, true);
  assert.equal(sink.events.some((event) => event.type === 'tool.error'), false);
  assert.equal(countTerminal(sink.events), 1);
});

test('cancel rejects a pending approval and ends with one cancelled terminal event', { timeout: 8000 }, async () => {
  const sink = createSink();
  let executions = 0;
  const runtime = new AgentRuntime({
    toolDefinitions: [writeFileTool],
    executeTool: async () => {
      executions += 1;
      return { ok: true };
    },
    modelFactory: () => new ScriptedChatModel({
      script: [
        { tokens: ['Waiting.'], toolCalls: [{ name: 'write_file', args: { path: 'never.txt', content: 'x' }, id: 'call_write_3' }] },
        { tokens: ['Should never appear.'] }
      ]
    })
  });

  const runPromise = runtime.run(basePayload({
    runId: 'cancel-run',
    taskId: 'cancel-task',
    permissionMode: 'ask'
  }), sink.emit);
  const request = await sink.waitFor((event) => event.type === 'approval.required');

  assert.equal(runtime.cancel('cancel-run'), true);
  const result = await runPromise;

  assert.equal(result.status, 'cancelled');
  assert.equal(result.ok, false);
  assert.equal(executions, 0);
  assert.equal(runtime.cancel('cancel-run'), false);
  assert.equal(runtime.approve({ runId: 'cancel-run', approvalId: request.approvalId, approved: true }), false);

  const resolved = sink.events.filter((event) => event.type === 'approval.resolved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].approved, false);
  assert.match(resolved[0].reason, /取消|cancel/i);
  assert.equal(sink.events.some((event) => event.type === 'run.error'), false);
  assert.equal(countTerminal(sink.events), 1);
  assert.equal(sink.events.at(-1).type, 'run.completed');
  assert.equal(sink.events.at(-1).status, 'cancelled');
});

test('cancel during tool execution passes the abort signal and ends cancelled', { timeout: 8000 }, async () => {
  const sink = createSink();
  let sawAbort = false;
  let markExecutionStarted;
  const executionStarted = new Promise((resolve) => { markExecutionStarted = resolve; });
  const runtime = new AgentRuntime({
    toolDefinitions: [{
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Run a command.',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
      }
    }],
    executeTool: async (name, input, payload, { signal }) => new Promise((resolve, reject) => {
      markExecutionStarted();
      signal.addEventListener('abort', () => {
        sawAbort = true;
        reject(new Error('tool stopped'));
      }, { once: true });
    }),
    modelFactory: () => new ScriptedChatModel({
      script: [
        { tokens: ['Running.'], toolCalls: [{ name: 'run_command', args: { command: 'long-task' }, id: 'call_long' }] },
        { tokens: ['Should never appear.'] }
      ]
    })
  });

  const runPromise = runtime.run(basePayload({
    runId: 'cancel-tool-run',
    taskId: 'cancel-tool-task',
    permissionMode: 'full'
  }), sink.emit);
  await sink.waitFor((event) => event.type === 'tool.started');
  await executionStarted;

  assert.equal(runtime.cancel('cancel-tool-run'), true);
  const result = await runPromise;

  assert.equal(result.status, 'cancelled');
  assert.equal(sawAbort, true);
  assert.equal(sink.events.some((event) => event.type === 'tool.completed'), false);
  assert.equal(sink.events.some((event) => event.type === 'run.error'), false);
  assert.equal(countTerminal(sink.events), 1);
  assert.equal(sink.events.at(-1).status, 'cancelled');
});

test('tool execution errors are fed back to the model instead of failing the run', { timeout: 8000 }, async () => {
  const sink = createSink();
  const runtime = new AgentRuntime({
    toolDefinitions: [readFileTool],
    executeTool: async () => {
      throw new Error('disk exploded');
    },
    modelFactory: () => new ScriptedChatModel({
      script: [
        { tokens: ['Reading.'], toolCalls: [{ name: 'read_file', args: { path: 'broken.txt' }, id: 'call_read_err' }] },
        { tokens: ['Recovered ', 'from tool failure.'] }
      ]
    })
  });

  const result = await runtime.run(basePayload({ runId: 'tool-error-run', taskId: 'tool-error-task' }), sink.emit);

  assert.equal(result.status, 'success');
  assert.equal(result.history.at(-1).content, 'Recovered from tool failure.');
  const toolError = sink.events.find((event) => event.type === 'tool.error');
  assert.equal(toolError.name, 'read_file');
  assert.equal(toolError.error, 'disk exploded');
  assert.equal(sink.events.some((event) => event.type === 'tool.completed'), false);

  const toolMessage = result.history.find((message) => message.role === 'tool');
  assert.match(toolMessage.content, /disk exploded/);
  assert.equal(countTerminal(sink.events), 1);
  assert.equal(sink.events.at(-1).status, 'success');
});

test('read mode rejects protected tools without approval', { timeout: 8000 }, async () => {
  const sink = createSink();
  let executions = 0;
  const runtime = new AgentRuntime({
    toolDefinitions: [writeFileTool],
    executeTool: async () => {
      executions += 1;
      return { ok: true };
    },
    modelFactory: () => new ScriptedChatModel({
      script: [
        { tokens: ['Attempting.'], toolCalls: [{ name: 'write_file', args: { path: 'blocked.txt', content: 'x' }, id: 'call_readonly' }] },
        { tokens: ['Blocked.'] }
      ]
    })
  });

  const result = await runtime.run(basePayload({
    runId: 'readonly-run',
    taskId: 'readonly-task',
    permissionMode: 'read'
  }), sink.emit);

  assert.equal(result.status, 'success');
  assert.equal(executions, 0);
  assert.equal(sink.events.some((event) => event.type === 'approval.required'), false);
  const toolError = sink.events.find((event) => event.type === 'tool.error');
  assert.match(toolError.error, /只读|read[- ]only/i);
  const toolMessage = result.history.find((message) => message.role === 'tool');
  assert.equal(JSON.parse(toolMessage.content).rejected, true);
});

test('full mode auto-runs mutations but always asks for trash and never permanently deletes', { timeout: 8000 }, async () => {
  const trashSink = createSink();
  const trashExecutions = [];
  const trashRuntime = new AgentRuntime({
    toolDefinitions: [trashFileTool],
    executeTool: async (name, input) => {
      trashExecutions.push({ name, input });
      return { ok: true, path: input.path, trashed: true };
    },
    modelFactory: () => new ScriptedChatModel({
      script: [
        { tokens: ['Trashing.'], toolCalls: [{ name: 'trash_file', args: { path: 'old.txt' }, id: 'call_trash' }] },
        { tokens: ['Trashed.'] }
      ]
    })
  });

  const trashPromise = trashRuntime.run(basePayload({
    runId: 'trash-run',
    taskId: 'trash-task',
    permissionMode: 'full'
  }), trashSink.emit);
  const trashRequest = await trashSink.waitFor((event) => event.type === 'approval.required');
  assert.equal(trashRequest.name, 'trash_file');
  assert.equal(trashExecutions.length, 0);
  assert.equal(trashRuntime.approve({
    runId: 'trash-run',
    approvalId: trashRequest.approvalId,
    approved: true
  }), true);
  const trashResult = await trashPromise;
  assert.equal(trashResult.status, 'success');
  assert.deepEqual(trashExecutions, [{ name: 'trash_file', input: { path: 'old.txt' } }]);

  const deleteSink = createSink();
  let deleteExecutions = 0;
  const deleteRuntime = new AgentRuntime({
    toolDefinitions: [deleteFileTool],
    executeTool: async () => {
      deleteExecutions += 1;
      return { ok: true };
    },
    modelFactory: () => new ScriptedChatModel({
      script: [
        { tokens: ['Deleting.'], toolCalls: [{ name: 'delete_file', args: { path: 'gone.txt' }, id: 'call_delete' }] },
        { tokens: ['Refused.'] }
      ]
    })
  });

  const deleteResult = await deleteRuntime.run(basePayload({
    runId: 'delete-run',
    taskId: 'delete-task',
    permissionMode: 'full'
  }), deleteSink.emit);

  assert.equal(deleteResult.status, 'success');
  assert.equal(deleteExecutions, 0);
  assert.equal(deleteSink.events.some((event) => event.type === 'approval.required'), false);
  const deleteError = deleteSink.events.find((event) => event.type === 'tool.error');
  assert.match(deleteError.error, /永久删除|permanent/i);
});

test('rejects duplicate run IDs and concurrent runs for the same task', { timeout: 8000 }, async () => {
  const sink = createSink();
  const runtime = new AgentRuntime({
    toolDefinitions: [writeFileTool],
    executeTool: async () => ({ ok: true }),
    modelFactory: () => new ScriptedChatModel({
      script: [
        { tokens: ['Waiting.'], toolCalls: [{ name: 'write_file', args: { path: 'x.txt', content: 'x' }, id: 'call_guard' }] },
        { tokens: ['Done.'] }
      ]
    })
  });

  const runPromise = runtime.run(basePayload({
    runId: 'guard-run',
    taskId: 'guard-task',
    permissionMode: 'ask'
  }), sink.emit);
  await sink.waitFor((event) => event.type === 'approval.required');

  const duplicateId = await runtime.run(basePayload({
    runId: 'guard-run',
    taskId: 'different-task',
    permissionMode: 'read'
  }), sink.emit);
  assert.equal(duplicateId.ok, false);
  assert.equal(duplicateId.status, 'error');
  assert.match(duplicateId.error, /重复|duplicate/i);

  const concurrentTask = await runtime.run(basePayload({
    runId: 'guard-run-2',
    taskId: 'guard-task',
    permissionMode: 'read'
  }), sink.emit);
  assert.equal(concurrentTask.ok, false);
  assert.match(concurrentTask.error, /已有运行|concurrent|running/i);
  assert.equal(sink.events.some((event) => event.runId === 'guard-run-2'), false);

  runtime.cancel('guard-run');
  await runPromise;

  const reusedId = await runtime.run(basePayload({
    runId: 'guard-run',
    taskId: 'new-task',
    permissionMode: 'read'
  }), sink.emit);
  assert.equal(reusedId.ok, false);
  assert.match(reusedId.error, /重复|duplicate/i);
});

test('demo mode emits an explicit message and never executes tools or tasks', { timeout: 5000 }, async () => {
  const sink = createSink();
  let executions = 0;
  const runtime = new AgentRuntime({
    toolDefinitions: [readFileTool],
    executeTool: async () => {
      executions += 1;
      return { ok: true };
    }
  });

  const result = await runtime.run(basePayload({
    runId: 'demo-run',
    taskId: 'demo-task',
    config: { provider: 'demo', model: '', maxSteps: 5 },
    permissionMode: 'full'
  }), sink.emit);

  assert.equal(result.status, 'success');
  assert.equal(result.ok, true);
  assert.equal(executions, 0);
  assert.match(result.history.at(-1).content, /演示模式|no model configured/i);
  assert.equal(sink.events.some((event) => event.type === 'tool.started'), false);
  assert.equal(sink.events.some((event) => event.type === 'tool.completed'), false);
  const delta = sink.events.find((event) => event.type === 'message.delta');
  assert.match(delta.content, /不会执行任务|不会执行任何真实模型/i);
  assert.equal(countTerminal(sink.events), 1);
  assert.equal(sink.events.at(-1).status, 'success');
});

test('stops a non-terminating tool loop at maxSteps', { timeout: 8000 }, async () => {
  const sink = createSink();
  const runtime = new AgentRuntime({
    toolDefinitions: [readFileTool],
    executeTool: async () => ({ ok: true }),
    modelFactory: () => new ScriptedChatModel({
      script: [
        { tokens: ['Again.'], toolCalls: [{ name: 'read_file', args: { path: 'loop.txt' }, id: 'call_loop' }] }
      ]
    })
  });

  const result = await runtime.run(basePayload({
    runId: 'steps-run',
    taskId: 'steps-task',
    config: { provider: 'openai', model: 'test-model', maxSteps: 2 }
  }), sink.emit);

  assert.equal(result.ok, false);
  assert.equal(result.status, 'error');
  assert.match(result.error, /最大步骤数|maxSteps/i);
  assert.equal(sink.events.filter((event) => event.type === 'run.error').length, 1);
  assert.equal(countTerminal(sink.events), 1);
  assert.equal(sink.events.at(-1).status, 'error');
});

test('createModel normalizes OpenAI and Anthropic base URLs without network calls', () => {
  const openai = createModel({
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'test-key',
    baseUrl: 'https://gateway.example.com'
  });
  assert.equal(openai.clientConfig.baseURL, 'https://gateway.example.com/v1');

  const openaiWithV1 = createModel({
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'test-key',
    baseUrl: 'https://gateway.example.com/v1/'
  });
  assert.equal(openaiWithV1.clientConfig.baseURL, 'https://gateway.example.com/v1');

  const anthropic = createModel({
    provider: 'anthropic',
    model: 'claude-test',
    apiKey: 'test-key',
    baseUrl: 'https://gateway.example.com/v1/'
  });
  assert.equal(anthropic.apiUrl, 'https://gateway.example.com');

  const anthropicDefault = createModel({
    provider: 'anthropic',
    model: 'claude-test',
    apiKey: 'test-key'
  });
  assert.equal(anthropicDefault.apiUrl, 'https://api.anthropic.com');

  assert.throws(() => createModel({ provider: 'demo', model: '' }), /演示模式|no model/i);
  assert.throws(() => createModel({ provider: 'unknown', model: 'x' }), /不支持|unsupported/i);
});

test('custom system prompt reaches the model and failed calls retain earlier history', async () => {
  const model = new ScriptedChatModel({ script: [{ error: new Error('provider unavailable') }] });
  const runtime = new AgentRuntime({ toolDefinitions: [], executeTool: async()=>{}, modelFactory:()=>model });
  const messages = [{role:'user',content:'Earlier question'},{role:'assistant',content:'Earlier answer'},{role:'user',content:'Follow up'}];
  const result = await runtime.run(basePayload({messages,config:{provider:'openai',model:'mock',systemPrompt:'始终中文回复'}}));
  assert.equal(result.status,'error');
  assert.ok(model.lastMessages.some(message => JSON.stringify(message.content).includes('始终中文回复')));
  assert.equal(result.history.filter(message=>message.role==='user').length,2);
  assert.ok(result.history.some(message=>message.content==='Earlier answer'));
});

test('cancelled approval returns balanced history that a provider can accept on the next turn', async () => {
  const sink = createSink();
  const runtime = new AgentRuntime({ toolDefinitions:[writeFileTool],executeTool:async()=>{throw new Error('must not execute');},modelFactory:()=>new ScriptedChatModel({script:[{toolCalls:[{name:'write_file',args:{path:'x',content:'y'},id:'pending-write'}]}]}) });
  const pending=runtime.run(basePayload({runId:'balance-cancel',permissionMode:'ask'}),sink.emit);
  await sink.waitFor(event=>event.type==='approval.required');runtime.cancel('balance-cancel');const result=await pending;
  const callIndex=result.history.findIndex(message=>message.tool_calls?.length);
  assert.ok(callIndex>=0);assert.equal(result.history[callIndex+1].role,'tool');assert.equal(result.history[callIndex+1].tool_call_id,'pending-write');
  assert.equal(JSON.parse(result.history[callIndex+1].content).cancelled,true);
});

test('screen observation reaches the model as image content rather than JSON encoded base64', async () => {
  const image={type:'image_url',image_url:{url:'data:image/png;base64,AAAA'}};
  const model=new ScriptedChatModel({script:[{toolCalls:[{name:'computer_screenshot',args:{},id:'screen-1'}]},{tokens:['观察完成']}]});
  const runtime=new AgentRuntime({toolDefinitions:[{type:'function',function:{name:'computer_screenshot',description:'Observe',parameters:{type:'object',properties:{}}}}],executeTool:async()=>({content:[{type:'text',text:'screen'},image]}),modelFactory:()=>model});
  const result=await runtime.run(basePayload());assert.equal(result.status,'success');
  const toolMessage=model.lastMessages.find(message=>message._getType()==='tool');
  assert.ok(Array.isArray(toolMessage.content));assert.equal(toolMessage.content[1].type,'image_url');
});

test('steering during a tool call is applied before the next model invocation', async () => {
  const sink = createSink(); let releaseTool; let firstToolStarted;
  const toolStarted = new Promise(resolve => { firstToolStarted = resolve; });
  const toolWait = new Promise(resolve => { releaseTool = resolve; });
  const model = new ScriptedChatModel({ script: [
    { toolCalls: [{ name: 'read_file', args: { path: 'a.txt' }, id: 'steer-read', type: 'tool_call' }] },
    { tokens: ['已按新要求处理'] }
  ] });
  const runtime = new AgentRuntime({ toolDefinitions: [readFileTool], modelFactory: () => model,
    executeTool: async () => { firstToolStarted(); await toolWait; return { content: 'file' }; } });
  const running = runtime.run(basePayload({runId:'steer-tool'}), sink.emit);
  await toolStarted;
  const id = runtime.steer('steer-tool', '请特别检查安全问题');
  assert.ok(id); releaseTool();
  const result = await running;
  assert.equal(result.status, 'success');
  assert.ok(model.lastMessages.some(message => message._getType() === 'human' && message.content === '请特别检查安全问题'));
  assert.ok(result.history.some(message => message.role === 'user' && message.content === '请特别检查安全问题'));
  assert.ok(sink.events.some(event => event.type === 'steer.applied' && event.id === id));
});

test('steering during streaming after a final answer starts another model invocation', async () => {
  const sink = createSink();
  const model = new ScriptedChatModel({ script: [{ tokens: ['原回答'] }, { tokens: ['补充回答'] }] });
  const runtime = new AgentRuntime({ modelFactory: () => model });
  let id;
  const result = await runtime.run(basePayload({runId:'steer-final'}), event => {
    sink.emit(event);
    if (event.type === 'message.delta' && event.content === '原回答' && !id) id = runtime.steer('steer-final', '追加要求');
  });
  assert.equal(result.status, 'success'); assert.ok(id); assert.equal(model.calls, 2);
  assert.ok(model.lastMessages.some(message => message._getType() === 'human' && message.content === '追加要求'));
  assert.deepEqual(result.history.filter(message => message.role === 'assistant').map(message => message.content), ['原回答', '补充回答']);
  assert.ok(sink.events.some(event => event.type === 'steer.received' && event.id === id));
  assert.ok(sink.events.some(event => event.type === 'steer.applied' && event.id === id));
});

test('steering validates text, bounded queue, and finished or cancelled runs', async () => {
  const sink = createSink(); let release; let started;
  const waiting = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const runtime = new AgentRuntime({ toolDefinitions: [readFileTool], modelFactory: () => new ScriptedChatModel({ script: [{ toolCalls: [{ name:'read_file',args:{path:'x'},id:'s',type:'tool_call' }] }, {tokens:['done']}] }),
    executeTool: async () => { started(); await waiting; return 'ok'; } });
  const running = runtime.run(basePayload({runId:'steer-bounds'}), sink.emit); await ready;
  assert.equal(runtime.steer('steer-bounds', ''), null);assert.equal(runtime.steer('steer-bounds', 'x'.repeat(16001)), null);
  for (let i=0;i<20;i++) assert.ok(runtime.steer('steer-bounds', `要求 ${i}`));
  assert.equal(runtime.steer('steer-bounds', '超出'), null);
  release();const result=await running;assert.equal(result.status,'success');
  assert.equal(result.history.filter(message=>message.role==='user').length,21);
  assert.equal(runtime.steer('steer-bounds','已结束'),null);
});

const mcpTool = {
  type: 'function',
  function: {
    name: 'mcp_browser',
    description: 'Run an MCP browser action.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
  },
  requiresApproval: true
};

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('setPermission validates modes and auto-approves a pending write when switching ask to full', { timeout: 8000 }, async () => {
  const sink = createSink();
  const executions = [];
  const runtime = new AgentRuntime({
    toolDefinitions: [writeFileTool],
    executeTool: async (name, input) => {
      executions.push({ name, input });
      return { ok: true };
    },
    modelFactory: () => new ScriptedChatModel({
      script: [
        { toolCalls: [{ name: 'write_file', args: { path: 'live.txt', content: 'x' }, id: 'call_perm' }] },
        { tokens: ['Saved.'] }
      ]
    })
  });

  const runPromise = runtime.run(basePayload({
    runId: 'perm-run',
    taskId: 'perm-task',
    permissionMode: 'ask'
  }), sink.emit);
  const request = await sink.waitFor((event) => event.type === 'approval.required');
  assert.equal(executions.length, 0);

  assert.equal(runtime.setPermission('perm-run', 'yolo'), false);
  assert.equal(runtime.setPermission('perm-run', ''), false);
  assert.equal(runtime.setPermission('perm-run', null), false);
  assert.equal(runtime.setPermission('missing-run', 'full'), false);
  assert.equal(sink.events.some((event) => event.type === 'permission.changed'), false);

  assert.equal(runtime.setPermission('perm-run', 'full'), true);

  const changed = sink.events.find((event) => event.type === 'permission.changed');
  assert.ok(changed);
  assert.equal(changed.runId, 'perm-run');
  assert.equal(changed.taskId, 'perm-task');
  assert.equal(changed.permissionMode, 'full');
  assert.equal(changed.previousMode, 'ask');

  const resolved = sink.events.find((event) => event.type === 'approval.resolved');
  assert.ok(resolved);
  assert.equal(resolved.approvalId, request.approvalId);
  assert.equal(resolved.name, 'write_file');
  assert.equal(resolved.approved, true);

  const result = await runPromise;
  assert.equal(result.status, 'success');
  assert.equal(executions.length, 1);
  assert.deepEqual(executions[0], { name: 'write_file', input: { path: 'live.txt', content: 'x' } });
  assert.equal(runtime.setPermission('perm-run', 'read'), false);
});

test('switching to read rejects a pending protected approval without executing the tool', { timeout: 8000 }, async () => {
  const sink = createSink();
  const executions = [];
  const runtime = new AgentRuntime({
    toolDefinitions: [writeFileTool],
    executeTool: async (name, input) => {
      executions.push({ name, input });
      return { ok: true };
    },
    modelFactory: () => new ScriptedChatModel({
      script: [
        { toolCalls: [{ name: 'write_file', args: { path: 'readonly.txt', content: 'x' }, id: 'call_to_read' }] },
        { tokens: ['Understood.'] }
      ]
    })
  });

  const runPromise = runtime.run(basePayload({
    runId: 'to-read-run',
    taskId: 'to-read-task',
    permissionMode: 'ask'
  }), sink.emit);
  const request = await sink.waitFor((event) => event.type === 'approval.required');
  assert.equal(runtime.setPermission('to-read-run', 'read'), true);

  const resolved = sink.events.find((event) => event.type === 'approval.resolved');
  assert.equal(resolved.approvalId, request.approvalId);
  assert.equal(resolved.approved, false);
  assert.match(resolved.reason, /只读|read[- ]only/i);

  const result = await runPromise;
  assert.equal(result.status, 'success');
  assert.equal(executions.length, 0);
  const toolMessage = result.history.find((message) => message.role === 'tool');
  assert.equal(JSON.parse(toolMessage.content).rejected, true);
  assert.match(JSON.parse(toolMessage.content).error, /只读|read[- ]only/i);
});

test('full mode never auto-approves trash or MCP tools that require approval', { timeout: 8000 }, async () => {
  for (const [runId, definition, name, args] of [
    ['trash-perm-run', trashFileTool, 'trash_file', { path: 'old.txt' }],
    ['mcp-perm-run', mcpTool, 'mcp_browser', { url: 'https://example.com' }]
  ]) {
    const sink = createSink();
    const executions = [];
    const runtime = new AgentRuntime({
      toolDefinitions: [definition],
      executeTool: async (toolName, input) => {
        executions.push({ name: toolName, input });
        return { ok: true };
      },
      modelFactory: () => new ScriptedChatModel({
        script: [
          { toolCalls: [{ name, args, id: `${runId}-call` }] },
          { tokens: ['Done.'] }
        ]
      })
    });

    const runPromise = runtime.run(basePayload({
      runId,
      taskId: `${runId}-task`,
      permissionMode: 'ask'
    }), sink.emit);
    const request = await sink.waitFor((event) => event.type === 'approval.required');
    assert.equal(runtime.setPermission(runId, 'full'), true);
    await wait(50);
    assert.equal(sink.events.some((event) => event.type === 'permission.changed'), true);
    assert.equal(sink.events.some((event) => event.type === 'approval.resolved'), false);
    assert.equal(executions.length, 0);

    assert.equal(runtime.approve({ runId, approvalId: request.approvalId, approved: true }), true);
    const result = await runPromise;
    assert.equal(result.status, 'success');
    assert.deepEqual(executions, [{ name, input: args }]);
  }
});

test('plan mode refuses live permission changes and keeps the pending approval', { timeout: 8000 }, async () => {
  const sink = createSink();
  let executions = 0;
  const runtime = new AgentRuntime({
    toolDefinitions: [writeFileTool],
    executeTool: async () => {
      executions += 1;
      return { ok: true };
    },
    modelFactory: () => new ScriptedChatModel({
      script: [
        { toolCalls: [{ name: 'write_file', args: { path: 'plan.txt', content: 'x' }, id: 'call_plan' }] },
        { tokens: ['Planned only.'] }
      ]
    })
  });

  const runPromise = runtime.run(basePayload({
    runId: 'plan-perm-run',
    taskId: 'plan-perm-task',
    mode: 'plan',
    permissionMode: 'ask'
  }), sink.emit);
  const request = await sink.waitFor((event) => event.type === 'approval.required');

  assert.equal(runtime.setPermission('plan-perm-run', 'full'), false);
  assert.equal(runtime.setPermission('plan-perm-run', 'read'), false);
  assert.equal(sink.events.some((event) => event.type === 'permission.changed'), false);
  assert.equal(sink.events.some((event) => event.type === 'approval.resolved'), false);

  assert.equal(runtime.approve({
    runId: 'plan-perm-run',
    approvalId: request.approvalId,
    approved: false
  }), true);
  const result = await runPromise;
  assert.equal(result.status, 'success');
  assert.equal(executions, 0);
});

test('streams reasoning blocks as reasoning.delta without leaking or duplicating them', { timeout: 8000 }, async () => {
  const sink = createSink();
  const runtime = new AgentRuntime({
    toolDefinitions: [readFileTool],
    executeTool: async () => ({ ok: true, content: 'data' }),
    modelFactory: () => new ScriptedChatModel({
      script: [
        {
          reasoning: ['Need to ', 'check the file.'],
          reasoningMetadata: ['Need to check the file.'],
          richChunks: [[
            { type: 'reasoning', text: 'hidden detail' },
            { type: 'text', text: 'Visible ' }
          ]],
          tokens: ['answer.'],
          toolCalls: [{ name: 'read_file', args: { path: 'a.txt' }, id: 'call_reason' }]
        },
        {
          reasoningMetadata: ['Think', 'Think more'],
          tokens: ['Final ', 'answer.']
        }
      ]
    })
  });

  const result = await runtime.run(basePayload({
    runId: 'reason-run',
    taskId: 'reason-task',
    permissionMode: 'read'
  }), sink.emit);

  assert.equal(result.status, 'success');
  const reasoning = sink.events
    .filter((event) => event.type === 'reasoning.delta')
    .map((event) => event.content)
    .join('');
  assert.equal(reasoning, 'Need to check the file.hidden detailThink more');

  const messages = sink.events
    .filter((event) => event.type === 'message.delta')
    .map((event) => event.content)
    .join('');
  assert.equal(messages, 'Visible answer.Final answer.');
  assert.equal(messages.includes('Need to'), false);
  assert.equal(messages.includes('hidden detail'), false);
  assert.equal(messages.includes('Think'), false);

  const reasoningIds = new Set(sink.events
    .filter((event) => event.type === 'reasoning.delta')
    .map((event) => event.messageId));
  assert.equal(reasoningIds.size, 2);
});

test('emits per-call usage.updated with latest call values and a separate cumulative total', { timeout: 8000 }, async () => {
  const sink = createSink();
  const runtime = new AgentRuntime({
    toolDefinitions: [readFileTool],
    executeTool: async () => ({ ok: true, content: 'data' }),
    modelFactory: () => new ScriptedChatModel({
      script: [
        {
          toolCalls: [{ name: 'read_file', args: { path: 'a.txt' }, id: 'call_usage_1' }],
          usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }
        },
        {
          tokens: ['Done.'],
          usage: { inputTokens: 250, outputTokens: 20, totalTokens: 270 }
        }
      ]
    })
  });

  const result = await runtime.run(basePayload({
    runId: 'usage-run',
    taskId: 'usage-task',
    permissionMode: 'read'
  }), sink.emit);

  assert.equal(result.status, 'success');
  const usageEvents = sink.events.filter((event) => event.type === 'usage.updated');
  assert.equal(usageEvents.length, 2);

  assert.equal(usageEvents[0].inputTokens, 100);
  assert.equal(usageEvents[0].outputTokens, 10);
  assert.equal(usageEvents[0].totalTokens, 110);
  assert.deepEqual(usageEvents[0].cumulative, { inputTokens: 100, outputTokens: 10, totalTokens: 110 });

  // The second call's input already contains the whole context; it is not added
  // to the first call's input again.
  assert.equal(usageEvents[1].inputTokens, 250);
  assert.equal(usageEvents[1].outputTokens, 20);
  assert.equal(usageEvents[1].totalTokens, 270);
  assert.deepEqual(usageEvents[1].cumulative, { inputTokens: 350, outputTokens: 30, totalTokens: 380 });
  assert.deepEqual(result.usage, { inputTokens: 350, outputTokens: 30, totalTokens: 380 });
});

