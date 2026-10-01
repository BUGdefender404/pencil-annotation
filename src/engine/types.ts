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
 * (an element with data-node-id), we record that block plus the block's
 * document-space origin at draw time. On reflow the block moves and the
 * stroke follows by the same delta.
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
    /** optional block anchor: [blockId, originX, originY] */
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
    return {
        id: d.i,
        tool: d.t === 0 ? "pen" : "highlighter",
        color: d.c,
        width: d.w,
        opacity: d.o,
        simulate: d.s === 1,
        points,
        createdAt: d.a,
        ...(Array.isArray(d.b) && d.b.length === 3
            ? {anchor: {blockId: d.b[0], ox: d.b[1], oy: d.b[2]}}
            : {}),
    };
};
