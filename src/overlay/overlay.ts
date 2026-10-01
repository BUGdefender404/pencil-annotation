import {
    pointHitsStroke,
    segmentHitsStroke,
    unionBBox,
    type BBox,
} from "../engine/geometry";
import {paintOne, paintStrokes, StrokeRenderer, type OffsetFn, type Viewport} from "../engine/renderer";
import {recognizeShape} from "../engine/shapes";
import {DocStore} from "../engine/store";
import type {PencilPayload, Point, Stroke, StrokeAnchor, ToolId} from "../engine/types";

/** Minimal structural view of a SiYuan protyle — keeps the overlay testable. */
export interface ProtyleLike {
    id?: string;
    element: HTMLElement;
    contentElement?: HTMLElement;
    wysiwyg?: { element: HTMLElement };
    options?: { rootId?: string };
    block?: { rootID?: string };
}

export interface OverlaySettings {
    mouseDrawing: boolean;
    doubleTapToggle: boolean;
    shapeSnap: boolean;
    showEraserCursor: boolean;
    eraserRadius: number;
    /** upper bound of the pen width slider (user adjustable in settings) */
    penWidthMax: number;
}

export interface OverlayConfig {
    tool: ToolId;
    penColor: string;
    penWidth: number;
    hlColor: string;
    hlWidth: number;
}

export interface OverlayDeps {
    settings: OverlaySettings;
    config: OverlayConfig;
    /** store mutated (need debounced save) */
    onDirty: () => void;
    /** undo/selection state changed (toolbar refresh) */
    onStateChange: () => void;
    /** pencil double-tap wants a pen<->eraser switch */
    onDoubleTapToggle: () => void;
    loadPayload: (docId: string) => Promise<PencilPayload | null>;
    store?: DocStore;
    onActivate?: () => void;
    onLoadError?: (error: unknown) => void;
}

const SELECT_THRESHOLD = 14;
const DPR_CAP = 3;
const MOUSE_EVENTS = ["mousedown", "mousemove", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "dragstart", "selectstart"] as const;
const TOUCH_EVENTS = ["touchstart", "touchmove", "touchend", "touchcancel"] as const;

export class DocOverlay {
    // One drawing contact per window: split-view listener order must not turn a palm into a pan.
    private static instances = new Set<DocOverlay>();
    private static inputOwner: DocOverlay | null = null;
    readonly root: HTMLDivElement;
    readonly store: DocStore;
    readonly docId: string;
    protyle: ProtyleLike;

    mode = false;
    selected: Stroke[] = [];

    private readonly deps: OverlayDeps;
    private readonly renderer = new StrokeRenderer();
    private inkCanvas!: HTMLCanvasElement;
    private hlCanvas!: HTMLCanvasElement;
    private liveCanvas!: HTMLCanvasElement;
    private destroyed = false;
    private ownedPointers = new Map<number, Node>();
    private ownedTouches = new Map<number, Node>();
    private blockedActivation: Node | null = null;
    private lastInput: "native" | "drawing" | "touch" = "native";
    private nativeMouseId: number | null = null;

    private wysiwygEl: HTMLElement | null = null;
    private contentEl: HTMLElement | null = null;
    private resizeObs: ResizeObserver | null = null;
    private mutationObs: MutationObserver | null = null;
    private observedWysiwyg: HTMLElement | null = null;
    private scrollEl: HTMLElement | null = null;
    private redrawScheduled = false;
    private liveFrame: number | null = null;

    // active pointer state
    private activePointerId: number | null = null;
    private activePointerType: string = "";
    private strokeConfig: OverlayConfig | null = null;
    private drawing = false;
    private erasing = false;
    private curPoints: Point[] = [];
    private curAnchor: StrokeAnchor | null = null;
    private curStart = {x: 0, y: 0, t: 0};
    private curMoved = 0;
    private eraseHitSomething = false;

    // selection drag
    private selDrag: { lastX: number; lastY: number; totalDx: number; totalDy: number } | null = null;

    // Only the owning pointer may change an in-progress stroke.
    private touchPointers = new Set<number>();
    private pan: {
        id: number; x: number; y: number; startX: number; startY: number; time: number;
        dx: number; dy: number; vx: number; vy: number; moved: boolean;
        horizontal: HTMLElement | null; vertical: HTMLElement | null;
    } | null = null;
    private panFrame: number | null = null;
    private inertiaFrame: number | null = null;
    private pendingDotTimer: number | null = null;
    /** dot held during double-tap detection, together with its anchor — finishPointer
     *  clears curAnchor before the delayed commit runs, so it must travel along */
    private pendingDot: {points: Point[]; anchor: StrokeAnchor | null; config: OverlayConfig} | null = null;
    /** stroke id of a dot that already committed while waiting for its double-tap pair */
    private pendingDotCommitted: string | null = null;
    private lastPenTap = {t: 0, x: 0, y: 0};
    /** GoodNotes-style shape snapping: pause mid-stroke and a line/rectangle/
     *  triangle/ellipse straightens itself; moving the pen again reverts to freehand */
    private shapeTimer: number | null = null;
    private shapeSnap: Point[] | null = null;
    private shapeSnapAt: {x: number; y: number} | null = null;
    private lastMoveAt = 0;

    private constructor(protyle: ProtyleLike, deps: OverlayDeps) {
        this.protyle = protyle;
        this.deps = deps;
        this.docId = protyle.options?.rootId || protyle.block?.rootID || "";
        this.store = deps.store ?? new DocStore(this.docId);

        const el = protyle.element;
        if (getComputedStyle(el).position === "static") el.style.position = "relative";

        this.root = document.createElement("div");
        // strokes stay visible in and out of drawing mode — never hide the root
        this.root.className = "pa-overlay";
        this.inkCanvas = document.createElement("canvas");
        this.inkCanvas.className = "pa-canvas";
        this.hlCanvas = document.createElement("canvas");
        this.hlCanvas.className = "pa-canvas pa-canvas--multiply";
        this.liveCanvas = document.createElement("canvas");
        this.liveCanvas.className = "pa-canvas";
        this.root.append(this.inkCanvas, this.hlCanvas, this.liveCanvas);
        el.appendChild(this.root);

        DocOverlay.instances.add(this);
        this.bindEvents();
        this.updateGeometry();
        void this.load();
    }

