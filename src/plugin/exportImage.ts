import {paintStrokes, StrokeRenderer, type OffsetFn} from "../engine/renderer";
import type {DocStore} from "../engine/store";

/**
 * Composites all strokes of a document into a single PNG blob.
 * Highlighter is blended (multiply on white bg) so it looks like a real marker.
 * `offsets` applies block-anchor deltas so strokes land where they render.
 */
export function strokesToPngBlob(
    store: DocStore,
    bg: "white" | "transparent",
    offsets?: OffsetFn,
): Promise<Blob> {
    const bbox = store.contentBBox(offsets);
    if (!bbox) return Promise.reject(new Error("empty"));
    const pad = 12;
    const scale = 2;
    const width = Math.max(1, Math.ceil((bbox.maxX - bbox.minX) + pad * 2));
    const height = Math.max(1, Math.ceil((bbox.maxY - bbox.minY) + pad * 2));

    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return Promise.reject(new Error("no 2d context"));

    ctx.scale(scale, scale);
    if (bg === "white") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
    }
    const viewport = {
        originX: bbox.minX - pad,
        originY: bbox.minY - pad,
        width,
        height,
    };

    const renderer = new StrokeRenderer();
    // highlighter pass (multiply against white looks like a real marker)
    ctx.globalCompositeOperation = bg === "white" ? "multiply" : "source-over";
    paintStrokes(ctx, store.strokes, renderer, viewport, (s) => s.tool !== "highlighter", offsets);
    // ink pass
    ctx.globalCompositeOperation = "source-over";
    paintStrokes(ctx, store.strokes, renderer, viewport, (s) => s.tool !== "pen", offsets);

    return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))),
            "image/png",
        );
    });
}
