import type {ToolId} from "../engine/types";
import type {OverlayConfig, OverlaySettings} from "./overlay";
import {ICONS} from "./icons";

export const PEN_COLORS = ["#1e1e1e", "#e03131", "#2f6fed", "#2f9e44", "#f76707", "#9c36b5"];
export const HL_COLORS = ["#ffd400", "#ff922b", "#69db7c", "#4dabf7", "#f783ac"];
export const PEN_WIDTHS = [2, 4, 7];
export const HL_WIDTHS = [14, 20];
export const ERASER_SIZES = [12, 20, 30];

export type PaletteAction =
    | "undo" | "redo" | "clear" | "export" | "collapse" | "settings"
    | "deleteSel" | "dupSel" | "doneSel";

export interface PaletteState {
    mode: boolean;
    canUndo: boolean;
    canRedo: boolean;
    hasSelection: boolean;
}

export interface PaletteDeps {
    i18n: (key: string, vars?: Record<string, string>) => string;
    config: OverlayConfig;
    settings: OverlaySettings;
    onSelectTool: (tool: ToolId) => void;
    onColor: (color: string) => void;
    onWidth: (width: number) => void;
    onAction: (action: PaletteAction) => void;
    /** tapping the floating handle toggles drawing mode */
    onHandleActivate: () => void;
}

const POS_KEY = "pencil-annotation.toolbar-pos";
const DOCK_KEY = "pencil-annotation.toolbar-dock";
const HANDLE_POS_KEY = "pencil-annotation.handle-pos";

type Dock = "free" | "top" | "bottom" | "left" | "right";
const DOCK_SNAP = 34;   // px from an edge that triggers docking
const DOCK_MARGIN = 4;  // gap between a docked toolbar and the screen edge

const loadDock = (): Dock => {
    const v = localStorage.getItem(DOCK_KEY);
    return v === "top" || v === "bottom" || v === "left" || v === "right" ? v : "free";
};

const saveDock = (dock: Dock) => {
    try {
        localStorage.setItem(DOCK_KEY, dock);
    } catch { /* ignore */ }
};

const loadPos = (key: string): { x: number; y: number } | null => {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const v = JSON.parse(raw);
        if (typeof v?.x === "number" && typeof v?.y === "number") return v;
    } catch { /* ignore */ }
    return null;
};

const savePos = (key: string, pos: { x: number; y: number }) => {
    try {
        localStorage.setItem(key, JSON.stringify(pos));
    } catch { /* ignore */ }
};

export class Palette {
    readonly toolbar: HTMLDivElement;
    readonly handle: HTMLButtonElement;

    private readonly deps: PaletteDeps;
    private state: PaletteState = {mode: false, canUndo: false, canRedo: false, hasSelection: false};
    private suppressClick = false;
    private dock: Dock = loadDock();

    constructor(deps: PaletteDeps) {
        this.deps = deps;

        this.toolbar = document.createElement("div");
        this.toolbar.className = "pa-toolbar";
        this.toolbar.style.display = "none";
        document.body.appendChild(this.toolbar);

        this.handle = document.createElement("button");
        this.handle.className = "pa-handle";
        this.handle.innerHTML = ICONS.penStroke;
        this.handle.style.display = "none";
        document.body.appendChild(this.handle);

        this.restorePositions();
        this.bindDragging();
        this.handle.addEventListener("click", () => {
            if (!this.suppressClick) this.deps.onHandleActivate();
            this.suppressClick = false;
        });
        this.renderToolbar();
    }

    // -------------------------------------------------------------- layout

    private restorePositions() {
        this.applyDockClass();
        const pos = loadPos(POS_KEY);
        if (pos) this.place(this.toolbar, pos);
        else this.defaultToolbarPos();
        this.snapToDock();
        const hpos = loadPos(HANDLE_POS_KEY);
        if (hpos) this.place(this.handle, hpos);
        else this.defaultHandlePos();
    }

    private applyDockClass() {
        this.toolbar.classList.toggle(
            "pa-toolbar--vertical",
            this.dock === "left" || this.dock === "right",
        );
    }

