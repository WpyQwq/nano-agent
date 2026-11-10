'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { McpManager } = require('../backend/mcp');
const { AgentRuntime } = require('../backend/agent');

const MISSING_EXE = 'nano-mcp-definitely-missing-exe';

class FakeTransport {
  constructor() {
    this.started = 0;
    this.closed = 0;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
  }

  async start() {
    this.started += 1;
  }

  async close() {
    this.closed += 1;
  }

  async send() {}
}

class FakeClient {
  constructor(options = {}) {
    this.options = options;
    this.transport = null;
    this.connectOptions = null;
    this.listCalls = [];
    this.callCalls = [];
    this.closeCount = 0;
    this.onclose = null;
    this.onerror = null;
  }

  async connect(transport, options) {
    this.transport = transport;
    this.connectOptions = options;
    if (this.options.connectBehavior === 'hang') return new Promise(() => {});
    if (this.options.connectError) throw this.options.connectError;
    return undefined;
  }

  async listTools(params, options) {
    this.listCalls.push({ params, options });
    if (this.options.listError) throw this.options.listError;
    if (typeof this.options.listBehavior === 'function') {
      return this.options.listBehavior(params, this.listCalls.length);
    }
    return { tools: this.options.tools ?? [] };
  }

  async callTool(params, resultSchema, options) {
    this.callCalls.push({ params, resultSchema, options });
    // 'hang' deliberately ignores the abort signal to prove the manager enforces it.
    if (this.options.callBehavior === 'hang') return new Promise(() => {});
    if (this.options.callError) throw this.options.callError;
    if (typeof this.options.callResult === 'function') return this.options.callResult(params);
    return this.options.callResult ?? { content: [{ type: 'text', text: 'ok' }] };
  }

  async close() {
    this.closeCount += 1;
  }

  simulateClose() {
    this.onclose?.();
  }

  simulateError(message) {
    this.onerror?.(new Error(message));
  }
}

// Minimal in-process JSON-RPC server transport: exercises the real SDK Client handshake
// without spawning a process or touching the network.
class ScriptedJsonRpcTransport {
  constructor({ tools = [], callResult } = {}) {
    this.tools = tools;
    this.callResult = callResult ?? { content: [{ type: 'text', text: 'scripted ok' }] };
    this.sent = [];
    this.closeCount = 0;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
  }

  async start() {}

  async close() {
    this.closeCount += 1;
  }

  reply(message) {
    if (message.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'scripted', version: '0.0.0' }
        }
      };
    }
    if (message.method === 'tools/list') {
      return { jsonrpc: '2.0', id: message.id, result: { tools: this.tools } };
    }
    if (message.method === 'tools/call') {
      return { jsonrpc: '2.0', id: message.id, result: this.callResult };
    }
    return null;
  }

  async send(message) {
    this.sent.push(message);
    const reply = message.id === undefined || message.id === null ? null : this.reply(message);
    if (reply) queueMicrotask(() => this.onmessage?.(reply));
  }
}

function createHarness(clientOptions = {}) {
  const clients = [];
  const transports = [];
  const resolveOptions = typeof clientOptions === 'function' ? clientOptions : () => clientOptions;
  const manager = new McpManager({
    clientFactory: (server) => {
      const client = new FakeClient(resolveOptions(server));
      clients.push(client);
      return client;
    },
    transportFactory: () => {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    }
  });
  return { manager, clients, transports };
}

function stdioServer(overrides = {}) {
  return {
    id: 'fs',
    name: 'Filesystem',
    type: 'stdio',
    command: 'node',
    args: ['server.js'],
    env: { NANO_MCP_TEST: '1' },
    ...overrides
  };
}

function tool(name, extra = {}) {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    },
    ...extra
  };
}

