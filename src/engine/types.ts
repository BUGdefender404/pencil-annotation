/** Core data model shared by the drawing engine, storage and UI. */

export type ToolId = "pen" | "highlighter" | "eraser" | "select";

/** A sample along a stroke: document-space coords plus pressure (0..1). */
export interface Point {
    x: number;
    y: number;
    /** pressure 0..1; mouse/touch input reports 0.5 */
    p: number;
}

export type StrokeTool = "pen" | "highlighter";

/**
 * Text-block anchoring: when a stroke starts on a SiYuan block
 * (an element with data-node-id), its points are stored RELATIVE to that
 * block's top-left origin, so the stroke sits at the same spot on the block
 * on every device and follows the block through any reflow or layout change.
 *
 * `ox`/`oy` are legacy fields from the old "block origin at draw time"
 * scheme: they are always 0 in newly written data. Old payloads carry the
 * creation-time origin there; deserializeStroke() migrates them by
 * subtracting it from the (absolute) points, which is exact and identical
 * on every device.
 */
export interface StrokeAnchor {
    blockId: string;
    ox: number;
    oy: number;
}

export interface Stroke {
    id: string;
    tool: StrokeTool;
    /** hex color, e.g. "#e03131" */
    color: string;
    /** base width in doc px */
    width: number;
    /** 0..1 */
    opacity: number;
    /** derive width from velocity instead of real pressure (mouse input) */
    simulate: boolean;
    points: Point[];
    createdAt: number;
    anchor?: StrokeAnchor;
}

export type ToolConfig = Pick<Stroke, "tool" | "color" | "width" | "opacity">;

export interface EraserConfig {
    radius: number;
    showCursor: boolean;
}

/** Serialized (compact) stroke — keys are minified to keep JSON payloads small. */
export interface SerializedStroke {
    i: string;
    t: 0 | 1; // 0 pen, 1 highlighter
    c: string;
    w: number;
    o: number;
    s: 0 | 1;
    /** flat [x, y, pressure, ...] */
    p: number[];
    a: number; // createdAt
    /** optional block anchor: [blockId, legacyOriginX, legacyOriginY] */
    b?: [string, number, number];
}

export interface PencilPayload {
    version: 1;
    docId: string;
    updatedAt: number;
    strokes: SerializedStroke[];
}

export const serializeStroke = (s: Stroke): SerializedStroke => ({
    i: s.id,
    t: s.tool === "pen" ? 0 : 1,
    c: s.color,
    w: s.width,
    o: s.opacity,
    s: s.simulate ? 1 : 0,
    p: s.points.flatMap((pt) => [
        Math.round(pt.x * 100) / 100,
        Math.round(pt.y * 100) / 100,
        Math.round(pt.p * 1000) / 1000,
    ]),
    a: s.createdAt,
    ...(s.anchor
        ? {
            b: [
                s.anchor.blockId,
                Math.round(s.anchor.ox * 100) / 100,
                Math.round(s.anchor.oy * 100) / 100,
            ] as [string, number, number],
        }
        : {}),
});

export const deserializeStroke = (d: SerializedStroke): Stroke => {
    const points: Point[] = [];
    for (let i = 0; i + 2 < d.p.length; i += 3) {
        points.push({x: d.p[i], y: d.p[i + 1], p: d.p[i + 2]});
    }
    // legacy payloads stored absolute points plus the anchor block's origin
    // at draw time — convert to block-relative points (exact, device-independent)
    let anchor: StrokeAnchor | undefined;
    if (Array.isArray(d.b) && d.b.length === 3) {
        const [blockId, ox, oy] = d.b;
        if (ox || oy) {
            for (const pt of points) {
                pt.x -= ox;
                pt.y -= oy;
            }
        }
        anchor = {blockId, ox: 0, oy: 0};
    }
    return {
        id: d.i,
        tool: d.t === 0 ? "pen" : "highlighter",
        color: d.c,
        width: d.w,
        opacity: d.o,
        simulate: d.s === 1,
        points,
        createdAt: d.a,
        ...(anchor ? {anchor} : {}),
    };
};
