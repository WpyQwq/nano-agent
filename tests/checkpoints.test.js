const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Checkpoints } = require('../backend/checkpoints');

const QA = path.resolve('E:/Nano-QA');
const read = (file) => fs.readFile(file, 'utf8');

// Keep every fixture: these tests never delete files, including their own setup.
async function fixture() {
  const base = path.join(QA, `run-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`);
  const project = path.join(base, 'project');
  const data = path.join(base, 'checkpoints');
  await fs.mkdir(project, { recursive: true });
  const trashed = [];
  const checkpoints = new Checkpoints({
    directory: data,
    trashItem: async (target) => { await fs.access(target); trashed.push(target); }
  });
  return { base, project, data, trashed, checkpoints, taskId: crypto.randomUUID() };
}

test('roundtrips existing and new files and exposes only public snapshot fields', async () => {
  const { project, checkpoints, trashed, taskId } = await fixture();
  await fs.writeFile(path.join(project, 'note.txt'), 'original\n');

  const changed = await checkpoints.write({ taskId, projectPath: project, path: 'note.txt', content: 'changed\nline\n' });
  assert.equal(changed.ok, true);
  assert.equal(changed.path, 'note.txt');
  assert.ok(changed.id);
  assert.ok(changed.added >= 2);
  assert.ok(changed.removed >= 1);
  assert.match(changed.patch, /changed/);
  assert.equal(await read(path.join(project, 'note.txt')), 'changed\nline\n');

  const created = await checkpoints.write({ taskId, projectPath: project, path: 'created.txt', content: 'hello\nworld\n' });
  assert.equal(created.ok, true);
  assert.equal(created.removed, 0);
  assert.equal(await read(path.join(project, 'created.txt')), 'hello\nworld\n');

  let list = await checkpoints.list(taskId);
  assert.equal(list.length, 2);
  for (const item of list) {
    assert.deepEqual(Object.keys(item).sort(), ['added', 'id', 'patch', 'path', 'projectPath', 'removed', 'status', 'timestamp']);
    assert.equal(item.status, 'pending');
    assert.equal('before' in item, false);
    assert.equal('after' in item, false);
  }

  const accepted = await checkpoints.accept({ taskId, id: changed.id });
  assert.equal(accepted.status, 'accepted');
  assert.equal((await checkpoints.list(taskId)).find((item) => item.id === changed.id).status, 'accepted');

  const restored = await checkpoints.restore({ taskId, id: changed.id });
  assert.equal(restored.status, 'restored');
  assert.equal(await read(path.join(project, 'note.txt')), 'original\n');

  const recycled = await checkpoints.restore({ taskId, id: created.id });
  assert.equal(recycled.status, 'restored');
  assert.deepEqual(trashed, [path.join(project, 'created.txt')]);
  assert.equal(await read(path.join(project, 'created.txt')), 'hello\nworld\n');

  list = await checkpoints.list(taskId);
  assert.equal(list.find((item) => item.id === changed.id).status, 'restored');
  assert.equal(list.find((item) => item.id === created.id).status, 'restored');
});

test('restore rejects a snapshot when the user edited the file afterwards', async () => {
  const { project, checkpoints, taskId } = await fixture();
  const file = path.join(project, 'conflict.txt');
  await fs.writeFile(file, 'base\n');
  const snapshot = await checkpoints.write({ taskId, projectPath: project, path: 'conflict.txt', content: 'agent\n' });
  await fs.writeFile(file, 'manual edit\n');

  await assert.rejects(checkpoints.restore({ taskId, id: snapshot.id }), /冲突/);
  assert.equal(await read(file), 'manual edit\n');
  assert.equal((await checkpoints.list(taskId))[0].status, 'pending');
});

