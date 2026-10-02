/** Verify: 3 rects render straight AND with uniform width (no gaps/holes). */
import {execSync} from "node:child_process";
import {writeFileSync} from "node:fs";

const targets = JSON.parse(execSync("curl -s -m 5 http://127.0.0.1:9222/json", {maxBuffer: 1e7}).toString());
const page = targets.find((t) => t.type === "page" && /stage\/build/.test(t.url)) || targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, {resolve, reject});
    ws.send(JSON.stringify({id: msgId, method, params}));
});
ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
        const {resolve} = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
    }
};
const evalIn = async (expression) => {
    const res = await send("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true});
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 400));
    return res.result?.result?.value;
};

const measure = (st) => `
  (() => {
    const ovx = (window.siyuan.ws.app.plugins || []).find(p => p.name === 'pencil-annotation').activeOverlay;
    const s = ovx.store.strokes[${st}];
    const vp = ovx.viewport();
    const off = ovx.buildOffsets()(s);
    const gp = ovx.renderer.getPath(s, true);
    const t = document.createElement('canvas');
    t.width = ovx.inkCanvas.width; t.height = ovx.inkCanvas.height;
    const tc = t.getContext('2d');
    tc.save();
    tc.translate(-vp.originX, -vp.originY);
    tc.translate(off.dx, off.dy);
    if (gp.strokeWidth > 0) {
      tc.strokeStyle = '#e03131'; tc.lineWidth = gp.strokeWidth;
      tc.lineJoin = 'round'; tc.lineCap = 'round';
      tc.stroke(gp.path);
    } else { tc.fillStyle = '#e03131'; tc.fill(gp.path); }
    tc.restore();
    const d = tc.getImageData(0, 0, t.width, t.height).data;
    const W = t.width;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, ink = 0;
    const rowInk = new Map(), colInk = new Map();
    for (let y = 0; y < t.height; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (d[i+3] > 60 && d[i] > 150 && d[i+1] < 110 && d[i+2] < 110) {
        ink++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        rowInk.set(y, (rowInk.get(y) || 0) + 1);
        colInk.set(x, (colInk.get(x) || 0) + 1);
      }
    }
    // straightness: top vs bottom band x-extents, left vs right column y-extents
    const band = (m) => { let lo = 1e9, hi = -1; for (const [x, y] of []) {} 
      for (let x = minX; x <= maxX; x++) if (colInk.get(x) && false) {}
      return [lo, hi]; };
    const rowExtent = (y0, y1) => { let lo = 1e9, hi = -1;
      for (let y = y0; y <= y1; y++) { const c = rowInk.get(y) || 0; if (!c) continue; }
      for (let x = minX; x <= maxX; x++) { let hit = false;
        for (let y = y0; y <= y1; y++) { const i = (y * W + x) * 4; if (d[i+3] > 60 && d[i] > 150) { hit = true; break; } }
        if (hit) { if (x < lo) lo = x; if (x > hi) hi = x; } }
      return [lo, hi]; };
    const colExtent = (x0, x1) => { let lo = 1e9, hi = -1;
      for (let y = minY; y <= maxY; y++) { let hit = false;
        for (let x = x0; x <= x1; x++) { const i = (y * W + x) * 4; if (d[i+3] > 60 && d[i] > 150) { hit = true; break; } }
        if (hit) { if (y < lo) lo = y; if (y > hi) hi = y; } }
      return [lo, hi]; };
    const top = rowExtent(minY + 1, minY + 6);
    const bot = rowExtent(maxY - 5, maxY - 1);
    const lef = colExtent(minX + 1, minX + 6);
    const rig = colExtent(maxX - 5, maxX - 1);
    // gaps: empty rows/cols strictly inside the bbox
    let gapRows = 0, gapCols = 0;
    for (let y = minY + 1; y < maxY; y++) if (!rowInk.get(y)) gapRows++;
    for (let x = minX + 1; x < maxX; x++) if (!colInk.get(x)) gapCols++;
    const perim = 2 * ((maxX - minX) + (maxY - minY));
    return {
      strokeWidth: gp.strokeWidth,
      bbox: [minX, minY, maxX, maxY],
      straight: Math.abs(top[0] - bot[0]) < 6 && Math.abs(top[1] - bot[1]) < 6 &&
                Math.abs(lef[0] - rig[0]) < 6 && Math.abs(lef[1] - rig[1]) < 6,
      gapRows, gapCols,
      thickness: +(ink / perim).toFixed(2)
    };
  })()`;

ws.onopen = async () => {
    try {
        await send("Runtime.enable");
        await send("Page.enable");
        await send("Page.bringToFront");
        for (let i = 0; i < 40; i++) {
            const c = await evalIn(`((window.siyuan?.ws?.app?.plugins||[]).find(p=>p.name==='pencil-annotation')?.activeOverlay?.store?.strokes||[]).length`);
            if (c > 0) break;
            await new Promise(r => setTimeout(r, 500));
        }
        const cnt = await evalIn(`(window.siyuan.ws.app.plugins||[]).find(p=>p.name==='pencil-annotation').activeOverlay.store.strokes.length`);
        for (let i = 0; i < cnt; i++) {
            console.log(`stroke[${i}]`, JSON.stringify(await evalIn(measure(i))));
        }
        const shot = await send("Page.captureScreenshot", {format: "png"});
        writeFileSync(process.env.TEMP + "\\pa-verify-width.png", Buffer.from(shot.result.data, "base64"));
        console.log("screenshot saved");
    } catch (e) {
        console.error("ERROR:", e.message);
        process.exit(1);
    } finally { process.exit(0); }
};
setTimeout(() => { console.error("timeout"); process.exit(2); }, 60000);
