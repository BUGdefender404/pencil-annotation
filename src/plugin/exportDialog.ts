import {Dialog, showMessage} from "siyuan";
import type {DocOverlay} from "../overlay/overlay";
import {appendBlockMarkdown, uploadAssetPng} from "./api";
import {strokesToPngBlob} from "./exportImage";

type I18nFn = (key: string, vars?: Record<string, string>) => string;

export function exportStrokesDialog(overlay: DocOverlay, t: I18nFn) {
    if (overlay.store.strokes.length === 0) {
        showMessage(t("exportNone"));
        return;
    }

    const dialog = new Dialog({
        title: t("exportTitle"),
        content: `<div class="pa-export">
            <label class="pa-export__opt">
                <input type="radio" name="pa-export-bg" value="white" checked>
                <span>${t("exportBgWhite")}</span>
            </label>
            <label class="pa-export__opt">
                <input type="radio" name="pa-export-bg" value="transparent">
                <span>${t("exportBgTransparent")}</span>
            </label>
            <div class="pa-export__actions">
                <button class="b3-button b3-button--outline" data-action="save">${t("exportSaveOnly")}</button>
                <button class="b3-button b3-button--text" data-action="insert">${t("exportInsert")}</button>
            </div>
        </div>`,
        width: "420px",
    });

    const el = dialog.element;
    const bg = (): "white" | "transparent" =>
        el.querySelector<HTMLInputElement>('input[name="pa-export-bg"]:checked')?.value === "transparent"
            ? "transparent" : "white";

    const run = async (insert: boolean) => {
        const buttons = el.querySelectorAll<HTMLButtonElement>(".pa-export__actions button");
        buttons.forEach((b) => (b.disabled = true));
        try {
            const blob = await strokesToPngBlob(overlay.store, bg(), overlay.strokeOffsets());
            const fileName = `pencil-${overlay.docId}-${Date.now()}.png`;
            const path = await uploadAssetPng(fileName, blob);
            if (insert) {
                await appendBlockMarkdown(overlay.docId, `![](${path})`);
                showMessage(t("exportInserted"));
            }
            showMessage(t("exportDone", {path}));
            dialog.destroy();
        } catch (e) {
            console.error("[pencil-annotation] export failed", e);
            showMessage(t("exportFailed", {msg: String((e as Error).message || e)}), undefined, "error");
            buttons.forEach((b) => (b.disabled = false));
        }
    };

    el.querySelector<HTMLButtonElement>('[data-action="save"]')
        ?.addEventListener("click", () => void run(false));
    el.querySelector<HTMLButtonElement>('[data-action="insert"]')
        ?.addEventListener("click", () => void run(true));
}