test('connect lists tools and exposes runtime-ready definitions', { timeout: 8000 }, async () => {
  const { manager, clients, transports } = createHarness({
    tools: [tool('read_file'), tool('search_files', { description: '' })]
  });
  const summary = await manager.connect(stdioServer());

  assert.equal(summary.status, 'connected');
  assert.equal(summary.toolCount, 2);
  assert.equal(clients.length, 1);
  assert.equal(transports.length, 1);
  assert.equal(transports[0].started, 0, 'fake transports are started by the client, not the manager');
  // Handshake gets the 15s connect timeout and an abort signal for teardown.
  assert.equal(clients[0].connectOptions.timeout, 15000);
  assert.ok(clients[0].connectOptions.signal instanceof AbortSignal);
  assert.equal(clients[0].listCalls.length, 1);
  assert.equal(clients[0].listCalls[0].options.timeout, 15000);

  const definitions = manager.toolDefinitions();
  assert.equal(definitions.length, 2);
  assert.deepEqual(definitions[0], {
    name: 'mcp_fs__read_file',
    description: 'Tool read_file',
    parameters: tool('read_file').inputSchema,
    requiresApproval: true
  });
  // Missing descriptions fall back instead of feeding the model an empty string.
  assert.equal(definitions[1].name, 'mcp_fs__search_files');
  assert.ok(definitions[1].description.length > 0);

  const status = manager.status();
  assert.equal(status.length, 1);
  assert.deepEqual(status[0], { id: 'fs', name: 'Filesystem', type: 'stdio', status: 'connected', toolCount: 2 });
  await manager.closeAll();
});

test('definitions feed AgentRuntime with top-level requiresApproval', { timeout: 8000 }, async () => {
  const { manager } = createHarness({ tools: [tool('read_file')] });
  await manager.connect(stdioServer());

  const runtime = new AgentRuntime({
    toolDefinitions: manager.toolDefinitions(),
    executeTool: async () => ({ ok: true })
  });
  assert.equal(runtime.toolDefinitions.length, 1);
  assert.equal(runtime.toolDefinitions[0].name, 'mcp_fs__read_file');
  assert.equal(runtime.toolDefinitions[0].requiresApproval, true);
  assert.deepEqual(runtime.toolDefinitions[0].parameters, tool('read_file').inputSchema);
  await manager.closeAll();
});

test('read-only metadata controls requiresApproval', { timeout: 8000 }, async () => {
  const tools = [
    tool('safe_read', { annotations: { readOnlyHint: true } }),
    tool('plain_read'),
    tool('write_thing', { annotations: { readOnlyHint: false } })
  ];
  const { manager } = createHarness({ tools });
  await manager.connect(stdioServer({ readOnly: true }));
  const byName = Object.fromEntries(manager.toolDefinitions().map((definition) => [definition.name, definition]));
  assert.equal(byName.mcp_fs__safe_read.requiresApproval, false);
  assert.equal(byName.mcp_fs__plain_read.requiresApproval, true);
  assert.equal(byName.mcp_fs__write_thing.requiresApproval, true);
  await manager.closeAll();

  // A read-only hint alone is not enough: the server must opt in with readOnly too.
  const { manager: manager2 } = createHarness({ tools: [tool('safe_read', { annotations: { readOnlyHint: true } })] });
  await manager2.connect(stdioServer());
  assert.equal(manager2.toolDefinitions()[0].requiresApproval, true);
  await manager2.closeAll();
});

test('normalized name collisions get stable unique aliases and route to the right server', { timeout: 8000 }, async () => {
  const { manager, clients } = createHarness(() => ({ tools: [tool('x')] }));
  // 'my server' and 'my/server' both normalize to my_server, so their aliases collide.
  await manager.connect(stdioServer({ id: 'my server', name: 'One' }));
  await manager.connect(stdioServer({ id: 'my/server', name: 'Two' }));

  const names = manager.toolDefinitions().map((definition) => definition.name);
  assert.equal(names.length, 2);
  assert.equal(new Set(names).size, 2);
  for (const name of names) assert.ok(name.startsWith('mcp_my_server__x'), name);
  // Stable: rebuilding yields the same aliases.
  assert.deepEqual(manager.toolDefinitions().map((definition) => definition.name), names);

  // Each alias executes on the server that listed the tool, under its original name.
  await manager.execute(names[0], { path: 'a' });
  assert.equal(clients[0].callCalls.length, 1);
  assert.equal(clients[1].callCalls.length, 0);
  await manager.execute(names[1], { path: 'b' });
  assert.equal(clients[1].callCalls.length, 1);
  assert.deepEqual(clients[1].callCalls[0].params, { name: 'x', arguments: { path: 'b' } });

  // Dropping one of the colliding servers keeps the other alias unchanged.
  await manager.disconnect('my server');
  assert.deepEqual(manager.toolDefinitions().map((definition) => definition.name), [names[1]]);
  // Reconnecting restores the frozen alias for both servers.
  await manager.connect(stdioServer({ id: 'my server', name: 'One' }));
  assert.deepEqual(
    manager.toolDefinitions().map((definition) => definition.name).sort(),
    [...names].sort()
  );
  await manager.closeAll();
});

