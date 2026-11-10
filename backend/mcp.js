'use strict';

/**
 * MCP tool connection manager for the Nano agent.
 *
 * Owns the lifecycle of external MCP servers: connecting on demand (never automatically),
 * listing tools into agent-ready tool definitions, executing tool calls through the
 * official Model Context Protocol SDK, and releasing subprocesses on disconnect.
 *
 * The lifecycle follows the opencode MCP client architecture (MIT): connections are
 * explicit, a failed connect closes the transport, and a connection that dies on its
 * own is reported through status() instead of being silently reused.
 */

const { createHash } = require('node:crypto');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const CLIENT_NAME = 'nano-agent';
const CLIENT_VERSION = '0.1';
const CONNECT_TIMEOUT_MS = 15000;
const LIST_TIMEOUT_MS = 15000;
const CALL_TIMEOUT_MS = 60000;
const MAX_TOOLS_PER_SERVER = 500;
const MAX_TOOL_NAME_LENGTH = 64;
const MAX_ERROR_LENGTH = 300;
const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

function abortError(message = 'Operation cancelled') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function errorMessage(error) {
  if (!error) return 'Unknown error';
  return String(error.message || error);
}

// One-line, length-capped messages with URL credentials redacted; safe for status() output.
function sanitizeMessage(text) {
  let message = String(text || 'Unknown error').replace(/[\r\n]+/g, ' ').trim();
  message = message.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi, '$1***@');
  return message.slice(0, MAX_ERROR_LENGTH) || 'Unknown error';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeJsonStringify(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

// Rejects when the signal fires, even if the wrapped promise ignores it.
function withAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  if (signal.aborted) return Promise.reject(abortError());
  let listener;
  const aborted = new Promise((_, reject) => {
    listener = () => reject(abortError());
    signal.addEventListener('abort', listener, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    if (listener) signal.removeEventListener('abort', listener);
  });
}

// A hard wall around the whole connect attempt, including process spawn.
function withTimeout(promise, timeoutMs, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(promise);
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer));
}

function stableHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

// OpenAI/LangChain tool names allow [a-zA-Z0-9_-]; everything else becomes '_'.
function normalizeSegment(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function suffixAlias(base, identity, attempt) {
  // Leave room for '_' plus 8 hash characters under the 64 character tool name limit.
  const stem = base.slice(0, MAX_TOOL_NAME_LENGTH - 9);
  return `${stem}_${stableHash(`${identity}#${attempt}`)}`;
}

function sanitizeInputSchema(schema) {
  if (!isPlainObject(schema)) return { type: 'object', properties: {} };
  const copy = { ...schema };
  copy.type = 'object';
  if (!isPlainObject(copy.properties)) copy.properties = {};
  if ('required' in copy && (!Array.isArray(copy.required) || !copy.required.every((key) => typeof key === 'string'))) {
    delete copy.required;
  }
  return copy;
}

// Keeps only tools with a usable name and schema; a malformed entry never fails the whole list.
function normalizeListedTool(tool, serverId) {
  if (!isPlainObject(tool)) return null;
  if (typeof tool.name !== 'string' || !tool.name.trim()) return null;
  const annotations = isPlainObject(tool.annotations) ? tool.annotations : {};
  return {
    name: tool.name,
    description: typeof tool.description === 'string' && tool.description.trim()
      ? tool.description
      : `MCP tool "${tool.name}" from server "${serverId}"`,
    inputSchema: sanitizeInputSchema(tool.inputSchema),
    readOnlyHint: annotations.readOnlyHint === true
  };
}

// Follows tools/list pagination cursors and stops at the cap so a hostile server cannot
// exhaust memory with an endless list.
async function listTools(client, serverId, timeoutMs, signal, limit) {
  const tools = [];
  let cursor;
  do {
    const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs, signal });
    const page = Array.isArray(result?.tools) ? result.tools : [];
    for (const tool of page) {
      if (tools.length >= limit) break;
      const normalized = normalizeListedTool(tool, serverId);
      if (normalized) tools.push(normalized);
    }
    cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
  } while (cursor && tools.length < limit);
  return tools;
}

function normalizeArguments(input, alias) {
  if (input == null) return {};
  if (!isPlainObject(input)) {
    throw new Error(`MCP tool "${alias}" arguments must be an object`);
  }
  return input;
}

