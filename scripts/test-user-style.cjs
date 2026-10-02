// Reproduce the user's drawing style from the screenshot and find the gate
// that rejects their rectangles.
const {recognizeShape} = require("./shapes-cjs.cjs");

// ---- geometry helpers mirroring shapes.ts internals ----
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const segDist = (p, a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return dist(p, a);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};
const windsOnce = (pts, cx, cy) => {
    let sum = 0, prev = null;
    for (const p of pts) {
        const ang = Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI;
        if (prev !== null) { let d = ang - prev; d = ((d % 360) + 540) % 360 - 180; sum += d; }
        prev = ang;
    }
    return Math.abs(sum);
};
const polyResidual = (raw, poly) => {
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
const rectCandidate = (raw, deg, cx, cy) => {
    const th = deg * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
    let nx0 = Infinity, ny0 = Infinity, nx1 = -Infinity, ny1 = -Infinity;
    for (const pt of raw) {
        const dx = pt.x - cx, dy = pt.y - cy;
        const rx = dx * c + dy * s, ry = -dx * s + dy * c;
        nx0 = Math.min(nx0, rx); nx1 = Math.max(nx1, rx);
        ny0 = Math.min(ny0, ry); ny1 = Math.max(ny1, ry);
    }
    const corner = (rx, ry) => ({x: cx + rx * c - ry * s, y: cy + rx * s + ry * c, p: 0.5});
    return [corner(nx0, ny0), corner(nx1, ny0), corner(nx1, ny1), corner(nx0, ny1), corner(nx0, ny0)];
};
const ellipseResidual = (raw, minX, minY, maxX, maxY) => {
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

// ---- user-style generators ----
// rounded-corner polygon walk with per-corner arc radius (mouse can't turn sharply)
function roundedBox({w, h, shearDeg = 0, round = 0, wobble = 1.5, steps = 36, overshoot = 0, leadIn = 0}) {
    const pts = [];
    const sh = Math.tan(shearDeg * Math.PI / 180) * h; // top edge shifted +sh relative to bottom
    const corners = [[0, 0], [w, sh], [w, sh + h], [0, h]]; // start bottom-left, CCW? CW-ish
    // build the outline as corner->corner segments with rounding at corners
    const path = [];
    for (let i = 0; i < 4; i++) {
        const A = corners[i], B = corners[(i + 1) % 4];
        path.push({A, B});
    }
    const emit = (x, y) => {
        const wv = wobble ? wobble * Math.sin(pts.length * 1.37) : 0;
        pts.push({x: x + wv, y: y - wv * 0.5, p: 0.5});
    };
    // lead-in: start below-left of the first corner
    if (leadIn > 0) {
        const [cx0, cy0] = corners[0];
        emit(cx0 - leadIn * 0.7, cy0 + leadIn);
        emit(cx0 - leadIn * 0.3, cy0 + leadIn * 0.4);
    }
    for (let seg = 0; seg < 4; seg++) {
        const {A, B} = path[seg];
        // trim the segment ends by `round` to fake corner arcs
        const dx = B[0] - A[0], dy = B[1] - A[1];
        const len = Math.hypot(dx, dy) || 1;
        const r0 = Math.min(round, len * 0.3), r1 = Math.min(round, len * 0.3);
        const N = Math.max(3, Math.round(steps / 4));
        for (let i = 0; i <= N; i++) {
            const f = i / N;
            const x = A[0] + dx * (r0 / len) + dx * f * (1 - (r0 + r1) / len);
            const y = A[1] + dy * (r0 / len) + dy * f * (1 - (r0 + r1) / len);
            emit(x, y);
        }
    }
    if (overshoot > 0) {
        const {A, B} = path[0];
        const dx = B[0] - A[0], dy = B[1] - A[1], len = Math.hypot(dx, dy) || 1;
        for (let i = 1; i <= 3; i++) emit(A[0] + dx * i * overshoot / 3 / len, A[1] + dy * i * overshoot / 3 / len);
    }
    return pts;
}

const cases = {
    "P1 parallelogram 230x55 shear12": roundedBox({w: 230, h: 55, shearDeg: 12, round: 10, wobble: 2, steps: 36, overshoot: 8}),
    "P2 parallelogram 230x55 shear20": roundedBox({w: 230, h: 55, shearDeg: 20, round: 10, wobble: 2, steps: 36, overshoot: 8}),
    "P3 small box 120x45": roundedBox({w: 120, h: 45, shearDeg: 6, round: 8, wobble: 2, steps: 28, overshoot: 6}),
    "P4 box + lead-in tail 30px": roundedBox({w: 200, h: 70, shearDeg: 8, round: 10, wobble: 2, steps: 36, overshoot: 8, leadIn: 30}),
    "P5 fast box (16 pts)": roundedBox({w: 200, h: 70, shearDeg: 5, round: 12, wobble: 2, steps: 16, overshoot: 8}),
};

for (const [name, pts] of Object.entries(cases)) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const diag = Math.hypot(maxX - minX, maxY - minY);
    // replicate trim + closedness from recognizeShape
    let endIdx = pts.length - 1, nearest = Infinity;
    const tailFrom = Math.floor(pts.length * 0.7);
    for (let i = tailFrom; i < pts.length; i++) { const d = dist(pts[i], pts[0]); if (d < nearest) { nearest = d; endIdx = i; } }
    const raw = pts.slice(0, endIdx + 1);
    let rminX = Infinity, rminY = Infinity, rmaxX = -Infinity, rmaxY = -Infinity;
    for (const p of raw) { rminX = Math.min(rminX, p.x); rmaxX = Math.max(rmaxX, p.x); rminY = Math.min(rminY, p.y); rmaxY = Math.max(rmaxY, p.y); }
    const rcx = (rminX + rmaxX) / 2, rcy = (rminY + rmaxY) / 2;
    const wind = windsOnce(raw, rcx, rcy);
    let bRes = Infinity, bDeg = -1;
    for (let deg = 0; deg < 90; deg += 3) {
        const r = polyResidual(raw, rectCandidate(raw, deg, rcx, rcy));
        if (r < bRes) { bRes = r; bDeg = deg; }
    }
    const eRes = ellipseResidual(raw, rminX, rminY, rmaxX, rmaxY);
    const out = recognizeShape(pts.map(p => ({...p})));
    console.log(
        name.padEnd(34),
        `n=${String(pts.length).padStart(3)}`,
        `diag=${String(Math.round(diag)).padStart(4)}`,
        `closed=${String(Math.round(nearest)).padStart(3)}<=${Math.round(diag * 0.3)}`,
        `wind=${String(Math.round(Math.abs(wind))).padStart(4)}[300-600]`,
        `rectRes=${bRes.toFixed(1)}@${bDeg} (lim ${(diag * 0.055 / 0.95).toFixed(1)})`,
        `ellRes=${eRes.toFixed(1)}`,
        `=> ${out ? (out.length === 5 ? "RECT" : out.length === 4 ? "TRI" : out.length === 73 ? "ELLIPSE" : out.length === 2 ? "LINE" : "?") : "null"}`,
    );
}
