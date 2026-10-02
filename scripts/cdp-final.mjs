/** Final identity + geometry experiments on the live overlay. */
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

const measureRed = `(c) => {
  const t = document.createElement('canvas');
  t.width = c.width; t.height = c.height;
  const tc = t.getContext('2d');
  tc.drawImage(c, 0, 0);
  const d = tc.getImageData(0, 0, t.width, t.height).data;
  let red = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  for (let y = 0; y < t.height; y += 2) for (let x = 0; x < t.width; x += 2) {
    const i = (y * t.width + x) * 4;
    if (d[i+3] > 60 && d[i] > 150 && d[i+1] < 110 && d[i+2] < 110) {
      red++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return {red, bbox: red ? [minX, minY, maxX, maxY] : null};
}`;

const expr = `(async () => {
  const pl = (window.siyuan && window.siyuan.ws && window.siyuan.ws.app.plugins || []).find(p => p.name === 'pencil-annotation');
  const ov = pl.activeOverlay;
  const all = [...document.querySelectorAll('canvas.pa-canvas')];
  const out = {};
  out.inkIsCanvas0 = ov.inkCanvas === all[0];
  out.liveIsCanvas2 = ov.liveCanvas === all[2];
  out.inkRed = (${measureRed})(ov.inkCanvas);
  out.liveRed = (${measureRed})(ov.liveCanvas);

  const vp = ov.viewport();
  out.vp = {originX: vp.originX, originY: vp.originY, w: vp.width, h: vp.height};
  const st = ov.store.strokes[0];
  const off = ov.buildOffsets()(st);
  out.off = off;

  // render stroke 0's current cached path into temp canvas with the real vp
  const t = document.createElement('canvas');
  t.width = 1836; t.height = 926;
  const tc = t.getContext('2d');
  tc.setTransform(1, 0, 0, 1, 0, 0);
  const p = ov.renderer.getPath(st, false);
  tc.save();
  tc.translate(-vp.originX, -vp.originY);
  tc.translate(off.dx, off.dy);
  tc.fillStyle = '#e03131';
  tc.fill(p.path);
  tc.restore();
  const d = tc.getImageData(0, 0, t.width, t.height).data;
  let red = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
  for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
    const i = (y * t.width + x) * 4;
    if (d[i+3] > 60 && d[i] > 150 && d[i+1] < 110 && d[i+2] < 110) {
      red++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  out.stroke0RenderedBbox = red ? [minX, minY, maxX, maxY] : null;
  out.stroke0Pts = st.points.map(q => [Math.round(q.x), Math.round(q.y)]);
  return out;
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