test('long tool names are truncated with a stable hash suffix and stay unique', { timeout: 8000 }, async () => {
  const { manager } = createHarness(() => ({ tools: [tool('a'.repeat(80)), tool('b'.repeat(80))] }));
  await manager.connect(stdioServer({ id: 'long' }));
  const names = manager.toolDefinitions().map((definition) => definition.name);
  assert.equal(names.length, 2);
  assert.equal(new Set(names).size, 2);
  for (const name of names) {
    assert.ok(name.length <= 64, name);
    assert.ok(name.startsWith('mcp_long__'), name);
  }
  await manager.closeAll();

  // Names differing only beyond the truncation point must not collapse into one alias.
  const { manager: manager2 } = createHarness(() => ({ tools: [tool(`${'c'.repeat(70)}1`), tool(`${'c'.repeat(70)}2`)] }));
  await manager2.connect(stdioServer({ id: 'long' }));
  const names2 = manager2.toolDefinitions().map((definition) => definition.name);
  assert.equal(new Set(names2).size, 2);
  await manager2.closeAll();
});

test('execute maps aliases to original tool names and normalizes content', { timeout: 8000 }, async () => {
  const callResult = {
    content: [
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'audio', data: 'BBBB', mimeType: 'audio/wav' },
      { type: 'resource_link', uri: 'file:///notes.txt' }
    ]
  };
  const { manager, clients } = createHarness({ tools: [tool('read_file')], callResult });
  await manager.connect(stdioServer());

  const result = await manager.execute('mcp_fs__read_file', { path: 'a.txt' }, { signal: new AbortController().signal });
  assert.deepEqual(result, {
    content: [
      { type: 'text', text: 'hello' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: '[audio content omitted]' },
      { type: 'text', text: 'file:///notes.txt' }
    ]
  });

  const call = clients[0].callCalls[0];
  assert.deepEqual(call.params, { name: 'read_file', arguments: { path: 'a.txt' } });
  assert.equal(call.resultSchema, undefined);
  assert.equal(call.options.timeout, 60000);
  assert.ok(call.options.signal instanceof AbortSignal);
  await manager.closeAll();
});

test('tool result content variants normalize to LangChain content', { timeout: 8000 }, async () => {
  const { manager } = createHarness({
    tools: [tool('structured')],
    callResult: { content: [], structuredContent: { rows: 2 } }
  });
  await manager.connect(stdioServer());
  assert.deepEqual(await manager.execute('mcp_fs__structured', {}), {
    content: [{ type: 'text', text: '{"rows":2}' }]
  });
  await manager.closeAll();

  const imageResource = {
    tools: [tool('img')],
    callResult: { content: [{ type: 'resource', resource: { uri: 'mem://img', blob: 'CCCC', mimeType: 'image/jpeg' } }] }
  };
  const { manager: manager2 } = createHarness(imageResource);
  await manager2.connect(stdioServer());
  assert.deepEqual(await manager2.execute('mcp_fs__img', {}), {
    content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,CCCC' } }]
  });
  await manager2.closeAll();

  const textResource = {
    tools: [tool('res')],
    callResult: { content: [{ type: 'resource', resource: { uri: 'mem://doc', text: 'body text' } }] }
  };
  const { manager: manager3 } = createHarness(textResource);
  await manager3.connect(stdioServer());
  assert.deepEqual(await manager3.execute('mcp_fs__res', {}), {
    content: [{ type: 'text', text: 'body text' }]
  });
  await manager3.closeAll();
});

test('server-side tool errors throw instead of faking success', { timeout: 8000 }, async () => {
  const { manager } = createHarness({
    tools: [tool('fail')],
    callResult: { isError: true, content: [{ type: 'text', text: 'disk on fire' }] }
  });
  await manager.connect(stdioServer());
  await assert.rejects(
    manager.execute('mcp_fs__fail', {}),
    /MCP tool "mcp_fs__fail" failed: disk on fire/
  );
  await manager.closeAll();

  // Transport/protocol level failures propagate as well.
  const { manager: manager2 } = createHarness({ tools: [tool('fail')], callError: new Error('connection closed') });
  await manager2.connect(stdioServer());
  await assert.rejects(manager2.execute('mcp_fs__fail', {}), /connection closed/);
  await manager2.closeAll();
});