    static attach(protyle: ProtyleLike, deps: OverlayDeps): DocOverlay | null {
        const docId = protyle.options?.rootId || protyle.block?.rootID;
        if (!docId) return null;
        return new DocOverlay(protyle, deps);
    }

    // ------------------------------------------------------------------ setup

    private resolveRefs() {
        const wysiwyg = this.protyle.wysiwyg?.element;
        this.wysiwygEl = wysiwyg && this.protyle.element.contains(wysiwyg)
            ? wysiwyg : this.protyle.element.querySelector<HTMLElement>(".protyle-wysiwyg");
        const previousContent = this.contentEl;
        const content = this.protyle.contentElement;
        this.contentEl = content && this.protyle.element.contains(content)
            ? content : this.wysiwygEl?.parentElement ?? null;
        if (previousContent !== this.contentEl) previousContent?.classList.remove("pa-writing");
        this.syncContentWatchers();
    }

    /** keep the resize/mutation observers pointed at the live wysiwyg element —
     *  SiYuan may replace the node when it re-renders the document */
    private syncContentWatchers() {
        const w = this.wysiwygEl;
        if (!w || this.observedWysiwyg === w) return;
        const previous = this.observedWysiwyg;
        this.observedWysiwyg = w;
        try {
            if (previous) this.resizeObs?.unobserve(previous);
            this.resizeObs?.observe(w);
            if (!this.mutationObs) {
                this.mutationObs = new MutationObserver(() => {
                    this.updateGeometry();
                    this.scheduleRedraw();
                });
                this.mutationObs.observe(this.protyle.element, {childList: true, subtree: true});
            }
        } catch { /* element detached mid-observation */ }
    }

    private bindEvents() {
        // SiYuan has document-level Touch→Mouse bridges. Intercept before those
        // handlers, not just PointerEvents bubbling through the editor.
        window.addEventListener("pointerdown", this.onPointerDown, true);
        window.addEventListener("pointermove", this.onPointerMove, true);
        window.addEventListener("pointerup", this.onPointerUp, true);
        window.addEventListener("pointercancel", this.onPointerCancel, true);
        for (const type of MOUSE_EVENTS) window.addEventListener(type, this.onMouse, true);
        for (const type of TOUCH_EVENTS) window.addEventListener(type, this.onTouch, {capture: true, passive: false});
        window.addEventListener("keydown", this.onNativeKey, true);
        window.addEventListener("keyup", this.onNativeKey, true);
        window.addEventListener("blur", this.onBlur);
        document.addEventListener("visibilitychange", this.onVisible);
    }

    refreshInputPolicy() {
        // This must be installed BEFORE contact, including nested table scrollers.
        // Changing touch-action on pointerdown cannot stop browser gesture takeover.
        this.contentEl?.classList.toggle("pa-writing", this.mode);
    }

    private inContent(target: EventTarget | null): boolean {
        return target instanceof Node && !!this.contentEl?.contains(target) && !this.root.contains(target);
    }

    private consume(e: Event) {
        if (e.cancelable) e.preventDefault();
        e.stopImmediatePropagation();
    }

    private activationScope(target: EventTarget | null): Node {
        if (this.inContent(target)) return this.protyle.element;
        return target instanceof Element ? target.closest(".pa-toolbar, .pa-handle") ?? target : this.protyle.element;
    }

    private onTouch = (e: TouchEvent) => {
        const touches = Array.from(e.changedTouches);
        const owner = [...DocOverlay.instances].find(o => touches.some(t => o.ownedTouches.has(t.identifier))) ?? DocOverlay.inputOwner;
        if (owner && owner !== this) { owner.onTouch(e); return; }
        const palm = this.mode && DocOverlay.inputOwner === this;
        const scope = touches.map(t => this.ownedTouches.get(t.identifier)).find(Boolean);
        if (!scope && !(this.mode && (this.inContent(e.target) || palm))) return;
        this.blockedActivation = scope ?? this.activationScope(e.target);
        this.lastInput = "touch";
        if (e.type === "touchstart") {
            for (const t of touches) this.ownedTouches.set(t.identifier, this.blockedActivation);
        }
        this.consume(e);
        if (e.type === "touchend" || e.type === "touchcancel") {
            for (const t of touches) this.ownedTouches.delete(t.identifier);
        }
    };

    private onMouse = (event: Event) => {
        const e = event as MouseEvent;
        const target = e.target as Node | null;
        const inEditor = target instanceof Node && this.protyle.element.contains(target);
        const blockedTarget = target instanceof Node && this.blockedActivation &&
            (this.blockedActivation.contains(target) || target.contains(this.blockedActivation));
        if (!inEditor && !blockedTarget) return;
        const pointerType = (e as PointerEvent).pointerType;
        const fromTouch = (e as MouseEvent & {sourceCapabilities?: {firesTouchEvents?: boolean}}).sourceCapabilities?.firesTouchEvents;
        if (this.mode && this.inContent(e.target) && (pointerType === "pen" || pointerType === "touch" || fromTouch)) {
            this.consume(e);
            return;
        }
        // A genuine mouse/keyboard contact resets lastInput before its legacy
        // events. Pen/touch-generated MouseEvents (including SiYuan's synthetic
        // bridge and detail=0 clicks) must not activate tables, tasks or selection.
        // Typed mouse activation keeps its own gesture provenance even if pen
        // movement occurred between mouse-down and mouse-up/click.
        if (pointerType === "mouse" && (e as PointerEvent).pointerId === this.nativeMouseId) return;
        if (this.lastInput !== "native") this.consume(e);
    };

    private markNativePointer(e: PointerEvent) {
        this.lastInput = "native";
        this.blockedActivation = null;
        if (e.pointerType === "mouse") this.nativeMouseId = e.pointerId;
    }

    private onNativeKey = () => { this.lastInput = "native"; };

