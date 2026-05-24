/**
 * app.js — PolyMind main frontend logic
 *
 * Responsibilities:
 *  - Model loading and chip selector
 *  - Tab switching
 *  - Image paste/drop handling
 *  - Prompt sending + SSE streaming
 *  - Response card creation and token streaming
 *  - Markdown rendering (inline, no external lib)
 *  - Session history (in-memory)
 *  - Cost summary bar
 *  - OpenRouter balance display
 *  - Debate tab logic
 *  - LocalStorage: reset counter only
 */

'use strict';

// ── State ──────────────────────────────────────────────────
let allModels = [];                    // full model list from /api/models
let selectedPromptModels = new Set();  // model IDs selected on prompt tab
let selectedDebateModels = new Set();  // model IDs selected on debate tab
let attachedImage = null;              // { base64, mediaType, name }
let sessionHistory = [];               // [{ prompt, timestamp, responses }]
let sessionCosts = {};                 // { model_id: { inputTok, outputTok, cost } }
let costResetDate = null;              // Date stored in localStorage
let activeSSE = null;                  // current EventSource
let debateState = null;                // completed debate data for Thread Composer

// ── Inline Markdown Renderer ───────────────────────────────
function renderMarkdown(text) {
  if (!text) return '';

  // Escape HTML first
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="lang-${lang}">${code.trimEnd()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Blockquote
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists (simple)
  html = html.replace(/^[\*\-] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Horizontal rule
  html = html.replace(/^---+$/gm, '<hr>');

  // Newlines → <br> (but not inside block elements)
  html = html.replace(/\n/g, '<br>');

  return html;
}

// ── SVG Icons (inline) ────────────────────────────────────
const ICONS = {
  eye: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`,
  crown: `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M2 19l2-9 5 5 3-9 3 9 5-5 2 9H2z"/></svg>`,
  copy: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  check: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
};

// ── Utility ────────────────────────────────────────────────
function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b}`;
}

function formatCost(usd) {
  if (usd === 0) return '$0.00';
  if (usd < 0.000001) return '<$0.000001';
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

function formatTokens(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function timeStr(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function truncate(str, len = 60) {
  return str.length > len ? str.slice(0, len) + '…' : str;
}

// ── Initialization ─────────────────────────────────────────
async function init() {
  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/static/sw.js').catch(() => {});
  }

  // Online/offline banner
  function updateOnlineBanner() {
    document.getElementById('offline-banner').classList.toggle('visible', !navigator.onLine);
  }
  window.addEventListener('online', updateOnlineBanner);
  window.addEventListener('offline', updateOnlineBanner);
  updateOnlineBanner();

  // Load localStorage
  const savedResetDate = localStorage.getItem('polymind_reset_date');
  if (savedResetDate) {
    costResetDate = new Date(savedResetDate);
    updateResetLabel();
  }

  // Fetch models
  try {
    const resp = await fetch('/api/models');
    allModels = await resp.json();
  } catch (e) {
    console.error('Failed to load models', e);
    allModels = [];
  }

  // Default selections: first 3 models
  allModels.slice(0, 3).forEach(m => {
    selectedPromptModels.add(m.id);
    selectedDebateModels.add(m.id);
  });

  buildChipSelector('chip-selector-prompt', selectedPromptModels, 'prompt');
  buildChipSelector('chip-selector-debate', selectedDebateModels, 'debate');
  updateDebateCostEstimate();
  initCostRows();

  // Fetch balance
  fetchBalance();

  // Input event listeners
  const ta = document.getElementById('prompt-textarea');
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); sendPrompt(); }
  });
  ta.addEventListener('input', autoResize.bind(null, ta));
  ta.addEventListener('paste', handlePaste);

  const dta = document.getElementById('debate-textarea');
  dta.addEventListener('input', autoResize.bind(null, dta));

  // Drag-drop on prompt textarea
  ta.addEventListener('dragover', (e) => { e.preventDefault(); ta.style.borderColor = 'var(--accent)'; });
  ta.addEventListener('dragleave', () => { ta.style.borderColor = ''; });
  ta.addEventListener('drop', handleDrop);

  // Debate chip changes recalculate estimate
  document.querySelectorAll('input[name="rounds"]').forEach(r => {
    r.addEventListener('change', updateDebateCostEstimate);
  });
}

// ── Auto-resize textarea ───────────────────────────────────
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

// ── Tab switching ──────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.remove('active');
    b.setAttribute('aria-selected', 'false');
  });
  document.getElementById(`tab-${name}`).classList.add('active');
  const btn = document.getElementById(`tab-${name}-btn`);
  btn.classList.add('active');
  btn.setAttribute('aria-selected', 'true');
}

// ── Chip Selector ──────────────────────────────────────────
function buildChipSelector(containerId, selectedSet, tab) {
  const container = document.getElementById(containerId);
  // Remove existing chips (preserve non-chip elements)
  container.querySelectorAll('.model-chip').forEach(c => c.remove());

  // Find the sidebar toggle if this is the prompt tab
  const toggleBtn = container.querySelector('#sidebar-toggle');

  allModels.forEach(model => {
    const chip = document.createElement('button');
    chip.className = `model-chip ${model.tier}`;
    chip.id = `chip-${tab}-${model.id}`;
    chip.setAttribute('aria-pressed', String(selectedSet.has(model.id)));
    chip.title = model.tier === 'paid'
      ? `${model.display_name} · ${model.prompts_per_10_usd || ''}`
      : `${model.display_name} · Free`;

    // Accent color CSS vars for paid chips
    if (model.tier === 'paid' && model.accent_color) {
      chip.style.setProperty('--chip-accent', model.accent_color);
      chip.style.setProperty('--chip-accent-rgb', hexToRgb(model.accent_color));
    }

    chip.innerHTML = `
      ${selectedSet.has(model.id) ? '' : ''}
      <span class="chip-name">${model.display_name}</span>
      ${model.vision ? `<span class="chip-vision" title="Vision capable">${ICONS.eye}</span>` : ''}
      <span class="chip-badge">${model.tier === 'free' ? 'FREE' : (model.prompts_per_10_usd || 'PAID')}</span>
    `;

    if (selectedSet.has(model.id)) chip.classList.add('selected');

    chip.addEventListener('click', () => toggleChip(model.id, selectedSet, tab));
    container.insertBefore(chip, toggleBtn || null);
  });
}

function toggleChip(modelId, selectedSet, tab) {
  if (selectedSet.has(modelId)) {
    // Don't allow deselecting the last chip
    if (selectedSet.size <= 1) return;
    selectedSet.delete(modelId);
  } else {
    selectedSet.add(modelId);
  }

  const chipId = `chip-${tab}-${modelId}`;
  const chip = document.getElementById(chipId);
  if (chip) {
    chip.classList.toggle('selected', selectedSet.has(modelId));
    chip.setAttribute('aria-pressed', String(selectedSet.has(modelId)));
  }

  if (tab === 'debate') updateDebateCostEstimate();
}

// ── Image handling ─────────────────────────────────────────
function handlePaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      processImageFile(item.getAsFile());
      return;
    }
  }
}

function handleDrop(e) {
  e.preventDefault();
  document.getElementById('prompt-textarea').style.borderColor = '';
  const file = e.dataTransfer?.files[0];
  if (file && file.type.startsWith('image/')) {
    processImageFile(file);
  }
}

function processImageFile(file) {
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) {
    alert('Image is too large. Maximum size is 4 MB.');
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    const [header, base64] = dataUrl.split(',');
    const mediaType = header.match(/data:([^;]+)/)[1];
    attachedImage = { base64, mediaType, name: file.name };

    document.getElementById('image-thumb').src = dataUrl;
    document.getElementById('image-name').textContent = truncate(file.name, 40);
    document.getElementById('image-preview-area').classList.add('visible');

    // Warn about non-vision models
    updateVisionWarnings();
  };
  reader.readAsDataURL(file);
}

function removeImage() {
  attachedImage = null;
  document.getElementById('image-preview-area').classList.remove('visible');
  document.getElementById('image-thumb').src = '';
  document.getElementById('image-name').textContent = '';
}

function updateVisionWarnings() {
  allModels.forEach(model => {
    const chip = document.getElementById(`chip-prompt-${model.id}`);
    if (!chip) return;
    const hasImg = !!attachedImage;
    const noVision = !model.vision;
    // Show a subtle warning indicator on non-vision chips when image attached
    let warn = chip.querySelector('.chip-no-vision-warn');
    if (hasImg && noVision && selectedPromptModels.has(model.id)) {
      if (!warn) {
        warn = document.createElement('span');
        warn.className = 'chip-no-vision-warn';
        warn.title = 'This model cannot see images';
        warn.textContent = ' ⚠';
        warn.style.cssText = 'font-size:9px;color:#f0a830;';
        chip.appendChild(warn);
      }
    } else {
      warn?.remove();
    }
  });
}

// ── Balance display ────────────────────────────────────────
async function fetchBalance() {
  try {
    const resp = await fetch('/api/balance');
    const data = await resp.json();
    const val = data.openrouter_balance_usd;
    document.getElementById('balance-val').textContent =
      val != null ? `$${Number(val).toFixed(2)}` : 'Unavailable';
    const fetched = data.fetched_at
      ? new Date(data.fetched_at).toLocaleTimeString()
      : '—';
    document.getElementById('balance-time').textContent = fetched;
  } catch {
    document.getElementById('balance-val').textContent = 'Unavailable';
  }
}

// ── Session History ────────────────────────────────────────
function addToHistory(prompt, responseMap) {
  const entry = {
    id: Date.now(),
    prompt,
    timestamp: new Date(),
    responseMap: { ...responseMap },
  };
  sessionHistory.unshift(entry);
  renderHistoryList();
  return entry.id;
}

function renderHistoryList() {
  const list = document.getElementById('history-list');
  list.innerHTML = '';
  if (sessionHistory.length === 0) {
    list.innerHTML = '<div style="padding:12px;font-size:12px;color:var(--text-dim)">No history yet</div>';
    return;
  }
  sessionHistory.forEach(entry => {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.setAttribute('role', 'listitem');
    item.innerHTML = `
      <div class="hi-prompt">${truncate(entry.prompt, 50)}</div>
      <div class="hi-time">${timeStr(entry.timestamp)}</div>
    `;
    item.addEventListener('click', () => showHistoryEntry(entry));
    list.appendChild(item);
  });
}

function showHistoryEntry(entry) {
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('past-label').classList.add('visible');
  renderResponseGrid(entry.responseMap, true);

  // Highlight active history item
  document.querySelectorAll('.history-item').forEach(el => el.classList.remove('active'));
  event?.currentTarget?.classList.add('active');
}

function clearHistory() {
  sessionHistory = [];
  renderHistoryList();
  document.getElementById('past-label').classList.remove('visible');
  document.getElementById('response-grid').innerHTML = '';
  document.getElementById('empty-state').style.display = '';
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.toggle('collapsed');
  sidebar.classList.toggle('open');
}

// ── Response Card ──────────────────────────────────────────
function createResponseCard(model) {
  const card = document.createElement('article');
  card.className = 'response-card';
  card.id = `card-${model.id}`;
  card.setAttribute('role', 'listitem');
  card.setAttribute('aria-label', `${model.display_name} response`);

  const accentColor = model.tier === 'paid' ? model.accent_color : '#888888';

  card.innerHTML = `
    <div class="card-header">
      <div class="card-dot" style="background:${accentColor}"></div>
      <span class="card-model-name">${model.display_name}</span>
      <span class="card-provider-badge">${model.provider_label}</span>
      <div class="card-meta">
        <span class="card-token-info" id="tokens-${model.id}">—</span>
        <button class="card-copy-btn" id="copy-${model.id}"
                onclick="copyCard('${model.id}')" aria-label="Copy response">
          ${ICONS.copy} Copy
        </button>
      </div>
    </div>
    <div class="card-body typing-cursor" id="body-${model.id}"></div>
    <div class="card-footer">
      <div class="context-bar-label">
        <span>Context</span>
        <span id="ctx-pct-${model.id}">0%</span>
      </div>
      <div class="context-bar-track">
        <div class="context-bar-fill" id="ctx-bar-${model.id}" style="width:0%"></div>
      </div>
    </div>
  `;

  return card;
}

function renderResponseGrid(responseMap, readOnly = false) {
  const grid = document.getElementById('response-grid');
  grid.innerHTML = '';

  Object.entries(responseMap).forEach(([modelId, content]) => {
    const model = allModels.find(m => m.id === modelId);
    if (!model) return;
    const card = createResponseCard(model);
    const body = card.querySelector(`#body-${modelId}`);
    body.classList.remove('typing-cursor');
    body.innerHTML = renderMarkdown(content);
    grid.appendChild(card);
  });
}

