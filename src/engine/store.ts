import {newId, strokeBBox, translateStroke} from "./geometry";
import {deserializeStroke, serializeStroke, type PencilPayload, type Point, type Stroke, type StrokeTool} from "./types";

export type Op =
    | { type: "add"; strokes: Stroke[] }
    | { type: "remove"; strokes: Stroke[] }
    | { type: "move"; strokes: Stroke[]; dx: number; dy: number };

const UNDO_LIMIT = 100;

/** In-memory document state: stroke list + undo/redo + persistence bookkeeping. */
export class DocStore {
    strokes: Stroke[] = [];
    docId: string;

    /** unsaved local changes exist (need to be pushed to the kernel) */
    dirty = false;
    /** updatedAt of the payload we last wrote or adopted */
    lastSavedAt = 0;
    /** in-flight save promise, so flushes can be awaited */
    saving: Promise<unknown> | null = null;

    private undoStack: Op[] = [];
    private redoStack: Op[] = [];

    constructor(docId: string) {
        this.docId = docId;
    }

    get canUndo() {
        return this.undoStack.length > 0;
    }

    get canRedo() {
        return this.redoStack.length > 0;
    }

    private pushOp(op: Op) {
        this.undoStack.push(op);
        if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
        this.redoStack = [];
    }

    addStroke(tool: StrokeTool, config: { color: string; width: number; opacity: number; simulate: boolean }, points: Point[]): Stroke {
        const stroke: Stroke = {
            id: newId(),
            tool,
            color: config.color,
            width: config.width,
            opacity: config.opacity,
            simulate: config.simulate,
            points,
            createdAt: Date.now(),
        };
        this.strokes.push(stroke);
        this.pushOp({type: "add", strokes: [stroke]});
        this.dirty = true;
        return stroke;
    }

    /** Removes strokes hit by the eraser segment; returns what was removed. */
    eraseWhere(predicate: (s: Stroke) => boolean): Stroke[] {
        const removed = this.strokes.filter(predicate);
        if (removed.length === 0) return [];
        const removedIds = new Set(removed.map((s) => s.id));
        this.strokes = this.strokes.filter((s) => !removedIds.has(s.id));
        this.pushOp({type: "remove", strokes: removed});
        this.dirty = true;
        return removed;
    }

    /** Visual-only translation while a drag is in progress (no undo entry). */
    moveStrokesTransient(strokes: Stroke[], dx: number, dy: number) {
        if (strokes.length === 0 || (dx === 0 && dy === 0)) return;
        for (const s of strokes) translateStroke(s, dx, dy);
    }

    /** Records the completed drag as one undoable op (points already moved). */
    commitMove(strokes: Stroke[], dx: number, dy: number) {
        if (strokes.length === 0 || (dx === 0 && dy === 0)) return;
        this.pushOp({type: "move", strokes, dx, dy});
        this.dirty = true;
    }

    moveStrokes(strokes: Stroke[], dx: number, dy: number) {
        this.moveStrokesTransient(strokes, dx, dy);
        this.commitMove(strokes, dx, dy);
    }

    clearAll(): Stroke[] {
        const removed = this.strokes;
        if (removed.length === 0) return [];
        this.strokes = [];
        this.pushOp({type: "remove", strokes: removed});
        this.dirty = true;
        return removed;
    }

    duplicateStroke(stroke: Stroke): Stroke | null {
        const copy: Stroke = {
            ...stroke,
            id: newId(),
            createdAt: Date.now(),
            points: stroke.points.map((p) => ({...p})),
        };
        translateStroke(copy, 12, 12);
        const idx = this.strokes.findIndex((s) => s.id === stroke.id);
        if (idx >= 0) this.strokes.splice(idx + 1, 0, copy);
        else this.strokes.push(copy);
        this.pushOp({type: "add", strokes: [copy]});
        this.dirty = true;
        return copy;
    }

    undo(): boolean {
        const op = this.undoStack.pop();
        if (!op) return false;
        if (op.type === "add") {
            const ids = new Set(op.strokes.map((s) => s.id));
            this.strokes = this.strokes.filter((s) => !ids.has(s.id));
        } else if (op.type === "remove") {
            this.strokes.push(...op.strokes);
            this.strokes.sort((a, b) => a.createdAt - b.createdAt);
        } else {
            for (const s of op.strokes) translateStroke(s, -op.dx, -op.dy);
        }
        this.redoStack.push(op);
        this.dirty = true;
        return true;
    }

    redo(): boolean {
        const op = this.redoStack.pop();
        if (!op) return false;
        if (op.type === "add") {
            this.strokes.push(...op.strokes);
        } else if (op.type === "remove") {
            const ids = new Set(op.strokes.map((s) => s.id));
            this.strokes = this.strokes.filter((s) => !ids.has(s.id));
        } else {
            for (const s of op.strokes) translateStroke(s, op.dx, op.dy);
        }
        this.undoStack.push(op);
        this.dirty = true;
        return true;
    }

    /** bbox of everything drawn (for export) */
    contentBBox() {
        if (this.strokes.length === 0) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const s of this.strokes) {
            const b = strokeBBox(s);
            minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
            maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
        }
        return {minX, minY, maxX, maxY};
    }

    serialize(): PencilPayload {
        return {
            version: 1,
            docId: this.docId,
            updatedAt: Date.now(),
            strokes: this.strokes.map(serializeStroke),
        };
    }

    adoptPayload(payload: PencilPayload) {
        this.strokes = (payload.strokes || []).map(deserializeStroke);
        this.lastSavedAt = payload.updatedAt || 0;
        this.undoStack = [];
        this.redoStack = [];
        this.dirty = false;
    }

    /**
     * Union-merge a remote payload (sync from another device) into local
     * strokes by id; local copies win for identical ids.
     */
    mergeRemote(payload: PencilPayload): boolean {
        const remote = (payload.strokes || []).map(deserializeStroke);
        const localIds = new Set(this.strokes.map((s) => s.id));
        const additions = remote.filter((s) => !localIds.has(s.id));
        if (additions.length === 0) {
            this.lastSavedAt = Math.max(this.lastSavedAt, payload.updatedAt || 0);
            return false;
        }
        this.strokes.push(...additions);
        this.strokes.sort((a, b) => a.createdAt - b.createdAt);
        this.lastSavedAt = Math.max(this.lastSavedAt, payload.updatedAt || 0);
        return true;
    }
}
