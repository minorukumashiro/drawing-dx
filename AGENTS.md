# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

**図面DXプラットフォーム (Drawing DX Platform)** — a single-page web application for AI-powered technical drawing management, targeting Japanese manufacturing workflows (mechanical parts: flanges, shafts, brackets, etc.).

## Development

There is no build process. The entire application is a single monolithic file:

```
index.html   # ~5,600 lines — all HTML, CSS, and JavaScript in one file
```

To develop: open `index.html` directly in a modern browser. All CDN dependencies are loaded at runtime. No npm, no bundler, no compilation step.

## Architecture

### Single-file monolith

All application code lives in `index.html`:
- `<style>` — custom CSS design system with CSS variables
- `<script>` — all application logic in vanilla JavaScript (no framework)
- Firebase config is embedded inline

### State model

A single global object `S` holds all application state. The render pipeline rebuilds the DOM from `S` on every state change — no virtual DOM, no reactive framework.

### Storage

- **IndexedDB** — primary storage; two stores: `meta` (metadata objects) and `images` (binary blobs)
- **Firebase Firestore** — real-time sync across devices; collection `workspaces/default` for metadata, `workspaces/default/images/*` for per-drawing blobs
- **Sync strategy** — debounced at 1500ms; own changes suppressed for 3s to prevent echo loops. Incoming snapshots are reconciled with a **three-way merge** against the last server state (`fbBase`), not a whole-document overwrite — see the `[MERGE_ENGINE_START]` block. Never reintroduce a full overwrite: it silently reverted other devices' edits. When you add a new synced data array, register it with the merge functions too, or its changes will be dropped.
- **Image compression** — adaptive JPEG compression to stay under Firestore's 1MB document limit

### Views

Shown in the tab bar (`master` and the desktop-only ones are hidden on mobile):

| Tab | Purpose |
|-----|---------|
| `board` | Kanban workflow board (待機 → 検討中 → 見積済 → 製造中 → 完了 → 納品済 → その他) |
| `list` | Grid view with full-text search and AI similarity search |
| `worklog` | 作業日報 — per-worker completion records (加工時間/良品数/不良数). Phone-first; its drawing picker lists 完了 drawings only |
| `delivery` | 納品カレンダー |
| `analytics` | 生産性分析 — ¥/h by drawing and client, plus actuals reconciled from `worklog` (desktop only) |
| `master` | Master data management (categories, materials, clients, etc.) (desktop only) |

Reachable but not in the tab bar — navigated to from a KPI card or the drawing detail screen:

| View | Purpose |
|-----|---------|
| `invoice` | Quote/invoice generation from drawing data |
| `annotate` | PDF/image annotation canvas (pen, text, stamps, QR) |

Note: the old `検図中` status was renamed to `検討中`; a migration rewrites it on load, so don't reintroduce the old label.

### AI features

- **OCR auto-fill** — Tesseract.js extracts fields (図番, 品名, 材質, etc.) from uploaded drawings
- **Similarity search** — drag & drop a drawing to find visually similar ones
- **Master data auto-import** — AI-assisted extraction of master data from documents

### Key external libraries (CDN)

- `pdf.js` v3.11.174 — PDF rendering and multi-page support
- `Tesseract.js` — OCR
- `jsPDF` v2.5.1 — PDF export
- `html5-qrcode` + `api.qrserver.com` — QR code scanning and generation
- Firebase SDK — Firestore real-time sync
- Google Fonts — Noto Sans JP

## Companion tools (outside index.html)

Two independent Node.js tools run on the office PC via Windows Task Scheduler. They write to Firestore with the Admin SDK (`mail-fax-watcher/serviceAccountKey.json`, gitignored — a real secret, never commit or paste it). Each has its own `npm install` and its own README with the details.

| Folder | Task name | What it does |
|--------|-----------|--------------|
| `mail-fax-watcher/` | `DrawingDX-MailFaxWatcher` (30 min) | Registers Outlook attachments and incoming FAXes as `待機` drawings; also runs the daily NAS backup and the health beacon the app reads |
| `estimate-helper/` | `DrawingDX-YayoiAutoImport` (15 min) | Watches the 弥生販売 ledger export folder and upserts rows into the `yayoiRecords` collection, which powers the 「💰 類似実績検索」 button |

`yayoiRecords` is deliberately a separate collection (one doc per row) — never merge that data into `workspaces/default`, which is already approaching the 1MB per-document limit.

## Editing conventions

- The UI language is Japanese throughout — keep all labels, placeholders, and messages in Japanese
- CSS variables are defined near the top of the `<style>` block — use them rather than hardcoded colors or sizes
- Mobile breakpoints: 768px (tablet) and 500px (phone); mobile shows board/list/worklog/delivery, while analytics and master are desktop-only
- Firebase API keys are intentionally embedded in the file (public project); do not treat them as secrets to remove
