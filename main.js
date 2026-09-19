const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { execFile } = require('node:child_process');

let mainWindow;

function projectPathOrThrow(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') throw new Error('未选择项目目录');
  return path.resolve(projectPath);
}

function isIgnored(name) {
  return new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'target']).has(name);
}

async function walkFiles(root, current = root, result = []) {
  if (result.length >= 500) return result;
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (isIgnored(entry.name)) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) await walkFiles(root, absolute, result);
    else result.push(path.relative(root, absolute));
    if (result.length >= 500) break;
  }
  return result;
}

async function projectFiles(projectPath) {
  const root = projectPathOrThrow(projectPath);
  const files = await walkFiles(root);
  return { root, files };
}

function safeProjectFile(projectPath, relativePath) {
  const root = projectPathOrThrow(projectPath);
  const target = path.resolve(root, relativePath || '');
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('路径超出项目目录范围');
  return { root, target };
}

async function searchProject(projectPath, query) {
  const root = projectPathOrThrow(projectPath);
  const files = await walkFiles(root);
  const results = [];
  for (const relative of files) {
    if (results.length >= 100) break;
    const absolute = path.join(root, relative);
    try {
      const content = await fs.readFile(absolute, 'utf8');
      const lines = content.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (results.length < 100 && line.toLowerCase().includes(String(query || '').toLowerCase())) results.push({ file: relative, line: index + 1, text: line.trim().slice(0, 240) });
      });
    } catch { /* binary or unreadable file */ }
  }
  return results;
}

function runCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { cwd: projectPathOrThrow(cwd), windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 120000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr.trim() || stdout.trim() || error.message));
      resolve({ stdout, stderr, code: 0 });
    });
  });
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr.trim() || error.message));
        resolve(stdout.trim());
      });
  });
}

