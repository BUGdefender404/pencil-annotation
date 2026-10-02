import {
    pointHitsStroke,
    segmentHitsStroke,
    smoothDense,
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
    onlyStylus: boolean;
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
}

const SELECT_THRESHOLD = 14;
const DPR_CAP = 3;

export class DocOverlay {
    readonly root: HTMLDivElement;
    readonly store: DocStore;
    readonly docId: string;
    readonly protyle: ProtyleLike;

    mode = false;
    selected: Stroke[] = [];

    private readonly deps: OverlayDeps;
    private readonly renderer = new StrokeRenderer();
    private inkCanvas!: HTMLCanvasElement;
    private hlCanvas!: HTMLCanvasElement;
    private liveCanvas!: HTMLCanvasElement;
    private capture!: HTMLDivElement;

    private wysiwygEl: HTMLElement | null = null;
    private contentEl: HTMLElement | null = null;
    private resizeObs: ResizeObserver | null = null;
    private mutationObs: MutationObserver | null = null;
    private observedWysiwyg: HTMLElement | null = null;
    private scrollEl: HTMLElement | null = null;
    private redrawScheduled = false;

    // active pointer state
    private activePointerId: number | null = null;
    private activePointerType: string = "";
    private drawing = false;
    private erasing = false;
    private curPoints: Point[] = [];
    private curAnchor: StrokeAnchor | null = null;
    private curStart = {x: 0, y: 0, t: 0};
    private curMoved = 0;
    private eraseHitSomething = false;

    // selection drag
    private selDrag: { lastX: number; lastY: number; totalDx: number; totalDy: number } | null = null;

    // gestures: track active touch pointers for palm rejection only
    private touchPointers = new Set<number>();
    /** finger panning of the document (GoodNotes-style: pen writes, finger pans) —
     *  the capture layer lives outside .protyle-content, so native touch-action
     *  scrolling can never reach the real scroller and we translate it by hand */
    private pan: {id: number; lastX: number; lastY: number; vy: number; lastT: number} | null = null;
    private panMomentum: number | null = null;
    /** last pen tap of a possible double-tap pair (id lets us erase its dot) */
    private lastPenTap = {t: 0, x: 0, y: 0, id: null as string | null};
    /** GoodNotes-style shape snapping: pause mid-stroke and a line/rectangle/
     *  triangle/ellipse straightens itself; moving the pen again reverts to freehand */
    private shapeTimer: number | null = null;
    private shapeSnap: Point[] | null = null;
    private shapeSnapAt: {x: number; y: number} | null = null;
    private lastMoveAt = 0;
    /** recent input samples (≈last 350ms) — lets the rest check measure the
     *  pen's current speed instead of trusting timestamp gaps alone */
    private trail: Array<{t: number; x: number; y: number}> = [];
    /**
     * Post-lift snap: a finished stroke that looks like a closed shape waits
     * briefly before committing — pausing after the lift perfects it, while
     * starting a new stroke within the window commits the raw one (so normal
     * handwriting never snaps). Nothing is painted on the ink layer until
     * either happens; the live layer keeps showing the raw stroke.
     */
    private pendingSnap: {
        timer: number;
        points: Point[];
        snapped: Point[];
        anchor: StrokeAnchor | null;
        tool: "pen" | "highlighter";
        color: string;
        width: number;
        opacity: number;
        simulate: boolean;
    } | null = null;
    /**
     * Strokes committed raw because the next stroke started within the
     * post-lift window. When the user finally pauses, these are perfected
     * retroactively — so casually drawing a run of boxes still ends with
     * every one of them a right-angle rectangle.
     */
    private rawSnapIds = new Set<string>();
    private retroSnapTimer: number | null = null;

    private constructor(protyle: ProtyleLike, deps: OverlayDeps) {
        this.protyle = protyle;
        this.deps = deps;
        this.docId = protyle.options?.rootId || protyle.block?.rootID || "";
        this.store = new DocStore(this.docId);

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
        this.capture = document.createElement("div");
        this.capture.className = "pa-capture";
        this.root.append(this.inkCanvas, this.hlCanvas, this.liveCanvas, this.capture);
        el.appendChild(this.root);

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
        this.wysiwygEl =
            this.protyle.wysiwyg?.element ||
            this.protyle.element.querySelector<HTMLElement>(".protyle-wysiwyg");
        this.contentEl =
            this.protyle.contentElement ||
            this.wysiwygEl?.parentElement ||
            null;
        this.syncContentWatchers();
    }

