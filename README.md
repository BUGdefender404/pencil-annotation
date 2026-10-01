# Pencil Annotation

Handwrite on SiYuan documents with **Apple Pencil / a stylus**: a GoodNotes-style transparent annotation layer over the whole document, with a pressure-sensitive pen, highlighter, eraser and stroke selection. **Strokes are stored per document in the plugin's private data directory and travel with SiYuan's encrypted sync** — write on the iPad, it appears on your desktop, and survives reinstalls.

> Inspired by [Cherise233/siyuan-document_drawing-plugins](https://github.com/Cherise233/siyuan-document_drawing-plugins) (not published on the marketplace; ships no source code or license). This is a from-scratch TypeScript implementation — no code reused — with two deliberate improvements: sync-safe storage (instead of localStorage) and real stylus pressure.

## Features

- **Pressure pen** — stylus pressure via Pointer Events, including Android pens and Apple Pencil where the device/browser reports it. Mouse drawing is off by default; when enabled it uses fixed width.
- **Highlighter** — translucent, `multiply`-blended so text stays readable through the mark; overlaps between strokes deepen naturally (no dark spots inside a single stroke).
- **Eraser** — stroke-level erase while dragging, adjustable size, with a cursor ring.
- **Select** — tap a stroke to select, then drag to move, duplicate or delete it.
- **Undo / redo** — toolbar buttons (plus `Ctrl+Z` / `Ctrl+Shift+Z` on desktop), up to 100 steps.
- **Writing-first inputs** — the pen draws, fingers only pan (including horizontal tables), and the mouse edits normally unless mouse drawing is enabled. Palm contacts are rejected during ink input. Exit drawing mode before tapping tasks, resizing tables or editing by touch; normal pen/touch interaction is restored on exit.
- **Pen-tip double-tap** — optionally tap the page twice to switch pen ↔ eraser. Off by default to avoid mistaking punctuation for a gesture; existing explicit preferences are preserved. This is not the pen's barrel gesture.
- **Floating toolbar** — draggable handle + palette with position memory. Hide the handle in settings; desktop top-bar/command entry remains available, and mobile users can restore it in plugin settings. The toolbar wraps on narrow screens.
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

Drawing waits for the initial read; failed reads never become empty writable documents. Reconnect or toggle drawing mode to retry. Split views share document state and writes are serialized per document. Failed writes remain in session memory with a warning and up to three automatic retries: **keep the page open until saving succeeds**. A page-hide flush cannot guarantee durability through a killed browser, power loss or offline shutdown. Cross-device merging is not real-time collaboration or deletion-conflict resolution.

## Install (dev build)

1. `npm install && npm run build` → output in `build/`;
2. copy everything from `build/` into `{SiYuan workspace}/data/plugins/pencil-annotation/`, or run:
   ```bash
   node scripts/copy-assets.mjs "/path/to/workspace/data/plugins"
   ```
3. restart SiYuan (or reload from Settings → Marketplace) and enable **Pencil Annotation** under downloaded plugins.

### Docker, Android tablets/phones and browser PWAs

The manifest supports the `docker` backend and both browser frontends. Install the built files in the **container's actual workspace** under `data/plugins/pencil-annotation/`; persist the workspace and ensure it is writable. Drawing runs in the browser, so the container needs neither a stylus nor Node.js at runtime.

Android tablets, pen-capable phones and PWAs use the same input path. Real pressure requires the browser to report `pointerType="pen"`. If the driver exposes a tablet only as a mouse, the browser cannot distinguish it from a real mouse: prefer the driver's pen/pressure mode (Windows Ink on Windows), or enable mouse drawing as a fallback. Include OS/browser versions, pen model and PWA status in device bug reports.

### On the iPad

**Marketplace (recommended)**. The plugin has been submitted to the official SiYuan bazaar ([PR](https://github.com/siyuan-note/bazaar/pulls?q=is%3Apr+BUGdefender404%2Fpencil-annotation)). Once merged, open SiYuan on the iPad → Settings → Marketplace → Plugins, search for **Pencil Annotation** and install; future updates ship through the marketplace too.

**Browser (quick test)**. Open the desktop instance's LAN address (e.g. `http://192.168.x.x:6806`) in iPad Safari — the plugin works in the mobile browser frontend as well.

> The iOS workspace lives inside the app sandbox, so files cannot be copied into `data/plugins` directly like on desktop; apart from the marketplace, mobile-browser access is the lightest way to try it.

## Release process (maintainer)

1. bump `version` in `plugin.json` and update `CHANGELOG.md`;
2. `npm run pack` → `package.zip`;
3. create a GitHub Release with a tag matching the version and attach the zip: `gh release create v0.1.0 package.zip`;
4. first listing: add a line `BUGdefender404/pencil-annotation` to `plugins.txt` in [siyuan-note/bazaar](https://github.com/siyuan-note/bazaar) and open a PR; later versions only need a new Release — the bazaar picks it up automatically.

## Development

```bash
npm install
npm run typecheck
npm run build
npm run deploy -- "/path/to/workspace/data/plugins"
npm run harness     # browser test bench at http://localhost:5199/test/harness.html
npx playwright install chromium webkit
npm test            # both engines; BROWSER=chromium selects one
SIYUAN_KERNEL=/path/to/SiYuan-Kernel npm run test:host  # optional real-host check
npm run pack
```

The harness mocks the SiYuan DOM and its independent Pointer/Touch/Mouse input paths. Checks cover eight-direction short strokes, capture-loss continuation, final endpoints, palm/split-view arbitration, toolbar contact ownership, frame-paced panning, persistence and phone layouts. Chromium also receives browser-protocol pen/touch input. `test:host` overlaps pen and touch on the real mobile frontend and checks endpoints, editor state and persisted ink, using a temporary workspace without opening existing notes.

Browser/mobile-viewport automation is **not physical Android/iPad or installed-PWA certification**. Hardware pressure, OS palm rejection and interruptions still need device checks; WebKit pen injection in the tests uses synthetic events.

## Known limitations (v1 roadmap)

- Coordinates use CSS pixels, not physical screen pixels. Strokes follow their anchor block's translation, not individual characters. Different desktop/tablet/phone layouts, font sizes or wrapping can misalign ink; use native text highlighting for an exact text range.
- No layers, no lasso multi-select, no pixel eraser (planned).
- Undo history is per-session and resets when the document closes (strokes themselves persist).
- Very long documents use a viewport canvas with culling; thousands of strokes may need tile caching for smoother scrolling.

## License

MIT
