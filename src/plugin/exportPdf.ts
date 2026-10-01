import {domToCanvas} from "modern-screenshot";
import {jsPDF} from "jspdf";
import {paintStrokes, StrokeRenderer} from "../engine/renderer";
import type {DocOverlay} from "../overlay/overlay";

export type PdfProgress = (stage: "prepare" | "page", done: number, total: number) => void;

/** iOS Safari caps canvas area at ~16.7M px² and the side at ~4096px */
const isIOS = typeof navigator !== "undefined" &&
    (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/**
 * Exports the whole document (rendered content) with the ink layer composited
 * on top as a paged PDF — the notebook-style export.
 *
 * The document is captured with the browser's own renderer (foreignObject, so
 * CSS/KaTeX stay faithful) in vertical chunks that respect canvas limits, then
 * sliced into A4-ratio pages that prefer to break at block seams. Ink is
 * painted per page with the same block-anchored offsets the overlay uses, so
 * it lands exactly where it does on screen.
 */
export async function buildNotePdfBlob(
    overlay: DocOverlay,
    onProgress: PdfProgress,
): Promise<{blob: Blob; name: string}> {
    const w = overlay.protyle.wysiwyg?.element;
    if (!w || !w.isConnected) throw new Error("document element not ready");
    const width = w.clientWidth;
    const docH = w.scrollHeight;
    if (width < 50 || docH < 50) throw new Error("document is empty");

    const areaBudget = isIOS ? 15e6 : 200e6;
    const maxSide = isIOS ? 3800 : 15000;
    const scale = Math.max(0.5, Math.min(2, window.devicePixelRatio || 1,
        maxSide / docH, Math.sqrt(areaBudget / (docH * width))));
    const bg = docBackground(w);
    const pageW = width;
    const pageH = Math.round(width * 842 / 595); // A4 aspect at content width

    // 1) capture the document in vertical chunks (one chunk when it fits)
    const chunkH = Math.max(200, Math.min(docH,
        Math.floor(maxSide / scale), Math.floor(areaBudget / (width * scale * scale))));
    const chunkCount = Math.ceil(docH / chunkH);
    const chunks: HTMLCanvasElement[] = [];
    const chunkY: number[] = [];
    const clone = w.cloneNode(true) as HTMLElement;
    for (let y = 0; y < docH; y += chunkH) {
        const h = Math.min(chunkH, docH - y);
        chunks.push(await captureSlice(clone, y, h, width, scale, bg));
        chunkY.push(y);
        onProgress("prepare", chunks.length, chunkCount);
    }
    const capturedH = chunks.reduce((s, c) => s + c.height, 0) / scale;

    // 2) page boundaries: prefer block seams, keep every page reasonably full
    const wr = w.getBoundingClientRect();
    const bottoms = [...w.querySelectorAll<HTMLElement>(":scope > [data-node-id]")]
        .map((b) => b.getBoundingClientRect().bottom - wr.top + w.scrollTop)
        .sort((a, b) => a - b);
    const pages: Array<[number, number]> = [];
    let y0 = 0;
    while (y0 < capturedH - 2) {
        const target = y0 + pageH;
        let best = -1;
        for (const b of bottoms) if (b <= target && b > best) best = b;
        const cut = best > y0 + 60 ? Math.round(best) : Math.min(target, capturedH);
        pages.push([y0, Math.min(cut, capturedH)]);
        y0 = pages[pages.length - 1][1];
    }
    if (pages.length === 0) pages.push([0, capturedH]);

    // 3) compose each page: document slice + ink, then hand to jsPDF
    const pagePt: [number, number] = [pageW * 0.75, pageH * 0.75];
    const pdf = new jsPDF({unit: "pt", format: pagePt, compress: true});
    const renderer = new StrokeRenderer();
    const offsets = overlay.strokeOffsets();
    const strokes = overlay.store.strokes;
    for (let i = 0; i < pages.length; i++) {
        const [py0, py1] = pages[i];
        const pc = document.createElement("canvas");
        pc.width = Math.round(pageW * scale);
        pc.height = Math.round(pageH * scale);
        const ctx = pc.getContext("2d");
        if (!ctx) throw new Error("no 2d context");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, pc.width, pc.height);
        drawDocRange(ctx, chunks, chunkY, scale, py0, py1 - py0);
        // ink (highlighter under pen, exactly like the live overlay)
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        const viewport = {originX: 0, originY: py0, width: pageW, height: pageH};
        ctx.globalCompositeOperation = "multiply";
        paintStrokes(ctx, strokes, renderer, viewport, (s) => s.tool !== "highlighter", offsets);
        ctx.globalCompositeOperation = "source-over";
        paintStrokes(ctx, strokes, renderer, viewport, (s) => s.tool !== "pen", offsets);
        ctx.globalCompositeOperation = "source-over";
        if (i > 0) pdf.addPage(pagePt, "portrait");
        pdf.addImage(pc.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, pagePt[0], pagePt[1]);
        onProgress("page", i + 1, pages.length);
    }
    return {blob: pdf.output("blob"), name: suggestPdfName(overlay)};
}

