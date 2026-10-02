/** Reproduce: start stroke 2 immediately inside stroke 1's pending window. */
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
const evalIn = async (expression) => {
    const res = await send("Runtime.evaluate", {expression, awaitPromise: true, returnByValue: true});
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails).slice(0, 500));
    return res.result?.result?.value;
};

const expr = `(async () => {
  const pl = (window.siyuan && window.siyuan.ws && window.siyuan.ws.app.plugins || []).find(p => p.name === 'pencil-annotation');
  const ov = pl.activeOverlay;
  const log = [];
  const capture = ov.capture;
  const r = capture.getBoundingClientRect();
  const fire = (type, x, y, pid) => {
    capture.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: pid, pointerType: 'pen',
      isPrimary: true, pressure: 0.5, buttons: type === 'pointerup' ? 0 : 1,
      clientX: x, clientY: y
    }));
  };
  const X = (fx) => r.left + r.width * fx;
  const Y = (fy) => r.top + r.height * fy;
  const count = () => ov.store.strokes.length;

  // stroke 1: a straight horizontal line (should stage pending via line snap)
  fire('pointerdown', X(0.30), Y(0.50), 51);
  log.push(['down1', 'drawing=' + ov.drawing, 'n=' + ov.curPoints.length]);
  for (let i = 1; i <= 12; i++) {
    fire('pointermove', X(0.30 + 0.25 * i / 12), Y(0.50), 51);
    await new Promise(r2 => setTimeout(r2, 15));
  }
  log.push(['moves1', 'n=' + ov.curPoints.length]);
  fire('pointerup', X(0.55), Y(0.50), 51);
  await new Promise(r2 => setTimeout(r2, 60));
  log.push(['up1', 'count=' + count(), 'pending=' + !!ov.pendingSnap, 'drawing=' + ov.drawing]);

  // stroke 2 IMMEDIATELY (inside the 800ms pending window)
  fire('pointerdown', X(0.30), Y(0.56), 52);
  log.push(['down2', 'drawing=' + ov.drawing, 'n=' + ov.curPoints.length, 'pending=' + !!ov.pendingSnap]);
  for (let i = 1; i <= 12; i++) {
    fire('pointermove', X(0.30 + 0.25 * i / 12), Y(0.56), 52);
    await new Promise(r2 => setTimeout(r2, 15));
  }
  log.push(['moves2', 'n=' + ov.curPoints.length, 'drawing=' + ov.drawing]);
  fire('pointerup', X(0.55), Y(0.56), 52);
  await new Promise(r2 => setTimeout(r2, 1200));
  log.push(['end', 'count=' + count()]);
  return log;
})()`;

ws.onopen = async () => {
    try {
        await send("Runtime.enable");
        console.log(JSON.stringify(await evalIn(expr), null, 1));
    } catch (e) {
        console.error("ERROR:", e.message);
        process.exit(1);
    } finally { process.exit(0); }
};
setTimeout(() => { console.error("timeout"); process.exit(2); }, 30000);
