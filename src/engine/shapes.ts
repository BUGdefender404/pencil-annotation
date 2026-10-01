import type {Point} from "./types";

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

const segDist = (p: Point, a: Point, b: Point) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return dist(p, a);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

/** Ramer–Douglas–Peucker simplification of an open polyline (keeps source indices) */
const rdpIdx = (pts: Point[], eps: number): number[] => {
    if (pts.length < 3) return pts.map((_, i) => i);
    const keep = new Array<boolean>(pts.length).fill(false);
    keep[0] = keep[pts.length - 1] = true;
    const stack: Array<[number, number]> = [[0, pts.length - 1]];
    while (stack.length) {
        const [s, e] = stack.pop()!;
        let maxD = -1, idx = -1;
        for (let i = s + 1; i < e; i++) {
            const d = segDist(pts[i], pts[s], pts[e]);
            if (d > maxD) { maxD = d; idx = i; }
        }
        if (maxD > eps && idx > 0) {
            keep[idx] = true;
            stack.push([s, idx], [idx, e]);
        }
    }
    const out: number[] = [];
    for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(i);
    return out;
};

/** max deviation of raw[i0..i1] from the chord — decides if an edge is "straight" */
const edgeBulge = (raw: Point[], i0: number, i1: number) => {
    const a = raw[i0], b = raw[i1];
    const chord = dist(a, b) || 1;
    let maxDev = 0;
    for (let k = i0; k <= i1; k++) maxDev = Math.max(maxDev, segDist(raw[k], a, b));
    return maxDev / chord;
};

const avgPressure = (pts: Point[]) => pts.reduce((s, p) => s + p.p, 0) / Math.max(1, pts.length);

/** near-horizontal / near-vertical lines snap to the axis within this many degrees */
export const AXIS_SNAP_DEG = 8;

/**
 * GoodNotes-style shape recognition: given a freehand stroke, return the
 * "perfected" replacement points — a straight line, an axis-aligned rectangle,
 * a triangle or an ellipse — or null when the stroke doesn't resemble a shape.
 */
export const recognizeShape = (raw: Point[]): Point[] | null => {
    if (raw.length < 6) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of raw) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    const w = maxX - minX, h = maxY - minY;
    const diag = Math.hypot(w, h);
    if (diag < 40) return null;
    const first = raw[0], last = raw[raw.length - 1];
    const gap = dist(first, last);
    const closed = gap <= Math.max(28, diag * 0.3);
    const p = avgPressure(raw);

    if (!closed) {
        // straight line: nearly every point lies on the start-end segment
        const len = dist(first, last);
        if (len < diag * 0.75) return null; // doubles back — not a line
        let maxDev = 0;
        for (const pt of raw) maxDev = Math.max(maxDev, segDist(pt, first, last));
        if (maxDev > Math.max(10, len * 0.08)) return null;
        let ax = first.x, ay = first.y, bx = last.x, by = last.y;
        const ang = Math.atan2(last.y - first.y, last.x - first.x) * 180 / Math.PI;
        if (Math.abs(ang) <= AXIS_SNAP_DEG || Math.abs(Math.abs(ang) - 180) <= AXIS_SNAP_DEG) {
            ay = by = (first.y + last.y) / 2;
        } else if (Math.abs(Math.abs(ang) - 90) <= AXIS_SNAP_DEG) {
            ax = bx = (first.x + last.x) / 2;
        }
        return [{x: ax, y: ay, p}, {x: bx, y: by, p}];
    }

    // closed shapes: count dominant corners
    const idx = rdpIdx(raw, Math.max(6, diag * 0.04));
    const corners = idx.map(i => raw[i]);
    if (corners.length > 1 && dist(corners[0], corners[corners.length - 1]) < diag * 0.08) {
        corners.pop();
        idx.pop();
    }

    if (corners.length === 4) {
        const rightAngles = [0, 1, 2, 3].every(i => {
            const a = corners[i], b = corners[(i + 1) % 4], c = corners[(i + 2) % 4];
            const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
            const denom = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1;
            const cos = (v1x * v2x + v1y * v2y) / denom;
            const ang = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
            return Math.abs(ang - 90) <= 30;
        });
        // all four sides must hug their chords, else it's an ellipse-ish blob
        const edgesStraight = rightAngles && [0, 1, 2, 3].every(i => {
            const s = idx[i], e = i === 3 ? raw.length - 1 : idx[i + 1];
            return edgeBulge(raw, s, e) <= 0.13;
        });
        if (rightAngles && edgesStraight) {
            // crisp axis-aligned rectangle spanning the drawn extents
            return [
                {x: minX, y: minY, p}, {x: maxX, y: minY, p},
                {x: maxX, y: maxY, p}, {x: minX, y: maxY, p},
                {x: minX, y: minY, p},
            ];
        }
    }
    if (corners.length === 3) {
        const [a, b, c] = corners;
        return [{...a, p}, {...b, p}, {...c, p}, {...a, p}];
    }
    if (Math.min(w, h) >= 8) {
        // ellipse inscribed in the drawn bbox
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        const rx = w / 2, ry = h / 2;
        const out: Point[] = [];
        for (let i = 0; i <= 72; i++) {
            const t = (i / 72) * Math.PI * 2;
            out.push({x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t), p});
        }
        return out;
    }
    return null;
};
