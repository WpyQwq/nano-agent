'use strict';
const { AgentRuntime } = require('./agent');
const { randomUUID } = require('node:crypto');

// Independent runtime and IPC namespace: side events never appear in the main timeline.
function registerSideAgent({ ipcMain, getWindow, getTask, getConfig, getTools, executeTool, getSystemPrompt, onRunStart, onRunEnd, runtimeFactory, onChildApprove, onChildPermission }) {
  const sessions = new Map();
  const questions = new Map();
  const tasks = new Map();
  function owner(event) {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents) throw new Error('无效的窗口');
  }
  function emit(event, data) { if (!event.sender.isDestroyed()) event.sender.send('side:agent-event', data); }
  function ask(input, payload, signal, emitEvent) {
    return new Promise((resolve, reject) => {
      const questionId = randomUUID();
      const abort = () => { questions.delete(questionId); reject(new Error('操作已取消')); };
      if (signal.aborted) return abort();
      questions.set(questionId, { runId: payload.runId, resolve: answer => { signal.removeEventListener('abort', abort); resolve({ answer }); } });
      signal.addEventListener('abort', abort, { once: true });
      emitEvent({ type: 'question.required', runId: payload.runId, taskId: payload.taskId, questionId, question: String(input.question).slice(0, 4000), options: Array.isArray(input.options) ? input.options.slice(0, 8).map(String) : [] });
    });
  }
  ipcMain.handle('side:agent-run', async (event, input) => {
    owner(event);
    const runId = String(input?.runId || ''), taskId = String(input?.taskId || ''), text = String(input?.text || '').trim();
    if (!runId || !taskId || !text || text.length > 20000) throw new Error('侧聊请求无效');
    if (sessions.has(runId) || tasks.has(taskId)) throw new Error('侧聊正在执行');
    const task = await getTask(taskId);
    if (!task?.projectPath) throw new Error('当前会话没有工作目录');
    const config = await getConfig(input.selection);
    if (config.provider === 'demo') throw new Error('请先连接模型');
    const basePrompt = await getSystemPrompt(task, config);
    config.systemPrompt = `${basePrompt}\n侧边会话：你可以使用与主会话相同的工具，独立完成当前用户要求；引用主会话已有上下文，清晰说明实际执行结果。`;
    const mainHistory = Array.isArray(task.history) ? task.history : [];
    const sideHistory = Array.isArray(input.history) ? input.history : [];
    // History is already structured provider messages. Preserve tool pairs intact.
    const messages = [...mainHistory, ...sideHistory, { role: 'user', content: text }];
    const emitEvent = data => emit(event, data);
    const toolDefinitions = getTools();
    const options = {
      toolDefinitions,
      executeTool: (name, args, payload, options) => name === 'ask_user'
        ? ask(args, payload, options.signal, emitEvent)
        : executeTool(name, args, payload, { ...options, emit: emitEvent, side: true })
    };
    const runtime = runtimeFactory ? runtimeFactory(options) : new AgentRuntime(options);
    sessions.set(runId, runtime); tasks.set(taskId, runId); onRunStart?.(runId, runtime);
    try {
      const result = await runtime.run({ runId, taskId, projectPath: task.projectPath, config, messages, mode: task.mode || 'build', permissionMode: task.mode === 'plan' ? 'read' : config.permissionMode || 'ask' }, emitEvent);
      return { ...result, history: (result.history || []).slice(mainHistory.filter(item => !['system', 'developer'].includes(item.role)).length), rawHistory: undefined };
    } finally { sessions.delete(runId); tasks.delete(taskId); onRunEnd?.(runId); }
  });
  ipcMain.handle('side:agent-cancel', (event, runId) => { owner(event); return sessions.get(String(runId))?.cancel(String(runId)) || false; });
  ipcMain.handle('side:agent-permission', (event, {runId, mode}) => { owner(event); const changed=sessions.get(String(runId))?.setPermission(String(runId), mode) || false;if(changed)onChildPermission?.(runId,mode);return changed; });
  ipcMain.handle('side:agent-approve', (event, decision) => { owner(event);if(decision.childId)return onChildApprove?.(decision) || false;return sessions.get(String(decision.runId))?.approve(decision) || false; });
  ipcMain.handle('side:agent-answer', (event, {runId, questionId, answer}) => {
    owner(event); const pending = questions.get(questionId); if (!pending || pending.runId !== runId) return false;
    questions.delete(questionId); pending.resolve(String(answer || '').slice(0, 16000)); return true;
  });
  return { cancelAll: () => { for (const [id, runtime] of sessions) runtime.cancel(id); }, size: () => sessions.size };
}
module.exports = { registerSideAgent };
