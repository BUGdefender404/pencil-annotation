/** Dumps live pencil-annotation strokes + render state from running SiYuan. */
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
  const ov = pl.activeOverlay;
  if (!ov) return {err: 'no active overlay', overlays: pl.overlays ? [...pl.overlays.keys()] : null};
  const st = ov.store.strokes;
  return {
    docId: ov.docId,
    count: st.length,
    firstKeys: st[0] ? Object.keys(st[0]) : null,
    strokes: st.map(s => {
      const pts = s.points || [];
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      return {
        id: String(s.id || '').slice(-10),
        n: pts.length,
        pts: pts.map(p => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]),
        anchor: s.anchor ? String(s.anchor.blockId).slice(-8) + ' ox=' + s.anchor.ox + ' oy=' + s.anchor.oy : null,
        tool: s.tool
      };
    })
  };
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
