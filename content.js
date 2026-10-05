/*
 * KEATS Video Summariser — content script.
 *
 * Runs automatically in every frame on KEATS / KCL / Kaltura pages.
 *  - Top frame: if a Kaltura player is present, reports the page title/url
 *    to the background (`pageContextCaptured`).
 *  - Every frame: watches the DOM and video text tracks for Kaltura transcript cues
 *    and reports the transcript to the background (`videoTranscriptCaptured`).
 *  - Responds to manual `scanPage` messages from the popup dashboard.
 *
 * Classic script (no modules). Uses only standard browser APIs so it can
 * be unit-tested with a stub DOM in Node's vm module.
 */
(function () {
  'use strict';

  if (window.__keatsSummariserLoaded) return;
  window.__keatsSummariserLoaded = true;

  var LOG_PREFIX = '[KEATS Summariser]';
  var DEBOUNCE_MS = 1500;
  var INITIAL_CHECK_MS = 1000;
  var INACTIVITY_MS = 10 * 60 * 1000;

  var PLAYER_SELECTORS = [
    'iframe[src*="kaltura"]',
    'iframe[src*="kaf"]',
    '[id^="kaltura_player"]',
    '.kaltura-player-container',
    '.playkit-container',
    '.playkit-player',
    '[class*="playkit"]'
  ];

  var isTopFrame = false;
  try {
    isTopFrame = window === window.top;
  } catch (e) {
    isTopFrame = false;
  }

  console.log(LOG_PREFIX, 'Content script active in ' + (isTopFrame ? '[top page]' : '[frame: ' + (location.href || '') + ']'));

  // ---- State ---------------------------------------------------------------
  var active = false;
  var observer = null;
  var debounceTimer = null;
  var inactivityTimer = null;
  var initialTimer = null;
  var periodicTimer = null;
  var lastSentCount = 0;
  var lastHref = null;
  var cachedFallbackId = null;
  var sentPageTitles = {};
  var attemptedAutoClick = false;

  // ---- Helpers -------------------------------------------------------------
  function collapse(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function djb2Hex(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h + str.charCodeAt(i)) | 0; // h * 33 + c, 32-bit
    }
    return (h >>> 0).toString(16);
  }

  function safeDecode(s) {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return s;
    }
  }

  function getHref() {
    try {
      return String(location.href || '');
    } catch (e) {
      return '';
    }
  }

  function isBenignError(msg) {
    return /Extension context invalidated|Receiving end does not exist|message port closed/i.test(
      String(msg || '')
    );
  }

  function sendMessage(payload, onReply) {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        console.debug(LOG_PREFIX, 'chrome.runtime unavailable');
        return;
      }
      var ret = chrome.runtime.sendMessage(payload, function (reply) {
        var err = chrome.runtime && chrome.runtime.lastError;
        if (err) {
          console.debug(LOG_PREFIX, 'sendMessage error:', err.message || err);
          return;
        }
        if (onReply) {
          try {
            onReply(reply);
          } catch (e) {
            console.debug(LOG_PREFIX, 'reply handler error:', e && e.message);
          }
        }
      });
      if (ret && typeof ret.then === 'function') {
        ret.then(null, function (e) {
          console.debug(LOG_PREFIX, 'sendMessage error:', e && e.message);
        });
      }
    } catch (e) {
      // Typically "Extension context invalidated" after an extension reload.
      console.debug(
        LOG_PREFIX,
        isBenignError(e && e.message) ? 'extension unavailable:' : 'sendMessage threw:',
        e && e.message
      );
    }
  }

  // ---- On-page Toast Notification ("Notes captured!") ----------------------
  var toastTimer = null;
  function showCaptureToast(title, cueCount) {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return;

    var containerId = '__keats_summariser_toast';
    var existing = document.getElementById ? document.getElementById(containerId) : null;
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }

    var toast = document.createElement('div');
    toast.id = containerId;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    toast.style.cssText = [
      'position: fixed',
      'top: 18px',
      'right: 18px',
      'z-index: 2147483647',
      'display: flex',
      'align-items: center',
      'gap: 12px',
      'max-width: 380px',
      'padding: 12px 16px',
      'background: #c41230',
      'color: #ffffff',
      'border: 1px solid #a80f28',
      'border-radius: 6px',
      'box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15)',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      'font-size: 13.5px',
      'line-height: 1.35',
      'box-sizing: border-box',
      'cursor: pointer',
      'opacity: 0',
      'transform: translateY(-8px)',
      'transition: opacity 0.2s ease, transform 0.2s ease',
      'pointer-events: auto'
    ].join('; ');

    var badge = document.createElement('div');
    badge.style.cssText = [
      'flex: none',
      'width: 20px',
      'height: 20px',
      'border-radius: 4px',
      'background: rgba(255, 255, 255, 0.2)',
      'color: #ffffff',
      'display: flex',
      'align-items: center',
      'justify-content: center'
    ].join('; ');
    badge.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';

    var body = document.createElement('div');
    body.style.cssText = 'flex: 1; min-width: 0;';

    var header = document.createElement('div');
    header.style.cssText = 'font-weight: 600; font-size: 14px; letter-spacing: -0.01em; color: #ffffff;';
    header.textContent = 'Notes captured!';

    var sub = document.createElement('div');
    sub.style.cssText = 'font-size: 12px; color: rgba(255, 255, 255, 0.88); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
    var subText = '';
    if (title) subText += title;
    if (cueCount) subText += (subText ? ' · ' : '') + cueCount + ' lines';
    sub.textContent = subText || 'Transcript saved to queue';

    body.appendChild(header);
    body.appendChild(sub);

    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.style.cssText = [
      'background: transparent',
      'border: none',
      'color: rgba(255, 255, 255, 0.75)',
      'font-size: 18px',
      'line-height: 1',
      'cursor: pointer',
      'padding: 2px 4px',
      'margin-left: 4px'
    ].join('; ');
    close.textContent = '×';

    function dismiss() {
      if (!toast.parentNode) return;
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 240);
    }

    close.addEventListener('click', function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      dismiss();
    });
    toast.addEventListener('click', dismiss);

    toast.appendChild(badge);
    toast.appendChild(body);
    toast.appendChild(close);

    var mount = (typeof document.fullscreenElement !== 'undefined' && document.fullscreenElement) ||
      document.body ||
      document.documentElement;

    if (mount && typeof mount.appendChild === 'function') {
      mount.appendChild(toast);
      setTimeout(function () {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
      }, 20);
      toastTimer = setTimeout(dismiss, 3500);
    }
  }

  // Deep query selector that also searches open shadow roots if supported
  function deepQuerySelectorAll(selector, root) {
    root = root || document;
    var results = [];
    try {
      var direct = root.querySelectorAll(selector);
      if (direct && direct.length) {
        for (var i = 0; i < direct.length; i++) results.push(direct[i]);
      }
    } catch (e) {
      /* ignore invalid selector */
    }

    if (typeof document !== 'undefined' && typeof document.createTreeWalker === 'function') {
      try {
        var walker = document.createTreeWalker(root, 1 /* NodeFilter.SHOW_ELEMENT */, null, false);
        var node;
        while ((node = walker.nextNode())) {
          if (node.shadowRoot) {
            var sub = deepQuerySelectorAll(selector, node.shadowRoot);
            for (var j = 0; j < sub.length; j++) results.push(sub[j]);
          }
        }
      } catch (e) {
        /* ignore */
      }
    }
    return results;
  }

  // ---- Page context (top frame) --------------------------------------------
  function hasKalturaPlayer() {
    for (var i = 0; i < PLAYER_SELECTORS.length; i++) {
      try {
        if (document.querySelector(PLAYER_SELECTORS[i])) return true;
      } catch (e) {
        /* ignore bad selector support */
      }
    }
    return false;
  }

  function getPageTitle() {
    var h1 = document.querySelector('h1');
    var h1Text = h1 ? collapse(h1.textContent) : '';
    if (h1Text) return h1Text;
    var t = collapse(document.title);
    // Strip trailing " | KEATS", " - KEATS", " – KEATS", ": KEATS" etc.
    t = t.replace(/\s*[|\-\u2013\u2014:\u00b7]\s*KEATS\s*$/i, '').trim();
    return t;
  }

  function checkPageContext() {
    if (!isTopFrame || !active) return;
    if (!hasKalturaPlayer()) return;
    var pageTitle = getPageTitle();
    if (!pageTitle || sentPageTitles[pageTitle]) return;
    sentPageTitles[pageTitle] = true;
    sendMessage(
      { action: 'pageContextCaptured', pageTitle: pageTitle, url: getHref() },
      function () {
        console.info(LOG_PREFIX, 'page context captured: ' + pageTitle);
      }
    );
  }

  // ---- Transcript capture (every frame) ------------------------------------
  function extractFromTextTracks() {
    try {
      var videos = deepQuerySelectorAll('video');
      for (var i = 0; i < videos.length; i++) {
        var v = videos[i];
        if (!v || !v.textTracks || !v.textTracks.length) continue;
        for (var j = 0; j < v.textTracks.length; j++) {
          var track = v.textTracks[j];
          if (!track) continue;
          if (track.mode === 'disabled') {
            try { track.mode = 'hidden'; } catch (e) {}
          }
          var cues = track.cues;
          if (cues && cues.length > 0) {
            var lines = [];
            var prev = null;
            for (var k = 0; k < cues.length; k++) {
              var cueText = collapse(cues[k] && cues[k].text);
              if (!cueText || cueText === prev) continue;
              lines.push(cueText);
              prev = cueText;
            }
            if (lines.length > 0) {
              return { text: lines.join('\n'), cueCount: lines.length, source: 'textTrack' };
            }
          }
        }
      }
    } catch (e) {
      console.debug(LOG_PREFIX, 'textTrack inspection failed:', e && e.message);
    }
    return null;
  }

  function getTranscriptNodes() {
    // 1. Direct standard playkit transcript cue text
    var nodes = deepQuerySelectorAll('.playkit-transcript-cue-text');
    if (nodes.length > 0) return nodes;

    // 2. Specific transcript cue text selectors
    var specific = [
      '[class*="transcript-cue-text"]',
      '.playkit-cue-text',
      '.transcript-text',
      '[class*="cueText"]',
      '.k-transcript-cue'
    ];
    for (var i = 0; i < specific.length; i++) {
      nodes = deepQuerySelectorAll(specific[i]);
      if (nodes.length > 0) return nodes;
    }

    // 3. Broader transcript cue line / container selectors
    var broader = [
      '[class*="playkit-transcript-cue"]',
      '[class*="transcript-cue"]',
      '[class*="transcript-line"]',
      '[class*="transcriptCue"]',
      '.playkit-transcript-item'
    ];
    for (var j = 0; j < broader.length; j++) {
      nodes = deepQuerySelectorAll(broader[j]);
      if (nodes.length > 0) return nodes;
    }

    return [];
  }

  function tryAutoOpenTranscript() {
    if (attemptedAutoClick) return;
    try {
      var btn = deepQuerySelectorAll(
        'button[aria-label*="transcript" i], button[title*="transcript" i], [class*="transcript-toggle"], [class*="transcript-btn"], .playkit-icon-transcript, button[data-id="transcript"]'
      )[0];
      if (btn && typeof btn.click === 'function') {
        attemptedAutoClick = true;
        console.log(LOG_PREFIX, 'found transcript button in player, opening panel to load cues...');
        btn.click();
      }
    } catch (e) {
      /* ignore */
    }
  }

  function extractTranscript() {
    var nodes = getTranscriptNodes();
    if (nodes.length > 0) {
      var lines = [];
      var prev = null;
      for (var i = 0; i < nodes.length; i++) {
        var line = collapse(nodes[i] && nodes[i].textContent);
        if (!line || line === prev) continue;
        lines.push(line);
        prev = line;
      }
      if (lines.length > 0) {
        return { text: lines.join('\n'), cueCount: lines.length, source: 'dom' };
      }
    }

    // Fallback: check video text tracks
    var trackRes = extractFromTextTracks();
    if (trackRes && trackRes.cueCount > 0) {
      return trackRes;
    }

    // If 0 cues and a transcript button exists, attempt to open it
    tryAutoOpenTranscript();

    return { text: '', cueCount: 0, source: 'none' };
  }

  function getEntryIdFromUrl(href) {
    if (!href) return null;
    try {
      var u = new URL(href);
      var q = u.searchParams.get('entry_id') || u.searchParams.get('entryId');
      if (q) return q;
    } catch (e) {
      /* fall through to regex */
    }
    var m = /\/(?:entry_id|entryId)\/([^\/?#&]+)/.exec(href);
    if (m && m[1]) return safeDecode(m[1]);
    return null;
  }

  function getTranscriptId(text) {
    var entryId = getEntryIdFromUrl(getHref());
    if (entryId) return entryId;
    // Fallback: hash of the transcript text — computed once so later, longer
    // captures of the same transcript update the same record.
    if (!cachedFallbackId) {
      cachedFallbackId = 'hash-' + djb2Hex(String(text || '').slice(0, 5000));
    }
    return cachedFallbackId;
  }

  function getPlayerTitle() {
    var selectors = ['[class*="playkit-title"]', '.playkit-top-bar [class*="title"]'];
    for (var i = 0; i < selectors.length; i++) {
      try {
        var el = document.querySelector(selectors[i]);
        var t = el ? collapse(el.textContent) : '';
        if (t) return t;
      } catch (e) {
        /* ignore */
      }
    }
    var meta = document.querySelector('meta[property="og:title"]');
    var mt = meta ? collapse(meta.getAttribute ? meta.getAttribute('content') : meta.content) : '';
    if (mt) return mt;
    return collapse(document.title);
  }

  function checkTranscript() {
    if (!active) return;
    var href = getHref();
    if (lastHref !== null && href !== lastHref) {
      // Frame navigated to a different video: reset per-video state.
      lastSentCount = 0;
      cachedFallbackId = null;
      attemptedAutoClick = false;
    }
    lastHref = href;

    var t = extractTranscript();
    if (!(t.cueCount > 0 && t.cueCount > lastSentCount)) return;
    lastSentCount = t.cueCount;

    var playerTitle = getPlayerTitle();
    var payload = {
      action: 'videoTranscriptCaptured',
      id: getTranscriptId(t.text),
      playerTitle: playerTitle,
      transcript: t.text,
      cueCount: t.cueCount,
      frameUrl: href
    };
    sendMessage(payload, function (reply) {
      var status = reply && reply.updated ? 'updated' : reply && reply.queued ? 'queued' : 'sent';
      console.log(LOG_PREFIX, 'Captured ' + t.cueCount + ' lines (' + status + ') from: "' + (playerTitle || 'video') + '"');
      if (isTopFrame) {
        showCaptureToast(playerTitle, t.cueCount);
      }
    });
  }

  function runChecks() {
    debounceTimer = null;
    if (!active) return;
    try {
      checkPageContext();
    } catch (e) {
      console.debug(LOG_PREFIX, 'page context check failed:', e && e.message);
    }
    try {
      checkTranscript();
    } catch (e) {
      console.debug(LOG_PREFIX, 'transcript check failed:', e && e.message);
    }
  }

  // ---- Observer lifecycle ---------------------------------------------------
  function resetInactivityTimer() {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(function () {
      inactivityTimer = null;
      console.debug(LOG_PREFIX, 'no DOM activity for 10 minutes; stopping observer');
      disconnectObserver();
    }, INACTIVITY_MS);
  }

  function onMutations() {
    if (!active) return;
    resetInactivityTimer();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runChecks, DEBOUNCE_MS);
  }

  function disconnectObserver() {
    if (observer) {
      try {
        observer.disconnect();
      } catch (e) {
        /* ignore */
      }
      observer = null;
    }
  }

  function start() {
    if (active) return;
    active = true;

    try {
      checkPageContext();
    } catch (e) {
      console.debug(LOG_PREFIX, 'page context check failed:', e && e.message);
    }

    if (typeof MutationObserver !== 'undefined' && document.documentElement) {
      try {
        observer = new MutationObserver(onMutations);
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          characterData: true
        });
      } catch (e) {
        console.debug(LOG_PREFIX, 'could not start observer:', e && e.message);
        observer = null;
      }
    }
    resetInactivityTimer();

    if (initialTimer) clearTimeout(initialTimer);
    initialTimer = setTimeout(function () {
      initialTimer = null;
      runChecks();
    }, INITIAL_CHECK_MS);

    // Also run a couple of periodic checks during the first 6 seconds for delayed media loads
    var count = 0;
    if (periodicTimer) clearInterval(periodicTimer);
    periodicTimer = setInterval(function () {
      count++;
      if (count > 4 || lastSentCount > 0) {
        clearInterval(periodicTimer);
        periodicTimer = null;
        return;
      }
      runChecks();
    }, 1500);
  }

  function stop() {
    active = false;
    disconnectObserver();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (inactivityTimer) clearTimeout(inactivityTimer);
    if (initialTimer) clearTimeout(initialTimer);
    if (periodicTimer) clearInterval(periodicTimer);
    debounceTimer = inactivityTimer = initialTimer = periodicTimer = null;
  }

  function applySettings(settings) {
    var enabled = !(settings && settings.autoCapture === false);
    if (enabled) start();
    else stop();
  }

  // ---- Message listener for manual scans from popup -------------------------
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage && chrome.runtime.onMessage.addListener) {
    try {
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (!msg) return;
        if (msg.action === 'showCaptureToast') {
          if (isTopFrame) {
            showCaptureToast(msg.title, msg.cueCount);
          }
          sendResponse({ ok: true });
          return true;
        }
        if (msg.action === 'scanPage' || msg.action === 'checkStatus') {
          var hasPlayer = hasKalturaPlayer() || deepQuerySelectorAll('video').length > 0;
          if (hasPlayer && extractTranscript().cueCount === 0) {
            tryAutoOpenTranscript();
          }
          var t = extractTranscript();
          var href = getHref();
          var id = t.cueCount > 0 ? getTranscriptId(t.text) : '';
          var title = getPlayerTitle() || (isTopFrame ? getPageTitle() : '');

          if (t.cueCount > 0 && t.cueCount > lastSentCount) {
            lastSentCount = t.cueCount;
            if (isTopFrame) {
              showCaptureToast(title, t.cueCount);
            }
            sendMessage({
              action: 'videoTranscriptCaptured',
              id: id,
              playerTitle: title,
              transcript: t.text,
              cueCount: t.cueCount,
              frameUrl: href
            }, function (reply) {
              console.log(LOG_PREFIX, 'Manual scan captured ' + t.cueCount + ' lines (' + (reply && reply.updated ? 'updated' : 'queued') + ')');
            });
          }

          sendResponse({
            ok: true,
            isTop: isTopFrame,
            hasPlayer: hasPlayer,
            cueCount: t.cueCount,
            title: title,
            url: href
          });
          return true;
        }
      });
    } catch (e) {
      console.debug(LOG_PREFIX, 'onMessage registration failed:', e && e.message);
    }
  }

  // ---- Bootstrap ------------------------------------------------------------
  function init() {
    if (typeof chrome === 'undefined' || !chrome.storage) {
      applySettings(null);
      return;
    }

    try {
      if (chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
        chrome.storage.onChanged.addListener(function (changes, areaName) {
          if (areaName && areaName !== 'local') return;
          if (!changes || !changes.settings) return;
          applySettings(changes.settings.newValue);
        });
      }
    } catch (e) {
      console.debug(LOG_PREFIX, 'could not listen for settings changes:', e && e.message);
    }

    var settled = false;
    function handle(result) {
      if (settled) return;
      settled = true;
      applySettings(result && result.settings);
    }

    try {
      var ret = chrome.storage.local.get('settings', function (result) {
        if (chrome.runtime && chrome.runtime.lastError) {
          console.debug(LOG_PREFIX, 'settings read error:', chrome.runtime.lastError.message);
          handle(null);
          return;
        }
        handle(result);
      });
      if (ret && typeof ret.then === 'function') {
        ret.then(handle, function (e) {
          console.debug(LOG_PREFIX, 'settings read error:', e && e.message);
          handle(null);
        });
      }
    } catch (e) {
      console.debug(LOG_PREFIX, 'settings read threw:', e && e.message);
      handle(null);
    }
  }

  init();
})();
