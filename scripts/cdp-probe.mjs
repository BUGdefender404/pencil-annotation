/** Probes overlay instances, canvases and pixel truth in the running SiYuan. */
import {execSync} from "node:child_process";

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

const expr = `(() => {
  const pl = (window.siyuan && window.siyuan.ws && window.siyuan.ws.app.plugins || []).find(p => p.name === 'pencil-annotation');
  if (!pl) return {err: 'no plugin'};
  const out = {overlays: [], canvases: []};
  for (const [k, ov] of (pl.overlays || new Map())) {
    const st = (ov.store && ov.store.strokes) || [];
    out.overlays.push({
      key: String(k).slice(0, 24),
      docId: ov.docId,
      isActive: ov === pl.activeOverlay,
      strokeCount: st.length,
      shapes: st.map(s => {
        const pts = s.points || [];
        const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
        return {
          id: String(s.id || '').slice(-8),
          n: pts.length,
          bbox: pts.length ? [Math.round(Math.min(...xs)), Math.round(Math.min(...ys)), Math.round(Math.max(...xs)), Math.round(Math.max(...ys))] : null,
          axisAligned: pts.length === 5 ? (Math.abs(pts[0].y - pts[1].y) < 2 && Math.abs(pts[1].x - pts[2].x) < 2 && Math.abs(pts[2].y - pts[3].y) < 2 && Math.abs(pts[3].x - pts[4].x) < 2) : null
        };
      }),
      canvas: ov.canvas ? {
        cls: ov.canvas.className,
        w: ov.canvas.width, h: ov.canvas.height,
        cssW: ov.canvas.clientWidth, cssH: ov.canvas.clientHeight,
        inDoc: document.contains(ov.canvas),
        z: getComputedStyle(ov.canvas).zIndex,
        display: getComputedStyle(ov.canvas).display
      } : (ov.renderer && ov.renderer.canvas ? {cls: ov.renderer.canvas.className} : 'no-canvas-field')
    });
  }
  const protyle = document.querySelector('.layout__center .protyle:not(.fn__none)');
  if (protyle) {
    out.protyleId = protyle.id || null;
    for (const c of protyle.querySelectorAll('canvas')) {
      const r = c.getBoundingClientRect();
      out.canvases.push({
        cls: c.className,
        w: c.width, h: c.height,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        parentCls: String(c.parentElement && c.parentElement.className).slice(0, 50),
        z: getComputedStyle(c).zIndex
      });
    }
  }
  return out;
})()`;

ws.onopen = async () => {
    try {
        await send("Runtime.enable");
        const res = await send("Runtime.evaluate", {expression: expr, awaitPromise: true, returnByValue: true});
        if (res.result?.exceptionDetails) {
            console.error("EXCEPTION:", JSON.stringify(res.result.exceptionDetails, null, 2));
        } else {
            console.log(JSON.stringify(res.result?.result?.value, null, 1));
        }
    } finally {
        process.exit(0);
    }
};
setTimeout(() => { console.error("timeout"); process.exit(2); }, 20000);
