/** Renders stroke 0 three ways (cached path / live-rebuilt / raw polygon) and
 *  returns PNGs so the shapes can be compared visually. */
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

const expr = `(async () => {
  const pl = (window.siyuan && window.siyuan.ws && window.siyuan.ws.app.plugins || []).find(p => p.name === 'pencil-annotation');
  const ov = pl.activeOverlay;
  const st = ov.store.strokes[0];
  const vp = ov.viewport();
  const off = ov.buildOffsets()(st);

  const make = (fill) => {
    const t = document.createElement('canvas');
    t.width = 400; t.height = 200;
    const tc = t.getContext('2d');
    // crop window: around the stroke, canvas coords minus vp
    const baseX = 940, baseY = 80;   // temp-canvas origin in canvas coords
    tc.setTransform(1, 0, 0, 1, 0, 0);
    tc.save();
    tc.translate(-vp.originX + off.dx - baseX, -vp.originY + off.dy - baseY);
    tc.fillStyle = '#e03131';
    fill(tc);
    tc.restore();
    return t.toDataURL('image/png');
  };

  const cached = make((tc) => tc.fill(ov.renderer.getPath(st, false).path));
  const rebuilt = make((tc) => tc.fill(ov.renderer.getPath(st, true).path));
  const manual = make((tc) => {
    const p = new Path2D();
    p.moveTo(st.points[0].x, st.points[0].y);
    for (let i = 1; i < st.points.length; i++) p.lineTo(st.points[i].x, st.points[i].y);
    p.closePath();
    tc.lineWidth = st.width;
    tc.lineJoin = 'round';
    tc.stroke(p);
  });
  return {cached, rebuilt, manual};
})()`;

ws.onopen = async () => {
    try {
        await send("Runtime.enable");
        const res = await send("Runtime.evaluate", {expression: expr, awaitPromise: true, returnByValue: true});
        if (res.result?.exceptionDetails) {
            console.error("EXCEPTION:", JSON.stringify(res.result.exceptionDetails, null, 2));
        } else {
            const v = res.result?.result?.value;
            if (v) {
                for (const k of Object.keys(v)) {
                    const b64 = v[k].split(",")[1];
                    writeFileSync(`${process.env.TEMP}\\pa-path-${k}.png`, Buffer.from(b64, "base64"));
                    console.log(`saved pa-path-${k}.png`);
                }
            }
        }
    } finally { process.exit(0); }
};
setTimeout(() => { console.error("timeout"); process.exit(2); }, 30000);
