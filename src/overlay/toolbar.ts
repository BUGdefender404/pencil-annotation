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
}

const POS_KEY = "pencil-annotation.toolbar-pos";
const HANDLE_POS_KEY = "pencil-annotation.handle-pos";

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
            this.toolbar.style.display = "";
            this.handle.style.display = "none";
            this.placeDefaultIfFloating();
        });
        this.renderToolbar();
    }

    // -------------------------------------------------------------- layout

    private restorePositions() {
        const pos = loadPos(POS_KEY);
        if (pos) this.place(this.toolbar, pos);
        else this.defaultToolbarPos();
        const hpos = loadPos(HANDLE_POS_KEY);
        if (hpos) this.place(this.handle, hpos);
        else this.defaultHandlePos();
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
                    this.place(el, {x: ev.clientX - offX, y: ev.clientY - offY});
                };
                const up = (ev: PointerEvent) => {
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                    if (moved) {
                        savePos(key, {x: ev.clientX - offX, y: ev.clientY - offY});
                    } else if (el === this.handle) {
                        // a plain tap on the handle expands the toolbar
                        this.toolbar.style.display = "";
                        this.handle.style.display = "none";
                        this.placeDefaultIfFloating();
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
        const x = parseFloat(this.toolbar.style.left || "0");
        const y = parseFloat(this.toolbar.style.top || "0");
        this.place(this.toolbar, {x, y});
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
        if (on) this.placeDefaultIfFloating();
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

    collapse() {
        this.toolbar.style.display = "none";
        this.handle.style.display = "";
        const x = parseFloat(this.toolbar.style.left || "0");
        const y = parseFloat(this.toolbar.style.top || "0");
        if (!loadPos(HANDLE_POS_KEY)) {
            this.place(this.handle, {x: Math.min(x + 20, window.innerWidth - 60), y: y + 40});
        }
    }

    repositionForViewport() {
        const x = parseFloat(this.toolbar.style.left || "0");
        const y = parseFloat(this.toolbar.style.top || "0");
        this.place(this.toolbar, {x, y});
        const hx = parseFloat(this.handle.style.left || "0");
        const hy = parseFloat(this.handle.style.top || "0");
        this.place(this.handle, {x: hx, y: hy});
    }
}
