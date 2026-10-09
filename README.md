# KEATS Video Summariser

A Manifest V3 Chrome extension built for King's College London students that **automatically captures Kaltura lecture transcripts** while you browse KEATS, queues multiple videos, and synthesises them into **one cohesive Markdown master study guide** powered by **Groq Cloud (`qwen/qwen3.8-27b`)** — complete with an interactive AI tutor to quiz you on your notes.

---

## Features

- **Automatic Multi-Source Transcript Capture**
  - Detects and extracts transcripts across top-level pages, nested Kaltura iframes (`all_frames: true`), open Shadow DOM roots, and HTML5 `<video>` `textTracks`.
  - Automatically clicks the player's transcript toggle button if cues have not been loaded into the DOM yet.
  - Displays an on-page **Notes captured!** toast notification in the top-right corner of the lecture page with the video title and captured line count.
  - Intelligently resolves lecture titles by pairing embedded Kaltura player frames with the parent KEATS page `<h1>` or document title, and deduplicates entries by Kaltura `entry_id` (or a `djb2` transcript hash fallback).
- **Manual Page Scanner & Dynamic Injection**
  - Click **Scan Page** in the popup to immediately inspect the active tab for video players and transcripts with diagnostic feedback.
  - Dynamically injects `content.js` into already-open tabs via `chrome.scripting.executeScript` so you don't have to reload pages after installing or updating the extension.
- **Cross-Video Master Study Guide Synthesis**
  - Synthesises all queued lecture transcripts into a single, topic-grouped Markdown study guide containing:
    - **Title & Overview**
    - **Key Concepts** grouped by topic across lectures with clear definitions
    - **Practice Questions & Actionable Coding Drills** for each concept
  - **Map-Reduce for Large Queues**: Queues up to `300,000` characters are synthesised in a single pass. Larger queues automatically condense each video transcript concurrently (up to 3 in parallel) before synthesising the final master guide.
  - **Resilient Background Streaming**: Streams Server-Sent Events (SSE) from Groq Cloud and keeps the MV3 service worker alive during long generations, allowing you to close the popup while notes generate in the background.
- **Master Notes Quiz (Multiple-Choice Topic Quiz)**
  - Click **Take Quiz** / **Generate Quiz** once master notes are generated to turn your study guide into an interactive multiple-choice quiz covering every key topic in your notes.
  - **Instant Feedback**: Selecting an option immediately tells you whether it is right or wrong along with a brief explanation of why.
  - **Final Score & Topic Breakdown**: Displays your overall score (`X / N` and percentage) at the end of the quiz, with per-topic results and options to **Retry Quiz** or **Generate New Quiz**.
- **Ask AI About Notes (Interactive Q&A Tutor)**
  - Unlocked automatically once master notes are generated.
  - Multi-turn chat grounded directly in your generated study guide, persisted across sessions.
  - One-click quick prompts: **Practice Exam**, **Flashcards**, **Common Pitfalls**, and **Quick Recap**.
  - Individual **Copy** buttons on every AI reply and **Clear Chat** to reset history.
- **Full-Tab Dashboard & Dark Mode**
  - **Dark / Light Theme**: Automatically follows your OS `prefers-color-scheme` setting, with a manual theme toggle in both the popup and Settings page.
  - **Full-Page Desktop Mode**: Click the **Open in new tab** button (`↗`) in the header to expand the popup into a wide-screen (`900px`) reading and study workspace.
  - **One-Click Markdown Export**: Copy raw Markdown to paste directly into Obsidian, Notion, or any Markdown editor, or preview it in-place via the built-in XSS-safe Markdown renderer (supporting tables, fenced code blocks, nested lists, blockquotes, and inline formatting).

---

## Installation & Setup

