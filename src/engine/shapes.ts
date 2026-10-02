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

const avgPressure = (pts: Point[]) => pts.reduce((s, p) => s + p.p, 0) / Math.max(1, pts.length);

/** interior angle at point b between the segments a-b and b-c, in degrees */
const interiorAngle = (a: Point, b: Point, c: Point) => {
    const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
    const denom = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1;
    const cos = (v1x * v2x + v1y * v2y) / denom;
    return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
};

const polygonArea = (pts: Point[]) => {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length];
        a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
};

/**
 * A genuine shape stroke winds around its centroid once, give or take a
 * retrace — people often trace a rectangle 1.5 times while drawing it. The
 * winding of the POSITION vector is immune to out-and-back spikes (they never
 * advance the angle); double loops wind 720° and back-and-forth doodles net
 * roughly zero — both rejected before any candidate fit is attempted.
 */
const windsOnce = (pts: Point[], cx: number, cy: number) => {
    let sum = 0;
    let prev: number | null = null;
    for (const p of pts) {
        const ang = Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI;
        if (prev !== null) {
            let d = ang - prev;
            d = ((d % 360) + 540) % 360 - 180;
            sum += d;
        }
        prev = ang;
    }
    return Math.abs(sum) >= 300 && Math.abs(sum) <= 600;
};

/** near-horizontal / near-vertical lines snap to the axis within this many degrees */
export const AXIS_SNAP_DEG = 8;
/** a candidate wins only when it hugs the stroke this closely (× diag) */
const SNAP_RESIDUAL = 0.055;

/**
 * mean distance from the raw points to the nearest edge of a closed polygon
 * (poly is given closed: last point === first point)
 */
const polyResidual = (raw: Point[], poly: Point[]) => {
    let sum = 0;
    for (const pt of raw) {
        let best = Infinity;
        for (let i = 0; i + 1 < poly.length; i++) {
            const d = segDist(pt, poly[i], poly[i + 1]);
            if (d < best) best = d;
        }
        sum += best;
    }
    return sum / Math.max(1, raw.length);
};

/** rectangle spanning the points, axis-aligned in the frame rotated by deg */
const rectCandidate = (
    raw: Point[],
    deg: number,
    cx: number,
    cy: number,
    p: number,
): Point[] => {
    const th = deg * Math.PI / 180;
    const c = Math.cos(th), s = Math.sin(th);
    let rminX = Infinity, rminY = Infinity, rmaxX = -Infinity, rmaxY = -Infinity;
    for (const pt of raw) {
        const dx = pt.x - cx, dy = pt.y - cy;
        const rx = dx * c + dy * s;
        const ry = -dx * s + dy * c;
        if (rx < rminX) rminX = rx;
        if (rx > rmaxX) rmaxX = rx;
        if (ry < rminY) rminY = ry;
        if (ry > rmaxY) rmaxY = ry;
    }
    const corner = (rx: number, ry: number): Point => ({
        x: cx + rx * c - ry * s,
        y: cy + rx * s + ry * c,
        p,
    });
    return [
        corner(rminX, rminY), corner(rmaxX, rminY),
        corner(rmaxX, rmaxY), corner(rminX, rmaxY),
        corner(rminX, rminY),
    ];
};

const ellipseCandidate = (minX: number, minY: number, maxX: number, maxY: number, p: number): Point[] => {
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const rx = (maxX - minX) / 2, ry = (maxY - minY) / 2;
    const out: Point[] = [];
    for (let i = 0; i <= 72; i++) {
        const t = (i / 72) * Math.PI * 2;
        out.push({x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t), p});
    }
    return out;
};

const ellipseResidual = (raw: Point[], minX: number, minY: number, maxX: number, maxY: number) => {
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const rx = (maxX - minX) / 2 || 1, ry = (maxY - minY) / 2 || 1;
    const unit = Math.min(rx, ry);
    let sum = 0;
    for (const pt of raw) {
        const r = Math.hypot((pt.x - cx) / rx, (pt.y - cy) / ry);
        sum += Math.abs(r - 1) * unit;
    }
    return sum / Math.max(1, raw.length);
};

/**
 * dominant corners of the closed loop: RDP rooted at the point farthest from
 * the centroid (the raw start can be mid-edge, and RDP always keeps the
 * endpoints, which would fake a corner there), then the shallowest extra
 * kinks are dropped while there are more than six candidates left.
 * Returns the corners together with their indices in the re-rooted loop so
 * callers can inspect the edge arcs between them.
 */
