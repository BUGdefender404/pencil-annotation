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
import type {DocStore} from "./engine/store";
import type {ToolId} from "./engine/types";

const SAVE_DEBOUNCE = 1200;

interface PendingSave {
    store: DocStore;
}

export default class PencilAnnotationPlugin extends Plugin {
    private overlays = new Map<string, DocOverlay>();
    private palette!: Palette;
    private activeOverlay: DocOverlay | null = null;

    private settings: PencilSettings = {...DEFAULT_SETTINGS};
    private overlaySettings!: OverlaySettings;
    private config!: OverlayConfig;

    private modeOn = false;
    private saveTimer: number | null = null;
    private pendingSaves = new Map<string, PendingSave>();
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
            onlyStylus: this.settings.onlyStylus,
            doubleTapToggle: this.settings.doubleTapToggle,
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
        this.palette.setMode(false); // shows the floating handle as entry point

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
        window.addEventListener("pagehide", () => void this.flushAll());
    }

    onLayoutReady() {
        this.attachExisting();
    }

    /** attach overlays to every editor that is already open */
    private attachExisting() {
        for (const editor of getAllEditor()) {
            this.attachProtyle(editor as unknown as ProtyleLike);
        }
    }

    async onunload() {
        window.removeEventListener("resize", this.onViewportResize);
        document.removeEventListener("keydown", this.onKeyDown, true);
        document.removeEventListener("visibilitychange", this.onVisibilityChange);
        await this.flushAll();
        for (const overlay of this.overlays.values()) overlay.destroy();
        this.overlays.clear();
        this.palette.toolbar.remove();
        this.palette.handle.remove();
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
                const remote = await loadPayload(this, overlay.docId);
                if (remote && overlay.applyRemote(remote)) mergedAny = true;
            }
            if (mergedAny) showMessage(this.t("syncMerged"));
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
        if (!p?.element) return;

        const key = p.id ?? "";
        const existing = this.overlays.get(key);
        if (existing) {
            const docId = this.docIdOf(p);
            if (!docId || existing.docId === docId) return; // already attached
            // mobile reuses one protyle for every doc — rebuild the overlay
            this.detachProtyle(p);
        }

        const overlay = DocOverlay.attach(p, {
            settings: this.overlaySettings,
            config: this.config,
            onDirty: () => this.scheduleSave(overlay as DocOverlay),
            onStateChange: () => this.refreshPalette(),
            onDoubleTapToggle: () => this.togglePenEraser(),
            loadPayload: (docId) => loadPayload(this, docId),
        });
        if (!overlay) return;
        this.overlays.set(p.id || overlay.docId, overlay);
        this.activeOverlay = overlay;
        if (this.modeOn) overlay.setMode(true);
        this.refreshPalette();
    }

    private detachProtyle(protyle: ProtyleLike) {
        const p = protyle as ProtyleLike;
        const key = p?.id ?? "";
        const overlay = this.overlays.get(key);
        if (!overlay) return;
        if (overlay.store.dirty) {
            void this.flushOverlay(overlay);
        }
        overlay.destroy();
        this.overlays.delete(key);
        if (this.activeOverlay === overlay) this.activeOverlay = null;
        this.refreshPalette();
    }

    private setActiveProtyle(protyle: ProtyleLike) {
        if (!protyle?.element) return;
        const overlay = this.overlays.get(protyle.id ?? "");
        if (overlay) {
            this.activeOverlay = overlay;
        } else {
            this.attachProtyle(protyle);
            this.activeOverlay = this.overlays.get(protyle.id ?? "") ?? this.activeOverlay;
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
        this.pendingSaves.set(overlay.docId, {store: overlay.store});
        if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(() => {
            this.saveTimer = null;
            void this.flushAll();
        }, SAVE_DEBOUNCE);
    }

    private async flushOverlay(overlay: DocOverlay) {
        const store = overlay.store;
        if (!store.dirty || store.saving) return;
        store.dirty = false;
        const payload = store.serialize();
        store.saving = savePayload(this, payload).then((ok) => {
            if (ok) {
                store.lastSavedAt = payload.updatedAt;
            } else {
                store.dirty = true; // retry on the next flush
            }
        }).catch(() => {
            store.dirty = true;
        }).finally(() => {
            store.saving = null;
        });
        await store.saving;
    }

    private async flushAll() {
        if (this.saveTimer !== null) {
            window.clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        const jobs: Promise<void>[] = [];
        for (const overlay of this.overlays.values()) {
            if (overlay.store.dirty) jobs.push(this.flushOverlay(overlay));
        }
        for (const pending of this.pendingSaves.values()) {
            if (pending.store.dirty) {
                const payload = pending.store.serialize();
                pending.store.dirty = false;
                jobs.push(
                    savePayload(this, payload).then((ok) => {
                        if (ok) pending.store.lastSavedAt = payload.updatedAt;
                        else pending.store.dirty = true;
                    }).catch(() => {
                        pending.store.dirty = true;
                    }),
                );
            }
        }
        this.pendingSaves.clear();
        await Promise.all(jobs);
    }

    private onVisibilityChange = () => {
        if (document.visibilityState === "hidden") void this.flushAll();
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

        row(this.t("settingOnlyStylus"), this.t("settingOnlyStylusHint"),
            mkCheckbox(() => this.overlaySettings.onlyStylus, (v) => {
                this.overlaySettings.onlyStylus = v;
                this.settings.onlyStylus = v;
            }));
        row(this.t("settingDoubleTap"), this.t("settingDoubleTapHint"),
            mkCheckbox(() => this.overlaySettings.doubleTapToggle, (v) => {
                this.overlaySettings.doubleTapToggle = v;
                this.settings.doubleTapToggle = v;
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
        saveSettings(this, this.settings);
        this.persistSession();
    }
}