    private defaultToolbarPos() {
        this.place(this.toolbar, {x: window.innerWidth - 320, y: 16});
    }

    private defaultHandlePos() {
        this.place(this.handle, {x: window.innerWidth - 62, y: Math.max(80, window.innerHeight * 0.3)});
    }

    /** viewport is `fixed`-positioned: x/y are the top-left corner */
    private place(el: HTMLElement, pos: { x: number; y: number }) {
        const w = el.offsetWidth || 60;
        const h = el.offsetHeight || 46;
        const x = Math.min(Math.max(8, pos.x), Math.max(8, window.innerWidth - w - 8));
        const y = Math.min(Math.max(8, pos.y), Math.max(8, window.innerHeight - h - 8));
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.right = "auto";
        el.style.bottom = "auto";
    }

    /** clamps a docked toolbar flush against its edge, sliding along it */
    private snapToDock() {
        if (this.dock === "free") return;
        const el = this.toolbar;
        this.applyDockClass();
        const w = el.offsetWidth || 60;
        const h = el.offsetHeight || 46;
        const cur = {x: parseFloat(el.style.left || "0"), y: parseFloat(el.style.top || "0")};
        let x = cur.x, y = cur.y;
        if (this.dock === "left") x = DOCK_MARGIN;
        else if (this.dock === "right") x = window.innerWidth - w - DOCK_MARGIN;
        else if (this.dock === "top") y = DOCK_MARGIN;
        else if (this.dock === "bottom") y = window.innerHeight - h - DOCK_MARGIN;
        this.place(el, {x, y});
    }

    /** live edge-snapping while the toolbar is dragged (edges detected by pointer) */
    private applyDockDrag(x: number, y: number, px: number, py: number) {
        const el = this.toolbar;
        let dock: Dock = "free";
        if (px < DOCK_SNAP) dock = "left";
        else if (px > window.innerWidth - DOCK_SNAP) dock = "right";
        else if (py < DOCK_SNAP) dock = "top";
        else if (py > window.innerHeight - DOCK_SNAP) dock = "bottom";
        this.dock = dock;
        el.classList.toggle("pa-toolbar--vertical", dock === "left" || dock === "right");
        const w2 = el.offsetWidth || 60;
        const h2 = el.offsetHeight || 46;
        let lx = x, ly = y;
        if (dock === "left") lx = DOCK_MARGIN;
        else if (dock === "right") lx = window.innerWidth - w2 - DOCK_MARGIN;
        else if (dock === "top") ly = DOCK_MARGIN;
        else if (dock === "bottom") ly = window.innerHeight - h2 - DOCK_MARGIN;
        this.place(el, {x: lx, y: ly});
    }

    private placeDefaultIfFloating() {
        if (!loadPos(POS_KEY)) this.defaultToolbarPos();
    }

