'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const path = require('node:path');
const EventEmitter = require('node:events');

class FakeContents extends EventEmitter {
  constructor() { super(); this.navigationHistory = { canGoBack: () => false, canGoForward: () => false }; this.url = ''; }
  isDestroyed() { return false; } setWindowOpenHandler(handler) { this.openHandler = handler; }
  loadURL(url) { this.url = url; return Promise.resolve(); } getURL() { return this.url; } getTitle() { return ''; } isLoading() { return false; } close() {} reload() {}
}
class FakeView { constructor(options) { this.options = options; this.webContents = new FakeContents(); } setBounds(bounds) { this.bounds = bounds; } setVisible(visible) { this.visible = visible; } }
class FakeSession extends EventEmitter { setPermissionRequestHandler(handler) { this.permission = handler; } setPermissionCheckHandler(handler) { this.permissionCheck = handler; } }
const fakeSession = new FakeSession();
const electron = { WebContentsView: FakeView, session: { fromPartition: () => fakeSession }, dialog: { showMessageBox: async () => ({ response: 1 }) } };
const originalLoad = Module._load;
Module._load = function(request, ...rest) { if (request === 'electron') return electron; return originalLoad.call(this, request, ...rest); };
const { registerSidepanel, parseUrl, hash } = require('../backend/sidepanel');
Module._load = originalLoad;

test('browser permits only HTTP and HTTPS without URL credentials', () => {
  assert.equal(parseUrl('example.org/path'), 'https://example.org/path');
  assert.throws(() => parseUrl('file:///C:/secret'), /HTTP/);
  assert.throws(() => parseUrl('https://user:pass@example.org'), /账户/);
  assert.throws(() => parseUrl('javascript://example.org'), /HTTP/);
});

test('isolated browser blocks popups and clamps bounds to its owner window', async () => {
  const handlers = {}; const sender = { send() {} }; const window = new EventEmitter();
  window.webContents = sender; window.isDestroyed = () => false; window.getContentSize = () => [800, 600];
  let view; window.contentView = { addChildView(value) { view = value; }, removeChildView() {} };
  registerSidepanel({ ipcMain: { handle(name, handler) { handlers[name] = handler; } }, getWindow: () => window, authorizedRoot: value => value, getCheckpoints: () => ({}) });
  await handlers['side:browser-bounds']({ sender }, { x: 700, y: 500, width: 400, height: 300 });
  await handlers['side:browser-open']({ sender }, 'https://example.org');
  assert.deepEqual(view.bounds, { x: 700, y: 500, width: 100, height: 100 });
  assert.equal(view.options.webPreferences.nodeIntegration, false); assert.equal(view.options.webPreferences.sandbox, true);
  assert.equal(view.webContents.openHandler().action, 'deny'); assert.equal(fakeSession.permissionCheck(), false);
  let blocked = false; view.webContents.emit('will-navigate', { preventDefault() { blocked = true; } }, 'file:///C:/secret'); assert.equal(blocked, true);
  assert.throws(() => handlers['side:browser-action']({ sender: {} }, 'hide'), /窗口/);
});

test('manual editor checks for external modifications and writes through checkpoints', async () => {
  const root = path.join('E:/Nano-QA', `side-test-${Date.now()}`); await fs.mkdir(root, { recursive: true }); await fs.writeFile(path.join(root, 'file.txt'), 'before');
  const handlers = {}, sender = {}, window = { webContents: sender, isDestroyed: () => false };
  const writes = []; registerSidepanel({ ipcMain: { handle(name, handler) { handlers[name] = handler; } }, getWindow: () => window, authorizedRoot: value => { assert.equal(value, root); return value; }, getCheckpoints: () => ({ write: async payload => { writes.push(payload); await fs.writeFile(path.join(root, payload.path), payload.content); return { ok: true, path: payload.path }; } }) });
  const read = await handlers['side:file-hash']({ sender }, { projectPath: root, path: 'file.txt' }); assert.equal(read.hash, hash('before'));
  await fs.writeFile(path.join(root, 'file.txt'), 'changed');
  await assert.rejects(handlers['side:save-file']({ sender }, { taskId: 't', projectPath: root, path: 'file.txt', expectedHash: read.hash, content: 'new' }), /其他操作修改/);
  assert.equal(writes.length, 0);
  await handlers['side:save-file']({ sender }, { taskId: 't', projectPath: root, path: 'file.txt', expectedHash: hash('changed'), content: 'new' });
  assert.equal(writes.length, 1); assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'new');
  await assert.rejects(handlers['side:file-hash']({ sender }, { projectPath: root, path: '../outside.txt' }), /项目范围/);
});

test('read-only mode prevents manual file editing', async () => {
  const handlers = {}, sender = {}, window = { webContents: sender, isDestroyed: () => false };
  registerSidepanel({ ipcMain: { handle(name, handler) { handlers[name] = handler; } }, getWindow: () => window, authorizedRoot: value => value, getCheckpoints: () => ({}), getSettings: async () => ({ permissionMode: 'read' }) });
  await assert.rejects(handlers['side:save-file']({ sender }, { projectPath: 'E:/Nano-QA', path: 'anything', content: 'x' }), /仅观察/);
});