// MCP content parts become LangChain message content: text stays text, images become
// data URLs; anything the chat models cannot show degrades to text instead of being lost.
function normalizeContentPart(part) {
  if (!isPlainObject(part)) return null;
  if (part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
  if (part.type === 'image' && typeof part.data === 'string' && typeof part.mimeType === 'string') {
    return { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } };
  }
  if (part.type === 'resource' && isPlainObject(part.resource)) {
    const resource = part.resource;
    if (typeof resource.text === 'string') return { type: 'text', text: resource.text };
    if (typeof resource.blob === 'string' && typeof resource.mimeType === 'string'
      && String(resource.mimeType).startsWith('image/')) {
      return { type: 'image_url', image_url: { url: `data:${resource.mimeType};base64,${resource.blob}` } };
    }
    if (typeof resource.uri === 'string') return { type: 'text', text: resource.uri };
    return null;
  }
  if (part.type === 'resource_link' && typeof part.uri === 'string') return { type: 'text', text: part.uri };
  if (part.type === 'audio') return { type: 'text', text: '[audio content omitted]' };
  const json = safeJsonStringify(part);
  return json ? { type: 'text', text: json } : null;
}

function normalizeToolResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const parts = [];
  for (const part of content) {
    const normalized = normalizeContentPart(part);
    if (normalized) parts.push(normalized);
  }
  if (!parts.length && isPlainObject(result?.structuredContent)) {
    parts.push({ type: 'text', text: safeJsonStringify(result.structuredContent) });
  }
  if (!parts.length) parts.push({ type: 'text', text: safeJsonStringify(result ?? null) });
  return { content: parts };
}

function resultText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join(' ')
    .trim();
  return text || sanitizeMessage(safeJsonStringify(result));
}

function validateServer(server) {
  if (!isPlainObject(server)) {
    throw new Error('MCP server config must be an object');
  }
  const id = server.id;
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('MCP server config requires a non-empty string "id"');
  }
  let name = id;
  if (server.name !== undefined) {
    if (typeof server.name !== 'string' || !server.name.trim()) {
      throw new Error(`MCP server "${id}" requires a non-empty string "name" when provided`);
    }
    name = server.name;
  }
  const type = server.type;
  if (type !== 'stdio' && type !== 'http') {
    throw new Error(`MCP server "${id}" type must be "stdio" or "http"`);
  }
  const config = { id, name, type, readOnly: server.readOnly === true };
  if (type === 'stdio') {
    if (typeof server.command !== 'string' || !server.command.trim()) {
      throw new Error(`MCP server "${id}" (stdio) requires a non-empty string "command"`);
    }
    config.command = server.command;
    if (server.args !== undefined && !Array.isArray(server.args)) {
      throw new Error(`MCP server "${id}" args must be an array of strings`);
    }
    config.args = (server.args ?? []).map((arg) => {
      if (typeof arg !== 'string') {
        throw new Error(`MCP server "${id}" args must be an array of strings`);
      }
      return arg;
    });
    if (server.env !== undefined && !isPlainObject(server.env)) {
      throw new Error(`MCP server "${id}" env must be an object with string values`);
    }
    config.env = {};
    for (const [key, value] of Object.entries(server.env ?? {})) {
      if (typeof value !== 'string') {
        throw new Error(`MCP server "${id}" env values must be strings (key: ${key})`);
      }
      config.env[key] = value;
    }
    if (server.cwd !== undefined && typeof server.cwd !== 'string') {
      throw new Error(`MCP server "${id}" cwd must be a string`);
    }
    config.cwd = typeof server.cwd === 'string' && server.cwd.trim() ? server.cwd : undefined;
  } else {
    if (typeof server.url !== 'string' || !server.url.trim()) {
      throw new Error(`MCP server "${id}" (http) requires a non-empty string "url"`);
    }
    const url = server.url.trim();
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`MCP server "${id}" has an invalid url: ${url}`);
    }
    if (!HTTP_PROTOCOLS.has(parsed.protocol)) {
      throw new Error(`MCP server "${id}" url protocol must be http or https`);
    }
    config.url = url;
  }
  return config;
}

function defaultClientFactory() {
  return new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
}

function defaultTransportFactory(server) {
  if (server.type === 'stdio') {
    // The SDK spawns with windowsHide on win32. process.env is merged under the configured
    // env so PATH & co. keep working; env values are never logged or reported anywhere.
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      cwd: server.cwd,
      env: { ...process.env, ...server.env },
      stderr: 'pipe'
    });
    // Drain server stderr silently so it cannot leak into the host process console.
    transport.stderr?.resume?.();
    return transport;
  }
  return new StreamableHTTPClientTransport(new URL(server.url));
}

// Closes the client and transport best-effort; both are idempotent and failures are ignored.
async function release(state) {
  const client = state.client;
  const transport = state.transport;
  state.client = null;
  state.transport = null;
  try {
    if (client && typeof client.close === 'function') await client.close();
  } catch { /* teardown is best-effort */ }
  try {
    if (transport && typeof transport.close === 'function') await transport.close();
  } catch { /* teardown is best-effort */ }
}

