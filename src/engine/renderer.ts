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
    private cache = new Map<string, { rev: string; path: Path2D; bbox: BBox }>();

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
            streamline: stroke.tool === "highlighter" ? 0.5 : 0.42,
            simulatePressure: false, // pressure values are precomputed per point
            easing: (t) => Math.sin((t * Math.PI) / 2),
            last: !live,
        });
    }

    /** Path2D in document coordinates for the given stroke. */
    getPath(stroke: Stroke, live = false): { path: Path2D; bbox: BBox } {
        const rev = StrokeRenderer.rev(stroke);
        const cached = this.cache.get(stroke.id);
        if (cached && cached.rev === rev && !live) {
            return cached;
        }
        const outline = StrokeRenderer.outline(stroke, live);
        const path = new Path2D();
        if (outline.length > 0) {
            path.moveTo(outline[0][0], outline[0][1]);
            for (let i = 1; i < outline.length; i++) {
                path.lineTo(outline[i][0], outline[i][1]);
            }
            path.closePath();
        }
        const bbox = strokeBBox(stroke);
        if (!live) {
            this.cache.set(stroke.id, {rev, path, bbox});
        }
        return {path, bbox};
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
        const {path, bbox} = renderer.getPath(stroke);
        if (!bboxesIntersect(bbox, view)) continue;
        ctx.globalAlpha = stroke.opacity;
        ctx.fillStyle = stroke.color;
        ctx.fill(path);
    }
    ctx.restore();
};

export const paintOne = (
    ctx: CanvasRenderingContext2D,
    stroke: Stroke,
    renderer: StrokeRenderer,
    viewport: Viewport,
) => {
    ctx.save();
    ctx.translate(-viewport.originX, -viewport.originY);
    const {path} = renderer.getPath(stroke, true);
    ctx.globalAlpha = stroke.opacity;
    ctx.fillStyle = stroke.color;
    ctx.fill(path);
    ctx.restore();
};
