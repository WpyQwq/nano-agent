const state = {
  view: 'task',
  projectPath: '',
  tasks: [
    { title: '实现 Codex 风格智能体', age: '现在' },
    { title: '分析开发习惯', age: '38m' },
    { title: '回应问候', age: '42m' },
    { title: '删除快捷方式', age: '16h' },
    { title: '用人声示例生成歌曲', age: '3d' },
    { title: '转码为MP3', age: '3d' },
    { title: '查找语言模型数据集', age: '3d' },
    { title: '了解 NIGHT DANCER', age: '4d' },
    { title: '评估本机训练NLP模型', age: '4d' },
    { title: '查看Agent2项目', age: '4d' },
    { title: '检查 Ollama 是否运行', age: '4d' }
  ],
  messages: [],
  agentWorking: false,
  pendingPrompts: [],
  turnCount: 4,
  activeTurn: 4,
  config: JSON.parse(localStorage.getItem('nano-config') || '{"provider":"demo","model":"Luna High","baseUrl":"","apiKey":""}')
};

const $ = (id) => document.getElementById(id);
const conversation = $('conversation');

function toast(message) {
  const element = $('toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 2600);
}

function renderTasks() {
  $('taskList').innerHTML = state.tasks.map((task, index) => `<button class="task-item ${index === 0 ? 'selected' : ''}"><span>${escapeHtml(task.title)}</span><span class="task-age">${task.age}</span></button>`).join('');
}

function renderTurnRail() {
  const markers = $('turnMarkers');
  if (!markers) return;
  markers.innerHTML = Array.from({ length: state.turnCount }, (_, index) => `<button class="turn-chip ${index + 1 === state.activeTurn ? 'active' : ''}" data-turn="${index + 1}" aria-label="第 ${index + 1} 轮对话"></button>`).join('');
  markers.querySelectorAll('.turn-chip').forEach((button) => button.addEventListener('click', () => {
    state.activeTurn = Number(button.dataset.turn);
    renderTurnRail();
    toast(`已定位到第 ${button.dataset.turn} 轮对话`);
  }));
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])); }

function showView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach((element) => element.classList.toggle('active', element.id === `${view}View`));
  document.querySelectorAll('.nav-item[data-view]').forEach((element) => element.classList.toggle('active', element.dataset.view === view));
}

function appendMessage(role, content) {
  state.messages.push({ role, content });
  const wrapper = document.createElement('div');
  wrapper.className = `message ${role}`;
  wrapper.innerHTML = `<div><div class="message-label">${role === 'user' ? '你' : 'Nano'}</div><div class="message-bubble">${escapeHtml(content)}</div></div>`;
  conversation.appendChild(wrapper);
  conversation.scrollTop = conversation.scrollHeight;
  $('welcomeState')?.remove();
  return wrapper.querySelector('.message-bubble');
}

function appendRunCard(text, icon = '◌') {
  const card = document.createElement('div');
  card.className = 'run-card';
  card.innerHTML = `<span class="run-icon">${icon}</span>${escapeHtml(text)}`;
  conversation.appendChild(card);
  conversation.scrollTop = conversation.scrollHeight;
  return card;
}

function renderPendingQueue() {
  const queue = $('pendingQueue');
  if (!queue) return;
  queue.innerHTML = state.pendingPrompts.map((prompt, index) => `<div class="pending-item"><span class="pending-icon">↳</span><span class="pending-text">${escapeHtml(prompt)}</span><span class="pending-meta">待发送</span><button class="pending-remove" data-pending-index="${index}" title="移除">×</button></div>`).join('');
  queue.querySelectorAll('[data-pending-index]').forEach((button) => button.addEventListener('click', () => { state.pendingPrompts.splice(Number(button.dataset.pendingIndex), 1); renderPendingQueue(); }));
}

function queuePrompt(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return;
  state.pendingPrompts.push(text);
  renderPendingQueue();
  $('composerInput').value = '';
  $('composerInput').style.height = 'auto';
  toast('已暂存，当前任务完成后自动发送');
}

function setWorkingVisual(working) {
  document.querySelector('.composer')?.classList.toggle('working', working);
}

function flushPendingPrompt() {
  if (state.agentWorking || state.pendingPrompts.length === 0) return;
  const next = state.pendingPrompts.shift();
  renderPendingQueue();
  setTimeout(() => sendPrompt(next), 180);
}