/**
 * Manages MCP server connections and exposes their tools to the agent runtime.
 *
 * Servers are only contacted when connect() is called; the manager never starts anything
 * on its own. toolDefinitions() output feeds AgentRuntime directly (requiresApproval is a
 * top-level field), and execute() maps the exposed tool names back to the original MCP
 * tool names on the server that listed them.
 */
class McpManager {
  /**
   * @param {object} [options]
   * @param {(server: object) => object} [options.clientFactory]  Creates an MCP client
   *   (SDK Client by default); injectable for offline tests.
   * @param {(server: object) => object} [options.transportFactory]  Creates a transport
   *   (StdioClientTransport / StreamableHTTPClientTransport by default); injectable for
   *   offline tests.
   */
  constructor(options = {}) {
    if (!isPlainObject(options)) throw new TypeError('McpManager options must be an object');
    this.clientFactory = typeof options.clientFactory === 'function' ? options.clientFactory : defaultClientFactory;
    this.transportFactory = typeof options.transportFactory === 'function' ? options.transportFactory : defaultTransportFactory;
    this.connectTimeoutMs = CONNECT_TIMEOUT_MS;
    this.listTimeoutMs = LIST_TIMEOUT_MS;
    this.callTimeoutMs = CALL_TIMEOUT_MS;
    /** @type {Map<string, object>} server id -> connection state */
    this.servers = new Map();
    /** @type {Map<string, {serverId: string, name: string}>} exposed alias -> original tool */
    this.index = new Map();
    /** @type {Map<string, string>} server/tool identity -> alias, frozen once assigned */
    this.assigned = new Map();
    /** @type {Array<object>} */
    this.definitions = [];
  }

