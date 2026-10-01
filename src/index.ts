import {
    confirm,
    getAllEditor,
    getFrontend,
    Plugin,
    Setting,
    showMessage,
} from "siyuan";
import {DocOverlay, type OverlayConfig, type OverlaySettings, type ProtyleLike} from "./overlay/overlay";
import {Palette, type PaletteAction} from "./overlay/toolbar";
import {TOPBAR_SVG} from "./overlay/icons";
import {loadPayload, savePayload} from "./plugin/api";
import {exportStrokesDialog} from "./plugin/exportDialog";
import {
    DEFAULT_SETTINGS,
    loadSession,
    loadSettings,
    saveSession,
    saveSettings,
    type PencilSettings,
} from "./plugin/settings";
import {DocStore} from "./engine/store";
import type {ToolId} from "./engine/types";

const SAVE_DEBOUNCE = 1200;

export default class PencilAnnotationPlugin extends Plugin {
    private overlays = new Map<HTMLElement, DocOverlay>();
    private documents = new Map<string, DocStore>();
    private palette!: Palette;
    private activeOverlay: DocOverlay | null = null;

    private settings: PencilSettings = {...DEFAULT_SETTINGS};
    private overlaySettings!: OverlaySettings;
    private config!: OverlayConfig;

    private modeOn = false;
    private saveTimer: number | null = null;
    private pendingSaves = new Set<DocStore>();
    private saveRetries = 0;
    private unloading = false;
    private syncingRemote = false;

    // ------------------------------------------------------------------ i18n

    private t = (key: string, vars?: Record<string, string>): string => {
        let text = String((this.i18n as Record<string, string>)[key] ?? key);
        if (vars) {
            for (const [k, v] of Object.entries(vars)) {
                text = text.split(`{${k}}`).join(v);
            }
        }
        return text;
    };

    // -------------------------------------------------------------- lifecycle

    async onload() {
        this.settings = await loadSettings(this);
        this.overlaySettings = {
            mouseDrawing: this.settings.mouseDrawing,
            doubleTapToggle: this.settings.doubleTapToggle,
            shapeSnap: this.settings.shapeSnap,
            showEraserCursor: this.settings.showEraserCursor,
            eraserRadius: this.settings.eraserRadius,
            penWidthMax: this.settings.penWidthMax,
        };
        const session = loadSession();
        this.config = {
            tool: (["pen", "highlighter", "eraser", "select"] as ToolId[]).includes(session.tool as ToolId)
                ? (session.tool as ToolId) : "pen",
            penColor: session.penColor || this.settings.penColor,
            // clamp stale session widths that exceed the (possibly new) slider cap
            penWidth: Math.min(session.penWidth || this.settings.penWidth, this.settings.penWidthMax),
            hlColor: session.hlColor || this.settings.hlColor,
            hlWidth: session.hlWidth || this.settings.hlWidth,
        };

        // core wiring first — the overlay must never depend on UI extras below
        this.eventBus.on("loaded-protyle-static", ({detail}) => this.attachProtyle(detail.protyle));
        this.eventBus.on("loaded-protyle-dynamic", ({detail}) => this.attachProtyle(detail.protyle));
        this.eventBus.on("destroy-protyle", ({detail}) => this.detachProtyle(detail.protyle));
        this.eventBus.on("switch-protyle", ({detail}) => this.setActiveProtyle(detail.protyle));
        this.eventBus.on("click-editorcontent", ({detail}) => this.setActiveProtyle(detail.protyle));

        this.palette = new Palette({
            i18n: this.t,
            config: this.config,
            settings: this.overlaySettings,
            onSelectTool: (tool) => {
                this.config.tool = tool;
                this.persistSession();
                this.palette.refresh();
            },
            onColor: (color) => {
                if (this.config.tool === "highlighter") this.config.hlColor = color;
                else this.config.penColor = color;
                this.persistSession();
                this.palette.refresh();
            },
            onWidth: (width) => {
                // no palette.refresh() here: the slider updates itself in place,
                // and a re-render mid-drag would tear the input from the pointer
                if (this.config.tool === "highlighter") this.config.hlWidth = width;
                else if (this.config.tool === "eraser") this.overlaySettings.eraserRadius = width;
                else this.config.penWidth = width;
                this.persistSession();
            },
            onAction: (action) => this.onPaletteAction(action),
            onHandleActivate: () => this.toggleMode(),
        });
        this.palette.setHandleVisible(this.settings.showFloatingBall);
        this.palette.setMode(false);

        if (["desktop", "desktop-window", "browser-desktop"].includes(getFrontend())) {
            this.addTopBar({
                icon: TOPBAR_SVG,
                title: this.t("topbarTitle"),
                callback: () => this.toggleMode(),
            });
        }

        this.addCommand({
            langKey: "topbarTitle",
            hotkey: "",
            callback: () => this.toggleMode(),
        });

        this.buildSettingDialog();

        // when the plugin is enabled mid-session, editors are already open and
        // no loaded-protyle event will fire — pick them up after onload settles
        window.setTimeout(() => this.attachExisting(), 600);

        window.addEventListener("resize", this.onViewportResize);
        document.addEventListener("keydown", this.onKeyDown, true);
        document.addEventListener("visibilitychange", this.onVisibilityChange);
        window.addEventListener("pagehide", this.onPageHide);
        window.addEventListener("online", this.onOnline);
    }