function renderWelcomeConversation() {
  conversation.innerHTML = `<div class="welcome-state" id="welcomeState"><svg viewBox="0 0 64 64" class="welcome-icon"><path d="M31.5 9c5.2 0 9.5 3.7 10.3 8.7a14.8 14.8 0 0 1 14.6 14.8c0 1-.1 2-.3 2.9a12.9 12.9 0 0 1-4.2 25.1H17.8A15.8 15.8 0 0 1 15 29.2 15.4 15.4 0 0 1 31.5 9Z"/><path d="M25.2 38.5h.1m13.5 0h.1m-11.2 6.3c2.8 2 5.6 2 8.4 0"/><path d="M31.8 27.8v5.7l-3.5 2.2"/></svg><h1>你想完成什么工作？</h1><p>告诉 Nano 目标，它可以理解项目、修改文件、执行命令，也能直接操作你的 Windows 桌面。</p><div class="quick-actions"><button data-prompt="分析当前项目结构，并告诉我从哪里开始。">✨ 分析项目</button><button data-prompt="检查当前项目是否能正常运行，并修复发现的问题。">⚡ 运行检查</button><button data-prompt="打开浏览器，搜索今天的开发者新闻，并整理成 Markdown。">🖥️ 操作电脑</button></div></div>`;
  bindQuickActions();
}

function renderDemoConversation() {
  $('taskTitle').textContent = '实现 Codex 风格智能体';
  conversation.innerHTML = `<div class="message user"><div><div class="message-bubble">能不能读一下 Codex 的代码？我毕竟安装了你</div></div></div>
  <div class="message assistant"><div><div class="message-bubble"><p>不能直接读取 Codex 的内部源代码。</p><p>你安装的是 Codex 应用，不代表安装了它的源码、设计稿或内部组件库。当前我能读取的是：</p><ul><li><code>D:\Nano</code> 里的项目源码</li><li>你提供的截图和图片</li><li>你明确提供路径且有权限访问的本地文件</li></ul><p>所以之前我只能根据截图和公开可见的交互去复刻，无法直接拿到 Codex 的真实 CSS、组件、字体、设计 Token 或状态逻辑。这也是视觉上一直有差距的原因。</p><p>如果你能提供 Codex 的源码目录、设计文件或可访问的前端资源路径，我可以直接分析并迁移；否则我会继续按你给的截图做像素级复刻。</p><p>当前 <code>D:\Nano</code> 的源代码我已经可以正常读取和修改。</p></div><div class="message-tools"><span class="message-tool-icon">▢</span><span class="message-tool-icon">↗</span><span class="message-tool-icon">↻</span><span>15:30</span></div></div></div>`;
  conversation.scrollTop = conversation.scrollHeight;
}

function buildMessages() {
  const system = `你是 Nano Agent，一个本地优先的 Codex 风格电脑智能体。你可以读取项目、修改文件、执行命令，也可以通过 computer 工具操作 Windows。所有付款、发送、删除、发布、管理员操作都必须请求用户确认。当前项目：${state.projectPath || '未选择'}`;
  return [{ role: 'system', content: system }, ...state.messages.map(({ role, content }) => ({ role, content }))];
}

async function sendPrompt(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return;
  if (state.agentWorking) {
    queuePrompt(text);
    return;
  }
  state.agentWorking = true;
  state.turnCount += 1;
  state.activeTurn = state.turnCount;
  renderTurnRail();
  setWorkingVisual(true);
  appendMessage('user', text);
  $('composerInput').value = '';
  const runCard = appendRunCard('正在理解任务并准备执行…');
  const bubble = appendMessage('assistant', '');
  const unsubscribe = window.nano.onAgentEvent((event) => {
    if (event.type === 'run.started') runCard.innerHTML = '<span class="run-icon">◌</span>正在运行智能体…';
    if (event.type === 'message.delta') bubble.textContent += event.content;
    if (event.type === 'tool.started') runCard.innerHTML = `<span class="run-icon">⌁</span>正在调用 ${escapeHtml(event.name)}…`;
    if (event.type === 'tool.completed') runCard.innerHTML = `<span class="run-icon">✓</span>已完成 ${escapeHtml(event.name)}`;
    if (event.type === 'approval.required') { runCard.innerHTML = `<span class="run-icon">!</span>${escapeHtml(event.reason)}`; toast(event.reason); }
    if (event.type === 'file.changed') toast(`已修改文件：${event.path}`);
    if (event.type === 'run.completed') { runCard.innerHTML = '<span class="run-icon">✓</span>任务完成'; state.agentWorking = false; setWorkingVisual(false); unsubscribe(); flushPendingPrompt(); }
    if (event.type === 'run.error') { runCard.innerHTML = `<span class="run-icon">!</span>${escapeHtml(event.message)}`; state.agentWorking = false; setWorkingVisual(false); toast(event.message); unsubscribe(); flushPendingPrompt(); }
    conversation.scrollTop = conversation.scrollHeight;
  });
  const result = await window.nano.runAgent({ config: state.config.provider === 'demo' ? null : state.config, messages: buildMessages(), projectPath: state.projectPath, permissionMode: 'full' });
  if (!result.ok) { state.agentWorking = false; setWorkingVisual(false); toast(result.error || '任务执行失败'); flushPendingPrompt(); }
}

async function chooseProject() {
  const project = await window.nano.chooseProject();
  if (!project) return;
  state.projectPath = project;
  $('projectPath').textContent = project;
  $('projectButton').textContent = `⌂ ${project.split('\\').pop()}`;
  $('composerProject').textContent = `⌂ ${project.split('\\').pop()}`;
  toast(`已选择项目：${project}`);
}

