// Unit-test recognizeShape directly (bundled to CJS via esbuild).
const {recognizeShape} = require("./shapes-cjs.cjs");

const pts = (arr) => arr.map(([x, y]) => ({x, y, p: 0.5}));
let pass = 0, fail = 0;
const check = (name, cond, extra) => {
    if (cond) { pass++; console.log("PASS", name); }
    else { fail++; console.log("FAIL", name, extra ?? ""); }
};

// helper: walk a polygon perimeter with wobble, optional overshoot tail
function polyPath(corners, steps, wobble, overshoot) {
    const out = [];
    const segs = [];
    for (let i = 0; i < corners.length; i++) {
        const A = corners[i], B = corners[(i + 1) % corners.length];
        segs.push([A, B]);
    }
    const lens = segs.map(([A, B]) => Math.hypot(B[0] - A[0], B[1] - A[1]));
    const total = lens.reduce((s, x) => s + x, 0);
    const pathLen = total + (overshoot || 0);
    for (let i = 0; i <= steps; i++) {
        let u = pathLen * i / steps;
        if (u > total) { // overshoot: continue past the start along segment 0
            u -= total;
            const [A, B] = segs[0];
            const f = u / lens[0];
            out.push({x: A[0] + (B[0] - A[0]) * f, y: A[1] + (B[1] - A[1]) * f, p: 0.5});
            continue;
        }
        let k = 0;
        while (u > lens[k]) { u -= lens[k]; k++; }
        const [A, B] = segs[k];
        const f = u / lens[k];
        const w = wobble ? wobble * Math.sin(i * 1.3) : 0;
        out.push({x: A[0] + (B[0] - A[0]) * f + w, y: A[1] + (B[1] - A[1]) * f - w * 0.6, p: 0.5});
    }
    return out;
}

const axisRect = [[0, 0], [200, 0], [200, 120], [0, 120]];
const tilted = [[0, 0], [180, 60], [120, 180], [-60, 120]]; // ~18.4° long side tilt

// T1: closed axis rect WITH overshoot tail (18% of a side past the start)
let r = recognizeShape(polyPath(axisRect, 60, 1.5, 34));
check("T1 overshoot rect -> 5pts rect", r && r.length === 5 &&
    Math.abs(r[0].x - 0) < 3 && Math.abs(r[2].x - 200) < 3 && Math.abs(r[1].y - 0) < 3,
    JSON.stringify(r && r.map(q => [Math.round(q.x), Math.round(q.y)])));

// T2: closed rect, wavy closing edge (bulge ~0.16): big wobble only near the end
{
    const path = polyPath(axisRect, 60, 1, 0);
    for (let i = 45; i < path.length; i++) path[i].y += 14 * Math.sin((i - 45) / 15 * Math.PI);
    r = recognizeShape(path);
    check("T2 wavy closing edge -> rect", r && r.length === 5,
        JSON.stringify(r && r.length));
}

// T3: U-shape (three sides, missing top edge)
r = recognizeShape(polyPath([[0, 0], [0, 120], [200, 120], [200, 0]], 50, 1.2, 0));
check("T3 U-shape -> closed rect", r && r.length === 5 &&
    Math.abs(r[0].y - r[1].y) < 3 && Math.abs(r[2].x - 200) < 3,
    JSON.stringify(r && r.map(q => [Math.round(q.x), Math.round(q.y)])));

// T4: circle stays ellipse
{
    const circ = [];
    for (let i = 0; i <= 60; i++) {
        const t = i / 60 * Math.PI * 2;
        circ.push({x: 100 + 90 * Math.cos(t) + 2 * Math.sin(3 * t), y: 80 + 70 * Math.sin(t), p: 0.5});
    }
    r = recognizeShape(circ);
    check("T4 circle -> ellipse (73pts)", r && r.length === 73, r && r.length);
}

// T5: checkmark stays raw (no snap)
{
    const tick = [];
    for (let i = 0; i <= 12; i++) tick.push({x: 20 + i * 4, y: 60 - i * 6, p: 0.5}); // down-right
    for (let i = 0; i <= 16; i++) tick.push({x: 68 + i * 5, y: -18 + i * 5, p: 0.5}); // up-right
    r = recognizeShape(tick);
    check("T5 checkmark -> null", r === null, JSON.stringify(r && r.length));
}