    onLayoutReady() {
        this.attachExisting();
    }

    /** attach overlays to every editor that is already open */
    private attachExisting() {
        if (this.unloading) return;
        for (const editor of getAllEditor()) {
            this.attachProtyle(editor as unknown as ProtyleLike);
        }
    }

    async onunload() {
        this.unloading = true;
        window.removeEventListener("pagehide", this.onPageHide);
        window.removeEventListener("online", this.onOnline);
        window.removeEventListener("resize", this.onViewportResize);
        document.removeEventListener("keydown", this.onKeyDown, true);
        document.removeEventListener("visibilitychange", this.onVisibilityChange);
        for (const overlay of this.overlays.values()) {
            overlay.destroy(); // stop input and finalize BEFORE the final persistence barrier
            if (overlay.store.dirty || overlay.store.saving) this.pendingSaves.add(overlay.store);
        }
        this.overlays.clear();
        this.palette.destroy();
        await this.flushAll();
    }

    /**
     * Kernel pushed a data change: "sync" means another device merged new
     * strokes into this doc's payload — pull and merge them into open editors.
     */
    async onDataChanged(reason?: string) {
        if (reason !== "sync" && reason !== "overwrite") return;
        if (this.syncingRemote) return;
        this.syncingRemote = true;
        try {
            let mergedAny = false;
            for (const overlay of this.overlays.values()) {
                try {
                    const remote = await loadPayload(this, overlay.docId);
                    if (remote && overlay.applyRemote(remote)) mergedAny = true;
                } catch (e) {
                    showMessage(this.t("loadFailed", {msg: String(e)}), 6000, "error");
                }
            }
            if (mergedAny) {
                for (const overlay of this.overlays.values()) overlay.redrawAll();
                showMessage(this.t("syncMerged"));
            }
        } finally {
            this.syncingRemote = false;
        }
    }

    // --------------------------------------------------------------- protyle

    private docIdOf(protyle: ProtyleLike): string | undefined {
        return protyle.options?.rootId || protyle.block?.rootID || undefined;
    }

