import {Dialog, showMessage} from "siyuan";
import type {DocOverlay} from "../overlay/overlay";
import {appendBlockMarkdown, uploadAssetPng} from "./api";
import {strokesToPngBlob} from "./exportImage";
import {exportNotePdf, PdfSaveCancelled} from "./exportPdf";

type I18nFn = (key: string, vars?: Record<string, string>) => string;

export function exportStrokesDialog(overlay: DocOverlay, t: I18nFn) {
    const hasInk = overlay.store.strokes.length > 0;

    const dialog = new Dialog({
        title: t("exportTitle"),
        content: `<div class="pa-export">
            <div class="b3-label config-item">
                <div class="fn__block">
                    <div class="config-name">${t("exportInkSection")}</div>
                    <div class="b3-label__text">${t("exportInkDesc")}</div>
                    <div class="fn__hr"></div>
                    <div class="pa-export__radios">
                        <label class="pa-export__radio">
                            <input class="b3-radio" type="radio" name="pa-export-bg" value="white" checked>
                            <span>${t("exportBgWhite")}</span>
                        </label>
                        <label class="pa-export__radio">
                            <input class="b3-radio" type="radio" name="pa-export-bg" value="transparent">
                            <span>${t("exportBgTransparent")}</span>
                        </label>
                    </div>
                    <div class="pa-export__row">
                        <button class="b3-button b3-button--outline" data-action="save"
                            ${hasInk ? "" : "disabled"}><span>${t("exportSaveOnly")}</span></button>
                        <button class="b3-button b3-button--outline" data-action="insert"
                            ${hasInk ? "" : "disabled"}><span>${t("exportInsert")}</span></button>
                    </div>
                    ${hasInk ? "" : `<div class="pa-export__note b3-label__text">${t("exportNone")}</div>`}
                </div>
            </div>
            <div class="b3-label config-item">
                <div class="fn__block">
                    <div class="config-name">${t("exportPdfSection")}</div>
                    <div class="b3-label__text">${t("exportPdfHint")}</div>
                    <div class="fn__hr"></div>
                    <button class="b3-button pa-export__pdf" data-action="pdf">
                        <span>${t("exportPdf")}</span>
                    </button>
                </div>
            </div>
        </div>`,
        width: "520px",
    });

    const el = dialog.element;
    const bg = (): "white" | "transparent" =>
        el.querySelector<HTMLInputElement>('input[name="pa-export-bg"]:checked')?.value === "transparent"
            ? "transparent" : "white";

    const busy = (on: boolean) => {
        el.querySelectorAll<HTMLButtonElement>(".pa-export button[data-action]")
            .forEach((b) => (b.disabled = on || (b.dataset.action !== "pdf" && !hasInk)));
    };

    const run = async (insert: boolean) => {
        busy(true);
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
            busy(false);
        }
    };

    const runPdf = async () => {
        const btn = el.querySelector<HTMLButtonElement>('[data-action="pdf"]');
        const label = btn?.textContent ?? "";
        busy(true);
        try {
            await exportNotePdf(overlay, (stage, done, total) => {
                if (btn) {
                    btn.textContent = stage === "prepare"
                        ? t("exportPdfPreparing", {done: String(done), total: String(total)})
                        : t("exportPdfProgress", {done: String(done), total: String(total)});
                }
            });
            showMessage(t("exportPdfDone"));
            dialog.destroy();
        } catch (e) {
            if (e instanceof PdfSaveCancelled) {
                if (btn) btn.textContent = label;
                busy(false);
                return;
            }
            console.error("[pencil-annotation] pdf export failed", e);
            showMessage(t("exportFailed", {msg: String((e as Error).message || e)}), undefined, "error");
            if (btn) btn.textContent = label;
            busy(false);
        }
    };

    el.querySelector<HTMLButtonElement>('[data-action="save"]')
        ?.addEventListener("click", () => void run(false));
    el.querySelector<HTMLButtonElement>('[data-action="insert"]')
        ?.addEventListener("click", () => void run(true));
    el.querySelector<HTMLButtonElement>('[data-action="pdf"]')
        ?.addEventListener("click", () => void runPdf());
}
