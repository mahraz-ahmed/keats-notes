/* KEATS Video Summariser — background service worker (classic script, MV3). */

const MODEL = 'gemini-3.8-flash';
const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse';
const MAX_SINGLE_PASS_CHARS = 300000;
const MAP_CONCURRENCY = 3;
const TEMPERATURE = 0.3;
const SYNTHESIS_MAX_TOKENS = 8192;
const CONDENSE_MAX_TOKENS = 4000;

const GENERIC_TITLES = ['kaltura', 'kaltura player', 'player', 'video', 'media', 'untitled'];

const SYNTHESIS_PROMPT =
  "You are an expert Computer Science tutor at King's College London. You will receive transcripts from multiple lecture videos, in order. Synthesise them into ONE cohesive, overarching Markdown study guide — do not summarise each video separately. Structure: Title; Overview; Learning objectives; Key concepts (grouped by topic across videos, with clear definitions); Worked examples and code blocks where relevant; How the topics connect; Common pitfalls; Revision checklist; Possible exam questions. Use headings, bullet points and fenced code blocks. Do not invent material unsupported by the transcripts.";

const CONDENSE_PROMPT =
  'You are an expert Computer Science tutor. Condense this single lecture transcript into detailed, faithful Markdown notes capturing every key concept, definition, example, algorithm and piece of code. Do not invent content.';

const INTERRUPTED_ERROR = 'Generation was interrupted. Please try again.';

// ---------------------------------------------------------------------------
// Serialised writes
// ---------------------------------------------------------------------------

let chain = Promise.resolve();
let isGenerating = false;