async function screenshot() {
  try {
    const result = await window.nano.computerAction({ type: 'screenshot' });
    $('screenPreview').innerHTML = `<img src="${result.dataUrl}" alt="当前屏幕截图" />`;
    toast('截图已更新');
  } catch (error) { toast(`截图失败：${error.message}`); }
}

async function runComputer(type) {
  let action = { type };
  if (type === 'mouse_move') { action = { type, x: 500, y: 400 }; }
  if (type === 'mouse_click') { action = { type, x: 500, y: 400, button: 'left' }; }
  if (type === 'scroll') { action = { type, amount: 3 }; }
  if (type === 'type') { action = { type, text: 'Nano Agent test input' }; }
  if (type === 'mouse_click' && !window.confirm('即将点击屏幕坐标 (500, 400)，确定执行吗？')) return;
  try { await window.nano.computerAction(action); await screenshot(); } catch (error) { toast(`动作失败：${error.message}`); }
}

async function refreshWindows() {
  try {
    const windows = await window.nano.listWindows();
    $('windowList').innerHTML = windows.length ? windows.map((item) => `<div class="window-row"><span>${escapeHtml(item.MainWindowTitle)}</span><small>${escapeHtml(item.ProcessName)} · ${item.Id}</small></div>`).join('') : '<div class="empty-secondary">没有找到活动窗口。</div>';
  } catch (error) { toast(`窗口读取失败：${error.message}`); }
}

function bindQuickActions() {
  document.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => sendPrompt(button.dataset.prompt)));
}

function loadSettings() {
  setProviderSelect(state.config.provider || 'demo');
  $('modelInput').value = state.config.model || '';
  $('baseUrlInput').value = state.config.baseUrl || '';
  $('apiKeyInput').value = state.config.apiKey || '';
  $('providerLabel').textContent = state.config.provider === 'demo' ? '演示模式' : state.config.provider;
  $('modelMeta').textContent = state.config.model || '未配置模型';
  $('modelButton').textContent = `${state.config.model || '未配置模型'} ▾`;
}

function setProviderSelect(value) {
  const control = $('providerSelect');
  if (!control) return;
  const option = control.querySelector(`[data-value="${value}"]`) || control.querySelector('[data-value="demo"]');
  control.dataset.value = option.dataset.value;
  control.querySelector('.select-value').textContent = option.textContent;
  control.querySelectorAll('.select-menu button').forEach((button) => button.classList.toggle('active', button === option));
}

function saveSettings() {
  state.config = { provider: $('providerSelect').dataset.value || 'demo', model: $('modelInput').value.trim(), baseUrl: $('baseUrlInput').value.trim(), apiKey: $('apiKeyInput').value };
  localStorage.setItem('nano-config', JSON.stringify(state.config));
  loadSettings();
  toast('设置已保存');
}

document.querySelectorAll('.nav-item[data-view]').forEach((element) => element.addEventListener('click', () => {
  showView(element.dataset.view);
  if (element.dataset.view === 'task') renderWelcomeConversation();
}));
document.querySelector('.window-toggle').addEventListener('click', () => $('sidebar').classList.toggle('collapsed'));
document.querySelectorAll('[data-window-control]').forEach((button) => button.addEventListener('click', () => window.nano.windowControl(button.dataset.windowControl)));
$('sendButton').addEventListener('click', () => sendPrompt($('composerInput').value));
$('composerInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    if (state.agentWorking) { event.preventDefault(); queuePrompt(event.target.value); }
    else if (event.ctrlKey || event.metaKey) { event.preventDefault(); sendPrompt(event.target.value); }
  }
});
$('composerInput').addEventListener('input', (event) => { event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 140)}px`; });
$('projectButton').addEventListener('click', chooseProject);
$('composerProject').addEventListener('click', chooseProject);
$('chooseProject').addEventListener('click', chooseProject);
$('refreshScreen').addEventListener('click', screenshot);
$('refreshWindows').addEventListener('click', refreshWindows);
$('saveSettings').addEventListener('click', saveSettings);
document.querySelectorAll('[data-computer]').forEach((button) => button.addEventListener('click', () => runComputer(button.dataset.computer)));
document.querySelectorAll('.select-control').forEach((control) => {
  control.querySelector('.select-trigger').addEventListener('click', () => control.classList.toggle('open'));
  control.querySelectorAll('.select-menu button').forEach((option) => option.addEventListener('click', () => { setProviderSelect(option.dataset.value); control.classList.remove('open'); }));
});
$('searchInput').addEventListener('input', (event) => { const term = event.target.value.toLowerCase(); $('searchResults').textContent = term ? state.tasks.filter((task) => task.title.toLowerCase().includes(term)).map((task) => task.title).join(' · ') || '没有找到匹配任务。' : '输入关键词开始搜索。'; });

renderTasks();
loadSettings();
renderTurnRail();
renderDemoConversation();