async function takeScreenshot() {
  const output = path.join(os.tmpdir(), 'nano-agent-screen.png');
  const escaped = output.replace(/'/g, "''");
  const script = `
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
$bitmap.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose(); $bitmap.Dispose()
Write-Output '${escaped}'
`;
  await runPowerShell(script);
  const data = await fs.readFile(output);
  return { path: output, dataUrl: `data:image/png;base64,${data.toString('base64')}` };
}

async function computerAction(action) {
  const type = action?.type;
  if (type === 'screenshot') return takeScreenshot();

  const x = Number.isFinite(action?.x) ? Math.round(action.x) : 0;
  const y = Number.isFinite(action?.y) ? Math.round(action.y) : 0;
  const buttonMap = { left: 0x0002 | 0x0004, right: 0x0008 | 0x0010, middle: 0x0020 | 0x0040 };
  const button = buttonMap[action?.button || 'left'] || buttonMap.left;
  const keyMap = { ENTER: 0x0D, ESC: 0x1B, TAB: 0x09, CTRL: 0x11, SHIFT: 0x10, ALT: 0x12, BACKSPACE: 0x08, DELETE: 0x2E, SPACE: 0x20 };
  const keys = (action?.keys || []).map((key) => keyMap[String(key).toUpperCase()] || String(key).charCodeAt(0)).filter(Boolean);
  const text = String(action?.text || '').replace(/'/g, "''");

  let body = '';
  if (type === 'mouse_move') {
    body = `[Win32]::SetCursorPos(${x}, ${y}) | Out-Null`;
  } else if (type === 'mouse_click') {
    body = `[Win32]::SetCursorPos(${x}, ${y}) | Out-Null; [Win32]::mouse_event(${button}, 0, 0, 0, 0)`;
  } else if (type === 'scroll') {
    const amount = Math.round(Number(action.amount || 1) * 120);
    body = `[Win32]::mouse_event(0x0800, 0, 0, ${amount}, 0)`;
  } else if (type === 'key_press') {
    body = keys.map((code) => `[Win32]::keybd_event(${code}, 0, 0, 0); [Win32]::keybd_event(${code}, 0, 2, 0)`).join(';');
  } else if (type === 'type') {
    body = `Set-Clipboard -Value '${text}'; [Win32]::keybd_event(0x11,0,0,0); [Win32]::keybd_event(0x56,0,0,0); [Win32]::keybd_event(0x56,0,2,0); [Win32]::keybd_event(0x11,0,2,0)`;
  } else {
    throw new Error(`Unsupported computer action: ${type}`);
  }

  const script = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Win32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extraInfo);
}
'@
${body}
Write-Output 'ok'
`;
  await runPowerShell(script);
  return { ok: true, type };
}

async function listWindows() {
  const script = `Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Trim() } | Select-Object Id, ProcessName, MainWindowTitle | ConvertTo-Json -Compress`;
  const output = await runPowerShell(script);
  if (!output) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1300,
    height: 840,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#00000000',
    transparent: true,
    hasShadow: true,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

const AGENT_TOOLS = [
  { type: 'function', function: { name: 'list_files', description: '列出项目目录中的文件。', parameters: { type: 'object', properties: { depth: { type: 'number', description: '最大递归深度，默认 3。' } } } } },
  { type: 'function', function: { name: 'read_file', description: '读取项目中的一个文本文件。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'search_text', description: '在项目文件中搜索文本。', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'write_file', description: '创建或修改项目文件。执行前必须确认用户授权。', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'run_command', description: '在项目目录执行 PowerShell 命令。执行前必须确认用户授权。', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'computer_screenshot', description: '获取当前 Windows 屏幕截图，用于观察界面。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'computer_windows', description: '获取当前桌面窗口列表。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'computer_action', description: '执行鼠标、键盘或滚轮动作。执行前必须确认用户授权。', parameters: { type: 'object', properties: { type: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string' }, text: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } }, amount: { type: 'number' } }, required: ['type'] } } }
];

async function callProvider(config, messages, tools = AGENT_TOOLS) {
  if (!config?.apiKey || !config?.model) {
    return { text: '演示模式已启用。请在设置中配置 API Base URL、API Key 和模型，即可连接真实模型。当前界面、任务流和电脑操控基础能力已经可用。', toolCalls: [] };
  }
  const provider = config.provider || 'openai';
  const baseUrl = (config.baseUrl || (provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')).replace(/\/$/, '');
  let url;
  let headers;
  let body;
  if (provider === 'anthropic') {
    url = `${baseUrl}/v1/messages`;
    headers = { 'content-type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' };
    const system = messages.find((message) => message.role === 'system')?.content;
    body = { model: config.model, max_tokens: config.maxOutputTokens || 4096, system, messages: messages.filter((message) => message.role !== 'system'), tools: tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })) };
  } else {
    url = `${baseUrl}/chat/completions`;
    headers = { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` };
    body = { model: config.model, messages, tools, tool_choice: 'auto', stream: false, temperature: config.temperature ?? 0.2 };
  }
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${raw.slice(0, 500)}`);
  const data = JSON.parse(raw);
  if (provider === 'anthropic') {
    return { text: data.content?.filter((item) => item.type === 'text').map((item) => item.text || '').join('') || '', toolCalls: data.content?.filter((item) => item.type === 'tool_use').map((item) => ({ id: item.id, name: item.name, input: item.input, raw: item })) || [], assistantContent: data.content || [] };
  }
  const message = data.choices?.[0]?.message || {};
  return { text: message.content || '', toolCalls: (message.tool_calls || []).map((call) => ({ id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments || '{}'), raw: call })), assistantMessage: message };
}

async function executeAgentTool(name, input, payload) {
  const projectPath = payload.projectPath;
  if (name === 'list_files') return projectFiles(projectPath);
  if (name === 'read_file') return projectReadFile(projectPath, input.path);
  if (name === 'search_text') return searchProject(projectPath, input.query);
  if (name === 'write_file') return projectWriteFile(projectPath, input.path, input.content);
  if (name === 'run_command') return runCommand(input.command, projectPath);
  if (name === 'computer_screenshot') { const result = await takeScreenshot(); return { path: result.path, note: '截图已生成；支持视觉输入的模型可以继续分析截图。' }; }
  if (name === 'computer_windows') return listWindows();
  if (name === 'computer_action') return computerAction(input);
  throw new Error(`未知工具：${name}`);
}

async function projectReadFile(projectPath, relativePath) {
  const { target } = safeProjectFile(projectPath, relativePath);
  return { path: relativePath, content: await fs.readFile(target, 'utf8') };
}

async function projectWriteFile(projectPath, relativePath, content) {
  const { target } = safeProjectFile(projectPath, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, String(content || ''), 'utf8');
  return { ok: true, path: relativePath };
}

async function runAgentLoop(event, payload) {
  const messages = [...payload.messages];
  for (let step = 0; step < 8; step += 1) {
    const response = await callProvider(payload.config, messages);
    if (response.text) {
      for (const chunk of response.text.match(/.{1,18}/gs) || [response.text]) {
        event.sender.send('agent:event', { type: 'message.delta', content: chunk });
        await new Promise((resolve) => setTimeout(resolve, 14));
      }
    }
    if (!response.toolCalls.length) return;

    if (payload.config?.provider === 'anthropic') {
      messages.push({ role: 'assistant', content: response.assistantContent });
    } else {
      messages.push({ role: 'assistant', content: response.assistantMessage.content || null, tool_calls: response.assistantMessage.tool_calls });
    }

    for (const toolCall of response.toolCalls) {
      event.sender.send('agent:event', { type: 'tool.started', callId: toolCall.id, name: toolCall.name, input: toolCall.input });
      const protectedTool = new Set(['write_file', 'run_command', 'computer_action']).has(toolCall.name);
      if (protectedTool && payload.permissionMode !== 'full') {
        event.sender.send('agent:event', { type: 'approval.required', approvalId: toolCall.id, reason: `工具 ${toolCall.name} 需要完全访问权限` });
        return;
      }
      let result;
      try {
        result = await executeAgentTool(toolCall.name, toolCall.input || {}, payload);
      } catch (error) {
        result = { error: error.message };
      }
      event.sender.send('agent:event', { type: 'tool.completed', callId: toolCall.id, name: toolCall.name, output: result });
      if (toolCall.name === 'write_file' && result.path) event.sender.send('agent:event', { type: 'file.changed', path: result.path });
      if (payload.config?.provider === 'anthropic') {
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolCall.id, content: JSON.stringify(result) }] });
      } else {
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) });
      }
    }
  }
  throw new Error('智能体工具循环超过最大步骤数');
}

ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, displays: screen.getAllDisplays().length }));
ipcMain.handle('window:control', (_event, action) => {
  if (!mainWindow) return;
  if (action === 'minimize') mainWindow.minimize();
  if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
  if (action === 'close') mainWindow.close();
});
ipcMain.handle('project:choose', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('project:files', (_event, projectPath) => projectFiles(projectPath));
ipcMain.handle('project:read', async (_event, payload) => {
  const { target } = safeProjectFile(payload.projectPath, payload.relativePath);
  return { path: payload.relativePath, content: await fs.readFile(target, 'utf8') };
});
ipcMain.handle('project:search', (_event, payload) => searchProject(payload.projectPath, payload.query));
ipcMain.handle('project:write', async (_event, payload) => {
  const { target } = safeProjectFile(payload.projectPath, payload.relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, String(payload.content || ''), 'utf8');
  return { ok: true, path: payload.relativePath };
});
ipcMain.handle('shell:run', (_event, payload) => runCommand(payload.command, payload.projectPath));
ipcMain.handle('shell:open', (_event, target) => shell.openPath(target));
ipcMain.handle('computer:action', (_event, action) => computerAction(action));
ipcMain.handle('computer:windows', () => listWindows());
ipcMain.handle('agent:run', async (event, payload) => {
  try {
    event.sender.send('agent:event', { type: 'run.started' });
    await runAgentLoop(event, payload);
    event.sender.send('agent:event', { type: 'run.completed', status: 'success' });
    return { ok: true };
  } catch (error) {
    event.sender.send('agent:event', { type: 'run.error', message: error.message });
    return { ok: false, error: error.message };
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
