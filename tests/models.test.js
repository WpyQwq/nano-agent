'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../backend/store');
const { ModelConnections } = require('../backend/models');

function createEncryption() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`sealed:${value}`),
    decryptString: (buffer) => buffer.toString().slice('sealed:'.length)
  };
}

async function fixture(legacySettings = null) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nano-models-'));
  const store = new Store(directory, createEncryption());
  if (legacySettings) {
    await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify(legacySettings, null, 2), 'utf8');
  }
  return { directory, store };
}

function legacySettings(overrides = {}) {
  return {
    provider: 'openai',
    model: 'gpt-5',
    baseUrl: 'https://api.openai.com/v1',
    encryptedKey: Buffer.from('sealed:sk-legacy-key').toString('base64'),
    permissionMode: 'ask',
    theme: 'dark',
    ...overrides
  };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body
  };
}

function createFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init?.headers || {}, signal: init?.signal });
    const result = await handler(url, init, calls.length);
    if (result instanceof Error) throw result;
    return result;
  };
  return { fetchImpl, calls };
}

function noFetch() {
  return async () => { throw new Error('network must not be touched'); };
}

test('lazily migrates legacy settings into a sanitized first connection without touching settings', async () => {
  const { directory, store } = await fixture(legacySettings());
  const settingsBefore = await fs.readFile(path.join(directory, 'settings.json'), 'utf8');
  const manager = new ModelConnections({ store, fetchImpl: noFetch() });

  const list = await manager.list();
  assert.equal(list.length, 1);
  const [connection] = list;
  assert.equal(connection.id, 'legacy-settings');
  assert.equal(connection.name, '默认连接');
  assert.equal(connection.provider, 'openai');
  assert.equal(connection.model, 'gpt-5');
  assert.equal(connection.baseUrl, 'https://api.openai.com/v1');
  assert.equal(connection.hasApiKey, true);
  assert.equal('apiKey' in connection, false);
  assert.equal('encryptedKey' in connection, false);
  assert.ok(JSON.stringify(list).includes('sk-legacy-key') === false);

  // A read alone writes nothing and never touches the legacy settings file.
  await assert.rejects(fs.access(path.join(directory, 'models.json')), (error) => error.code === 'ENOENT');
  assert.equal(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'), settingsBefore);
  // Repeated reads agree on the migrated id so later writes can address it.
  assert.equal((await manager.list())[0].id, connection.id);

  const config = await manager.resolve('legacy-settings');
  assert.deepEqual(config, {
    provider: 'openai',
    model: 'gpt-5',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-legacy-key'
  });
});

test('the migrated connection persists first alongside new connections and stays encrypted', async () => {
  const { directory, store } = await fixture(legacySettings());
  const manager = new ModelConnections({ store, fetchImpl: noFetch() });

  const saved = await manager.save({ name: 'Anthropic 直连', provider: 'anthropic', apiKey: 'sk-new-key' });
  assert.equal(saved.hasApiKey, true);

  const list = await manager.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'legacy-settings'); // migration stays the first connection
  assert.equal(list[1].id, saved.id);

  const raw = JSON.parse(await fs.readFile(path.join(directory, 'models.json'), 'utf8'));
  assert.equal(raw.connections.length, 2);
  assert.equal(raw.connections[0].encryptedKey, legacySettings().encryptedKey);
  assert.equal(raw.connections[1].encryptedKey, Buffer.from('sealed:sk-new-key').toString('base64'));
  assert.equal(JSON.stringify(raw).includes('sk-legacy-key'), false);
  assert.equal(JSON.stringify(raw).includes('sk-new-key'), false);
  // Legacy settings remain untouched after the write.
  const settings = JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'));
  assert.equal(settings.encryptedKey, legacySettings().encryptedKey);
  assert.equal(settings.model, 'gpt-5');

  const config = await manager.resolve(saved.id, 'claude-sonnet-5');
  assert.equal(config.provider, 'anthropic');
  assert.equal(config.model, 'claude-sonnet-5');
  assert.equal(config.apiKey, 'sk-new-key');
});