    private attachProtyle(protyle: ProtyleLike) {
        const p = protyle as ProtyleLike;
        if (!p?.element || this.unloading) return;

        const key = p.element;
        const existing = this.overlays.get(key);
        if (existing) {
            const docId = this.docIdOf(p);
            if (!docId) return;
            if (existing.docId === docId) {
                existing.refreshProtyle(p);
                return;
            }
            // mobile reuses one protyle for every doc — rebuild the overlay
            this.detachProtyle(p);
        }

        const docId = this.docIdOf(p);
        if (!docId) return;
        let store = this.documents.get(docId);
        if (!store) {
            store = new DocStore(docId);
            this.documents.set(docId, store);
        }
        const overlay = DocOverlay.attach(p, {
            store,
            settings: this.overlaySettings,
            config: this.config,
            onDirty: () => this.scheduleSave(overlay as DocOverlay),
            onStateChange: () => this.refreshPalette(),
            onDoubleTapToggle: () => this.togglePenEraser(),
            loadPayload: (docId) => loadPayload(this, docId),
            onActivate: () => { this.activeOverlay = overlay; },
            onLoadError: (e) => showMessage(this.t("loadFailed", {msg: String(e)}), 6000, "error"),
        });
        if (!overlay) return;
        this.overlays.set(key, overlay);
        this.activeOverlay = overlay;
        if (this.modeOn) overlay.setMode(true);
        this.refreshPalette();
    }

    private detachProtyle(protyle: ProtyleLike) {
        const p = protyle as ProtyleLike;
        const key = p?.element;
        const overlay = this.overlays.get(key);
        if (!overlay) return;
        overlay.destroy(); // finalize completed dots and interrupted strokes BEFORE saving
        if (overlay.store.dirty || overlay.store.saving) {
            this.pendingSaves.add(overlay.store);
            void this.flushAll();
        }
        this.overlays.delete(key);
        this.releaseUnusedDocuments();
        if (this.activeOverlay === overlay) this.activeOverlay = null;
        this.refreshPalette();
    }

    private setActiveProtyle(protyle: ProtyleLike) {
        if (!protyle?.element) return;
        const overlay = this.overlays.get(protyle.element);
        if (overlay) {
            this.activeOverlay = overlay;
        } else {
            this.attachProtyle(protyle);
            this.activeOverlay = this.overlays.get(protyle.element) ?? this.activeOverlay;
        }
        this.refreshPalette();
    }

    // ------------------------------------------------------------------ mode

    private toggleMode() {
        this.modeOn = !this.modeOn;
        for (const overlay of this.overlays.values()) {
            overlay.setMode(this.modeOn);
        }
        this.palette.setMode(this.modeOn);
        showMessage(this.t(this.modeOn ? "modeOn" : "modeOff"));
    }

    private togglePenEraser() {
        this.config.tool = this.config.tool === "eraser" ? "pen" : "eraser";
        this.persistSession();
        this.palette.refresh();
        showMessage(this.t("doubleTapToggled", {tool: this.t(this.config.tool)}));
    }

    private onPaletteAction(action: PaletteAction) {
        const overlay = this.activeOverlay;
        switch (action) {
            case "undo":
                overlay?.undo();
                break;
            case "redo":
                overlay?.redo();
                break;
            case "clear":
                if (!overlay) return;
                confirm(this.t("clearAll"), this.t("confirmClear"), () => {
                    overlay.clearAll();
                    showMessage(this.t("clearDone"));
                });
                break;
            case "export":
                if (overlay) exportStrokesDialog(overlay, this.t);
                break;
            case "collapse":
                // collapsing the toolbar exits drawing mode (handle comes back)
                this.toggleMode();
                break;
            case "settings":
                this.openSetting();
                break;
            case "deleteSel":
                overlay?.deleteSelection();
                break;
            case "dupSel":
                overlay?.duplicateSelection();
                break;
            case "doneSel":
                overlay?.deselect();
                break;
        }
    }

    private refreshPalette() {
        const overlay = this.activeOverlay;
        this.palette.update({
            canUndo: overlay?.store.canUndo ?? false,
            canRedo: overlay?.store.canRedo ?? false,
            hasSelection: (overlay?.selected.length ?? 0) > 0,
        });
    }

    private persistSession() {
        saveSession({
            tool: this.config.tool,
            penColor: this.config.penColor,
            penWidth: this.config.penWidth,
            hlColor: this.config.hlColor,
            hlWidth: this.config.hlWidth,
            eraserRadius: this.overlaySettings.eraserRadius,
        });
    }

    // ------------------------------------------------------------ persistence