// ── Copy card content ──────────────────────────────────────
function copyCard(modelId) {
  const body = document.getElementById(`body-${modelId}`);
  if (!body) return;
  const text = body.innerText || body.textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById(`copy-${modelId}`);
    btn.classList.add('copied');
    btn.innerHTML = `${ICONS.check} Copied!`;
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = `${ICONS.copy} Copy`;
    }, 2000);
  });
}

// ── Cost Tracking ──────────────────────────────────────────
function initCostRows() {
  const container = document.getElementById('cost-rows');
  container.innerHTML = '';
  allModels.forEach(model => {
    if (model.tier !== 'paid') return;
    const accentColor = model.accent_color || '#888';
    const row = document.createElement('div');
    row.className = 'cost-row';
    row.id = `cost-row-${model.id}`;
    row.innerHTML = `
      <div class="cost-dot" style="background:${accentColor}"></div>
      <span>${model.display_name}</span>
      <span class="cost-val" id="cost-val-${model.id}">—</span>
      ${model.billing_note ? '<span class="cost-note">*</span>' : ''}
    `;
    container.appendChild(row);
  });
}

function updateCostRow(model, inputTok, outputTok, totalCost) {
  if (!sessionCosts[model.id]) {
    sessionCosts[model.id] = { inputTok: 0, outputTok: 0, cost: 0 };
  }
  sessionCosts[model.id].inputTok += inputTok;
  sessionCosts[model.id].outputTok += outputTok;
  sessionCosts[model.id].cost += totalCost;

  const val = document.getElementById(`cost-val-${model.id}`);
  if (val) {
    const c = sessionCosts[model.id];
    val.textContent = `${formatTokens(c.inputTok)} in / ${formatTokens(c.outputTok)} out · ${formatCost(c.cost)}`;
  }

  // Update session total
  let total = Object.values(sessionCosts).reduce((s, v) => s + v.cost, 0);
  document.getElementById('cost-total-val').textContent = formatCost(total);
  document.getElementById('cost-total-row').style.display = total > 0 ? 'flex' : 'none';
}

