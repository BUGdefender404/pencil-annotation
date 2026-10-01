import {fetchSyncPost, type Plugin} from "siyuan";
import type {PencilPayload} from "../engine/types";

/**
 * Kernel-backed persistence. Doc payloads live in the plugin's private
 * petal directory (/data/storage/petal/pencil-annotation/<docId>.json),
 * which participates in SiYuan's encrypted cloud sync — strokes written on
 * the iPad show up on the desktop and vice versa.
 */

const LOAD_TIMEOUT = 8000;

const authHeaders = (): HeadersInit => {
    const token = (window as unknown as {siyuan?: {config?: {api?: {token?: string}}}}).siyuan?.config?.api?.token;
    return token ? {Authorization: `Token ${token}`} : {};
};

export const storageName = (docId: string) => `${docId}.json`;

export async function loadPayload(plugin: Plugin, docId: string): Promise<PencilPayload | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOAD_TIMEOUT);
    try {
        // loadData collapses missing files and failed reads to "". A failed read
        // must NOT become an empty baseline that the next stroke overwrites.
        const res = await fetch("/api/file/getFile", {
            method: "POST",
            headers: {"Content-Type": "application/json", ...authHeaders()},
            body: JSON.stringify({path: `/data/storage/petal/${plugin.name}/${storageName(docId)}`}),
            signal: controller.signal,
        });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`load failed: HTTP ${res.status}`);
        const data = await res.json();
        if (data?.code === 404) return null;
        if (data?.version !== 1 || data.docId !== docId || !Number.isFinite(data.updatedAt) ||
            !Array.isArray(data.strokes) || !data.strokes.every((s: any) =>
                s && typeof s.i === "string" && (s.t === 0 || s.t === 1) &&
                typeof s.c === "string" && Number.isFinite(s.w) && s.w > 0 &&
                Number.isFinite(s.o) && Number.isFinite(s.a) && (s.s === 0 || s.s === 1) &&
                Array.isArray(s.p) && s.p.length >= 3 && s.p.length % 3 === 0 && s.p.every(Number.isFinite) &&
                (s.b === undefined || (Array.isArray(s.b) && s.b.length === 3 &&
                    typeof s.b[0] === "string" && Number.isFinite(s.b[1]) && Number.isFinite(s.b[2]))))) {
            throw new Error(data?.msg || "Invalid handwriting data; refusing to overwrite it");
        }
        return data as PencilPayload;
    } finally {
        clearTimeout(timer);
    }
}

export async function savePayload(plugin: Plugin, payload: PencilPayload): Promise<boolean> {
    try {
        const host = (window as unknown as {siyuan?: {config?: {readonly?: boolean}; isPublish?: boolean}}).siyuan;
        if (host?.config?.readonly || host?.isPublish) throw new Error("Readonly or published document");
        const form = new FormData();
        form.append("path", `/data/storage/petal/${plugin.name}/${storageName(payload.docId)}`);
        form.append("isDir", "false");
        form.append("file", new Blob([JSON.stringify(payload)], {type: "application/json"}), storageName(payload.docId));
        // Do not release the document's write lock on an artificial timeout:
        // the old request could still commit after a newer snapshot.
        const res = await fetch("/api/file/putFile", {method: "POST", headers: authHeaders(), body: form});
        if (!res.ok) throw new Error(`save failed: HTTP ${res.status}`);
        const result = await res.json();
        if (result.code !== 0) throw new Error(result.msg || "save failed");
        return true;
    } catch (e) {
        console.error("[pencil-annotation] savePayload failed", e);
        return false;
    }
}

/** Uploads a PNG blob into the workspace assets folder, returns its path. */
export async function uploadAssetPng(fileName: string, blob: Blob): Promise<string> {
    const token = (window as unknown as {siyuan?: {config?: {api?: {token?: string}}}}).siyuan?.config?.api?.token || "";
    const form = new FormData();
    form.append("assetsPath", "/assets/");
    form.append("file[]", blob, fileName);
    const res = await fetch(`/api/asset/upload?token=${encodeURIComponent(token)}`, {
        method: "POST",
        body: form,
    });
    const json = await res.json();
    if (json.code !== 0) throw new Error(json.msg || "upload failed");
    const path = json.data?.succMap?.[fileName];
    if (!path) throw new Error(json.msg || "upload failed");
    return path as string;
}

/** Appends a markdown block (e.g. an image reference) to the doc root. */
export async function appendBlockMarkdown(parentId: string, markdown: string): Promise<void> {
    const res = await fetchSyncPost("/api/block/appendBlock", {
        dataType: "markdown",
        data: markdown,
        parentID: parentId,
    });
    const code = (res as {code?: number}).code;
    if (code !== 0) throw new Error((res as {msg?: string}).msg || "appendBlock failed");
}