    private scheduleSave(overlay: DocOverlay) {
        this.pendingSaves.add(overlay.store);
        this.saveRetries = 0;
        // Split views share one document, including undo and unsaved ink.
        for (const other of this.overlays.values()) {
            if (other !== overlay && other.store === overlay.store) other.redrawAll();
        }
        this.armSave(SAVE_DEBOUNCE);
    }

    private armSave(delay: number) {
        if (this.unloading) return;
        if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            void this.flushAll();
        }, delay);
    }

    private async flushStore(store: DocStore) {
        if (store.saving) {
            await store.saving;
            return;
        }
        if (!store.loaded || !store.dirty) return;
        store.saving = (async () => {
            while (store.dirty) {
                const payload = store.serialize();
                store.dirty = false;
                const ok = await savePayload(this, payload);
                if (!ok) {
                    store.dirty = true;
                    showMessage(this.t("saveFailed", {msg: this.t("saveRetry")}), 6000, "error");
                    break;
                }
                store.lastSavedAt = payload.updatedAt;
            }
        })().finally(() => { store.saving = null; });
        await store.saving;
    }

    private async flushAll() {
        if (this.saveTimer !== null) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        for (const overlay of this.overlays.values()) {
            if (overlay.store.dirty || overlay.store.saving) this.pendingSaves.add(overlay.store);
        }
        await Promise.all([...this.pendingSaves].map(store => this.flushStore(store)));
        for (const store of this.pendingSaves) {
            if (!store.dirty && !store.saving) this.pendingSaves.delete(store);
        }
        // Keep failed/detached stores until success; bounded automatic retries avoid a busy loop.
        if (this.pendingSaves.size && this.saveRetries < 3) {
            this.armSave(2000 * 2 ** this.saveRetries++);
        }
        this.releaseUnusedDocuments();
    }

    private releaseUnusedDocuments() {
        for (const [id, store] of this.documents) {
            if (!store.dirty && !store.saving &&
                ![...this.overlays.values()].some(o => o.store === store)) this.documents.delete(id);
        }
    }

    private onPageHide = () => {
        for (const overlay of this.overlays.values()) overlay.finalizeInput();
        void this.flushAll();
    };

    private onOnline = () => {
        this.saveRetries = 0;
        for (const overlay of this.overlays.values()) overlay.setMode(this.modeOn);
        void this.flushAll();
    };

    private onVisibilityChange = () => {
        if (document.visibilityState === "hidden") this.onPageHide();
        else this.onOnline();
    };

    private onViewportResize = () => {
        this.palette.repositionForViewport();
    };

    // -------------------------------------------------------------- keyboard

    private onKeyDown = (e: KeyboardEvent) => {
        if (!this.modeOn || !this.activeOverlay) return;
        const target = e.target as HTMLElement | null;
        if (target?.closest("input, textarea, [contenteditable='true'], .b3-dialog")) return;

        const mod = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        if (mod && key === "z" && !e.shiftKey) {
            e.preventDefault();
            e.stopPropagation();
            this.activeOverlay.undo();
        } else if ((mod && key === "z" && e.shiftKey) || (mod && key === "y")) {
            e.preventDefault();
            e.stopPropagation();
            this.activeOverlay.redo();
        } else if (key === "escape") {
            e.preventDefault();
            this.toggleMode();
        }
    };

    // -------------------------------------------------------------- settings

    private buildSettingDialog() {
        this.setting = new Setting({
            height: "44vh",
            width: "600px",
            confirmCallback: () => this.applyAndPersistSettings(),
        });
        const s: Setting = this.setting;
        const row = (
            title: string,
            description: string | undefined,
            control: HTMLElement,
        ) => {
            s.addItem({
                title,
                description,
                direction: "row",
                createActionElement: () => control,
            });
        };

        const mkCheckbox = (get: () => boolean, set: (v: boolean) => void) => {
            const box = document.createElement("input");
            box.type = "checkbox";
            box.className = "b3-switch";
            box.checked = get();
            box.addEventListener("change", () => {
                set(box.checked);
                this.applyAndPersistSettings();
            });
            return box;
        };
        const mkColor = (get: () => string, set: (v: string) => void) => {
            const input = document.createElement("input");
            input.type = "color";
            input.className = "b3-text-field";
            input.style.width = "64px";
            input.value = get();
            input.addEventListener("change", () => {
                set(input.value);
                this.applyAndPersistSettings();
                this.palette.refresh();
            });
            return input;
        };
        const mkNumber = (get: () => number, set: (v: number) => void, min: number, max: number, step = 1) => {
            const input = document.createElement("input");
            input.type = "number";
            input.className = "b3-text-field";
            input.style.width = "90px";
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            input.value = String(get());
            input.addEventListener("change", () => {
                const v = Math.min(max, Math.max(min, parseFloat(input.value) || min));
                set(v);
                input.value = String(v);
                this.applyAndPersistSettings();
                this.palette.refresh();
            });
            return input;
        };

        row(this.t("settingShowFloatingBall"), this.t("settingShowFloatingBallHint"),
            mkCheckbox(() => this.settings.showFloatingBall, (v) => {
                this.settings.showFloatingBall = v;
                this.palette.setHandleVisible(v);
            }));
        // Keep the switch on all frontends: Android tablets/phones can also use a mouse.
        row(this.t("settingMouseDrawing"), this.t("settingMouseDrawingHint"),
            mkCheckbox(() => this.settings.mouseDrawing, (v) => {
                this.settings.mouseDrawing = v;
                this.overlaySettings.mouseDrawing = v;
            }));

        row(this.t("settingDoubleTap"), this.t("settingDoubleTapHint"),
            mkCheckbox(() => this.overlaySettings.doubleTapToggle, (v) => {
                this.overlaySettings.doubleTapToggle = v;
                this.settings.doubleTapToggle = v;
            }));
        row(this.t("settingShapeSnap"), this.t("settingShapeSnapHint"),
            mkCheckbox(() => this.overlaySettings.shapeSnap, (v) => {
                this.overlaySettings.shapeSnap = v;
                this.settings.shapeSnap = v;
            }));
        row(this.t("settingShowEraserCursor"), undefined,
            mkCheckbox(() => this.overlaySettings.showEraserCursor, (v) => {
                this.overlaySettings.showEraserCursor = v;
                this.settings.showEraserCursor = v;
            }));
        row(this.t("settingPenColor"), undefined,
            mkColor(() => this.config.penColor, (v) => {
                this.config.penColor = v;
                this.settings.penColor = v;
            }));
        row(this.t("settingPenWidth"), undefined,
            mkNumber(() => this.config.penWidth, (v) => {
                this.config.penWidth = v;
                this.settings.penWidth = v;
            }, 1, 100));
        row(this.t("settingPenWidthMax"), this.t("settingPenWidthMaxHint"),
            mkNumber(() => this.settings.penWidthMax, (v) => {
                this.settings.penWidthMax = v;
                this.overlaySettings.penWidthMax = v;
                if (this.config.penWidth > v) {
                    this.config.penWidth = v;
                    this.persistSession();
                }
            }, 5, 100));
        row(this.t("settingHlColor"), undefined,
            mkColor(() => this.config.hlColor, (v) => {
                this.config.hlColor = v;
                this.settings.hlColor = v;
            }));
        row(this.t("settingHlWidth"), undefined,
            mkNumber(() => this.config.hlWidth, (v) => {
                this.config.hlWidth = v;
                this.settings.hlWidth = v;
            }, 8, 48));
        row(this.t("settingEraserSize"), undefined,
            mkNumber(() => this.overlaySettings.eraserRadius, (v) => {
                this.overlaySettings.eraserRadius = v;
                this.settings.eraserRadius = v;
            }, 4, 60));
    }

    private applyAndPersistSettings() {
        for (const overlay of this.overlays.values()) overlay.refreshInputPolicy();
        saveSettings(this, this.settings);
        this.persistSession();
    }
}
