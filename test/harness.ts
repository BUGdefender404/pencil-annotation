/**
 * Browser test harness: mocks a SiYuan protyle DOM and drives DocOverlay
 * with synthetic PointerEvents (including pressure) to verify drawing,
 * highlighter blending, erasing, selection, gestures and export.
 */
import {DocOverlay, type OverlayConfig, type OverlaySettings, type ProtyleLike} from "../src/overlay/overlay";
import {Palette} from "../src/overlay/toolbar";
import {strokesToPngBlob} from "../src/plugin/exportImage";
import type {PencilPayload} from "../src/engine/types";
import PencilAnnotationPlugin from "../src/index";
import {DEFAULT_SETTINGS, loadSettings} from "../src/plugin/settings";
import {loadPayload, savePayload} from "../src/plugin/api";
import {messages} from "./siyuan";

const ZH: Record<string, string> = {
    toolPen: "钢笔", toolHighlighter: "荧光笔", toolEraser: "橡皮擦", toolSelect: "选择",
    undo: "撤销", redo: "重做", clearAll: "清空", exportImage: "导出", settings: "设置",
    collapse: "收起", strokeDelete: "删除", strokeDuplicate: "复制", strokeDeselect: "完成",
};
const t = (k: string) => ZH[k] || k;

// ---------------------------------------------------------------- DOM mock
const app = document.getElementById("app")!;

const protyleEl = document.createElement("div");
protyleEl.className = "protyle";
Object.assign(protyleEl.style, {
    position: "relative", width: "min(900px, calc(100vw - 16px))", height: "min(620px, calc(100dvh - 32px))",
    margin: "16px auto", background: "#fff",
    boxShadow: "0 2px 12px rgba(0,0,0,.12)", overflow: "hidden",
});

const contentEl = document.createElement("div");
contentEl.className = "protyle-content";
Object.assign(contentEl.style, {
    position: "relative", width: "100%", height: "100%", overflow: "auto",
});

const titleEl = document.createElement("div");
titleEl.className = "protyle-title";
titleEl.textContent = "牛顿运动定律 · 课堂笔记";
Object.assign(titleEl.style, {padding: "24px 60px 12px", fontSize: "22px", fontWeight: "600"});

const wysiwygEl = document.createElement("div");
wysiwygEl.className = "protyle-wysiwyg";
wysiwygEl.setAttribute("contenteditable", "true");
Object.assign(wysiwygEl.style, {
    boxSizing: "border-box", width: "100%", padding: "0 24px 400px",
    minHeight: "1600px", outline: "none", lineHeight: "1.9", fontSize: "15px",
});
const paragraphs = [
    "牛顿第一定律：一切物体总保持匀速直线运动状态或静止状态，直到有外力迫使它改变这种状态为止。",
    "牛顿第二定律：物体的加速度跟所受的合外力成正比，跟物体的质量成反比。F = ma",
    "牛顿第三定律：两个物体之间的作用力和反作用力，总是大小相等、方向相反，作用在同一条直线上。",
    "惯性是物体的固有属性，质量是惯性大小的唯一量度。",
    "（这一段留白用于手写演示——试着在文字旁边圈画出重点）",
];
for (const p of paragraphs) {
    const el = document.createElement("p");
    el.textContent = p;
    el.dataset.nodeId = `block-${wysiwygEl.children.length}`;
    wysiwygEl.appendChild(el);
}

const controls = document.createElement("div");
controls.innerHTML = '<label><input id="todo" type="checkbox"> Task</label><div style="overflow:auto"><table style="width:1200px"><tr><td><button id="table-drag" class="table__resize" draggable="true">Table handle</button></td></tr></table></div>';
controls.contentEditable = "false";
wysiwygEl.prepend(controls);
const nativeEvents = {down: 0, click: 0, move: 0, mouse: 0, touch: 0, bridge: 0};
// Register host-like document capture BEFORE the plugin. SiYuan also bridges
// TouchEvents to legacy mouse handlers; PointerEvent-only tests miss this path.
for (const type of ["mousedown", "mousemove", "mouseup"] as const) {
    document.addEventListener(type, e => {
        if (e.target instanceof Node && contentEl.contains(e.target)) nativeEvents.mouse++;
    }, true);
}
for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"] as const) {
    document.addEventListener(type, e => {
        if (!(e.target instanceof Element) || !contentEl.contains(e.target)) return;
        nativeEvents.touch++;
        if (e.target.closest(".table__resize") && type === "touchstart") {
            nativeEvents.bridge++;
            e.target.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true}));
        }
    }, true);
}
wysiwygEl.addEventListener("pointerdown", () => nativeEvents.down++);
wysiwygEl.addEventListener("pointermove", () => nativeEvents.move++);
wysiwygEl.addEventListener("click", () => nativeEvents.click++);
contentEl.append(titleEl, wysiwygEl);
protyleEl.appendChild(contentEl);
app.appendChild(protyleEl);

const fakeProtyle: ProtyleLike = {
    id: "harness-protyle-1",
    element: protyleEl,
    contentElement: contentEl,
    wysiwyg: {element: wysiwygEl},
    options: {rootId: "20240930161532-harnessdoc"},
    block: {rootID: "20240930161532-harnessdoc"},
};