test('skips migration for demo providers or settings without a stored key', async () => {
  const demo = await fixture(legacySettings({ provider: 'demo' }));
  const demoManager = new ModelConnections({ store: demo.store, fetchImpl: noFetch() });
  assert.deepEqual(await demoManager.list(), []);

  const keyless = await fixture(legacySettings({ encryptedKey: '' }));
  assert.deepEqual(await new ModelConnections({ store: keyless.store, fetchImpl: noFetch() }).list(), []);

  const anthropic = await fixture(legacySettings({ provider: 'anthropic', model: 'claude-sonnet-5', baseUrl: undefined }));
  const anthropicManager = new ModelConnections({ store: anthropic.store, fetchImpl: noFetch() });
  const list = await anthropicManager.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].provider, 'anthropic');
  assert.equal(list[0].model, 'claude-sonnet-5');
  assert.equal('baseUrl' in list[0], false);

  // Once the user removes the imported connection, migration never comes back.
  await anthropicManager.remove('legacy-settings');
  assert.deepEqual(await anthropicManager.list(), []);
});

test('save, list and remove round-trip with sanitized fields and validation', async () => {
  const { directory, store } = await fixture();
  const manager = new ModelConnections({ store, fetchImpl: noFetch() });

  const created = await manager.save({
    name: 'OpenAI',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-roundtrip',
    model: 'gpt-5-mini',
    contextWindow: 128000
  });
  assert.match(created.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(Object.keys(created).sort(), [
    'baseUrl', 'contextWindow', 'createdAt', 'hasApiKey', 'id', 'model', 'name', 'provider', 'updatedAt'
  ]);

  const list = await manager.list();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], created);
  assert.equal(JSON.stringify(list).includes('sk-roundtrip'), false);

  const raw = JSON.parse(await fs.readFile(path.join(directory, 'models.json'), 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.connections[0].encryptedKey, Buffer.from('sealed:sk-roundtrip').toString('base64'));

  const removed = await manager.remove(created.id);
  assert.equal(removed.id, created.id);
  assert.deepEqual(await manager.list(), []);
  await assert.rejects(manager.remove(created.id), /连接不存在/);

  const invalid = [
    [{}, /提供方/],
    [{ name: '' , provider: 'openai' }, /名称/],
    [{ name: 'X', provider: 'llama' }, /提供方/],
    [{ name: 'X', provider: 'openai', baseUrl: 'ftp://nope.example.com' }, /Base URL/],
    [{ name: 'X', provider: 'openai', baseUrl: 'not a url' }, /Base URL/],
    [{ name: 'X', provider: 'openai', contextWindow: 'huge' }, /contextWindow/],
    [{ name: 'X', provider: 'openai', contextWindow: -5 }, /contextWindow/],
    [{ name: 'X', provider: 'openai', apiKey: 42 }, /API Key/],
    [{ id: 'missing', name: 'X', provider: 'openai' }, /连接不存在/],
    ['not-an-object', /必须是一个对象/]
  ];
  for (const [input, pattern] of invalid) {
    await assert.rejects(manager.save(input), pattern);
  }
  assert.deepEqual(await manager.list(), []);
});

test('blank API keys preserve the stored secret and explicit clearing removes it', async () => {
  const { store } = await fixture();
  const manager = new ModelConnections({ store, fetchImpl: noFetch() });
  const created = await manager.save({ name: 'OpenAI', provider: 'openai', apiKey: 'sk-first', model: 'gpt-5' });

  const renamed = await manager.save({ id: created.id, name: 'Renamed', apiKey: '' });
  assert.equal(renamed.name, 'Renamed');
  assert.equal(renamed.hasApiKey, true);
  assert.equal((await manager.resolve(created.id)).apiKey, 'sk-first');

  const cleared = await manager.save({ id: created.id, clearApiKey: true });
  assert.equal(cleared.hasApiKey, false);
  assert.equal('apiKey' in (await manager.resolve(created.id)), false);

  // A missing encryption service never stores plaintext credentials.
  const insecure = new Store(await fs.mkdtemp(path.join(os.tmpdir(), 'nano-models-')), { isEncryptionAvailable: () => false });
  const insecureManager = new ModelConnections({ store: insecure, fetchImpl: noFetch() });
  await assert.rejects(insecureManager.save({ name: 'X', provider: 'openai', apiKey: 'sk-never' }), /加密不可用/);
  assert.deepEqual(await insecureManager.list(), []);
});