    /** keep the resize/mutation observers pointed at the live wysiwyg element —
     *  SiYuan may replace the node when it re-renders the document */
    private syncContentWatchers() {
        const w = this.wysiwygEl;
        if (!w || this.observedWysiwyg === w) return;
        this.observedWysiwyg = w;
        try {
            this.resizeObs?.observe(w);
            if (!this.mutationObs) {
                this.mutationObs = new MutationObserver(this.scheduleRedraw);
            }
            this.mutationObs.disconnect();
            this.mutationObs.observe(w, {childList: true, subtree: true});
        } catch { /* element detached mid-observation */ }
    }

    private bindEvents() {
        this.capture.addEventListener("pointerdown", this.onPointerDown);
        this.capture.addEventListener("pointermove", this.onPointerMove);
        this.capture.addEventListener("pointerup", this.onPointerUp);
        this.capture.addEventListener("pointercancel", this.onPointerCancel);
        this.capture.addEventListener("contextmenu", (e) => {
            if (this.mode) e.preventDefault();
        });
        document.addEventListener("visibilitychange", this.onVisible);
    }

    private watchScroll() {
        this.resolveRefs();
        if (this.scrollEl || !this.contentEl) return;
        this.scrollEl = this.contentEl;
        this.scrollEl.addEventListener("scroll", this.scheduleRedraw, {passive: true});
        this.resizeObs = new ResizeObserver(() => {
            this.updateGeometry();
            this.scheduleRedraw();
        });
        this.resizeObs.observe(this.root);
        if (this.contentEl) this.resizeObs.observe(this.contentEl);
        // wysiwyg observation (size + DOM mutations) is kept in sync with the
        // live element by syncContentWatchers(), called from resolveRefs()
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
        // capture layer sits over the scrollable content area only, so the
        // doc title bar and breadcrumb stay clickable while in drawing mode
        const area = this.contentEl ?? this.wysiwygEl;
        if (area) {
            const areaRect = area.getBoundingClientRect();
            Object.assign(this.capture.style, {
                left: `${Math.max(0, areaRect.left - rootRect.left)}px`,
                top: `${Math.max(0, areaRect.top - rootRect.top)}px`,
                width: `${Math.min(areaRect.width, rootRect.width)}px`,
                height: `${Math.min(areaRect.height, rootRect.height)}px`,
            });
        }
    }

    /** contexts holding a clip pushed by prepareCtx — clip() intersects with
     *  the existing region, so each call must pop the previous clip first */
    private clippedCtxs = new WeakSet<CanvasRenderingContext2D>();

