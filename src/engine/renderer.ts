import {getStroke} from "perfect-freehand";
import {bboxesIntersect, strokeBBox, type BBox} from "./geometry";
import type {Stroke} from "./types";

/**
 * Turns a stroke into the outline polygon that perfect-freehand generates
 * (pressure-aware for real stylus input, velocity-aware for mouse/touch),
 * and caches the resulting Path2D + bbox per stroke revision so panning,
 * scrolling and full redraws stay cheap.
 */
export class StrokeRenderer {
    private cache = new Map<string, { rev: string; path: Path2D; bbox: BBox; strokeWidth: number }>();

    private static rev(stroke: Stroke): string {
        const pts = stroke.points;
        const first = pts[0], last = pts[pts.length - 1];
        return `${pts.length}|${first ? first.x : 0},${first ? first.y : 0}|${last ? last.x : 0},${last ? last.y : 0}`;
    }

    private static outline(stroke: Stroke, live: boolean): number[][] {
        // perfect-freehand accepts [x, y, pressure] tuples
        const points: [number, number, number][] =
            stroke.points.map((p) => [p.x, p.y, Math.max(0.02, p.p)]);
        return getStroke(points, {
            size: stroke.width,
            thinning: stroke.simulate || stroke.tool === "highlighter" ? 0 : 0.55,
            smoothing: 0.58,
            // streamline must stay 0: it is a per-sample positional lag (each
            // outline point stops short of its predecessor), invisible on
            // dense handwriting but enough to shear sparse polygons — a
            // 5-point snapped rectangle came out as a tilted parallelogram.
            // Ink smoothing happens once at commit time instead
            // (smoothDense in geometry.ts, applied by overlay.commitStroke).
            streamline: 0,
            simulatePressure: false, // pressure values are precomputed per point
            easing: (t) => Math.sin((t * Math.PI) / 2),
            last: !live,
        });
    }

    /**
     * Path in document coordinates for the given stroke, plus `strokeWidth`:
     * 0 means "fill this outline path" (pressure-aware ink); a positive value
     * means "ctx.stroke() this centerline at that width". Constant-width
     * strokes (uniform pressure, highlighter, simulated input) must be
     * stroked, not filled: perfect-freehand's outline polygon self-intersects
     * at sharp corners and the fill winding then punches holes and uneven
     * width into snapped right-angle rectangles. A dot (nothing to stroke)
     * still goes through perfect-freehand for its round shape.
     */
    getPath(stroke: Stroke, live = false): { path: Path2D; bbox: BBox; strokeWidth: number } {
        const rev = StrokeRenderer.rev(stroke);
        const cached = this.cache.get(stroke.id);
        if (cached && cached.rev === rev && !live) {
            return cached;
        }
        const bbox = strokeBBox(stroke);
        const diag = Math.hypot(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY);
        const thinning = stroke.simulate || stroke.tool === "highlighter" ? 0 : 0.55;
        const uniformP = stroke.points.length > 0 &&
            stroke.points.every((q) => Math.abs(q.p - stroke.points[0].p) < 0.02);
        const asLine = diag >= 6 && (thinning === 0 || uniformP);
        const path = new Path2D();
        let strokeWidth = 0;
        if (asLine) {
            path.moveTo(stroke.points[0].x, stroke.points[0].y);
            for (let i = 1; i < stroke.points.length; i++) {
                path.lineTo(stroke.points[i].x, stroke.points[i].y);
            }
            // match the ribbon width perfect-freehand would have produced:
            // thinning 0 → full size; otherwise radius size·easing(0.5) per side
            strokeWidth = thinning === 0
                ? stroke.width
                : stroke.width * 2 * Math.sin(Math.PI / 4);
        } else {
            const outline = StrokeRenderer.outline(stroke, live);
            if (outline.length > 0) {
                path.moveTo(outline[0][0], outline[0][1]);
                for (let i = 1; i < outline.length; i++) {
                    path.lineTo(outline[i][0], outline[i][1]);
                }
                path.closePath();
            }
        }
        const result = {rev, path, bbox, strokeWidth};
        if (!live) {
            this.cache.set(stroke.id, result);
        }
        return result;
    }

    forget(id: string) {
        this.cache.delete(id);
    }

    clear() {
        this.cache.clear();
    }
}

export interface Viewport {
    /** doc-space coordinate at the canvas' top-left corner */
    originX: number;
    originY: number;
    width: number;
    height: number;
}

/** per-stroke render offset (block-anchor delta in doc coords) */
export type OffsetFn = (stroke: Stroke) => {dx: number; dy: number};

/**
 * Paints strokes onto a 2d context. The caller has already applied the
 * device-pixel-ratio transform; coordinates passed in are document coords
 * translated so that `viewport.origin` maps to the canvas' top-left.
 */
export const paintStrokes = (
    ctx: CanvasRenderingContext2D,
    strokes: Stroke[],
    renderer: StrokeRenderer,
    viewport: Viewport,
    skip?: (stroke: Stroke) => boolean,
    offsets?: OffsetFn,
) => {
    ctx.save();
    ctx.translate(-viewport.originX, -viewport.originY);
    const view: BBox = {
        minX: viewport.originX,
        minY: viewport.originY,
        maxX: viewport.originX + viewport.width,
        maxY: viewport.originY + viewport.height,
    };
    // strokes are painted in array order; highlighters and ink share one
    // array but render into separate canvases (see overlay)
    for (const stroke of strokes) {
        if (skip && skip(stroke)) continue;
        const off = offsets ? offsets(stroke) : {dx: 0, dy: 0};
        const {path, bbox, strokeWidth} = renderer.getPath(stroke);
        if (!bboxesIntersect(
            {minX: bbox.minX + off.dx, minY: bbox.minY + off.dy, maxX: bbox.maxX + off.dx, maxY: bbox.maxY + off.dy},
            view,
        )) continue;
        ctx.save();
        ctx.translate(off.dx, off.dy);
        ctx.globalAlpha = stroke.opacity;
        if (strokeWidth > 0) {
            ctx.strokeStyle = stroke.color;
            ctx.lineWidth = strokeWidth;
            ctx.lineJoin = "round";
            ctx.lineCap = "round";
            ctx.stroke(path);
        } else {
            ctx.fillStyle = stroke.color;
            ctx.fill(path);
        }
        ctx.restore();
    }
    ctx.restore();
};

export const paintOne = (
    ctx: CanvasRenderingContext2D,
    stroke: Stroke,
    renderer: StrokeRenderer,
    viewport: Viewport,
    offset?: {dx: number; dy: number},
    live = true,
) => {
    ctx.save();
    ctx.translate(-viewport.originX, -viewport.originY);
    if (offset) ctx.translate(offset.dx, offset.dy);
    const {path, strokeWidth} = renderer.getPath(stroke, live);
    ctx.globalAlpha = stroke.opacity;
    if (strokeWidth > 0) {
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = strokeWidth;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke(path);
    } else {
        ctx.fillStyle = stroke.color;
        ctx.fill(path);
    }
    ctx.restore();
};