// T6 regressions: mid-edge start rect, line, triangle
r = recognizeShape(polyPath(axisRect, 56, 1.5, 0));
check("T6a mid-edge rect -> 5pts", r && r.length === 5, r && r.length);
r = recognizeShape(polyPath(tilted, 56, 1.5, 0));
check("T6b tilted rect snaps axis-aligned", r && r.length === 5 &&
    r[0].y === r[1].y && r[2].y === r[3].y && r[0].x === r[3].x && r[1].x === r[2].x &&
    Math.abs(r[0].y - 0) < 3 && Math.abs(r[1].x - 180) <= 4,
    JSON.stringify(r && r.map(q => [Math.round(q.x), Math.round(q.y)])));
{
    const line = [];
    for (let i = 0; i <= 30; i++) line.push({x: 10 + i * 8, y: 50 + Math.sin(i) * 2, p: 0.5});
    r = recognizeShape(line);
    check("T6c line -> 2pts flat", r && r.length === 2 && Math.abs(r[0].y - r[1].y) < 0.6, JSON.stringify(r));
}
{
    const tri = [];
    const c3 = [[10, 100], [100, 100], [55, 10], [10, 100]];
    for (let s = 0; s < 3; s++) for (let i = 0; i < 15; i++) {
        const f = i / 15, A = c3[s], B = c3[s + 1];
        tri.push({x: A[0] + (B[0] - A[0]) * f, y: A[1] + (B[1] - A[1]) * f, p: 0.5});
    }
    r = recognizeShape(tri);
    check("T6d triangle -> 4pts", r && r.length === 4, r && r.length);
}

// T7: small rect (diag ~126) with moderate wobble — small-RDP-eps regime
r = recognizeShape(polyPath([[0, 0], [120, 0], [120, 40], [0, 40]], 40, 2.2, 8));
check("T7 small rect w/ wobble+small overshoot -> 5pts", r && r.length === 5,
    JSON.stringify(r && r.map(q => [Math.round(q.x), Math.round(q.y)])));

console.log(`\n${pass} passed, ${fail} failed`);

// ---- round 2: triangle kinks & scribble guard ----
const triPath = (mutate) => {
    // triangle A(0,120) B(100,120) C(50,0), drawn A->B->C->A, wobble 1px
    const A = [0, 120], B = [100, 120], C = [50, 0];
    const segs = [[A, B], [B, C], [C, A]];
    const out = [];
    const N = 51;
    for (let i = 0; i <= N; i++) {
        let u = (i / N) * 3; // 3 segments
        const k = Math.min(2, Math.floor(u));
        const f = u - k;
        const [P, Q] = segs[k];
        out.push({x: P[0] + (Q[0] - P[0]) * f, y: P[1] + (Q[1] - P[1]) * f, p: 0.5});
        if (mutate) mutate(out, k, f, i);
    }
    return out;
};

// T8: shallow kink bump on edge B->C (4 RDP corners, kink ~160 deg)
r = recognizeShape(triPath((out, k) => {
    if (k === 1 && out.length === 26) {
        const n = out.length;
        const px = out[n - 2], q = out[n - 1];
        out.push({x: q.x + 9, y: q.y + 5, p: 0.5}); // sideways bump
    }
}));
check("T8 kinked triangle -> triangle", r && r.length === 4 &&
    JSON.stringify(r && r.map(q => [Math.round(q.x), Math.round(q.y)])));

// T9: rounded/blunted apex — two close corners near C merge into the vertex
r = recognizeShape(triPath((out, k, f) => {
    if (k === 1 && f > 0.92) {
        const q = out[out.length - 1];
        // small arc around C(50,0): push points outward radially
        const dx = q.x - 50, dy = q.y - 0;
        const len = Math.hypot(dx, dy) || 1;
        q.x += (dx / len) * 6;
        q.y += (dy / len) * 6;
    }
}));
check("T9 blunted triangle -> triangle", r && r.length === 4,
    JSON.stringify(r && r.map(q => [Math.round(q.x), Math.round(q.y)])));

// T10: zigzag bump (out-and-back, two close sharp corners) on edge B->C
r = recognizeShape(triPath((out, k) => {
    if (k === 1 && out.length === 34) {
        const q = out[out.length - 1];
        out.push({x: q.x + 14, y: q.y + 7, p: 0.5});
        out.push({x: q.x + 6, y: q.y + 10, p: 0.5});
    }
}));
check("T10 zigzag triangle -> triangle", r && r.length === 4,
    JSON.stringify(r && r.map(q => [Math.round(q.x), Math.round(q.y)])));