function resetCost() {
  sessionCosts = {};
  costResetDate = new Date();
  localStorage.setItem('polymind_reset_date', costResetDate.toISOString());
  initCostRows();
  document.getElementById('cost-total-row').style.display = 'none';
  updateResetLabel();
}

function updateResetLabel() {
  const el = document.getElementById('reset-label');
  if (el && costResetDate) {
    el.textContent = `Reset on ${costResetDate.toLocaleDateString()}`;
  }
}

// ── Prompt Sending ─────────────────────────────────────────
async function sendPrompt(prefilled = null) {
  const ta = document.getElementById('prompt-textarea');
  const promptText = prefilled || ta.value.trim();
  if (!promptText) return;

  const modelIds = [...selectedPromptModels];
  if (modelIds.length === 0) return;

  // Cancel any running stream
  if (activeSSE) { activeSSE.abort?.(); activeSSE = null; }

  // UI state
  setSendLoading(true);
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('past-label').classList.remove('visible');

  // Create cards immediately
  const grid = document.getElementById('response-grid');
  grid.innerHTML = '';
  const cards = {};
  const rawTexts = {};  // accumulate text per model for history

  modelIds.forEach(modelId => {
    const model = allModels.find(m => m.id === modelId);
    if (!model) return;
    const card = createResponseCard(model);
    grid.appendChild(card);
    cards[modelId] = card;
    rawTexts[modelId] = '';
  });

  // Build request body
  const body = {
    prompt: promptText,
    model_ids: modelIds,
    model_roles: {},  // Thread Composer sets this when sending
  };
  if (attachedImage) {
    body.image_base64 = attachedImage.base64;
    body.image_media_type = attachedImage.mediaType;
  }

  // If prefilled from composer, roles may be injected via window._composerRoles
  if (window._composerRoles) {
    body.model_roles = window._composerRoles;
    window._composerRoles = null;
  }

  // POST to /api/prompt — SSE via fetch + ReadableStream
  const controller = new AbortController();
  activeSSE = controller;

  let doneCount = 0;

  try {
    const resp = await fetch('/api/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    await readSSEStream(resp, (event) => {
      const data = JSON.parse(event);
      handlePromptEvent(data, cards, rawTexts);
      if (data.type === 'done' || data.type === 'error') {
        doneCount++;
        if (doneCount >= modelIds.length) {
          setSendLoading(false);
          activeSSE = null;
          // Remove typing cursors
          Object.values(cards).forEach(card => {
            card.querySelector('.card-body')?.classList.remove('typing-cursor');
          });
          // Add to history
          addToHistory(promptText, rawTexts);
          // Refresh balance
          fetchBalance();
        }
      }
    });
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('SSE error', err);
    }
    setSendLoading(false);
    activeSSE = null;
  }

  if (!prefilled) {
    ta.value = '';
    ta.style.height = '';
  }
}