test('execute can be aborted even when the client ignores the signal', { timeout: 8000 }, async () => {
  const { manager } = createHarness({ tools: [tool('hang')], callBehavior: 'hang' });
  await manager.connect(stdioServer());

  const controller = new AbortController();
  const pending = manager.execute('mcp_fs__hang', {}, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error) => error.name === 'AbortError');

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    manager.execute('mcp_fs__hang', {}, { signal: aborted.signal }),
    (error) => error.name === 'AbortError'
  );
  await manager.closeAll();
});

test('unknown tools, disconnected servers and bad arguments reject', { timeout: 8000 }, async () => {
  const { manager } = createHarness({ tools: [tool('read_file')] });
  await manager.connect(stdioServer());
  await assert.rejects(manager.execute('mcp_fs__nope', {}), /Unknown MCP tool: mcp_fs__nope/);
  await assert.rejects(manager.execute('read_file', {}), /Unknown MCP tool/);
  await assert.rejects(manager.execute('mcp_fs__read_file', 'not-an-object'), /arguments must be an object/);
  await assert.rejects(manager.execute('mcp_fs__read_file', ['array']), /arguments must be an object/);
  await manager.disconnect('fs');
  // The alias is gone with the server, so a stale name is simply unknown.
  await assert.rejects(manager.execute('mcp_fs__read_file', {}), /Unknown MCP tool: mcp_fs__read_file/);
});

test('connect failures close the transport and record a sanitized error', { timeout: 8000 }, async () => {
  const { manager, clients, transports } = createHarness({
    connectError: new Error('spawn ENOENT: mystery-binary\nsecond\ndetail line')
  });
  await assert.rejects(manager.connect(stdioServer()), /Failed to connect MCP server "fs": spawn ENOENT/);
  assert.equal(clients[0].closeCount, 1);
  assert.equal(transports[0].closed, 1);
  const status = manager.status();
  assert.equal(status.length, 1);
  assert.equal(status[0].status, 'error');
  assert.equal(status[0].toolCount, 0);
  assert.ok(status[0].error.includes('spawn ENOENT'));
  assert.ok(!status[0].error.includes('\n'));
  await manager.closeAll();

  // A failing tools/list is cleaned up the same way.
  const { manager: manager2, transports: transports2 } = createHarness({ listError: new Error('tools/list failed') });
  await assert.rejects(manager2.connect(stdioServer()), /tools\/list failed/);
  assert.equal(transports2[0].closed, 1);
  assert.equal(manager2.status()[0].status, 'error');
  await manager2.closeAll();
});

test('connect timeout closes the transport', { timeout: 8000 }, async () => {
  const { manager, clients, transports } = createHarness({ connectBehavior: 'hang' });
  manager.connectTimeoutMs = 50;
  await assert.rejects(manager.connect(stdioServer()), /connection timed out after 50ms/);
  assert.equal(clients[0].closeCount, 1);
  assert.equal(transports[0].closed, 1);
  assert.equal(manager.status()[0].status, 'error');
  await manager.closeAll();
});

test('concurrent connects share one attempt and connected ids cannot reconnect', { timeout: 8000 }, async () => {
  const { manager, clients, transports } = createHarness({ tools: [tool('x')] });
  const first = manager.connect(stdioServer());
  const second = manager.connect(stdioServer());
  assert.equal(first, second, 'concurrent connects for one id must join the same attempt');
  const summaries = await Promise.all([first, second]);
  assert.equal(summaries[0].status, 'connected');
  assert.equal(clients.length, 1);
  assert.equal(transports.length, 1);

  await assert.rejects(manager.connect(stdioServer()), /MCP server "fs" is already connected/);

  // Reconnecting after an explicit disconnect is allowed.
  await manager.disconnect('fs');
  const third = await manager.connect(stdioServer());
  assert.equal(third.status, 'connected');
  assert.equal(clients.length, 2);
  await manager.closeAll();
});

