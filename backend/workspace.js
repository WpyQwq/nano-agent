const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const ignored = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'target', '.nano']);
async function resolveFile(projectPath, relative = '.', writing = false) {
  if (!projectPath) throw new Error('请先选择项目目录');
  const root = await fs.realpath(projectPath);
  if (root.split(path.sep).some(part => part.toLowerCase() === '.nano')) throw new Error('不能将智能体数据目录作为项目目录');
  const target = path.resolve(root, relative);
  const inside = (candidate) => { const rel = path.relative(root, candidate); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
  if (!inside(target)) throw new Error('路径超出项目范围');
  if (path.relative(root, target).split(path.sep).some(part => part.toLowerCase() === '.nano')) throw new Error('本地智能体数据目录不可作为项目文件访问');
  let current = target;
  while (true) {
    // lstat sees a dangling link even when realpath cannot resolve its target.
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('不允许通过符号链接读写项目文件'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { if (!inside(await fs.realpath(current))) throw new Error('符号链接指向项目之外'); break; }
    catch (error) { if (error.code !== 'ENOENT' || !writing) throw error; current = path.dirname(current); }
  }
  return { root, target };
}
async function listFiles(projectPath) {
  const { root } = await resolveFile(projectPath);
  const files = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name) || entry.isSymbolicLink()) continue;
      if (files.length >= 500) return;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(target); else files.push(path.relative(root, target));
    }
  }
  await walk(root);
  return { root, files, truncated: files.length >= 500 };
}
async function readFile(projectPath, relativePath) {
  const { target } = await resolveFile(projectPath, relativePath);
  if ((await fs.stat(target)).size > 1024 * 1024) throw new Error('文件超过 1 MB，请选择较小的文本文件');
  const content = await fs.readFile(target, 'utf8');
  if (content.includes('\0')) throw new Error('不支持预览二进制文件');
  return { path: relativePath, content };
}
async function writeFile(projectPath, relativePath, content) {
  const { target } = await resolveFile(projectPath, relativePath, true);
  if (String(content).length > 1024 * 1024) throw new Error('单次写入不能超过 1 MB');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, String(content), 'utf8');
  return { ok: true, path: relativePath };
}
async function search(projectPath, query) {
  if (!String(query).trim()) return [];
  const { files } = await listFiles(projectPath);
  const results = [];
  for (const file of files) {
    try {
      const { content } = await readFile(projectPath, file);
      content.split(/\r?\n/).forEach((line, index) => {
        if (results.length < 100 && line.toLowerCase().includes(query.toLowerCase())) results.push({ file, line: index + 1, text: line.trim().slice(0, 240) });
      });
    } catch { /* Skip oversized, binary and unreadable files. */ }
    if (results.length >= 100) break;
  }
  return results;
}
async function runCommand(command, projectPath, { signal, onOutput } = {}) {
  const { root } = await resolveFile(projectPath);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', overflow = false;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); ${command}`], { cwd: root, windowsHide: true });
    const stop = () => { if (child.pid) execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); };
    const timeout = setTimeout(() => { overflow = true; stderr += '\n命令超过 120 秒'; stop(); }, 120000);
    const consume = (key, chunk) => {
      if (key === 'stdout') stdout += chunk; else stderr += chunk;
      if (stdout.length + stderr.length <= 1024 * 1024) onOutput?.({ stream: key, text: chunk.toString('utf8') });
      if (stdout.length + stderr.length > 1024 * 1024) { overflow = true; stop(); }
    };
    child.stdout.on('data', (c) => consume('stdout', c)); child.stderr.on('data', (c) => consume('stderr', c));
    const cleanup = () => { clearTimeout(timeout); signal?.removeEventListener('abort', stop); };
    signal?.addEventListener('abort', stop, { once: true });
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (code) => { cleanup(); if (signal?.aborted) reject(new Error('操作已取消')); else resolve({ stdout: stdout.slice(0, 100000), stderr: stderr.slice(0, 20000), code, truncated: overflow }); });
  });
}
module.exports = { resolveFile, listFiles, readFile, writeFile, search, runCommand };
