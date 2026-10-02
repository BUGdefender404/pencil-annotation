/** Re-renders store stroke 0 through the overlay's own renderer and measures it. */
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
  const ov = pl && pl.activeOverlay;
  if (!ov) return {err: 'no overlay'};
  const st = ov.store.strokes[0];
  if (!st) return {err: 'no strokes'};

  // measure block offsets + viewport the same way paint does
  const off = ov.strokeOffsets ? ov.strokeOffsets()(st) : {dx: 0, dy: 0};
  const vp = ov.viewport || (ov.renderer && ov.renderer.viewport) || null;

  // render stroke 0 alone through the overlay's renderer
  const t = document.createElement('canvas');
  t.width = 1836; t.height = 926;
  const tc = t.getContext('2d');
  tc.setTransform(1, 0, 0, 1, 0, 0);
  try {
    if (ov.paintStrokes) {
      // not exposed? fall back below
    }
  } catch (e) {}
  const path = ov.renderer.getPath(st, false).path;
  tc.save();
  if (vp) tc.translate(-vp.originX, -vp.originY);
  tc.translate(off.dx, off.dy);
  tc.globalAlpha = st.opacity;
  tc.fillStyle = '#e03131';
  tc.fill(path);
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
  // corner check: is the rendered ink axis-aligned? sample the four extreme
  // corners of the bbox — a straight rect has ink along top/bottom edges at
  // both left and right x; a tilted one does not
  const inkAt = (x, y) => { const i = (y * t.width + x) * 4; return d[i+3] > 60; };
  const probe = {
    topLeftInk: inkAt(minX + 3, minY + 3),
    topRightInk: inkAt(maxX - 3, minY + 3),
    botLeftInk: inkAt(minX + 3, maxY - 3),
    botRightInk: inkAt(maxX - 3, maxY - 3)
  };
  return {
    offset: off,
    viewport: vp ? {originX: vp.originX, originY: vp.originY, w: vp.width, h: vp.height} : null,
    pathBbox: [minX, minY, maxX, maxY],
    redPx: red,
    corners: probe,
    strokePts: st.points.map(p => [Math.round(p.x), Math.round(p.y)])
  };
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
