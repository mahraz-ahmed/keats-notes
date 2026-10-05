# KEATS Video Summariser

A Manifest V3 Chrome extension that **automatically captures Kaltura lecture transcripts** while you browse KEATS, queues them up, and synthesises every queued video into **one master Markdown study guide** using Google Gemini (`gemini-3.8-flash`).

## Setup

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and select this folder.
2. Click the extension icon → ⚙ (or right-click the icon → **Options**) and paste your Google Gemini API key (from [Google AI Studio](https://aistudio.google.com)). Click **Save**.

## Usage

1. Open a KEATS lecture video. **Make sure to refresh the page if it was already open before loading the extension.**
2. **Open the video player's Transcript panel** (or enable captions). The extension captures cues automatically across DOM elements, Shadow DOM, and media text tracks.
3. If a video hasn't captured yet, open the extension popup and click **🔍 Scan Page** for instant capture and diagnostic feedback.
4. Repeat for as many videos as you like. Open the popup to see the queue; remove individual videos with **×**.
5. Click **Generate Master Notes**. You can close the popup — generation continues in the background and the result is saved.
6. Once notes are generated, use **💬 Ask AI About Notes** directly beneath the notes to ask questions, request quiz problems, get flashcards, or clarify complex topics grounded in the master notes.
7. Click **Copy Markdown** to paste the notes into Obsidian, Notion, etc.
8. Use **Clear Notes** to clear generated notes, or **Clear Queue** to empty the queue.

Use the **Auto-capture** toggle in the popup to pause capturing.

## How it works

| File | Role |
|---|---|
| `content.js` | Runs in every frame on KEATS / KCL / Kaltura pages. Watches for `.playkit-transcript-cue-text` and sends `videoTranscriptCaptured` to the background. The top KEATS frame also sends `pageContextCaptured` (page title) so videos get sensible names. |
| `background.js` | Service worker. Maintains the queue in `chrome.storage.local` (serialised writes, de-duplicated by Kaltura `entry_id`), and calls Google Gemini API on `generateMasterNotes`. Very large queues are condensed per-video first (map-reduce). |
| `popup.html/js` | Dashboard: queue list, Generate / Clear buttons, Markdown renderer, Copy button. |
| `options.html/js` | Stores your Gemini API key in `chrome.storage.local`. |

## Security note

Your API key is stored in `chrome.storage.local`. It is isolated from websites and other extensions but **is not encrypted on disk**. Use a key with a usage limit, and don't share your Chrome profile. Transcripts are only sent to Google Gemini when you click **Generate Master Notes**.