function handlePromptEvent(data, cards, rawTexts) {
  const { type, model_id } = data;
  const model = allModels.find(m => m.id === model_id);
  if (!model && type !== 'error') return;

  if (type === 'token') {
    const body = document.getElementById(`body-${model_id}`);
    if (body) {
      rawTexts[model_id] = (rawTexts[model_id] || '') + data.text;
      body.innerHTML = renderMarkdown(rawTexts[model_id]);
    }
  } else if (type === 'usage') {
    // Update token info in card header
    const tokenEl = document.getElementById(`tokens-${model_id}`);
    if (tokenEl) {
      tokenEl.textContent = `${formatTokens(data.input_tokens)}→${formatTokens(data.output_tokens)} tok · ${formatCost(data.total_cost_usd)}`;
    }
    // Update context bar
    const pct = model ? Math.min(100, ((data.input_tokens + data.output_tokens) / model.context_window) * 100) : 0;
    const bar = document.getElementById(`ctx-bar-${model_id}`);
    const pctEl = document.getElementById(`ctx-pct-${model_id}`);
    if (bar) {
      bar.style.width = `${pct.toFixed(1)}%`;
      bar.classList.toggle('warning', pct > 60 && pct <= 85);
      bar.classList.toggle('danger', pct > 85);
    }
    if (pctEl) pctEl.textContent = `${pct.toFixed(1)}%`;
    // Update cost summary
    if (model && model.tier === 'paid') {
      updateCostRow(model, data.input_tokens, data.output_tokens, data.total_cost_usd);
    }
  } else if (type === 'error') {
    const body = document.getElementById(`body-${model_id}`);
    if (body) {
      body.classList.add('error');
      body.classList.remove('typing-cursor');
      body.textContent = data.message || 'Unknown error';
    }
  }
}