test('disconnect and closeAll release every client and transport', { timeout: 8000 }, async () => {
  const { manager, clients, transports } = createHarness(() => ({ tools: [tool('x')] }));
  await manager.connect(stdioServer({ id: 'one' }));
  await manager.connect(stdioServer({ id: 'two', name: 'Second' }));
  assert.equal(manager.toolDefinitions().length, 2);

  assert.equal(await manager.disconnect('one'), true);
  assert.equal(await manager.disconnect('missing-id'), false);
  assert.deepEqual(
    manager.status().find((entry) => entry.id === 'one'),
    { id: 'one', name: 'Filesystem', type: 'stdio', status: 'disconnected', toolCount: 0 }
  );
  assert.equal(manager.toolDefinitions().length, 1);
  assert.equal(clients[0].closeCount, 1);
  assert.equal(transports[0].closed, 1);

  await manager.closeAll();
  assert.equal(clients[1].closeCount, 1);
  assert.equal(transports[1].closed, 1);
  assert.equal(manager.toolDefinitions().length, 0);
  assert.ok(manager.status().every((entry) => entry.status === 'disconnected'));

  // Status stays sanitized: no commands, args or env values anywhere.
  const serialized = JSON.stringify(manager.status());
  assert.ok(!serialized.includes('server.js'));
  assert.ok(!serialized.includes('NANO_MCP_TEST'));
});

test('a connection that dies on its own drops its tools and rejects execution', { timeout: 8000 }, async () => {
  const { manager, clients } = createHarness({ tools: [tool('read_file')] });
  await manager.connect(stdioServer());

  clients[0].simulateError('process exited unexpectedly');
  const connected = manager.status()[0];
  assert.equal(connected.status, 'connected');
  assert.equal(connected.error, 'process exited unexpectedly');

  clients[0].simulateClose();
  assert.equal(manager.status()[0].status, 'disconnected');
  assert.equal(manager.status()[0].toolCount, 0);
  assert.equal(manager.toolDefinitions().length, 0);
  await assert.rejects(manager.execute('mcp_fs__read_file', {}), /Unknown MCP tool: mcp_fs__read_file/);
  await manager.closeAll();
});

test('config validation rejects malformed servers without registering anything', { timeout: 8000 }, async () => {
  const { manager } = createHarness();
  const cases = [
    [null, /must be an object/],
    ['string', /must be an object/],
    [{ type: 'stdio', command: 'c' }, /"id"/],
    [{ id: 'x', type: 'ws', command: 'c' }, /"stdio" or "http"/],
    [{ id: 'x', type: 'stdio' }, /"command"/],
    [{ id: 'x', type: 'stdio', command: 'c', args: ['ok', 5] }, /args must be an array of strings/],
    [{ id: 'x', type: 'stdio', command: 'c', args: 'nope' }, /args must be an array of strings/],
    [{ id: 'x', type: 'stdio', command: 'c', env: { TOKEN: 42 } }, /env values must be strings/],
    [{ id: 'x', type: 'stdio', command: 'c', env: 'nope' }, /env must be an object/],
    [{ id: 'x', type: 'stdio', command: 'c', cwd: 7 }, /cwd must be a string/],
    [{ id: 'x', type: 'stdio', command: 'c', name: 9 }, /"name"/],
    [{ id: 'x', type: 'http' }, /"url"/],
    [{ id: 'x', type: 'http', url: 'ftp://example.com/mcp' }, /http or https/],
    [{ id: 'x', type: 'http', url: 'not a url' }, /invalid url/],
    [{ id: 'x', type: 'http', url: 'file:///C:/mcp' }, /http or https/]
  ];
  for (const [server, pattern] of cases) {
    await assert.rejects(manager.connect(server), pattern);
  }
  assert.deepEqual(manager.status(), []);
  assert.deepEqual(manager.toolDefinitions(), []);
});

test('tool listing follows pagination and caps at 500 tools', { timeout: 8000 }, async () => {
  const pages = [
    { tools: Array.from({ length: 200 }, (_, index) => tool(`page0_${index}`)), nextCursor: 'page1' },
    { tools: Array.from({ length: 200 }, (_, index) => tool(`page1_${index}`)), nextCursor: 'page2' },
    { tools: Array.from({ length: 200 }, (_, index) => tool(`page2_${index}`)), nextCursor: undefined }
  ];
  const { manager, clients } = createHarness({ listBehavior: (params, callIndex) => pages[callIndex - 1] });
  const summary = await manager.connect(stdioServer({ id: 'paged' }));

  assert.equal(summary.toolCount, 500);
  assert.equal(manager.toolDefinitions().length, 500);
  assert.deepEqual(
    clients[0].listCalls.map((call) => call.params),
    [undefined, { cursor: 'page1' }, { cursor: 'page2' }]
  );
  await manager.closeAll();
});

