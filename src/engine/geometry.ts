import type {Point, Stroke} from "./types";

export interface BBox {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export const strokeBBox = (stroke: Stroke): BBox => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of stroke.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
    }
    const pad = stroke.width / 2 + 2;
    return {minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad};
};

export const bboxesIntersect = (a: BBox, b: BBox): boolean =>
    a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

export const unionBBox = (boxes: BBox[]): BBox | null => {
    if (boxes.length === 0) return null;
    return {
        minX: Math.min(...boxes.map((b) => b.minX)),
        minY: Math.min(...boxes.map((b) => b.minY)),
        maxX: Math.max(...boxes.map((b) => b.maxX)),
        maxY: Math.max(...boxes.map((b) => b.maxY)),
    };
};

/** squared distance from point p to segment a-b */
const distSqToSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
    const abx = bx - ax, aby = by - ay;
    const lenSq = abx * abx + aby * aby;
    let t = lenSq > 0 ? ((px - ax) * abx + (py - ay) * aby) / lenSq : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = ax + abx * t - px, dy = ay + aby * t - py;
    return dx * dx + dy * dy;
};

/**
 * True when the segment (x1,y1)-(x2,y2) passes within `threshold` doc px
 * of any sample of the stroke. Used by the eraser (segment sweep) and by
 * tap-selection (point input degenerates to a tiny segment).
 */
export const segmentHitsStroke = (
    stroke: Stroke,
    x1: number, y1: number, x2: number, y2: number,
    threshold: number,
): boolean => {
    const bbox = strokeBBox(stroke);
    const hitBox: BBox = {
        minX: Math.min(x1, x2) - threshold,
        minY: Math.min(y1, y2) - threshold,
        maxX: Math.max(x1, x2) + threshold,
        maxY: Math.max(y1, y2) + threshold,
    };
    if (!bboxesIntersect(bbox, hitBox)) return false;

    const pts = stroke.points;
    if (pts.length === 1) {
        return distSqToSegment(pts[0].x, pts[0].y, x1, y1, x2, y2) <= threshold * threshold;
    }
    // every stroke segment is tested against the sweep segment. Sampling
    // stroke POINTS instead (the old approach, with decimation on top)
    // leaves coverage holes exactly where fast strokes store sparse
    // samples — the eraser then needs repeated scrubs over the same spot.
    const thrSq = threshold * threshold;
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        if (distSqSegToSeg(a.x, a.y, b.x, b.y, x1, y1, x2, y2) <= thrSq) return true;
    }
    return false;
};

/** squared distance between two segments; degenerate segments (a point) fall
 *  out of the point-to-segment fallbacks naturally */
const distSqSegToSeg = (
    ax: number, ay: number, bx: number, by: number,
    cx: number, cy: number, dx: number, dy: number,
): number => {
    // straddle test: proper crossing means distance 0
    const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
    const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
    const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
        ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
    return Math.min(
        distSqToSegment(ax, ay, cx, cy, dx, dy),
        distSqToSegment(bx, by, cx, cy, dx, dy),
        distSqToSegment(cx, cy, ax, ay, bx, by),
        distSqToSegment(dx, dy, ax, ay, bx, by),
    );
};

export const pointHitsStroke = (stroke: Stroke, x: number, y: number, threshold: number): boolean =>
    segmentHitsStroke(stroke, x, y, x + 0.01, y + 0.01, threshold);

export const translateStroke = (stroke: Stroke, dx: number, dy: number) => {
    for (const p of stroke.points) {
        p.x = Math.round((p.x + dx) * 100) / 100;
        p.y = Math.round((p.y + dy) * 100) / 100;
    }
};

/** Zero-phase smoothing for committed ink: two passes of the [1,2,1]/4 kernel
 *  over interior points. Directional filters (perfect-freehand's streamline)
 *  lag proportionally to segment length and shear sparse polygons, so
 *  smoothing happens once here instead — symmetric, so corners are not
 *  displaced. Strokes with fewer than minCount points (snapped rectangles,
 *  lines, triangles) are already exact and pass through untouched. */
export const smoothDense = (points: Point[], minCount = 12): Point[] => {
    if (points.length < minCount) return points;
    let pts = points.slice();
    for (let pass = 0; pass < 2; pass++) {
        const next = pts.slice();
        for (let i = 1; i < pts.length - 1; i++) {
            next[i] = {
                x: (pts[i - 1].x + 2 * pts[i].x + pts[i + 1].x) / 4,
                y: (pts[i - 1].y + 2 * pts[i].y + pts[i + 1].y) / 4,
                p: pts[i].p,
            };
        }
        pts = next;
    }
    return pts;
};

export const newId = (): string =>
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