    private onBlur = () => {
        this.finalizeInput();
        this.ownedPointers.clear();
        this.ownedTouches.clear();
    };

    refreshProtyle(protyle: ProtyleLike) {
        this.protyle = protyle;
        this.updateGeometry();
        this.scheduleRedraw();
    }

    private watchScroll() {
        if (!this.resizeObs) {
            this.resizeObs = new ResizeObserver(() => {
                this.updateGeometry();
                this.scheduleRedraw();
            });
            this.resizeObs.observe(this.root);
        }
        if (this.scrollEl !== this.contentEl) {
            if (this.scrollEl) {
                this.scrollEl.removeEventListener("scroll", this.scheduleRedraw);
                this.resizeObs.unobserve(this.scrollEl);
            }
            this.scrollEl = this.contentEl;
            this.scrollEl?.addEventListener("scroll", this.scheduleRedraw, {passive: true});
            if (this.scrollEl) this.resizeObs.observe(this.scrollEl);
        }
        if (this.wysiwygEl) this.resizeObs.observe(this.wysiwygEl);
    }

    // ------------------------------------------------------------- geometry

    private viewport(): Viewport {
        const rootRect = this.root.getBoundingClientRect();
        const wysiwygRect = (this.wysiwygEl ?? this.root).getBoundingClientRect();
        return {
            originX: rootRect.left - wysiwygRect.left,
            originY: rootRect.top - wysiwygRect.top,
            width: rootRect.width,
            height: rootRect.height,
        };
    }

    /** doc-space clip rect of the visible content area (excludes breadcrumb etc.) */
    private contentClip(vp: Viewport): BBox | null {
        const area = this.contentEl ?? this.wysiwygEl;
        if (!area) return null;
        const rootRect = this.root.getBoundingClientRect();
        const areaRect = area.getBoundingClientRect();
        return {
            minX: vp.originX + (areaRect.left - rootRect.left),
            minY: vp.originY + (areaRect.top - rootRect.top),
            maxX: vp.originX + (areaRect.right - rootRect.left),
            maxY: vp.originY + (areaRect.bottom - rootRect.top),
        };
    }

