/* KEATS Video Summariser — background service worker (classic script, MV3). */

const MODEL = 'qwen/qwen3.8-27b';
const API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_SINGLE_PASS_CHARS = 300000;
const MAP_CONCURRENCY = 3;
const TEMPERATURE = 0.3;
const SYNTHESIS_MAX_TOKENS = 950;
const CONDENSE_MAX_TOKENS = 800;
const QUIZ_MAX_TOKENS = 900;
const QA_MAX_TOKENS = 900;

const GENERIC_TITLES = ['kaltura', 'kaltura player', 'player', 'video', 'media', 'untitled'];

const SYNTHESIS_PROMPT =
  "You are an expert Computer Science tutor at King's College London. You will receive transcripts from multiple lecture videos. Synthesise them into ONE cohesive, overarching Markdown study guide — do not summarise each video separately. Structure: Title; Overview; Key concepts (grouped by topic across videos, with clear definitions); a practice question or two to drill the key concept into the reader's head (or prefer actionable coding drills based on the key concept if it involves programming) on each key concept. Use headings, bullet points and fenced code blocks. Be concise and high-density so the entire guide fits within the output token budget. Do not invent material unsupported by the transcripts.";

const CONDENSE_PROMPT =
  'You are an expert Computer Science tutor. Condense this single lecture transcript into detailed, faithful, concise Markdown notes capturing every key concept, definition, example, algorithm and piece of code. Do not invent content.';

const QUIZ_SYSTEM_PROMPT = [
  "You are an expert Computer Science examiner at King's College London.",
  "Turn the provided Master Study Notes into a multiple-choice quiz covering ALL key topics in the notes.",
  "",
  "Strict Requirements:",
  "1. Cover ALL key topics and concepts present in the Master Study Notes. Every major topic section in the notes MUST be tested by at least one question.",
  "2. Use ONLY multiple-choice format with 4 options per question.",
  "3. Do NOT prefix option strings with letters or numbers (e.g. do not write 'A. ' or '1) ') — provide only the option text itself.",
  "4. Vary the correct option index (0, 1, 2, 3) across questions and keep options concise and self-contained.",
  "5. Keep the output compact so all questions fit well within 850 tokens. Use these exact short keys for each question object:",
  "   - \"t\": Specific topic name from the notes.",
  "   - \"q\": Concise question stem (may use inline backticks for code).",
  "   - \"o\": Array of 4 concise option strings.",
  "   - \"c\": Integer 0, 1, 2, or 3 indicating the correct option.",
  "   - \"e\": Brief 1-sentence note explaining why the correct option is right and why the other choices are wrong.",
  "6. Output ONLY valid minified JSON in the exact format below (no markdown code fences, no extra text):",
  "{\"q\":[{\"t\":\"Topic Name\",\"q\":\"Question?\",\"o\":[\"Opt 1\",\"Opt 2\",\"Opt 3\",\"Opt 4\"],\"c\":0,\"e\":\"Brief note on why Opt 1 is right and others are wrong.\"}]}"
].join('\n');

const INTERRUPTED_ERROR = 'Generation was interrupted. Please try again.';

// ---------------------------------------------------------------------------
// Serialised writes
// ---------------------------------------------------------------------------

let chain = Promise.resolve();
let isGenerating = false;
let isGeneratingQuiz = false;

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

async function setMasterQuiz(masterQuiz) {
  await chrome.storage.local.set({ masterQuiz });
}