  /**
   * Connects one MCP server and lists its tools. Concurrent calls for the same id share
   * the in-flight attempt; connecting an id that is already connected is rejected.
   * Resolves with the sanitized server status, rejects (with the transport closed) on
   * failure.
   *
   * @param {{id: string, name?: string, type: 'stdio'|'http', command?: string, args?: string[],
   *   env?: Record<string,string>, cwd?: string, url?: string, readOnly?: boolean}} server
   */
  connect(server) {
    let config;
    try {
      config = validateServer(server);
    } catch (error) {
      return Promise.reject(error);
    }
    const existing = this.servers.get(config.id);
    if (existing?.connecting) return existing.connecting;
    if (existing?.status === 'connected') {
      return Promise.reject(new Error(`MCP server "${config.id}" is already connected`));
    }
    const state = {
      id: config.id,
      name: config.name,
      type: config.type,
      readOnly: config.readOnly,
      status: 'connecting',
      error: null,
      tools: [],
      client: null,
      transport: null,
      connecting: null,
      controller: new AbortController()
    };
    this.servers.set(config.id, state);
    state.connecting = this.#open(state, config).finally(() => {
      state.connecting = null;
      state.controller = null;
    });
    return state.connecting;
  }

  /**
   * Tool definitions for the agent runtime (OpenAI function shape with a top-level
   * requiresApproval flag). Names are `mcp_<serverId>__<toolName>` with stable hash
   * suffixes when normalization collides.
   */
  toolDefinitions() {
    return this.definitions.map((definition) => ({ ...definition }));
  }

  /**
   * Executes an exposed MCP tool. Unknown names reject; a server-side tool error
   * (isError) throws instead of faking success; the call is abortable through signal.
   *
   * @param {string} name Exposed tool name (from toolDefinitions()).
   * @param {object} input Tool arguments object.
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<{content: Array<object>}>} LangChain-compatible content array.
   */
  async execute(name, input, options = {}) {
    const alias = String(name ?? '');
    const target = this.index.get(alias);
    if (!target) throw new Error(`Unknown MCP tool: ${alias}`);
    const state = this.servers.get(target.serverId);
    if (!state || state.status !== 'connected' || !state.client) {
      throw new Error(`MCP server "${target.serverId}" is not connected`);
    }
    const args = normalizeArguments(input, alias);
    const signal = options?.signal;
    if (signal?.aborted) throw abortError();
    const result = await withAbort(
      Promise.resolve(state.client.callTool(
        { name: target.name, arguments: args },
        undefined,
        { signal, timeout: this.callTimeoutMs }
      )),
      signal
    );
    if (result?.isError) {
      throw new Error(`MCP tool "${alias}" failed: ${resultText(result)}`);
    }
    return normalizeToolResult(result);
  }

  /**
   * Sanitized server statuses. Never includes commands, arguments, environment values
   * or URLs, so no configured secret can leak through it.
   */
  status() {
    return Array.from(this.servers.values()).map((state) => ({
      id: state.id,
      name: state.name,
      type: state.type,
      status: state.status,
      toolCount: state.status === 'connected' ? state.tools.length : 0,
      ...(state.error ? { error: state.error } : {})
    }));
  }

  /**
   * Disconnects one server and releases its subprocess/transport. Unknown ids resolve
   * false. A connect still in flight is aborted and waited for first.
   */
  async disconnect(id) {
    const state = this.servers.get(String(id ?? ''));
    if (!state) return false;
    if (state.controller) state.controller.abort();
    if (state.connecting) {
      try { await state.connecting; } catch { /* the failure path already cleaned up */ }
    }
    state.status = 'disconnected';
    state.tools = [];
    state.error = null;
    await release(state);
    this.#reindex();
    return true;
  }

  /** Disconnects every server and releases all subprocesses. */
  async closeAll() {
    const ids = Array.from(this.servers.keys());
    await Promise.all(ids.map((id) => this.disconnect(id)));
  }

  async #open(state, config) {
    const signal = state.controller.signal;
    try {
      const transport = this.transportFactory(config);
      const client = this.clientFactory(config);
      state.transport = transport;
      state.client = client;
      // Only a close while connected is unexpected; failures during connect are handled below.
      client.onclose = () => this.#handleClosed(state);
      client.onerror = (error) => {
        if (state.status === 'connected') state.error = sanitizeMessage(errorMessage(error));
      };
      await withTimeout(
        withAbort(
          Promise.resolve(client.connect(transport, { timeout: this.connectTimeoutMs, signal })),
          signal
        ),
        this.connectTimeoutMs,
        `connection timed out after ${this.connectTimeoutMs}ms`
      );
      state.tools = await listTools(client, state.id, this.listTimeoutMs, signal, MAX_TOOLS_PER_SERVER);
      state.status = 'connected';
      state.error = null;
      this.#reindex();
      return {
        id: state.id,
        name: state.name,
        type: state.type,
        status: 'connected',
        toolCount: state.tools.length
      };
    } catch (error) {
      const failure = sanitizeMessage(`Failed to connect MCP server "${config.id}": ${errorMessage(error)}`);
      state.status = 'error';
      state.error = failure;
      state.tools = [];
      await release(state);
      this.#reindex();
      throw new Error(failure, { cause: error });
    }
  }

  // The transport died on its own: drop the tools so callers stop using a dead connection.
  #handleClosed(state) {
    if (state.status !== 'connected') return;
    state.status = 'disconnected';
    state.tools = [];
    state.client = null;
    state.transport = null;
    this.#reindex();
  }

  // Rebuilds alias -> original tool mapping and the runtime definitions. Aliases are
  // assigned once per server+tool identity and frozen: a reconnect or a later collision
  // never renames a tool the agent may already be calling. Colliding or over-length base
  // names get a stable hash suffix of the full identity, so aliases stay collision-
  // resistant and deterministic.
  #reindex() {
    const entries = [];
    for (const state of this.servers.values()) {
      if (state.status !== 'connected') continue;
      for (const tool of state.tools) entries.push({ state, tool });
    }
    const baseNames = entries.map((entry) =>
      `mcp_${normalizeSegment(entry.state.id)}__${normalizeSegment(entry.tool.name)}`);
    const collisions = new Map();
    for (const base of baseNames) collisions.set(base, (collisions.get(base) || 0) + 1);
    // Frozen aliases stay reserved so a new tool cannot steal a name an older identity
    // will reclaim when its server reconnects.
    const used = new Set(this.assigned.values());
    const index = new Map();
    const definitions = [];
    entries.forEach((entry, position) => {
      const base = baseNames[position];
      const identity = JSON.stringify([entry.state.id, entry.tool.name]);
      let alias = this.assigned.get(identity);
      if (alias === undefined) {
        alias = base;
        if (alias.length > MAX_TOOL_NAME_LENGTH || collisions.get(base) > 1) {
          alias = suffixAlias(base, identity, 0);
        }
        let attempt = 0;
        while (used.has(alias)) {
          attempt += 1;
          alias = suffixAlias(base, identity, attempt);
        }
        this.assigned.set(identity, alias);
      }
      used.add(alias);
      index.set(alias, { serverId: entry.state.id, name: entry.tool.name });
      definitions.push({
        name: alias,
        description: entry.tool.description,
        parameters: entry.tool.inputSchema,
        // External tools always require approval unless the server opts into read-only
        // AND the tool itself declares a read-only hint.
        requiresApproval: !(entry.state.readOnly && entry.tool.readOnlyHint)
      });
    });
    this.index = index;
    this.definitions = definitions;
  }
}

module.exports = { McpManager };