    private updateGeometry() {
        this.resolveRefs();
        this.watchScroll();
        const rootRect = this.root.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
        for (const canvas of [this.inkCanvas, this.hlCanvas, this.liveCanvas]) {
            const w = Math.max(1, Math.round(rootRect.width * dpr));
            const h = Math.max(1, Math.round(rootRect.height * dpr));
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }
        }
        this.refreshInputPolicy();
    }

    private prepareCtx(ctx: CanvasRenderingContext2D, vp: Viewport, clip: BBox | null, clear = true) {
        ctx.save();
        const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (clear) ctx.clearRect(0, 0, vp.width, vp.height);
        if (clip) {
            ctx.beginPath();
            ctx.rect(clip.minX - vp.originX, clip.minY - vp.originY,
                clip.maxX - clip.minX, clip.maxY - clip.minY);
            ctx.clip();
        }
    }

    // ------------------------------------------------------- block anchoring

    /** document-space origin of a block element */
    private blockOrigin(el: HTMLElement): {x: number; y: number} | null {
        const w = this.wysiwygEl;
        if (!w) return null;
        const wr = w.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return {x: r.left - wr.left, y: r.top - wr.top};
    }

    /** find the deepest text block under a screen point, for stroke anchoring */
    private captureAnchor(clientX: number, clientY: number): StrokeAnchor | null {
        const w = this.wysiwygEl;
        if (!w || typeof document.elementsFromPoint !== "function") return null;
        for (const el of document.elementsFromPoint(clientX, clientY)) {
            const id = (el as HTMLElement).dataset?.nodeId;
            if (id && el !== w && w.contains(el)) {
                const o = this.blockOrigin(el as HTMLElement);
                if (o) return {blockId: id, ox: Math.round(o.x * 100) / 100, oy: Math.round(o.y * 100) / 100};
            }
        }
        return null;
    }

    private blockOffsetCache = new Map<string, {dx: number; dy: number}>();

    /**
     * Per-stroke render offset: how far the stroke's anchor block has moved
     * since the stroke was drawn. Strokes without an anchor never move.
     */
    private buildOffsets(): OffsetFn {
        this.blockOffsetCache.clear();
        const w = this.wysiwygEl;
        const zero = {dx: 0, dy: 0};
        if (!w) return () => zero;
        const wr = w.getBoundingClientRect();
        return (s: Stroke) => {
            if (!s.anchor) return zero;
            let d = this.blockOffsetCache.get(s.anchor.blockId);
            if (!d) {
                d = {dx: 0, dy: 0};
                const el = w.querySelector<HTMLElement>(`[data-node-id="${s.anchor.blockId}"]`);
                if (el) {
                    const r = el.getBoundingClientRect();
                    d = {
                        dx: Math.round((r.left - wr.left - s.anchor.ox) * 100) / 100,
                        dy: Math.round((r.top - wr.top - s.anchor.oy) * 100) / 100,
                    };
                }
                this.blockOffsetCache.set(s.anchor.blockId, d);
            }
            return d;
        };
    }

    /** public accessor for export and other consumers */
    strokeOffsets(): OffsetFn {
        return this.buildOffsets();
    }

    // -------------------------------------------------------------- painting

    /** repaint once the window becomes visible again (canvas may have been
     *  cleared by a resize that happened while rAF was frozen) */
    private onVisible = () => {
        if (document.visibilityState === "visible") this.scheduleRedraw();
    };

    private scheduleRedraw = () => {
        if (this.redrawScheduled || this.destroyed) return;
        this.redrawScheduled = true;
        let done = false;
        const run = () => {
            if (done) return;
            done = true;
            this.redrawScheduled = false;
            if (!this.destroyed) this.redrawAll();
        };
        requestAnimationFrame(run);
        // rAF never fires while the window is hidden/occluded (SiYuan keeps
        // running in the tray); the timeout guarantees the repaint happens
        window.setTimeout(run, 150);
    };

    redrawAll() {
        const vp = this.viewport();
        const clip = this.contentClip(vp);
        const offsets = this.buildOffsets();
        const inkCtx = this.inkCanvas.getContext("2d");
        const hlCtx = this.hlCanvas.getContext("2d");
        if (inkCtx) {
            this.prepareCtx(inkCtx, vp, clip);
            paintStrokes(inkCtx, this.store.strokes, this.renderer, vp,
                (s) => s.tool !== "pen", offsets);
            inkCtx.restore();
        }
        if (hlCtx) {
            this.prepareCtx(hlCtx, vp, clip);
            paintStrokes(hlCtx, this.store.strokes, this.renderer, vp,
                (s) => s.tool !== "highlighter", offsets);
            hlCtx.restore();
        }
        this.redrawLive(offsets);
    }

    private scheduleLive() {
        if (this.liveFrame !== null) return;
        this.liveFrame = requestAnimationFrame(() => {
            this.liveFrame = null;
            if (!this.destroyed) this.redrawLive();
        });
    }

    /** live layer: current stroke / eraser cursor / selection box */
    private redrawLive(offsets?: OffsetFn) {
        const offsetsFn = offsets || this.buildOffsets();
        const vp = this.viewport();
        const clip = this.contentClip(vp);
        const ctx = this.liveCanvas.getContext("2d");
        if (!ctx) return;
        this.prepareCtx(ctx, vp, clip);

        if (this.drawing && this.curPoints.length > 0) {
            const config = this.strokeConfig ?? this.deps.config;
            const tool = config.tool as "pen" | "highlighter";
            const cfg = tool === "pen"
                ? {color: config.penColor, width: config.penWidth, opacity: 1}
                : {color: config.hlColor, width: config.hlWidth, opacity: 0.45};
            paintOne(ctx, {
                id: "live", tool, color: cfg.color, width: cfg.width,
                opacity: cfg.opacity, simulate: this.activePointerType !== "pen",
                points: this.shapeSnap ?? this.curPoints, createdAt: 0,
                ...(this.curAnchor ? {anchor: this.curAnchor} : {}),
            }, this.renderer, vp, this.liveOffset());
        } else if (this.erasing && this.deps.settings.showEraserCursor && this.curPoints.length > 0) {
            const last = this.curPoints[this.curPoints.length - 1];
            ctx.save();
            ctx.translate(-vp.originX, -vp.originY);
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = "rgba(120,120,130,0.9)";
            ctx.fillStyle = "rgba(255,255,255,0.25)";
            ctx.beginPath();
            ctx.arc(last.x, last.y, this.deps.settings.eraserRadius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        } else if (this.selected.length > 0) {
            const boxes = this.selected.map((s) => {
                const b = this.renderer.getPath(s).bbox;
                const o = offsetsFn(s);
                return {minX: b.minX + o.dx, minY: b.minY + o.dy, maxX: b.maxX + o.dx, maxY: b.maxY + o.dy};
            });
            const box = unionBBox(boxes);
            if (box) {
                ctx.save();
                ctx.translate(-vp.originX, -vp.originY);
                ctx.setLineDash([6, 4]);
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = "#6366f1";
                ctx.strokeRect(box.minX - 4, box.minY - 4, box.maxX - box.minX + 8, box.maxY - box.minY + 8);
                ctx.restore();
            }
        }
        ctx.restore();
    }

    /** incremental commit: paints the new stroke WITHOUT clearing the layer */
    private paintCommitted(stroke: Stroke) {
        const vp = this.viewport();
        const clip = this.contentClip(vp);
        const target = stroke.tool === "pen" ? this.inkCanvas : this.hlCanvas;
        const ctx = target.getContext("2d");
        if (!ctx) return;
        this.prepareCtx(ctx, vp, clip, false);
        const offsets = this.buildOffsets();
        paintOne(ctx, stroke, this.renderer, vp, offsets(stroke), false);
        ctx.restore();
    }

    // ------------------------------------------------------------ data load

    private async load() {
        try {
            if (!this.store.loaded) {
                this.store.loading ??= this.deps.loadPayload(this.docId).then(payload => {
                    if (payload) this.store.adoptPayload(payload);
                    this.store.loaded = true;
                }).finally(() => { this.store.loading = null; });
                await this.store.loading;
            }
            if (this.destroyed) return;
            if (this.anchorLegacyStrokes()) this.changed();
            this.scheduleRedraw();
            this.deps.onStateChange();
        } catch (e) {
            if (!this.destroyed) this.deps.onLoadError?.(e);
            console.error("[pencil-annotation] load failed", e);
        }
    }

    /** merge strokes coming from another device via sync */
    applyRemote(payload: PencilPayload): boolean {
        if (!this.store.loaded || (payload.docId && payload.docId !== this.docId)) return false;
        const changed = this.store.mergeRemote(payload);
        if (changed) {
            this.anchorLegacyStrokes();
            this.scheduleRedraw();
        }
        return changed;
    }

    /**
     * Strokes drawn before block anchoring existed have no anchor and would sit
     * still through reflow. Anchor each of them to the block under its first
     * point (offset is captured at the current position, so nothing moves now —
     * the stroke just starts following that block from here on).
     * @returns true if any stroke gained an anchor
     */
    private anchorLegacyStrokes(): boolean {
        const w = this.wysiwygEl;
        if (!w) return false;
        const blocks = [...w.querySelectorAll<HTMLElement>("[data-node-id]")];
        if (blocks.length === 0) return false;
        const wr = w.getBoundingClientRect();
        let any = false;
        for (const s of this.store.strokes) {
            if (s.anchor) continue;
            const p0 = s.points[0];
            if (!p0) continue;
            const sx = wr.left + p0.x;
            const sy = wr.top + p0.y;
            let hit: HTMLElement | null = null;
            for (const el of blocks) {
                const r = el.getBoundingClientRect();
                const pad = hit ? 0 : 24; // exact containment first, then a small margin
                if (sx >= r.left - pad && sx <= r.right + pad && sy >= r.top - pad && sy <= r.bottom + pad) {
                    hit = el; // pre-order: later matches are deeper blocks
                }
            }
            if (hit) {
                const o = this.blockOrigin(hit);
                if (o) {
                    s.anchor = {
                        blockId: hit.dataset.nodeId!,
                        ox: Math.round(o.x * 100) / 100,
                        oy: Math.round(o.y * 100) / 100,
                    };
                    any = true;
                }
            }
        }
        if (any) this.store.dirty = true; // so the retro-anchored payload gets saved
        return any;
    }

    // ---------------------------------------------------------------- mode

    setMode(on: boolean) {
        if (!on) this.finalizeInput();
        this.mode = on;
        this.refreshInputPolicy();
        if (on) {
            if (!this.store.loaded && !this.store.loading) void this.load();
            this.updateGeometry();
            this.scheduleRedraw();
        } else {
            this.deselect();
        }
    }

    destroy() {
        this.finalizeInput();
        this.destroyed = true;
        DocOverlay.instances.delete(this);
        this.contentEl?.classList.remove("pa-writing");
        window.removeEventListener("pointerdown", this.onPointerDown, true);
        window.removeEventListener("pointermove", this.onPointerMove, true);
        window.removeEventListener("pointerup", this.onPointerUp, true);
        window.removeEventListener("pointercancel", this.onPointerCancel, true);
        for (const type of MOUSE_EVENTS) window.removeEventListener(type, this.onMouse, true);
        for (const type of TOUCH_EVENTS) window.removeEventListener(type, this.onTouch, true);
        window.removeEventListener("keydown", this.onNativeKey, true);
        window.removeEventListener("keyup", this.onNativeKey, true);
        window.removeEventListener("blur", this.onBlur);
        document.removeEventListener("visibilitychange", this.onVisible);
        this.mutationObs?.disconnect();
        this.mutationObs = null;
        this.resizeObs?.disconnect();
        this.resizeObs = null;
        if (this.scrollEl) {
            this.scrollEl.removeEventListener("scroll", this.scheduleRedraw);
            this.scrollEl = null;
        }
        this.root.remove();
    }

    // ----------------------------------------------------------- store ops

    private changed() {
        this.deps.onDirty();
        this.deps.onStateChange();
    }

    undo() {
        this.finalizeInput();
        if (this.store.undo()) {
            this.deselect();
            this.scheduleRedraw();
            this.changed();
        }
    }

    redo() {
        this.finalizeInput();
        if (this.store.redo()) {
            this.deselect();
            this.scheduleRedraw();
            this.changed();
        }
    }

    clearAll() {
        this.finalizeInput();
        const removed = this.store.clearAll();
        if (removed.length > 0) {
            this.deselect();
            this.scheduleRedraw();
            this.changed();
        }
        return removed.length > 0;
    }

    deleteSelection() {
        if (this.selected.length === 0) return;
        const ids = new Set(this.selected.map((s) => s.id));
        this.store.eraseWhere((s) => ids.has(s.id));
        this.deselect();
        this.scheduleRedraw();
        this.changed();
    }

    duplicateSelection() {
        if (this.selected.length === 0) return;
        for (const s of [...this.selected]) {
            const copy = this.store.duplicateStroke(s);
            if (copy) this.selected.push(copy);
        }
        this.scheduleRedraw();
        this.changed();
    }

    deselect() {
        if (this.selected.length === 0) return;
        this.selected = [];
        this.scheduleRedraw();
        this.deps.onStateChange();
    }

    // -------------------------------------------------------- pointer input

    private toDoc(e: PointerEvent): Point {
        const wysiwygRect = (this.wysiwygEl ?? this.root).getBoundingClientRect();
        return {x: e.clientX - wysiwygRect.left, y: e.clientY - wysiwygRect.top, p: 0.5};
    }

    private onPointerDown = (e: PointerEvent) => {
        const owner = DocOverlay.inputOwner;
        if (e.pointerType === "touch" && owner && owner !== this) { owner.onPointerDown(e); return; }
        const palm = this.mode && owner === this && e.pointerType === "touch";
        if (!this.inContent(e.target) && !palm) {
            if (this.activePointerId === e.pointerId) this.finalizeInput();
            this.ownedPointers.delete(e.pointerId);
            this.markNativePointer(e);
            return;
        }
        if (!this.mode) {
            this.markNativePointer(e);
            this.ownedPointers.delete(e.pointerId);
            return;
        }
        if (e.pointerType === "mouse" && (!this.deps.settings.mouseDrawing || e.button !== 0)) {
            if (this.activePointerId === e.pointerId) this.finalizeInput();
            this.markNativePointer(e);
            this.ownedPointers.delete(e.pointerId);
            return;
        }
        if (e.pointerType === "mouse") this.nativeMouseId = null;
        this.consume(e);
        this.blockedActivation = this.activationScope(e.target);
        this.ownedPointers.set(e.pointerId, this.blockedActivation);
        this.lastInput = e.pointerType === "touch" ? "touch" : "drawing";
        if (e.pointerType === "touch") {
            this.touchPointers.add(e.pointerId);
            if (this.touchPointers.size > 1) this.stopPan();
            if (this.activePointerId === null && this.touchPointers.size === 1 && !palm) this.startPan(e);
            return;
        }
        if (e.pointerType !== "pen" && e.pointerType !== "mouse") return;
        // Barrel-button changes may arrive with the tip still down. Only a
        // physical tip/eraser contact starts ink; every pen stream stays isolated.
        if (e.pointerType === "pen" ? !(e.buttons & 33) && e.button !== 0 && e.button !== 5 : e.button !== 0) return;
        if (!this.store.loaded) return;
        if (this.activePointerId !== null) {
            if (e.pointerType !== this.activePointerType || (e.button !== 0 && e.button !== 5)) return;
            // A fresh physical down recovers from an up lost outside the window.
            // Capture loss itself never ends a stroke.
            this.finalizeInput();
        }
        if (owner && owner !== this) owner.finalizeInput();
        for (const overlay of DocOverlay.instances) overlay.stopPan();
        this.deps.onActivate?.();
        const pt = this.toDoc(e);
        this.activePointerId = e.pointerId;
        this.activePointerType = e.pointerType;
        DocOverlay.inputOwner = this;
        this.strokeConfig = {...this.deps.config};
        if (e.pointerType === "pen" && (e.buttons & 32)) this.strokeConfig.tool = "eraser";
        try {
            this.protyle.element.setPointerCapture(e.pointerId);
        } catch { /* window capture listeners still receive the entire contact */ }

        this.curStart = {x: pt.x, y: pt.y, t: Date.now()};
        this.curMoved = 0;
        this.eraseHitSomething = false;

        const pressure = e.pointerType === "pen" ? Math.max(0.04, e.pressure || 0.25) : 0.5;
        pt.p = pressure;

        const tool = this.strokeConfig.tool;
        if (tool === "eraser") {
            this.erasing = true;
            this.curPoints = [pt];
            this.eraseSegment(pt.x, pt.y, pt.x, pt.y);
        } else if (tool === "select") {
            this.curAnchor = null;
            const offsets = this.buildOffsets();
            const hit = this.store.strokes.find((s) => {
                const o = offsets(s);
                return pointHitsStroke(s, pt.x - o.dx, pt.y - o.dy, SELECT_THRESHOLD);
            });
            this.selected = hit ? [hit] : [];
            if (hit) {
                this.selDrag = {lastX: pt.x, lastY: pt.y, totalDx: 0, totalDy: 0};
            }
            this.redrawLive();
            this.deps.onStateChange();
        } else {
            this.drawing = true;
            this.curAnchor = this.captureAnchor(e.clientX, e.clientY);
            this.curPoints = [pt];
            this.lastMoveAt = Date.now();
            this.clearShapeSnap();
            this.liveCanvas.style.mixBlendMode =
                tool === "highlighter" ? "multiply" : "normal";
            this.redrawLive();
        }
    };

    private onPointerMove = (e: PointerEvent) => {
        if (!this.ownedPointers.has(e.pointerId)) {
            if (e.pointerType === "mouse") this.markNativePointer(e);
            return;
        }
        this.consume(e);
        this.lastInput = e.pointerType === "touch" ? "touch" : "drawing";
        this.blockedActivation = this.ownedPointers.get(e.pointerId)!;
        if (this.pan?.id === e.pointerId) { this.movePan(e); return; }
        if (e.pointerId !== this.activePointerId) return;
        // Capture loss alone is not an up event. A zero-button, zero-pressure
        // hover is, however, evidence the physical contact ended while unfocused.
        if (e.buttons === 0 && e.pressure === 0) {
            this.ownedPointers.delete(e.pointerId);
            this.finalizeInput();
            return;
        }
        this.sampleInput(e);
    };

    private sampleInput(e: PointerEvent, final = false) {
        if (!this.drawing && !this.erasing && !this.selDrag) return;
        const pt = this.toDoc(e);
        let events: PointerEvent[] = [];
        try { events = e.getCoalescedEvents?.() ?? []; } catch { /* use the dispatched sample */ }
        const samples = [...events, e];
        const rect = (this.wysiwygEl ?? this.root).getBoundingClientRect();

        if (this.drawing) {
            if (this.shapeSnap && this.shapeSnapAt) {
                // pen moved again after the snap → revert to freehand drawing
                if (Math.hypot(pt.x - this.shapeSnapAt.x, pt.y - this.shapeSnapAt.y) > 6) {
                    this.shapeSnap = null;
                    this.shapeSnapAt = null;
                } else {
                    return; // stay snapped while the pen rests
                }
            }
            for (const ev of samples) {
                const last = this.curPoints[this.curPoints.length - 1];
                const pressure = final && ev.pressure === 0 ? last.p : Math.max(0.04, Math.min(1, ev.pressure || 0.25));
                const p = {x: ev.clientX - rect.left, y: ev.clientY - rect.top,
                    p: this.activePointerType === "pen" ? pressure : 0.5};
                if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
                // Keep short turns and pressure changes; only exact duplicates add no information.
                if (p.x === last.x && p.y === last.y && p.p === last.p) continue;
                this.curMoved = Math.max(this.curMoved, Math.hypot(p.x - this.curStart.x, p.y - this.curStart.y));
                this.curPoints.push(p);
            }
            this.lastMoveAt = Date.now();
            if (!final && this.deps.settings.shapeSnap) this.scheduleShapeCheck();
            if (!final) this.scheduleLive();
        } else if (this.erasing) {
            let first = this.curPoints[this.curPoints.length - 1];
            for (const ev of samples) {
                const p = {x: ev.clientX - rect.left, y: ev.clientY - rect.top, p: 0.5};
                this.eraseSegment(first.x, first.y, p.x, p.y);
                this.curPoints.push(p);
                first = p;
            }
            if (!final) this.scheduleLive();
        } else if (this.selDrag) {
            const dx = pt.x - this.selDrag.lastX;
            const dy = pt.y - this.selDrag.lastY;
            this.selDrag.lastX = pt.x;
            this.selDrag.lastY = pt.y;
            this.selDrag.totalDx += dx;
            this.selDrag.totalDy += dy;
            this.store.moveStrokesTransient(this.selected, dx, dy);
            this.scheduleRedraw();
            this.redrawLive();
        }
    }

    private onPointerUp = (e: PointerEvent) => {
        this.touchPointers.delete(e.pointerId);
        const scope = this.ownedPointers.get(e.pointerId);
        if (!scope) {
            if (e.pointerType === "mouse") this.markNativePointer(e);
            return;
        }
        this.ownedPointers.delete(e.pointerId);
        this.blockedActivation = scope;
        this.consume(e);
        this.lastInput = e.pointerType === "touch" ? "touch" : "drawing";
        if (this.pan?.id === e.pointerId) { this.endPan(e); return; }
        if (e.pointerId !== this.activePointerId) return;
        this.sampleInput(e, true);
        const pt = this.toDoc(e);

        if (this.drawing) {
            this.finishStroke(pt);
        } else if (this.erasing) {
            this.curPoints = [];
            this.redrawLive();
            if (this.eraseHitSomething) this.changed();
        } else if (this.selDrag) {
            this.store.commitMove(this.selected, this.selDrag.totalDx, this.selDrag.totalDy);
            this.reanchorStrokes(this.selected);
            this.selDrag = null;
            this.changed();
        }
        this.finishPointer();
    };

    private onPointerCancel = (e: PointerEvent) => {
        this.touchPointers.delete(e.pointerId);
        const scope = this.ownedPointers.get(e.pointerId);
        if (!scope) return;
        this.ownedPointers.delete(e.pointerId);
        this.blockedActivation = scope;
        this.lastInput = e.pointerType === "touch" ? "touch" : "drawing";
        this.consume(e);
        if (this.pan?.id === e.pointerId) this.stopPan();
        if (e.pointerId === this.activePointerId) this.finalizeInput();
    };

    private finishPointer() {
        if (this.liveFrame !== null) cancelAnimationFrame(this.liveFrame);
        this.liveFrame = null;
        const id = this.activePointerId;
        this.activePointerId = null;
        if (DocOverlay.inputOwner === this) DocOverlay.inputOwner = null;
        if (id !== null && this.protyle.element.hasPointerCapture(id)) this.protyle.element.releasePointerCapture(id);
        this.activePointerType = "";
        this.strokeConfig = null;
        this.drawing = false;
        this.erasing = false;
        this.selDrag = null;
        this.curPoints = [];
        this.curAnchor = null;
        this.clearShapeSnap();
        this.redrawLive();
    }

    // -------------------------------------------------------------- finger pan

    private startPan(e: PointerEvent) {
        this.stopPan();
        let horizontal: HTMLElement | null = null, vertical: HTMLElement | null = null;
        for (let el = e.target instanceof Element ? e.target : null; el; el = el.parentElement) {
            if (el instanceof HTMLElement) {
                const style = getComputedStyle(el);
                if (!horizontal && /auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth) horizontal = el;
                if (!vertical && /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight) vertical = el;
            }
            if (el === this.contentEl) break;
        }
        this.pan = {id: e.pointerId, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY,
            time: e.timeStamp, dx: 0, dy: 0, vx: 0, vy: 0, moved: false, horizontal, vertical};
    }

    private movePan(e: PointerEvent) {
        const pan = this.pan;
        if (!pan) return;
        if (!pan.moved && Math.hypot(e.clientX - pan.startX, e.clientY - pan.startY) < 8) return;
        pan.moved = true;
        const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
        const dt = Math.max(1, e.timeStamp - pan.time);
        const blend = 1 - Math.exp(-dt / 24);
        const cap = (v: number) => Math.max(-3, Math.min(3, v));
        pan.vx += blend * (cap(dx / dt) - pan.vx);
        pan.vy += blend * (cap(dy / dt) - pan.vy);
        pan.dx += dx; pan.dy += dy;
        pan.x = e.clientX; pan.y = e.clientY; pan.time = e.timeStamp;
        if (this.panFrame === null) this.panFrame = requestAnimationFrame(() => {
            this.panFrame = null;
            this.flushPan();
        });
    }

    private flushPan() {
        if (!this.pan) return;
        const {horizontal, vertical, dx, dy} = this.pan;
        this.pan.dx = 0; this.pan.dy = 0;
        if (horizontal && dx) horizontal.scrollLeft -= dx;
        if (vertical && dy) vertical.scrollTop -= dy;
        // Move the ink in the SAME frame as the scroller, not one scroll event later.
        if (dx || dy) this.redrawAll();
    }

    private endPan(e: PointerEvent) {
        const pan = this.pan;
        if (!pan) return;
        const idle = e.timeStamp - pan.time;
        if (e.clientX !== pan.x || e.clientY !== pan.y) this.movePan(e);
        this.flushPan();
        this.stopPan();
        if (!pan.moved || idle > 80) return;
        let vx = pan.vx, vy = pan.vy, last = performance.now();
        const step = (now: number) => {
            this.inertiaFrame = null;
            // Resume from a suspended tab must not jump by seconds of velocity.
            const elapsed = now - last;
            if (elapsed > 80 || !this.mode || this.destroyed) return;
            const dt = Math.max(0, Math.min(32, elapsed));
            last = now;
            const x = pan.horizontal?.scrollLeft, y = pan.vertical?.scrollTop;
            if (pan.horizontal) pan.horizontal.scrollLeft -= vx * dt;
            if (pan.vertical) pan.vertical.scrollTop -= vy * dt;
            if (!pan.horizontal || pan.horizontal.scrollLeft === x) vx = 0;
            if (!pan.vertical || pan.vertical.scrollTop === y) vy = 0;
            vx *= Math.exp(-dt / 180); vy *= Math.exp(-dt / 180);
            this.redrawAll();
            if (Math.hypot(vx, vy) > 0.03) this.inertiaFrame = requestAnimationFrame(step);
        };
        this.inertiaFrame = requestAnimationFrame(step);
    }

    private stopPan() {
        // Do not apply queued palm motion when a pen starts writing.
        this.pan = null;
        if (this.panFrame !== null) cancelAnimationFrame(this.panFrame);
        if (this.inertiaFrame !== null) cancelAnimationFrame(this.inertiaFrame);
        this.panFrame = this.inertiaFrame = null;
    }

    // ---------------------------------------------------------- shape snapping

    private clearShapeSnap() {
        if (this.shapeTimer !== null) {
            window.clearTimeout(this.shapeTimer);
            this.shapeTimer = null;
        }
        this.shapeSnap = null;
        this.shapeSnapAt = null;
    }

    private scheduleShapeCheck() {
        if (this.shapeTimer !== null) window.clearTimeout(this.shapeTimer);
        this.shapeTimer = window.setTimeout(() => {
            this.shapeTimer = null;
            this.tryShapeSnap();
        }, 520);
    }

    /** fired after the pen rests briefly mid-stroke: perfect the shape */
    private tryShapeSnap() {
        if (!this.deps.settings.shapeSnap || !this.drawing || this.shapeSnap || this.erasing || this.selDrag) return;
        if (Date.now() - this.lastMoveAt < 460) {
            this.scheduleShapeCheck(); // still moving, re-arm
            return;
        }
        const tool = (this.strokeConfig ?? this.deps.config).tool;
        if (tool !== "pen" && tool !== "highlighter") return;
        const snapped = recognizeShape(this.curPoints);
        if (snapped) {
            this.shapeSnap = snapped;
            const lp = this.curPoints[this.curPoints.length - 1];
            this.shapeSnapAt = {x: lp.x, y: lp.y};
            this.redrawLive();
        }
    }

    /** Commit sampled ink and already-applied edits before navigation, hiding or interruption. */
    finalizeInput() {
        this.stopPan();
        this.flushPendingDot();
        if (this.drawing && this.curPoints.length) this.commitStroke(this.shapeSnap ?? this.curPoints);
        if (this.erasing && this.eraseHitSomething) this.changed();
        if (this.selDrag) {
            this.store.commitMove(this.selected, this.selDrag.totalDx, this.selDrag.totalDy);
            this.reanchorStrokes(this.selected);
            this.changed();
        }
        this.finishPointer();
        this.touchPointers.clear();
        this.lastPenTap = {t: 0, x: 0, y: 0};
        this.pendingDotCommitted = null;
    }

    private flushPendingDot() {
        if (this.pendingDotTimer !== null) window.clearTimeout(this.pendingDotTimer);
        this.pendingDotTimer = null;
        const dot = this.pendingDot;
        this.pendingDot = null;
        if (dot) {
            const stroke = this.commitStroke(dot.points, dot.anchor, dot.config, false);
            this.pendingDotCommitted = stroke?.id ?? null;
        }
    }

    /** after a drag, re-anchor moved strokes to the block under their new position */
    private reanchorStrokes(strokes: Stroke[]) {
        const w = this.wysiwygEl;
        if (!w || strokes.length === 0) return;
        const wr = w.getBoundingClientRect();
        for (const s of strokes) {
            const p0 = s.points[0];
            if (!p0) continue;
            const anchor = this.captureAnchor(wr.left + p0.x, wr.top + p0.y);
            if (anchor) s.anchor = anchor;
        }
    }

    private finishStroke(pt: Point) {
        const isDot = this.curPoints.length < 3 && this.curMoved < 5;
        const points = this.shapeSnap ?? this.curPoints;

        if (isDot && this.activePointerType === "pen" && this.deps.settings.doubleTapToggle) {
            const sinceLast = Date.now() - this.lastPenTap.t;
            const nearLast = Math.hypot(pt.x - this.lastPenTap.x, pt.y - this.lastPenTap.y) < 28;
            if (sinceLast < 420 && nearLast) {
                // second tap of a pencil double-tap → tool toggle, no dots left behind
                if (this.pendingDotTimer !== null) {
                    window.clearTimeout(this.pendingDotTimer);
                    this.pendingDotTimer = null;
                    this.pendingDot = null;
                } else if (this.pendingDotCommitted) {
                    // the first dot already committed (tap landed in the 300-420ms
                    // gap) — remove it so the pair leaves no trace
                    const dotId = this.pendingDotCommitted;
                    this.store.eraseWhere((s) => s.id === dotId);
                    this.renderer.forget(dotId);
                    this.scheduleRedraw();
                    this.changed();
                    this.pendingDotCommitted = null;
                }
                this.lastPenTap = {t: 0, x: 0, y: 0};
                this.redrawLive();
                this.deps.onDoubleTapToggle();
                return;
            }
            // hold the dot briefly in case a double-tap follows
            this.flushPendingDot();
            this.pendingDotCommitted = null;
            this.pendingDot = {points, anchor: this.curAnchor, config: {...(this.strokeConfig ?? this.deps.config)}};
            this.pendingDotTimer = window.setTimeout(() => this.flushPendingDot(), 300);
            this.lastPenTap = {t: Date.now(), x: pt.x, y: pt.y};
            this.redrawLive();
            return;
        }

        this.flushPendingDot();
        this.lastPenTap = {t: 0, x: 0, y: 0};
        this.pendingDotCommitted = null;
        this.commitStroke(points);
    }

    /** current anchor delta for the in-progress stroke */
    private liveOffset(): {dx: number; dy: number} {
        if (!this.curAnchor) return {dx: 0, dy: 0};
        const w = this.wysiwygEl;
        if (!w) return {dx: 0, dy: 0};
        const el = w.querySelector<HTMLElement>(`[data-node-id="${this.curAnchor.blockId}"]`);
        if (!el) return {dx: 0, dy: 0};
        const wr = w.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return {
            dx: Math.round((r.left - wr.left - this.curAnchor.ox) * 100) / 100,
            dy: Math.round((r.top - wr.top - this.curAnchor.oy) * 100) / 100,
        };
    }

    private commitStroke(points: Point[], anchor?: StrokeAnchor | null, cfg = this.strokeConfig ?? this.deps.config,
        simulate = this.activePointerType !== "pen"): Stroke | null {
        if (points.length === 0 || !this.store.loaded) return null;
        const tool = cfg.tool as "pen" | "highlighter";
        const stroke = tool === "pen"
            ? {color: cfg.penColor, width: cfg.penWidth, opacity: 1}
            : {color: cfg.hlColor, width: cfg.hlWidth, opacity: 0.45};
        const committed = this.store.addStroke(tool, {...stroke, simulate}, points);
        const a = anchor !== undefined ? anchor : this.curAnchor;
        if (a) committed.anchor = a;
        this.paintCommitted(committed);
        this.changed();
        return committed;
    }

    private eraseSegment(x1: number, y1: number, x2: number, y2: number) {
        const r = this.deps.settings.eraserRadius;
        const offsets = this.buildOffsets();
        const removed = this.store.eraseWhere((s) => {
            const o = offsets(s);
            // shift the test segment into the stroke's creation-space
            return segmentHitsStroke(s, x1 - o.dx, y1 - o.dy, x2 - o.dx, y2 - o.dy, r);
        });
        if (removed.length > 0) {
            this.eraseHitSomething = true;
            for (const s of removed) this.renderer.forget(s.id);
            this.scheduleRedraw();
        }
    }
}