    private prepareCtx(ctx: CanvasRenderingContext2D, vp: Viewport, clip: BBox | null, clear = true) {
        const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
        if (this.clippedCtxs.has(ctx)) {
            ctx.restore();
            this.clippedCtxs.delete(ctx);
        }
        ctx.save();
        this.clippedCtxs.add(ctx);
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

    private blockOriginById(blockId: string): {x: number; y: number} | null {
        const w = this.wysiwygEl;
        if (!w) return null;
        const el = w.querySelector<HTMLElement>(`[data-node-id="${blockId}"]`);
        return el ? this.blockOrigin(el) : null;
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
    /** last origin seen for each anchor block — fallback while SiYuan re-renders it */
    private lastKnownOrigin = new Map<string, {x: number; y: number}>();

    /**
     * Per-stroke render offset: the current origin of the stroke's anchor
     * block. Anchored strokes store block-relative points, so painting at
     * points + origin keeps them glued to the block on every device and
     * through any layout change. Strokes without an anchor never move.
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
                const el = w.querySelector<HTMLElement>(`[data-node-id="${s.anchor.blockId}"]`);
                if (el) {
                    const r = el.getBoundingClientRect();
                    d = {
                        dx: Math.round((r.left - wr.left) * 100) / 100,
                        dy: Math.round((r.top - wr.top) * 100) / 100,
                    };
                    this.lastKnownOrigin.set(s.anchor.blockId, {x: d.dx, y: d.dy});
                } else {
                    // block missing from the DOM right now (re-render in
                    // progress) — keep the stroke at its last known spot
                    const known = this.lastKnownOrigin.get(s.anchor.blockId);
                    d = known ? {dx: known.x, dy: known.y} : zero;
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
        if (this.redrawScheduled) return;
        this.redrawScheduled = true;
        let done = false;
        const run = () => {
            if (done) return;
            done = true;
            this.redrawScheduled = false;
            this.redrawAll();
        };
        requestAnimationFrame(run);
        // rAF never fires while the window is hidden/occluded (SiYuan keeps
        // running in the tray); the timeout guarantees the repaint happens
        window.setTimeout(run, 150);
    };

    private liveScheduled = false;
    private liveForced = false;
    /** coalesces per-event live-layer repaints into one per animation frame —
     *  high-rate styli otherwise trigger dozens of full repaints per second */
    private requestLive() {
        if (this.liveScheduled) return;
        this.liveScheduled = true;
        this.liveForced = false;
        const run = () => {
            if (this.liveForced) return;
            this.liveForced = true;
            this.liveScheduled = false;
            this.redrawLive();
        };
        requestAnimationFrame(run);
        // rAF never fires while the window is hidden/occluded (SiYuan keeps
        // running in the tray) — the timeout guarantees the live layer, and
        // with it the in-progress stroke, still shows up
        window.setTimeout(run, 150);
    }

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
        }
        if (hlCtx) {
            this.prepareCtx(hlCtx, vp, clip);
            paintStrokes(hlCtx, this.store.strokes, this.renderer, vp,
                (s) => s.tool !== "highlighter", offsets);
        }
        this.redrawLive(offsets);
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
            const tool = this.deps.config.tool as "pen" | "highlighter";
            const cfg = tool === "pen"
                ? {color: this.deps.config.penColor, width: this.deps.config.penWidth, opacity: 1}
                : {color: this.deps.config.hlColor, width: this.deps.config.hlWidth, opacity: 0.45};
            paintOne(ctx, {
                id: "live", tool, color: cfg.color, width: cfg.width,
                opacity: cfg.opacity, simulate: this.activePointerType !== "pen",
                points: this.shapeSnap ?? this.curPoints, createdAt: 0,
                ...(this.curAnchor ? {anchor: this.curAnchor} : {}),
            }, this.renderer, vp, this.liveOffset());
        } else if (this.pendingSnap) {
            // a finished stroke waiting out the post-lift snap window: keep
            // showing it on the live layer until it commits (raw or snapped)
            const pd = this.pendingSnap;
            paintOne(ctx, {
                id: "pending", tool: pd.tool, color: pd.color, width: pd.width,
                opacity: pd.opacity, simulate: pd.simulate, points: pd.points, createdAt: 0,
                ...(pd.anchor ? {anchor: pd.anchor} : {}),
            }, this.renderer, vp, this.liveOffsetFor(pd.anchor));
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
        // live=false: a committed stroke gets the final end cap and is cached,
        // matching what a full redraw renders
        paintOne(ctx, stroke, this.renderer, vp, offsets(stroke), false);
    }

    // ------------------------------------------------------------ data load

    private async load() {
        try {
            const payload = await this.deps.loadPayload(this.docId);
            if (payload && Array.isArray(payload.strokes)) {
                this.store.adoptPayload(payload);
                if (this.anchorLegacyStrokes()) this.changed();
                this.scheduleRedraw();
                // the protyle may still be rendering blocks when this first
                // paint lands; repaint a couple more times as the layout settles
                window.setTimeout(() => this.scheduleRedraw(), 250);
                window.setTimeout(() => this.scheduleRedraw(), 900);
                this.deps.onStateChange();
            }
        } catch (e) {
            console.error("[pencil-annotation] load failed", e);
        }
    }