const dominantCorners = (raw: Point[], minX: number, minY: number, maxX: number, maxY: number): {
    corners: Point[]; loop: Point[]; idx: number[];
} => {
    let startIdx = 0, far = -1;
    const icx = (minX + maxX) / 2, icy = (minY + maxY) / 2;
    for (let i = 0; i < raw.length; i++) {
        const d = (raw[i].x - icx) * (raw[i].x - icx) + (raw[i].y - icy) * (raw[i].y - icy);
        if (d > far) { far = d; startIdx = i; }
    }
    const loop = raw.slice(startIdx).concat(raw.slice(0, startIdx + 1));
    const diag = Math.hypot(maxX - minX, maxY - minY);
    const idx0 = rdpIdx(loop, Math.max(6, diag * 0.04));
    const corners = idx0.map(i => loop[i]);
    if (corners.length > 1 && dist(corners[0], corners[corners.length - 1]) < diag * 0.08) {
        corners.pop();
    }
    while (corners.length > 6) {
        let flat = -1, flatAng = -1;
        for (let i = 0; i < corners.length; i++) {
            const ang = interiorAngle(
                corners[(i + corners.length - 1) % corners.length],
                corners[i],
                corners[(i + 1) % corners.length],
            );
            if (ang > flatAng) { flatAng = ang; flat = i; }
        }
        if (flatAng < 155) break;
        corners.splice(flat, 1);
    }
    return {corners, loop, idx: idx0};
};

/**
 * Brute-force rectangle: a closed stroke with four real corners, quad-ish
 * interior angles and straight-ish edges IS a rectangle however skewed the
 * user drew it — snap it to the axis-aligned right-angle bbox rectangle
 * without entering the fit competition at all (an ellipse would sometimes
 * steal it, and a slanted "perfected" rectangle is never what annotating
 * means). What keeps genuine ellipses out is edge straightness: an arc cut
 * into four segments bulges ~0.2 of its chords, hand-drawn quad edges stay
 * under ~0.1.
 */
const forcedQuadRect = (
    loop: Point[],
    idx: number[],
    corners: Point[],
    p: number,
): Point[] | null => {
    const cs = corners.slice();
    // rounded corners blunt the RDP vertex below 180°; drop the flattest
    // corner while clearly shallow until four remain
    while (cs.length > 4) {
        let flat = -1, flatAng = -1;
        for (let i = 0; i < cs.length; i++) {
            const ang = interiorAngle(
                cs[(i + cs.length - 1) % cs.length], cs[i], cs[(i + 1) % cs.length]);
            if (ang > flatAng) { flatAng = ang; flat = i; }
        }
        if (flatAng < 135) break;
        cs.splice(flat, 1);
    }
    if (cs.length !== 4) return null;
    // quadrilateral angles: rules out triangles and blobs, allows skew
    for (let i = 0; i < 4; i++) {
        const ang = interiorAngle(cs[(i + 3) % 4], cs[i], cs[(i + 1) % 4]);
        if (ang < 50 || ang > 145) return null;
    }
    // straight edges — judged by MEAN deviation so a single wobble kink on
    // an edge can't disqualify the box; an ellipse's arc bulges along its
    // whole length and stays roughly twice above this line
    for (let k = 0; k < 4; k++) {
        const a = loop[idx[k]], b = loop[idx[k + 1]];
        const chord = dist(a, b) || 1;
        let sum = 0, n = 0;
        for (let i = idx[k]; i <= idx[k + 1]; i++) {
            sum += segDist(loop[i], a, b);
            n++;
        }
        if (sum / n / chord > 0.07) return null;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pt of loop) {
        if (pt.x < minX) minX = pt.x;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.y > maxY) maxY = pt.y;
    }
    return [
        {x: minX, y: minY, p}, {x: maxX, y: minY, p},
        {x: maxX, y: maxY, p}, {x: minX, y: maxY, p},
        {x: minX, y: minY, p},
    ];
};

/**
 * GoodNotes-style shape recognition: given a freehand stroke, return the
 * "perfected" replacement points — a straight line, a rectangle (any tilt),
 * a triangle or an ellipse — or null when the stroke doesn't resemble a shape.
 *
 * Closed shapes are classified by FIT, not by corner-count rules: rectangle /
 * triangle / ellipse candidates compete on how closely they hug the drawn
 * points, so a sloppy rectangle can never be stolen by the ellipse fallback
 * and a kinked triangle can never turn into a rectangle.
 */