// -------------------------------------------------------------- overlay deps
const settings: OverlaySettings = {
    ...DEFAULT_SETTINGS,
};
const config: OverlayConfig = {
    tool: "pen",
    penColor: "#1e1e1e",
    penWidth: 4,
    hlColor: "#ffd400",
    hlWidth: 20,
};

const counts = {dirty: 0, stateChanges: 0, doubleTaps: 0, saved: 0 as unknown};

const preset: PencilPayload | null = new URLSearchParams(location.search).get("preset")
    ? ({
        version: 1,
        docId: "20240930161532-harnessdoc",
        updatedAt: Date.now() - 60000,
        strokes: [
            {i: "pre1", t: 1, c: "#4dabf7", w: 20, o: 0.45, s: 0, a: 1,
             p: [80, 130, 0.5, 300, 132, 0.5, 520, 130, 0.5]},
            {i: "pre2", t: 0, c: "#e03131", w: 5, o: 1, s: 0, a: 2,
             p: [90, 200, 0.2, 200, 210, 0.5, 310, 195, 0.8, 420, 205, 0.4]},
        ],
    } as PencilPayload)
    : null;

const overlay = DocOverlay.attach(fakeProtyle, {
    settings,
    config,
    onDirty: () => {
        counts.dirty++;
        log(`onDirty (total ${counts.dirty})`);
    },
    onStateChange: () => {
        counts.stateChanges++;
    },
    onDoubleTapToggle: () => {
        counts.doubleTaps++;
        config.tool = config.tool === "eraser" ? "pen" : "eraser";
        log(`double-tap → tool=${config.tool}`);
    },
    loadPayload: async () => {
        await new Promise(r => setTimeout(r, Number(new URLSearchParams(location.search).get("loadDelay")) || 0));
        return preset;
    },
})!;

// palette (same wiring as the plugin entry)
const palette = new Palette({
    i18n: t,
    config,
    settings,
    onSelectTool: (tool) => {
        config.tool = tool;
        palette.refresh();
        log(`tool=${tool}`);
    },
    onColor: (c) => log(`color=${c}`),
    onWidth: (w) => log(`width=${w}`),
    onAction: (a) => log(`action=${a}`),
    onHandleActivate: () => { overlay.setMode(!overlay.mode); palette.setMode(overlay.mode); },
});
palette.setMode(false);

overlay.setMode(true);
palette.setMode(true);

// ------------------------------------------------------------------ helpers
const logEl = document.getElementById("log")!;
function log(msg: string) {
    const line = document.createElement("div");
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
}

const captureEl = () => wysiwygEl;

let pointerSeq = 100;
function fire(el: HTMLElement, type: string, x: number, y: number, opts: {pointerType?: string; pressure?: number; pointerId?: number; buttons?: number; button?: number} = {}) {
    const ev = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: x,
        clientY: y,
        pointerId: opts.pointerId ?? ++pointerSeq,
        pointerType: opts.pointerType ?? "pen",
        pressure: opts.pressure ?? 0.5,
        isPrimary: true,
        button: opts.button ?? (type === "pointermove" ? -1 : 0),
        buttons: opts.buttons ?? (type === "pointerup" || type === "pointercancel" ? 0 : 1),
    });
    el.dispatchEvent(ev);
}

/** client coords for a doc-space point */
const toClient = (docX: number, docY: number) => {
    const r = wysiwygEl.getBoundingClientRect();
    return {x: r.left + docX, y: r.top + docY};
};

/** Draws a stroke through doc-space points with per-point pressure. */
function stroke(points: Array<[number, number, number?]>, opts: {pointerType?: string} = {}) {
    const el = captureEl();
    const pid = ++pointerSeq;
    points.forEach(([x, y, p], i) => {
        const c = toClient(x, y);
        if (i === 0) {
            fire(el, "pointerdown", c.x, c.y, {pointerType: opts.pointerType ?? "pen", pressure: p ?? 0.4, pointerId: pid});
        } else if (i === points.length - 1) {
            fire(el, "pointerup", c.x, c.y, {pointerType: opts.pointerType ?? "pen", pressure: 0, pointerId: pid});
        } else {
            fire(el, "pointermove", c.x, c.y, {pointerType: opts.pointerType ?? "pen", pressure: p ?? 0.4, pointerId: pid});
        }
    });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ window API
(window as any).harness = {
    DocOverlay,
    nativeEvents,
    contentEl,
    wysiwygEl,
    fakeProtyle,
    createPlugin: () => new PencilAnnotationPlugin({
        app: {} as any, name: "pencil-annotation", displayName: "Pencil Annotation", i18n: {},
    }),
    loadSettings,
    loadPayload,
    savePayload,
    messages,
    overlay,
    palette,
    config,
    settings,
    counts,
    stroke,
    toClient,
    fire,
    captureEl,
    sleep,
    log,
    async exportBlob(bg: "white" | "transparent") {
        const blob = await strokesToPngBlob(overlay.store, bg, overlay.strokeOffsets());
        log(`export blob: ${blob.size} bytes`);
        return blob.size;
    },
    strokesCount() {
        return overlay.store.strokes.length;
    },
    docRect() {
        const r = wysiwygEl.getBoundingClientRect();
        return {left: r.left, top: r.top, width: r.width, height: r.height};
    },
    scrollTopOfContent() {
        return contentEl.scrollTop;
    },
};

log("harness ready — overlay attached, drawing mode ON");