    private bindDragging() {
        for (const [elRaw, key] of [[this.toolbar, POS_KEY], [this.handle, HANDLE_POS_KEY]] as const) {
            const el = elRaw as HTMLElement;
            el.addEventListener("pointerdown", (e: PointerEvent) => {
                const target = e.target as HTMLElement;
                if (el === this.toolbar && target.closest("button")) return; // buttons stay clickable
                e.preventDefault();
                e.stopPropagation();
                const rect = el.getBoundingClientRect();
                const offX = e.clientX - rect.left;
                const offY = e.clientY - rect.top;
                let moved = false;
                const move = (ev: PointerEvent) => {
                    moved = true;
                    if (el === this.toolbar) {
                        this.applyDockDrag(ev.clientX - offX, ev.clientY - offY, ev.clientX, ev.clientY);
                    } else {
                        this.place(el, {x: ev.clientX - offX, y: ev.clientY - offY});
                    }
                };
                const up = (ev: PointerEvent) => {
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                    if (moved) {
                        if (el === this.toolbar) {
                            savePos(key, {
                                x: parseFloat(el.style.left || "0"),
                                y: parseFloat(el.style.top || "0"),
                            });
                            saveDock(this.dock);
                            requestAnimationFrame(() => this.snapToDock());
                        } else {
                            savePos(key, {x: ev.clientX - offX, y: ev.clientY - offY});
                            this.suppressClick = true; // drag, not a tap
                        }
                    } else if (el === this.handle) {
                        // a plain tap on the handle toggles drawing mode
                        this.deps.onHandleActivate();
                        this.suppressClick = true;
                    }
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
            });
        }
    }

    // -------------------------------------------------------------- render

    private btn(icon: string, title: string, onClick: () => void, cls = ""): HTMLButtonElement {
        const b = document.createElement("button");
        b.className = `pa-btn ${cls}`.trim();
        b.innerHTML = icon;
        b.title = title;
        b.setAttribute("aria-label", title);
        b.addEventListener("click", (e) => {
            e.stopPropagation();
            onClick();
        });
        return b;
    }

    private renderToolbar() {
        const t = this.deps.i18n;
        const cfg = this.deps.config;
        const tool = cfg.tool;

        this.toolbar.innerHTML = "";

        // tool buttons
        const toolsGroup = document.createElement("div");
        toolsGroup.className = "pa-toolbar__group";
        const toolDefs: Array<[ToolId, string, string]> = [
            ["pen", ICONS.penStroke, t("toolPen")],
            ["highlighter", ICONS.highlighter, t("toolHighlighter")],
            ["eraser", ICONS.eraser, t("toolEraser")],
            ["select", ICONS.select, t("toolSelect")],
        ];
        for (const [id, icon, label] of toolDefs) {
            const b = this.btn(icon, label, () => this.deps.onSelectTool(id),
                tool === id ? "pa-btn--active" : "");
            toolsGroup.appendChild(b);
        }
        this.toolbar.appendChild(toolsGroup);

        this.toolbar.appendChild(this.sep());

        // contextual options
        const options = document.createElement("div");
        options.className = "pa-toolbar__options";
        if (tool === "pen" || tool === "highlighter") {
            const colors = tool === "pen" ? PEN_COLORS : HL_COLORS;
            const activeColor = tool === "pen" ? cfg.penColor : cfg.hlColor;
            for (const c of colors) {
                const sw = document.createElement("button");
                sw.className = `pa-swatch ${c.toLowerCase() === activeColor.toLowerCase() ? "pa-swatch--active" : ""}`;
                sw.style.background = c;
                sw.title = c;
                sw.addEventListener("click", (e) => {
                    e.stopPropagation();
                    this.deps.onColor(c);
                });
                options.appendChild(sw);
            }
            const widths = tool === "pen" ? PEN_WIDTHS : HL_WIDTHS;
            const activeWidth = tool === "pen" ? cfg.penWidth : cfg.hlWidth;
            for (const w of widths) {
                const wb = document.createElement("button");
                wb.className = `pa-width ${w === activeWidth ? "pa-width--active" : ""}`;
                const dot = document.createElement("i");
                const d = Math.min(20, 6 + w * 1.6);
                dot.style.width = `${d}px`;
                dot.style.height = `${d}px`;
                wb.appendChild(dot);
                wb.title = `${w}px`;
                wb.addEventListener("click", (e) => {
                    e.stopPropagation();
                    this.deps.onWidth(w);
                });
                options.appendChild(wb);
            }
        } else if (tool === "eraser") {
            for (const size of ERASER_SIZES) {
                const wb = document.createElement("button");
                wb.className = `pa-width ${size === this.deps.settings.eraserRadius ? "pa-width--active" : ""}`;
                const dot = document.createElement("i");
                const d = 8 + ERASER_SIZES.indexOf(size) * 5;
                dot.style.width = `${d}px`;
                dot.style.height = `${d}px`;
                wb.appendChild(dot);
                wb.title = `${size}px`;
                wb.addEventListener("click", (e) => {
                    e.stopPropagation();
                    this.deps.onWidth(size);
                });
                options.appendChild(wb);
            }
        } else if (tool === "select") {
            const hint = document.createElement("span");
            hint.style.cssText = "font-size:12px;color:rgba(255,255,255,.65);white-space:nowrap;";
            hint.textContent = this.state.hasSelection
                ? t("strokeDelete")
                : t("toolSelect");
            options.appendChild(hint);
        }
        this.toolbar.appendChild(options);

        // selection actions
        if (this.state.hasSelection) {
            this.toolbar.appendChild(this.sep());
            const selGroup = document.createElement("div");
            selGroup.className = "pa-toolbar__selection";
            selGroup.appendChild(this.btn(ICONS.duplicate, this.deps.i18n("strokeDuplicate"), () => this.deps.onAction("dupSel")));
            selGroup.appendChild(this.btn(ICONS.trash, this.deps.i18n("strokeDelete"), () => this.deps.onAction("deleteSel")));
            selGroup.appendChild(this.btn(ICONS.check, this.deps.i18n("strokeDeselect"), () => this.deps.onAction("doneSel")));
            this.toolbar.appendChild(selGroup);
        }

        this.toolbar.appendChild(this.sep());

        // global actions
        const actionsGroup = document.createElement("div");
        actionsGroup.className = "pa-toolbar__group";
        const undoBtn = this.btn(ICONS.undo, this.deps.i18n("undo"), () => this.deps.onAction("undo"));
        (undoBtn as HTMLButtonElement & { disabled: boolean }).disabled = !this.state.canUndo;
        const redoBtn = this.btn(ICONS.redo, this.deps.i18n("redo"), () => this.deps.onAction("redo"));
        (redoBtn as HTMLButtonElement & { disabled: boolean }).disabled = !this.state.canRedo;
        actionsGroup.append(
            undoBtn,
            redoBtn,
            this.btn(ICONS.export, this.deps.i18n("exportImage"), () => this.deps.onAction("export")),
            this.btn(ICONS.trash, this.deps.i18n("clearAll"), () => this.deps.onAction("clear")),
        );
        this.toolbar.appendChild(actionsGroup);

        this.toolbar.appendChild(this.sep());
        this.toolbar.appendChild(
            this.btn(ICONS.gear, this.deps.i18n("settings"), () => this.deps.onAction("settings")),
        );
        this.toolbar.appendChild(
            this.btn(ICONS.collapse, this.deps.i18n("collapse"), () => this.deps.onAction("collapse")),
        );

        // keep inside viewport after re-render (size may have changed)
        this.applyDockClass();
        const x = parseFloat(this.toolbar.style.left || "0");
        const y = parseFloat(this.toolbar.style.top || "0");
        this.place(this.toolbar, {x, y});
        this.snapToDock();
    }

    private sep(): HTMLDivElement {
        const s = document.createElement("div");
        s.className = "pa-toolbar__sep";
        return s;
    }

    // --------------------------------------------------------------- state

    setMode(on: boolean) {
        this.state.mode = on;
        this.toolbar.style.display = on ? "" : "none";
        this.handle.style.display = on ? "none" : "";
        this.handle.classList.toggle("pa-handle--on", on);
        if (on) {
            if (this.dock === "free") this.placeDefaultIfFloating();
            else this.snapToDock();
        }
    }

    update(state: Partial<PaletteState>) {
        const prev = this.state;
        this.state = {...prev, ...state};
        const structural =
            prev.canUndo !== this.state.canUndo ||
            prev.canRedo !== this.state.canRedo ||
            prev.hasSelection !== this.state.hasSelection;
        if (structural) this.renderToolbar();
        this.handle.classList.toggle("pa-handle--on", this.state.mode);
    }

    /** force a full re-render (tool/color/width changes) */
    refresh() {
        this.renderToolbar();
    }

    repositionForViewport() {
        this.snapToDock();
        const hx = parseFloat(this.handle.style.left || "0");
        const hy = parseFloat(this.handle.style.top || "0");
        this.place(this.handle, {x: hx, y: hy});
    }
}