// ── SSE Stream Reader (fetch-based) ───────────────────────
async function readSSEStream(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop();  // keep incomplete line

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const payload = line.slice(6).trim();
        if (payload && payload !== '[DONE]') {
          onEvent(payload);
        }
      }
    }
  }
}

// ── Loading state ──────────────────────────────────────────
function setSendLoading(loading) {
  const btn = document.getElementById('send-btn');
  btn.classList.toggle('loading', loading);
  btn.disabled = loading;
}

function setDebateLoading(loading) {
  const btn = document.getElementById('start-debate-btn');
  btn.classList.toggle('loading', loading);
  btn.disabled = loading;
}

// ── Debate tab ─────────────────────────────────────────────
function updateDebateCostEstimate() {
  const rounds = parseInt(document.querySelector('input[name="rounds"]:checked')?.value || 3);
  const modelIds = [...selectedDebateModels];
  const models = modelIds.map(id => allModels.find(m => m.id === id)).filter(Boolean);
  const paidModels = models.filter(m => m.tier === 'paid');

  if (paidModels.length === 0) {
    document.getElementById('debate-cost-estimate').classList.remove('visible');
    return;
  }

  // Simple estimate: 400 avg prompt + 400 avg response per model per round
  const avgIn = 400;
  const avgOut = 400;
  let total = 0;
  paidModels.forEach(m => {
    for (let r = 1; r <= rounds; r++) {
      const inputTok = avgIn + (r - 1) * models.length * avgOut;
      total += (inputTok / 1e6 * m.input_cost_per_million) + (avgOut / 1e6 * m.output_cost_per_million);
    }
  });

  const el = document.getElementById('debate-cost-estimate');
  el.textContent = `Estimated cost: ~${formatCost(total)} for ${paidModels.length} paid model${paidModels.length > 1 ? 's' : ''} × ${rounds} rounds`;
  el.classList.add('visible');
}

