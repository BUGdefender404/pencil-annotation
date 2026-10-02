/** Captures a screenshot of the running SiYuan window via CDP. */
import {execSync} from "node:child_process";
import {writeFileSync} from "node:fs";

const out = process.argv[2] || process.env.TEMP + "\\pa-shot.png";

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

ws.onopen = async () => {
    try {
        await send("Page.enable");
        await send("Page.bringToFront");
        await new Promise(r => setTimeout(r, 600));
        const shot = await send("Page.captureScreenshot", {format: "png"});
        writeFileSync(out, Buffer.from(shot.result.data, "base64"));
        console.log("saved:", out);
    } catch (e) {
        console.error("error:", e.message);
        process.exit(1);
    } finally {
        process.exit(0);
    }
};
setTimeout(() => { console.error("timeout"); process.exit(2); }, 20000);