test('discovers OpenAI models with real metadata only and deduplicates entries', async () => {
  const { store } = await fixture();
  const { fetchImpl, calls } = createFetch(() => response({
    object: 'list',
    data: [
      { id: 'gpt-5', object: 'model', owned_by: 'openai' },
      { id: 'gpt-5-mini', name: 'GPT-5 Mini', context_length: 200000 },
      { id: 'gpt-5', name: 'duplicate id' },
      { id: '', name: 'broken entry' },
      'not-an-object',
      { id: 'bad-window', context_window: 'not-a-number' },
      { id: 'router-style', top_provider: { context_length: '256000' } }
    ]
  }));
  const manager = new ModelConnections({ store, fetchImpl });

  const models = await manager.discover({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-discover' });
  assert.deepEqual(models, [
    { id: 'gpt-5', name: 'gpt-5' },
    { id: 'gpt-5-mini', name: 'GPT-5 Mini', contextWindow: 200000 },
    { id: 'bad-window', name: 'bad-window' },
    { id: 'router-style', name: 'router-style', contextWindow: 256000 }
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/models');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-discover');
  assert.ok(calls[0].signal instanceof AbortSignal);
  // Testing without an id persists nothing.
  assert.deepEqual(await manager.list(), []);
});

test('normalizes OpenAI base URLs and preserves arbitrary custom paths', async () => {
  const { store } = await fixture();
  const cases = [
    ['https://api.openai.com', 'https://api.openai.com/v1/models'],
    ['https://api.openai.com/v1/', 'https://api.openai.com/v1/models'],
    ['https://api.openai.com/v1/chat/completions', 'https://api.openai.com/v1/models'],
    ['https://gateway.example.com/openai/', 'https://gateway.example.com/openai/models'],
    ['https://gateway.example.com/openai', 'https://gateway.example.com/openai/models'],
    ['https://gateway.example.com/v1', 'https://gateway.example.com/v1/models'],
    ['https://gateway.example.com/v1/chat/completions', 'https://gateway.example.com/v1/models']
  ];
  const { fetchImpl, calls } = createFetch(() => response({ data: [] }));
  const manager = new ModelConnections({ store, fetchImpl });
  for (const [baseUrl] of cases) {
    await manager.discover({ provider: 'openai', baseUrl });
  }
  assert.deepEqual(calls.map((call) => call.url), cases.map(([, url]) => url));
  await manager.discover({ provider: 'openai' });
  assert.equal(calls.at(-1).url, 'https://api.openai.com/v1/models');
});

test('discovers Anthropic models with pagination, headers and real context metadata', async () => {
  const { store } = await fixture();
  const pages = [
    {
      data: [{ type: 'model', id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', max_input_tokens: 200000 }],
      has_more: true,
      first_id: 'claude-sonnet-5',
      last_id: 'claude-sonnet-5'
    },
    {
      data: [{ type: 'model', id: 'claude-opus-5', display_name: 'Claude Opus 5', max_tokens: 64000 }],
      has_more: false,
      last_id: 'claude-opus-5'
    }
  ];
  const { fetchImpl, calls } = createFetch((url) => {
    const after = new URL(url).searchParams.get('after_id');
    return response(after ? pages[1] : pages[0]);
  });
  const manager = new ModelConnections({ store, fetchImpl });

  const models = await manager.discover({ provider: 'anthropic', apiKey: 'sk-ant-key' });
  assert.deepEqual(models, [
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 200000 },
    { id: 'claude-opus-5', name: 'Claude Opus 5' } // max_tokens is output, never treated as context
  ]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/models?limit=1000');
  assert.equal(calls[1].url, 'https://api.anthropic.com/v1/models?limit=1000&after_id=claude-sonnet-5');
  assert.equal(calls[0].headers['x-api-key'], 'sk-ant-key');
  assert.equal(calls[0].headers['anthropic-version'], '2026-10-21');
  assert.equal('Authorization' in calls[0].headers, false);

  // Custom gateway paths are preserved and a trailing /v1 is never doubled.
  const { fetchImpl: customFetch, calls: customCalls } = createFetch(() => response({ data: [] }));
  const customManager = new ModelConnections({ store, fetchImpl: customFetch });
  await customManager.discover({ provider: 'anthropic', baseUrl: 'https://gw.example.com/anth' });
  await customManager.discover({ provider: 'anthropic', baseUrl: 'https://gw.example.com/anth/v1' });
  await customManager.discover({ provider: 'anthropic', baseUrl: 'https://gw.example.com/anth/v1/messages' });
  assert.deepEqual(customCalls.map((call) => call.url), [
    'https://gw.example.com/anth/v1/models?limit=1000',
    'https://gw.example.com/anth/v1/models?limit=1000',
    'https://gw.example.com/anth/v1/models?limit=1000'
  ]);
});

test('discover reuses a stored key for saved connections and never persists a fresh one', async () => {
  const { directory, store } = await fixture();
  const { fetchImpl, calls } = createFetch(() => response({ data: [{ id: 'gpt-5', name: 'GPT-5' }] }));
  const manager = new ModelConnections({ store, fetchImpl });
  const created = await manager.save({
    name: 'OpenAI',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-stored',
    model: 'gpt-5'
  });

  await manager.discover({ id: created.id, provider: 'openai' });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/models');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-stored');

  await manager.discover({ id: created.id, provider: 'openai', apiKey: 'sk-fresh' });
  assert.equal(calls[1].headers.Authorization, 'Bearer sk-fresh');

  const raw = JSON.parse(await fs.readFile(path.join(directory, 'models.json'), 'utf8'));
  assert.equal(raw.connections[0].encryptedKey, Buffer.from('sealed:sk-stored').toString('base64'));
  const config = await manager.resolve(created.id);
  assert.equal(config.apiKey, 'sk-stored');

  await assert.rejects(manager.discover({ id: created.id, provider: 'anthropic' }), /不一致/);
  await assert.rejects(manager.discover({ id: 'missing-id' }), /连接不存在/);
  await assert.rejects(manager.discover({}), /提供方/);
  await assert.rejects(manager.discover({ provider: 'llama' }), /提供方/);
});

test('discovery caches models per connection and resolve only reports real context windows', async () => {
  const { store } = await fixture();
  const { fetchImpl } = createFetch(() => response({
    data: [
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'gpt-5-mini', name: 'GPT-5 Mini', context_length: 200000 }
    ]
  }));
  const manager = new ModelConnections({ store, fetchImpl });
  const created = await manager.save({ name: 'OpenAI', provider: 'openai', apiKey: 'sk', model: 'gpt-5' });

  const models = await manager.discover({ id: created.id, provider: 'openai' });
  assert.equal(models.length, 2);

  const list = await manager.list();
  assert.equal(list[0].models.length, 2);
  assert.deepEqual(list[0].models[1], { id: 'gpt-5-mini', name: 'GPT-5 Mini', contextWindow: 200000 });
  assert.ok(list[0].discoveredAt >= created.updatedAt);

  const known = await manager.resolve(created.id, 'gpt-5-mini');
  assert.equal(known.contextWindow, 200000);
  const unknown = await manager.resolve(created.id, 'gpt-4o');
  assert.equal('contextWindow' in unknown, false); // never fabricated

  // Connection-level metadata provided on save is honored for other models.
  await manager.save({ id: created.id, name: 'OpenAI', provider: 'openai', model: 'gpt-5', contextWindow: 32000 });
  assert.equal((await manager.resolve(created.id, 'gpt-4o')).contextWindow, 32000);

  // Renaming keeps the cache; moving the endpoint drops it.
  const renamed = await manager.save({ id: created.id, name: 'Renamed' });
  assert.equal(renamed.models.length, 2);
  const moved = await manager.save({ id: created.id, name: 'Moved', baseUrl: 'https://gw.example.com/v1' });
  assert.equal('models' in moved, false);
  assert.equal('discoveredAt' in moved, false);

  // Switching providers also invalidates the cache.
  const recached = await manager.save({ id: created.id, name: 'Back', baseUrl: 'https://api.openai.com/v1' });
  const switched = await manager.save({ id: recached.id, name: 'Back', provider: 'anthropic', baseUrl: 'https://api.anthropic.com' });
  assert.equal('models' in switched, false);
});

test('reports readable discovery errors without leaking the API key', async () => {
  const { store } = await fixture();

  const unauthorized = createFetch(() => response({ error: { message: 'Incorrect API key provided' } }, 401));
  const manager = new ModelConnections({ store, fetchImpl: unauthorized.fetchImpl });
  await assert.rejects(manager.discover({ provider: 'openai', apiKey: 'sk-secret-value' }), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.match(error.message, /Incorrect API key provided/);
    assert.equal(error.message.includes('sk-secret-value'), false);
    return true;
  });

  const serverError = createFetch(() => ({
    ok: false,
    status: 500,
    json: async () => { throw new Error('bad json'); },
    text: async () => 'gateway exploded'
  }));
  await assert.rejects(
    new ModelConnections({ store, fetchImpl: serverError.fetchImpl }).discover({ provider: 'openai' }),
    (error) => {
      assert.match(error.message, /HTTP 500/);
      assert.match(error.message, /gateway exploded/);
      return true;
    }
  );

  const network = createFetch(async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND api.openai.com') });
  });
  await assert.rejects(
    new ModelConnections({ store, fetchImpl: network.fetchImpl }).discover({ provider: 'openai' }),
    (error) => {
      assert.match(error.message, /获取模型列表失败/);
      assert.match(error.message, /ENOTFOUND/);
      return true;
    }
  );

  const malformed = createFetch(() => response({ data: 'nope' }));
  await assert.rejects(
    new ModelConnections({ store, fetchImpl: malformed.fetchImpl }).discover({ provider: 'openai' }),
    /格式无效/
  );

  const notJson = createFetch(() => ({
    ok: true,
    status: 200,
    json: async () => { throw new Error('unexpected end of input'); }
  }));
  await assert.rejects(
    new ModelConnections({ store, fetchImpl: notJson.fetchImpl }).discover({ provider: 'anthropic' }),
    /不是有效 JSON/
  );
});

test('a hanging endpoint times out with a readable error and no unhandled rejection', async () => {
  const { store } = await fixture();
  const { fetchImpl } = createFetch(() => new Promise(() => {})); // ignores the abort signal
  const manager = new ModelConnections({ store, fetchImpl });
  manager.timeoutMs = 50;
  await assert.rejects(manager.discover({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' }), /超时/);
});

test('resolve returns private config with selected model, effort and real context window', async () => {
  const { store } = await fixture();
  const manager = new ModelConnections({ store, fetchImpl: noFetch() });

  const openai = await manager.save({ name: 'OpenAI', provider: 'openai', apiKey: 'sk-openai', model: 'gpt-5' });
  assert.deepEqual(await manager.resolve(openai.id, 'gpt-5-mini', 'medium'), {
    provider: 'openai',
    model: 'gpt-5-mini',
    apiKey: 'sk-openai',
    effort: 'medium',
    reasoningEffort: 'medium'
  });
  assert.deepEqual(await manager.resolve(openai.id, undefined, 'none'), {
    provider: 'openai',
    model: 'gpt-5',
    apiKey: 'sk-openai',
    effort: 'none'
  });
  assert.deepEqual(await manager.resolve(openai.id), {
    provider: 'openai',
    model: 'gpt-5',
    apiKey: 'sk-openai'
  });

  const anthropic = await manager.save({
    name: 'Anthropic',
    provider: 'anthropic',
    apiKey: 'sk-ant',
    baseUrl: 'https://gw.example.com',
    model: 'claude-sonnet-5',
    contextWindow: 200000
  });
  assert.deepEqual(await manager.resolve(anthropic.id, undefined, 'high'), {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    baseUrl: 'https://gw.example.com',
    apiKey: 'sk-ant',
    contextWindow: 200000,
    effort: 'high',
    outputConfig: { effort: 'high' }
  });
  assert.deepEqual(await manager.resolve(anthropic.id, 'claude-opus-5', 'minimal'), {
    provider: 'anthropic',
    model: 'claude-opus-5',
    baseUrl: 'https://gw.example.com',
    apiKey: 'sk-ant',
    contextWindow: 200000,
    effort: 'minimal',
    outputConfig: { effort: 'low' }
  });

  await assert.rejects(manager.resolve(anthropic.id, 'claude-opus-5', 'extreme'), /努力程度/);
  await assert.rejects(manager.resolve('nope', 'any-model'), /连接不存在/);

  const keyless = await manager.save({ name: 'Local', provider: 'openai' });
  await assert.rejects(manager.resolve(keyless.id), /模型/);
});

test('concurrent saves serialize without losing connections or deadlocking the store queue', async () => {
  const { directory, store } = await fixture();
  const manager = new ModelConnections({ store, fetchImpl: noFetch() });

  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => manager.save({
    name: `Connection ${index}`,
    provider: index % 2 ? 'anthropic' : 'openai',
    apiKey: `sk-${index}`
  })));
  assert.equal(new Set(results.map((result) => result.id)).size, 12);
  assert.equal((await manager.list()).length, 12);
  const raw = JSON.parse(await fs.readFile(path.join(directory, 'models.json'), 'utf8'));
  assert.equal(raw.connections.length, 12);

  // The models queue coordinates with the store's own writes instead of deadlocking.
  await Promise.all([
    manager.save({ name: 'Extra', provider: 'openai' }),
    store.saveSettings({ theme: 'light' }),
    store.saveTask({ id: 'task-1', messages: [] })
  ]);
  assert.equal((await manager.list()).length, 13);
  assert.equal((await store.settings()).theme, 'light');
  assert.equal((await store.tasks()).length, 1);

  // Parallel saves and removals of the same ids stay consistent.
  const extra = (await manager.list()).find((connection) => connection.name === 'Extra');
  await Promise.all([
    manager.remove(extra.id),
    manager.save({ name: 'After Remove', provider: 'anthropic' })
  ]);
  const finalList = await manager.list();
  assert.equal(finalList.length, 13);
  assert.equal(finalList.some((connection) => connection.id === extra.id), false);
  assert.equal(finalList.some((connection) => connection.name === 'After Remove'), true);
});

test('discovery in flight persists its cache without clobbering parallel saves', async () => {
  const { store } = await fixture();
  let releaseFetch;
  const gate = new Promise((resolve) => { releaseFetch = resolve; });
  const { fetchImpl } = createFetch(async () => {
    await gate;
    return response({ data: [{ id: 'gpt-5', name: 'GPT-5' }] });
  });
  const manager = new ModelConnections({ store, fetchImpl });
  const created = await manager.save({ name: 'OpenAI', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk' });

  const discovering = manager.discover({ id: created.id, provider: 'openai' });
  const parallelSave = manager.save({ name: 'Anthropic', provider: 'anthropic', apiKey: 'sk-ant' });
  releaseFetch();
  const [models, saved] = await Promise.all([discovering, parallelSave]);

  assert.equal(models.length, 1);
  const list = await manager.list();
  assert.equal(list.length, 2);
  const withCache = list.find((connection) => connection.id === created.id);
  assert.equal(withCache.models.length, 1);
  const other = list.find((connection) => connection.id === saved.id);
  assert.equal(other.name, 'Anthropic');
  assert.equal('models' in other, false);
});
