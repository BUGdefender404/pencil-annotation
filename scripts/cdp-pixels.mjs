/** Pixel-level forensics: which canvas holds the red strokes, straight or tilted. */
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
  const protyle = document.querySelector('.layout__center .protyle:not(.fn__none)') || document;
  const canvases = [...protyle.querySelectorAll('canvas.pa-canvas')];
  return canvases.map((c, idx) => {
    const t = document.createElement('canvas');
    t.width = c.width; t.height = c.height;
    const tc = t.getContext('2d');
    tc.drawImage(c, 0, 0);
    let red = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    const d = tc.getImageData(0, 0, t.width, t.height).data;
    for (let y = 0; y < t.height; y += 2) {
      for (let x = 0; x < t.width; x += 2) {
        const i = (y * t.width + x) * 4;
        const r = d[i], g = d[i+1], b = d[i+2], a = d[i+3];
        if (a > 60 && r > 150 && g < 110 && b < 110) {
          red++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    const r = c.getBoundingClientRect();
    return {
      idx,
      cls: c.className,
      redPx: red,
      redBbox: red ? [minX, minY, maxX, maxY] : null,
      cssRect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      containerCls: String(c.parentElement && c.parentElement.className),
      containers: (() => { const p = c.closest('.pa-overlay'); return p ? {n: 1, rectSame: true} : null; })()
    };
  });
})()`;

ws.onopen = async () => {
    try {
        await send("Runtime.enable");
        const res = await send("Runtime.evaluate", {expression: expr, awaitPromise: true, returnByValue: true});
        if (res.result?.exceptionDetails) console.error("EXCEPTION:", JSON.stringify(res.result.exceptionDetails, null, 2));
        else console.log(JSON.stringify(res.result?.result?.value, null, 1));
    } finally { process.exit(0); }
};
setTimeout(() => { console.error("timeout"); process.exit(2); }, 30000);