// T11: double-loop scribble must NOT become an ellipse/shape
{
    const scr = [];
    for (let i = 0; i <= 40; i++) {
        const t = i / 40 * Math.PI * 2;
        scr.push({x: 40 + 28 * Math.cos(t), y: 40 + 26 * Math.sin(t), p: 0.5});
    }
    for (let i = 0; i <= 40; i++) {
        const t = i / 40 * Math.PI * 2;
        scr.push({x: 104 + 28 * Math.cos(t), y: 44 + 24 * Math.sin(t), p: 0.5});
    }
    r = recognizeShape(scr);
    check("T11 double-loop scribble -> null", r === null, JSON.stringify(r && r.length));
}

// T12: realistic freehand scribbles -> null (serpentine + spiral)
{
    // serpentine: back-and-forth horizontal scribble, closed
    const serp = [];
    for (let row = 0; row < 8; row++) {
        const y = 20 + row * 14;
        for (let i = 0; i <= 10; i++) {
            const x = row % 2 === 0 ? 15 + i * 12 : 135 - i * 12;
            serp.push({x, y: y + (i % 2) * 2, p: 0.5});
        }
    }
    serp.push({...serp[0]});
    r = recognizeShape(serp);
    check("T12a serpentine scribble -> null", r === null, JSON.stringify(r && r.length));
}
{
    // spiral: winds once but no candidate hugs it
    const spiral = [];
    for (let i = 0; i <= 90; i++) {
        const t = i / 90 * Math.PI * 3.6;
        const rr = 12 + t * 16;
        spiral.push({x: 80 + rr * Math.cos(t), y: 70 + rr * 0.7 * Math.sin(t), p: 0.5});
    }
    r = recognizeShape(spiral);
    check("T12b spiral scribble -> null", r === null, JSON.stringify(r && r.length));
}

// T13: genuine sloppy circle still snaps to ellipse
{
    const circ = [];
    for (let i = 0; i <= 55; i++) {
        const t = i / 55 * Math.PI * 2;
        circ.push({x: 100 + 88 * Math.cos(t) + 3 * Math.sin(5 * t), y: 80 + 66 * Math.sin(t) + 3 * Math.cos(4 * t), p: 0.5});
    }
    r = recognizeShape(circ);
    check("T13 sloppy circle -> ellipse", r && r.length === 73, r && r.length);
}

// T14: retraced rectangles — people often trace 1.2-1.5 loops while drawing
{
    const seq = [[0, 0], [200, 0], [200, 120], [0, 120], [0, 0], [200, 0], [200, 120]];
    const retr = [];
    const N = 100;
    for (let i = 0; i <= N; i++) {
        const u = (i / N) * 6; // 1.5 loops
        const k = Math.min(5, Math.floor(u));
        const f = u - k;
        const A = seq[k], B = seq[k + 1];
        const w = 1.2 * Math.sin(i * 1.1);
        retr.push({x: A[0] + (B[0] - A[0]) * f + w, y: A[1] + (B[1] - A[1]) * f - w * 0.6, p: 0.5});
    }
    r = recognizeShape(retr);
    check("T14a rect retraced 1.5 loops -> 5pts", r && r.length === 5,
        JSON.stringify(r && r.map(q => [Math.round(q.x), Math.round(q.y)])));
}
{
    const seq = [[0, 0], [200, 0], [200, 120], [0, 120], [0, 0], [200, 0], [200, 120]];
    const retr = [];
    const N = 110;
    for (let i = 0; i <= N; i++) {
        const u = (i / N) * 5; // 1.25 loops, ends on the top edge
        const k = Math.min(5, Math.floor(u));
        const f = u - k;
        const A = seq[k], B = seq[k + 1];
        const w = 1.2 * Math.sin(i * 1.3);
        retr.push({x: A[0] + (B[0] - A[0]) * f + w, y: A[1] + (B[1] - A[1]) * f - w * 0.6, p: 0.5});
    }
    r = recognizeShape(retr);
    check("T14b rect retraced 1.25 loops -> 5pts", r && r.length === 5,
        JSON.stringify(r && r.map(q => [Math.round(q.x), Math.round(q.y)])));
}

console.log(`[total] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
