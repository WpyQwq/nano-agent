'use strict';

const { WebContentsView, session, dialog } = require('electron');
const crypto = require('node:crypto');
const workspace = require('./workspace');

function hash(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }
function parseUrl(value) {
  let text = String(value || '').trim();
  if (!text) throw new Error('请输入网址');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  const url = new URL(text);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 HTTP 和 HTTPS 网页');
  if (url.username || url.password) throw new Error('网址中不能包含账户或密码');
  return url.href;
}

// Install once after app.whenReady(). The caller provides the active window and
// project authorizer used by the rest of the app; no renderer-supplied root is trusted.
function registerSidepanel({ ipcMain, getWindow, authorizedRoot, getCheckpoints, getSettings }) {
  let view = null;
  let owner = null;
  let browserSession = null;
  let pendingBounds = null;
  function assertOwner(event) {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents) throw new Error('无效的窗口');
    return window;
  }
  function notify() {
    if (!owner || owner.isDestroyed() || !view || view.webContents.isDestroyed()) return;
    const contents = view.webContents;
    owner.webContents.send('side:browser-state', {
      url: contents.getURL(), title: contents.getTitle(), loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward()
    });
  }
  function hide() { if (view && !view.webContents.isDestroyed()) view.setVisible(false); }
  function dispose() {
    if (!view) return;
    try { if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(view); } catch {}
    if (!view.webContents.isDestroyed()) view.webContents.close();
    view = null; owner = null;
  }
  function ensure(window) {
    if (view && owner === window && !view.webContents.isDestroyed()) return view;
    dispose(); owner = window;
    browserSession ||= session.fromPartition('nano-side-browser', { cache: true });
    browserSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.on('will-download', event => event.preventDefault());
    view = new WebContentsView({ webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false } });
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guard = (event, target) => { try { parseUrl(target); } catch { event.preventDefault(); } };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    for (const name of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) contents.on(name, notify);
    contents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
      if (mainFrame && code !== -3 && owner && !owner.isDestroyed()) owner.webContents.send('side:browser-error', { code, message: description, url });
    });
    window.contentView.addChildView(view);
    view.setVisible(false);
    window.once('closed', dispose);
    return view;
  }
  ipcMain.handle('side:browser-open', async (event, value) => {
    const window = assertOwner(event);
    const url = parseUrl(value);
    const browser = ensure(window);
    if (pendingBounds) browser.setBounds(pendingBounds);
    browser.setVisible(Boolean(pendingBounds));
    await browser.webContents.loadURL(url);
    notify(); return { ok: true };
  });
  ipcMain.handle('side:browser-bounds', (event, bounds) => {
    const window = assertOwner(event);
    if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]))) throw new Error('无效的浏览器尺寸');
    const [width, height] = window.getContentSize();
    const x = Math.max(0, Math.min(width, Math.round(bounds.x)));
    const y = Math.max(0, Math.min(height, Math.round(bounds.y)));
    const w = Math.max(0, Math.min(width - x, Math.round(bounds.width)));
    const h = Math.max(0, Math.min(height - y, Math.round(bounds.height)));
    pendingBounds = w && h ? { x, y, width: w, height: h } : null;
    if (view && !view.webContents.isDestroyed()) { if (pendingBounds) view.setBounds(pendingBounds); view.setVisible(Boolean(pendingBounds)); }
    return { ok: true };
  });
  ipcMain.handle('side:browser-action', (event, action) => {
    assertOwner(event);
    if (action === 'hide') { hide(); pendingBounds = null; return true; }
    if (action === 'close') { dispose(); pendingBounds = null; return true; }
    if (!view || view.webContents.isDestroyed()) return false;
    const contents = view.webContents;
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (action === 'reload') contents.reload();
    else if (!['back', 'forward', 'reload'].includes(action)) throw new Error('不支持的浏览器操作');
    return true;
  });
  ipcMain.handle('side:save-file', async (event, payload) => {
    const window = assertOwner(event);
    const projectPath = authorizedRoot(payload.projectPath);
    if (getSettings && (await getSettings()).permissionMode === 'read') throw new Error('仅观察模式不允许修改文件');
    const current = await workspace.readFile(projectPath, payload.path);
    if (hash(current.content) !== payload.expectedHash) throw new Error('文件已被其他操作修改，请重新打开后再保存');
    const answer = await dialog.showMessageBox(window, { type: 'question', message: `保存 ${payload.path}？`, buttons: ['取消', '保存'], defaultId: 0, cancelId: 0 });
    if (answer.response !== 1) return { cancelled: true };
    // Recheck after the dialog, immediately before writing.
    if (hash((await workspace.readFile(projectPath, payload.path)).content) !== payload.expectedHash) throw new Error('文件已被其他操作修改，请重新打开后再保存');
    const result = await getCheckpoints().write({ taskId: payload.taskId, projectPath, path: payload.path, content: payload.content });
    return { ...result, hash: hash(payload.content) };
  });
  ipcMain.handle('side:file-hash', async (event, payload) => {
    assertOwner(event);
    const result = await workspace.readFile(authorizedRoot(payload.projectPath), payload.path);
    return { ...result, hash: hash(result.content) };
  });
  return { dispose, hide };
}
module.exports = { registerSidepanel, parseUrl, hash };
