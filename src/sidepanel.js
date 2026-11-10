'use strict';

  // Host calls NanoSidePanel.init({ api, getTask, toast, icons, sendSideChat?, onSideChatUpdate? }).
window.NanoSidePanel = (() => {
  const state = { api: null, getTask: null, toast: null, icons: null, sendSideChat: null, tab: 'overview', file: null, commandId: null, browserOpen: false, browserUrl: '', sideChats: new Map(), sideChatBusy: new Set(), runs: new Map() };
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const icon = name => `<i data-lucide="${name}"></i>`;
  const task = () => state.getTask?.();
  function renderSideChat() {
    const messages = $('sideChatMessages'); if (!messages) return;
    const current = task(); const history = sideHistory(current);
    messages.innerHTML = history.map(message => message.role === 'activity' ? `<details class="side-chat-activity"><summary>${esc(message.content)}</summary><pre>${esc(message.detail || '')}</pre></details>` : message.role === 'reasoning' ? `<details class="side-chat-activity"><summary>思考过程</summary><pre>${esc(message.content)}</pre></details>` : `<div class="${message.role === 'user' ? 'side-chat-user' : 'side-chat-answer'}">${esc(message.content)}</div>`).join('');
    messages.scrollTop = messages.scrollHeight;
    const run = state.runs.get(current?.id);
    const button = $('sideChatForm')?.querySelector('button'); if (button) button.disabled = Boolean(run && !run.question);
    $('sideChatStop').classList.toggle('hidden', !run); $('sideChatPermission').disabled = !run;
    const pending = run?.approvals || [];
    $('sideChatApprovals').innerHTML = pending.map(item => `<div class="side-chat-approval"><strong>${esc(item.childName ? `${item.childName} · ` : '')}${esc(item.name)} 需要确认</strong><pre>${esc(JSON.stringify(item.input || {}, null, 2))}</pre><div><button type="button" data-side-approval="${esc(item.approvalId)}" data-side-child="${esc(item.childId || '')}" data-side-approved="false">拒绝</button><button type="button" data-side-approval="${esc(item.approvalId)}" data-side-child="${esc(item.childId || '')}" data-side-approved="true">允许</button></div></div>`).join('') + (run?.question ? `<div class="side-chat-approval"><strong>${esc(run.question.question)}</strong><div>${run.question.options.map(option=>`<button type="button" data-side-answer="${esc(option)}">${esc(option)}</button>`).join('')}</div></div>` : '');
  }
  function sideHistory(current) {
    if (!current?.id) return [];
    if (!state.sideChats.has(current.id)) state.sideChats.set(current.id, Array.isArray(current.sideChat) ? current.sideChat.map(message => ({ ...message })) : []);
    return state.sideChats.get(current.id);
  }
  async function saveSideHistory(id, history) { if (state.onSideChatUpdate) await state.onSideChatUpdate(id, history.map(message => ({ ...message }))); }
  function sideAgentEvent(event) {
    const run = state.runs.get(event.taskId); if (!run || run.id !== event.runId) return;
    const history = sideHistory({ id: event.taskId });
    if(event.type==='subagent.event'){
      const child=event.event || {};
      if(child.type==='approval.required')run.approvals.push({...child,childId:event.childId,childName:event.name});
      if(child.type==='approval.resolved')run.approvals=run.approvals.filter(item=>item.approvalId!==child.approvalId);
      if(task()?.id===event.taskId)renderSideChat();return;
    }
    if(event.type==='subagent.started' || event.type==='subagent.completed')history.push({role:'activity',content:`${event.name} · ${event.type==='subagent.started'?'开始执行':event.status==='success'?'已完成':'未完成'}`,detail:event.summary || event.error || '',runId:run.id});
    if (event.type === 'message.delta' || event.type === 'reasoning.delta') {
      const role = event.type === 'message.delta' ? 'assistant' : 'reasoning'; const key = `${role}:${event.messageId || run.id}`;
      let item = run.messages.get(key); if (!item) { item = { role, content: '', runId: run.id };run.messages.set(key, item);history.push(item); }
      item.content += event.content || '';
    } else if (event.type === 'tool.started') {
      const item = { role: 'activity', content: `${event.name} · 执行中`, detail: JSON.stringify(event.input || {}, null, 2), runId: run.id };
      run.messages.set(`tool:${event.callId}`, item); history.push(item);
    } else if (event.type === 'tool.completed' || event.type === 'tool.error') {
      const item = run.messages.get(`tool:${event.callId}`);
      if (item) { const failed = event.type === 'tool.error' || event.output?.rejected || (typeof event.output?.code === 'number' && event.output.code !== 0); item.content = `${event.name} · ${failed ? '失败' : '成功'}`; item.detail += `\n${JSON.stringify(event.output || event.error || '', null, 2)}`; }
    } else if (event.type === 'approval.required') run.approvals.push(event);
    else if (event.type === 'approval.resolved') run.approvals = run.approvals.filter(item => item.approvalId !== event.approvalId);
    else if (event.type === 'question.required') run.question = event;
    if (task()?.id === event.taskId) renderSideChat();
  }
  function error(error) { state.toast?.(error?.message || String(error)); }
  function paintIcons() { state.icons?.(); }
  function browserBounds() {
    const update = () => {
      const element = $('sideBrowserViewport');
      const panel = $('activityPanel');
      const visible = state.tab === 'browser' && state.browserOpen && element && panel && !panel.classList.contains('hidden') && $('chatView')?.classList.contains('active');
      if (!visible) { state.api.sideBrowserAction('hide').catch(() => {}); return; }
      const rect = element.getBoundingClientRect();
      state.api.sideBrowserBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }).catch(error);
    };
    update();
  }
  function selectTab(tab) {
    if (state.file?.dirty && state.tab === 'files' && tab !== 'files' && !window.confirm('文件有未保存的修改，仍要切换吗？')) return;
    state.tab = tab;
    document.querySelectorAll('[data-side-tab]').forEach(button => button.classList.toggle('active', button.dataset.sideTab === tab));
    const inspector = $('inspectorFiles'); const activity = $('activityList'); const workspace = $('sideWorkspace');
    inspector.classList.toggle('hidden', tab !== 'overview');
    activity.classList.toggle('hidden', tab !== 'activity');
    workspace.classList.toggle('hidden', tab === 'overview' || tab === 'activity');
    workspace.querySelectorAll('[data-side-view]').forEach(view => view.classList.toggle('hidden', view.dataset.sideView !== tab));
    if (tab === 'files') refreshFiles();
    if (tab === 'chat') renderSideChat();
    if (tab !== 'browser') state.api.sideBrowserAction('hide').catch(() => {});
    browserBounds();
  }
  async function refreshFiles() {
    const active = task(); if (!active?.projectPath) return;
    const taskId = active.id; const projectPath = active.projectPath;
    try {
      const result = await state.api.listProjectFiles(projectPath);
      if (task()?.id !== taskId || task()?.projectPath !== projectPath) return;
      const filter = $('sideFileFilter').value.trim().toLowerCase();
      $('sideFileList').innerHTML = result.files.filter(file => file.toLowerCase().includes(filter)).map(file => `<button type="button" data-side-file="${esc(file)}" title="${esc(file)}">${icon('file-text')}<span>${esc(file)}</span></button>`).join('') || '<p class="side-empty">没有匹配的文件</p>';
      paintIcons();
    } catch (err) { error(err); }
  }
  async function openFile(file) {
    if (state.file?.dirty && !window.confirm('文件有未保存的修改，仍要打开其他文件吗？')) return;
    const active = task(); if (!active?.projectPath) return;
    try {
      const result = await state.api.sideFileRead({ projectPath: active.projectPath, path: file });
      if (task()?.id !== active.id || task()?.projectPath !== active.projectPath) return;
      state.file = { taskId: active.id, projectPath: active.projectPath, path: file, hash: result.hash, content: result.content, dirty: false };
      $('sideFilePath').textContent = file; $('sideEditor').value = result.content; $('sideEditor').disabled = false; $('sideSaveFile').disabled = true;
    } catch (err) { error(err); }
  }
  async function saveFile() {
    const file = state.file; const active = task();
    if (!file || !file.dirty || active?.id !== file.taskId || active.projectPath !== file.projectPath) return;
    const content = $('sideEditor').value; $('sideSaveFile').disabled = true;
    try {
      const result = await state.api.sideFileSave({ taskId: file.taskId, projectPath: file.projectPath, path: file.path, content, expectedHash: file.hash });
      if (result.cancelled) return;
      file.hash = result.hash; file.content = content; file.dirty = $('sideEditor').value !== content;
      window.dispatchEvent(new CustomEvent('nano-side-file-saved', { detail: { taskId: file.taskId, projectPath: file.projectPath, ...result } }));
      state.toast?.('文件已保存');
    } catch (err) { error(err); }
    finally { $('sideSaveFile').disabled = !file.dirty; }
  }
  async function runCommand(event) {
    event.preventDefault(); const active = task(); const command = $('sideCommandInput').value.trim();
    if (!active?.projectPath || !command || state.commandId) return;
    const id = crypto.randomUUID(); state.commandId = id; $('sideRunCommand').disabled = true; $('sideStopCommand').disabled = false;
    const output = $('sideTerminalOutput'); output.textContent += `\nPS ${active.projectPath}> ${command}\n`; output.scrollTop = output.scrollHeight;
    try {
      const result = await state.api.runCommand({ id, projectPath: active.projectPath, command });
      output.textContent += `\n退出代码：${result.code ?? '未执行'}${result.truncated ? ' · 输出已截断' : ''}\n`; output.scrollTop = output.scrollHeight;
    } catch (err) { output.textContent += `\n${err.message}\n`; }
    finally { state.commandId = null; $('sideRunCommand').disabled = false; $('sideStopCommand').disabled = true; }
  }
  async function navigate(event) {
    event.preventDefault(); const value = $('sideBrowserUrl').value.trim(); if (!value) return;
    try { state.browserOpen = true; browserBounds(); await state.api.sideBrowserOpen(value); }
    catch (err) { state.browserOpen = false; browserBounds(); error(err); }
  }
  function createResizeHandle(parent, className, options) {
    const handle = document.createElement('div'); handle.className = className; handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical'); handle.tabIndex = 0;
    handle.setAttribute('aria-label', options.label); parent.appendChild(handle);
    const apply = value => { const max = Math.max(options.min, Math.min(options.max, innerWidth - 360)); const width = Math.max(options.min, Math.min(max, Math.round(value))); document.documentElement.style.setProperty(options.variable, `${width}px`); localStorage.setItem(options.storage, String(width)); browserBounds(); };
    const saved = Number(localStorage.getItem(options.storage)); if (saved) apply(saved);
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return; event.preventDefault(); const start = event.clientX; const initial = options.element().getBoundingClientRect().width;
      handle.setPointerCapture(event.pointerId); document.body.classList.add('side-resizing');
      const move = next => apply(initial + (next.clientX - start) * options.direction);
      const end = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end); document.body.classList.remove('side-resizing'); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
    });
    handle.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); apply(options.element().getBoundingClientRect().width + (event.key === 'ArrowRight' ? 12 : -12) * options.direction); });
  }
  function init(options) {
    if (state.api) return;
    Object.assign(state, options);
    const panel = $('activityPanel'); if (!panel) throw new Error('右侧面板不存在');
    const tabs = panel.querySelector('.inspector-tabs');
    tabs.innerHTML = `<button class="active" type="button" data-side-tab="overview">概览</button><button type="button" data-side-tab="files">文件</button><button type="button" data-side-tab="terminal">终端</button><button type="button" data-side-tab="browser">浏览器</button><button type="button" data-side-tab="chat">侧聊</button><button type="button" data-side-tab="activity">执行</button>`;
    const workspace = document.createElement('div'); workspace.id = 'sideWorkspace'; workspace.className = 'side-workspace hidden';
    workspace.innerHTML = `<section class="side-files hidden" data-side-view="files"><div class="side-file-tools"><input id="sideFileFilter" placeholder="筛选项目文件" aria-label="筛选文件"><button type="button" class="icon-button small" id="sideRefreshFiles" title="刷新文件" aria-label="刷新文件">${icon('refresh-cw')}</button></div><div id="sideFileList" class="side-file-list"></div><div class="side-editor-head"><span id="sideFilePath">选择文件</span><button type="button" id="sideSaveFile" class="icon-button small" disabled title="保存文件" aria-label="保存文件">${icon('save')}</button></div><textarea id="sideEditor" disabled spellcheck="false" aria-label="文件编辑器" placeholder="选择文件后编辑"></textarea></section><section class="side-terminal hidden" data-side-view="terminal"><pre id="sideTerminalOutput" tabindex="0"></pre><form id="sideCommandForm"><input id="sideCommandInput" placeholder="输入 PowerShell 命令" aria-label="终端命令"><button class="icon-button small" type="submit" id="sideRunCommand" title="执行" aria-label="执行">${icon('play')}</button><button class="icon-button small" type="button" id="sideStopCommand" title="停止" aria-label="停止" disabled>${icon('square')}</button></form></section><section class="side-browser hidden" data-side-view="browser"><div class="side-browser-bar"><button type="button" class="icon-button small" data-side-browser-action="back" title="后退" aria-label="后退">${icon('arrow-left')}</button><button type="button" class="icon-button small" data-side-browser-action="forward" title="前进" aria-label="前进">${icon('arrow-right')}</button><button type="button" class="icon-button small" data-side-browser-action="reload" title="刷新" aria-label="刷新">${icon('refresh-cw')}</button><form id="sideBrowserForm"><input id="sideBrowserUrl" placeholder="输入网址" aria-label="浏览器网址"></form></div><div id="sideBrowserViewport"><div class="side-empty">输入网址打开网页</div></div></section><section class="side-chat hidden" data-side-view="chat"><div id="sideChatMessages" class="side-chat-messages"></div><form id="sideChatForm"><textarea id="sideChatInput" rows="2" placeholder="向 Nano 提问" aria-label="侧边对话"></textarea><button class="icon-button small" type="submit" aria-label="发送" title="发送">${icon('arrow-up')}</button></form></section>`;
    panel.appendChild(workspace);
    const chatSection = workspace.querySelector('[data-side-view="chat"]');
    chatSection.innerHTML = `<div class="side-chat-toolbar"><select id="sideChatPermission" aria-label="侧聊权限" disabled><option value="ask">按需确认</option><option value="read">仅观察</option><option value="full">完全访问</option></select><span></span><button type="button" id="sideChatStop" class="icon-button small hidden" title="停止侧聊" aria-label="停止侧聊">${icon('square')}</button></div><div id="sideChatMessages" class="side-chat-messages"></div><div id="sideChatApprovals"></div><form id="sideChatForm"><textarea id="sideChatInput" rows="2" placeholder="向 Nano 提问" aria-label="侧边对话"></textarea><button class="icon-button small" type="submit" aria-label="发送" title="发送">${icon('arrow-up')}</button></form>`;
    tabs.addEventListener('click', event => { const button = event.target.closest('[data-side-tab]'); if (button) selectTab(button.dataset.sideTab); });
    workspace.addEventListener('click', event => { const file = event.target.closest('[data-side-file]'); if (file) openFile(file.dataset.sideFile); const action = event.target.closest('[data-side-browser-action]'); if (action) state.api.sideBrowserAction(action.dataset.sideBrowserAction).catch(error); });
    $('sideFileFilter').addEventListener('input', refreshFiles); $('sideRefreshFiles').addEventListener('click', refreshFiles); $('sideSaveFile').addEventListener('click', saveFile);
    $('sideEditor').addEventListener('input', () => { if (state.file) { state.file.dirty = $('sideEditor').value !== state.file.content; $('sideSaveFile').disabled = !state.file.dirty; } });
    $('sideCommandForm').addEventListener('submit', runCommand); $('sideStopCommand').addEventListener('click', () => state.commandId && state.api.cancelCommand(state.commandId).catch(error));
    $('sideBrowserForm').addEventListener('submit', navigate);
    $('sideChatForm').addEventListener('submit', async event => {
      event.preventDefault(); const input = $('sideChatInput'), text = input.value.trim(), active = task();
      if (!text || !active) return;
      const running = state.runs.get(active.id);
      if (running?.question) { input.value = ''; const question = running.question; if(await state.api.sideAgentAnswer({ runId: running.id, questionId: question.questionId, answer: text })){running.question = null;sideHistory(active).push({role:'user',content:text});await saveSideHistory(active.id,sideHistory(active));}renderSideChat(); return; }
      if (running) return;
      if (!state.startSideAgent) return state.toast?.('侧边智能体暂不可用');
      const history = sideHistory(active);
      const runId = crypto.randomUUID(); const run = { id: runId, approvals: [], question: null, messages: new Map() }; state.runs.set(active.id, run);
      input.value = ''; history.push({ role: 'user', content: text }); renderSideChat();
      try {
        await saveSideHistory(active.id, history);
        const result = await state.startSideAgent({ runId, taskId: active.id, text, history: active.sideAgentHistory || [] });
        if (result.history?.length && state.onSideAgentHistory) await state.onSideAgentHistory(active.id, result.history);
        if (result.status === 'cancelled') history.push({ role: 'activity', content: '已停止' });
        else if (!result.ok) history.push({ role: 'activity', content: result.error || '执行失败' });
        else if (!history.some(message => message.role === 'assistant' && message.runId === runId)) history.push({ role: 'assistant', content: '任务完成，模型未返回文本。', runId });
        await saveSideHistory(active.id, history);
      } catch (err) { history.push({ role: 'activity', content: `执行失败：${err.message}` }); await saveSideHistory(active.id, history).catch(() => {}); error(err); }
      finally { state.runs.delete(active.id); if (task()?.id === active.id) renderSideChat(); }
    });
    $('sideChatStop').addEventListener('click', () => { const run=state.runs.get(task()?.id);if(run)state.api.sideAgentCancel(run.id).catch(error); });
    $('sideChatPermission').addEventListener('change', async event => { const run=state.runs.get(task()?.id);if(!run)return;try{if(!await state.api.sideAgentPermission({runId:run.id,mode:event.target.value}))state.toast?.('当前模式无法修改权限');}catch(err){error(err);} });
    $('sideChatApprovals').addEventListener('click', async event => {
      const button=event.target.closest('button'), run=state.runs.get(task()?.id);if(!button || !run)return;
      try {
        if(button.dataset.sideApproval){button.disabled=true;await state.api.sideAgentApprove({runId:run.id,approvalId:button.dataset.sideApproval,childId:button.dataset.sideChild || undefined,approved:button.dataset.sideApproved==='true'});}
        if(button.dataset.sideAnswer && run.question){const question=run.question,active=task();if(await state.api.sideAgentAnswer({runId:run.id,questionId:question.questionId,answer:button.dataset.sideAnswer})){run.question=null;sideHistory(active).push({role:'user',content:button.dataset.sideAnswer});await saveSideHistory(active.id,sideHistory(active));}renderSideChat();}
      }catch(err){error(err);button.disabled=false;}
    });
    state.api.onSideAgentEvent?.(sideAgentEvent);
    document.addEventListener('click', event => {
      const target = event.target.closest('[data-task],#newTask,#projectButton,#chooseProject,[data-home-project]');
      if (!target || !state.file?.dirty || target.dataset.task === task()?.id) return;
      if (!window.confirm('文件有未保存的修改，仍要切换会话吗？')) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (target.matches('[data-task],#newTask')) clearEditor();
    }, true);
    const projectButton = $('projectButton');
    if (projectButton) new MutationObserver(() => { if (state.file && state.file.projectPath !== task()?.projectPath) clearEditor(); }).observe(projectButton, { childList: true, subtree: true, characterData: true });
    document.addEventListener('click', event => { if (event.target.closest('[data-task],#newTask')) setTimeout(() => { if (state.tab === 'chat') renderSideChat(); if (state.tab === 'files') refreshFiles(); }, 0); });
    state.api.onCommandOutput?.(event => { if (event.id === state.commandId) { const output = $('sideTerminalOutput'); output.textContent += event.text; output.scrollTop = output.scrollHeight; } });
    state.api.onSideBrowserState?.(event => { if (event.url) { state.browserUrl = event.url; $('sideBrowserUrl').value = event.url; } });
    state.api.onSideBrowserError?.(event => state.toast?.(`网页加载失败：${event.message}`));
    createResizeHandle($('sidebar'), 'side-resize-left', { element: () => $('sidebar'), variable: '--nano-left-width', storage: 'nano-left-width', direction: 1, min: 160, max: 420, label: '调整左侧栏宽度' });
    createResizeHandle(panel, 'side-resize-right', { element: () => panel, variable: '--nano-right-width', storage: 'nano-right-width', direction: -1, min: 260, max: 850, label: '调整右侧栏宽度' });
    new ResizeObserver(browserBounds).observe(panel); new ResizeObserver(browserBounds).observe($('sideBrowserViewport'));
    new MutationObserver(browserBounds).observe(panel, { attributes: true, attributeFilter: ['class'] });
    new MutationObserver(browserBounds).observe($('chatView'), { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', browserBounds); window.addEventListener('beforeunload', () => state.api.sideBrowserAction('close').catch(() => {}));
    paintIcons();
  }
  function clearEditor() { state.file = null; $('sideEditor').value = ''; $('sideEditor').disabled = true; $('sideSaveFile').disabled = true; $('sideFilePath').textContent = '选择文件'; }
  return { init, selectTab, browserBounds, refreshFiles };
})();
