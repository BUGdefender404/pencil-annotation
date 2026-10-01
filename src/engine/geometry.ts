import type {Stroke} from "./types";

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

    // decimate long strokes for cheaper hit tests
    const step = Math.max(1, Math.floor(stroke.points.length / 120));
    const pts = stroke.points;
    const thrSq = threshold * threshold;
    for (let i = 0; i < pts.length - 1; i += step) {
        const a = pts[i];
        const b = pts[Math.min(i + step, pts.length - 1)];
        if (distSqToSegment(a.x, a.y, x1, y1, x2, y2) <= thrSq ||
            distSqToSegment(b.x, b.y, x1, y1, x2, y2) <= thrSq) return true;
    }
    return false;
};

export const pointHitsStroke = (stroke: Stroke, x: number, y: number, threshold: number): boolean =>
    segmentHitsStroke(stroke, x, y, x + 0.01, y + 0.01, threshold);

export const translateStroke = (stroke: Stroke, dx: number, dy: number) => {
    for (const p of stroke.points) {
        p.x = Math.round((p.x + dx) * 100) / 100;
        p.y = Math.round((p.y + dy) * 100) / 100;
    }
};

export const newId = (): string =>
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