async function getMasterQuiz() {
  const { masterQuiz } = await chrome.storage.local.get('masterQuiz');
  return (masterQuiz && typeof masterQuiz === 'object') ? masterQuiz : { status: 'idle' };
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
    await setMasterQuiz({ status: 'idle' });
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

function handleAnswerQuizQuestion(msg) {
  return withLock(async () => {
    const quiz = await getMasterQuiz();
    if (!quiz || quiz.status !== 'done' || !Array.isArray(quiz.questions)) {
      return { ok: false, error: 'No active quiz found.' };
    }
    const qIdx = Number(msg && msg.questionIndex);
    const optIdx = Number(msg && msg.optionIndex);
    if (!Number.isInteger(qIdx) || qIdx < 0 || qIdx >= quiz.questions.length) {
      return { ok: false, error: 'Invalid question index.' };
    }
    const q = quiz.questions[qIdx];
    if (!Number.isInteger(optIdx) || optIdx < 0 || !Array.isArray(q.options) || optIdx >= q.options.length) {
      return { ok: false, error: 'Invalid option index.' };
    }
    const answers = Object.assign({}, (quiz.answers && typeof quiz.answers === 'object') ? quiz.answers : {});
    if (!(String(qIdx) in answers)) {
      answers[String(qIdx)] = optIdx;
      await setMasterQuiz(Object.assign({}, quiz, { answers }));
    }
    return { ok: true, answers };
  });
}

function handleResetMasterQuiz() {
  return withLock(async () => {
    const quiz = await getMasterQuiz();
    if (quiz && quiz.status === 'done') {
      await setMasterQuiz(Object.assign({}, quiz, { answers: {} }));
    }
    return { ok: true };
  });
}

function handleClearMasterQuiz() {
  return withLock(async () => {
    await setMasterQuiz({ status: 'idle' });
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
    return { ok: false, error: 'Set your Groq API key in Options first.' };
  }

  const masterNotes = await getMasterNotes();
  const notesMarkdown = (masterNotes && typeof masterNotes.markdown === 'string') ? masterNotes.markdown.trim() : '';
  if (!notesMarkdown) {
    return { ok: false, error: 'No master notes found. Please generate master notes first.' };
  }

  const rawHistory = Array.isArray(msg.history) ? msg.history : [];
  const messages = [];
  for (const item of rawHistory) {
    if (item && isNonEmptyString(item.text) && (item.role === 'user' || item.role === 'model' || item.role === 'assistant')) {
      messages.push({
        role: item.role === 'model' ? 'assistant' : item.role,
        content: item.text
      });
    }
  }
  messages.push({
    role: 'user',
    content: prompt
  });

  const answer = await callGroq(
    apiKey,
    getQaSystemInstruction(notesMarkdown),
    messages,
    QA_MAX_TOKENS
  );

  const updatedHistory = rawHistory.concat([
    { role: 'user', text: prompt, timestamp: Date.now() },
    { role: 'model', text: answer, timestamp: Date.now() }
  ]);
  await chrome.storage.local.set({ notesChat: updatedHistory });

  return { ok: true, answer, history: updatedHistory };
}

// ---------------------------------------------------------------------------
// Groq Cloud
// ---------------------------------------------------------------------------

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryWaitMs(detail, retryAfterHeader) {
  if (retryAfterHeader) {
    const sec = parseFloat(retryAfterHeader);
    if (isFinite(sec) && sec > 0) return Math.min(62000, Math.ceil(sec * 1000) + 500);
  }
  const m = /try again in\s+(\d+(?:\.\d+)?)\s*(ms|m|s)/i.exec(String(detail || ''));
  if (m) {
    const val = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    const ms = unit === 'ms' ? val : unit === 'm' ? val * 60000 : val * 1000;
    if (isFinite(ms) && ms > 0) return Math.min(62000, Math.ceil(ms) + 500);
  }
  return 0;
}

async function callGroq(apiKey, systemInstruction, userTextOrMessages, maxTokens, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const messages = [];
  if (systemInstruction) {
    messages.push({
      role: 'system',
      content: systemInstruction
    });
  }

  if (Array.isArray(userTextOrMessages)) {
    for (const item of userTextOrMessages) {
      if (!item) continue;
      const role = item.role === 'model' ? 'assistant' : (item.role || 'user');
      const text = typeof item.content === 'string'
        ? item.content
        : (item.parts && item.parts[0] && typeof item.parts[0].text === 'string' ? item.parts[0].text : '');
      if (text) messages.push({ role, content: text });
    }
  } else {
    messages.push({
      role: 'user',
      content: String(userTextOrMessages || '')
    });
  }

  let currentMaxTokens = typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 900;
  let useReasoningEffort = /^qwen\//i.test(MODEL);
  let res;

  for (let attempt = 0; attempt < 4; attempt++) {
    const requestBody = {
      model: MODEL,
      messages,
      temperature: TEMPERATURE,
      max_completion_tokens: currentMaxTokens,
      stream: true
    };
    if (useReasoningEffort) {
      requestBody.reasoning_effort = 'none';
    }

    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        // Streaming: response headers arrive quickly and chunks keep flowing, so
        // Chrome doesn't terminate the MV3 service worker for a slow fetch response.
        body: JSON.stringify(requestBody)
      });
    } catch (err) {
      throw new Error('Network error: could not reach the Groq API. Check your internet connection and try again.');
    }

    if (res.ok) break;

    let data = {};
    try {
      data = await res.json();
    } catch (e) {
      data = {};
    }
    const detail = (data && data.error && data.error.message) || res.statusText || '';

    // If reasoning_effort is rejected by the model, retry immediately without it.
    if (res.status === 400 && useReasoningEffort && /reasoning/i.test(detail)) {
      useReasoningEffort = false;
      continue;
    }

    // Handle 429 OTPM / TPM rate limits automatically by scaling max_completion_tokens or waiting.
    if (res.status === 429 && attempt < 3) {
      const limitMatch = /Limit\s+(\d+)/i.exec(detail);
      const reqMatch = /Requested\s+(\d+)/i.exec(detail);
      const usedMatch = /Used\s+(\d+)/i.exec(detail);
      const limit = limitMatch ? parseInt(limitMatch[1], 10) : 0;
      const requested = reqMatch ? parseInt(reqMatch[1], 10) : 0;
      const used = usedMatch ? parseInt(usedMatch[1], 10) : 0;
      const retryAfter = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
      const waitMs = parseRetryWaitMs(detail, retryAfter);

      const isTooLarge = /expected output tokens exceed|reduce max_tokens|Request too large/i.test(detail);
      if (isTooLarge) {
        if (limit > 0 && requested > 0) {
          const available = used > 0 && used < limit ? (limit - used) : limit;
          const scaled = Math.floor(currentMaxTokens * (available / requested) * 0.85);
          currentMaxTokens = Math.max(200, Math.min(limit - 50, scaled, currentMaxTokens - 100));
        } else if (limit > 0) {
          currentMaxTokens = Math.max(200, Math.min(limit - 100, Math.floor(currentMaxTokens * 0.65)));
        } else {
          currentMaxTokens = Math.max(200, Math.floor(currentMaxTokens * 0.6));
        }
        if (waitMs > 0) {
          await sleepMs(waitMs);
        }
        continue;
      }

      if (waitMs > 0 || used > 0) {
        await sleepMs(waitMs > 0 ? waitMs : 12000);
        if (limit > 0 && currentMaxTokens >= limit) {
          currentMaxTokens = Math.max(250, limit - 100);
        }
        continue;
      }
    }

    throw new Error(`Groq API error (${res.status}): ${detail}`);
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
      if (json.error) throw new Error(`Groq API error: ${json.error.message || 'unknown error'}`);
      const choice = json.choices && json.choices[0];
      if (choice) {
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const deltaText = choice.delta && choice.delta.content;
        if (typeof deltaText === 'string') {
          content += deltaText;
        } else if (choice.message && typeof choice.message.content === 'string') {
          content += choice.message.content;
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
      if (err && /Groq API error/.test(err.message)) throw err;
      throw new Error('Network error while receiving the response from Groq. Please try again.');
    }
  } else {
    // Fallback for environments without a readable stream body.
    const data = await res.json();
    const items = Array.isArray(data) ? data : [data];
    for (const item of items) {
      const choice = item?.choices?.[0];
      if (choice) {
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const msgText = choice.message?.content ?? choice.delta?.content;
        if (typeof msgText === 'string') content += msgText;
      }
    }
  }

  content = content.trim();
  if (!content) throw new Error('Groq returned an empty response.');
  if (!opts.rawJson && (finishReason === 'length' || finishReason === 'MAX_TOKENS')) {
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
  return callGroq(
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
    return callGroq(
      apiKey,
      SYNTHESIS_PROMPT,
      `The following are transcripts from ${n} lecture video(s), in order.\n\n${combined}`,
      SYNTHESIS_MAX_TOKENS
    );
  }

  // Map-reduce: condense each video, then synthesise the condensed notes.
  const condensed = await mapWithConcurrency(queue, MAP_CONCURRENCY, (item) => condenseTranscript(apiKey, item));
  const combinedNotes = buildCombined(queue, (item, i) => condensed[i]);
  return callGroq(
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
      await setMasterNotes({ status: 'error', error: 'Set your Groq API key in Options.' });
      return;
    }
    const queue = await getQueue();
    if (queue.length === 0) {
      await setMasterNotes({ status: 'error', error: 'Queue is empty.' });
      return;
    }
    videoIds = queue.map((item) => item.id);
    await setMasterNotes({ status: 'generating', videoIds });
    await setMasterQuiz({ status: 'idle' });

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
// Master Notes Quiz Generation
// ---------------------------------------------------------------------------

function extractKeyTopicsFromNotes(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const ignored = /^(title|overview|introduction|summary|conclusion|key concepts?|practice questions?|coding drills?|actionable coding drills?|exercises?|questions?|table of contents)$/i;
  const topics = [];
  const seen = new Set();
  for (const line of lines) {
    const m = /^\s*#{2,4}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      const raw = m[1]
        .replace(/\*\*|__|`/g, '')
        .replace(/^\d+[.)]\s*/, '')
        .trim();
      if (raw && !ignored.test(raw) && !/^practice question/i.test(raw) && !/^coding drill/i.test(raw)) {
        const key = raw.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          topics.push(raw);
        }
      }
    }
  }
  return topics;
}

function stripOptionPrefix(opt) {
  return String(opt == null ? '' : opt)
    .replace(/^\s*(?:[A-Da-d][.):\-]|(?:\([A-Da-d]\))|\d+[.):\-])\s+/, '')
    .trim();
}

function resolveCorrectIndex(q, options) {
  const candidates = [
    q.c,
    q.correctIndex,
    q.correct_index,
    q.answerIndex,
    q.answer_index,
    q.correctAnswer,
    q.correct_answer,
    q.correct,
    q.answer
  ];
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isInteger(c) && c >= 0 && c < options.length) {
      return c;
    }
    if (typeof c === 'string') {
      const trimmed = c.trim();
      if (/^[0-3]$/.test(trimmed)) {
        const n = Number(trimmed);
        if (n < options.length) return n;
      }
      if (/^[A-Da-d]$/.test(trimmed)) {
        const idx = trimmed.toUpperCase().charCodeAt(0) - 65;
        if (idx >= 0 && idx < options.length) return idx;
      }
      const matchIdx = options.findIndex(
        (o) => o.toLowerCase() === stripOptionPrefix(trimmed).toLowerCase()
      );
      if (matchIdx !== -1) return matchIdx;
    }
  }
  return 0;
}

function extractJsonSubstring(text) {
  let s = String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/\n*>\s*\*\*Note:\*\*[\s\S]*$/i, '')
    .trim();

  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fenceMatch && fenceMatch[1]) {
    s = fenceMatch[1].trim();
  }

  const firstObj = s.indexOf('{');
  const firstArr = s.indexOf('[');
  let start = -1;
  let closeChar = '';
  if (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) {
    start = firstObj;
    closeChar = '}';
  } else if (firstArr !== -1) {
    start = firstArr;
    closeChar = ']';
  }
  if (start === -1) return s;

  const end = s.lastIndexOf(closeChar);
  if (end > start) {
    return s.slice(start, end + 1);
  }
  return s.slice(start);
}

function salvageTruncatedQuizJson(raw) {
  const s = String(raw || '').trim();
  const arrStart = s.indexOf('[');
  if (arrStart === -1) return null;
  let pos = s.length;
  while (pos > arrStart) {
    const lastBrace = s.lastIndexOf('}', pos - 1);
    if (lastBrace === -1 || lastBrace <= arrStart) break;
    const prefix = s.slice(0, lastBrace + 1);
    const suffix = s.trim().startsWith('[') ? ']' : ']}';
    try {
      return JSON.parse(prefix + suffix);
    } catch (e) {
      pos = lastBrace;
    }
  }
  return null;
}

function parseQuizResponse(rawText) {
  const candidate = extractJsonSubstring(rawText);
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (e1) {
    const repaired = candidate.replace(/,\s*([}\]])/g, '$1');
    try {
      parsed = JSON.parse(repaired);
    } catch (e2) {
      parsed = salvageTruncatedQuizJson(repaired) || salvageTruncatedQuizJson(RawTextOrCandidate(rawText, candidate));
      if (!parsed) {
        throw new Error('Could not parse quiz questions from AI response. Please try generating the quiz again.');
      }
    }
  }

  const rawList = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.q)
        ? parsed.q
        : (parsed && Array.isArray(parsed.questions)
            ? parsed.questions
            : (parsed && Array.isArray(parsed.quiz) ? parsed.quiz : null)));

  if (!Array.isArray(rawList) || rawList.length === 0) {
    throw new Error('AI response did not contain any quiz questions. Please try again.');
  }

  const questions = [];
  for (let i = 0; i < rawList.length; i++) {
    const q = rawList[i];
    if (!q || typeof q !== 'object') continue;
    const questionText = String(q.q || q.question || q.prompt || q.stem || '').trim();
    if (!questionText) continue;

    const rawOptions = Array.isArray(q.o || q.options || q.choices) ? (q.o || q.options || q.choices) : [];
    const options = rawOptions
      .map((o) => stripOptionPrefix(o))
      .filter((o) => o.length > 0)
      .slice(0, 4);
    if (options.length < 2) continue;

    const correctIndex = resolveCorrectIndex(q, options);
    const topic = String(q.t || q.topic || q.category || q.concept || 'Key Concept').trim() || 'Key Concept';
    const rawOptExps = Array.isArray(q.optionExplanations || q.option_explanations || q.explanations)
      ? (q.optionExplanations || q.option_explanations || q.explanations)
      : [];
    const optionExplanations = options.map((_, idx) =>
      rawOptExps[idx] != null ? String(rawOptExps[idx]).trim() : ''
    );
    let explanation = String(q.e || q.explanation || q.rationale || q.reason || '').trim();
    if (!explanation && optionExplanations[correctIndex]) {
      explanation = optionExplanations[correctIndex];
    }
    if (!explanation) {
      explanation = 'The correct answer is "' + options[correctIndex] + '".';
    }

    questions.push({
      topic,
      question: questionText,
      options,
      correctIndex,
      explanation,
      optionExplanations
    });
  }

  if (questions.length === 0) {
    throw new Error('No valid multiple-choice questions were generated. Please try again.');
  }
  return questions;
}

function RawTextOrCandidate(rawText, candidate) {
  const s = String(rawText || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/\n*>\s*\*\*Note:\*\*[\s\S]*$/i, '')
    .trim();
  const firstObj = s.indexOf('{');
  return firstObj !== -1 ? s.slice(firstObj) : candidate;
}

async function generateMasterQuiz() {
  if (isGeneratingQuiz) return;
  isGeneratingQuiz = true;
  const keepAlive = setInterval(() => {
    try {
      if (chrome.runtime.getPlatformInfo) chrome.runtime.getPlatformInfo(() => {});
    } catch (e) {
      /* ignore */
    }
  }, 20000);
  try {
    const apiKey = await getApiKey();
    if (!isNonEmptyString(apiKey)) {
      await setMasterQuiz({ status: 'error', error: 'Set your Groq API key in Options first.' });
      return;
    }
    const masterNotes = await getMasterNotes();
    const notesMarkdown = (masterNotes && typeof masterNotes.markdown === 'string')
      ? masterNotes.markdown.trim()
      : '';
    if (!notesMarkdown) {
      await setMasterQuiz({ status: 'error', error: 'Generate Master Notes first before creating a quiz.' });
      return;
    }

    await setMasterQuiz({ status: 'generating' });

    const topics = extractKeyTopicsFromNotes(notesMarkdown);
    const topicSection = topics.length > 0
      ? `Key topics identified in the notes (ensure EVERY ONE of these topics is covered by at least one question, plus any other key concepts in the text):\n${topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n`
      : 'Ensure every key topic, concept, algorithm, and definition in the notes below is covered by at least one multiple-choice question.\n\n';

    const minQuestions = Math.min(10, Math.max(5, topics.length));
    const userPrompt = [
      topicSection,
      `Generate a concise multiple-choice quiz (${minQuestions} questions) covering all key topics in the Master Study Notes below.`,
      '',
      '--- MASTER STUDY NOTES ---',
      notesMarkdown,
      '--- END MASTER STUDY NOTES ---'
    ].join('\n');

    const rawResponse = await callGroq(
      apiKey,
      QUIZ_SYSTEM_PROMPT,
      userPrompt,
      QUIZ_MAX_TOKENS,
      { rawJson: true }
    );

    const questions = parseQuizResponse(rawResponse);
    await setMasterQuiz({
      status: 'done',
      questions,
      answers: {},
      generatedAt: Date.now()
    });
  } catch (err) {
    console.error('[KEATS] Master quiz generation failed:', err);
    try {
      await setMasterQuiz({
        status: 'error',
        error: (err && err.message) || String(err)
      });
    } catch (e) {
      console.error('[KEATS] Failed to save quiz error state:', e);
    }
  } finally {
    clearInterval(keepAlive);
    isGeneratingQuiz = false;
  }
}

// ---------------------------------------------------------------------------
// Startup recovery
// ---------------------------------------------------------------------------

async function recoverInterruptedGeneration() {
  try {
    const { masterNotes, masterQuiz } = await chrome.storage.local.get(['masterNotes', 'masterQuiz']);
    // Check the in-memory flag after the read to avoid clobbering a generation started meanwhile.
    if (masterNotes && masterNotes.status === 'generating' && !isGenerating) {
      await setMasterNotes({
        status: 'error',
        error: INTERRUPTED_ERROR,
        videoIds: masterNotes.videoIds
      });
    }
    if (masterQuiz && masterQuiz.status === 'generating' && !isGeneratingQuiz) {
      await setMasterQuiz({
        status: 'error',
        error: INTERRUPTED_ERROR
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
    case 'generateMasterQuiz':
      sendResponse({ ok: true });
      generateMasterQuiz();
      return false;
    case 'answerQuizQuestion':
      return respondAsync(() => handleAnswerQuizQuestion(msg), sendResponse);
    case 'resetMasterQuiz':
      return respondAsync(() => handleResetMasterQuiz(), sendResponse);
    case 'clearMasterQuiz':
      return respondAsync(() => handleClearMasterQuiz(), sendResponse);
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

if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener(onMessageListener);

  if (chrome.tabs && chrome.tabs.onRemoved) {
    chrome.tabs.onRemoved.addListener(onTabRemovedListener);
  }

  if (chrome.runtime.onStartup) {
    chrome.runtime.onStartup.addListener(recoverInterruptedGeneration);
  }

  recoverInterruptedGeneration();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    extractKeyTopicsFromNotes,
    parseQuizResponse
  };
}
