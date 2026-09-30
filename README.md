# Pencil Annotation

Handwrite on SiYuan documents with **Apple Pencil / a stylus**: a GoodNotes-style transparent annotation layer over the whole document, with a pressure-sensitive pen, highlighter, eraser and stroke selection. **Strokes are stored per document in the plugin's private data directory and travel with SiYuan's encrypted sync** — write on the iPad, it appears on your desktop, and survives reinstalls.

> Inspired by [Cherise233/siyuan-document_drawing-plugins](https://github.com/Cherise233/siyuan-document_drawing-plugins) (not published on the marketplace; ships no source code or license). This is a from-scratch TypeScript implementation — no code reused — with two deliberate improvements: sync-safe storage (instead of localStorage) and real stylus pressure.

## Features

- **Pressure pen** — real stylus pressure via Pointer Events (Apple Pencil); mouse/touchpad falls back to velocity-based simulated pressure.
- **Highlighter** — translucent, `multiply`-blended so text stays readable through the mark; overlaps between strokes deepen naturally (no dark spots inside a single stroke).
- **Eraser** — stroke-level erase while dragging, adjustable size, with a cursor ring.
- **Select** — tap a stroke to select, then drag to move, duplicate or delete it.
- **Undo / redo** — toolbar buttons (plus `Ctrl+Z` / `Ctrl+Shift+Z` on desktop), up to 100 steps.
- **Palm rejection** — in drawing mode fingers scroll the page and only a stylus can draw (toggleable in settings).
- **Apple Pencil double-tap** — quickly double-tap the page with the pencil to switch pen ↔ eraser (toggleable).
- **Floating toolbar** — draggable handle + palette with position memory; desktop also gets a top-bar button.
- **Export** — composite strokes to PNG (white or transparent background), save to assets, optionally insert into the document.
- **English & Simplified Chinese UI**.

## Storage & multi-device sync

Each document's strokes live in one JSON file:

```
{workspace}/data/storage/petal/pencil-annotation/{docID}.json
```

This is the plugin-private petal directory, which is part of SiYuan's encrypted sync:

- strokes are saved (debounced, 1.2 s) right after each gesture;
- when another device syncs new strokes in, open editors **merge by stroke id** and show a notice;
- concurrent edits on two devices merge as a union by stroke id (local wins for identical ids).

## Install (dev build)

1. `npm install && npm run build` → output in `build/`;
2. copy everything from `build/` into `{SiYuan workspace}/data/plugins/pencil-annotation/`, or run:
   ```bash
   node scripts/copy-assets.mjs "/path/to/workspace/data/plugins"
   ```
3. restart SiYuan (or reload from Settings → Marketplace) and enable **Pencil Annotation** under downloaded plugins.

### On the iPad

Any of these works:

1. **Via SiYuan sync**: install and enable the plugin on desktop first; `data/plugins` then reaches the iPad workspace through data sync.
2. **Browser** (quick test): open the desktop instance's LAN address (e.g. `http://192.168.x.x:6806`) in iPad Safari — the plugin works in the mobile browser frontend too.
3. **Marketplace**: `npm run pack` produces `package.zip`; publish via the official bazaar flow, then install from the marketplace on the iPad directly (rename `plugin.json`'s `name` to your GitHub repo name and fill in `author`/`url` before publishing).

## Development

```bash
npm install
npm run typecheck
npm run build
npm run deploy -- "/path/to/workspace/data/plugins"
npm run harness     # browser test bench at http://localhost:5199/test/harness.html
npm run pack
```

The harness (`test/harness.html`) mocks the SiYuan editor DOM and drives the real input path with synthetic PointerEvents (including pressure), so drawing, highlighter blending, erasing, selection, gestures and export can be verified without launching SiYuan.

## Known limitations (v1 roadmap)

- Strokes are anchored to **document coordinates**: reflowing text (window resize, font-size change) does not move existing strokes — same trade-off as annotating a PDF.
- No layers, no lasso multi-select, no pixel eraser (planned).
- Undo history is per-session and resets when the document closes (strokes themselves persist).
- Very long documents use a viewport canvas with culling; thousands of strokes may need tile caching for smoother scrolling.

## License

MIT
