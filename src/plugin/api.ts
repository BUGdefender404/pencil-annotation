import {fetchSyncPost, type Plugin} from "siyuan";
import type {PencilPayload} from "../engine/types";

/**
 * Kernel-backed persistence. Doc payloads live in the plugin's private
 * petal directory (/data/storage/petal/pencil-annotation/<docId>.json),
 * which participates in SiYuan's encrypted cloud sync — strokes written on
 * the iPad show up on the desktop and vice versa.
 */

const LOAD_TIMEOUT = 8000;
const SAVE_TIMEOUT = 10000;

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
    Promise.race([
        p,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`kernel timeout after ${ms}ms`)), ms)),
    ]);

export const storageName = (docId: string) => `${docId}.json`;

export async function loadPayload(plugin: Plugin, docId: string): Promise<PencilPayload | null> {
    const name = storageName(docId);
    // drop the instance cache so we read the real file (see loadData docs)
    delete (plugin as unknown as {data: Record<string, unknown>}).data[name];
    try {
        const data = await withTimeout(plugin.loadData(name), LOAD_TIMEOUT);
        if (!data || typeof data === "string" || typeof data !== "object") return null;
        const payload = data as PencilPayload;
        if (!Array.isArray(payload.strokes)) return null;
        return payload;
    } catch (e) {
        console.error("[pencil-annotation] loadPayload failed", e);
        return null;
    }
}

export async function savePayload(plugin: Plugin, payload: PencilPayload): Promise<boolean> {
    try {
        await withTimeout(plugin.saveData(storageName(payload.docId), payload), SAVE_TIMEOUT);
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
