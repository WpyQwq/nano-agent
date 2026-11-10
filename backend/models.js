'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const PROVIDERS = ['openai', 'anthropic'];
const DEFAULT_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com'
};
const ANTHROPIC_VERSION = '2026-10-21';
const FILE_NAME = 'models';
// Legacy settings only ever held a single provider config, so the imported
// connection gets a stable id: reads before the first write must agree on it.
const LEGACY_CONNECTION_ID = 'legacy-settings';
const LEGACY_CONNECTION_NAME = '默认连接';
const MAX_MODELS = 1000;
const MAX_PAGES = 10;
const DEFAULT_TIMEOUT_MS = 15000;
const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high'];
// Anthropic reports effort levels low/medium/high; 'minimal' only exists for OpenAI.
const ANTHROPIC_EFFORT_MAP = { minimal: 'low', low: 'low', medium: 'medium', high: 'high' };

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function parseHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Base URL 无效：${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Base URL 必须是 http(s) 地址：${value}`);
  }
  return url;
}

function assertBaseUrl(value) {
  parseHttpUrl(value);
  return value;
}

// Mirrors backend/agent.js normalizeOpenAIBaseUrl (not exported there): strip
// /chat/completions, keep arbitrary custom paths, default host roots to /v1.
function openaiModelsEndpoint(baseUrl) {
  const value = String(baseUrl || '').trim() || DEFAULT_BASE_URLS.openai;
  const stripped = value.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  const url = parseHttpUrl(stripped);
  let pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname) pathname = '/v1';
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  return `${url.toString().replace(/\/$/, '')}/models`;
}

// Mirrors backend/agent.js normalizeAnthropicBaseUrl: the SDK appends /v1 itself,
// so a trailing /v1 or /v1/messages is removed and exactly one is added back.
function anthropicModelsEndpoint(baseUrl) {
  const value = String(baseUrl || '').trim() || DEFAULT_BASE_URLS.anthropic;
  const stripped = value.replace(/\/+$/, '').replace(/\/v1(?:\/messages)?$/i, '').replace(/\/+$/, '');
  const url = parseHttpUrl(stripped);
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  url.search = '';
  url.hash = '';
  return `${url.toString().replace(/\/$/, '')}/v1/models`;
}

function redact(text, secret) {
  const value = String(text);
  if (!secret || typeof secret !== 'string') return value;
  return value.split(secret).join('[API Key 已隐藏]');
}

function extractErrorMessage(body) {
  if (!body || typeof body !== 'object') return '';
  const error = body.error && typeof body.error === 'object' ? body.error : null;
  const candidates = [
    error?.message,
    body.message,
    typeof body.detail === 'string' ? body.detail : null,
    Array.isArray(body.detail) ? body.detail.map((item) => item?.message).filter(Boolean).join('; ') : null
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return '';
}

async function httpErrorMessage(response, secret) {
  const status = Number.isFinite(Number(response.status)) ? Number(response.status) : 'HTTP';
  let detail = '';
  try {
    detail = extractErrorMessage(await response.json());
  } catch {
    try {
      if (typeof response.text === 'function') detail = String((await response.text()) || '').trim().slice(0, 200);
    } catch { /* body unavailable */ }
  }
  const suffix = detail ? `：${detail}` : '';
  return new Error(redact(`获取模型列表失败（HTTP ${status}）${suffix}`, secret));
}

function networkErrorMessage(error, secret, url) {
  const parts = [];
  if (error?.message) parts.push(String(error.message));
  if (error?.cause?.message) parts.push(String(error.cause.message));
  const text = parts.join('：') || '未知网络错误';
  return new Error(redact(`获取模型列表失败（${url}）：${text}`, secret));
}

// Only context sizes the provider explicitly reported are accepted; max_tokens is
// deliberately excluded because it describes output, not the input window.
function readContextWindow(raw) {
  const candidates = [
    raw.context_window,
    raw.contextWindow,
    raw.context_length,
    raw.contextLength,
    raw.max_context_tokens,
    raw.max_model_len,
    raw.max_input_tokens,
    raw.top_provider && typeof raw.top_provider === 'object' && !Array.isArray(raw.top_provider)
      ? raw.top_provider.context_length
      : undefined
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    if (typeof candidate !== 'number' && typeof candidate !== 'string') continue;
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return Math.trunc(value);
  }
  return null;
}

function normalizeModelEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const name = firstNonEmptyString(raw.name, raw.display_name, raw.displayName) || id;
  const contextWindow = readContextWindow(raw);
  return contextWindow ? { id, name, contextWindow } : { id, name };
}

function normalizeModels(entries) {
  const seen = new Set();
  const models = [];
  for (const raw of Array.isArray(entries) ? entries : []) {
    const model = normalizeModelEntry(raw);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

function sanitizeModel(model) {
  if (!model || typeof model !== 'object') return null;
  const id = typeof model.id === 'string' ? model.id.trim() : '';
  if (!id) return null;
  return {
    id,
    name: typeof model.name === 'string' && model.name.trim() !== '' ? model.name : id,
    ...(Number(model.contextWindow) > 0 ? { contextWindow: model.contextWindow } : {})
  };
}

function sanitizeConnection(connection) {
  return {
    id: connection.id,
    name: connection.name,
    provider: connection.provider,
    ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
    hasApiKey: Boolean(connection.encryptedKey),
    ...(connection.model ? { model: connection.model } : {}),
    ...(Number(connection.contextWindow) > 0 ? { contextWindow: connection.contextWindow } : {}),
    ...(typeof connection.supportsEffort === 'boolean' ? {supportsEffort:connection.supportsEffort} : {}),
    ...(Array.isArray(connection.models) && connection.models.length
      ? { models: connection.models.map(sanitizeModel).filter(Boolean) }
      : {}),
    ...(connection.discoveredAt ? { discoveredAt: connection.discoveredAt } : {}),
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt
  };
}

class ModelConnections {
  constructor(options = {}) {
    if (!options || typeof options !== 'object') throw new TypeError('ModelConnections 配置必须是一个对象');
    if (!options.store) throw new TypeError('ModelConnections 需要 store 实例');
    this.store = options.store;
    this.fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : (typeof fetch === 'function' ? fetch : null);
    const timeout = Number(options.timeoutMs);
    this.timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS;
  }

  async list() {
    return this.#enqueue(async () => {
      const { doc } = await this.#loadDocument();
      return doc.connections.map(sanitizeConnection);
    });
  }

  async save(input = {}) {
    return this.#enqueue(async () => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('连接配置必须是一个对象');
      const { doc } = await this.#loadDocument();
      const connections = doc.connections;
      const now = Date.now();

      const rawId = input.id;
      const hasId = rawId !== undefined && rawId !== null && String(rawId).trim() !== '';
      const id = hasId ? String(rawId).trim() : randomUUID();
      const index = hasId ? connections.findIndex((item) => item.id === id) : -1;
      if (hasId && index < 0) throw new Error(`连接不存在：${id}`);
      const existing = index >= 0 ? connections[index] : null;

      let provider = existing?.provider;
      const rawProvider = input.provider;
      if (rawProvider !== undefined && rawProvider !== null && String(rawProvider).trim() !== '') {
        provider = String(rawProvider).trim().toLowerCase();
      }
      if (!provider || !PROVIDERS.includes(provider)) {
        throw new Error(`不支持的模型提供方：${provider || '(未指定)'}，仅支持 openai 或 anthropic`);
      }

      let name = existing?.name;
      const rawName = input.name;
      if (rawName !== undefined && rawName !== null) {
        if (typeof rawName !== 'string') throw new Error('连接名称必须是字符串');
        name = rawName.trim();
      }
      if (!name) throw new Error('连接名称不能为空');

      let baseUrl = existing?.baseUrl;
      const rawBase = input.baseUrl;
      if (rawBase !== undefined && rawBase !== null) {
        if (typeof rawBase !== 'string') throw new Error('Base URL 必须是字符串');
        const trimmed = rawBase.trim();
        baseUrl = trimmed === '' ? undefined : assertBaseUrl(trimmed);
      }

      let model = existing?.model;
      const rawModel = input.model;
      if (rawModel !== undefined && rawModel !== null) {
        if (typeof rawModel !== 'string') throw new Error('模型名称必须是字符串');
        const trimmed = rawModel.trim();
        model = trimmed === '' ? undefined : trimmed;
      }

      let contextWindow = existing?.contextWindow;
      const rawWindow = input.contextWindow;
      if (rawWindow !== undefined && rawWindow !== null) {
        if (rawWindow === '' || rawWindow === 0 || rawWindow === '0') {
          contextWindow = undefined; // explicit "no known window"
        } else {
          const parsed = Number(rawWindow);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            throw new Error(`contextWindow 必须是正整数（真实模型元数据）：${String(rawWindow)}`);
          }
          contextWindow = parsed;
        }
      }
      // The stored window described the previously selected model.
      if (model !== existing?.model && (rawWindow === undefined || rawWindow === null)) {
        contextWindow = undefined;
      }

      // Blank means "keep the stored secret"; only a non-empty key re-encrypts.
      let encryptedKey = existing?.encryptedKey;
      if (input.clearApiKey) encryptedKey = undefined;
      const rawKey = input.apiKey;
      if (rawKey !== undefined && rawKey !== null) {
        if (typeof rawKey !== 'string') throw new Error('API Key 必须是字符串');
        if (rawKey.trim() !== '') {
          if (!this.store.encryption.isEncryptionAvailable()) throw new Error('系统加密不可用，密钥未保存');
          encryptedKey = this.store.encryption.encryptString(rawKey.trim()).toString('base64');
        }
      }

      // Cached discovery results describe one endpoint; drop them when it moves.
      const providerChanged = Boolean(existing) && existing.provider !== provider;
      const baseUrlChanged = Boolean(existing) && (existing.baseUrl || undefined) !== (baseUrl || undefined);
      const keepCache = !providerChanged && !baseUrlChanged;

      const record = {
        id,
        name,
        provider,
        ...(baseUrl ? { baseUrl } : {}),
        ...(model ? { model } : {}),
        ...(encryptedKey ? { encryptedKey } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(keepCache && existing?.models?.length ? { models: existing.models } : {}),
        ...(keepCache && existing?.discoveredAt ? { discoveredAt: existing.discoveredAt } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      if(typeof input.supportsEffort==='boolean')record.supportsEffort=input.supportsEffort;
      else if(typeof existing?.supportsEffort==='boolean')record.supportsEffort=existing.supportsEffort;
      if(Array.isArray(input.models))record.models=normalizeModels(input.models);
      if (existing) connections[index] = record; else connections.push(record);
      await this.#writeDocument(doc);
      return sanitizeConnection(record);
    });
  }

  async remove(id) {
    return this.#enqueue(async () => {
      const { doc } = await this.#loadDocument();
      const target = String(id ?? '').trim();
      const index = doc.connections.findIndex((item) => item.id === target);
      if (index < 0) throw new Error(`连接不存在：${target || '(未指定)'}`);
      const [removed] = doc.connections.splice(index, 1);
      await this.#writeDocument(doc);
      return sanitizeConnection(removed);
    });
  }

  async discover(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('发现请求必须是一个对象');
    // Phase 1: resolve provider/baseUrl/key under the store queue; never hold the
    // queue during network I/O (settings/task writes must not wait on a request).
    const request = await this.#enqueue(async () => {
      const { doc } = await this.#loadDocument();
      const rawId = input.id;
      const id = rawId === undefined || rawId === null || String(rawId).trim() === ''
        ? null
        : String(rawId).trim();
      const connection = id ? doc.connections.find((item) => item.id === id) || null : null;
      if (id && !connection) throw new Error(`连接不存在：${id}`);

      const rawProvider = input.provider;
      const provider = rawProvider === undefined || rawProvider === null || String(rawProvider).trim() === ''
        ? connection?.provider
        : String(rawProvider).trim().toLowerCase();
      if (!provider || !PROVIDERS.includes(provider)) {
        throw new Error(`不支持的模型提供方：${provider || '(未指定)'}，仅支持 openai 或 anthropic`);
      }
      if (connection && connection.provider !== provider) {
        throw new Error(`提供方 ${provider} 与已保存连接（${connection.provider}）不一致`);
      }

      const rawBase = input.baseUrl;
      let baseUrl;
      if (rawBase === undefined || rawBase === null || String(rawBase).trim() === '') {
        baseUrl = connection?.baseUrl;
      } else {
        if (typeof rawBase !== 'string') throw new Error('Base URL 必须是字符串');
        baseUrl = assertBaseUrl(rawBase.trim());
      }

      let apiKey;
      const rawKey = input.apiKey;
      if (rawKey === undefined || rawKey === null || String(rawKey).trim() === '') {
        // Testing a saved connection reuses its encrypted key.
        if (connection?.encryptedKey) apiKey = this.#decryptKey(connection.encryptedKey);
      } else if (typeof rawKey !== 'string') {
        throw new Error('API Key 必须是字符串');
      } else {
        apiKey = rawKey.trim();
      }

      return { id, provider, ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}) };
    });

    const models = request.provider === 'anthropic'
      ? await this.#discoverAnthropic(request)
      : await this.#discoverOpenAI(request);

    // Phase 3: cache results for the saved connection; the request key itself is
    // never persisted here, only the model list it produced.
    if (request.id) {
      await this.#enqueue(async () => {
        const { doc } = await this.#loadDocument();
        const connection = doc.connections.find((item) => item.id === request.id);
        if (!connection) return; // removed while the request was in flight
        connection.models = models;
        connection.discoveredAt = Date.now();
        connection.updatedAt = connection.discoveredAt;
        await this.#writeDocument(doc);
      });
    }
    return models;
  }

  async resolve(id, model, effort) {
    return this.#enqueue(async () => {
      const { doc } = await this.#loadDocument();
      const target = String(id ?? '').trim();
      const connection = doc.connections.find((item) => item.id === target);
      if (!connection) throw new Error(`连接不存在：${target || '(未指定)'}`);

      const selectedModel = firstNonEmptyString(model, connection.model) || '';
      if (!selectedModel) throw new Error('尚未选择模型名称（model）');

      let effortLevel = null;
      if (effort !== undefined && effort !== null && String(effort).trim() !== '') {
        effortLevel = String(effort).trim().toLowerCase();
        if (!EFFORT_LEVELS.includes(effortLevel)) {
          throw new Error(`不支持的努力程度：${effortLevel}，可选 ${EFFORT_LEVELS.join('、')}`);
        }
      }

      const apiKey = connection.encryptedKey ? this.#decryptKey(connection.encryptedKey) : undefined;
      // Only surface a context window that real metadata actually reported.
      const metadata = Array.isArray(connection.models)
        ? connection.models.find((item) => item && item.id === selectedModel)
        : null;
      const contextWindow = Number(connection.contextWindow) > 0 ? connection.contextWindow : (Number(metadata?.contextWindow) > 0 ? metadata.contextWindow : undefined);

      const config = {
        provider: connection.provider,
        model: selectedModel,
        ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(effortLevel ? { effort: effortLevel } : {})
      };
      if(connection.supportsEffort === true)config.forceReasoningEffort=true;
      if (effortLevel && effortLevel !== 'none') {
        if (connection.provider === 'openai') config.reasoningEffort = effortLevel;
        else config.outputConfig = { effort: ANTHROPIC_EFFORT_MAP[effortLevel] };
      }
      return config;
    });
  }

  async #discoverOpenAI({ baseUrl, apiKey }) {
    const endpoint = openaiModelsEndpoint(baseUrl);
    const headers = { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
    const body = await this.#requestJson(endpoint, headers, apiKey);
    const data = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
    if (!data) throw new Error(`模型列表响应格式无效（缺少 data 数组）：${endpoint}`);
    return normalizeModels(data);
  }

  async #discoverAnthropic({ baseUrl, apiKey }) {
    const endpoint = anthropicModelsEndpoint(baseUrl);
    const headers = {
      'anthropic-version': ANTHROPIC_VERSION,
      ...(apiKey ? { 'x-api-key': apiKey } : {})
    };
    const entries = [];
    let afterId = null;
    for (let page = 0; page < MAX_PAGES && entries.length < MAX_MODELS; page += 1) {
      const url = new URL(endpoint);
      url.searchParams.set('limit', String(MAX_MODELS));
      if (afterId) url.searchParams.set('after_id', afterId);
      const body = await this.#requestJson(url.toString(), headers, apiKey);
      const data = Array.isArray(body?.data) ? body.data : null;
      if (!data) throw new Error(`模型列表响应格式无效（缺少 data 数组）：${url.toString()}`);
      entries.push(...data);
      if (!body.has_more || !body.last_id) break;
      afterId = String(body.last_id);
    }
    return normalizeModels(entries);
  }

  async #requestJson(url, headers, secret) {
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('当前环境没有可用的 fetch 实现，无法获取模型列表');
    }
    const controller = new AbortController();
    const timeoutMs = Number.isFinite(Number(this.timeoutMs)) && this.timeoutMs > 0 ? this.timeoutMs : DEFAULT_TIMEOUT_MS;
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`获取模型列表超时（${timeoutMs}ms）：${url}`));
      }, timeoutMs);
    });
    // The work promise never rejects by itself, so a lost race cannot produce an
    // unhandled rejection while the request keeps running in the background.
    const work = (async () => {
      try {
        const response = await this.fetchImpl(url, { headers, signal: controller.signal });
        if (!response || typeof response !== 'object' || typeof response.json !== 'function') {
          throw new Error('fetch 实现未返回有效响应');
        }
        if (!response.ok) throw await httpErrorMessage(response, secret);
        try {
          return { body: await response.json() };
        } catch {
          throw new Error(`模型列表响应不是有效 JSON：${url}`);
        }
      } catch (error) {
        return { error: error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
          ? new Error(`请求模型列表已中止：${url}`)
          : networkErrorMessage(error, secret, url) };
      }
    })();
    try {
      const outcome = await Promise.race([work, timeout]);
      if (outcome.error) throw outcome.error;
      return outcome.body;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #decryptKey(encryptedKey) {
    try {
      return this.store.encryption.decryptString(Buffer.from(encryptedKey, 'base64'));
    } catch (error) {
      throw new Error(`无法解密已保存的 API Key：${error?.message || error}`);
    }
  }

  // Reads the dedicated models.json. When it has never been written, the legacy
  // settings provider/model/baseUrl/encryptedKey are imported lazily as the first
  // connection; settings.json itself is never modified and no plaintext is stored.
  async #loadDocument() {
    const doc = await this.store.read(FILE_NAME, null);
    if (doc === null || doc === undefined) {
      const legacy = await this.store.read('settings', {});
      const source = legacy && typeof legacy === 'object' ? legacy : {};
      const provider = String(source.provider || '').trim().toLowerCase();
      const connections = [];
      if (PROVIDERS.includes(provider) && typeof source.encryptedKey === 'string' && source.encryptedKey.trim() !== '') {
        const now = Date.now();
        connections.push({
          id: LEGACY_CONNECTION_ID,
          name: LEGACY_CONNECTION_NAME,
          provider,
          ...(typeof source.baseUrl === 'string' && source.baseUrl.trim() !== '' ? { baseUrl: source.baseUrl.trim() } : {}),
          ...(typeof source.model === 'string' && source.model.trim() !== '' ? { model: source.model.trim() } : {}),
          ...(typeof source.model === 'string' && source.model.trim() !== '' ? { models: [{ id: source.model.trim(), name: source.model.trim() }] } : {}),
          encryptedKey: source.encryptedKey,
          createdAt: now,
          updatedAt: now
        });
      }
      return { doc: { version: 1, connections } };
    }
    if (typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.connections)) {
      throw new Error('模型连接数据格式无效');
    }
    return { doc };
  }

  #writeDocument(doc) {
    return (async () => {
      await fs.mkdir(this.store.directory, { recursive: true });
      const target = path.join(this.store.directory, `${FILE_NAME}.json`);
      await fs.writeFile(`${target}.tmp`, JSON.stringify({ ...doc, version: doc.version ?? 1 }, null, 2), 'utf8');
      await fs.rename(`${target}.tmp`, target);
    })();
  }

  // All reads and writes run through the store's own serialization queue so
  // models.json never sees a stale read-modify-write. Nested queued calls (for
  // example store.write from inside an operation) would deadlock, so operations
  // only touch the file system and non-queued store reads directly.
  #enqueue(action) {
    const previous = this.store.queue || Promise.resolve();
    const operation = previous.catch(() => {}).then(action);
    this.store.queue = operation;
    return operation;
  }
}

module.exports = { ModelConnections };
