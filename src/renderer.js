'use strict';
const $ = (id) => document.getElementById(id);
const api = window.nano;
const state = { tasks: [], currentId: null, config: {}, view: 'chat', archived: false, files: [], contexts: [], preview: null, run: null, command: null, dataPath: '', gitTab: false, scroller:null, streamFrame:0, dirtyMessages:new Set() };
state.reviewTab=false;state.mcpBusy=new Set();state.reviewRecords=[];
const labels = { list_files:'列出文件', read_file:'读取文件', search_text:'搜索内容', write_file:'写入文件', run_command:'执行命令', trash_file:'移入回收站', computer_screenshot:'观察屏幕', computer_windows:'读取窗口', computer_action:'操作桌面', git_status:'检查 Git 状态', git_diff:'读取 Git 差异' };
Object.assign(labels,{update_plan:'更新工作计划',ask_user:'询问用户'});
const permissionLabels = { ask:'按需确认', full:'完全访问', read:'仅观察' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = (name) => `<i data-lucide="${name}"></i>`;
const icons = () => window.lucide.createIcons({ attrs: { 'aria-hidden':'true' } });
const current = () => state.tasks.find(t => t.id === state.currentId);
const project = () => current()?.projectPath || '';
const json = (value) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
function toast(text) { $('toast').textContent = text; $('toast').classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').classList.remove('show'), 3500); }
async function safely(fn) { try { return await fn(); } catch(error) { toast(error.message); return null; } }
function hidePopovers() { document.querySelectorAll('[popover]').forEach(p => { if(p.matches(':popover-open')) p.hidePopover(); }); }
function timeAgo(time) { const m = Math.max(0, Math.floor((Date.now() - time)/60000)); return m < 1 ? '刚刚' : m < 60 ? `${m}分` : m < 1440 ? `${Math.floor(m/60)}时` : `${Math.floor(m/1440)}天`; }
function persist(task = current()) { return task ? api.saveTask(JSON.parse(JSON.stringify(task))) : Promise.resolve(); }
function renderTasks() {
  const tasks = state.tasks.filter(t => Boolean(t.archived) === state.archived).sort((a,b) => Number(Boolean(b.pinned))-Number(Boolean(a.pinned)) || b.updatedAt-a.updatedAt);
  $('listHeading').textContent = state.archived ? '已归档会话' : '最近会话';
  $('taskList').innerHTML = tasks.length ? tasks.map((t,index) => `${t.pinned && index===0?'<div class="task-group-heading">置顶</div>':''}${!t.pinned && index>0 && tasks[index-1].pinned?'<div class="task-group-heading">最近会话</div>':''}<div class="task-row ${t.id===state.currentId?'selected':''}"><button class="task-item" data-task="${esc(t.id)}" title="${esc(t.title)}"><span>${esc(t.title)}</span>${state.run?.taskId===t.id?'<span class="run-indicator"></span>':`<time>${timeAgo(t.updatedAt)}</time>`}</button><div class="task-row-actions"><button class="icon-button small" data-pin-row="${esc(t.id)}" title="${t.pinned?'取消置顶':'置顶'}" aria-label="${t.pinned?'取消置顶':'置顶'}">${icon('pin')}</button><button class="icon-button small" data-archive-row="${esc(t.id)}" title="${t.archived?'恢复':'归档'}" aria-label="${t.archived?'恢复':'归档'}">${icon('archive')}</button></div></div>`).join('') : '<p class="empty">暂无会话</p>';
  $('taskCount').textContent = `${state.tasks.length} 个会话 · ${state.tasks.filter(t => t.archived).length} 个已归档`;
  icons();
}
function showView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active',v.id===`${view}View`));
  document.querySelectorAll('.main-nav [data-view]').forEach(b => b.classList.toggle('active',b.dataset.view===view));
  hidePopovers();
  if(view==='search') setTimeout(() => $('searchInput').focus(),50);
  if(view==='project') safely(refreshFiles);
  if(view==='settings') $('saveStatus').textContent='';
  window.NanoMotion.enter(document.getElementById(`${view}View`),3);
}
function newTask() {
  if(current()) current().draft = $('composerInput').value;
  const task = { id:crypto.randomUUID(), title:'新建会话', projectPath:project() || state.defaultProject, messages:[], history:[], events:[], changes:[], createdAt:Date.now(), updatedAt:Date.now(), draft:'' };
  state.tasks.unshift(task); state.currentId = task.id; state.contexts=[]; state.preview=null; state.archived=false;
  renderChat(); renderTasks(); showView('chat'); safely(()=>persist(task)); $('composerInput').focus();
}
function selectTask(id) {
  const old = current(); if(old) { old.draft=$('composerInput').value; safely(()=>persist(old)); }
  state.currentId=id; state.contexts=[]; state.preview=null; $('fileContent').textContent='选择文件查看内容'; $('previewPath').textContent='文件预览'; $('addContext').classList.add('hidden'); renderChat(); renderTasks(); showView('chat');
}
function markdown(content) { return window.DOMPurify.sanitize(window.marked.parse(content || '', { breaks:true }), { FORBID_TAGS:['img','style','iframe'], FORBID_ATTR:['style'] }); }
function homeHtml(task) {
  const name=task.projectPath?.split(/[\\/]/).pop() || '工作区';
  return `<div class="welcome simple-welcome">${icon('sparkles')}<h1>今天想在 ${esc(name)} 做什么？</h1><button class="home-project-link" data-home-project>${icon('folder-open')} ${esc(name)} ${icon('chevron-down')}</button></div>`;
}
function messageHtml(message,final=false) {
  if(message.role==='activity')return `<details class="timeline-activity ${message.error?'activity-error':''}" data-message="${esc(message.id)}"><summary>${icon(message.status==='执行中'?'loader-circle':message.error?'circle-alert':'terminal-square')}<span>${esc(message.label)}</span>${message.status==='执行中'?'<span class="timeline-pulse"></span>':''}</summary>${message.detail?`<pre>${esc(message.detail)}</pre>`:''}</details>`;
  if(message.role==='reasoning')return `<details class="timeline-thinking" data-message="${esc(message.id)}"><summary>${icon('brain')} 思考过程</summary><div class="thinking-text">${esc(message.content || '')}</div></details>`;
  if(message.role==='compact')return `<div class="timeline-compact" data-message="${esc(message.id)}"><span>${esc(message.label)}</span></div>`;
  return `<article class="message ${message.role}" data-message="${esc(message.id)}"><div class="message-inner"><div class="message-content">${message.role==='user'?esc(message.content):markdown(message.content)}</div>${final && message.role==='assistant' && message.content ? `<div class="message-actions"><button class="icon-button" data-copy="${esc(message.id)}" title="复制回复" aria-label="复制回复">${icon('copy')}</button><button class="icon-button" data-retry="${esc(message.id)}" title="重新生成" aria-label="重新生成">${icon('rotate-ccw')}</button></div>`:''}</div></article>`;
}
function renderChat() {
  const task = current(); if(!task) return;
  $('taskTitle').textContent=task.title;
  $('projectButton').textContent=task.projectPath?.split(/[\\/]/).pop() || '选择项目';
  $('projectPath').textContent=task.projectPath || '选择一个本地目录开始工作';
  $('composerInput').value=task.draft || '';
  if(!task.messages.length) $('conversation').innerHTML=homeHtml(task);
  else {
    let html='';const processed=new Set();
    for(const m of task.messages){
      if(!m.runId || state.run?.id===m.runId){if(m.runId && state.run?.id===m.runId && !processed.has(m.runId)){processed.add(m.runId);html+=`<div class="run-summary" data-active-run="${esc(m.runId)}">${icon('workflow')}<span>正在工作</span></div>`;}html+=messageHtml(m);continue;}
      if(processed.has(m.runId))continue;processed.add(m.runId);
      const group=task.messages.filter(item=>item.runId===m.runId);const responses=group.filter(item=>item.role==='assistant' && item.content);const final=responses.at(-1);const detail=group.filter(item=>item!==final);const fileStats=new Map();for(const item of group.filter(item=>item.changedPath)){const stat=fileStats.get(item.changedPath) || {added:0,removed:0};stat.added+=item.added || 0;stat.removed+=item.removed || 0;fileStats.set(item.changedPath,stat);}const duration=final?.durationMs ?? group.find(item=>item.durationMs!=null)?.durationMs;const elapsed=duration!=null?` · ${Math.max(1,Math.round(duration/1000))} 秒`:'';
      html+=`<details class="turn-details"><summary>已完成的工作${elapsed} ${icon('chevron-down')}</summary>${detail.map(item=>messageHtml(item)).join('')}</details>${final?messageHtml(final,true):''}${fileStats.size?`<div class="turn-deliverables"><strong>修改了 ${fileStats.size} 个文件</strong>${[...fileStats].map(([file,stat])=>`<button data-hub-file="${esc(file)}">${icon('file-diff')}<span>${esc(file)}</span><span class="added">+${stat.added}</span><span class="removed">−${stat.removed}</span></button>`).join('')}</div>`:''}`;
    }
    $('conversation').innerHTML=html;
  }
  $('conversation').querySelector('.welcome>svg')?.classList.add('welcome-mark');
  renderActivity(); renderApprovals(); renderChanges(); renderContexts(); renderHub(); renderPlan(); renderQueue(); renderTurns(); updateRunVisual(); icons(); scrollBottom();
}
function inspectorTab(tab) {
  if(window.NanoSidePanel && document.querySelector('[data-side-tab]')){window.NanoSidePanel.selectTab(tab==='files'?'overview':tab);return;}
  document.querySelectorAll('[data-inspector-tab]').forEach(button=>button.classList.toggle('active',button.dataset.inspectorTab===tab));
  $('inspectorFiles').classList.toggle('hidden',tab!=='files'); $('activityList').classList.toggle('hidden',tab!=='activity');
}
function renderHub() {
  const task=current();
  $('outputList').innerHTML=task?.changes?.length?task.changes.map(file=>`<button class="hub-file" data-hub-file="${esc(file)}">${icon('file-diff')}<span title="${esc(file)}">${esc(file)}</span></button>`).join(''):'<p class="hub-empty">尚无文件变更</p>';
  $('sourceList').innerHTML=task?.sources?.length?task.sources.map(file=>`<button class="hub-file" data-hub-file="${esc(file)}">${icon('file-text')}<span title="${esc(file)}">${esc(file)}</span></button>`).join(''):'<p class="hub-empty">尚无文件来源</p>';
  $('summaryHub').classList.toggle('hidden',!task?.summary);$('summaryText').textContent=task?.summary || '';
}
async function refreshReviews() {
  const taskId=current()?.id;if(!taskId)return;const records=await api.listChanges(taskId);if(current()?.id!==taskId)return;
  state.reviewRecords=records;
  $('changeReview').innerHTML=records.length?records.map(record=>`<article class="review-card"><div class="review-heading">${icon('file-diff')}<span>${esc(record.path)}</span><span class="review-state">${({pending:'待审阅',accepted:'已接受',restored:'已恢复'})[record.status]}</span></div><div class="review-actions">${record.status==='pending'?`<button class="button compact" data-accept-change="${record.id}">${icon('check')}接受</button>`:''}${record.status!=='restored'?`<button class="button compact" data-restore-change="${record.id}">${icon('undo-2')}恢复</button>`:''}</div><div class="review-diff">${record.patch.split('\n').map(line=>`<span class="diff-line ${line.startsWith('+')&&!line.startsWith('+++')?'diff-added':line.startsWith('-')&&!line.startsWith('---')?'diff-removed':line.startsWith('@@')?'diff-hunk':''}">${esc(line)}</span>`).join('')}</div></article>`).join(''):'<p class="empty">Nano 修改文件后，在这里逐项审阅或恢复。</p>';icons();
}
async function renderMcp() {
  const statuses=await api.mcpStatus();const servers=state.config.mcpServers || [];
  $('mcpServerList').innerHTML=servers.length?servers.map(server=>{const status=statuses.find(item=>item.id===server.id);const busy=state.mcpBusy.has(server.id),connected=status?.status==='connected';return `<div class="mcp-server">${icon('plug')}<div><strong>${esc(server.name)}</strong><small>${esc(server.type==='stdio'?server.command:server.url)}</small>${status?.error?`<small class="mcp-error">${esc(status.error)}</small>`:''}<small>${busy?'正在连接…':connected?`${status.toolCount} 个工具已连接`:'未连接'}${server.hasEnv?' · 已保存环境变量':''}</small></div><button class="button compact" ${busy?'disabled':''} data-mcp-${connected?'disconnect':'connect'}="${esc(server.id)}">${connected?'断开':'连接'}</button><button class="icon-button small" data-mcp-remove="${esc(server.id)}" title="移除扩展" aria-label="移除扩展">${icon('x')}</button></div>`;}).join(''):'<p class="empty">添加 MCP 扩展，将外部工具接入智能体。</p>';icons();
}
function renderTurns() {
  const messages=current()?.messages.filter(message=>message.role==='user') || [];
  $('turnRail').innerHTML=messages.length>2?messages.map((message,index)=>`<button data-turn-message="${esc(message.id)}" title="${esc(message.content.slice(0,60))}" aria-label="定位第 ${index+1} 轮"></button>`).join(''):'';
}
function renderContextUsage(){
  const usage=current()?.usage || {};const selection=window.NanoModels?.selection() || {};const used=Number(usage.inputTokens || 0)+Number(usage.outputTokens || 0);const preset=/deepseek|gpt|claude|kimi|glm|hy[34]|minimax|gemini/i.test(selection.model || '');const limit=Number(selection.contextWindow || (preset?1000000:0));const pct=limit?Math.min(100,used/limit*100):0;
  $('contextMeter').style.setProperty('--context-used',`${pct}%`);
  const cached=usage.cachedTokens ?? usage.inputTokenDetails?.cache_read;
  $('contextTooltip').textContent=limit?`上下文窗口${selection.contextWindow?'':'（1M 预设，实际以服务商为准）'}\n已用 ${pct.toFixed(0)}% · 剩余 ${Math.max(0,100-pct).toFixed(0)}%\n${used.toLocaleString()} / ${limit.toLocaleString()} tokens${cached!=null?`\n缓存命中 ${Number(cached).toLocaleString()}`:''}`:used?`本次使用 ${used.toLocaleString()} tokens · 服务商未提供上下文上限`:'上下文用量将在模型返回后显示';
}
function scrollBottom(force=false) { state.scroller?.bottom(force); }
function renderActivity() {
  const events=current()?.events || [];
  const open=new Set([...$('activityList').querySelectorAll('details[open]')].map(item=>item.dataset.eventId));
  $('activityList').innerHTML=events.length?events.map((e,index)=>`<details class="activity-entry" data-event-id="${e.callId || index}" ${open.has(String(e.callId || index)) || e.status==='执行中'?'open':''}><summary>${esc(labels[e.name] || e.name || '运行')} · ${esc(e.status || e.type)}</summary><pre>${esc(json(e.input || {}))}</pre>${e.liveOutput?`<pre class="live-output">${esc(e.liveOutput)}</pre>`:''}${e.output!==undefined?`<pre>${esc(json(e.output).slice(0,14000))}</pre>`:''}</details>`).join(''):'<p class="empty">执行后显示模型与工具的真实记录。</p>';
}
function renderApprovals() {
  const pending = state.run?.taskId === current()?.id ? state.run.approvals : [];
  const question=state.run?.taskId===current()?.id ? state.run.question:null;
  $('approvalHost').innerHTML=(pending||[]).map(e=>`<div class="approval-card"><strong>${icon('shield-check')} ${esc(labels[e.name] || e.name)}需要你的确认</strong><pre>${esc(json(e.input))}</pre><div class="approval-actions"><button class="button" data-decision="reject" data-approval="${esc(e.approvalId)}">拒绝</button><button class="button primary" data-decision="approve" data-approval="${esc(e.approvalId)}">允许这一次</button></div></div>`).join('')+(question?`<div class="approval-card question-card"><strong>${esc(question.question)}</strong><div class="question-options">${question.options.map(option=>`<button class="button compact" data-question-option="${esc(option)}">${esc(option)}</button>`).join('')}</div></div>`:''); icons();
}
function renderQueue() { const queue=current()?.queue || []; $('promptQueue').innerHTML=queue.map((item,index)=>`<div class="queued-prompt">${icon('corner-down-right')}<span>${esc(item.text)}</span><button class="icon-button small" data-remove-queued="${index}" aria-label="移除待办消息">${icon('x')}</button></div>`).join(''); }
function renderPlan() {
  const task=current(),plan=task?.plan || [];
  const count=plan.filter(step=>step.status==='completed').length;
  $('planHub').innerHTML=`<div class="hub-heading">工作计划 ${plan.length?`${count}/${plan.length}`:''}<button class="icon-button small" data-toggle-plan title="编辑工作计划" aria-label="编辑工作计划">${icon('pencil')}</button></div>${plan.length?`<div class="plan-progress"><span style="width:${count/plan.length*100}%"></span></div>${plan.map(step=>`<div class="plan-row ${step.status}">${icon(step.status==='completed'?'circle-check':step.status==='in_progress'?'circle-dot':'circle')}<span>${esc(step.text)}</span></div>`).join('')}${!state.run && count<plan.length?'<div class="plan-hub-actions"><button class="button compact" data-continue-plan>继续执行</button></div>':''}`:'<p class="hub-empty">复杂任务会在这里分解步骤</p>'}`;
}
function renderChanges() {
  const paths = state.run?.taskId===current()?.id ? [...(state.run.changedFiles?.keys() || [])] : [];
  const details = state.run?.taskId===current()?.id ? [...(state.run.changedFiles?.values() || [])] : [];
  const added = details.reduce((sum, item) => sum + (item.added || 0), 0);
  const removed = details.reduce((sum, item) => sum + (item.removed || 0), 0);
  $('changePill').classList.toggle('hidden',!paths.length || state.run?.taskId!==current()?.id);
  $('changePill').innerHTML=`${paths.length} 个文件已修改 ${added?`<span class="added">+${added}</span>`:''}${removed?`<span class="removed">−${removed}</span>`:''} ${icon('chevron-right')}`;
}
function renderContexts() { $('contextFiles').innerHTML=state.contexts.map((f,index)=>`<div class="context-chip">${icon('file-text')}<span title="${esc(f.path)}">${esc(f.path.split(/[\\/]/).pop())}</span><button data-remove-context="${index}" aria-label="移除文件">${icon('x')}</button></div>`).join(''); icons(); }
function updateRunVisual() {
  const own = state.run?.taskId===current()?.id;
  const hasDraft=Boolean($('composerInput').value.trim());
  $('sendButton').classList.toggle('stopping',own);
  $('sendButton').innerHTML=icon(own && !hasDraft?'square':'arrow-up');
  $('sendButton').title=own?'停止执行 (Esc)':'发送消息'; $('sendButton').setAttribute('aria-label',own?'停止执行':'发送消息');
  $('runStatus').textContent=own ? (state.run.approvals.length?'等待你的确认':'正在工作…') : '本地优先 · 由你掌控';
  $('composerInput').placeholder=own?'执行中，你可以随时停止':'与 Nano 一起工作'; icons();
  if(own && state.run.question)$('composerInput').placeholder='回复 Nano 的问题…';else if(own)$('composerInput').placeholder='随时补充要求…';
  $('modeButton').querySelector('span').textContent=current()?.mode==='plan'?'规划':'构建';
  renderContextUsage();
}
function applyAppearance(config) {
  const mode = config.theme==='system' ? (matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light') : config.theme || 'dark';
  document.documentElement.dataset.theme=mode;
  document.documentElement.style.setProperty('--font-size',`${config.fontSize || 14}px`);
}
function updateConfigUI() {
  const c=state.config;
  $('modelButton').querySelector('span').textContent=c.provider==='demo'?'演示模式':c.model || '配置模型';
  $('providerStatus').textContent=c.provider==='demo'?'演示模式 · 未连接模型':c.model || '未配置模型';
  $('permissionButton').querySelector('span').textContent=permissionLabels[c.permissionMode] || '按需确认';
  $('permissionButton').classList.toggle('full',c.permissionMode==='full');
  $('providerInput').value=c.provider || 'demo'; $('modelInput').value=c.model || ''; $('baseUrlInput').value=c.baseUrl || '';
  $('apiKeyInput').value=''; $('apiKeyInput').placeholder=c.hasApiKey?'密钥已加密保存，留空保留':'输入 API Key';
  $('permissionSelect').value=c.permissionMode || 'ask'; $('themeInput').value=c.theme || 'dark'; $('fontSizeInput').value=String(c.fontSize || 14);
  $('maxStepsInput').value=c.maxSteps || 20; $('systemPromptInput').value=c.systemPrompt || ''; $('clearKey').checked=false;
  applyAppearance(c);
  window.NanoSelect?.scan();
}
function settingsPayload() { return {permissionMode:$('permissionSelect').value,theme:$('themeInput').value,fontSize:Number($('fontSizeInput').value),maxSteps:Number($('maxStepsInput').value),systemPrompt:$('systemPromptInput').value.trim()}; }
function settingsTab(tab) { document.querySelectorAll('[data-settings-tab]').forEach(b=>b.classList.toggle('active',b.dataset.settingsTab===tab)); document.querySelectorAll('[data-section]').forEach(s=>s.classList.toggle('hidden',s.dataset.section!==tab));if(tab==='mcp')safely(renderMcp); }
async function saveSettings(event) {
  event.preventDefault(); const payload=settingsPayload();
  if(!Number.isInteger(payload.maxSteps) || payload.maxSteps<1 || payload.maxSteps>40) throw new Error('最大模型轮数应为 1–40');
  state.config=await api.saveSettings(payload); updateConfigUI(); $('saveStatus').textContent='已保存'; toast('设置已保存');
}
async function chooseProject() {
  if(state.run?.taskId===current()?.id) return toast('请先停止当前任务再切换项目');
  const selected=await api.chooseProject(); if(!selected) return;
  const task=current(); task.projectPath=selected; task.history=[]; state.contexts=[]; state.preview=null; $('addContext').classList.add('hidden'); await persist(task); renderChat(); toast('项目已打开');
  if(state.view==='project') await refreshFiles();
}
async function refreshFiles() {
  if(!project()) { $('fileTree').innerHTML='<p class="empty">尚未打开项目</p>'; return; }
  const root=project(); const result=await api.listProjectFiles(root); if(root!==project()) return;
  state.files=result.files;
  $('fileTree').innerHTML=result.files.map(f=>`<button data-file="${esc(f)}" title="${esc(f)}">${icon('file-text')}<span>${esc(f)}</span></button>`).join('')+(result.truncated?'<p class="empty">仅显示前 500 个文件</p>':'');
  if(!result.files.length) $('fileTree').innerHTML='<p class="empty">目录中没有可显示的文件</p>';
  icons(); if(state.gitTab) await refreshGit();if(state.reviewTab)await refreshReviews();
}
async function openFile(file) { const root=project(), taskId=current()?.id; const result=await api.readProjectFile({projectPath:root,relativePath:file}); if(root!==project() || taskId!==current()?.id) return; state.preview={...result,root}; $('previewPath').textContent=file; $('fileContent').textContent=result.content; $('addContext').classList.remove('hidden'); document.querySelectorAll('[data-file]').forEach(b=>b.classList.toggle('active',b.dataset.file===file)); }
async function refreshGit() { if(!project()) return; $('gitOutput').textContent='正在读取 Git 变更…'; const root=project(); const status=await api.git({projectPath:root}); const diff=await api.git({projectPath:root,diff:true}); if(root!==project()) return; const patches=Object.values(current()?.changeDetails || {}).map(item=>item.patch).filter(Boolean).join('\n'); $('gitOutput').textContent=[status.stdout,status.stderr,diff.stdout,diff.stderr,patches?`\nNano 本会话修改记录（逐次操作）\n${patches}`:''].filter(Boolean).join('\n') || '工作区干净，没有 Git 变更。'; }
async function openContextDialog() { if(!project()) { await chooseProject(); if(!project()) return; } await refreshFiles(); $('contextFilter').value=''; renderContextList(); $('contextDialog').showModal(); }
function renderContextList() { const query=$('contextFilter').value.toLowerCase(); $('contextList').innerHTML=state.files.filter(f=>f.toLowerCase().includes(query)).map(f=>`<button data-context-file="${esc(f)}">${icon('file-text')}<span>${esc(f)}</span></button>`).join('') || '<p class="empty">没有匹配文件</p>'; icons(); }
function addContext(file) { if(!file || file.root!==project()) return toast('请从当前项目重新选择文件'); if(state.contexts.some(f=>f.path===file.path)) return toast('文件已加入'); if(state.contexts.length>=6) return toast('每次最多加入 6 个文件'); if(file.content.length>60000) return toast('文件过大，请通过智能体按需读取'); state.contexts.push(file); renderContexts(); toast('已加入上下文'); }
async function sendPrompt(text, retry=false) {
  text=String(text || '').trim(); if(!text) return;
  const task=current(); if(!task) return;
  if(state.run) {
    if(state.run.taskId!==task.id)return toast('其他会话正在执行，请先等待或停止');
    if(state.run.question){const run=state.run,question=run.question;task.messages.push({id:crypto.randomUUID(),role:'user',content:text,time:Date.now(),runId:run.id});run.question=null;$('composerInput').value='';task.draft='';renderChat();await persist(task);const accepted=await api.answerQuestion({runId:run.id,questionId:question.questionId,answer:text});if(!accepted)toast('该问题已结束');return;}
    if(state.contexts.length)return toast('插话暂不支持附件，请在新一轮发送文件');
    const run=state.run;const accepted=await api.steerAgent(run.id,text);if(!accepted)return toast('当前任务即将结束，请重试');task.messages.push({id:crypto.randomUUID(),role:'user',content:text,time:Date.now(),runId:run.id});task.draft='';$('composerInput').value='';window.NanoMotion.autosize($('composerInput'));renderChat();scrollBottom(true);updateRunVisual();await persist(task);return;
  }
  const runId=crypto.randomUUID();
  const attached=state.contexts.map(f=>`\n\n[项目文件：${f.path}]\n${f.content}`).join('');
  task.sources ||= []; for(const file of state.contexts) if(!task.sources.includes(file.path)) task.sources.push(file.path);
  const userMessage={id:crypto.randomUUID(),role:'user',content:text,time:Date.now(),modelContent:text+attached};
  if(!retry) task.messages.push(userMessage);
  const needsTitle=task.title==='新建会话';
  if(needsTitle) task.title=text.slice(0,32);
  task.updatedAt=Date.now(); task.draft='';
  const visible=task.messages.filter(m=>(m.role==='user'||m.role==='assistant') && m.content).map(m=>({role:m.role,content:m.modelContent || m.content}));
  const messages=task.history?.length ? [...task.history,{role:'user',content:userMessage.modelContent}] : visible;
  state.run={id:runId,taskId:task.id,approvals:[],messageMap:new Map(),changedFiles:new Map(),started:Date.now()};
  state.contexts=[]; $('composerInput').value=''; $('composerInput').style.height='auto';
  renderTasks(); renderChat();$('conversation').insertAdjacentHTML('beforeend',`<div class="run-summary" data-active-run="${runId}">${icon('workflow')}<span>正在工作</span></div>`);icons();state.run.hasSummary=true;scrollBottom(true);
  try {
    await persist(task);
    const selection=window.NanoModels?.selection() || {};
    if(needsTitle) api.suggestTitle({taskId:task.id,text,selection}).then(title=>{if(title && task.title===text.slice(0,32)){task.title=title;persist(task);renderTasks();if(current()?.id===task.id)$('taskTitle').textContent=title;}}).catch(()=>{});
    const result=await api.runAgent({runId,taskId:task.id,messages,mode:task.mode || 'build',workMode:state.workMode || 'code',selection});
    if(result.history?.length) task.history=result.history;
    const last=result.history?.at(-1);const finalText=last?.role==='assistant' && !last.tool_calls?.length ? (typeof last.content==='string'?last.content:Array.isArray(last.content)?last.content.filter(part=>part.type==='text').map(part=>part.text).join(''):'') : '';
    const visibleFinal=task.messages.filter(message=>message.runId===runId && message.role==='assistant').at(-1);
    if(result.status==='success' && finalText && visibleFinal?.content!==finalText)task.messages.push({id:crypto.randomUUID(),role:'assistant',content:finalText,time:Date.now(),runId});
    if(result.status==='success' && !finalText)task.messages.push({id:crypto.randomUUID(),role:'assistant',content:'本轮已结束，模型未给出最终总结。请查看工作详情与文件变更。',time:Date.now(),runId});
    if(state.run?.id===runId) await finishRun(task,result.status || (result.ok?'success':'error'),result.error);
    await persist(task);
    if(result.status==='success' && task.queue?.length && current()?.id===task.id) { const next=task.queue.shift();state.contexts=next.contexts || [];setTimeout(()=>safely(()=>sendPrompt(next.text)),120); }
  } catch(error) { if(state.run?.id===runId) await finishRun(task,'error',error.message); }
}
async function finishRun(task,status,error) {
  const duration=state.run ? ((Date.now()-state.run.started)/1000).toFixed(1):'';
  task.lastStatus=status; task.updatedAt=Date.now();
  delete task.interruptedRun;
  const label=status==='success'?'已完成':status==='cancelled'?'已停止':`执行失败${error?' · '+error:''}`;
  const messages=task.messages.filter(m=>m.runId===state.run?.id && m.role==='assistant');
  for(const message of messages) {message.statusText=label;message.durationMs=Number(duration)*1000;}
  if(!messages.some(m=>m.content)) task.messages.push({id:crypto.randomUUID(),role:'assistant',content:status==='cancelled'?'本次执行已停止。':error || '本次执行结束，未生成文本回复。',time:Date.now(),runId:state.run?.id,statusText:label});
  task.events.push({type:'run.completed',name:'运行结束',status:label});
  state.run=null; await persist(task); renderTasks();
  if(current()?.id===task.id) { renderChat(); $('runStatus').textContent=label; }
  if(error) toast(error);
}
function handleAgentEvent(event) {
  const run=state.run; if(!run || event.runId!==run.id || event.taskId!==run.taskId) return;
  const task=state.tasks.find(t=>t.id===event.taskId); if(!task) return;
  if(event.type==='subagent.event'){
    const child=event.event;
    if(child.type==='approval.required')run.approvals.push({...child,childId:event.childId,name:`${event.name} · ${child.name}`});
    if(child.type==='approval.resolved')run.approvals=run.approvals.filter(item=>item.approvalId!==child.approvalId);
    if(child.type==='tool.started')task.messages.push({id:crypto.randomUUID(),role:'activity',runId:run.id,callId:`${event.childId}:${child.callId}`,label:`${event.name} · ${labels[child.name] || child.name}`,status:'执行中',detail:json(child.input)});
    if(child.type==='tool.completed' && child.name==='write_file' && child.output?.ok){task.changes ||= [];if(!task.changes.includes(child.output.path))task.changes.push(child.output.path);run.changedFiles.set(child.output.path,{added:child.output.added || 0,removed:child.output.removed || 0});}
    if(current()?.id===task.id){renderApprovals();renderChanges();renderHub();}return;
  }
  if(event.type==='subagent.started' || event.type==='subagent.completed'){task.messages.push({id:crypto.randomUUID(),role:'activity',runId:run.id,label:`${event.name} · ${event.type==='subagent.started'?'开始执行':event.status==='success'?'已完成':'未完成'}`,status:event.type==='subagent.started'?'执行中':'成功',detail:event.summary || event.error || ''});if(current()?.id===task.id)renderChat();return;}
  if(event.type==='reasoning.delta') {
    const key=`thinking:${event.messageId}`;let message=run.messageMap.get(key);
    if(!message){message={id:crypto.randomUUID(),role:'reasoning',content:'',runId:run.id};run.messageMap.set(key,message);task.messages.push(message);if(current()?.id===task.id){$('conversation').insertAdjacentHTML('beforeend',messageHtml(message));icons();}}
    message.content+=event.content;const node=$('conversation').querySelector(`[data-message="${message.id}"] .thinking-text`);if(node)node.textContent=message.content;
  }
  if(event.type==='usage.updated'){task.usage={inputTokens:event.inputTokens,outputTokens:event.outputTokens,totalTokens:event.totalTokens,cachedTokens:event.cachedTokens};renderContextUsage();}
  if(event.type==='tool.preparing'){
    const activity={id:crypto.randomUUID(),role:'activity',runId:run.id,preparationId:event.preparationId,label:'正在准备写入',status:'执行中'};task.messages.push(activity);
    if(current()?.id===task.id){$('conversation').insertAdjacentHTML('beforeend',messageHtml(activity));icons();scrollBottom();}
  }
  if(event.type==='message.delta') {
    const key=event.messageId || run.id;
    let message=run.messageMap.get(key);
    if(!message) {
      message={id:crypto.randomUUID(),sourceId:key,role:'assistant',content:'',time:Date.now(),runId:run.id,statusText:'正在工作…'};run.messageMap.set(key,message);task.messages.push(message);
      if(current()?.id===task.id) {
        if(!run.hasSummary){$('conversation').insertAdjacentHTML('beforeend',`<div class="run-summary">${icon('workflow')}<span>正在工作</span></div>`);run.hasSummary=true;}
        $('conversation').insertAdjacentHTML('beforeend',messageHtml(message));
        window.NanoMotion.enter($('conversation').lastElementChild,5);icons();
      }
    }
    message.content+=event.content;
    state.dirtyMessages.add(message);
    if(!state.streamFrame)state.streamFrame=requestAnimationFrame(()=>{state.streamFrame=0;for(const item of state.dirtyMessages){if(!current()?.messages.includes(item))continue;const bubble=$('conversation').querySelector(`[data-message="${item.id}"] .message-content`);if(bubble)bubble.innerHTML=markdown(item.content);}state.dirtyMessages.clear();scrollBottom();});
  }
  if(event.type==='command.output') { const item=task.events.findLast(item=>item.name==='run_command' && item.status==='执行中');if(item)item.liveOutput=((item.liveOutput || '')+event.chunk.text).slice(-50000);if(!state.activityFrame)state.activityFrame=requestAnimationFrame(()=>{state.activityFrame=0;if(current()?.id===task.id)renderActivity();});return; }
  if(event.type==='tool.started') {
    task.events.push({type:event.type,callId:event.callId,name:event.name,input:event.input,status:'执行中'});
    let activity=event.name==='write_file'?task.messages.find(item=>item.role==='activity' && item.runId===run.id && item.preparationId && !item.callId):null;
    if(activity){activity.callId=event.callId;activity.detail=json(event.input || {});}else{activity={id:crypto.randomUUID(),role:'activity',callId:event.callId,runId:run.id,label:event.name==='write_file'?'正在准备写入':labels[event.name] || event.name,status:'执行中',detail:json(event.input || {})};task.messages.push(activity);if(current()?.id===task.id){$('conversation').insertAdjacentHTML('beforeend',messageHtml(activity));icons();scrollBottom();}}
  }
  if(event.type==='tool.completed' || event.type==='tool.error') {
    const item=task.events.find(e=>e.callId===event.callId); if(item) { item.output=event.output || event.error || event.message; item.status=event.type==='tool.error' || event.output?.rejected?'未执行':event.output?.code?'执行结束（非零退出码）':'已完成'; }
    const activity=task.messages.find(m=>m.role==='activity' && m.callId===event.callId);if(activity){activity.error=event.type==='tool.error' || Boolean(event.output?.rejected) || (event.name==='run_command' && event.output?.code!==0);activity.status=activity.error?'失败':'成功';activity.label=`${labels[event.name] || event.name} · ${activity.status}`;activity.detail=[activity.detail,event.output!==undefined?json(event.output):event.error].filter(Boolean).join('\n\n').slice(0,40000);const node=$('conversation').querySelector(`[data-message="${activity.id}"]`);if(node){node.outerHTML=messageHtml(activity);icons();}}
    if(event.name==='write_file' && event.output?.ok) { const file=event.output.path || item?.input?.path; if(file && !task.changes.includes(file)) task.changes.push(file); if(file) {if(activity){activity.changedPath=file;activity.added=event.output.added || 0;activity.removed=event.output.removed || 0;}const turn=run.changedFiles.get(file) || {added:0,removed:0};turn.added+=event.output.added || 0;turn.removed+=event.output.removed || 0;run.changedFiles.set(file,turn);task.changeDetails ||= {}; const previous=task.changeDetails[file]; task.changeDetails[file]={...event.output,added:(previous?.added || 0)+(event.output.added || 0),removed:(previous?.removed || 0)+(event.output.removed || 0),patch:[previous?.patch,event.output.patch].filter(Boolean).join('\n').slice(-200000)}; } }
    if(event.name==='read_file' && event.output?.path) { task.sources ||= []; if(!task.sources.includes(event.output.path))task.sources.push(event.output.path); }
    if(event.name==='update_plan' && event.output?.plan)task.plan=event.output.plan;
  }
  if(event.type==='file.changed' && !task.changes.includes(event.path)) task.changes.push(event.path);
  if(event.type==='approval.required') run.approvals.push(event);
  if(event.type==='question.required')run.question=event;
  if(event.type==='approval.resolved') run.approvals=run.approvals.filter(a=>a.approvalId!==event.approvalId);
  if(event.type==='run.error') run.error=event.message;
  if(current()?.id===task.id && event.type!=='message.delta') { renderActivity(); renderApprovals(); renderChanges(); renderHub();renderPlan(); updateRunVisual(); }
  if(event.type==='run.completed') { run.terminalStatus=event.status; }
}
async function cancelRun() { if(!state.run) return; $('runStatus').textContent='正在停止…'; await api.cancelAgent(state.run.id); }
async function retryMessage(id) {
  if(state.run) return toast('请先停止当前运行');
  const task=current(); const index=task.messages.findIndex(m=>m.id===id);
  let userIndex=index-1; while(userIndex>=0 && task.messages[userIndex].role!=='user') userIndex--;
  if(userIndex<0) return;
  const message=task.messages[userIndex];
  // Preserve existing replies; append a fresh attempt using the prior user request.
  task.history=[]; await sendPrompt(message.content);
}
let searchSerial=0;
async function searchNow() {
  const query=$('searchInput').value.trim(), serial=++searchSerial;
  if(!query) { $('searchResults').innerHTML='<p class="empty">输入关键词开始搜索</p>'; return; }
  if($('searchScope').value==='files') {
    if(!project()) return $('searchResults').innerHTML='<p class="empty">请先选择项目目录</p>';
    const results=await api.searchProject({projectPath:project(),query}); if(serial!==searchSerial) return;
    $('searchResults').innerHTML=results.map(r=>`<button class="result-item" data-search-file="${esc(r.file)}">${esc(r.file)}:${r.line}<small>${esc(r.text)}</small></button>`).join('') || '<p class="empty">未找到匹配内容</p>';
  } else {
    const needle=query.toLowerCase(); const results=state.tasks.filter(t=>t.title.toLowerCase().includes(needle) || t.messages.some(m=>m.content.toLowerCase().includes(needle)));
    $('searchResults').innerHTML=results.map(t=>`<button class="result-item" data-task="${esc(t.id)}">${esc(t.title)}<small>${t.archived?'已归档 · ':''}${esc(t.messages.find(m=>m.content.toLowerCase().includes(needle))?.content.slice(0,120) || t.projectPath || '本地会话')}</small></button>`).join('') || '<p class="empty">未找到匹配会话</p>';
  }
}
async function screenshot() { $('refreshScreen').disabled=true; try { const result=await api.computerAction({type:'screenshot'}); $('screenPreview').innerHTML=`<img src="${result.dataUrl}" alt="当前 Windows 桌面截图">`; } finally { $('refreshScreen').disabled=false; } }
async function runCommand(event) {
  event.preventDefault(); if(!project()) return toast('请先选择项目目录'); if(state.command) return;
  const command=$('commandInput').value.trim(); if(!command) return;
  const id=crypto.randomUUID(); state.command=id; $('runCommand').disabled=true; $('stopCommand').classList.remove('hidden');
  $('terminalOutput').textContent=`PS ${project()}> ${command}\n\n执行中…`;
  try { const result=await api.runCommand({id,projectPath:project(),command}); $('terminalOutput').textContent=`PS ${project()}> ${command}\n\n${result.stdout}${result.stderr}\n\n退出代码：${result.code}${result.truncated?' · 输出已截断或超时':''}`; }
  catch(error) { $('terminalOutput').textContent+=`\n${error.message}`; }
  finally { state.command=null; $('runCommand').disabled=false; $('stopCommand').classList.add('hidden'); }
}
function bind() {
  state.scroller=window.NanoMotion.scrollController($('conversation'));
  const commands=[['new','新建会话','square-pen',()=>newTask()],['archive','归档当前会话','archive',()=>$('archiveTask').click()],['compact','压缩上下文','minimize-2',()=>$('compactTask').click()],['model','选择模型','boxes',()=>window.NanoModels?.open()],['mcp','MCP 扩展','plug',()=>{showView('settings');settingsTab('mcp');}],['plan','规划模式','list-checks',()=>{current().mode='plan';persist();updateRunVisual();}],['build','构建模式','hammer',()=>{current().mode='build';persist();updateRunVisual();}]];
  let slashResults=[],slashIndex=0;
  function renderSlash(){const match=$('composerInput').value.match(/^\/([^\s]*)$/);const menu=$('slashMenu');if(!match){menu.classList.add('hidden');return;}const q=match[1].toLowerCase();slashResults=commands.filter(c=>c[0].includes(q)||c[1].includes(q));slashIndex=Math.min(slashIndex,Math.max(0,slashResults.length-1));menu.innerHTML=slashResults.map((c,i)=>`<button type="button" role="option" data-slash="${c[0]}" class="${i===slashIndex?'active':''}">${icon(c[2])}<span>/${c[0]}</span><span>${c[1]}</span></button>`).join('') || '<div class="slash-empty">没有匹配命令</div>';menu.classList.remove('hidden');const box=$('composer').getBoundingClientRect();menu.style.left=`${box.left}px`;menu.style.width=`${box.width}px`;menu.style.bottom=`${innerHeight-box.top+8}px`;icons();}
  function executeSlash(name){const command=commands.find(c=>c[0]===name);if(!command)return;$('slashMenu').classList.add('hidden');$('composerInput').value='';if(current())current().draft='';command[3]();}
  document.addEventListener('click',e=>{ safely(async()=>{
    const button=e.target.closest('button'); if(!button) return;
    if(button.dataset.slash){executeSlash(button.dataset.slash);return;}
    if(button.dataset.view) showView(button.dataset.view);
    if(button.hasAttribute('data-home-project'))await chooseProject();
    if(button.dataset.homeMode || button.dataset.agentMode){if(state.run)return toast('请先停止运行再切换模式');current().mode=button.dataset.homeMode || button.dataset.agentMode;await persist();updateRunVisual();hidePopovers();$('composerInput').focus();}
    if(button.dataset.questionOption)await sendPrompt(button.dataset.questionOption);
    if(button.dataset.removeQueued!==undefined){current().queue.splice(Number(button.dataset.removeQueued),1);renderQueue();icons();await persist();}
    if(button.hasAttribute('data-continue-plan')){current().mode='build';await sendPrompt('继续执行工作计划中尚未完成的步骤，先检查已有成果，避免重复执行，逐步验证并更新计划。');}
    if(button.hasAttribute('data-toggle-plan')){if(state.run)return toast('运行中由智能体更新计划');$('planInput').value=(current().plan || []).map(step=>step.text).join('\n');$('planDialog').showModal();}
    if(button.dataset.inspectorTab) inspectorTab(button.dataset.inspectorTab);
    if(button.dataset.hubFile) { showView('project');await openFile(button.dataset.hubFile); }
    if(button.dataset.turnMessage) { state.scroller.pause(); const message=$('conversation').querySelector(`[data-message="${button.dataset.turnMessage}"]`); message?.scrollIntoView({block:'start',behavior:'smooth'});document.querySelectorAll('[data-turn-message]').forEach(mark=>mark.classList.toggle('active',mark===button)); }
    if(button.dataset.task) selectTask(button.dataset.task);
    if(button.dataset.pinRow){const task=state.tasks.find(t=>t.id===button.dataset.pinRow);task.pinned=!task.pinned;await persist(task);renderTasks();}
    if(button.dataset.archiveRow){const task=state.tasks.find(t=>t.id===button.dataset.archiveRow);if(state.run?.taskId===task.id)return toast('请先停止该会话');task.archived=!task.archived;await persist(task);if(task.id===state.currentId && task.archived){const next=state.tasks.find(t=>!t.archived && t.id!==task.id);if(next)selectTask(next.id);else newTask();}renderTasks();}
    if(button.dataset.workspaceMode){state.workMode=button.dataset.workspaceMode;localStorage.setItem('nano-work-mode',state.workMode);$('workspaceMenu').firstChild.textContent=state.workMode==='work'?'Work':'Code';hidePopovers();}
    if(button.dataset.window) await api.windowControl(button.dataset.window);
    if(button.dataset.suggest) { $('composerInput').value=button.dataset.suggest; $('composerInput').focus(); }
    if(button.dataset.file) await openFile(button.dataset.file);
    if(button.dataset.contextFile) { const root=project(), taskId=current()?.id; const file=await api.readProjectFile({projectPath:root,relativePath:button.dataset.contextFile}); if(taskId!==current()?.id || root!==project())return; addContext({...file,root}); $('contextDialog').close(); }
    if(button.dataset.removeContext!==undefined) { state.contexts.splice(Number(button.dataset.removeContext),1); renderContexts(); }
    if(button.dataset.searchFile) { showView('project'); await openFile(button.dataset.searchFile); }
    if(button.dataset.settingsTab) settingsTab(button.dataset.settingsTab);
    if(button.dataset.projectTab) { state.gitTab=button.dataset.projectTab==='git';state.reviewTab=button.dataset.projectTab==='review'; document.querySelectorAll('[data-project-tab]').forEach(b=>b.classList.toggle('active',b===button)); $('fileWorkspace').classList.toggle('hidden',state.gitTab || state.reviewTab); $('gitOutput').classList.toggle('hidden',!state.gitTab);$('changeReview').classList.toggle('hidden',!state.reviewTab);if(state.gitTab)await refreshGit();if(state.reviewTab)await refreshReviews(); }
    if(button.dataset.acceptChange){await api.acceptChange({taskId:current().id,id:button.dataset.acceptChange});await refreshReviews();}
    if(button.dataset.restoreChange){const result=await api.restoreChange({taskId:current().id,id:button.dataset.restoreChange});if(result.cancelled)return;await refreshReviews();const active=state.reviewRecords.filter(record=>record.status!=='restored');current().changes=[...new Set(active.map(record=>record.path))];current().changeDetails={};for(const record of active){current().changeDetails[record.path] ||= {added:0,removed:0,patch:''};const entry=current().changeDetails[record.path];entry.added+=record.added;entry.removed+=record.removed;entry.patch+=record.patch+'\n';}await persist();renderChanges();renderHub();toast('已恢复修改前的文件');}
    if(button.dataset.mcpConnect){const id=button.dataset.mcpConnect;state.mcpBusy.add(id);await renderMcp();try{await api.connectMcp(id);}finally{state.mcpBusy.delete(id);await renderMcp();}}
    if(button.dataset.mcpDisconnect){await api.disconnectMcp(button.dataset.mcpDisconnect);await renderMcp();}
    if(button.dataset.mcpRemove){if(state.run)return toast('请先停止任务');await api.disconnectMcp(button.dataset.mcpRemove);state.config=await api.saveSettings({mcpServers:(state.config.mcpServers || []).filter(server=>server.id!==button.dataset.mcpRemove)});await renderMcp();}
    if(button.dataset.permission) { if(state.run && state.run.taskId===current()?.id){const changed=await api.setPermission(state.run.id,button.dataset.permission);if(!changed)return toast('规划模式下保持只读');} state.config=await api.saveSettings({permissionMode:button.dataset.permission}); updateConfigUI(); hidePopovers(); }
    if(button.dataset.copy) { const message=current().messages.find(m=>m.id===button.dataset.copy); await navigator.clipboard.writeText(message.content); toast('已复制'); }
    if(button.dataset.retry) await retryMessage(button.dataset.retry);
    if(button.dataset.decision) { const run=state.run; if(!run) return; button.disabled=true; const pending=run.approvals.find(item=>item.approvalId===button.dataset.approval);const ok=await api.approve({runId:run.id,childId:pending?.childId,approvalId:button.dataset.approval,approved:button.dataset.decision==='approve'}); if(!ok) toast('该请求已结束'); }
  }); });
  $('toggleSidebar').onclick=()=>$('sidebar').classList.toggle('collapsed');
  $('newTask').onclick=newTask;
  $('sendButton').onclick=()=>safely(()=>state.run?.taskId===current()?.id && !$('composerInput').value.trim()?cancelRun():sendPrompt($('composerInput').value));
  $('composerInput').onkeydown=e=>{if(!$('slashMenu').classList.contains('hidden')){if(e.key==='ArrowDown' || e.key==='ArrowUp'){e.preventDefault();slashIndex=(slashIndex+(e.key==='ArrowDown'?1:-1)+slashResults.length)%Math.max(1,slashResults.length);renderSlash();return;}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();$('slashMenu').classList.add('hidden');return;}if(e.key==='Enter'&&!e.shiftKey&&slashResults.length){e.preventDefault();executeSlash(slashResults[slashIndex][0]);return;}}if(e.key==='Enter' && !e.shiftKey && !e.isComposing){e.preventDefault();safely(()=>sendPrompt(e.target.value));}};
  $('composerInput').oninput=e=>{window.NanoMotion.autosize(e.target);if(current())current().draft=e.target.value;updateRunVisual();slashIndex=0;renderSlash();};
  $('projectButton').onclick=$('chooseProject').onclick=()=>safely(chooseProject);
  $('refreshProject').onclick=()=>safely(refreshFiles);
  $('openProject').onclick=()=>safely(async()=>project()?api.openPath(project()):toast('请先选择项目'));
  $('addFilesCommand').onclick=()=>safely(async()=>{hidePopovers();await openContextDialog();});$('addPlanCommand').onclick=()=>{hidePopovers();current().mode='plan';safely(()=>persist());updateRunVisual();};$('addMcpCommand').onclick=()=>{hidePopovers();showView('settings');settingsTab('mcp');};$('addCompactCommand').onclick=()=>{$('compactTask').click();};$('closeCompactDone').onclick=()=>$('compactDone').close();$('addContext').onclick=()=>addContext(state.preview);
  $('closeContext').onclick=()=>$('contextDialog').close(); $('contextFilter').oninput=renderContextList;
  $('toggleActivity').onclick=()=>{$('activityPanel').classList.remove('hidden');inspectorTab('activity');};
  $('toggleInspector').onclick=()=>{$('activityPanel').classList.toggle('hidden');localStorage.setItem('nano-inspector',$('activityPanel').classList.contains('hidden')?'closed':'open');inspectorTab('files');renderHub();icons();};
  $('closeActivity').onclick=()=>{$('activityPanel').classList.add('hidden');localStorage.setItem('nano-inspector','closed');};
  $('viewChanges').onclick=()=>{showView('project');document.querySelector('[data-project-tab="review"]').click();};
  $('addSource').onclick=()=>safely(openContextDialog);
  $('jumpBottom').onclick=()=>scrollBottom(true);
  $('conversation').addEventListener('scroll',()=>{const el=$('conversation');$('jumpBottom').classList.toggle('hidden',el.scrollHeight-el.scrollTop-el.clientHeight<160);});
  new ResizeObserver(()=>{const area=document.querySelector('.composer-area');$('chatView').style.setProperty('--composer-height',`${area.offsetHeight}px`);$('chatView').style.setProperty('--composer-input-height',`${$('composer').offsetHeight+17}px`);scrollBottom();}).observe(document.querySelector('.composer-area'));
  $('changePill').onclick=()=>{showView('project');document.querySelector('[data-project-tab="review"]').click();};
  $('renameTask').onclick=()=>{hidePopovers();$('renameInput').value=current().title;$('renameDialog').showModal();};
  $('cancelRename').onclick=()=>$('renameDialog').close();
  $('cancelPlan').onclick=()=>$('planDialog').close();
  $('planForm').onsubmit=event=>{event.preventDefault();safely(async()=>{const old=current().plan || [];current().plan=$('planInput').value.split('\n').map(text=>text.trim()).filter(Boolean).slice(0,30).map(text=>({text,status:old.find(step=>step.text===text)?.status || 'pending'}));await persist();$('planDialog').close();renderPlan();icons();});};
  $('renameForm').onsubmit=e=>{e.preventDefault();safely(async()=>{current().title=$('renameInput').value.trim() || '未命名会话';await persist();$('renameDialog').close();renderTasks();$('taskTitle').textContent=current().title;});};
  $('pinTask').onclick=()=>safely(async()=>{current().pinned=!current().pinned;await persist();renderTasks();hidePopovers();});
  $('archiveTask').onclick=()=>safely(async()=>{const task=current();if(state.run?.taskId===task.id)return toast('请先停止当前任务');task.archived=!task.archived;await persist(task);hidePopovers();if(task.archived){const next=state.tasks.find(t=>!t.archived && t.id!==task.id);if(next)selectTask(next.id);else newTask();}renderTasks();toast(task.archived?'会话已归档':'会话已恢复');});
  $('exportTask').onclick=()=>safely(async()=>{hidePopovers();if(await api.exportTask(current()))toast('已导出 Markdown');});
  $('compactTask').onclick=()=>safely(async()=>{hidePopovers();if(state.run)return toast('请先等待当前任务结束');const task=current();if(!task.messages.some(m=>m.role==='user'||m.role==='assistant'))return toast('当前会话没有可压缩的内容');const message={id:crypto.randomUUID(),role:'compact',label:'正在压缩上下文',status:'执行中',time:Date.now()};task.messages.push(message);renderChat();scrollBottom(true);try{const result=await api.compactTask(task.id);task.summary=result.summary;task.history=result.history;message.label='上下文已压缩';message.status='已完成';await persist(task);if(current()?.id===task.id){renderChat();renderHub();}}catch(error){message.label=`压缩失败：${error.message}`;message.status='失败';await persist(task);if(current()?.id===task.id)renderChat();throw error;}});
  $('backToChat').onclick=()=>showView('chat');
  $('modelButton').onclick=()=>window.NanoModels?.open();
  $('settingsForm').onsubmit=e=>safely(()=>saveSettings(e));
  $('testConnection').onclick=()=>safely(async()=>{const button=$('testConnection');button.disabled=true;$('connectionResult').textContent='正在连接…';try{const r=await api.testConnection(settingsPayload());$('connectionResult').textContent=r.message;}catch(error){$('connectionResult').textContent=error.message;}finally{button.disabled=false;}});
  for(const id of ['themeInput','fontSizeInput'])$(id).onchange=()=>applyAppearance({theme:$('themeInput').value,fontSize:Number($('fontSizeInput').value)});
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>applyAppearance(state.config));
  matchMedia('(max-width:1000px)').addEventListener('change',event=>{if(event.matches)$('activityPanel').classList.add('hidden');});
  $('providerInput').onchange=()=>{$('connectionResult').textContent='';};
  $('mcpTypeInput').onchange=()=>{const http=$('mcpTypeInput').value==='http';$('mcpCommandLabel').classList.toggle('hidden',http);$('mcpArgsLabel').classList.toggle('hidden',http);$('mcpUrlLabel').classList.toggle('hidden',!http);};
  $('addMcp').onclick=()=>safely(async()=>{if(state.run)return toast('请先停止任务');const type=$('mcpTypeInput').value,name=$('mcpNameInput').value.trim();if(!name)throw new Error('请输入扩展名称');let args=[],env={};try{args=JSON.parse($('mcpArgsInput').value || '[]');env=JSON.parse($('mcpEnvInput').value || '{}');}catch{throw new Error('参数和环境变量需要合法 JSON');}if(!Array.isArray(args) || args.some(arg=>typeof arg!=='string'))throw new Error('参数应为字符串数组');if(!env || Array.isArray(env) || typeof env!=='object' || Object.values(env).some(value=>typeof value!=='string'))throw new Error('环境变量应为字符串键值对象');const server={id:crypto.randomUUID(),name,type,args,env,readOnly:$('mcpReadOnlyInput').checked};if(type==='stdio'){server.command=$('mcpCommandInput').value.trim();if(!server.command)throw new Error('请输入启动命令');}else{server.url=$('mcpUrlInput').value.trim();const url=new URL(server.url);if(!['http:','https:'].includes(url.protocol))throw new Error('服务地址必须使用 HTTP 或 HTTPS');}state.config=await api.saveSettings({mcpServers:[...(state.config.mcpServers || []),server]});$('mcpNameInput').value='';$('mcpEnvInput').value='';await renderMcp();toast('扩展已保存，点击连接后启用');});
  $('searchInput').oninput=()=>{clearTimeout(searchNow.timer);searchNow.timer=setTimeout(()=>safely(searchNow),220);}; $('searchScope').onchange=()=>safely(searchNow);
  $('refreshScreen').onclick=()=>safely(screenshot);
  $('refreshWindows').onclick=()=>safely(async()=>{const windows=await api.listWindows();$('windowList').innerHTML=windows.map(w=>`<div class="window-row"><span>${esc(w.MainWindowTitle)}</span><small>${esc(w.ProcessName)} · ${w.Id}</small></div>`).join('') || '<p class="empty">没有活动窗口</p>';});
  $('desktopForm').onsubmit=e=>{e.preventDefault();safely(async()=>{const type=$('desktopType').value;const r=await api.computerAction({type,x:Number($('desktopX').value),y:Number($('desktopY').value),text:$('desktopText').value,keys:$('desktopText').value.split(',').map(k=>k.trim()),amount:Number($('desktopAmount').value)});if(!r.cancelled)await screenshot();});};
  $('commandForm').onsubmit=e=>safely(()=>runCommand(e)); $('stopCommand').onclick=()=>safely(()=>api.cancelCommand(state.command));
  $('openData').onclick=()=>safely(()=>api.openPath(state.dataPath)); $('viewArchived').onclick=()=>{state.archived=true;renderTasks();showView('chat');};
  document.addEventListener('keydown',e=>{if(e.ctrlKey && e.key.toLowerCase()==='n'){e.preventDefault();newTask();}if(e.ctrlKey && e.key.toLowerCase()==='k'){e.preventDefault();showView('search');}if(e.ctrlKey && e.key===','){e.preventDefault();showView('settings');}if(e.key==='Escape' && state.run && !document.querySelector('dialog[open]'))safely(cancelRun);});
  document.addEventListener('click',e=>{const link=e.target.closest('.message-content a');if(link){e.preventDefault();safely(()=>api.openExternal(link.href));}});
  setInterval(()=>{if(state.run){const task=state.tasks.find(t=>t.id===state.run.taskId);task.interruptedRun=state.run.id;safely(()=>persist(task));return;}if(!current())return;const task=current();if(task.draft!==task.savedDraft){task.savedDraft=task.draft;safely(()=>persist(task));}},2000);
}
async function init() {
  icons(); if(!api) { $('conversation').innerHTML='<p class="empty">请通过 npm start 启动 Nano 桌面应用。</p>';return; }
  const [tasks,config,info]=await Promise.all([api.listTasks(),api.loadSettings(),api.appInfo()]);
  state.tasks=tasks;state.config=config;state.dataPath=info.dataPath;state.defaultProject=info.defaultProject;state.workMode=localStorage.getItem('nano-work-mode') || 'code';$('workspaceMenu').firstChild.textContent=state.workMode==='work'?'Work':'Code';$('dataPath').textContent=info.dataPath;
  for(const task of tasks) { task.events ||= []; task.changes ||= []; task.history ||= [];if(!task.projectPath){task.projectPath=state.defaultProject;await persist(task);} if(task.interruptedRun){task.lastStatus='cancelled';task.messages.push({id:crypto.randomUUID(),role:'assistant',content:'上次运行因应用关闭而中断。已保留对话，你可以重新发送请求继续；未完成的操作不会自动重放。',time:Date.now(),statusText:'运行已中断'});delete task.interruptedRun;await persist(task);} }
  await window.NanoModels.init({api,toast,icons,showView,onSelect:()=>renderContextUsage(),getConfig:()=>state.config});
  window.NanoSidePanel.init({api,getTask:current,toast,icons,startSideAgent:payload=>api.sideAgentRun({...payload,selection:window.NanoModels.selection()}),onSideAgentHistory:async(id,history)=>{const task=state.tasks.find(item=>item.id===id);if(task){task.sideAgentHistory=history;await persist(task);}},onSideChatUpdate:async(taskId,history)=>{const item=state.tasks.find(task=>task.id===taskId);if(item){item.sideChat=history;await persist(item);}}});
  bind();api.onAgentEvent(handleAgentEvent);api.onCommandOutput(event=>{if(event.id!==state.command)return;const output=$('terminalOutput');if(output.textContent.endsWith('执行中…'))output.textContent=output.textContent.slice(0,-4);output.textContent+=event.text;output.scrollTop=output.scrollHeight;});updateConfigUI();
  // Migrate legacy settings once; remove the plaintext browser copy only after successful encrypted save.
  const legacy=localStorage.getItem('nano-config');
  if(legacy && !config.hasApiKey){try{const old=JSON.parse(legacy);if(old.apiKey){state.config=await api.saveSettings(old);updateConfigUI();}localStorage.removeItem('nano-config');}catch{toast('旧设置迁移失败，原配置已保留');}}
  if(state.tasks.length) {state.currentId=state.tasks.find(t=>!t.archived)?.id || state.tasks[0].id;renderChat();renderTasks();} else newTask();
  if(innerWidth>=1200 && localStorage.getItem('nano-inspector')!=='closed'){$('activityPanel').classList.remove('hidden');inspectorTab('files');}
}
init().catch(error=>toast(`启动失败：${error.message}`));

