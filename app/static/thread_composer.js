/**
 * thread_composer.js — Thread Composer panel logic
 *
 * Responsibilities:
 *  - Build the picker UI from completed debate state
 *  - Checkbox selection per round × model
 *  - Live context preview regeneration
 *  - Token count estimate (word-count heuristic)
 *  - Role badge toggle (Participant / Product Owner, max 1 PO)
 *  - Send to Prompt tab with composed context
 */

'use strict';

// ── State ──────────────────────────────────────────────────
let _debate = null;       // debateState passed in from app.js
let _models = [];         // all model configs
let _checks = {};         // { "r1-modelId": bool, "r2-modelId": bool, ... , "prompt": bool }
let _composerRoles = {};  // { model_id: "participant" | "product_owner" }
let _composerSelected = new Set();  // model IDs selected for follow-up

// ── Entry Point ────────────────────────────────────────────
window.initThreadComposer = function(debateState, allModels) {
  _debate = debateState;
  _models = allModels;
  _checks = { prompt: true };
  _composerRoles = {};
  _composerSelected = new Set(debateState.models.map(m => m.id));

  // Init roles
  debateState.models.forEach(m => { _composerRoles[m.id] = 'participant'; });

  buildComposerUI();
  document.getElementById('thread-composer').classList.add('open');
};

window.closeThreadComposer = function() {
  document.getElementById('thread-composer').classList.remove('open');
};

// ── UI Construction ────────────────────────────────────────
function buildComposerUI() {
  buildPicksPanel();
  buildComposerModelChips();
  updatePreview();

  // Focus follow-up textarea
  setTimeout(() => {
    document.getElementById('composer-followup-textarea').focus();
  }, 300);
}

function buildPicksPanel() {
  const container = document.getElementById('composer-picks');
  container.innerHTML = '';

  // Global controls
  const controls = document.createElement('div');
  controls.id = 'composer-controls';
  controls.innerHTML = `
    <button class="composer-ctrl-btn" onclick="_composerSelectRound(1)">All Round 1</button>
    <button class="composer-ctrl-btn" onclick="_composerSelectRound(2)">All Round 2</button>
    ${_debate.rounds >= 3 ? '<button class="composer-ctrl-btn" onclick="_composerSelectRound(3)">All Round 3</button>' : ''}
    <button class="composer-ctrl-btn" onclick="_composerSelectFinals()">Select Finals</button>
    <button class="composer-ctrl-btn" onclick="_composerClearAll()">Clear All</button>
  `;
  container.appendChild(controls);

  // Original prompt section
  const promptSection = document.createElement('div');
  promptSection.className = 'composer-section';
  promptSection.innerHTML = `
    <div class="composer-section-header">
      <span class="composer-section-title">Original Prompt</span>
    </div>
    <label class="composer-item">
      <input type="checkbox" id="check-prompt" checked onchange="_composerToggle('prompt', this.checked)" />
      <div class="composer-item-label">
        <div class="composer-item-title">User prompt</div>
        <div class="composer-item-preview">${_escHtml(truncateStr(_debate.prompt, 100))}</div>
        <div class="composer-item-tokens">${_estimateTokens(_debate.prompt)} tokens</div>
      </div>
    </label>
  `;
  container.appendChild(promptSection);

  // Round sections
  for (let r = 1; r <= _debate.rounds; r++) {
    const roundSection = buildRoundSection(r);
    container.appendChild(roundSection);
  }
}