function withLock(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getQueue() {
  const { queue } = await chrome.storage.local.get('queue');
  return Array.isArray(queue) ? queue : [];
}

async function setQueue(queue) {
  await chrome.storage.local.set({ queue });
}

async function setMasterNotes(masterNotes) {
  await chrome.storage.local.set({ masterNotes });
}

async function getMasterNotes() {
  const { masterNotes } = await chrome.storage.local.get('masterNotes');
  return (masterNotes && typeof masterNotes === 'object') ? masterNotes : {};
}

async function getApiKey() {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  return typeof apiKey === 'string' ? apiKey.trim() : '';
}

function tabContextKey(tabId) {
  return `tabContext:${tabId}`;
}

async function getTabContext(tabId) {
  if (tabId === undefined || tabId === null) return {};
  if (!chrome.storage || !chrome.storage.session) return {};
  try {
    const key = tabContextKey(tabId);
    const data = await chrome.storage.session.get(key);
    return (data && data[key]) || {};
  } catch (err) {
    console.warn('[KEATS] Failed to read tab context:', err);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return 'hash-' + (h >>> 0).toString(36);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isGenericTitle(title) {
  return GENERIC_TITLES.includes(String(title).trim().toLowerCase());
}

function resolveTitle(playerTitle, tabContext, tab) {
  if (isNonEmptyString(playerTitle) && !isGenericTitle(playerTitle)) return playerTitle.trim();
  if (tabContext && isNonEmptyString(tabContext.pageTitle)) return tabContext.pageTitle.trim();
  if (tab && isNonEmptyString(tab.title)) return tab.title.trim();
  return 'Untitled video';
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

async function handlePageContextCaptured(msg, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  if (tabId === undefined || tabId === null) return { ok: false, error: 'No tab id.' };
  await chrome.storage.session.set({
    [tabContextKey(tabId)]: { pageTitle: msg.pageTitle || '', url: msg.url || '' }
  });
  return { ok: true };
}

async function handleVideoTranscriptCaptured(msg, sender) {
  const transcript = msg.transcript;
  if (!isNonEmptyString(transcript)) {
    return { ok: false, error: 'Transcript is empty or invalid.' };
  }
  const tab = sender && sender.tab ? sender.tab : undefined;
  const tabContext = await getTabContext(tab ? tab.id : undefined);
  const title = resolveTitle(msg.playerTitle, tabContext, tab);
  const pageUrl = (tab && tab.url) || tabContext.url || '';
  const id = isNonEmptyString(msg.id) ? msg.id : hashString(transcript);
  const cueCount = typeof msg.cueCount === 'number' ? msg.cueCount : 0;
  const frameUrl = msg.frameUrl || '';

  return withLock(async () => {
    const queue = await getQueue();
    const idx = queue.findIndex((item) => item && item.id === id);
    const capturedAt = Date.now();
    let queued = false;
    let updated = false;
    if (idx !== -1) {
      queue[idx] = { ...queue[idx], id, title, pageUrl, frameUrl, transcript, cueCount, capturedAt };
      await setQueue(queue);
      updated = true;
    } else {
      queue.push({ id, title, pageUrl, frameUrl, transcript, cueCount, capturedAt });
      await setQueue(queue);
      queued = true;
    }

    // Notify tab so it displays an on-page 'Notes captured!' popup toast
    if (tab && tab.id && chrome.tabs && typeof chrome.tabs.sendMessage === 'function') {
      try {
        const p = chrome.tabs.sendMessage(tab.id, {
          action: 'showCaptureToast',
          title: title,
          cueCount: cueCount,
          queued: queued,
          updated: updated
        });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (err) {
        /* ignore tab send failure */
      }
    }

    return { ok: true, queued, updated };
  });
}

function handleRemoveFromQueue(msg) {
  return withLock(async () => {
    const queue = await getQueue();
    await setQueue(queue.filter((item) => item && item.id !== msg.id));
    return { ok: true };
  });
}

function handleClearQueue() {
  return withLock(async () => {
    await setQueue([]);
    return { ok: true };
  });
}

function handleClearMasterNotes() {
  return withLock(async () => {
    await setMasterNotes({ status: 'idle' });
    await chrome.storage.local.set({ notesChat: [] });
    return { ok: true };
  });
}

function handleClearNotesChat() {
  return withLock(async () => {
    await chrome.storage.local.set({ notesChat: [] });
    return { ok: true };
  });
}

function getQaSystemInstruction(notesMarkdown) {
  return [
    "You are an expert Computer Science tutor at King's College London assisting a student.",
    "You have full access to the student's Master Study Notes synthesized from their lecture videos below:",
    "",
    "--- MASTER STUDY NOTES ---",
    notesMarkdown,
    "--- END MASTER STUDY NOTES ---",
    "",
    "Instructions:",
    "1. Answer the student's questions, requests, or prompts accurately based on the notes above.",
    "2. If the student asks for practice questions, quiz questions, or flashcards, provide high-quality problems with clear explanations.",
    "3. If the student asks to clarify or expand on concepts, algorithms, proofs, or definitions, provide thorough pedagogical explanations and code snippets where appropriate.",
    "4. Format your response using clean, modern Markdown with headings, bullet lists, and fenced code blocks."
  ].join('\n');
}

async function handlePromptMasterNotes(msg) {
  const prompt = (msg && typeof msg.prompt === 'string') ? msg.prompt.trim() : '';
  if (!prompt) {
    return { ok: false, error: 'Prompt cannot be empty.' };
  }

  const apiKey = await getApiKey();
  if (!isNonEmptyString(apiKey)) {
    return { ok: false, error: 'Set your Google Gemini API key in Options first.' };
  }

  const masterNotes = await getMasterNotes();
  const notesMarkdown = (masterNotes && typeof masterNotes.markdown === 'string') ? masterNotes.markdown.trim() : '';
  if (!notesMarkdown) {
    return { ok: false, error: 'No master notes found. Please generate master notes first.' };
  }

  const rawHistory = Array.isArray(msg.history) ? msg.history : [];
  const contents = [];
  for (const item of rawHistory) {
    if (item && isNonEmptyString(item.text) && (item.role === 'user' || item.role === 'model')) {
      contents.push({
        role: item.role,
        parts: [{ text: item.text }]
      });
    }
  }
  contents.push({
    role: 'user',
    parts: [{ text: prompt }]
  });

  const answer = await callGemini(
    apiKey,
    getQaSystemInstruction(notesMarkdown),
    contents,
    4000
  );

  const updatedHistory = rawHistory.concat([
    { role: 'user', text: prompt, timestamp: Date.now() },
    { role: 'model', text: answer, timestamp: Date.now() }
  ]);
  await chrome.storage.local.set({ notesChat: updatedHistory });

  return { ok: true, answer, history: updatedHistory };
}

// ---------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------

async function callGemini(apiKey, systemInstruction, userTextOrContents, maxTokens) {
  let res;
  const contents = Array.isArray(userTextOrContents)
    ? userTextOrContents
    : [
        {
          role: 'user',
          parts: [{ text: String(userTextOrContents || '') }]
        }
      ];

  const requestBody = {
    contents,
    generationConfig: {
      temperature: TEMPERATURE,
      maxOutputTokens: maxTokens
    }
  };
  if (systemInstruction) {
    requestBody.systemInstruction = {
      parts: [{ text: systemInstruction }]
    };
  }

  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json'
      },
      // Streaming: response headers arrive quickly and chunks keep flowing, so
      // Chrome doesn't terminate the MV3 service worker for a slow fetch response.
      body: JSON.stringify(requestBody)
    });
  } catch (err) {
    throw new Error('Network error: could not reach the Gemini API. Check your internet connection and try again.');
  }

  if (!res.ok) {
    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      data = {};
    }
    const detail = (data && data.error && data.error.message) || res.statusText;
    throw new Error(`Gemini API error (${res.status}): ${detail}`);
  }

  let content = '';
  let finishReason = null;

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const handleLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let json;
      try {
        json = JSON.parse(payload);
      } catch (e) {
        return; // ignore malformed / partial lines
      }
      if (json.error) throw new Error(`Gemini API error: ${json.error.message || 'unknown error'}`);
      const candidate = json.candidates && json.candidates[0];
      if (candidate) {
        if (candidate.finishReason) finishReason = candidate.finishReason;
        const parts = candidate.content && candidate.content.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (part && typeof part.text === 'string') content += part.text;
          }
        }
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          handleLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      }
      buffer += decoder.decode();
      if (buffer) handleLine(buffer);
    } catch (err) {
      if (err && /Gemini API error/.test(err.message)) throw err;
      throw new Error('Network error while receiving the response from Gemini. Please try again.');
    }
  } else {
    // Fallback for environments without a readable stream body.
    const data = await res.json();
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      const candidate = item?.candidates?.[0];
      if (candidate) {
        if (candidate.finishReason) finishReason = candidate.finishReason;
        const parts = candidate.content?.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (part && typeof part.text === 'string') content += part.text;
          }
        }
      }
    }
  }

  content = content.trim();
  if (!content) throw new Error('Gemini returned an empty response.');
  if (finishReason === 'MAX_TOKENS') {
    content += '\n\n> **Note:** the output reached the token limit and may be incomplete.';
  }
  return content;
}

