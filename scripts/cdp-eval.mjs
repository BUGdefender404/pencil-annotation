/**
 * Evaluates a JS expression inside the running SiYuan desktop app via CDP.
 * Usage: node scripts/cdp-eval.mjs "<expression>"
 * Requires SiYuan launched with --remote-debugging-port=9222.
 */
import {execSync} from "node:child_process";

const expr = process.argv[2];
if (!expr) {
    console.error("usage: node scripts/cdp-eval.mjs \"<expression>\"");
    process.exit(1);
}

const targets = JSON.parse(execSync("curl -s -m 5 http://127.0.0.1:9222/json", {maxBuffer: 1e7}).toString());
const page = targets.find((t) => t.type === "page" && /stage\/build|check-auth|6806/.test(t.url))
    || targets.find((t) => t.type === "page");
if (!page) {
    console.error("no page target found; targets:", targets.map((t) => `${t.type}:${t.url}`).join("\n"));
    process.exit(1);
}

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
        await send("Runtime.enable");
        const res = await send("Runtime.evaluate", {
            expression: expr,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
        });
        if (res.result?.exceptionDetails) {
            console.error("EXCEPTION:", JSON.stringify(res.result.exceptionDetails, null, 2));
        } else {
            console.log(JSON.stringify(res.result?.result?.value, null, 2));
        }
    } catch (e) {
        console.error("CDP error:", e.message);
    } finally {
        process.exit(0);
    }
};

ws.onerror = (e) => {
    console.error("ws error");
    process.exit(1);
};

setTimeout(() => {
    console.error("timeout");
    process.exit(2);
}, 20000);
