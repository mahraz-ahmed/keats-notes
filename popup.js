'use strict';

/*
 * KEATS Video Summariser — popup dashboard.
 *
 * Contract notes:
 *  - The popup NEVER writes `queue` or `masterNotes` directly; it uses the
 *    background messages `generateMasterNotes`, `removeFromQueue`, `clearQueue`.
 *  - The popup MAY write `settings` directly.
 *  - All DOM wiring happens inside init() (DOMContentLoaded) so this file can be
 *    loaded in Node with a stub `document` to unit-test renderMarkdown/escapeHtml.
 */

const STORAGE_KEYS = ['apiKey', 'settings', 'queue', 'masterNotes', 'masterQuiz', 'notesChat'];
const EMPTY_QUEUE_TEXT = "Open a KEATS video and its Transcript panel — it'll be captured automatically.";
const MESSAGE_TIMEOUT_MS = 6000;

/* ------------------------------------------------------------------------ *
 * Pure helpers (no DOM access) — safe to unit-test in Node.
 * ------------------------------------------------------------------------ */

/** Escape the five HTML-significant characters. */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render a (model-generated) Markdown string to an HTML string.
 * PURE: string in, string out. The whole input is HTML-escaped FIRST, so no
 * raw model text can ever reach the output unescaped; Markdown syntax is then
 * recognised on the escaped text (e.g. a blockquote marker is `&gt;`).
 */
function renderMarkdown(md) {
  // \u0000 is used internally as a placeholder delimiter; strip any from input.
  const source = String(md == null ? '' : md).replace(/\u0000/g, '');
  const lines = escapeHtml(source).replace(/\r\n?/g, '\n').split('\n');
  return mdRenderBlocks(lines);
}

/** Leading-whitespace width (tabs count as 4). */
function mdIndentOf(line) {
  const m = /^[ \t]*/.exec(line)[0];
  let n = 0;
  for (const ch of m) n += ch === '\t' ? 4 : 1;
  return n;
}

function mdIsBlank(line) {
  return /^\s*$/.test(line);
}

const MD_FENCE_RE = /^\s*(`{3,}|~{3,})\s*([^`]*)$/;
const MD_HR_RE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const MD_HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const MD_QUOTE_RE = /^\s{0,3}&gt;\s?(.*)$/;
const MD_LIST_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const MD_TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function mdIsTableStart(lines, i) {
  return i + 1 < lines.length &&
    lines[i].indexOf('|') !== -1 &&
    MD_TABLE_SEP_RE.test(lines[i + 1]) &&
    lines[i + 1].indexOf('-') !== -1;
}

function mdIsBlockStart(lines, i) {
  const line = lines[i];
  return MD_FENCE_RE.test(line) || MD_HR_RE.test(line) || MD_HEADING_RE.test(line) ||
    MD_QUOTE_RE.test(line) || MD_LIST_RE.test(line) || mdIsTableStart(lines, i);
}