export const recognizeShape = (input: Point[]): Point[] | null => {
    if (input.length < 6) return null;
    // Quick closures often overshoot the start point; the spike would bias
    // every fit. Trim the tail where the path comes nearest to the start
    // again, and judge closedness by that nearest approach.
    let endIdx = input.length - 1;
    let nearest = Infinity;
    const tailFrom = Math.floor(input.length * 0.7);
    for (let i = tailFrom; i < input.length; i++) {
        const d = dist(input[i], input[0]);
        if (d < nearest) { nearest = d; endIdx = i; }
    }
    const raw = input.slice(0, endIdx + 1);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of raw) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    const diag = Math.hypot(maxX - minX, maxY - minY);
    if (diag < 40) return null;
    const p = avgPressure(raw);
    const closed = nearest <= Math.max(28, diag * 0.3);

    if (!closed) {
        const first = raw[0], last = raw[raw.length - 1];
        // straight line: nearly every point lies on the start-end segment
        const len = dist(first, last);
        if (len >= diag * 0.75) { // else it doubles back — not a line
            let maxDev = 0;
            for (const pt of raw) maxDev = Math.max(maxDev, segDist(pt, first, last));
            if (maxDev <= Math.max(10, len * 0.08)) {
                let ax = first.x, ay = first.y, bx = last.x, by = last.y;
                const ang = Math.atan2(last.y - first.y, last.x - first.x) * 180 / Math.PI;
                if (Math.abs(ang) <= AXIS_SNAP_DEG || Math.abs(Math.abs(ang) - 180) <= AXIS_SNAP_DEG) {
                    ay = by = (first.y + last.y) / 2;
                } else if (Math.abs(Math.abs(ang) - 90) <= AXIS_SNAP_DEG) {
                    ax = bx = (first.x + last.x) / 2;
                }
                return [{x: ax, y: ay, p}, {x: bx, y: by, p}];
            }
        }
        // an outline with only the closing side missing (three sides of a
        // rectangle, say) closes itself into the shape
        if (nearest <= Math.max(45, diag * 0.5)) {
            return loopShape(raw.concat([{x: first.x, y: first.y, p: first.p}]), true);
        }
        return null;
    }
    return loopShape(raw, false);
};

/**
 * Closed-shape pipeline: every candidate shape competes on fit residual and
 * the winner must hug the stroke closely enough. With `rectOnly` (open
 * strokes relying on an implicit closing side) only rectangles are offered.
 */
const loopShape = (raw: Point[], rectOnly: boolean): Point[] | null => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of raw) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    const w = maxX - minX, h = maxY - minY;
    const diag = Math.hypot(w, h);
    const p = avgPressure(raw);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;

    // scribbles and dented doodles are not shapes at all — leave them alone
    if (!windsOnce(raw, cx, cy)) return null;

    let best: {score: number; pts: Point[]} | null = null;
    const offer = (res: number, pts: Point[], pref: number) => {
        const score = res * pref;
        if (!best || score < best.score) best = {score, pts};
    };

    // brute-force quad: four corners + straight edges → right-angle rectangle,
    // no competition (this is what "draw a box" means while annotating)
    const dc = dominantCorners(raw, minX, minY, maxX, maxY);
    const forced = forcedQuadRect(dc.loop, dc.idx, dc.corners, p);
    if (forced) return forced;

    // rect fallback: when the strict quad test misses (very wobbly edges,
    // extra kinks), the fit competition still awards an axis-aligned rectangle
    {
        let bRes = Infinity;
        for (let deg = 0; deg < 90; deg += 3) {
            bRes = Math.min(bRes, polyResidual(raw, rectCandidate(raw, deg, cx, cy, p)));
        }
        if (bRes < Infinity) {
            offer(bRes, [
                {x: minX, y: minY, p}, {x: maxX, y: minY, p},
                {x: maxX, y: maxY, p}, {x: minX, y: maxY, p},
                {x: minX, y: minY, p},
            ], 0.85);
        }
    }

    if (!rectOnly) {
        // triangle: every 3-corner subset of the dominant corners competes
        const corners = dc.corners;
        const n = corners.length;
        const minArea = Math.max(64, diag * diag * 0.004);
        for (let a = 0; a < n; a++) {
            for (let b = a + 1; b < n; b++) {
                for (let c = b + 1; c < n; c++) {
                    const tri = [corners[a], corners[b], corners[c]];
                    if (polygonArea(tri) < minArea) continue;
                    const pts = [tri[0], tri[1], tri[2], tri[0]];
                    offer(polyResidual(raw, pts), pts, 1);
                }
            }
        }
        if (Math.min(w, h) >= 8) {
            offer(
                ellipseResidual(raw, minX, minY, maxX, maxY),
                ellipseCandidate(minX, minY, maxX, maxY, p),
                1.05,
            );
        }
    }

    if (best && best.score <= diag * SNAP_RESIDUAL) return best.pts;
    return null;
};