function buildCombined(items, getText) {
  return items.map((item, i) => `## Video ${i + 1}: ${item.title}\n${getText(item, i)}`).join('\n\n');
}

async function condenseTranscript(apiKey, item) {
  let transcript = item.transcript || '';
  if (transcript.length > MAX_SINGLE_PASS_CHARS) {
    transcript =
      transcript.slice(0, MAX_SINGLE_PASS_CHARS) +
      '\n\n[Note: transcript truncated due to length; later content omitted.]';
  }
  return callGemini(
    apiKey,
    CONDENSE_PROMPT,
    `Lecture video title: ${item.title}\n\nTranscript:\n${transcript}`,
    CONDENSE_MAX_TOKENS
  );
}

async function synthesise(apiKey, queue) {
  const n = queue.length;
  const combined = buildCombined(queue, (item) => item.transcript);

  if (combined.length <= MAX_SINGLE_PASS_CHARS) {
    return callGemini(
      apiKey,
      SYNTHESIS_PROMPT,
      `The following are transcripts from ${n} lecture video(s), in order.\n\n${combined}`,
      SYNTHESIS_MAX_TOKENS
    );
  }

  // Map-reduce: condense each video, then synthesise the condensed notes.
  const condensed = await mapWithConcurrency(queue, MAP_CONCURRENCY, (item) => condenseTranscript(apiKey, item));
  const combinedNotes = buildCombined(queue, (item, i) => condensed[i]);
  return callGemini(
    apiKey,
    SYNTHESIS_PROMPT,
    `The following are condensed notes from the transcripts of ${n} lecture video(s), in order.\n\n${combinedNotes}`,
    SYNTHESIS_MAX_TOKENS
  );
}