function buildRoundSection(roundNum) {
  const roundLabels = { 1: 'Round 1 — Independent Answers', 2: 'Round 2 — Critique & Refine', 3: 'Round 3 — Convergence' };
  const section = document.createElement('div');
  section.className = 'composer-section';

  const header = document.createElement('div');
  header.className = 'composer-section-header';
  header.innerHTML = `
    <span class="composer-section-title">${roundLabels[roundNum] || `Round ${roundNum}`}</span>
    <span class="composer-select-all" onclick="_composerSelectRound(${roundNum})">Select all</span>
  `;
  section.appendChild(header);

  const roundResponses = _debate.roundData[roundNum] || {};
  _debate.models.forEach(model => {
    const key = `r${roundNum}-${model.id}`;
    const text = roundResponses[model.id] || '';
    const preview = truncateStr(text, 80);
    const tokens = _estimateTokens(text);
    const checked = _checks[key] ?? false;

    const item = document.createElement('label');
    item.className = 'composer-item';
    item.innerHTML = `
      <input type="checkbox" id="check-${key}" ${checked ? 'checked' : ''}
             onchange="_composerToggle('${key}', this.checked)" />
      <div class="composer-item-label">
        <div class="composer-item-title">[Round ${roundNum}] ${_escHtml(model.display_name)}</div>
        <div class="composer-item-preview">${_escHtml(preview)}…</div>
        <div class="composer-item-tokens">${tokens} tokens</div>
      </div>
    `;
    section.appendChild(item);
  });

  return section;
}

function buildComposerModelChips() {
  const container = document.getElementById('composer-model-chips');
  container.innerHTML = '';

  _models.forEach(model => {
    const isSelected = _composerSelected.has(model.id);
    const role = _composerRoles[model.id] || 'participant';
    const isPO = role === 'product_owner';
    const accentColor = isPO ? '#FC0FC0' : (model.tier === 'paid' ? model.accent_color : '#888888');

    const chip = document.createElement('div');
    chip.className = `model-chip ${model.tier} ${isSelected ? 'selected' : ''}`;
    chip.id = `composer-chip-${model.id}`;
    chip.style.setProperty('--chip-accent', accentColor);
    if (accentColor.startsWith('#') && accentColor.length === 7) {
      chip.style.setProperty('--chip-accent-rgb', _hexToRgb(accentColor));
    }
    chip.style.cursor = 'pointer';
    chip.style.userSelect = 'none';

    chip.innerHTML = `
      ${isPO ? `<span class="chip-crown" title="Product Owner">${_crownSVG()}</span>` : ''}
      <span class="chip-name">${model.display_name}</span>
      <span class="chip-role-badge" title="Click to toggle role"
            style="font-size:9px;opacity:0.7;margin-left:2px">${isPO ? '👑' : ''}</span>
    `;

    // Left click → toggle selection
    chip.addEventListener('click', (e) => {
      if (e.target.closest('.chip-role-toggle')) return;
      _composerToggleChip(model.id);
    });

    // Right click → toggle role
    chip.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      _composerToggleRole(model.id);
    });

    // Long press on mobile → toggle role
    let longPressTimer;
    chip.addEventListener('pointerdown', () => {
      longPressTimer = setTimeout(() => _composerToggleRole(model.id), 600);
    });
    chip.addEventListener('pointerup', () => clearTimeout(longPressTimer));
    chip.addEventListener('pointercancel', () => clearTimeout(longPressTimer));

    container.appendChild(chip);
  });

  // Role legend hint
  const hint = document.createElement('span');
  hint.style.cssText = 'font-size:10px;color:var(--text-dim);white-space:nowrap;margin-left:4px';
  hint.textContent = 'Right-click chip for PO role';
  container.appendChild(hint);
}

function _composerToggleChip(modelId) {
  if (_composerSelected.has(modelId)) {
    if (_composerSelected.size <= 1) return;
    _composerSelected.delete(modelId);
  } else {
    _composerSelected.add(modelId);
  }
  buildComposerModelChips();
}

function _composerToggleRole(modelId) {
  const current = _composerRoles[modelId] || 'participant';
  if (current === 'participant') {
    // Demote any existing PO
    Object.keys(_composerRoles).forEach(id => {
      if (_composerRoles[id] === 'product_owner') {
        _composerRoles[id] = 'participant';
      }
    });
    _composerRoles[modelId] = 'product_owner';
  } else {
    _composerRoles[modelId] = 'participant';
  }
  buildComposerModelChips();
}