async function startDebate() {
  const ta = document.getElementById('debate-textarea');
  const prompt = ta.value.trim();
  if (!prompt) return;

  const modelIds = [...selectedDebateModels];
  if (modelIds.length === 0) return;

  const rounds = parseInt(document.querySelector('input[name="rounds"]:checked')?.value || 3);

  setDebateLoading(true);
  document.getElementById('debate-content').innerHTML = '';
  document.getElementById('debate-footer').classList.remove('visible');
  debateState = { prompt, rounds, roundData: {} };  // reset

  const controller = new AbortController();
  activeSSE = controller;

  const rawResponses = { 1: {}, 2: {}, 3: {} };
  let totalCost = 0;

  try {
    const resp = await fetch('/api/debate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, model_ids: modelIds, rounds }),
      signal: controller.signal,
    });

    await readSSEStream(resp, (event) => {
      const data = JSON.parse(event);
      handleDebateEvent(data, modelIds, rawResponses, (cost) => { totalCost += cost; });
    });
  } catch (err) {
    if (err.name !== 'AbortError') console.error('Debate SSE error', err);
  }

  setDebateLoading(false);
  activeSSE = null;

  // Update debate state for thread composer
  debateState.roundData = rawResponses;
  debateState.models = modelIds.map(id => allModels.find(m => m.id === id)).filter(Boolean);

  // Show footer
  document.getElementById('debate-cost-val').textContent = formatCost(totalCost);
  document.getElementById('debate-footer').classList.add('visible');
  fetchBalance();
}