/** renders the PDF and saves it (native dialog on desktop, download on mobile) */
export async function exportNotePdf(overlay: DocOverlay, onProgress: PdfProgress): Promise<void> {
    const name = suggestPdfName(overlay);
    // ask for the destination FIRST so the call still runs inside the user
    // gesture — a picker opened after the long render would be rejected
    const target = await openPdfSaveTarget(name);
    const {blob} = await buildNotePdfBlob(overlay, onProgress);
    if (target) {
        await target.write(blob);
        return;
    }
    // iOS Safari / Android: anchor download (lands in Files/Downloads)
    const url = URL.createObjectURL(blob);
    try {
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
    } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
}

export class PdfSaveCancelled extends Error {
    constructor() {
        super("pdf save cancelled");
    }
}

/** returns a file writer on desktop Chromium, or null where the picker
 *  is unavailable (iOS/Android) — throws PdfSaveCancelled when dismissed */
async function openPdfSaveTarget(name: string): Promise<{write(blob: Blob): Promise<void>} | null> {
    const picker = (window as unknown as {showSaveFilePicker?: (opts: unknown) => Promise<unknown>}).showSaveFilePicker;
    if (typeof picker !== "function") return null;
    let handle: {createWritable(): Promise<{write(data: Blob): Promise<void>; close(): Promise<void>}>};
    try {
        handle = await picker.call(window, {
            suggestedName: name,
            types: [{description: "PDF", accept: {"application/pdf": [".pdf"]}}],
        }) as typeof handle;
    } catch (e) {
        if ((e as DOMException)?.name === "AbortError") throw new PdfSaveCancelled();
        return null; // picker unavailable → fall back to the anchor download
    }
    return {
        write: async (blob) => {
            const w = await handle.createWritable();
            await w.write(blob);
            await w.close();
        },
    };
}

/** captures [y, y+h) of the document clone into a canvas */
async function captureSlice(
    clone: HTMLElement,
    y: number,
    h: number,
    width: number,
    scale: number,
    bg: string,
): Promise<HTMLCanvasElement> {
    const wrap = document.createElement("div");
    // offscreen but fully opaque — the snapshot reads these styles as-is
    wrap.style.cssText =
        `position:fixed;left:-99999px;top:0;width:${width}px;height:${h}px;` +
        `overflow:hidden;z-index:-1;pointer-events:none;`;
    clone.style.margin = "0";
    clone.style.transform = `translateY(${-y}px)`;
    wrap.appendChild(clone);
    document.body.appendChild(wrap);
    try {
        return await domToCanvas(wrap, {scale, backgroundColor: bg});
    } finally {
        wrap.remove(); // keeps the clone alive for the next chunk
    }
}

/** draws the doc-space range [y0, y0+h) from the captured chunks onto ctx */
function drawDocRange(
    ctx: CanvasRenderingContext2D,
    chunks: HTMLCanvasElement[],
    chunkY: number[],
    scale: number,
    y0: number,
    h: number,
) {
    for (let i = 0; i < chunks.length; i++) {
        const ch = chunks[i];
        const cy0 = chunkY[i];
        const cy1 = cy0 + ch.height / scale;
        const s = Math.max(y0, cy0);
        const e = Math.min(y0 + h, cy1);
        if (e <= s) continue;
        ctx.drawImage(
            ch,
            0, Math.round((s - cy0) * scale), ch.width, Math.round((e - s) * scale),
            0, Math.round((s - y0) * scale), ch.width, Math.round((e - s) * scale),
        );
    }
}

/** first non-transparent background from the wysiwyg up to the root */
function docBackground(el: HTMLElement): string {
    let n: HTMLElement | null = el;
    while (n) {
        const c = getComputedStyle(n).backgroundColor;
        if (c && c !== "transparent" && !/rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)/.test(c)) return c;
        n = n.parentElement;
    }
    return "#ffffff";
}

function suggestPdfName(overlay: DocOverlay): string {
    const t = overlay.protyle.element
        .querySelector<HTMLElement>(".protyle-title .protyle-title__input")
        ?.textContent?.trim();
    const base = (t && t.length > 0 ? t : overlay.docId)
        .replace(/[\\/:*?"<>|\n\r]/g, "_")
        .slice(0, 60);
    return `${base || "note"}.pdf`;
}
