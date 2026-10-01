import type {Plugin} from "siyuan";

export interface PencilSettings {
    showFloatingBall: boolean;
    mouseDrawing: boolean;
    doubleTapToggle: boolean;
    shapeSnap: boolean;
    showEraserCursor: boolean;
    eraserRadius: number;
    penColor: string;
    penWidth: number;
    /** upper bound of the pen width slider */
    penWidthMax: number;
    hlColor: string;
    hlWidth: number;
}

export const DEFAULT_SETTINGS: PencilSettings = {
    showFloatingBall: true,
    mouseDrawing: false,
    doubleTapToggle: false,
    shapeSnap: true,
    showEraserCursor: true,
    eraserRadius: 20,
    penColor: "#1e1e1e",
    penWidth: 5, // sits within the pen slider range (min 1)
    penWidthMax: 20,
    hlColor: "#ffd400",
    hlWidth: 20,
};

const SETTINGS_NAME = "settings.json";

export async function loadSettings(plugin: Plugin): Promise<PencilSettings> {
    try {
        const data = await plugin.loadData(SETTINGS_NAME);
        if (data && typeof data === "object") {
            return {...DEFAULT_SETTINGS, ...(data as Partial<PencilSettings>)};
        }
    } catch { /* first run */ }
    return {...DEFAULT_SETTINGS};
}

export function saveSettings(plugin: Plugin, settings: PencilSettings): void {
    void plugin.saveData(SETTINGS_NAME, settings).catch((e) =>
        console.error("[pencil-annotation] saveSettings failed", e));
}

/** Per-device session state: active tool + last used colors/widths. */
export interface SessionConfig {
    tool: string;
    penColor?: string;
    penWidth?: number;
    hlColor?: string;
    hlWidth?: number;
    eraserRadius?: number;
}

const SESSION_KEY = "pencil-annotation.session";

export function loadSession(): SessionConfig {
    try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (raw) return JSON.parse(raw) as SessionConfig;
    } catch { /* ignore */ }
    return {tool: "pen"};
}

export function saveSession(config: SessionConfig): void {
    try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(config));
    } catch { /* ignore */ }
}