    /** merge strokes coming from another device via sync */
    applyRemote(payload: PencilPayload): boolean {
        if (payload.docId && payload.docId !== this.docId) return false;
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
                    s.anchor = {blockId: hit.dataset.nodeId!, ox: 0, oy: 0};
                    // rebase the points to block-relative space
                    for (const p of s.points) {
                        p.x -= o.x;
                        p.y -= o.y;
                    }
                    this.renderer.forget(s.id);
                    any = true;
                }
            }
        }
        if (any) this.store.dirty = true; // so the retro-anchored payload gets saved
        return any;
    }

    // ---------------------------------------------------------------- mode

    setMode(on: boolean) {
        this.mode = on;
        this.capture.classList.toggle("pa-capture--active", on);
        if (on) {
            this.updateGeometry();
            this.scheduleRedraw();
        } else {
            this.cancelActiveInput();
            this.deselect();
        }
    }

    destroy() {
        if (this.retroSnapTimer !== null) {
            window.clearTimeout(this.retroSnapTimer);
            this.retroSnapTimer = null;
        }
        this.cancelPendingSnap(true);
        this.cancelActiveInput();
        this.stopPan();
        this.clearShapeSnap();
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
        if (this.store.undo()) {
            this.deselect();
            this.scheduleRedraw();
            this.changed();
        }
    }

    redo() {
        if (this.store.redo()) {
            this.deselect();
            this.scheduleRedraw();
            this.changed();
        }
    }

    clearAll() {
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
        if (!this.mode) return;
        e.stopPropagation();
        // A pen contact while the overlay still believes the previous contact
        // is down means that contact's pointerup was lost — iOS can eat it
        // (Pencil hover ghost events, Scribble, palm rejection). There is
        // only one pencil, so the held state is stale: finish the dead
        // stroke (its ink is kept) and take over. Without this, every
        // pen-down was silently dropped until the user lifted the pencil and
        // let the same-id pointerup reset the state.
        if (e.pointerType !== "touch" && this.activePointerId !== null) {
            if (this.drawing) {
                const last = this.curPoints[this.curPoints.length - 1];
                if (last) this.finishStroke(last);
            }
            this.finishPointer();
        }
        // a new stroke during the post-lift snap window keeps the raw one
        this.cancelPendingSnap(true);

        const pt = this.toDoc(e);

        if (e.pointerType === "touch") {
            this.touchPointers.add(e.pointerId);
            const penWasDrawing = this.activePointerId !== null;
            // palm landing while the pen is mid-stroke: ignore it completely —
            // cancelling here used to eat the stroke being written
            if (penWasDrawing) return;
            if (this.deps.settings.onlyStylus || this.touchPointers.size >= 2) {
                if (this.touchPointers.size >= 2) this.stopPan(); // second finger kills the pan
                this.cancelActiveInput();
                // GoodNotes-style: with onlyStylus a lone finger pans the page
                if (this.deps.settings.onlyStylus && this.touchPointers.size === 1 && !this.pan) {
                    this.startPan(e);
                }
                return;
            }
        } else if (this.activePointerId !== null) {
            return; // already drawing with another pointer
        }

        // pen or mouse (or touch with onlyStylus off) takes over from a finger pan
        if (e.pointerType !== "touch") {
            this.stopPan();
            e.preventDefault();
        }
        this.activePointerId = e.pointerId;
        this.activePointerType = e.pointerType;
        try {
            this.capture.setPointerCapture(e.pointerId);
        } catch { /* iOS may refuse; events still arrive */ }

        this.curStart = {x: pt.x, y: pt.y, t: Date.now()};
        this.curMoved = 0;
        this.trail = [];
        this.eraseHitSomething = false;

        const pressure = e.pointerType === "pen" ? Math.max(0.04, e.pressure || 0.25) : 0.5;
        pt.p = pressure;

        const tool = this.deps.config.tool;
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
        if (e.pointerType === "touch" && !this.touchPointers.has(e.pointerId)) return;
        if (this.pan && this.movePan(e)) return;
        if (e.pointerId !== this.activePointerId) return;
        if (!this.drawing && !this.erasing && !this.selDrag) return;

        const pt = this.toDoc(e);
        e.preventDefault();
        const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
        const samples = events.length > 0 ? events : [e];

        if (this.drawing) {
            if (this.shapeSnap && this.shapeSnapAt) {
                // pen moved again after the snap → revert to freehand drawing
                if (Math.hypot(pt.x - this.shapeSnapAt.x, pt.y - this.shapeSnapAt.y) > 3) {
                    this.shapeSnap = null;
                    this.shapeSnapAt = null;
                } else {
                    return; // stay snapped while the pen rests
                }
            }
            let pushed = false;
            for (const ev of samples) {
                if (this.pushSample(ev)) pushed = true;
            }
            // only real movement re-arms the shape timer — pen jitter must not
            // keep a resting stroke from ever snapping
            if (pushed) {
                this.lastMoveAt = Date.now();
                this.scheduleShapeCheck();
                this.requestLive();
            }
        } else if (this.erasing) {
            // chain segment-to-segment (one batch can carry many coalesced
            // samples; fanning them from a fixed origin skipped corners);
            // sub-pixel samples are dropped — styli stream them and the
            // redundant hit-scans make the eraser stutter
            const offsets = this.buildOffsets();
            for (const ev of samples) {
                const p = this.toDoc(ev);
                const last = this.curPoints[this.curPoints.length - 1];
                if (last && Math.hypot(p.x - last.x, p.y - last.y) < 0.5) continue;
                this.eraseSegment(last.x, last.y, p.x, p.y, offsets);
                this.curPoints.push(p);
            }
            this.requestLive();
        } else if (this.selDrag) {
            const dx = pt.x - this.selDrag.lastX;
            const dy = pt.y - this.selDrag.lastY;
            this.selDrag.lastX = pt.x;
            this.selDrag.lastY = pt.y;
            this.selDrag.totalDx += dx;
            this.selDrag.totalDy += dy;
            this.store.moveStrokesTransient(this.selected, dx, dy);
            this.scheduleRedraw();
            this.requestLive();
        }
    };

    /** append one input sample to the in-progress stroke; @returns true when it moved */
    private pushSample(ev: PointerEvent): boolean {
        const p = this.toDoc(ev);
        p.p = ev.pointerType === "pen" ? Math.max(0.04, ev.pressure || 0.25) : 0.5;
        const last = this.curPoints[this.curPoints.length - 1];
        if (last && this.curPoints.length > 1 &&
            Math.hypot(p.x - last.x, p.y - last.y) < 0.5) return false;
        this.curMoved = Math.max(this.curMoved, Math.hypot(p.x - this.curStart.x, p.y - this.curStart.y));
        this.curPoints.push(p);
        const now = performance.now();
        this.trail.push({t: now, x: p.x, y: p.y});
        while (this.trail.length > 2 && now - this.trail[0].t > 450) this.trail.shift();
        return true;
    }

    private onPointerUp = (e: PointerEvent) => {
        const pt = this.toDoc(e);

        if (e.pointerType === "touch") {
            this.touchPointers.delete(e.pointerId);
            if (this.pan && e.pointerId === this.pan.id) {
                this.endPan(e, true);
                return;
            }
            // a touch that isn't the active drawing pointer is scroll/palm input
            if (this.activePointerId !== e.pointerId) return;
        } else if (e.pointerId !== this.activePointerId) {
            return;
        }

        if (this.drawing) {
            // the lift position is a real sample too — fast strokes otherwise
            // end wherever the last move event happened to land
            this.pushSample(e);
            this.finishStroke(pt);
        } else if (this.erasing) {
            const isTap = this.curMoved < 7 && (Date.now() - this.curStart.t) < 160;
            // real sweeps also erase up to the lift position; a tap must erase
            // nothing — it may be the first half of the double-tap gesture
            if (!isTap) {
                const last = this.curPoints[this.curPoints.length - 1];
                if (last) this.eraseSegment(last.x, last.y, pt.x, pt.y);
            }
            // an eraser TAP also joins the double-tap gesture, so pencil
            // double-tap switches back from eraser to pen
            const gesture = isTap && !this.eraseHitSomething &&
                this.activePointerType === "pen" && this.deps.settings.doubleTapToggle;
            if (gesture && this.tryTogglePair(pt)) {
                // consumed by the gesture; nothing was erased
            } else if (this.eraseHitSomething) {
                this.changed();
                this.lastPenTap = {t: 0, x: 0, y: 0, id: null};
            } else if (gesture) {
                // first tap of a potential eraser double-tap (nothing armed to erase)
                this.lastPenTap = {t: Date.now(), x: pt.x, y: pt.y, id: null};
            } else {
                this.lastPenTap = {t: 0, x: 0, y: 0, id: null};
            }
            this.curPoints = [];
            this.redrawLive();
        } else if (this.selDrag) {
            this.store.commitMove(this.selected, this.selDrag.totalDx, this.selDrag.totalDy);
            this.reanchorStrokes(this.selected);
            this.selDrag = null;
            this.changed();
        }
        this.finishPointer();
    };

    private onPointerCancel = (e: PointerEvent) => {
        if (e.pointerType === "touch") {
            this.touchPointers.delete(e.pointerId);
            if (this.pan && e.pointerId === this.pan.id) this.stopPan();
        }
        if (e.pointerId === this.activePointerId) {
            this.cancelActiveInput();
        }
    };

    private finishPointer() {
        this.activePointerId = null;
        this.activePointerType = "";
        this.drawing = false;
        this.erasing = false;
        this.selDrag = null;
        this.curPoints = [];
        this.curAnchor = null;
        this.clearShapeSnap();
    }

    // ------------------------------------------------------------ finger pan

    private startPan(e: PointerEvent) {
        this.stopPan();
        this.pan = {id: e.pointerId, lastX: e.clientX, lastY: e.clientY, vy: 0, lastT: Date.now()};
        try {
            this.capture.setPointerCapture(e.pointerId);
        } catch { /* iOS may refuse */ }
    }

    /** @returns true if this pointer is the panning finger and the move was consumed */
    private movePan(e: PointerEvent): boolean {
        if (!this.pan || e.pointerId !== this.pan.id) return false;
        const dy = e.clientY - this.pan.lastY;
        this.pan.lastY = e.clientY;
        const now = Date.now();
        const dt = Math.max(1, now - this.pan.lastT);
        this.pan.lastT = now;
        this.pan.vy = 0.75 * (dy / dt) + 0.25 * this.pan.vy; // px/ms, + = finger moving down
        const sc = this.scrollEl || this.contentEl;
        if (sc && dy !== 0) sc.scrollTop -= dy;
        return true;
    }

    /** end a pan; with momentum the release velocity carries the scroll and decays */
    private endPan(e: PointerEvent, withMomentum: boolean) {
        if (!this.pan || e.pointerId !== this.pan.id) return;
        const vy = this.pan.vy;
        this.pan = null;
        this.stopPanMomentum();
        const sc = this.scrollEl || this.contentEl;
        if (!withMomentum || !sc || Math.abs(vy) < 0.08) return;
        let v = vy;
        let last = performance.now();
        const step = (now: number) => {
            const dt = Math.max(1, now - last);
            last = now;
            sc.scrollTop -= v * dt;
            v *= Math.pow(0.94, dt / 16); // ~6% decay per frame
            if (Math.abs(v) > 0.02) this.panMomentum = requestAnimationFrame(step);
            else this.panMomentum = null;
        };
        this.panMomentum = requestAnimationFrame(step);
    }

    private stopPan() {
        this.pan = null;
        this.stopPanMomentum();
    }

    private stopPanMomentum() {
        if (this.panMomentum !== null) {
            cancelAnimationFrame(this.panMomentum);
            this.panMomentum = null;
        }
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
        if (!this.deps.settings.shapeSnap) return;
        if (this.shapeTimer !== null) window.clearTimeout(this.shapeTimer);
        this.shapeTimer = window.setTimeout(() => {
            this.shapeTimer = null;
            this.tryShapeSnap();
        }, 520);
    }

    /** fired after the pen rests briefly mid-stroke: perfect the shape */
    private tryShapeSnap() {
        if (!this.deps.settings.shapeSnap) return;
        if (!this.drawing || this.shapeSnap || this.erasing || this.selDrag) return;
        // styli report micro-tremor while the hand holds the pen still, so a
        // bare "time since last move" check never settles on high-rate pens:
        // every 1-2px tremor sample refreshes lastMoveAt and the snap keeps
        // re-arming forever. Judge rest by the pen's NET displacement over
        // the recent trail — tremor oscillates in place (a few px of net
        // travel) while even slow deliberate writing covers far more. The
        // old 40px/s threshold fired in the middle of slow handwriting and
        // ate the user's strokes.
        const now = performance.now();
        while (this.trail.length > 2 && now - this.trail[0].t > 450) this.trail.shift();
        const old = this.trail[0];
        const dt = old ? now - old.t : 0;
        const lp = this.curPoints[this.curPoints.length - 1];
        const still = (Date.now() - this.lastMoveAt >= 600) ||
            (old !== undefined && lp !== undefined && dt >= 400 &&
                Math.hypot(lp.x - old.x, lp.y - old.y) <= 3);
        if (!still) {
            this.scheduleShapeCheck(); // still moving, re-arm
            return;
        }
        const tool = this.deps.config.tool;
        if (tool !== "pen" && tool !== "highlighter") return;
        const snapped = recognizeShape(this.curPoints);
        if (snapped) {
            this.shapeSnap = snapped;
            const lp = this.curPoints[this.curPoints.length - 1];
            this.shapeSnapAt = {x: lp.x, y: lp.y};
            this.redrawLive();
        }
    }

    private cancelActiveInput() {
        if (this.drawing || this.erasing || this.selDrag || this.curPoints.length > 0) {
            this.curPoints = [];
            this.selDrag = null;
            this.redrawLive();
        }
        this.activePointerId = null;
        this.drawing = false;
        this.erasing = false;
        this.curAnchor = null;
        this.clearShapeSnap();
    }

    /** after a drag, re-anchor moved strokes to the block under their new position */
    private reanchorStrokes(strokes: Stroke[]) {
        const w = this.wysiwygEl;
        if (!w || strokes.length === 0) return;
        const wr = w.getBoundingClientRect();
        for (const s of strokes) {
            const p0 = s.points[0];
            if (!p0) continue;
            // current origin of the block the points are relative to
            const prev = s.anchor
                ? (this.blockOriginById(s.anchor.blockId) ?? {x: 0, y: 0})
                : {x: 0, y: 0};
            const anchor = this.captureAnchor(wr.left + p0.x + prev.x, wr.top + p0.y + prev.y);
            if (anchor) {
                s.anchor = {blockId: anchor.blockId, ox: 0, oy: 0};
                // rebase the (dragged) points onto the new block's frame
                for (const p of s.points) {
                    p.x += prev.x - anchor.ox;
                    p.y += prev.y - anchor.oy;
                }
                this.renderer.forget(s.id);
            }
            // no block under the new spot → keep the old anchor; the drag
            // delta already lives in the points
        }
    }

    private finishStroke(pt: Point) {
        const points = this.shapeSnap ?? this.curPoints;
        // a "tap" is judged by MOVEMENT and DURATION, not sample count —
        // Apple Pencil reports 240Hz, so even a stationary tap produces many
        // samples. Deliberate taps are brief and motionless; handwriting
        // dots (点) dwell 80-200ms, so the tight duration keeps them out of
        // the gesture path.
        const isTap = this.curMoved < 7 && (Date.now() - this.curStart.t) < 160;
        const gesture = isTap && this.activePointerType === "pen" && this.deps.settings.doubleTapToggle;
        if (gesture && this.tryTogglePair(pt)) return;

        if (this.shapeSnap) {
            // perfected mid-stroke (the user held the pen still): commit now
            this.lastPenTap = {t: 0, x: 0, y: 0, id: null};
            this.commitStroke(points);
            return;
        }

        // post-lift snap: the natural gesture is "draw the box, lift, look at
        // it" — recognize immediately and give the user a short window to
        // keep drawing (commits raw, handwriting stays untouched) before the
        // perfected shape is committed
        const tool = this.deps.config.tool;
        if (this.deps.settings.shapeSnap && (tool === "pen" || tool === "highlighter") &&
            !isTap && this.curMoved > 12) {
            const snapped = recognizeShape(points);
            if (snapped) {
                this.stagePendingSnap(points, snapped);
                this.lastPenTap = {t: 0, x: 0, y: 0, id: null};
                return;
            }
        }

        const committed = this.commitStroke(points);
        // remember a brief, motionless pen tap so a matching second tap can
        // toggle; any real stroke or a slower/longer dot breaks the pair
        this.lastPenTap = gesture && committed
            ? {t: Date.now(), x: pt.x, y: pt.y, id: committed.id}
            : {t: 0, x: 0, y: 0, id: null};
    }

    /** hold a finished shape-looking stroke for a moment; commit perfected
     *  when the window lapses, raw when the user starts a new stroke */
    private stagePendingSnap(points: Point[], snapped: Point[]) {
        this.cancelPendingSnap(true);
        const cfg = this.deps.config;
        const tool = cfg.tool as "pen" | "highlighter";
        const anchor = this.curAnchor ? {...this.curAnchor} : null;
        this.pendingSnap = {
            timer: window.setTimeout(() => {
                const pending = this.pendingSnap;
                this.pendingSnap = null;
                if (!pending) return;
                this.commitStroke(pending.snapped, pending.anchor, pending.simulate);
            }, 800),
            points,
            snapped,
            anchor,
            tool,
            color: tool === "pen" ? cfg.penColor : cfg.hlColor,
            width: tool === "pen" ? cfg.penWidth : cfg.hlWidth,
            opacity: tool === "pen" ? 1 : 0.45,
            simulate: this.activePointerType !== "pen",
        };
    }

    private cancelPendingSnap(commitRaw: boolean) {
        const pending = this.pendingSnap;
        if (!pending) return;
        this.pendingSnap = null;
        window.clearTimeout(pending.timer);
        // the stroke was never committed — don't lose the user's ink
        if (commitRaw) {
            const committed = this.commitStroke(pending.points, pending.anchor, pending.simulate);
            if (committed) {
                // queue it for retroactive perfection once the user pauses
                this.rawSnapIds.add(committed.id);
                this.scheduleRetroSnap();
            }
        }
    }

    private scheduleRetroSnap() {
        if (this.retroSnapTimer !== null) window.clearTimeout(this.retroSnapTimer);
        this.retroSnapTimer = window.setTimeout(() => {
            this.retroSnapTimer = null;
            this.retroSnap();
        }, 1100);
    }

    /** perfect the raw-committed shapes once the user pauses drawing */
    private retroSnap() {
        if (this.rawSnapIds.size === 0) return;
        const ids = this.rawSnapIds;
        this.rawSnapIds = new Set();
        let changedAny = false;
        for (const s of this.store.strokes) {
            if (!ids.has(s.id)) continue;
            // skip small strokes — handwriting-sized loops must stay raw
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const q of s.points) {
                if (q.x < minX) minX = q.x;
                if (q.x > maxX) maxX = q.x;
                if (q.y < minY) minY = q.y;
                if (q.y > maxY) maxY = q.y;
            }
            if (Math.hypot(maxX - minX, maxY - minY) < 55) continue;
            const snapped = recognizeShape(s.points);
            // retro-snap is for boxes drawn in rhythm — a 2-point result is a
            // LINE, and lines must only straighten on the deliberate pause
            // (holding mid-stroke or waiting after lifting), never retroactively
            if (!snapped || snapped.length === 2) continue;
            s.points = snapped;
            this.renderer.forget(s.id);
            changedAny = true;
        }
        if (changedAny) {
            this.scheduleRedraw();
            this.changed();
        }
    }

    /**
     * If `pt` completes a double-tap with the previously armed tap: erase the
     * first tap's dot (when there was one) and toggle pen<->eraser.
     * @returns true when the tap was consumed by the gesture
     */
    private tryTogglePair(pt: Point): boolean {
        const prev = this.lastPenTap;
        if (!prev.t || Date.now() - prev.t >= 480 ||
            Math.hypot(pt.x - prev.x, pt.y - prev.y) >= 16) return false;
        if (prev.id) {
            this.store.eraseWhere((s) => s.id === prev.id);
            this.renderer.forget(prev.id);
            this.scheduleRedraw();
            this.changed();
        }
        this.lastPenTap = {t: 0, x: 0, y: 0, id: null};
        this.redrawLive();
        this.deps.onDoubleTapToggle();
        return true;
    }

    /** current anchor delta for the in-progress stroke */
    private liveOffset(): {dx: number; dy: number} {
        return this.liveOffsetFor(this.curAnchor);
    }

    /** anchor delta (block origin now − anchor origin) for any staged anchor */
    private liveOffsetFor(anchor: StrokeAnchor | null): {dx: number; dy: number} {
        if (!anchor) return {dx: 0, dy: 0};
        const w = this.wysiwygEl;
        if (!w) return {dx: 0, dy: 0};
        const el = w.querySelector<HTMLElement>(`[data-node-id="${anchor.blockId}"]`);
        if (!el) return {dx: 0, dy: 0};
        const wr = w.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return {
            dx: Math.round((r.left - wr.left - anchor.ox) * 100) / 100,
            dy: Math.round((r.top - wr.top - anchor.oy) * 100) / 100,
        };
    }

    private commitStroke(points: Point[], anchor?: StrokeAnchor | null, simulate?: boolean): Stroke | null {
        if (points.length === 0) return null;
        // smooth dense freehand ink once, symmetrically (no directional lag);
        // sparse constructed shapes (snapped rects / lines) pass through exact
        points = smoothDense(points);
        const cfg = this.deps.config;
        const tool = cfg.tool as "pen" | "highlighter";
        const stroke = tool === "pen"
            ? {color: cfg.penColor, width: cfg.penWidth, opacity: 1}
            : {color: cfg.hlColor, width: cfg.hlWidth, opacity: 0.45};
        // the delayed pending-timer commit must not re-read the live pointer
        // type (it is cleared after pointerup) — use the captured value
        const sim = simulate ?? (this.activePointerType !== "pen");
        const committed = this.store.addStroke(tool, {...stroke, simulate: sim}, points);
        const a = anchor !== undefined ? anchor : this.curAnchor;
        if (a) {
            // store block-relative points: the stroke follows this block on
            // every device and through any reflow / layout change
            committed.anchor = {blockId: a.blockId, ox: 0, oy: 0};
            committed.points = points.map((p) => ({
                x: Math.round((p.x - a.ox) * 100) / 100,
                y: Math.round((p.y - a.oy) * 100) / 100,
                p: p.p,
            }));
        }
        this.redrawLive();
        this.paintCommitted(committed);
        this.changed();
        return committed;
    }

    private eraseSegment(x1: number, y1: number, x2: number, y2: number, offsets?: OffsetFn) {
        const r = this.deps.settings.eraserRadius;
        const offs = offsets ?? this.buildOffsets();
        const removed = this.store.eraseWhere((s) => {
            const o = offs(s);
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
