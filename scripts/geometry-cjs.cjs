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

// src/engine/geometry.ts
var geometry_exports = {};
__export(geometry_exports, {
  bboxesIntersect: () => bboxesIntersect,
  newId: () => newId,
  pointHitsStroke: () => pointHitsStroke,
  segmentHitsStroke: () => segmentHitsStroke,
  smoothDense: () => smoothDense,
  strokeBBox: () => strokeBBox,
  translateStroke: () => translateStroke,
  unionBBox: () => unionBBox
});
module.exports = __toCommonJS(geometry_exports);
var strokeBBox = (stroke) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of stroke.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = stroke.width / 2 + 2;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
};
var bboxesIntersect = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
var unionBBox = (boxes) => {
  if (boxes.length === 0) return null;
  return {
    minX: Math.min(...boxes.map((b) => b.minX)),
    minY: Math.min(...boxes.map((b) => b.minY)),
    maxX: Math.max(...boxes.map((b) => b.maxX)),
    maxY: Math.max(...boxes.map((b) => b.maxY))
  };
};
var distSqToSegment = (px, py, ax, ay, bx, by) => {
  const abx = bx - ax, aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  let t = lenSq > 0 ? ((px - ax) * abx + (py - ay) * aby) / lenSq : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = ax + abx * t - px, dy = ay + aby * t - py;
  return dx * dx + dy * dy;
};
var segmentHitsStroke = (stroke, x1, y1, x2, y2, threshold) => {
  const bbox = strokeBBox(stroke);
  const hitBox = {
    minX: Math.min(x1, x2) - threshold,
    minY: Math.min(y1, y2) - threshold,
    maxX: Math.max(x1, x2) + threshold,
    maxY: Math.max(y1, y2) + threshold
  };
  if (!bboxesIntersect(bbox, hitBox)) return false;
  const step = Math.max(1, Math.floor(stroke.points.length / 120));
  const pts = stroke.points;
  const thrSq = threshold * threshold;
  for (let i = 0; i < pts.length - 1; i += step) {
    const a = pts[i];
    const b = pts[Math.min(i + step, pts.length - 1)];
    if (distSqToSegment(a.x, a.y, x1, y1, x2, y2) <= thrSq || distSqToSegment(b.x, b.y, x1, y1, x2, y2) <= thrSq) return true;
  }
  return false;
};
var pointHitsStroke = (stroke, x, y, threshold) => segmentHitsStroke(stroke, x, y, x + 0.01, y + 0.01, threshold);
var translateStroke = (stroke, dx, dy) => {
  for (const p of stroke.points) {
    p.x = Math.round((p.x + dx) * 100) / 100;
    p.y = Math.round((p.y + dy) * 100) / 100;
  }
};
var smoothDense = (points, minCount = 12) => {
  if (points.length < minCount) return points;
  let pts = points.slice();
  for (let pass = 0; pass < 2; pass++) {
    const next = pts.slice();
    for (let i = 1; i < pts.length - 1; i++) {
      next[i] = {
        x: (pts[i - 1].x + 2 * pts[i].x + pts[i + 1].x) / 4,
        y: (pts[i - 1].y + 2 * pts[i].y + pts[i + 1].y) / 4,
        p: pts[i].p
      };
    }
    pts = next;
  }
  return pts;
};
var newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
