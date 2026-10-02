"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/engine/shapes.ts
var shapes_exports = {};
__export(shapes_exports, {
  AXIS_SNAP_DEG: () => AXIS_SNAP_DEG,
  recognizeShape: () => recognizeShape
});
module.exports = __toCommonJS(shapes_exports);
var dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
var segDist = (p, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};
var rdpIdx = (pts, eps) => {
  if (pts.length < 3) return pts.map((_, i) => i);
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(pts[i], pts[s], pts[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = true;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(i);
  return out;
};
var avgPressure = (pts) => pts.reduce((s, p) => s + p.p, 0) / Math.max(1, pts.length);
var interiorAngle = (a, b, c) => {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const denom = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1;
  const cos = (v1x * v2x + v1y * v2y) / denom;
  return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
};
var polygonArea = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
};
var windsOnce = (pts, cx, cy) => {
  let sum = 0;
  let prev = null;
  for (const p of pts) {
    const ang = Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI;
    if (prev !== null) {
      let d = ang - prev;
      d = (d % 360 + 540) % 360 - 180;
      sum += d;
    }
    prev = ang;
  }
  return Math.abs(sum) >= 300 && Math.abs(sum) <= 600;
};
var AXIS_SNAP_DEG = 8;
var SNAP_RESIDUAL = 0.055;
var polyResidual = (raw, poly) => {
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
var rectCandidate = (raw, deg, cx, cy, p) => {
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
  const corner = (rx, ry) => ({
    x: cx + rx * c - ry * s,
    y: cy + rx * s + ry * c,
    p
  });
  return [
    corner(rminX, rminY),
    corner(rmaxX, rminY),
    corner(rmaxX, rmaxY),
    corner(rminX, rmaxY),
    corner(rminX, rminY)
  ];
};
var ellipseCandidate = (minX, minY, maxX, maxY, p) => {
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const rx = (maxX - minX) / 2, ry = (maxY - minY) / 2;
  const out = [];
  for (let i = 0; i <= 72; i++) {
    const t = i / 72 * Math.PI * 2;
    out.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t), p });
  }
  return out;
};
var ellipseResidual = (raw, minX, minY, maxX, maxY) => {
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
var dominantCorners = (raw, minX, minY, maxX, maxY) => {
  let startIdx = 0, far = -1;
  const icx = (minX + maxX) / 2, icy = (minY + maxY) / 2;
  for (let i = 0; i < raw.length; i++) {
    const d = (raw[i].x - icx) * (raw[i].x - icx) + (raw[i].y - icy) * (raw[i].y - icy);
    if (d > far) {
      far = d;
      startIdx = i;
    }
  }
  const loop = raw.slice(startIdx).concat(raw.slice(0, startIdx + 1));
  const diag = Math.hypot(maxX - minX, maxY - minY);
  const idx0 = rdpIdx(loop, Math.max(6, diag * 0.04));
  const corners = idx0.map((i) => loop[i]);
  if (corners.length > 1 && dist(corners[0], corners[corners.length - 1]) < diag * 0.08) {
    corners.pop();
  }
  while (corners.length > 6) {
    let flat = -1, flatAng = -1;
    for (let i = 0; i < corners.length; i++) {
      const ang = interiorAngle(
        corners[(i + corners.length - 1) % corners.length],
        corners[i],
        corners[(i + 1) % corners.length]
      );
      if (ang > flatAng) {
        flatAng = ang;
        flat = i;
      }
    }
    if (flatAng < 155) break;
    corners.splice(flat, 1);
  }
  return { corners, loop, idx: idx0 };
};
var forcedQuadRect = (loop, idx, corners, p) => {
  const cs = corners.slice();
  while (cs.length > 4) {
    let flat = -1, flatAng = -1;
    for (let i = 0; i < cs.length; i++) {
      const ang = interiorAngle(
        cs[(i + cs.length - 1) % cs.length],
        cs[i],
        cs[(i + 1) % cs.length]
      );
      if (ang > flatAng) {
        flatAng = ang;
        flat = i;
      }
    }
    if (flatAng < 135) break;
    cs.splice(flat, 1);
  }
  if (cs.length !== 4) return null;
  for (let i = 0; i < 4; i++) {
    const ang = interiorAngle(cs[(i + 3) % 4], cs[i], cs[(i + 1) % 4]);
    if (ang < 50 || ang > 145) return null;
  }
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
    { x: minX, y: minY, p },
    { x: maxX, y: minY, p },
    { x: maxX, y: maxY, p },
    { x: minX, y: maxY, p },
    { x: minX, y: minY, p }
  ];
};
var recognizeShape = (input) => {
  if (input.length < 6) return null;
  let endIdx = input.length - 1;
  let nearest = Infinity;
  const tailFrom = Math.floor(input.length * 0.7);
  for (let i = tailFrom; i < input.length; i++) {
    const d = dist(input[i], input[0]);
    if (d < nearest) {
      nearest = d;
      endIdx = i;
    }
  }
  let fMinX = Infinity, fMinY = Infinity, fMaxX = -Infinity, fMaxY = -Infinity;
  for (const p2 of input) {
    if (p2.x < fMinX) fMinX = p2.x;
    if (p2.x > fMaxX) fMaxX = p2.x;
    if (p2.y < fMinY) fMinY = p2.y;
    if (p2.y > fMaxY) fMaxY = p2.y;
  }
  const fullDiag = Math.hypot(fMaxX - fMinX, fMaxY - fMinY);
  const raw = nearest <= Math.max(8, fullDiag * 0.2) ? input.slice(0, endIdx + 1) : input.slice();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p2 of raw) {
    if (p2.x < minX) minX = p2.x;
    if (p2.x > maxX) maxX = p2.x;
    if (p2.y < minY) minY = p2.y;
    if (p2.y > maxY) maxY = p2.y;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY);
  let pathLen = 0;
  for (let i = 1; i < raw.length; i++) {
    pathLen += dist(raw[i - 1], raw[i]);
  }
  const p = avgPressure(raw);
  const closed = nearest <= Math.max(28, diag * 0.3) && nearest <= pathLen * 0.5;
  if (!closed) {
    const first = raw[0], last = raw[raw.length - 1];
    const len = dist(first, last);
    const ang = Math.atan2(last.y - first.y, last.x - first.x) * 180 / Math.PI;
    const nearAxis = Math.abs(ang) <= AXIS_SNAP_DEG || Math.abs(Math.abs(ang) - 180) <= AXIS_SNAP_DEG || Math.abs(Math.abs(ang) - 90) <= AXIS_SNAP_DEG;
    if (len >= Math.max(nearAxis ? 20 : 40, diag * 0.75)) {
      let maxDev = 0;
      for (const pt of raw) maxDev = Math.max(maxDev, segDist(pt, first, last));
      if (maxDev <= Math.max(3.5, len * 0.06)) {
        let ax = first.x, ay = first.y, bx = last.x, by = last.y;
        if (Math.abs(ang) <= AXIS_SNAP_DEG || Math.abs(Math.abs(ang) - 180) <= AXIS_SNAP_DEG) {
          ay = by = (first.y + last.y) / 2;
        } else if (Math.abs(Math.abs(ang) - 90) <= AXIS_SNAP_DEG) {
          ax = bx = (first.x + last.x) / 2;
        }
        return [{ x: ax, y: ay, p }, { x: bx, y: by, p }];
      }
    }
    if (diag >= 40 && nearest <= Math.max(45, diag * 0.5)) {
      return loopShape(raw.concat([{ x: first.x, y: first.y, p: first.p }]), true);
    }
    return null;
  }
  if (diag < 40) return null;
  return loopShape(raw, false);
};
var loopShape = (raw, rectOnly) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p2 of raw) {
    if (p2.x < minX) minX = p2.x;
    if (p2.x > maxX) maxX = p2.x;
    if (p2.y < minY) minY = p2.y;
    if (p2.y > maxY) maxY = p2.y;
  }
  const w = maxX - minX, h = maxY - minY;
  const diag = Math.hypot(w, h);
  const p = avgPressure(raw);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  if (!windsOnce(raw, cx, cy)) return null;
  const best = { score: Infinity, pts: [] };
  const offer = (res, pts, pref) => {
    const score = res * pref;
    if (score < best.score) {
      best.score = score;
      best.pts = pts;
    }
  };
  const dc = dominantCorners(raw, minX, minY, maxX, maxY);
  const forced = forcedQuadRect(dc.loop, dc.idx, dc.corners, p);
  if (forced) return forced;
  {
    let bRes = Infinity;
    for (let deg = 0; deg < 90; deg += 3) {
      bRes = Math.min(bRes, polyResidual(raw, rectCandidate(raw, deg, cx, cy, p)));
    }
    if (bRes < Infinity) {
      offer(bRes, [
        { x: minX, y: minY, p },
        { x: maxX, y: minY, p },
        { x: maxX, y: maxY, p },
        { x: minX, y: maxY, p },
        { x: minX, y: minY, p }
      ], 0.85);
    }
  }
  if (!rectOnly) {
    const corners = dc.corners;
    const n = corners.length;
    const minArea = Math.max(64, diag * diag * 4e-3);
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
        1.05
      );
    }
  }
  if (best.pts.length > 0 && best.score <= diag * SNAP_RESIDUAL) return best.pts;
  return null;
};
