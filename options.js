'use strict';

/*
 * KEATS Video Summariser — options page.
 * Stores the Google Gemini API key in chrome.storage.local.apiKey.
 */

/** Mask a key for display, e.g. "AQ.…abcd" or "AIza…abcd". Pure. */
function maskKey(key) {
  const k = String(key || '').trim();
  if (!k) return '';
  const prefixLen = k.startsWith('AQ.') ? 3 : 4;
  if (k.length <= prefixLen + 4) return k.slice(0, prefixLen) + '…';
  return k.slice(0, prefixLen) + '…' + k.slice(-4);
}

/** Light validation. Returns an error string, or '' if the key looks OK. Pure. */
function validateKey(key) {
  if (!key) return 'Please paste your Google Gemini API key.';
  if (!key.startsWith('AQ.') && !key.startsWith('AIza')) {
    return 'That doesn\'t look like a Google Gemini API key — it should start with "AQ." or "AIza".';
  }
  if (/\s/.test(key)) return 'The key must not contain spaces or line breaks.';
  if (key.length < 20) return 'That key looks too short — please check you copied all of it.';
  return '';
}

const optEls = {};
let statusTimer = null;

function initOptions() {
  ['keyForm', 'apiKeyInput', 'toggleVisibility', 'saveBtn', 'removeBtn', 'currentKey', 'status']
    .forEach(function (id) { optEls[id] = document.getElementById(id); });

  optEls.keyForm.addEventListener('submit', onSave);
  optEls.removeBtn.addEventListener('click', onRemove);
  optEls.toggleVisibility.addEventListener('click', onToggleVisibility);

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && 'apiKey' in changes) renderCurrentKey(changes.apiKey.newValue);
  });

  chrome.storage.local.get('apiKey', function (data) {
    if (chrome.runtime.lastError) {
      setStatus('Could not read storage: ' + chrome.runtime.lastError.message, 'error');
      return;
    }
    renderCurrentKey(data && data.apiKey);
  });
}

function renderCurrentKey(key) {
  const has = typeof key === 'string' && key.trim() !== '';
  optEls.currentKey.textContent = '';
  if (has) {
    optEls.currentKey.appendChild(document.createTextNode('Saved key: '));
    const code = document.createElement('code');
    code.textContent = maskKey(key.trim());
    optEls.currentKey.appendChild(code);
  } else {
    optEls.currentKey.textContent = 'No key saved.';
  }
  optEls.removeBtn.disabled = !has;
}

function setStatus(text, kind) {
  optEls.status.textContent = text;
  optEls.status.className = 'status' + (kind ? ' ' + kind : '');
  clearTimeout(statusTimer);
  if (kind === 'ok') {
    statusTimer = setTimeout(function () { setStatus('', ''); }, 4000);
  }
}

function onSave(event) {
  event.preventDefault();
  const key = optEls.apiKeyInput.value.trim();
  const err = validateKey(key);
  if (err) {
    setStatus(err, 'error');
    optEls.apiKeyInput.focus();
    return;
  }
  optEls.saveBtn.disabled = true;
  chrome.storage.local.set({ apiKey: key }, function () {
    optEls.saveBtn.disabled = false;
    if (chrome.runtime.lastError) {
      setStatus('Could not save: ' + chrome.runtime.lastError.message, 'error');
      return;
    }
    optEls.apiKeyInput.value = '';
    setVisibility(false);
    renderCurrentKey(key);
    setStatus('Saved (' + maskKey(key) + ')', 'ok');
  });
}

function onRemove() {
  chrome.storage.local.remove('apiKey', function () {
    if (chrome.runtime.lastError) {
      setStatus('Could not remove key: ' + chrome.runtime.lastError.message, 'error');
      return;
    }
    optEls.apiKeyInput.value = '';
    renderCurrentKey('');
    setStatus('Key removed.', 'ok');
  });
}

function setVisibility(show) {
  optEls.apiKeyInput.type = show ? 'text' : 'password';
  optEls.toggleVisibility.textContent = show ? 'Hide' : 'Show';
  optEls.toggleVisibility.setAttribute('aria-pressed', show ? 'true' : 'false');
}

function onToggleVisibility() {
  setVisibility(optEls.apiKeyInput.type === 'password');
}

document.addEventListener('DOMContentLoaded', initOptions);