test('default stdio transport merges process.env, passes cwd and hides the console', { timeout: 8000 }, async () => {
  const clients = [];
  const manager = new McpManager({
    // Real default transport factory; a fake client so nothing is spawned.
    clientFactory: () => {
      const client = new FakeClient({ tools: [] });
      clients.push(client);
      return client;
    }
  });
  await manager.connect({
    id: 'env-test',
    type: 'stdio',
    command: 'node',
    args: ['x.js'],
    cwd: 'C:\\temp',
    env: { NANO_TEST_TOKEN: 'secret-value' }
  });

  const transport = clients[0].transport;
  const params = transport._serverParams;
  assert.ok(params, 'expected StdioClientTransport server params');
  assert.equal(params.command, 'node');
  assert.deepEqual(params.args, ['x.js']);
  assert.equal(params.cwd, 'C:\\temp');
  assert.equal(params.env.NANO_TEST_TOKEN, 'secret-value');
  // process.env is merged underneath the configured env values.
  assert.ok(Object.keys(process.env).some((key) => params.env[key] === process.env[key]));
  // Server stderr is piped and drained instead of leaking into the host console.
  assert.equal(params.stderr, 'pipe');
  assert.ok(transport.stderr);
  // The real transport has no close counter; wrap it to observe teardown.
  let realCloses = 0;
  const originalClose = transport.close.bind(transport);
  transport.close = async () => {
    realCloses += 1;
    await originalClose();
  };
  await manager.closeAll();
  assert.ok(realCloses >= 1);
});

test('default stdio transport cleans up when the executable is missing', { timeout: 15000 }, async () => {
  const manager = new McpManager();
  manager.connectTimeoutMs = 5000;
  await assert.rejects(
    manager.connect({ id: 'missing', type: 'stdio', command: MISSING_EXE, env: { NANO_SECRET: 'hunter2-value' } }),
    /Failed to connect MCP server "missing"/
  );
  const status = manager.status();
  assert.equal(status[0].status, 'error');
  assert.ok(status[0].error);
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes('hunter2-value'), 'env values must not leak into status');
  await manager.closeAll();
});

test('default http transport cleans up after a refused connection', { timeout: 15000 }, async () => {
  const manager = new McpManager();
  manager.connectTimeoutMs = 3000;
  await assert.rejects(
    manager.connect({ id: 'refused', type: 'http', url: 'http://127.0.0.1:9/mcp' }),
    /Failed to connect MCP server "refused"/
  );
  const entry = manager.status()[0];
  assert.equal(entry.status, 'error');
  assert.ok(!('url' in entry), 'status must not expose the configured url');
  assert.ok(!('command' in entry));
  await manager.closeAll();
});

test('real SDK client handshake: identity, listing and tool round trip', { timeout: 8000 }, async () => {
  const transports = [];
  const manager = new McpManager({
    // Real default client factory; scripted JSON-RPC transport instead of a live server.
    transportFactory: () => {
      const transport = new ScriptedJsonRpcTransport({
        tools: [{
          name: 'echo',
          description: 'Echo text',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
        }]
      });
      transports.push(transport);
      return transport;
    }
  });
  const summary = await manager.connect(stdioServer({ id: 'scripted', name: 'Scripted' }));
  assert.equal(summary.status, 'connected');
  assert.equal(summary.toolCount, 1);

  const initialize = transports[0].sent.find((message) => message.method === 'initialize');
  assert.ok(initialize, 'initialize request was sent');
  assert.deepEqual(initialize.params.clientInfo, { name: 'nano-agent', version: '0.1' });
  assert.deepEqual(initialize.params.capabilities, {});

  const definitions = manager.toolDefinitions();
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0].name, 'mcp_scripted__echo');
  assert.equal(definitions[0].requiresApproval, true);

  const result = await manager.execute('mcp_scripted__echo', { text: 'hi' });
  assert.deepEqual(result, { content: [{ type: 'text', text: 'scripted ok' }] });

  const call = transports[0].sent.find((message) => message.method === 'tools/call');
  assert.deepEqual(call.params, { name: 'echo', arguments: { text: 'hi' } });

  await manager.closeAll();
  assert.ok(transports[0].closeCount >= 1);
});