1. Clone or download this repository to your computer:
   ```bash
   git clone https://github.com/mahraz-ahmed/keats-notes.git
   ```
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** using the toggle in the top-right corner.
4. Click **Load unpacked** and select the `keats-notes` directory.
5. Click the extension icon in your toolbar → click the **Settings** gear icon (`⚙`) (or right-click the extension icon → **Options**).
6. Paste your Groq API key (starts with `gsk_`, available from the [GroqCloud Console](https://console.groq.com/keys)) and click **Save**.

---

## Usage

1. **Open a KEATS Lecture Video**: Navigate to any lecture page on KEATS with an embedded Kaltura video player.
2. **Capture the Transcript**:
   - Open the video player's **Transcript** panel (or enable captions). When `Auto-capture` is enabled, the extension automatically extracts the transcript cues and shows a **Notes captured!** toast on the page.
   - If a video hasn't been captured yet, open the extension popup and click **Scan Page** for immediate capture and status diagnostics.
3. **Build Your Queue**: Repeat across as many lecture videos as you want to combine. Open the popup to view queued videos, line counts, and capture timestamps, or remove individual videos with **×**.
4. **Generate Master Notes**: Click **Generate Master Notes**. You can freely close the popup or switch tabs — generation runs in the background service worker and saves automatically when complete.
5. **Study, Take the Quiz & Ask Follow-Up Questions**:
   - Read the formatted study guide directly in the popup, or click **Open in new tab** (`↗`) for a full-page view.
   - Click **Take Quiz** (or **Generate Quiz** in the **Master Notes Quiz** panel) to test yourself across all key topics with 4-option multiple-choice questions, instant right/wrong explanations, and a final score card.
   - Use the **Ask AI About Notes** panel beneath your notes to click a quick-prompt chip (**Practice Exam**, **Flashcards**, **Common Pitfalls**, **Quick Recap**) or ask custom questions.
6. **Export or Reset**:
   - Click **Copy Markdown** to copy the study guide to your clipboard for Notion, Obsidian, or local `.md` files.
   - Use **Clear Notes** to reset the generated guide, quiz, and chat, or **Clear Queue** to empty the video queue.

---

## Architecture & File Overview

| File | Description |
|---|---|
| `manifest.json` | Manifest V3 configuration. Declares `storage`, `activeTab`, and `scripting` permissions, host permissions for `https://api.groq.com/*`, background service worker, and all-frame content scripts for KEATS (`*.kcl.ac.uk`) and Kaltura (`*.kaltura.com`, `*.kaltura.nordu.net`, `*.cloud.kaltura.com`, `*.kaltura.org`). |
| `content.js` | Runs in every frame on matching KEATS/Kaltura pages. Observes the DOM (including open Shadow DOM roots) and `<video>` text tracks for transcript cues, auto-opens the transcript panel when needed, sends `pageContextCaptured` (top frame) and `videoTranscriptCaptured` (player frame) messages, handles manual `scanPage` requests, and renders the on-page capture toast. |
| `background.js` | MV3 service worker. Serialises queue and storage writes with a promise lock, pairs frame transcripts with top-frame tab context stored in `chrome.storage.session`, deduplicates videos by Kaltura `entry_id`, orchestrates single-pass and map-reduce synthesis via streaming Groq Cloud API calls (`qwen/qwen3.8-27b`), generates topic-complete multiple-choice quizzes (`generateMasterQuiz`), handles multi-turn Q&A requests (`promptMasterNotes`), and recovers interrupted generations on startup. |
| `popup.html` / `popup.js` | Extension popup and responsive full-tab study dashboard. Manages the video queue UI, manual page scanner, theme toggle (Light / Dark / System), zero-dependency XSS-safe Markdown renderer, clipboard export, the interactive **Master Notes Quiz** with instant feedback and final scoring, and the **Ask AI About Notes** chat interface. |
| `options.html` / `options.js` | Settings page for validating (`gsk_…`), masking, saving, and removing your Groq Cloud API key in `chrome.storage.local`, plus theme toggling. |

---

## Privacy & Security

- **Local Storage Only**: Your Groq API key, queued transcripts, generated master notes, and Q&A chat history are stored locally in your browser profile via `chrome.storage.local` (and temporary tab title context in `chrome.storage.session`).
- **No Third-Party Servers**: Transcripts and prompts are sent **only** to `https://api.groq.com/openai/v1/chat/completions` when you explicitly click **Generate Master Notes** or submit a question in **Ask AI About Notes**.
- **API Key Safety**: Because `chrome.storage.local` is isolated to your browser profile but not encrypted on disk, avoid sharing your Chrome profile and consider configuring usage limits on your key in the [GroqCloud Console](https://console.groq.com/keys).
