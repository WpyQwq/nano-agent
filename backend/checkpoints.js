const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { diffLines, createTwoFilesPatch } = require('diff');
const workspace = require('./workspace');

const MAX_CONTENT = 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function fingerprint(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function safeName(value, label) {
  if (typeof value !== 'string' || !SAFE_NAME.test(value)) throw new Error(`无效的${label}`);
  return value;
}

class Checkpoints {
  constructor({ directory, trashItem } = {}) {
    if (!directory) throw new Error('检查点目录不能为空');
    this.directory = directory;
    this.trashItem = trashItem;
    this.queues = new Map();
    this.lastTimestamp = 0;
  }

  // Serialize every mutation of one task so read-modify-write snapshots cannot interleave.
  _enqueue(taskId, operation) {
    const key = safeName(taskId, '任务标识');
    const previous = this.queues.get(key) || Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const cleanup = () => { if (this.queues.get(key) === result) this.queues.delete(key); };
    result.then(cleanup, cleanup);
    this.queues.set(key, result);
    return result;
  }

  _file(taskId, id) {
    return path.join(this.directory, `${taskId}.${id}.json`);
  }

  async _persist(taskId, record) {
    await fs.mkdir(this.directory, { recursive: true });
    const target = this._file(taskId, record.id);
    const temporary = `${target}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(record), 'utf8');
    await fs.rename(temporary, target);
  }

  async _load(taskId, id) {
    safeName(taskId, '任务标识');
    safeName(id, '检查点标识');
    try {
      return JSON.parse(await fs.readFile(this._file(taskId, id), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('检查点不存在');
      throw new Error('无法读取检查点');
    }
  }

  _public(record) {
    return {
      id: record.id,
      path: record.path,
      projectPath: record.projectPath,
      added: record.added,
      removed: record.removed,
      patch: record.patch,
      status: record.restored ? 'restored' : record.reviewed ? 'accepted' : 'pending',
      timestamp: record.timestamp
    };
  }

  async write({ taskId, projectPath, path: relativePath, content } = {}) {
    safeName(taskId, '任务标识');
    if (!projectPath || typeof projectPath !== 'string') throw new Error('请先选择项目目录');
    if (typeof relativePath !== 'string' || !relativePath) throw new Error('无效的文件路径');
    if (typeof content !== 'string') throw new Error('写入内容必须是文本');
    if (content.length > MAX_CONTENT) throw new Error('单次写入不能超过 1 MB');

    return this._enqueue(taskId, async () => {
      let before = null;
      try {
        before = (await workspace.readFile(projectPath, relativePath)).content;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      const after = content;
      const changes = diffLines(before === null ? '' : before, after);
      const added = changes.filter((part) => part.added).reduce((sum, part) => sum + part.count, 0);
      const removed = changes.filter((part) => part.removed).reduce((sum, part) => sum + part.count, 0);
      const patch = createTwoFilesPatch(relativePath, relativePath, before === null ? '' : before, after).slice(0, 100000);

      await workspace.writeFile(projectPath, relativePath, after);

      const timestamp = Math.max(Date.now(), this.lastTimestamp + 1);
      this.lastTimestamp = timestamp;
      const id = `${timestamp.toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
      await this._persist(taskId, {
        taskId,
        id,
        projectPath,
        path: relativePath,
        before,
        after,
        beforeHash: before === null ? null : fingerprint(before),
        afterHash: fingerprint(after),
        added,
        removed,
        patch,
        timestamp,
        reviewed: false,
        restored: false
      });
      return { ok: true, path: relativePath, id, added, removed, patch };
    });
  }

  async list(taskId) {
    safeName(taskId, '任务标识');
    let names;
    try {
      names = await fs.readdir(this.directory);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error('无法读取检查点');
    }

    const prefix = `${taskId}.`;
    const records = [];
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
      if (!SAFE_NAME.test(name.slice(prefix.length, -5))) continue;
      try {
        const record = JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8'));
        if (record && record.taskId === taskId && typeof record.id === 'string') records.push(record);
      } catch { /* Ignore partial or unreadable snapshot files. */ }
    }
    records.sort((left, right) => right.timestamp - left.timestamp || right.id.localeCompare(left.id));
    return records.map((record) => this._public(record));
  }

  async accept({ taskId, id } = {}) {
    safeName(taskId, '任务标识');
    safeName(id, '检查点标识');
    return this._enqueue(taskId, async () => {
      const record = await this._load(taskId, id);
      record.reviewed = true;
      await this._persist(taskId, record);
      return { ok: true, path: record.path, id: record.id, status: record.restored ? 'restored' : 'accepted' };
    });
  }

  async restore({ taskId, id } = {}) {
    safeName(taskId, '任务标识');
    safeName(id, '检查点标识');
    return this._enqueue(taskId, async () => {
      const record = await this._load(taskId, id);

      let current;
      try {
        current = (await workspace.readFile(record.projectPath, record.path)).content;
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error('文件已被修改或删除，恢复冲突');
        throw error;
      }
      if (fingerprint(current) !== record.afterHash) throw new Error('文件已被修改，恢复冲突');

      if (record.before === null) {
        // A new file is moved to the OS trash; never unlink it ourselves.
        const { root, target } = await workspace.resolveFile(record.projectPath, record.path);
        if (target === root) throw new Error('不能恢复项目根目录');
        if (typeof this.trashItem !== 'function') throw new Error('回收站不可用，已取消恢复');
        await this.trashItem(target);
      } else {
        await workspace.writeFile(record.projectPath, record.path, record.before);
      }

      record.restored = true;
      await this._persist(taskId, record);
      return { ok: true, path: record.path, id: record.id, status: 'restored' };
    });
  }
}

module.exports = { Checkpoints };