test('repeated writes restore newest then older and reject out-of-order restores', async () => {
  const { project, checkpoints, taskId } = await fixture();
  const file = path.join(project, 'versions.txt');
  await fs.writeFile(file, 'v0\n');
  const first = await checkpoints.write({ taskId, projectPath: project, path: 'versions.txt', content: 'v1\n' });
  const second = await checkpoints.write({ taskId, projectPath: project, path: 'versions.txt', content: 'v2\n' });
  const third = await checkpoints.write({ taskId, projectPath: project, path: 'versions.txt', content: 'v3\n' });

  await assert.rejects(checkpoints.restore({ taskId, id: first.id }), /冲突/);
  assert.equal(await read(file), 'v3\n');

  await checkpoints.restore({ taskId, id: third.id });
  assert.equal(await read(file), 'v2\n');
  await checkpoints.restore({ taskId, id: second.id });
  assert.equal(await read(file), 'v1\n');
  await checkpoints.restore({ taskId, id: first.id });
  assert.equal(await read(file), 'v0\n');
  await assert.rejects(checkpoints.restore({ taskId, id: second.id }), /冲突/);

  const list = await checkpoints.list(taskId);
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((item) => item.status), ['restored', 'restored', 'restored']);
});

test('concurrent writes to different files in one task stay separate and durable', async () => {
  const { project, checkpoints, taskId } = await fixture();
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => checkpoints.write({
    taskId,
    projectPath: project,
    path: `file-${index}.txt`,
    content: `value ${index}\n`
  })));

  assert.equal(results.every((result) => result.ok), true);
  assert.equal(new Set(results.map((result) => result.id)).size, 8);
  for (let index = 0; index < 8; index += 1) {
    assert.equal(await read(path.join(project, `file-${index}.txt`)), `value ${index}\n`);
  }
  assert.equal((await checkpoints.list(taskId)).length, 8);
});

test('list rebuilds persisted statuses after a restart', async () => {
  const { project, data, checkpoints, taskId } = await fixture();
  await fs.writeFile(path.join(project, 'keep.txt'), 'old\n');
  const kept = await checkpoints.write({ taskId, projectPath: project, path: 'keep.txt', content: 'new\n' });
  await checkpoints.accept({ taskId, id: kept.id });
  const added = await checkpoints.write({ taskId, projectPath: project, path: 'temp.txt', content: 'temp\n' });
  await checkpoints.restore({ taskId, id: added.id });

  const reopened = new Checkpoints({ directory: data, trashItem: async () => {} });
  const list = await reopened.list(taskId);
  assert.equal(list.length, 2);
  assert.equal(list.find((item) => item.id === kept.id).status, 'accepted');
  assert.equal(list.find((item) => item.id === added.id).status, 'restored');
  for (const item of list) {
    assert.equal('before' in item, false);
    assert.equal('after' in item, false);
  }
});

test('rejects traversal task ids, checkpoint ids, project paths and oversized content', async () => {
  const { project, checkpoints, taskId } = await fixture();
  await fs.writeFile(path.join(project, 'safe.txt'), 'before\n');

  await assert.rejects(checkpoints.write({ taskId: '../escape', projectPath: project, path: 'safe.txt', content: 'x' }), /任务标识/);
  await assert.rejects(checkpoints.write({ taskId, projectPath: project, path: '../outside.txt', content: 'x' }), /范围|路径/);
  await assert.rejects(checkpoints.write({ taskId, projectPath: project, path: '.nano/settings.json', content: 'x' }), /数据目录/);
  await assert.rejects(checkpoints.list('../escape'), /任务标识/);

  const snapshot = await checkpoints.write({ taskId, projectPath: project, path: 'safe.txt', content: 'after\n' });
  await assert.rejects(checkpoints.accept({ taskId, id: `../${snapshot.id}` }), /检查点标识/);
  await assert.rejects(checkpoints.restore({ taskId, id: `../${snapshot.id}` }), /检查点标识/);
  await assert.rejects(checkpoints.write({ taskId, projectPath: project, path: 'safe.txt', content: 'x'.repeat(1024 * 1024 + 1) }), /1 MB/);

  await assert.rejects(fs.access(path.join(path.dirname(project), 'outside.txt')));
});
