'use strict';

/*
 * KEATS Video Summariser — options page.
 * Stores the Groq Cloud API key in chrome.storage.local.apiKey.
 */

/** Mask a key for display, e.g. "gsk_…abcd". Pure. */
function maskKey(key) {
  const k = String(key || '').trim();
  if (!k) return '';
  const prefixLen = 4;
  if (k.length <= prefixLen + 4) return k.slice(0, prefixLen) + '…';
  return k.slice(0, prefixLen) + '…' + k.slice(-4);
}

/** Light validation. Returns an error string, or '' if the key looks OK. Pure. */
function validateKey(key) {
  if (!key) return 'Please paste your Groq API key.';
  if (!key.startsWith('gsk_')) {
    return 'That doesn\'t look like a Groq API key — it should start with "gsk_".';
  }
  if (/\s/.test(key)) return 'The key must not contain spaces or line breaks.';
  if (key.length < 20) return 'That key looks too short — please check you copied all of it.';
  return '';
}

const optEls = {};
let statusTimer = null;
let currentSettings = {};

function initOptions() {
  ['keyForm', 'apiKeyInput', 'toggleVisibility', 'saveBtn', 'removeBtn', 'currentKey', 'status', 'themeToggle', 'themeIconMoon', 'themeIconSun']
    .forEach(function (id) { optEls[id] = document.getElementById(id); });

  optEls.keyForm.addEventListener('submit', onSave);
  optEls.removeBtn.addEventListener('click', onRemove);
  optEls.toggleVisibility.addEventListener('click', onToggleVisibility);
  if (optEls.themeToggle) optEls.themeToggle.addEventListener('click', onToggleTheme);

  if (typeof window !== 'undefined' && window.matchMedia) {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    if (media && media.addEventListener) {
      media.addEventListener('change', function () {
        if (!currentSettings || !currentSettings.theme || currentSettings.theme === 'system') {
          updateThemeIcons();
        }
      });
    }
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local') {
      if ('apiKey' in changes) renderCurrentKey(changes.apiKey.newValue);
      if ('settings' in changes) {
        currentSettings = changes.settings.newValue || {};
        applyTheme(currentSettings.theme);
      }
    }
  });

  chrome.storage.local.get(['apiKey', 'settings'], function (data) {
    if (chrome.runtime.lastError) {
      setStatus('Could not read storage: ' + chrome.runtime.lastError.message, 'error');
      return;
    }
    renderCurrentKey(data && data.apiKey);
    currentSettings = (data && data.settings && typeof data.settings === 'object') ? data.settings : {};
    applyTheme(currentSettings.theme);
  });
}

function isDarkModeActive() {
  const theme = currentSettings && currentSettings.theme;
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return false;
}

function applyTheme(theme) {
  if (typeof document === 'undefined' || !document.documentElement) return;
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  updateThemeIcons();
}

function updateThemeIcons() {
  const dark = isDarkModeActive();
  if (optEls.themeIconMoon) optEls.themeIconMoon.hidden = dark;
  if (optEls.themeIconSun) optEls.themeIconSun.hidden = !dark;
  if (optEls.themeToggle) {
    const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
    optEls.themeToggle.title = label;
    optEls.themeToggle.setAttribute('aria-label', label);
  }
}

function onToggleTheme() {
  const currentlyDark = isDarkModeActive();
  const nextTheme = currentlyDark ? 'light' : 'dark';
  currentSettings = Object.assign({}, currentSettings || {}, { theme: nextTheme });
  applyTheme(nextTheme);
  chrome.storage.local.set({ settings: currentSettings });
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
  optEls.toggleVisibility.setAttribute('aria-label', show ? 'Hide API key' : 'Show API key');
  optEls.toggleVisibility.setAttribute('aria-pressed', show ? 'true' : 'false');
}

function onToggleVisibility() {
  setVisibility(optEls.apiKeyInput.type === 'password');
}

document.addEventListener('DOMContentLoaded', initOptions);

// Export for unit tests in Node
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { maskKey: maskKey, validateKey: validateKey };
}
