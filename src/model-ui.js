'use strict';

/*
 * Model connection UI.
 * Loaded by index.html; the host calls NanoModels.init(...) after settings load.
 * All user/service-provided strings are escaped before entering HTML.
 */
(() => {
  const EFFORTS = ['default', 'low', 'medium', 'high'];
  const EFFORT_LABELS = { default: '默认', low: '低', medium: '中', high: '高' };
  const PROVIDERS = [
    { value: 'openai', label: 'OpenAI / 兼容接口' },
    { value: 'anthropic', label: 'Anthropic' },
  ];

  const $ = (id) => document.getElementById(id);
  const state = {
    api: null,
    toast: null,
    icons: null,
    showView: null,
    onSelect: null,
    getConfig: null,
    config: {},
    connections: [],
    connectionsError: '',
    loadingConnections: false,
    loadSeq: 0,
    selected: { connectionId: '', model: '', effort: 'default' },
    settingsMode: 'list',
    draft: null,
    activeId: null,
    discovery: { status: 'idle', message: '' },
    discoveryTimer: 0,
    discoverySeq: 0,
    picker: null,
    pickerView: 'effort',
    pickerFocus: '',
    saving: false,
    bound: false,
    initialized: false,
    renderingButton: false,
    buttonObserver: null,
    deleteTimer: 0
  };

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));

  const icon = (name) => `<i data-lucide="${name}" aria-hidden="true"></i>`;

  function renderIcons() {
    try {
      if (typeof state.icons === 'function') state.icons();
      else if (window.lucide?.createIcons) window.lucide.createIcons({ attrs: { 'aria-hidden': 'true' } });
    } catch {
      /* Icons are decorative; a missing icon set must not break the UI. */
    }
  }

  function notify(message) {
    if (!message) return;
    if (typeof state.toast === 'function') {
      try { state.toast(message); return; } catch { /* fall through */ }
    }
    const target = $('toast');
    if (!target) return;
    target.textContent = message;
    target.classList.add('show');
    clearTimeout(notify.timer);
    notify.timer = setTimeout(() => target.classList.remove('show'), 3500);
  }

  function normalizeEffort(value) {
    const effort = String(value ?? '').toLowerCase();
    if (effort === 'low' || effort === 'minimal') return 'low';
    if (effort === 'medium' || effort === 'mid') return 'medium';
    if (effort === 'high') return 'high';
    return 'default';
  }

  function normalizeProvider(value) {
    const provider = String(value ?? '').toLowerCase();
    return PROVIDERS.some((item) => item.value === provider) ? provider : (provider || 'openai');
  }

  function providerLabel(provider) {
    return PROVIDERS.find((item) => item.value === provider)?.label || String(provider || '模型服务');
  }

  function providerPlaceholder(provider) {
    if (provider === 'anthropic') return 'https://api.anthropic.com';
    if (provider === 'demo') return '演示模式不需要地址';
    return 'https://api.openai.com/v1';
  }

  function normalizeBase(value) {
    return String(value ?? '').trim().replace(/\/+$/, '');
  }

  function normalizeModel(item) {
    if (typeof item === 'string') {
      const id = item.trim();
      return id ? { id, name: id } : null;
    }
    if (!item || typeof item !== 'object') return null;
    const id = String(item.id ?? item.model ?? item.slug ?? item.name ?? '').trim();
    if (!id) return null;
    const name = String(item.name ?? item.displayName ?? item.label ?? id).trim() || id;
    const rawContext = item.contextWindow ?? item.context_window ?? item.contextLength
      ?? item.context_length ?? item.maxContextTokens;
    const contextWindow = Number(rawContext);
    return {
      id,
      name,
      ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {})
    };
  }

  function normalizeModels(value) {
    const list = Array.isArray(value)
      ? value
      : (Array.isArray(value?.models) ? value.models
        : (Array.isArray(value?.data) ? value.data : []));
    const seen = new Set();
    return list.map(normalizeModel).filter((model) => {
      if (!model || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });
  }

  function normalizeConnection(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id ?? raw.connectionId ?? '').trim();
    if (!id) return null;
    const provider = normalizeProvider(raw.provider);
    const name = String(raw.name ?? raw.title ?? '').trim() || providerLabel(provider);
    const capabilities = raw.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : null;
    return {
      id,
      name,
      provider,
      baseUrl: String(raw.baseUrl ?? '').trim(),
      models: normalizeModels(raw.models),
      contextWindow: Number(raw.contextWindow) || null,
      hasApiKey: Boolean(raw.hasApiKey),
      capabilities,
      supportsEffort: raw.supportsEffort ?? raw.supportsReasoningEffort ?? raw.supportsReasoning,
      efforts: raw.efforts ?? raw.reasoningEfforts
    };
  }

  function normalizeConnections(raw) {
    if (Array.isArray(raw)) return raw.map(normalizeConnection).filter(Boolean);
    const list = Array.isArray(raw?.connections) ? raw.connections
      : (Array.isArray(raw?.items) ? raw.items : []);
    return list.map(normalizeConnection).filter(Boolean);
  }

  function formatContext(value) {
    const context = Number(value);
    if (!Number.isFinite(context) || context <= 0) return '';
    return `${new Intl.NumberFormat('zh-CN').format(context)} tokens`;
  }

  function getConnection(id = state.selected.connectionId) {
    return state.connections.find((connection) => connection.id === id) || null;
  }

  function getSelectedModel(connection = getConnection()) {
    return connection?.models.find((model) => model.id === state.selected.model) || null;
  }

  function getSelection() {
    const connection = getConnection();
    const model = getSelectedModel(connection);
    return {
      connectionId: state.selected.connectionId || '',
      model: state.selected.model || '',
      effort: normalizeEffort(state.selected.effort),
      contextWindow: Number(connection?.contextWindow) || Number(model?.contextWindow) || null
    };
  }

  function rememberSelection(current = getSelection()) {
    if (!state.config || typeof state.config !== 'object') return;
    state.config.selectedModel = {
      connectionId: current.connectionId,
      model: current.model,
      effort: current.effort
    };
  }

  function effortSupport(connection) {
    return { mode: 'all', allowed: new Set(EFFORTS) };
  }

  async function readConfig() {
    if (typeof state.getConfig !== 'function') return state.config || {};
    try {
      const config = await state.getConfig();
      if (config && typeof config === 'object') state.config = config;
    } catch {
      /* Keep the last known configuration. */
    }
    return state.config || {};
  }

  function applyConfigSelection(config) {
    const selected = config?.selectedModel;
    if (!selected || typeof selected !== 'object') return false;
    const connectionId = String(selected.connectionId ?? '');
    const model = String(selected.model ?? '');
    if (!connectionId && !model) return false;
    state.selected = { connectionId, model, effort: normalizeEffort(selected.effort) };
    return true;
  }

  function inferLegacySelection() {
    if (state.selected.connectionId || !state.config) return;
    const configuredModel = String(state.config.model || '');
    if (!configuredModel) return;
    const provider = String(state.config.provider || '').toLowerCase();
    const baseUrl = normalizeBase(state.config.baseUrl);
    const matches = [];
    for (const connection of state.connections) {
      if (provider && connection.provider !== provider) continue;
      if (baseUrl && normalizeBase(connection.baseUrl) !== baseUrl) continue;
      const model = connection.models.find((item) => item.id === configuredModel || item.name === configuredModel);
      if (model) matches.push({ connection, model });
    }
    if (matches.length === 1) {
      state.selected = {
        connectionId: matches[0].connection.id,
        model: matches[0].model.id,
        effort: normalizeEffort(state.config.effort || state.config.reasoningEffort)
      };
    }
  }

  function syncLegacy() {
    const connection = getConnection();
    const selectedModel = getSelectedModel(connection);
    const providerInput = $('providerInput');
    const modelInput = $('modelInput');
    const baseUrlInput = $('baseUrlInput');
    const apiKeyInput = $('apiKeyInput');
    const clearKey = $('clearKey');
    if (providerInput && connection) providerInput.value = connection.provider;
    if (modelInput) modelInput.value = selectedModel?.id || '';
    if (baseUrlInput) baseUrlInput.value = connection?.baseUrl || '';
    if (apiKeyInput) {
      apiKeyInput.value = '';
      apiKeyInput.placeholder = connection?.hasApiKey ? '密钥已加密保存，留空不修改' : '输入 API Key';
    }
    if (clearKey) clearKey.checked = false;
  }

  function syncLegacyForSubmit() {
    // Keep the legacy hidden fields aligned with the selected connection.
    // API keys are intentionally not mirrored from the detail form.
    syncLegacy();
  }

  function modelButtonLabel() {
    const connection = getConnection();
    const selectedModel = getSelectedModel(connection);
    return selectedModel?.name || (state.selected.model ? state.selected.model : '选择模型');
  }

  function updateModelButton() {
    const button = $('modelButton');
    if (!button) return;
    const connection = getConnection();
    const selectedModel = getSelectedModel(connection);
    const label = modelButtonLabel();
    const effort = normalizeEffort(state.selected.effort);
    const effortLabel = EFFORT_LABELS[effort];
    const chip = state.selected.model
      ? `<span class="nm-effort-chip" title="推理强度：${esc(effortLabel)}">${esc(effortLabel)}</span>` : '';
    state.renderingButton = true;
    button.innerHTML = `<span class="nm-model-label">${esc(label)}</span>${chip}${icon('chevron-down')}`;
    button.title = state.selected.model
      ? `模型：${label}\n推理强度：${effortLabel}\n点击选择模型`
      : '选择模型与推理强度';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', String(Boolean(state.picker && !state.picker.hidden)));
    button.setAttribute('aria-label', state.selected.model
      ? `模型 ${label}，推理强度 ${effortLabel}。点击打开模型选择`
      : '选择模型与推理强度');
    state.renderingButton = false;
    renderIcons();
  }

  function observeModelButton() {
    const button = $('modelButton');
    if (!button || state.buttonObserver) return;
    state.buttonObserver = new MutationObserver(() => {
      if (state.renderingButton) return;
      const label = button.querySelector('.nm-model-label');
      const chip = button.querySelector('.nm-effort-chip');
      const desired = modelButtonLabel();
      const wrongChip = Boolean(state.selected.model) ? !chip : Boolean(chip);
      if (!label || label.textContent !== desired || wrongChip || !button.querySelector('svg, i[data-lucide="chevron-down"]')) {
        updateModelButton();
      }
    });
    state.buttonObserver.observe(button, { childList: true, subtree: true, characterData: true });
  }

  function ensureSettingsUi() {
    const section = document.querySelector('[data-section="model"]');
    if (!section) return null;
    let root = section.querySelector('#nanoModelSettings');
    if (!root) {
      section.innerHTML = `<div id="nanoModelSettings" class="nm-settings"></div>
        <div class="nm-legacy" hidden aria-hidden="true">
          <select id="providerInput" tabindex="-1">
            <option value="demo">演示模式</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
          <input id="modelInput" tabindex="-1" autocomplete="off">
          <input id="baseUrlInput" type="url" tabindex="-1" autocomplete="off">
          <input id="apiKeyInput" type="password" tabindex="-1" autocomplete="off">
          <input type="checkbox" id="clearKey" tabindex="-1">
          <button type="button" id="testConnection" tabindex="-1">测试连接</button>
          <span id="connectionResult" role="status"></span>
        </div>`;
      root = section.querySelector('#nanoModelSettings');
    }
    return root;
  }

  function connectionCard(connection) {
    const isSelected = connection.id === state.selected.connectionId;
    const selectedModel = isSelected ? getSelectedModel(connection) : null;
    const count = connection.models.length;
    const modelText = count ? `${count} 个模型` : '未获取模型';
    const keyText = connection.hasApiKey ? '密钥已保存' : '未保存密钥';
    const current = selectedModel
      ? `<span class="nm-connection-current">${esc(selectedModel.name)} · ${esc(EFFORT_LABELS[normalizeEffort(state.selected.effort)])}</span>`
      : '';
    return `<div class="nm-connection${isSelected ? ' selected' : ''}" role="listitem">
      <button class="nm-connection-main" type="button" data-nm-edit="${esc(connection.id)}">
        <span class="nm-connection-icon">${icon('server')}</span>
        <span class="nm-connection-info">
          <span class="nm-connection-title"><strong>${esc(connection.name)}</strong>${isSelected ? '<span class="nm-badge">当前</span>' : ''}</span>
          <span class="nm-connection-sub">${esc(providerLabel(connection.provider))} · ${esc(connection.baseUrl || '默认地址')}</span>
          <span class="nm-connection-meta"><span>${esc(modelText)}</span><span>${esc(keyText)}</span>${current}</span>
        </span>
        <span class="nm-connection-chevron">${icon('chevron-right')}</span>
      </button>
    </div>`;
  }

  function renderList(root) {
    const cards = state.connections.map(connectionCard).join('');
    const error = state.connectionsError
      ? `<div class="nm-alert is-error" role="alert">${icon('circle-alert')}<span>${esc(state.connectionsError)}</span>
          <button class="button compact" type="button" data-nm-refresh>重试</button></div>` : '';
    const loading = state.loadingConnections && !state.connections.length
      ? `<div class="nm-list-loading" role="status">${icon('loader-circle')}<span>正在读取模型连接…</span></div>` : '';
    const empty = !state.loadingConnections && !state.connections.length
      ? `<div class="nm-empty">${icon('server')}<strong>还没有模型连接</strong>
          <p>添加服务商连接，填写 API Key 后会自动测试并获取可用模型。</p>
          <button class="button primary" type="button" data-nm-add>${icon('plus')}添加连接</button></div>` : '';
    root.innerHTML = `<header class="nm-settings-head">
        <div><h1>模型连接</h1><p class="subtle">管理服务商连接。模型名称只来自服务商返回的列表，不支持手动输入。</p></div>
        <div class="nm-head-actions">
          <button class="button compact" type="button" data-nm-refresh${state.loadingConnections ? ' disabled' : ''} aria-label="刷新连接列表">${icon('refresh-cw')}刷新</button>
          <button class="button primary" type="button" data-nm-add>${icon('plus')}添加连接</button>
        </div>
      </header>
      ${error}${loading}
      <div class="nm-connection-list" role="list" aria-label="模型连接">${cards}</div>
      ${empty}
      <p class="nm-footnote">连接获取失败时仍可保存配置；稍后重新测试即可。</p>`;
    renderIcons();
  }

  function draftDiscoveryMessage(draft) {
    if (!draft) return '';
    if (draft.provider === 'demo') return '演示模式不需要连接服务商。';
    if (draft.models.length) return `已加载 ${draft.models.length} 个模型，可直接保存。`;
    if (draft.apiKey || (draft.hasApiKey && !draft.clearApiKey)) return '可测试连接并获取模型。';
    return '填写 API Key 后会自动测试并获取可用模型。';
  }

  function modelOptions(draft) {
    const placeholder = draft.models.length ? '选择模型' : '暂无可用模型，请先测试获取';
    return `<option value="">${esc(placeholder)}</option>${draft.models.map((model) => (
      `<option value="${esc(model.id)}">${esc(model.name)}</option>`
    )).join('')}`;
  }

  function contextText(draft) {
    if (!draft?.model) return '';
    const model = draft.models.find((item) => item.id === draft.model);
    if (!model) return '';
    const context = formatContext(model.contextWindow);
    return context ? `上下文长度：${context}` : '服务商未提供上下文长度。';
  }

  function statusMarkup(status, message) {
    const iconName = status === 'loading' ? 'loader-circle'
      : (status === 'error' ? 'circle-alert' : (status === 'success' ? 'circle-check' : 'info'));
    return `${icon(iconName)}<span>${esc(message)}</span>`;
  }

  function renderDetail(root) {
    const draft = state.draft;
    if (!draft) {
      state.settingsMode = 'list';
      renderList(root);
      return;
    }
    const selectedConnection = state.selected.connectionId === draft.id;
    const keyHint = draft.hasApiKey ? '已加密保存；留空不修改' : '需要服务商密钥才能获取模型';
    const clearRow = draft.hasApiKey
      ? `<label class="nm-check"><input type="checkbox" data-nm-field="clearApiKey"${draft.clearApiKey ? ' checked' : ''}> 保存时清除已保存的 API Key</label>` : '';
    const deleteButton = draft.id
      ? `<button class="button nm-danger" type="button" data-nm-delete>${icon('trash-2')}删除连接</button>` : '';
    root.innerHTML = `<button class="nm-back" type="button" data-nm-back>${icon('chevron-left')}返回连接列表</button>
      <header class="nm-detail-head">
        <div><h1>${draft.id ? '编辑模型连接' : '添加模型连接'}</h1>
          <p class="subtle">${selectedConnection ? '当前连接正在使用。' : '保存后可在模型选择器中切换。'}</p></div>
      </header>
      <div class="settings-group form-group nm-form">
        <label class="nm-field" for="nmName"><span>连接名称</span>
          <input id="nmName" data-nm-field="name" maxlength="80" autocomplete="off" value="${esc(draft.name)}" placeholder="例如：工作账号"></label>
        <label class="nm-field" for="nmProvider"><span>提供方</span>
          <select id="nmProvider" data-nm-field="provider">${PROVIDERS.map((provider) => (
            `<option value="${esc(provider.value)}"${provider.value === draft.provider ? ' selected' : ''}>${esc(provider.label)}</option>`
          )).join('')}</select></label>
        <label class="nm-field" for="nmBaseUrl"><span>API Base URL</span>
          <input id="nmBaseUrl" data-nm-field="baseUrl" type="url" autocomplete="off" value="${esc(draft.baseUrl)}" placeholder="${esc(providerPlaceholder(draft.provider))}">
          <small>留空使用提供方默认地址。</small></label>
        <label class="nm-field" for="nmApiKey"><span>API Key <small class="nm-key-state">${esc(keyHint)}</small></span>
          <input id="nmApiKey" data-nm-field="apiKey" type="password" autocomplete="off" spellcheck="false" value="" placeholder="${draft.hasApiKey ? '已保存，输入新密钥可替换' : '输入 API Key'}"></label>
        ${clearRow}
        <label class="nm-field" for="nmModel"><span>模型</span>
          <select id="nmModel" data-nm-field="model"${draft.models.length ? '' : ' disabled'}>${modelOptions(draft)}</select>
          <small data-nm-context>${esc(contextText(draft))}</small></label>
        <label class="nm-field" for="nmContextWindow"><span>上下文上限</span><input id="nmContextWindow" data-nm-field="contextWindow" type="number" min="1" step="1" value="${esc(draft.contextWindow || '')}" placeholder="使用模型返回值或 1M 预设"></label>
        <div class="nm-status nm-status-${esc(state.discovery.status)}" data-nm-discovery role="status" aria-live="polite">${statusMarkup(state.discovery.status, state.discovery.message)}</div>
      </div>
      <div class="nm-detail-actions">
        <button class="button primary" type="button" data-nm-save${state.saving ? ' disabled' : ''}>${icon('check')}保存连接</button>
        ${deleteButton}
      </div>
      <p class="nm-footnote">测试失败不影响保存；API Key 保存后会从输入框清除。</p>`;
    const select = root.querySelector('#nmModel');
    if (select) select.value = draft.models.some((model) => model.id === draft.model) ? draft.model : '';
    renderIcons();
  }

  function renderSettings() {
    const root = ensureSettingsUi();
    if (!root) return;
    if (state.settingsMode === 'detail' && state.draft) renderDetail(root);
    else renderList(root);
  }

  function refreshDetailModelSelect() {
    const root = ensureSettingsUi();
    if (!root || !state.draft) return;
    const draft = state.draft;
    if (!draft.models.some((model) => model.id === draft.model)) draft.model = '';
    const select = root.querySelector('#nmModel');
    if (select) {
      select.innerHTML = modelOptions(draft);
      select.disabled = !draft.models.length;
      select.value = draft.model;
    }
    const context = root.querySelector('[data-nm-context]');
    if (context) context.textContent = contextText(draft);
  }

  function updateDetailKeyState() {
    const root = ensureSettingsUi();
    const label = root?.querySelector('.nm-key-state');
    if (label && state.draft) {
      label.textContent = state.draft.hasApiKey ? '已加密保存；留空不修改' : '需要服务商密钥才能获取模型';
    }
  }

  function setDiscovery(status, message) {
    state.discovery = { status, message };
    const root = ensureSettingsUi();
    const target = root?.querySelector('[data-nm-discovery]');
    if (target) {
      target.className = `nm-status nm-status-${status}`;
      target.innerHTML = statusMarkup(status, message);
      renderIcons();
    }
    const testButton = root?.querySelector('[data-nm-test]');
    if (testButton) testButton.disabled = status === 'loading';
    const legacy = $('connectionResult');
    if (legacy) legacy.textContent = message;
  }

  function blankDraft() {
    const config = state.config || {};
    const provider = normalizeProvider(config.provider === 'demo' ? 'openai' : config.provider || 'openai');
    return {
      id: '',
      name: '',
      provider,
      baseUrl: String(config.baseUrl || ''),
      apiKey: '',
      clearApiKey: false,
      hasApiKey: false,
      model: '',
      models: [],
      contextWindow: null,
      supportsEffort: null,
      capabilities: null,
      origin: { provider, baseUrl: normalizeBase(config.baseUrl || '') }
    };
  }

  function draftFromConnection(connection) {
    const selectedModel = connection.id === state.selected.connectionId
      && connection.models.some((model) => model.id === state.selected.model)
      ? state.selected.model : '';
    return {
      id: connection.id,
      name: connection.name,
      provider: connection.provider,
      baseUrl: connection.baseUrl,
      apiKey: '',
      clearApiKey: false,
      hasApiKey: connection.hasApiKey,
      model: selectedModel,
      models: connection.models.slice(),
      contextWindow: connection.contextWindow,
      supportsEffort: connection.supportsEffort,
      capabilities: connection.capabilities,
      origin: { provider: connection.provider, baseUrl: normalizeBase(connection.baseUrl) }
    };
  }

  function openDetail(id) {
    if (id) {
      const connection = getConnection(id);
      if (!connection) {
        notify('连接不存在，请刷新列表');
        return;
      }
      state.activeId = id;
      state.draft = draftFromConnection(connection);
    } else {
      state.activeId = null;
      state.draft = blankDraft();
    }
    state.settingsMode = 'detail';
    state.discoverySeq += 1;
    clearTimeout(state.discoveryTimer);
    state.discovery = { status: 'idle', message: draftDiscoveryMessage(state.draft) };
    renderSettings();
    const nameInput = ensureSettingsUi()?.querySelector('#nmName');
    if (nameInput) nameInput.focus();
  }

  function closeDetail() {
    clearTimeout(state.discoveryTimer);
    state.discoverySeq += 1;
    state.settingsMode = 'list';
    state.draft = null;
    state.activeId = null;
    state.discovery = { status: 'idle', message: '' };
    renderSettings();
    const root = ensureSettingsUi();
    (root?.querySelector('[data-nm-add]') || root?.querySelector('[data-nm-edit]'))?.focus();
  }

  function showModelSettings() {
    if (typeof state.showView === 'function') state.showView('settings');
    const tab = document.querySelector('[data-settings-tab="model"]');
    if (tab && !tab.classList.contains('active')) tab.click();
  }

  function openSettingsAdd() {
    closePicker(false);
    showModelSettings();
    openDetail(null);
  }

  function openSettingsList() {
    closePicker(false);
    showModelSettings();
    state.settingsMode = 'list';
    state.draft = null;
    state.activeId = null;
    renderSettings();
    requestAnimationFrame(() => ensureSettingsUi()?.querySelector('[data-nm-add]')?.focus());
  }

  function readDraftFields() {
    const root = ensureSettingsUi();
    const draft = state.draft;
    if (!root || !draft) return null;
    const field = (name) => root.querySelector(`[data-nm-field="${name}"]`);
    const name = field('name');
    const provider = field('provider');
    const baseUrl = field('baseUrl');
    const apiKey = field('apiKey');
    const model = field('model');
    const clearApiKey = field('clearApiKey');
    const contextWindow = field('contextWindow');
    const supportsEffort = field('supportsEffort');
    if (name) draft.name = name.value;
    if (provider) draft.provider = normalizeProvider(provider.value);
    if (baseUrl) draft.baseUrl = baseUrl.value.trim();
    if (apiKey) draft.apiKey = apiKey.value;
    if (model) draft.model = model.value;
    if (clearApiKey) draft.clearApiKey = clearApiKey.checked;
    if (contextWindow) draft.contextWindow = contextWindow.value;
    if (supportsEffort) draft.supportsEffort = supportsEffort.value==='auto'?null:supportsEffort.value==='true';
    return draft;
  }

  function hasUsableKey(draft) {
    return Boolean(draft?.apiKey) || Boolean(draft?.hasApiKey && !draft?.clearApiKey);
  }

  function scheduleDiscovery() {
    const draft = state.draft;
    if (!draft) return;
    readDraftFields();
    clearTimeout(state.discoveryTimer);
    if (draft.provider === 'demo') {
      setDiscovery('idle', draftDiscoveryMessage(draft));
      return;
    }
    if (!hasUsableKey(draft)) {
      setDiscovery('idle', draft.clearApiKey
        ? '保存后将清除已保存的密钥；输入新密钥可重新测试。'
        : '填写 API Key 后会自动测试并获取可用模型。');
      return;
    }
    const endpointChanged = draft.provider !== draft.origin.provider
      || normalizeBase(draft.baseUrl) !== draft.origin.baseUrl;
    if (endpointChanged) {
      draft.models = [];
      draft.model = '';
      refreshDetailModelSelect();
    }
    setDiscovery('idle', 'API Key 就绪，稍后自动测试并获取模型…');
    state.discoveryTimer = window.setTimeout(() => runDiscovery('auto'), 700);
  }

  async function runDiscovery(reason = 'manual') {
    const draft = state.draft;
    if (!draft) return;
    readDraftFields();
    clearTimeout(state.discoveryTimer);
    if (draft.provider === 'demo') {
      draft.models = [];
      draft.model = '';
      refreshDetailModelSelect();
      setDiscovery('idle', '演示模式不需要连接服务商。');
      return;
    }
    if (!hasUsableKey(draft)) {
      setDiscovery('error', draft.clearApiKey
        ? '保存后将清除密钥；请输入新 API Key 再测试。'
        : '请先填写 API Key。');
      return;
    }
    if (typeof state.api?.discoverModels !== 'function') {
      setDiscovery('error', '模型获取接口不可用，暂时只能保存连接。');
      return;
    }
    const endpointChanged = draft.provider !== draft.origin.provider
      || normalizeBase(draft.baseUrl) !== draft.origin.baseUrl;
    if (endpointChanged) {
      draft.models = [];
      draft.model = '';
      refreshDetailModelSelect();
    }
    state.discoverySeq += 1;
    const seq = state.discoverySeq;
    setDiscovery('loading', reason === 'auto' ? '正在自动测试并获取模型…' : '正在测试连接并获取模型…');
    try {
      const payload = {
        provider: draft.provider,
        baseUrl: draft.baseUrl,
        ...(draft.id ? { connectionId: draft.id, id: draft.id } : {}),
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {})
      };
      const result = await state.api.discoverModels(payload);
      if (seq !== state.discoverySeq || state.draft !== draft) return;
      if (result?.ok === false) throw new Error(result.message || result.error || '服务商返回失败');
      const models = normalizeModels(result?.connection?.models ?? result);
      draft.models = models;
      draft.origin = { provider: draft.provider, baseUrl: normalizeBase(draft.baseUrl) };
      if (!models.some((model) => model.id === draft.model)) draft.model = '';
      if (result?.hasApiKey !== undefined) draft.hasApiKey = Boolean(result.hasApiKey);
      else if (draft.apiKey) draft.hasApiKey = true;
      refreshDetailModelSelect();
      updateDetailKeyState();
      if (models.length) setDiscovery('success', `连接成功，获取到 ${models.length} 个模型。`);
      else setDiscovery('success', '连接成功，但服务商未返回模型。可保存配置后重试。');
    } catch (error) {
      if (seq !== state.discoverySeq || state.draft !== draft) return;
      setDiscovery('error', `获取模型失败：${error?.message || '未知错误'}`);
    }
  }

  function applySelection(connectionId, modelId, effort = state.selected.effort) {
    const connection = getConnection(connectionId);
    const model = connection?.models.find((item) => item.id === modelId);
    if (!connection || !model) return false;
    let nextEffort = normalizeEffort(effort);
    if (!effortSupport(connection).allowed.has(nextEffort)) nextEffort = 'default';
    state.selected = { connectionId, model: modelId, effort: nextEffort };
    syncLegacy();
    updateModelButton();
    const current = getSelection();
    rememberSelection(current);
    if (typeof state.onSelect === 'function') {
      try { state.onSelect({ ...current }); } catch { /* host callback must not break selection */ }
    }
    document.dispatchEvent(new CustomEvent('nano-model-change', { detail: { ...current } }));
    return true;
  }

  async function persistSelection() {
    const current = getSelection();
    if (!current.connectionId || !current.model
      || typeof state.api?.selectModel !== 'function') return;
    try {
      await state.api.selectModel({
        connectionId: current.connectionId,
        model: current.model,
        effort: current.effort
      });
    } catch (error) {
      notify(`模型选择未能保存：${error?.message || '未知错误'}`);
    }
  }

  function chooseModel(connectionId, modelId) {
    if (!applySelection(connectionId, modelId)) return;
    closePicker();
    void persistSelection();
  }

  function resetDeleteButton(button) {
    if (!button) return;
    button.dataset.armed = '';
    button.classList.remove('is-armed');
    button.innerHTML = `${icon('trash-2')}删除连接`;
    renderIcons();
  }

  async function removeDraft(button) {
    const draft = state.draft;
    if (!draft?.id) return;
    if (typeof state.api?.removeModel !== 'function') {
      setDiscovery('error', '删除接口不可用。');
      return;
    }
    button.disabled = true;
    setDiscovery('loading', '正在删除连接…');
    try {
      await state.api.removeModel(draft.id);
      const removedId = draft.id;
      state.connections = state.connections.filter((connection) => connection.id !== removedId);
      if (state.selected.connectionId === removedId) {
        state.selected = { connectionId: '', model: '', effort: state.selected.effort };
        syncLegacy();
        updateModelButton();
        const current = getSelection();
        rememberSelection(current);
        try { state.onSelect?.({ ...current }); } catch { /* ignore */ }
        document.dispatchEvent(new CustomEvent('nano-model-change', { detail: { ...current } }));
        if (typeof state.api?.selectModel === 'function') {
          try {
            await state.api.selectModel({ connectionId: '', model: '', effort: current.effort });
          } catch { /* the connection is gone; stale selection is harmless */ }
        }
      }
      state.settingsMode = 'list';
      state.draft = null;
      state.activeId = null;
      state.discovery = { status: 'idle', message: '' };
      renderSettings();
      notify('模型连接已删除');
    } catch (error) {
      button.disabled = false;
      resetDeleteButton(button);
      setDiscovery('error', `删除失败：${error?.message || '未知错误'}`);
      notify('删除连接失败');
    }
  }

  async function saveDraft() {
    const draft = readDraftFields();
    if (!draft || state.saving) return;
    const root = ensureSettingsUi();
    const saveButton = root?.querySelector('[data-nm-save]');
    if (draft.provider !== 'demo' && !draft.name.trim() && !draft.id) {
      draft.name = providerLabel(draft.provider);
    }
    if (draft.baseUrl) {
      try {
        const url = new URL(draft.baseUrl);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('协议');
      } catch {
        setDiscovery('error', 'API Base URL 必须是有效的 HTTP 或 HTTPS 地址。');
        root?.querySelector('#nmBaseUrl')?.focus();
        return;
      }
    }
    if (typeof state.api?.saveModel !== 'function') {
      setDiscovery('error', '保存接口不可用，无法保存连接。');
      return;
    }
    state.saving = true;
    if (saveButton) {
      saveButton.disabled = true;
      saveButton.innerHTML = `${icon('loader-circle')}保存中…`;
      renderIcons();
    }
    try {
      const payload = {
        id: draft.id || undefined,
        name: draft.name.trim() || providerLabel(draft.provider),
        provider: draft.provider,
        baseUrl: draft.baseUrl,
        model: draft.model || undefined,
        models: draft.models,
        contextWindow: draft.contextWindow || undefined,
        supportsEffort: draft.supportsEffort,
        apiKey: draft.apiKey || undefined,
        clearApiKey: draft.clearApiKey || undefined
      };
      const result = await state.api.saveModel(payload);
      const raw = result?.connection || result;
      let saved = normalizeConnection({
        ...draft,
        ...(raw && typeof raw === 'object' ? raw : {}),
        id: raw?.id || raw?.connectionId || draft.id,
        models: normalizeModels(raw?.models).length ? raw.models : draft.models,
        hasApiKey: raw?.hasApiKey ?? (draft.clearApiKey ? false : (draft.hasApiKey || Boolean(draft.apiKey)))
      });
      if (!saved) {
        notify('连接已保存，但服务端未返回连接信息');
        await loadConnections();
        closeDetail();
        return;
      }
      if (!saved.models.length && draft.models.length) saved.models = draft.models;
      const index = state.connections.findIndex((connection) => connection.id === saved.id);
      if (index >= 0) state.connections.splice(index, 1, saved);
      else state.connections.push(saved);
      const chosenModel = saved.models.some((model) => model.id === draft.model) ? draft.model : '';
      state.activeId = saved.id;
      state.draft = draftFromConnection(saved);
      state.draft.model = chosenModel;
      state.draft.apiKey = '';
      state.draft.clearApiKey = false;
      state.discovery = { status: 'success', message: '连接已保存，API Key 已从输入框清除。' };
      if (state.draft.model) applySelection(saved.id, state.draft.model, state.selected.effort);
      else updateModelButton();
      renderSettings();
      if (state.draft.model) void persistSelection();
      notify('模型连接已保存');
    } catch (error) {
      setDiscovery('error', `保存失败：${error?.message || '未知错误'}`);
      notify('保存连接失败');
    } finally {
      state.saving = false;
      const currentButton = ensureSettingsUi()?.querySelector('[data-nm-save]');
      if (currentButton) {
        currentButton.disabled = false;
        currentButton.innerHTML = `${icon('check')}保存连接`;
        renderIcons();
      }
    }
  }

  async function loadConnections() {
    state.loadSeq += 1;
    const seq = state.loadSeq;
    state.loadingConnections = true;
    if (state.settingsMode === 'list') renderSettings();
    try {
      if (typeof state.api?.listModels !== 'function') throw new Error('模型连接接口不可用');
      const result = await state.api.listModels();
      if (seq !== state.loadSeq) return;
      state.connections = normalizeConnections(result);
      state.connectionsError = '';
      if (state.selected.connectionId) {
        const connection = getConnection();
        if (!connection) state.selected = { connectionId: '', model: '', effort: state.selected.effort };
        else if (!connection.models.some((model) => model.id === state.selected.model)) {
          state.selected = { connectionId: connection.id, model: '', effort: state.selected.effort };
        }
        const active = getConnection();
        if (active && !effortSupport(active).allowed.has(normalizeEffort(state.selected.effort))) {
          state.selected.effort = 'default';
        }
      }
      inferLegacySelection();
      syncLegacy();
      updateModelButton();
    } catch (error) {
      if (seq !== state.loadSeq) return;
      state.connectionsError = `读取模型连接失败：${error?.message || '未知错误'}`;
    } finally {
      if (seq === state.loadSeq) {
        state.loadingConnections = false;
        if (state.settingsMode === 'list') renderSettings();
      }
    }
  }

  async function refresh() {
    const config = await readConfig();
    if (config) applyConfigSelection(config);
    await loadConnections();
    updateModelButton();
    if (state.settingsMode === 'list') renderSettings();
    return getSelection();
  }

  function effortNote() {
    const connection = getConnection();
    const support = effortSupport(connection);
    if (!state.selected.connectionId) return '选择模型后可调整；设置会随模型一起保存。';
    if (support.mode === 'none') return '当前连接未声明支持推理强度，将仅使用默认。';
    if (support.mode === 'limited') {
      const available = EFFORTS.filter((effort) => support.allowed.has(effort)).map((effort) => EFFORT_LABELS[effort]);
      return `当前连接支持：${available.join('、')}。`;
    }
    return '推理强度会随所选模型一起保存。';
  }

  function effortViewHtml() {
    const support = effortSupport(getConnection());
    const selectedEffort = normalizeEffort(state.selected.effort);
    const connection = getConnection();
    const selectedModel = getSelectedModel(connection);
    const modelName = selectedModel?.name || (state.selected.model ? state.selected.model : '选择模型');
    const subtitle = connection
      ? `${connection.name} · ${selectedModel ? formatContext(selectedModel.contextWindow) || providerLabel(connection.provider) : providerLabel(connection.provider)}`
      : '尚未选择模型';
    return `<div class="nm-picker-head">
        <div><strong>推理强度</strong><small>${esc(effortNote())}</small></div>
        <button class="nm-picker-close" type="button" data-nm-picker-close aria-label="关闭模型选择">${icon('x')}</button>
      </div>
      <div class="nm-picker-body">
        <div class="nm-effort-slider"><strong>${esc(EFFORT_LABELS[selectedEffort])}</strong><input type="range" min="0" max="300" step="1" value="${EFFORTS.indexOf(selectedEffort)*100}" data-nm-effort-slider aria-label="推理强度"><div><span>默认</span><span>低</span><span>中</span><span>高</span></div></div>
        <button class="nm-model-entry" type="button" data-nm-picker-models>
          <span class="nm-model-entry-icon">${icon('sparkles')}</span>
          <span class="nm-model-entry-text"><small>模型</small><strong>${esc(modelName)}</strong><span>${esc(subtitle)}</span></span>
          <span class="nm-model-entry-chevron">${icon('chevron-right')}</span>
        </button>
      </div>`;
  }

  function modelRowsHtml() {
    const rows = [];
    for (const connection of state.connections) {
      for (const model of connection.models) {
        const selected = connection.id === state.selected.connectionId && model.id === state.selected.model;
        const context = formatContext(model.contextWindow);
        rows.push(`<button class="nm-pick-model${selected ? ' selected' : ''}" type="button" role="option"
          aria-selected="${selected}" data-nm-pick="${esc(connection.id)}" data-nm-model-id="${esc(model.id)}">
          <span class="nm-pick-model-main"><strong>${esc(model.name)}</strong>
            <small>${esc(connection.name)} · ${esc(providerLabel(connection.provider))}</small></span>
          <span class="nm-pick-model-meta">${context ? `<span>${esc(context)}</span>` : ''}${selected ? icon('check') : ''}</span>
        </button>`);
      }
    }
    return rows.join('');
  }

  function modelsViewHtml() {
    const rows = modelRowsHtml();
    return `<div class="nm-picker-head">
        <button class="nm-picker-back" type="button" data-nm-picker-back aria-label="返回推理强度">${icon('chevron-left')}</button>
        <div><strong>选择模型</strong><small>模型来自已连接服务商的可用列表</small></div>
        <button class="nm-picker-close" type="button" data-nm-picker-close aria-label="关闭模型选择">${icon('x')}</button>
      </div>
      <div class="nm-picker-body nm-picker-scroll">
        <button class="nm-picker-add" type="button" data-nm-picker-add>${icon('plus')}<span><strong>添加模型</strong><small>新建服务商连接并获取模型</small></span></button>
        <div class="nm-pick-models" role="listbox" aria-label="可用模型">
          ${rows || `<div class="nm-picker-empty">${icon('server')}<span>还没有可用模型。先添加连接并填写 API Key。</span></div>`}
        </div>
      </div>
      <footer class="nm-picker-foot">
        <button type="button" data-nm-picker-manage>${icon('settings-2')}管理模型连接</button>
      </footer>`;
  }

  function renderPicker(focusTarget = '') {
    if (!state.picker) return;
    state.picker.innerHTML = state.pickerView === 'models' ? modelsViewHtml() : effortViewHtml();
    state.picker.setAttribute('aria-label', state.pickerView === 'models' ? '选择模型' : '模型与推理强度');
    renderIcons();
    positionPicker();
    let target = null;
    if (focusTarget) target = state.picker.querySelector(focusTarget);
    if (!target && state.pickerView === 'models') {
      target = state.picker.querySelector('[data-nm-picker-add]') || state.picker.querySelector('[data-nm-pick]');
    }
    if (!target) {
      target = state.picker.querySelector('[data-nm-effort][aria-checked="true"]:not(:disabled)')
        || state.picker.querySelector('[data-nm-picker-models]');
    }
    if (target) target.focus();
  }

  function positionPicker() {
    if (!state.picker || state.picker.hidden) return;
    const button = $('modelButton');
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const width = state.picker.offsetWidth;
    const height = state.picker.offsetHeight;
    const margin = 8;
    let left = Math.min(rect.right - width, window.innerWidth - width - margin);
    left = Math.max(margin, left);
    let top = rect.top - height - 10;
    if (top < margin) top = Math.min(rect.bottom + 10, window.innerHeight - height - margin);
    top = Math.max(margin, top);
    state.picker.style.left = `${Math.round(left)}px`;
    state.picker.style.top = `${Math.round(top)}px`;
  }

  function openPicker() {
    const button = $('modelButton');
    if (!button) return;
    if (!effortSupport(getConnection()).allowed.has(normalizeEffort(state.selected.effort))) {
      state.selected.effort = 'default';
      updateModelButton();
    }
    if (!state.picker) {
      const picker = document.createElement('div');
      picker.id = 'nanoModelPicker';
      picker.className = 'nm-popover';
      picker.hidden = true;
      picker.setAttribute('role', 'dialog');
      picker.setAttribute('aria-modal', 'false');
      picker.addEventListener('click', onPickerClick);
      picker.addEventListener('input', event => {if(event.target.matches('[data-nm-effort-slider]')){const index=Math.round(Number(event.target.value)/100);event.target.style.setProperty('--slider-progress',`${Number(event.target.value)/3}%`);const label=picker.querySelector('.nm-effort-slider strong');if(label)label.textContent=EFFORT_LABELS[EFFORTS[index]];}});
      picker.addEventListener('change', event => {if(event.target.matches('[data-nm-effort-slider]')){const index=Math.round(Number(event.target.value)/100);event.target.value=index*100;event.target.style.setProperty('--slider-progress',`${index/3*100}%`);applyEffort(EFFORTS[index]);}});
      picker.addEventListener('keydown', onPickerKeydown);
      document.body.appendChild(picker);
      state.picker = picker;
    }
    state.pickerView = 'effort';
    state.picker.hidden = false;
    state.picker.classList.add('open');
    button.setAttribute('aria-expanded', 'true');
    renderPicker();
  }

  function closePicker(restoreFocus = true) {
    if (!state.picker || state.picker.hidden) return;
    state.picker.hidden = true;
    state.picker.classList.remove('open');
    const button = $('modelButton');
    button?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) button?.focus();
  }

  function pickerItems() {
    if (!state.picker) return [];
    return [...state.picker.querySelectorAll('button:not(:disabled), [tabindex="0"]')]
      .filter((item) => item.offsetParent !== null);
  }

  function onPickerKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePicker();
      return;
    }
    if (event.key === 'Tab') {
      const items = pickerItems();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const items = pickerItems();
      if (!items.length) return;
      event.preventDefault();
      const index = items.indexOf(document.activeElement);
      const offset = event.key === 'ArrowDown' ? 1 : -1;
      const next = index < 0 ? 0 : (index + offset + items.length) % items.length;
      items[next].focus();
    }
  }

  function applyEffort(nextEffort) {
    const effort = normalizeEffort(nextEffort);
    const connection = getConnection();
    if (!effortSupport(connection).allowed.has(effort)) return;
    state.selected.effort = effort;
    updateModelButton();
    if (state.picker && !state.picker.hidden) {
      for (const button of state.picker.querySelectorAll('[data-nm-effort]')) {
        const selected = button.dataset.nmEffort === effort;
        button.classList.toggle('selected', selected);
        button.setAttribute('aria-checked', String(selected));
        const check = button.querySelector('svg');
        if (selected && !check) button.insertAdjacentHTML('beforeend', icon('check'));
        if (!selected) button.querySelector('svg')?.remove();
      }
      renderIcons();
      const note = state.picker.querySelector('.nm-picker-head small');
      if (note) note.textContent = effortNote();
    }
    const current = getSelection();
    rememberSelection(current);
    if (typeof state.onSelect === 'function') {
      try { state.onSelect({ ...current }); } catch { /* ignore */ }
    }
    document.dispatchEvent(new CustomEvent('nano-model-change', { detail: { ...current } }));
    if (state.selected.connectionId && state.selected.model) void persistSelection();
  }

  function onPickerClick(event) {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-nm-picker-close')) {
      closePicker();
      return;
    }
    if (button.hasAttribute('data-nm-picker-models')) {
      state.pickerView = 'models';
      renderPicker();
      return;
    }
    if (button.hasAttribute('data-nm-picker-back')) {
      state.pickerView = 'effort';
      renderPicker('[data-nm-picker-models]');
      return;
    }
    if (button.hasAttribute('data-nm-picker-add')) {
      openSettingsAdd();
      return;
    }
    if (button.hasAttribute('data-nm-picker-manage')) {
      openSettingsList();
      return;
    }
    if (button.dataset.nmEffort !== undefined) {
      applyEffort(button.dataset.nmEffort);
      return;
    }
    if (button.dataset.nmPick !== undefined) {
      chooseModel(button.dataset.nmPick, button.dataset.nmModelId || '');
    }
  }

  function onSettingsClick(event) {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-nm-add')) {
      openDetail(null);
      return;
    }
    if (button.hasAttribute('data-nm-refresh')) {
      void loadConnections();
      return;
    }
    if (button.dataset.nmEdit !== undefined) {
      openDetail(button.dataset.nmEdit);
      return;
    }
    if (button.hasAttribute('data-nm-back')) {
      closeDetail();
      return;
    }
    if (button.hasAttribute('data-nm-save')) {
      void saveDraft();
      return;
    }
    if (button.hasAttribute('data-nm-test')) {
      void runDiscovery('manual');
      return;
    }
    if (button.hasAttribute('data-nm-delete')) {
      if (button.dataset.armed === '1') {
        clearTimeout(state.deleteTimer);
        void removeDraft(button);
        return;
      }
      button.dataset.armed = '1';
      button.classList.add('is-armed');
      button.textContent = '再次点击确认删除';
      clearTimeout(state.deleteTimer);
      state.deleteTimer = window.setTimeout(() => resetDeleteButton(button), 4000);
    }
  }

  function onSettingsInput(event) {
    const field = event.target?.dataset?.nmField;
    if (!field || !state.draft) return;
    readDraftFields();
    if (field === 'apiKey' && state.draft.apiKey) {
      state.draft.clearApiKey = false;
      const clearField = ensureSettingsUi()?.querySelector('[data-nm-field="clearApiKey"]');
      if (clearField) clearField.checked = false;
    }
    if (field === 'apiKey' || field === 'baseUrl') scheduleDiscovery();
    if (field === 'model') {
      const context = ensureSettingsUi()?.querySelector('[data-nm-context]');
      if (context) context.textContent = contextText(state.draft);
    }
  }

  function onSettingsChange(event) {
    const field = event.target?.dataset?.nmField;
    if (!field || !state.draft) return;
    readDraftFields();
    if (field === 'provider') {
      state.draft.models = [];
      state.draft.model = '';
      refreshDetailModelSelect();
      scheduleDiscovery();
      return;
    }
    if (field === 'baseUrl' || field === 'apiKey') {
      scheduleDiscovery();
      return;
    }
    if (field === 'clearApiKey') {
      clearTimeout(state.discoveryTimer);
      if (state.draft.clearApiKey) {
        setDiscovery('idle', '保存后将清除已保存的密钥；输入新密钥可重新测试。');
      } else if (hasUsableKey(state.draft)) {
        scheduleDiscovery();
      }
      return;
    }
    if (field === 'model') {
      const context = ensureSettingsUi()?.querySelector('[data-nm-context]');
      if (context) context.textContent = contextText(state.draft);
    }
  }

  function onSettingsKeydown(event) {
    if (event.key !== 'Enter' || event.target?.tagName === 'TEXTAREA') return;
    if (event.target?.tagName === 'BUTTON') return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      void saveDraft();
    } else if (event.target?.tagName === 'INPUT' || event.target?.tagName === 'SELECT') {
      event.preventDefault();
    }
  }

  function bindModelButton() {
    const button = $('modelButton');
    if (!button || button.dataset.nmPickerBound === '1') return;
    button.dataset.nmPickerBound = '1';
    button.removeAttribute('data-view');
    button.onclick = null;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (state.picker && !state.picker.hidden) closePicker();
      else openPicker();
    }, true);
  }

  function bindOnce() {
    if (state.bound) return;
    state.bound = true;
    const section = document.querySelector('[data-section="model"]');
    section?.addEventListener('click', onSettingsClick);
    section?.addEventListener('input', onSettingsInput);
    section?.addEventListener('change', onSettingsChange);
    section?.addEventListener('keydown', onSettingsKeydown);
    $('settingsForm')?.addEventListener('submit', syncLegacyForSubmit, true);
    document.addEventListener('pointerdown', (event) => {
      if (!state.picker || state.picker.hidden) return;
      if (state.picker.contains(event.target) || event.target.closest?.('#modelButton')) return;
      closePicker(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.picker && !state.picker.hidden) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closePicker();
      }
    }, true);
    window.addEventListener('resize', () => {
      if (!state.picker || state.picker.hidden) return;
      requestAnimationFrame(positionPicker);
    });
    document.addEventListener('scroll', () => {
      if (!state.picker || state.picker.hidden) return;
      requestAnimationFrame(positionPicker);
    }, true);
  }

  async function init(dependencies = {}) {
    if (dependencies.api) state.api = dependencies.api;
    else if (!state.api) state.api = window.nano || null;
    if (typeof dependencies.toast === 'function') state.toast = dependencies.toast;
    if (typeof dependencies.icons === 'function') state.icons = dependencies.icons;
    if (typeof dependencies.showView === 'function') state.showView = dependencies.showView;
    if (typeof dependencies.onSelect === 'function') state.onSelect = dependencies.onSelect;
    if (typeof dependencies.getConfig === 'function') state.getConfig = dependencies.getConfig;

    ensureSettingsUi();
    bindOnce();
    bindModelButton();

    const config = await readConfig();
    if (config && typeof config === 'object') {
      state.config = config;
      applyConfigSelection(config);
    }
    await loadConnections();
    updateModelButton();
    observeModelButton();
    if (state.settingsMode !== 'detail') renderSettings();
    state.initialized = true;
    return getSelection();
  }

  window.NanoModels = {
    init,
    refresh,
    open: openPicker,
    selection: getSelection
  };
})();