/** Render an array of already-escaped lines as block-level HTML. */
function mdRenderBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (mdIsBlank(line)) { i++; continue; }

    // Fenced code block — content stays escaped, no inline formatting.
    const fence = MD_FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = (fence[2] || '').trim().split(/\s+/)[0].replace(/[^\w+#.-]/g, '');
      const body = [];
      i++;
      while (i < lines.length) {
        const close = /^\s*(`{3,}|~{3,})\s*$/.exec(lines[i]);
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length) { i++; break; }
        body.push(lines[i]);
        i++;
      }
      const cls = lang ? ' class="language-' + lang + '"' : '';
      out.push('<pre><code' + cls + '>' + body.join('\n') + '</code></pre>');
      continue;
    }

    if (MD_HR_RE.test(line)) { out.push('<hr>'); i++; continue; }

    const heading = MD_HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push('<h' + level + '>' + mdRenderInline(heading[2]) + '</h' + level + '>');
      i++;
      continue;
    }

    if (MD_QUOTE_RE.test(line)) {
      const inner = [];
      while (i < lines.length && !mdIsBlank(lines[i])) {
        const q = MD_QUOTE_RE.exec(lines[i]);
        if (q) inner.push(q[1]);
        else if (inner.length && !mdIsBlockStart(lines, i)) inner.push(lines[i]); // lazy continuation
        else break;
        i++;
      }
      out.push('<blockquote>' + mdRenderBlocks(inner) + '</blockquote>');
      continue;
    }

    if (MD_LIST_RE.test(line)) {
      const res = mdParseList(lines, i, mdIndentOf(line));
      out.push(res.html);
      i = res.next;
      continue;
    }

    if (mdIsTableStart(lines, i)) {
      const res = mdParseTable(lines, i);
      out.push(res.html);
      i = res.next;
      continue;
    }

    // Paragraph: consecutive non-blank lines that don't start another block.
    const para = [line.trim()];
    i++;
    while (i < lines.length && !mdIsBlank(lines[i]) && !mdIsBlockStart(lines, i)) {
      para.push(lines[i].trim());
      i++;
    }
    out.push('<p>' + mdRenderInline(para.join('\n')).replace(/\n/g, ' ') + '</p>');
  }
  return out.join('\n');
}

/** Parse a (possibly nested) list starting at lines[start] with the given base indent. */
function mdParseList(lines, start, baseIndent) {
  const first = MD_LIST_RE.exec(lines[start]);
  const ordered = /\d/.test(first[2]);
  const tag = ordered ? 'ol' : 'ul';
  let startAttr = '';
  if (ordered) {
    const n = parseInt(first[2], 10);
    if (n !== 1 && !isNaN(n)) startAttr = ' start="' + n + '"';
  }

  const items = []; // { text: string[], children: string[] }
  let i = start;

  while (i < lines.length) {
    const line = lines[i];

    if (mdIsBlank(line)) {
      // Continue the list only if the next non-blank line is a list item at >= base indent.
      let j = i + 1;
      while (j < lines.length && mdIsBlank(lines[j])) j++;
      if (j < lines.length && MD_LIST_RE.test(lines[j]) && mdIndentOf(lines[j]) >= baseIndent) { i = j; continue; }
      if (j < lines.length && items.length && mdIndentOf(lines[j]) > baseIndent && !MD_LIST_RE.test(lines[j])) {
        i = j; continue; // indented continuation paragraph of the current item
      }
      break;
    }

    const m = MD_LIST_RE.exec(line);
    const indent = mdIndentOf(line);

    if (m) {
      if (indent < baseIndent) break;
      if (indent >= baseIndent + 2 && items.length) {
        const sub = mdParseList(lines, i, indent);
        items[items.length - 1].children.push(sub.html);
        i = sub.next;
        continue;
      }
      const itemOrdered = /\d/.test(m[2]);
      if (itemOrdered !== ordered && items.length) break; // different list type at same level
      items.push({ text: [m[3]], children: [] });
      i++;
      continue;
    }

    // Non-list, non-blank line.
    // Another block type (heading, fence, quote, hr, table) ends the list;
    // anything else is a (lazy or indented) continuation of the current item.
    if (!items.length || mdIsBlockStart(lines, i)) break;
    items[items.length - 1].text.push(line.trim());
    i++;
  }

  const html = '<' + tag + startAttr + '>' + items.map(function (it) {
    return '<li>' + mdRenderInline(it.text.join('\n')).replace(/\n/g, ' ') + it.children.join('') + '</li>';
  }).join('') + '</' + tag + '>';
  return { html: html, next: i };
}

function mdSplitRow(line) {
  let s = line.trim();
  if (s.charAt(0) === '|') s = s.slice(1);
  if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
  return s.split('|').map(function (c) { return c.trim(); });
}

function mdParseTable(lines, start) {
  const header = mdSplitRow(lines[start]);
  const aligns = mdSplitRow(lines[start + 1]).map(function (c) {
    const l = c.charAt(0) === ':';
    const r = c.charAt(c.length - 1) === ':';
    return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
  });
  const cell = function (tag, text, idx) {
    const a = aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : '';
    return '<' + tag + a + '>' + mdRenderInline(text || '') + '</' + tag + '>';
  };
  let i = start + 2;
  const rows = [];
  while (i < lines.length && !mdIsBlank(lines[i]) && lines[i].indexOf('|') !== -1) {
    const cells = mdSplitRow(lines[i]);
    rows.push('<tr>' + header.map(function (_, idx) { return cell('td', cells[idx], idx); }).join('') + '</tr>');
    i++;
  }
  const html = '<table><thead><tr>' +
    header.map(function (h, idx) { return cell('th', h, idx); }).join('') +
    '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
  return { html: html, next: i };
}

/**
 * Inline formatting on already-escaped text. Code spans and link tags are
 * swapped out for placeholders so emphasis rules can't corrupt them.
 */
function mdRenderInline(text) {
  const slots = [];
  const hold = function (html) {
    slots.push(html);
    return '\u0000' + (slots.length - 1) + '\u0000';
  };

  let s = text;

  // Inline code (content already escaped; no further formatting inside).
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, function (_, ticks, code) {
    return hold('<code>' + code.replace(/^ (.*) $/, '$1') + '</code>');
  });

  // Links: only http(s) URLs become anchors; others render as plain text.
  s = s.replace(/\[([^\]\n]+)\]\(\s*([^\s)]+)(?:\s+&quot;[^\n]*?&quot;)?\s*\)/g, function (_, label, url) {
    if (/^https?:\/\//i.test(url)) {
      return hold('<a href="' + url + '" target="_blank" rel="noopener noreferrer">') + label + hold('</a>');
    }
    return label;
  });

  // Bold, strikethrough, italic.
  s = s.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  s = s.replace(/\*(?=[^\s*])([^*\n]*?[^\s*])\*/g, '<em>$1</em>');
  s = s.replace(/\*(?=[^\s*])([^*\n])\*/g, '<em>$1</em>');
  s = s.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_]|[^\s_])_(?!\w)/g, '$1<em>$2</em>');

  // Restore placeholders (loop handles any nesting).
  let prev;
  do {
    prev = s;
    s = s.replace(/\u0000(\d+)\u0000/g, function (_, n) { return slots[Number(n)]; });
  } while (s !== prev && s.indexOf('\u0000') !== -1);
  return s;
}

/** Human-friendly time: relative for recent times, locale string otherwise. Pure. */
function formatTime(ms, now) {
  if (typeof ms !== 'number' || !isFinite(ms)) return '';
  const ref = typeof now === 'number' ? now : Date.now();
  const diff = Math.round((ref - ms) / 1000);
  if (diff < 0) return new Date(ms).toLocaleString();
  if (diff < 45) return 'just now';
  if (diff < 3600) return Math.round(diff / 60) + ' min ago';
  if (diff < 86400) {
    const h = Math.round(diff / 3600);
    return h + (h === 1 ? ' hour ago' : ' hours ago');
  }
  return new Date(ms).toLocaleString();
}

function pluralise(n, one, many) {
  return n + ' ' + (n === 1 ? one : many);
}

/** Render inline Markdown (code spans, bold, italic, links) safely without outer <p> tags. Pure. */
function renderInlineMarkdown(s) {
  const source = String(s == null ? '' : s).replace(/\u0000/g, '');
  return mdRenderInline(escapeHtml(source));
}

/**
 * Compute instant feedback for a selected option on a multiple-choice question. Pure.
 */
function getQuizFeedback(question, selectedIndex) {
  const q = question && typeof question === 'object' ? question : {};
  const correctIndex = Number(q.correctIndex) || 0;
  const isCorrect = selectedIndex === correctIndex;
  const letters = ['A', 'B', 'C', 'D'];
  const selectedLetter = letters[selectedIndex] || String(selectedIndex + 1);
  const correctLetter = letters[correctIndex] || String(correctIndex + 1);
  const optExps = Array.isArray(q.optionExplanations) ? q.optionExplanations : [];
  const selectedNote = typeof optExps[selectedIndex] === 'string' ? optExps[selectedIndex].trim() : '';
  const correctNote = typeof optExps[correctIndex] === 'string' ? optExps[correctIndex].trim() : '';
  const generalExp = typeof q.explanation === 'string' ? q.explanation.trim() : '';

  let title;
  let note;
  if (isCorrect) {
    title = '✓ Correct! (' + selectedLetter + ')';
    note = selectedNote || generalExp || 'Correct based on your master notes.';
  } else {
    title = '✗ Incorrect — You chose ' + selectedLetter + ' (Correct answer: ' + correctLetter + ')';
    const fallbackRight = generalExp || correctNote;
    if (selectedNote && fallbackRight && selectedNote.toLowerCase() !== fallbackRight.toLowerCase()) {
      note = selectedNote + ' ' + fallbackRight;
    } else {
      note = selectedNote || fallbackRight || ('Option ' + correctLetter + ' is the correct answer.');
    }
  }
  return {
    isCorrect: isCorrect,
    title: title,
    note: note,
    correctIndex: correctIndex,
    correctLetter: correctLetter,
    selectedLetter: selectedLetter,
  };
}

/**
 * Compute overall score and per-question breakdown for a quiz. Pure.
 */
function computeQuizScore(questions, answers) {
  const list = Array.isArray(questions) ? questions : [];
  const ansMap = (answers && typeof answers === 'object') ? answers : {};
  const total = list.length;
  let answered = 0;
  let correct = 0;
  const breakdown = [];

  for (let i = 0; i < total; i++) {
    const q = list[i] || {};
    const rawAns = ansMap[i] !== undefined ? ansMap[i] : ansMap[String(i)];
    const hasAns = rawAns !== undefined && rawAns !== null && Number.isInteger(Number(rawAns));
    const sel = hasAns ? Number(rawAns) : -1;
    const isRight = hasAns && sel === Number(q.correctIndex);
    if (hasAns) answered++;
    if (isRight) correct++;
    breakdown.push({
      index: i,
      topic: (q.topic && String(q.topic).trim()) || ('Question ' + (i + 1)),
      answered: hasAns,
      selectedIndex: sel,
      isCorrect: isRight,
    });
  }

  const percentage = total > 0 ? Math.round((correct / total) * 100) : 0;
  const completed = total > 0 && answered === total;
  let verdict = '';
  if (completed) {
    if (percentage === 100) verdict = 'Perfect score! You mastered every key topic in your notes.';
    else if (percentage >= 80) verdict = 'Great job! Strong understanding across the key topics.';
    else if (percentage >= 60) verdict = 'Good effort! Review the missed topics below to solidify your knowledge.';
    else verdict = 'Keep studying your master notes and retry the quiz to improve your score.';
  }

  return {
    total: total,
    answered: answered,
    correct: correct,
    percentage: percentage,
    completed: completed,
    verdict: verdict,
    breakdown: breakdown,
  };
}

/* ------------------------------------------------------------------------ *
 * DOM / chrome wiring — only runs after DOMContentLoaded.
 * ------------------------------------------------------------------------ */

const state = {
  apiKey: '',
  settings: { autoCapture: true },
  queue: [],
  masterNotes: { status: 'idle' },
  masterQuiz: { status: 'idle' },
  notesChat: [],
  generatePending: false,
  quizPending: false,
  qaPending: false,
  quizIndex: 0,
  quizViewingScore: false,
  lastQuizTimestamp: 0,
};
const els = {};
let messageTimer = null;
let copyTimer = null;

function init() {
  [
    'autoCapture', 'openTabBtn', 'openOptions', 'apiKeyBanner', 'setApiKey', 'message',
    'queueCount', 'queueEmpty', 'queueList', 'generateBtn', 'clearBtn',
    'takeQuizBtn', 'copyBtn', 'clearNotesBtn', 'notesGenerating', 'notesError', 'notesMeta', 'notesContent', 'notesEmpty',
    'scanBtn', 'scanStatus',
    'quizPanel', 'quizHeading', 'quizProgressMeta', 'retryQuizBtn', 'generateQuizBtn',
    'quizEmpty', 'quizGenerating', 'quizError', 'quizProgressBarWrap', 'quizProgressBar', 'quizContent', 'quizScoreCard',
    'qaPanel', 'qaHeading', 'clearChatBtn', 'qaChips', 'qaMessages', 'qaThinking', 'qaForm', 'qaInput', 'qaSendBtn',
    'themeToggle', 'themeIconMoon', 'themeIconSun',
  ].forEach(function (id) { els[id] = document.getElementById(id); });

  els.queueEmpty.textContent = EMPTY_QUEUE_TEXT;

  if (els.openTabBtn) {
    els.openTabBtn.addEventListener('click', openInFullTab);
    if (typeof window !== 'undefined' && window.innerWidth >= 600) {
      els.openTabBtn.style.display = 'none';
    }
  }
  if (els.themeToggle) els.themeToggle.addEventListener('click', onToggleTheme);
  els.openOptions.addEventListener('click', openOptions);
  els.setApiKey.addEventListener('click', openOptions);
  els.autoCapture.addEventListener('change', onAutoCaptureChange);
  els.generateBtn.addEventListener('click', onGenerate);
  els.clearBtn.addEventListener('click', onClearQueue);
  els.copyBtn.addEventListener('click', onCopy);
  if (els.clearNotesBtn) els.clearNotesBtn.addEventListener('click', onClearNotes);
  if (els.takeQuizBtn) els.takeQuizBtn.addEventListener('click', onTakeQuizClick);
  els.queueList.addEventListener('click', onQueueListClick);
  if (els.scanBtn) els.scanBtn.addEventListener('click', onScanPage);

  if (els.generateQuizBtn) els.generateQuizBtn.addEventListener('click', onGenerateQuiz);
  if (els.retryQuizBtn) els.retryQuizBtn.addEventListener('click', onRetryQuiz);
  if (els.quizContent) els.quizContent.addEventListener('click', onQuizOptionClick);
  if (els.quizScoreCard) els.quizScoreCard.addEventListener('click', onQuizScoreCardClick);

  if (els.clearChatBtn) els.clearChatBtn.addEventListener('click', onClearChat);
  if (els.qaForm) els.qaForm.addEventListener('submit', onQaSubmit);
  if (els.qaChips) els.qaChips.addEventListener('click', onQaChipClick);
  if (els.qaInput) {
    els.qaInput.addEventListener('input', onQaInput);
    els.qaInput.addEventListener('keydown', onQaKeyDown);
  }

  if (typeof window !== 'undefined' && window.matchMedia) {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    if (media && media.addEventListener) {
      media.addEventListener('change', function () {
        if (!state.settings || !state.settings.theme || state.settings.theme === 'system') {
          updateThemeIcons();
        }
      });
    }
  }

  chrome.storage.onChanged.addListener(onStorageChanged);

  chrome.storage.local.get(STORAGE_KEYS, function (data) {
    if (chrome.runtime.lastError) {
      showMessage('Could not read storage: ' + chrome.runtime.lastError.message);
      data = {};
    }
    applyStorage(data || {});
    renderAll();
  });

  // Passive initial check: if player exists on active tab, advise the user
  if (chrome.tabs && chrome.tabs.query) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs && tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'checkStatus' }, function (res) {
          if (chrome.runtime && chrome.runtime.lastError) return;
          if (res && res.hasPlayer && res.cueCount === 0 && (!state.queue || state.queue.length === 0)) {
            showScanStatus('Video player detected. Click the player\'s "Transcript" panel, then click "Scan Page".', 'info');
          }
        });
      }
    });
  }

  // Keep relative timestamps fresh while the popup is open.
  setInterval(renderQueue, 30000);
}

function applyStorage(data) {
  if ('apiKey' in data) state.apiKey = typeof data.apiKey === 'string' ? data.apiKey : '';
  if ('settings' in data) state.settings = (data.settings && typeof data.settings === 'object') ? data.settings : {};
  if ('queue' in data) state.queue = Array.isArray(data.queue) ? data.queue : [];
  if ('masterNotes' in data) {
    state.masterNotes = (data.masterNotes && typeof data.masterNotes === 'object') ? data.masterNotes : { status: 'idle' };
  }
  if ('masterQuiz' in data) {
    const nextQuiz = (data.masterQuiz && typeof data.masterQuiz === 'object') ? data.masterQuiz : { status: 'idle' };
    const prevTs = state.lastQuizTimestamp || 0;
    const nextTs = Number(nextQuiz.generatedAt) || 0;
    const wasIdleOrGen = !state.masterQuiz || state.masterQuiz.status !== 'done';
    state.masterQuiz = nextQuiz;

    if (nextQuiz.status !== 'done') {
      state.quizIndex = 0;
      state.quizViewingScore = false;
      state.lastQuizTimestamp = 0;
    } else if (nextTs !== prevTs || wasIdleOrGen) {
      state.lastQuizTimestamp = nextTs;
      const qs = Array.isArray(nextQuiz.questions) ? nextQuiz.questions : [];
      const ans = (nextQuiz.answers && typeof nextQuiz.answers === 'object') ? nextQuiz.answers : {};
      let firstUnanswered = -1;
      for (let i = 0; i < qs.length; i++) {
        const raw = ans[i] !== undefined ? ans[i] : ans[String(i)];
        if (raw === undefined || raw === null || !Number.isInteger(Number(raw))) {
          firstUnanswered = i;
          break;
        }
      }
      if (firstUnanswered === -1 && qs.length > 0) {
        state.quizIndex = qs.length - 1;
        state.quizViewingScore = true;
      } else {
        state.quizIndex = Math.max(0, firstUnanswered);
        state.quizViewingScore = false;
      }
    }
  }
  if ('notesChat' in data) {
    state.notesChat = Array.isArray(data.notesChat) ? data.notesChat : [];
  }
}

function onStorageChanged(changes, area) {
  if (area !== 'local') return;
  const data = {};
  let relevant = false;
  STORAGE_KEYS.forEach(function (k) {
    if (k in changes) {
      data[k] = changes[k].newValue; // undefined when the key was removed
      relevant = true;
    }
  });
  if (!relevant) return;

  if (changes.queue && Array.isArray(changes.queue.newValue)) {
    const oldQueue = Array.isArray(state.queue) ? state.queue : [];
    const newQueue = changes.queue.newValue;
    if (newQueue.length > oldQueue.length) {
      const added = newQueue[newQueue.length - 1];
      const title = (added && added.title) ? added.title : 'Video';
      showMessage('Notes captured! Added “' + title + '” to queue.', 'success');
    }
  }

  applyStorage(data);
  renderAll();
}

function hasApiKey() {
  return typeof state.apiKey === 'string' && state.apiKey.trim() !== '';
}

function isGenerating() {
  return state.masterNotes && state.masterNotes.status === 'generating';
}

function isGeneratingQuiz() {
  return state.masterQuiz && state.masterQuiz.status === 'generating';
}

function renderAll() {
  renderSettings();
  renderApiKey();
  renderQueue();
  renderNotes();
  renderButtons();
  renderQuiz();
  renderQa();
}

function renderSettings() {
  els.autoCapture.checked = !(state.settings && state.settings.autoCapture === false);
  renderTheme();
}

function isDarkModeActive() {
  const theme = state.settings && state.settings.theme;
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
  if (els.themeIconMoon) els.themeIconMoon.hidden = dark;
  if (els.themeIconSun) els.themeIconSun.hidden = !dark;
  if (els.themeToggle) {
    const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
    els.themeToggle.title = label;
    els.themeToggle.setAttribute('aria-label', label);
  }
}

function renderTheme() {
  applyTheme(state.settings && state.settings.theme);
}

function onToggleTheme() {
  const currentlyDark = isDarkModeActive();
  const nextTheme = currentlyDark ? 'light' : 'dark';
  const newSettings = Object.assign({}, state.settings || {}, { theme: nextTheme });
  state.settings = newSettings;
  applyTheme(nextTheme);
  chrome.storage.local.set({ settings: newSettings });
}

function renderApiKey() {
  els.apiKeyBanner.hidden = hasApiKey();
}

function renderQueue() {
  const queue = state.queue || [];
  els.queueCount.textContent = pluralise(queue.length, 'video', 'videos') + ' queued';
  els.queueEmpty.hidden = queue.length > 0;
  els.queueList.hidden = queue.length === 0;

  const frag = document.createDocumentFragment();
  queue.forEach(function (item) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'q-row';

    const body = document.createElement('div');
    body.className = 'q-body';

    const title = document.createElement('div');
    title.className = 'q-title';
    const titleText = (item && item.title) ? String(item.title) : 'Untitled video';
    title.textContent = titleText;
    title.title = titleText;

    const meta = document.createElement('div');
    meta.className = 'q-meta';
    const cues = Number(item && item.cueCount) || 0;
    const when = formatTime(item && item.capturedAt);
    meta.textContent = cues + ' lines' + (when ? ' · ' + when : '');
    if (typeof (item && item.capturedAt) === 'number') meta.title = new Date(item.capturedAt).toLocaleString();

    body.appendChild(title);
    body.appendChild(meta);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'q-remove';
    remove.textContent = '×';
    remove.dataset.id = String(item && item.id);
    remove.title = 'Remove from queue';
    remove.setAttribute('aria-label', 'Remove “' + titleText + '” from queue');

    row.appendChild(body);
    row.appendChild(remove);
    li.appendChild(row);
    frag.appendChild(li);
  });
  els.queueList.textContent = '';
  els.queueList.appendChild(frag);
}

function renderNotes() {
  const notes = state.masterNotes || { status: 'idle' };
  const status = notes.status || 'idle';
  const markdown = typeof notes.markdown === 'string' ? notes.markdown : '';
  const generating = status === 'generating';

  els.notesGenerating.hidden = !generating;

  const showError = status === 'error';
  els.notesError.hidden = !showError;
  els.notesError.textContent = showError ? ('Error: ' + (notes.error || 'Something went wrong while generating notes.')) : '';

  const showMarkdown = !generating && markdown.trim() !== '';
  els.notesContent.hidden = !showMarkdown;
  els.copyBtn.hidden = !showMarkdown;
  if (els.clearNotesBtn) els.clearNotesBtn.hidden = !showMarkdown;
  if (els.takeQuizBtn) els.takeQuizBtn.hidden = !showMarkdown;
  els.notesContent.innerHTML = showMarkdown ? renderMarkdown(markdown) : '';

  const metaParts = [];
  if (showMarkdown) {
    if (Array.isArray(notes.videoIds)) metaParts.push('Generated from ' + pluralise(notes.videoIds.length, 'video', 'videos'));
    if (typeof notes.generatedAt === 'number') metaParts.push(new Date(notes.generatedAt).toLocaleString());
  }
  els.notesMeta.hidden = metaParts.length === 0;
  els.notesMeta.textContent = metaParts.join(' · ');

  els.notesEmpty.hidden = generating || showError || showMarkdown;
}

function renderButtons() {
  const empty = !state.queue || state.queue.length === 0;
  const generating = isGenerating();
  els.generateBtn.disabled = empty || !hasApiKey() || generating || state.generatePending;
  els.clearBtn.disabled = empty;
  if (!hasApiKey()) els.generateBtn.title = 'Set your Groq API key first';
  else if (empty) els.generateBtn.title = 'Queue some videos first';
  else if (generating) els.generateBtn.title = 'Generation in progress';
  else els.generateBtn.title = '';
}

function showMessage(text, kind) {
  if (!els.message) return;
  els.message.textContent = text;
  els.message.className = 'msg' + (kind === 'success' ? ' msg-success' : '');
  els.message.hidden = false;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(function () { els.message.hidden = true; }, MESSAGE_TIMEOUT_MS);
}

/** sendMessage wrapper that surfaces lastError, thrown errors and {ok:false}. */
function sendMessage(msg) {
  return new Promise(function (resolve, reject) {
    try {
      chrome.runtime.sendMessage(msg, function (response) {
        const err = chrome.runtime.lastError;
        if (err) { reject(new Error(err.message || 'Extension background is unavailable.')); return; }
        if (response && response.ok === false) { reject(new Error(response.error || 'Request failed.')); return; }
        resolve(response);
      });
    } catch (e) {
      reject(e);
    }
  });
}

function openOptions() {
  try {
    chrome.runtime.openOptionsPage(function () {
      if (chrome.runtime.lastError) showMessage('Could not open settings: ' + chrome.runtime.lastError.message);
    });
  } catch (e) {
    showMessage('Could not open settings: ' + e.message);
  }
}

function openInFullTab() {
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
      if (typeof window !== 'undefined' && window.close) {
        window.close();
      }
    } else if (typeof window !== 'undefined') {
      window.open(location.href, '_blank');
    }
  } catch (e) {
    showMessage('Could not open full view tab: ' + e.message);
  }
}

function onAutoCaptureChange() {
  const settings = Object.assign({}, state.settings || {}, { autoCapture: els.autoCapture.checked });
  state.settings = settings;
  chrome.storage.local.set({ settings: settings }, function () {
    if (chrome.runtime.lastError) {
      showMessage('Could not save setting: ' + chrome.runtime.lastError.message);
      els.autoCapture.checked = !settings.autoCapture;
      state.settings = Object.assign({}, settings, { autoCapture: !settings.autoCapture });
    }
  });
}

let scanStatusTimer = null;
function showScanStatus(text, kind) {
  if (!els.scanStatus) return;
  els.scanStatus.textContent = text;
  els.scanStatus.className = 'scan-status ' + (kind || 'info');
  els.scanStatus.hidden = false;
  clearTimeout(scanStatusTimer);
  if (kind === 'success' || kind === 'info') {
    scanStatusTimer = setTimeout(function () {
      if (els.scanStatus) els.scanStatus.hidden = true;
    }, 8000);
  }
}

async function onScanPage() {
  if (!els.scanBtn) return;
  els.scanBtn.disabled = true;
  showScanStatus('Scanning active tab for lecture video and transcript…', 'info');

  try {
    if (!chrome.tabs || !chrome.tabs.query) {
      showScanStatus('Tab access is not supported in this context.', 'warn');
      return;
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs || !tabs[0] || !tabs[0].id) {
      showScanStatus('No active tab found. Please navigate to your KEATS video.', 'warn');
      return;
    }
    const tab = tabs[0];
    const tabUrl = tab.url || '';
    if (/^chrome:\/\/|^edge:\/\/|^about:/i.test(tabUrl)) {
      showScanStatus('Cannot scan browser internal pages. Navigate to a KEATS lecture video.', 'warn');
      return;
    }

    let responses = [];
    try {
      responses = await chrome.tabs.sendMessage(tab.id, { action: 'scanPage' });
    } catch (msgErr) {
      // Content script may not be injected yet if tab was open prior to extension install/reload
      if (chrome.scripting && chrome.scripting.executeScript) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            files: ['content.js']
          });
          await new Promise(function (r) { setTimeout(r, 400); });
          responses = await chrome.tabs.sendMessage(tab.id, { action: 'scanPage' });
        } catch (injectErr) {
          console.warn('Script injection failed:', injectErr);
        }
      }
    }

    const frameList = Array.isArray(responses) ? responses : responses ? [responses] : [];
    const withCues = frameList.filter(function (r) { return r && r.cueCount > 0; });
    const withPlayer = frameList.filter(function (r) { return r && r.hasPlayer; });

    if (withCues.length > 0) {
      const top = withCues[0];
      showScanStatus('Captured ' + top.cueCount + ' transcript lines from “' + (top.title || 'Video') + '”.', 'success');
      showMessage('Notes captured!', 'success');
    } else if (withPlayer.length > 0) {
      showScanStatus('Video player detected, but no transcript cues found yet. Open the "Transcript" tab in the video player, then click "Scan Page" again.', 'warn');
    } else {
      showScanStatus('No video player found on current tab. If you are on KEATS, make sure the video has loaded.', 'warn');
    }
  } catch (err) {
    showScanStatus('Scan failed: ' + (err.message || String(err)), 'warn');
  } finally {
    if (els.scanBtn) els.scanBtn.disabled = false;
  }
}

function onGenerate() {
  if (els.generateBtn.disabled) return;
  state.generatePending = true;
  renderButtons();
  sendMessage({ action: 'generateMasterNotes' })
    .catch(function (e) { showMessage('Could not start generation: ' + e.message); })
    .then(function () {
      state.generatePending = false;
      renderButtons();
    });
}

function onClearQueue() {
  if (!state.queue || state.queue.length === 0) return;
  const n = state.queue.length;
  if (!confirm('Remove all ' + pluralise(n, 'video', 'videos') + ' from the queue?')) return;
  els.clearBtn.disabled = true;
  sendMessage({ action: 'clearQueue' })
    .catch(function (e) {
      showMessage('Could not clear queue: ' + e.message);
      renderButtons();
    });
}

function onClearNotes() {
  if (!state.masterNotes || (!state.masterNotes.markdown && state.masterNotes.status !== 'done')) return;
  if (!confirm('Clear the generated master notes?')) return;
  if (els.clearNotesBtn) els.clearNotesBtn.disabled = true;
  sendMessage({ action: 'clearMasterNotes' })
    .catch(function (e) {
      showMessage('Could not clear notes: ' + e.message);
    })
    .then(function () {
      if (els.clearNotesBtn) els.clearNotesBtn.disabled = false;
    });
}

function onQueueListClick(event) {
  const btn = event.target && event.target.closest ? event.target.closest('.q-remove') : null;
  if (!btn || btn.disabled) return;
  const idStr = btn.dataset.id;
  // Send the id with its original type (number or string) as stored in the queue.
  const item = (state.queue || []).find(function (q) { return String(q && q.id) === idStr; });
  const id = item ? item.id : idStr;
  btn.disabled = true;
  sendMessage({ action: 'removeFromQueue', id: id })
    .catch(function (e) {
      btn.disabled = false;
      showMessage('Could not remove video: ' + e.message);
    });
}

function onCopy() {
  const markdown = state.masterNotes && typeof state.masterNotes.markdown === 'string' ? state.masterNotes.markdown : '';
  if (!markdown) return;
  const done = function () {
    els.copyBtn.textContent = 'Copied!';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(function () { els.copyBtn.textContent = 'Copy Markdown'; }, 1500);
  };
  const fallback = function () {
    try {
      const ta = document.createElement('textarea');
      ta.value = markdown;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) done(); else showMessage('Copy failed — please try again.');
    } catch (e) {
      showMessage('Copy failed: ' + e.message);
    }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(markdown).then(done, fallback);
  } else {
    fallback();
  }
}

function hasMasterNotes() {
  return Boolean(
    state.masterNotes &&
    state.masterNotes.status === 'done' &&
    typeof state.masterNotes.markdown === 'string' &&
    state.masterNotes.markdown.trim() !== ''
  );
}

function renderQuiz() {
  if (!els.quizPanel) return;
  const ready = hasMasterNotes();
  els.quizPanel.hidden = !ready;
  if (!ready) return;

  const quiz = state.masterQuiz || { status: 'idle' };
  const status = quiz.status || 'idle';
  const generating = status === 'generating' || state.quizPending;
  const showError = status === 'error' && !generating;
  const questions = Array.isArray(quiz.questions) ? quiz.questions : [];
  const answers = (quiz.answers && typeof quiz.answers === 'object') ? quiz.answers : {};
  const hasQuiz = !generating && status === 'done' && questions.length > 0;
  const score = computeQuizScore(questions, answers);

  const qIdx = hasQuiz
    ? Math.min(Math.max(0, Number(state.quizIndex) || 0), questions.length - 1)
    : 0;
  state.quizIndex = qIdx;
  const showingScore = Boolean(hasQuiz && state.quizViewingScore && score.completed);

  if (els.generateQuizBtn) {
    els.generateQuizBtn.disabled = generating || !hasApiKey();
    els.generateQuizBtn.textContent = hasQuiz ? 'New Quiz' : 'Generate Quiz';
  }
  if (els.retryQuizBtn) {
    els.retryQuizBtn.hidden = !hasQuiz || score.answered === 0;
    els.retryQuizBtn.disabled = generating;
  }
  if (els.quizProgressMeta) {
    els.quizProgressMeta.hidden = !hasQuiz;
    if (hasQuiz) {
      if (showingScore) {
        els.quizProgressMeta.textContent =
          'Completed · ' + score.correct + ' / ' + score.total + ' right (' + score.percentage + '%)';
      } else {
        els.quizProgressMeta.textContent =
          'Q' + (qIdx + 1) + ' of ' + score.total + ' · ' + score.correct + ' / ' + score.answered + ' right';
      }
    }
  }

  if (els.quizGenerating) els.quizGenerating.hidden = !generating;
  if (els.quizError) {
    els.quizError.hidden = !showError;
    els.quizError.textContent = showError ? ('Error: ' + (quiz.error || 'Could not generate quiz.')) : '';
  }
  if (els.quizEmpty) els.quizEmpty.hidden = generating || showError || hasQuiz;

  if (els.quizProgressBarWrap) els.quizProgressBarWrap.hidden = !hasQuiz;
  if (els.quizProgressBar && hasQuiz) {
    const pct = score.total > 0 ? Math.round((score.answered / score.total) * 100) : 0;
    els.quizProgressBar.style.width = pct + '%';
  }

  if (els.quizContent) {
    els.quizContent.hidden = !hasQuiz || showingScore;
    els.quizContent.textContent = '';
    if (hasQuiz && !showingScore) {
      const q = questions[qIdx];
      if (q && typeof q === 'object') {
        const letters = ['A', 'B', 'C', 'D'];
        const card = document.createElement('div');
        card.className = 'quiz-card';

        const head = document.createElement('div');
        head.className = 'quiz-card-head';

        const qNum = document.createElement('span');
        qNum.className = 'quiz-q-num';
        qNum.textContent = 'Question ' + (qIdx + 1) + ' of ' + score.total;

        const badge = document.createElement('span');
        badge.className = 'quiz-topic-badge';
        const topicText = (q.topic && String(q.topic).trim()) || 'Key Concept';
        badge.textContent = topicText;
        badge.title = topicText;

        head.appendChild(qNum);
        head.appendChild(badge);
        card.appendChild(head);

        const qStem = document.createElement('p');
        qStem.className = 'quiz-question';
        qStem.innerHTML = renderInlineMarkdown(q.question || '');
        card.appendChild(qStem);

        const optsWrap = document.createElement('div');
        optsWrap.className = 'quiz-options';

        const rawAns = answers[qIdx] !== undefined ? answers[qIdx] : answers[String(qIdx)];
        const isAnswered = rawAns !== undefined && rawAns !== null && Number.isInteger(Number(rawAns));
        const selectedIdx = isAnswered ? Number(rawAns) : -1;
        const correctIdx = Number(q.correctIndex) || 0;
        const opts = Array.isArray(q.options) ? q.options : [];

        opts.forEach(function (optText, optIdx) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'quiz-option';
          btn.dataset.questionIndex = String(qIdx);
          btn.dataset.optionIndex = String(optIdx);
          btn.disabled = isAnswered;

          if (isAnswered) {
            if (optIdx === correctIdx) {
              btn.classList.add('is-correct');
            } else if (optIdx === selectedIdx) {
              btn.classList.add('is-wrong');
            } else {
              btn.classList.add('is-dimmed');
            }
          }

          const letterSpan = document.createElement('span');
          letterSpan.className = 'quiz-opt-letter';
          letterSpan.textContent = letters[optIdx] || String(optIdx + 1);

          const textSpan = document.createElement('span');
          textSpan.className = 'quiz-opt-text';
          textSpan.innerHTML = renderInlineMarkdown(optText);

          btn.appendChild(letterSpan);
          btn.appendChild(textSpan);

          if (isAnswered && (optIdx === correctIdx || optIdx === selectedIdx)) {
            const statusSpan = document.createElement('span');
            statusSpan.className = 'quiz-opt-status';
            statusSpan.textContent = optIdx === correctIdx ? '✓ Right' : '✗ Wrong';
            btn.appendChild(statusSpan);
          }

          optsWrap.appendChild(btn);
        });

        card.appendChild(optsWrap);

        if (isAnswered) {
          const fb = getQuizFeedback(q, selectedIdx);
          const fbBox = document.createElement('div');
          fbBox.className = 'quiz-feedback ' + (fb.isCorrect ? 'is-correct' : 'is-wrong');
          fbBox.setAttribute('role', 'status');

          const fbTitle = document.createElement('span');
          fbTitle.className = 'quiz-feedback-title';
          fbTitle.textContent = fb.title;

          const fbNote = document.createElement('span');
          fbNote.className = 'quiz-feedback-note';
          fbNote.innerHTML = renderInlineMarkdown(fb.note);

          fbBox.appendChild(fbTitle);
          fbBox.appendChild(fbNote);
          card.appendChild(fbBox);
        }

        // Single-question stepper navigation
        const nav = document.createElement('div');
        nav.className = 'quiz-nav';

        const prevBtn = document.createElement('button');
        prevBtn.type = 'button';
        prevBtn.className = 'btn btn-secondary btn-small';
        prevBtn.dataset.quizNav = 'prev';
        prevBtn.disabled = qIdx === 0;
        prevBtn.textContent = '← Previous';

        const navHint = document.createElement('span');
        navHint.className = 'quiz-nav-hint';
        if (!isAnswered) {
          navHint.textContent = 'Select an option above';
        } else if (score.completed) {
          navHint.textContent = 'All ' + score.total + ' questions answered';
        } else {
          navHint.textContent = score.answered + ' of ' + score.total + ' answered';
        }

        const rightActions = document.createElement('div');
        rightActions.style.display = 'flex';
        rightActions.style.gap = '6px';
        rightActions.style.alignItems = 'center';

        const isLast = qIdx >= questions.length - 1;
        if (score.completed && !isLast) {
          const scoreJumpBtn = document.createElement('button');
          scoreJumpBtn.type = 'button';
          scoreJumpBtn.className = 'btn btn-secondary btn-small';
          scoreJumpBtn.dataset.quizNav = 'finish';
          scoreJumpBtn.textContent = 'Final Score';
          rightActions.appendChild(scoreJumpBtn);
        }

        const nextBtn = document.createElement('button');
        nextBtn.type = 'button';
        nextBtn.className = 'btn btn-primary btn-small';
        if (isLast) {
          nextBtn.dataset.quizNav = 'finish';
          nextBtn.disabled = !score.completed;
          nextBtn.textContent = 'View Final Score →';
        } else {
          nextBtn.dataset.quizNav = 'next';
          nextBtn.disabled = !isAnswered;
          nextBtn.textContent = 'Next Question →';
        }
        rightActions.appendChild(nextBtn);

        nav.appendChild(prevBtn);
        nav.appendChild(navHint);
        nav.appendChild(rightActions);
        card.appendChild(nav);

        els.quizContent.appendChild(card);
      }
    }
  }

  if (els.quizScoreCard) {
    els.quizScoreCard.hidden = !showingScore;
    els.quizScoreCard.textContent = '';
    if (showingScore) {
      els.quizScoreCard.className = 'quiz-score-card';

      const heading = document.createElement('p');
      heading.className = 'quiz-score-heading';
      heading.textContent = 'Quiz Complete — Final Score';

      const value = document.createElement('div');
      value.className = 'quiz-score-value';
      value.textContent = score.correct + ' / ' + score.total + ' (' + score.percentage + '%)';

      const verdict = document.createElement('p');
      verdict.className = 'quiz-score-verdict';
      verdict.textContent = score.verdict;

      const summary = document.createElement('div');
      summary.className = 'quiz-topic-summary';
      score.breakdown.forEach(function (item) {
        const pill = document.createElement('span');
        pill.className = 'quiz-topic-pill ' + (item.isCorrect ? 'pass' : 'fail');
        pill.dataset.reviewIndex = String(item.index);
        pill.style.cursor = 'pointer';
        pill.title = 'Click to review Question ' + (item.index + 1);
        pill.textContent = (item.isCorrect ? '✓ ' : '✗ ') + 'Q' + (item.index + 1) + ': ' + item.topic;
        summary.appendChild(pill);
      });

      const actions = document.createElement('div');
      actions.className = 'quiz-score-actions';

      const reviewBtn = document.createElement('button');
      reviewBtn.type = 'button';
      reviewBtn.className = 'btn btn-secondary btn-small';
      reviewBtn.dataset.quizAction = 'review';
      reviewBtn.textContent = 'Review Questions';

      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn btn-secondary btn-small';
      retryBtn.dataset.quizAction = 'retry';
      retryBtn.textContent = 'Retry Quiz';

      const newBtn = document.createElement('button');
      newBtn.type = 'button';
      newBtn.className = 'btn btn-primary btn-small';
      newBtn.dataset.quizAction = 'new';
      newBtn.textContent = 'Generate New Quiz';

      actions.appendChild(reviewBtn);
      actions.appendChild(retryBtn);
      actions.appendChild(newBtn);

      els.quizScoreCard.appendChild(heading);
      els.quizScoreCard.appendChild(value);
      els.quizScoreCard.appendChild(verdict);
      els.quizScoreCard.appendChild(summary);
      els.quizScoreCard.appendChild(actions);
    }
  }
}

function onTakeQuizClick() {
  if (els.quizPanel && els.quizPanel.scrollIntoView) {
    els.quizPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  const status = state.masterQuiz && state.masterQuiz.status;
  if (status !== 'done' && status !== 'generating' && !state.quizPending) {
    onGenerateQuiz();
  }
}

function onGenerateQuiz() {
  if (isGeneratingQuiz() || state.quizPending) return;
  if (!hasApiKey()) {
    showMessage('Set your Groq API key in Options first.');
    return;
  }
  if (!hasMasterNotes()) {
    showMessage('Generate master notes first.');
    return;
  }
  state.quizPending = true;
  state.quizIndex = 0;
  state.quizViewingScore = false;
  renderQuiz();
  sendMessage({ action: 'generateMasterQuiz' })
    .catch(function (err) {
      showMessage('Could not start quiz generation: ' + err.message);
    })
    .then(function () {
      state.quizPending = false;
      renderQuiz();
    });
}

function onRetryQuiz() {
  if (!state.masterQuiz || state.masterQuiz.status !== 'done') return;
  state.masterQuiz = Object.assign({}, state.masterQuiz, { answers: {} });
  state.quizIndex = 0;
  state.quizViewingScore = false;
  renderQuiz();
  sendMessage({ action: 'resetMasterQuiz' }).catch(function (err) {
    showMessage('Could not reset quiz: ' + err.message);
  });
}

function onQuizOptionClick(event) {
  const navBtn = event.target && event.target.closest ? event.target.closest('[data-quiz-nav]') : null;
  if (navBtn) {
    if (navBtn.disabled) return;
    const navAction = navBtn.dataset.quizNav;
    const questions = (state.masterQuiz && Array.isArray(state.masterQuiz.questions)) ? state.masterQuiz.questions : [];
    if (navAction === 'prev' && state.quizIndex > 0) {
      state.quizIndex -= 1;
      state.quizViewingScore = false;
      renderQuiz();
    } else if (navAction === 'next' && state.quizIndex < questions.length - 1) {
      state.quizIndex += 1;
      state.quizViewingScore = false;
      renderQuiz();
    } else if (navAction === 'finish') {
      state.quizViewingScore = true;
      renderQuiz();
    }
    return;
  }

  const btn = event.target && event.target.closest ? event.target.closest('.quiz-option') : null;
  if (!btn || btn.disabled) return;
  const qIdx = Number(btn.dataset.questionIndex);
  const optIdx = Number(btn.dataset.optionIndex);
  if (!Number.isInteger(qIdx) || !Number.isInteger(optIdx)) return;
  if (!state.masterQuiz || state.masterQuiz.status !== 'done') return;

  const currentAnswers = Object.assign({}, (state.masterQuiz.answers && typeof state.masterQuiz.answers === 'object') ? state.masterQuiz.answers : {});
  if (String(qIdx) in currentAnswers || qIdx in currentAnswers) return;

  currentAnswers[String(qIdx)] = optIdx;
  state.masterQuiz = Object.assign({}, state.masterQuiz, { answers: currentAnswers });
  renderQuiz();

  sendMessage({
    action: 'answerQuizQuestion',
    questionIndex: qIdx,
    optionIndex: optIdx,
  }).catch(function (err) {
    showMessage('Could not save quiz answer: ' + err.message);
  });
}

function onQuizScoreCardClick(event) {
  const pill = event.target && event.target.closest ? event.target.closest('[data-review-index]') : null;
  if (pill) {
    const revIdx = Number(pill.dataset.reviewIndex);
    if (Number.isInteger(revIdx) && revIdx >= 0) {
      state.quizIndex = revIdx;
      state.quizViewingScore = false;
      renderQuiz();
    }
    return;
  }

  const btn = event.target && event.target.closest ? event.target.closest('[data-quiz-action]') : null;
  if (!btn) return;
  const action = btn.dataset.quizAction;
  if (action === 'review') {
    state.quizIndex = 0;
    state.quizViewingScore = false;
    renderQuiz();
  } else if (action === 'retry') {
    onRetryQuiz();
    if (els.quizPanel && els.quizPanel.scrollIntoView) {
      els.quizPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } else if (action === 'new') {
    onGenerateQuiz();
  }
}

function renderQa() {
  if (!els.qaPanel) return;
  const ready = hasMasterNotes();
  els.qaPanel.hidden = !ready;
  if (!ready) return;

  const chat = Array.isArray(state.notesChat) ? state.notesChat : [];
  if (els.clearChatBtn) els.clearChatBtn.hidden = chat.length === 0;

  if (els.qaMessages) {
    els.qaMessages.textContent = '';
    const frag = document.createDocumentFragment();
    chat.forEach(function (msg) {
      if (!msg || typeof msg.text !== 'string') return;
      const row = document.createElement('div');
      if (msg.role === 'user') {
        row.className = 'qa-msg-user';
        row.textContent = msg.text;
      } else {
        row.className = 'qa-msg-model';
        const head = document.createElement('div');
        head.className = 'qa-msg-head';

        const label = document.createElement('span');
        label.textContent = 'Groq';

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'qa-copy-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', function () {
          navigator.clipboard.writeText(msg.text).then(function () {
            copyBtn.textContent = 'Copied!';
            setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500);
          });
        });

        head.appendChild(label);
        head.appendChild(copyBtn);

        const body = document.createElement('div');
        body.innerHTML = renderMarkdown(msg.text);

        row.appendChild(head);
        row.appendChild(body);
      }
      frag.appendChild(row);
    });
    els.qaMessages.appendChild(frag);
  }

  if (els.qaThinking) els.qaThinking.hidden = !state.qaPending;
  if (els.qaSendBtn) {
    const text = els.qaInput ? els.qaInput.value.trim() : '';
    els.qaSendBtn.disabled = state.qaPending || !text || !hasApiKey();
    if (!hasApiKey()) els.qaSendBtn.title = 'Set your Groq API key first';
    else if (state.qaPending) els.qaSendBtn.title = 'Waiting for Groq response';
    else els.qaSendBtn.title = '';
  }
  if (els.qaInput) els.qaInput.disabled = state.qaPending;
}

function onQaInput() {
  if (!els.qaSendBtn) return;
  const text = els.qaInput ? els.qaInput.value.trim() : '';
  els.qaSendBtn.disabled = state.qaPending || !text || !hasApiKey();
}

function onQaKeyDown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    onQaSubmit();
  }
}

function onQaChipClick(e) {
  const btn = e.target && e.target.closest ? e.target.closest('.qa-chip') : null;
  if (!btn || !btn.dataset.prompt) return;
  if (els.qaInput) {
    els.qaInput.value = btn.dataset.prompt;
    onQaInput();
    onQaSubmit();
  }
}

function onQaSubmit(e) {
  if (e && e.preventDefault) e.preventDefault();
  if (state.qaPending) return;
  const prompt = els.qaInput ? els.qaInput.value.trim() : '';
  if (!prompt) return;
  if (!hasApiKey()) {
    showMessage('Set your Groq API key in Options first.');
    return;
  }
  if (!hasMasterNotes()) {
    showMessage('Generate master notes first.');
    return;
  }

  state.qaPending = true;
  const currentHistory = Array.isArray(state.notesChat) ? state.notesChat.slice() : [];
  state.notesChat = currentHistory.concat([{ role: 'user', text: prompt, timestamp: Date.now() }]);
  if (els.qaInput) els.qaInput.value = '';
  renderQa();
  if (els.qaMessages) els.qaMessages.scrollTop = els.qaMessages.scrollHeight;

  sendMessage({
    action: 'promptMasterNotes',
    prompt: prompt,
    history: currentHistory
  })
    .then(function (res) {
      state.qaPending = false;
      if (res && Array.isArray(res.history)) {
        state.notesChat = res.history;
      }
      renderQa();
      if (els.qaMessages) els.qaMessages.scrollTop = els.qaMessages.scrollHeight;
    })
    .catch(function (err) {
      state.qaPending = false;
      state.notesChat = currentHistory.concat([
        { role: 'user', text: prompt, timestamp: Date.now() },
        { role: 'model', text: '**Error:** ' + (err.message || 'Failed to get a response.'), timestamp: Date.now() }
      ]);
      renderQa();
      if (els.qaMessages) els.qaMessages.scrollTop = els.qaMessages.scrollHeight;
    });
}

function onClearChat() {
  if (!state.notesChat || state.notesChat.length === 0) return;
  if (!confirm('Clear the conversation history?')) return;
  state.notesChat = [];
  renderQa();
  sendMessage({ action: 'clearNotesChat' }).catch(function (err) {
    console.warn('Could not clear notes chat in background:', err);
  });
}

document.addEventListener('DOMContentLoaded', init);

// Allow `require('./popup.js')` in Node tests (no effect in the browser).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    renderMarkdown: renderMarkdown,
    renderInlineMarkdown: renderInlineMarkdown,
    escapeHtml: escapeHtml,
    formatTime: formatTime,
    getQuizFeedback: getQuizFeedback,
    computeQuizScore: computeQuizScore,
  };
}