function handleDebateEvent(data, modelIds, rawResponses, onCost) {
  const { type } = data;

  if (type === 'round_start') {
    createRoundSection(data.round_number, data.label, modelIds);
  } else if (type === 'token') {
    const { model_id, round_number, text } = data;
    rawResponses[round_number] = rawResponses[round_number] || {};
    rawResponses[round_number][model_id] = (rawResponses[round_number][model_id] || '') + text;
    const body = document.getElementById(`body-r${round_number}-${model_id}`);
    if (body) {
      body.innerHTML = renderMarkdown(rawResponses[round_number][model_id]);
    }
  } else if (type === 'usage') {
    const { model_id, round_number, input_tokens, output_tokens, total_cost_usd } = data;
    const tokenEl = document.getElementById(`tokens-r${round_number}-${model_id}`);
    const model = allModels.find(m => m.id === model_id);
    if (tokenEl) {
      tokenEl.textContent = `${formatTokens(input_tokens)}→${formatTokens(output_tokens)} · ${formatCost(total_cost_usd)}`;
    }
    if (model && model.tier === 'paid') {
      updateCostRow(model, input_tokens, output_tokens, total_cost_usd);
      onCost(total_cost_usd);
    }
    // Update round header cost
    const roundCostEl = document.getElementById(`round-cost-${round_number}`);
    // Will be updated cumulatively
  } else if (type === 'done') {
    const { model_id, round_number } = data;
    const body = document.getElementById(`body-r${round_number}-${model_id}`);
    if (body) body.classList.remove('typing-cursor');
  } else if (type === 'error') {
    const { model_id, round_number, message } = data;
    const body = document.getElementById(`body-r${round_number}-${model_id}`);
    if (body) {
      body.classList.add('error');
      body.classList.remove('typing-cursor');
      body.textContent = message;
    }
  }
}

function createRoundSection(roundNum, label, modelIds) {
  const container = document.getElementById('debate-content');

  const section = document.createElement('div');
  section.className = 'debate-round';
  section.id = `debate-round-${roundNum}`;

  section.innerHTML = `
    <div class="round-header">
      <div class="round-badge">Round ${roundNum}</div>
      <span style="font-size:13px;color:var(--text-muted)">${label}</span>
      <div class="round-divider"></div>
      <span class="round-cost" id="round-cost-${roundNum}"></span>
    </div>
    <div class="round-grid" id="round-grid-${roundNum}"></div>
  `;

  container.appendChild(section);

  // Create cards for this round
  const grid = section.querySelector(`#round-grid-${roundNum}`);
  modelIds.forEach(modelId => {
    const model = allModels.find(m => m.id === modelId);
    if (!model) return;

    const accentColor = model.tier === 'paid' ? model.accent_color : '#888888';
    const card = document.createElement('article');
    card.className = 'response-card';
    card.id = `round-card-r${roundNum}-${modelId}`;

    card.innerHTML = `
      <div class="card-header">
        <div class="card-dot" style="background:${accentColor}"></div>
        <span class="card-model-name">${model.display_name}</span>
        <div class="card-meta">
          <span class="card-token-info" id="tokens-r${roundNum}-${modelId}">—</span>
          <button class="card-copy-btn" onclick="copyDebateCard(${roundNum}, '${modelId}')"
                  aria-label="Copy response">${ICONS.copy} Copy</button>
        </div>
      </div>
      <div class="card-body typing-cursor" id="body-r${roundNum}-${modelId}"></div>
    `;

    grid.appendChild(card);
  });

  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function copyDebateCard(roundNum, modelId) {
  const body = document.getElementById(`body-r${roundNum}-${modelId}`);
  if (!body) return;
  navigator.clipboard.writeText(body.innerText || body.textContent);
}

function newDebate() {
  document.getElementById('debate-content').innerHTML = '';
  document.getElementById('debate-footer').classList.remove('visible');
  document.getElementById('debate-textarea').value = '';
  debateState = null;
}

// ── Thread Composer entry point ────────────────────────────
function openThreadComposer() {
  if (!debateState) return;
  window.initThreadComposer(debateState, allModels);
}

// ── Initialize ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