// ── Selection helpers ──────────────────────────────────────
window._composerToggle = function(key, checked) {
  _checks[key] = checked;
  updatePreview();
};

window._composerSelectRound = function(roundNum) {
  _debate.models.forEach(m => {
    const key = `r${roundNum}-${m.id}`;
    _checks[key] = true;
    const el = document.getElementById(`check-${key}`);
    if (el) el.checked = true;
  });
  updatePreview();
};

window._composerSelectFinals = function() {
  const finalRound = _debate.rounds;
  _debate.models.forEach(m => {
    const key = `r${finalRound}-${m.id}`;
    _checks[key] = true;
    const el = document.getElementById(`check-${key}`);
    if (el) el.checked = true;
  });
  updatePreview();
};

window._composerClearAll = function() {
  Object.keys(_checks).forEach(k => { _checks[k] = false; });
  // Uncheck all checkboxes
  document.querySelectorAll('#composer-picks input[type="checkbox"]').forEach(el => {
    el.checked = false;
  });
  // Keep original prompt checked by default
  _checks['prompt'] = true;
  const promptCheck = document.getElementById('check-prompt');
  if (promptCheck) promptCheck.checked = true;
  updatePreview();
};

// ── Context Preview ────────────────────────────────────────
function buildComposedContext() {
  const parts = [];

  if (_checks['prompt']) {
    parts.push(`--- Original Prompt ---\n${_debate.prompt}`);
  }

  for (let r = 1; r <= _debate.rounds; r++) {
    const roundResponses = _debate.roundData[r] || {};
    _debate.models.forEach(model => {
      const key = `r${r}-${model.id}`;
      if (_checks[key] && roundResponses[model.id]) {
        parts.push(`--- Round ${r}: ${model.display_name} ---\n${roundResponses[model.id].trim()}`);
      }
    });
  }

  return parts.join('\n\n');
}

function updatePreview() {
  const context = buildComposedContext();
  const preview = document.getElementById('composer-preview-text');
  const tokenEl = document.getElementById('composer-token-count');

  preview.textContent = context || 'Select items on the left to build your context…';

  const tokens = _estimateTokens(context);
  tokenEl.textContent = `${tokens.toLocaleString()} tokens`;
  tokenEl.classList.toggle('warning', tokens > 3500);

  if (tokens > 4000) {
    tokenEl.title = 'Warning: context is large and may exceed model limits';
  } else {
    tokenEl.title = '';
  }
}

// ── Send to Prompt tab ─────────────────────────────────────
window.sendFromComposer = function() {
  const context = buildComposedContext();
  const followup = document.getElementById('composer-followup-textarea').value.trim();

  if (!context && !followup) return;

  const combined = [context, followup].filter(Boolean).join('\n\n');

  // Set roles for app.js to pick up
  window._composerRoles = { ..._composerRoles };

  // Update selected models in prompt tab
  window.selectedPromptModels = new Set(_composerSelected);
  window.buildChipSelector('chip-selector-prompt', window.selectedPromptModels, 'prompt');

  // Close composer
  closeThreadComposer();

  // Switch to prompt tab
  window.switchTab('prompt');

  // Set textarea value and fire
  const ta = document.getElementById('prompt-textarea');
  ta.value = combined;
  ta.dispatchEvent(new Event('input'));

  // Auto-send
  window.sendPrompt(combined);
};

// ── Utilities ──────────────────────────────────────────────
function _estimateTokens(text) {
  if (!text) return 0;
  // ~1.3 tokens per word heuristic
  return Math.round(text.split(/\s+/).filter(Boolean).length * 1.3);
}

function _escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncateStr(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) : str;
}

function _hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b}`;
}

function _crownSVG() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="color:var(--accent)">
    <path d="M2 19l2-9 5 5 3-9 3 9 5-5 2 9H2z"/>
  </svg>`;
}

// Close on backdrop click
document.addEventListener('DOMContentLoaded', () => {
  const overlay = document.getElementById('thread-composer');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeThreadComposer();
    });
  }
});
