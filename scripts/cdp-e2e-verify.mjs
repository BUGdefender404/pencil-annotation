/** End-to-end verification: existing strokes must render as axis-aligned
 *  rects on canvas; a synthesized pen-drawn box must snap and render straight. */
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

const waitOverlay = `(async () => {
  for (let i = 0; i < 60; i++) {
    const pl = (window.siyuan && window.siyuan.ws && window.siyuan.ws.app.plugins || []).find(p => p.name === 'pencil-annotation');
    const ov = pl && pl.activeOverlay;
    if (ov && ov.store && ov.store.strokes) return {count: ov.store.strokes.length};
    await new Promise(r => setTimeout(r, 500));
  }
  return {err: 'overlay never appeared'};
})()`;

const straightCheck = (st) => `
  (() => {
    const ovx = (window.siyuan.ws.app.plugins || []).find(p => p.name === 'pencil-annotation').activeOverlay;
    const st = ovx.store.strokes[${st}];
    const vp = ovx.viewport();
    const off = ovx.buildOffsets()(st);
    const t = document.createElement('canvas');
    t.width = ovx.inkCanvas.width; t.height = ovx.inkCanvas.height;
    const tc = t.getContext('2d');
    tc.save();
    tc.translate(-vp.originX, -vp.originY);
    tc.translate(off.dx, off.dy);
    tc.fillStyle = '#e03131';
    tc.fill(ovx.renderer.getPath(st, true).path);
    tc.restore();
    const d = tc.getImageData(0, 0, t.width, t.height).data;
    const W = t.width;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    const ink = [];
    for (let y = 0; y < t.height; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (d[i+3] > 60 && d[i] > 150 && d[i+1] < 110 && d[i+2] < 110) {
        ink.push([x, y]);
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    if (!ink.length) return {err: 'no ink rendered'};
    const band = (y0, y1) => {
      let lo = 1e9, hi = -1;
      for (const [x, y] of ink) if (y >= y0 && y <= y1) { if (x < lo) lo = x; if (x > hi) hi = x; }
      return [lo, hi];
    };
    const col = (x0, x1) => {
      let lo = 1e9, hi = -1;
      for (const [x, y] of ink) if (x >= x0 && x <= x1) { if (y < lo) lo = y; if (y > hi) hi = y; }
      return [lo, hi];
    };
    const top = band(minY + 1, minY + 6);
    const bot = band(maxY - 5, maxY - 1);
    const lef = col(minX + 1, minX + 6);
    const rig = col(maxX - 5, maxX - 1);
    return {
      bbox: [minX, minY, maxX, maxY],
      straight: Math.abs(top[0] - bot[0]) < 6 && Math.abs(top[1] - bot[1]) < 6 &&
                Math.abs(lef[0] - rig[0]) < 6 && Math.abs(lef[1] - rig[1]) < 6,
      topDiff: [top[0] - bot[0], top[1] - bot[1]],
      leftDiff: [lef[0] - rig[0], lef[1] - rig[1]]
    };
  })()`;

const drawBox = `(async () => {
  const pl = (window.siyuan && window.siyuan.ws && window.siyuan.ws.app.plugins || []).find(p => p.name === 'pencil-annotation');
  const ov = pl.activeOverlay;
  const fire = (type, x, y, pressure) => {
    const el = document.elementFromPoint(x, y) || ov.capture;
    el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 7, pointerType: 'pen',
      isPrimary: true, pressure, buttons: type === 'pointerup' ? 0 : 1,
      clientX: x, clientY: y, width: 1, height: 1
    }));
  };
  // a casually sheared box with a wobble, drawn quickly (like a human)
  const x0 = 700, y0 = 520, x1 = 900, y1 = 585, shear = 18;
  const pts = [];
  const N = 14;
  const corners = [[x0, y0], [x1, y0 + shear * 0.3], [x1 - shear, y1], [x0 + shear * 0.2, y1 - 4], [x0, y0]];
  let px = x0, py = y0;
  for (let i = 1; i <= N; i++) {
    const f = i / N;
    const seg = f * (corners.length - 1);
    const ci = Math.min(corners.length - 2, Math.floor(seg));
    const cf = seg - ci;
    const A = corners[ci], B = corners[ci + 1];
    px = A[0] + (B[0] - A[0]) * cf + Math.sin(f * 21) * 2.5;
    py = A[1] + (B[1] - A[1]) * cf + Math.cos(f * 17) * 2.5;
    pts.push([px, py]);
  }
  fire('pointerdown', x0, y0, 0.5);
  for (const [x, y] of pts) { fire('pointermove', x, y, 0.5); await new Promise(r => setTimeout(r, 16)); }
  fire('pointerup', px, py, 0.5);
  await new Promise(r => setTimeout(r, 1300)); // post-lift snap window + margin
  return {drawn: pts.length};
})()`;

ws.onopen = async () => {
    try {
        await send("Runtime.enable");
        await send("Page.enable");
        await send("Page.bringToFront");
        console.log("waiting for overlay...");
        console.log(JSON.stringify(await evalIn(waitOverlay)));

        // 1) existing strokes: render each through the live pipeline and assert straight
        const pl = await evalIn(`(window.siyuan.ws.app.plugins || []).find(p => p.name === 'pencil-annotation').activeOverlay.store.strokes.length`);
        for (let i = 0; i < pl; i++) {
            const r = await evalIn(straightCheck(i));
            console.log(`stroke[${i}]`, JSON.stringify(r));
        }

        // 2) draw a new casual box, then assert store + render
        console.log("drawing box...", JSON.stringify(await evalIn(drawBox)));
        const cnt = await evalIn(`(window.siyuan.ws.app.plugins || []).find(p => p.name === 'pencil-annotation').activeOverlay.store.strokes.length`);
        console.log("stroke count now:", cnt);
        const last = await evalIn(`(() => {
          const ov = (window.siyuan.ws.app.plugins || []).find(p => p.name === 'pencil-annotation').activeOverlay;
          const s = ov.store.strokes[ov.store.strokes.length - 1];
          const xs = s.points.map(p => p.x), ys = s.points.map(p => p.y);
          return {n: s.points.length, pts: s.points.map(p => [Math.round(p.x), Math.round(p.y)]),
                  axisAligned: s.points.length === 5 &&
                    Math.abs(s.points[0].y - s.points[1].y) < 2 && Math.abs(s.points[1].x - s.points[2].x) < 2 &&
                    Math.abs(s.points[2].y - s.points[3].y) < 2 && Math.abs(s.points[3].x - s.points[4].x) < 2};
        })()`);
        console.log("new stroke:", JSON.stringify(last));
        if (last.n) {
            const r = await evalIn(straightCheck(cnt - 1));
            console.log("new stroke render:", JSON.stringify(r));
        }

        // 3) full-window screenshot for visual proof
        const shot = await send("Page.captureScreenshot", {format: "png"});
        writeFileSync(process.env.TEMP + "\\pa-verify-final.png", Buffer.from(shot.result.data, "base64"));
        console.log("screenshot saved");
    } catch (e) {
        console.error("ERROR:", e.message);
        process.exit(1);
    } finally {
        process.exit(0);
    }
};
setTimeout(() => { console.error("timeout"); process.exit(2); }, 90000);