async function generateMasterNotes() {
  if (isGenerating) return;
  isGenerating = true;
  // Calling any extension API resets the MV3 service worker's 30 s idle timer, so ping
  // periodically while a (possibly multi-call, map-reduce) generation is running.
  const keepAlive = setInterval(() => {
    try {
      if (chrome.runtime.getPlatformInfo) chrome.runtime.getPlatformInfo(() => {});
    } catch (e) {
      /* ignore */
    }
  }, 20000);
  let videoIds;
  try {
    const { apiKey } = await chrome.storage.local.get('apiKey');
    if (!isNonEmptyString(apiKey)) {
      await setMasterNotes({ status: 'error', error: 'Set your Gemini API key in Options.' });
      return;
    }
    const queue = await getQueue();
    if (queue.length === 0) {
      await setMasterNotes({ status: 'error', error: 'Queue is empty.' });
      return;
    }
    videoIds = queue.map((item) => item.id);
    await setMasterNotes({ status: 'generating', videoIds });

    const markdown = await synthesise(apiKey.trim(), queue);
    await setMasterNotes({ status: 'done', markdown, videoIds, generatedAt: Date.now() });
  } catch (err) {
    console.error('[KEATS] Master notes generation failed:', err);
    try {
      await setMasterNotes({
        status: 'error',
        error: (err && err.message) || String(err),
        videoIds
      });
    } catch (e) {
      console.error('[KEATS] Failed to save error state:', e);
    }
  } finally {
    clearInterval(keepAlive);
    isGenerating = false;
  }
}

// ---------------------------------------------------------------------------
// Startup recovery
// ---------------------------------------------------------------------------

async function recoverInterruptedGeneration() {
  try {
    const { masterNotes } = await chrome.storage.local.get('masterNotes');
    // Check the in-memory flag after the read to avoid clobbering a generation started meanwhile.
    if (masterNotes && masterNotes.status === 'generating' && !isGenerating) {
      await setMasterNotes({
        status: 'error',
        error: INTERRUPTED_ERROR,
        videoIds: masterNotes.videoIds
      });
    }
  } catch (err) {
    console.warn('[KEATS] Startup recovery failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

function respondAsync(promise, sendResponse) {
  Promise.resolve()
    .then(() => promise())
    .then(
      (result) => sendResponse(result),
      (err) => {
        console.error('[KEATS] Handler error:', err);
        sendResponse({ ok: false, error: (err && err.message) || String(err) });
      }
    );
  return true;
}

function onMessageListener(msg, sender, sendResponse) {
  const action = msg && msg.action;
  switch (action) {
    case 'pageContextCaptured':
      return respondAsync(() => handlePageContextCaptured(msg, sender), sendResponse);
    case 'videoTranscriptCaptured':
      return respondAsync(() => handleVideoTranscriptCaptured(msg, sender), sendResponse);
    case 'generateMasterNotes':
      sendResponse({ ok: true });
      generateMasterNotes();
      return false;
    case 'removeFromQueue':
      return respondAsync(() => handleRemoveFromQueue(msg), sendResponse);
    case 'clearQueue':
      return respondAsync(() => handleClearQueue(), sendResponse);
    case 'clearMasterNotes':
      return respondAsync(() => handleClearMasterNotes(), sendResponse);
    case 'promptMasterNotes':
      return respondAsync(() => handlePromptMasterNotes(msg), sendResponse);
    case 'clearNotesChat':
      return respondAsync(() => handleClearNotesChat(), sendResponse);
    default:
      return false;
  }
}

function onTabRemovedListener(tabId) {
  if (!chrome.storage || !chrome.storage.session) return;
  chrome.storage.session.remove(tabContextKey(tabId)).catch((err) => {
    console.warn('[KEATS] Failed to remove tab context:', err);
  });
}

chrome.runtime.onMessage.addListener(onMessageListener);

if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener(onTabRemovedListener);
}

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(recoverInterruptedGeneration);
}

recoverInterruptedGeneration();
