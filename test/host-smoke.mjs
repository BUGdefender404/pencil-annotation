// Optional real-host integration: never opens or modifies an existing workspace.
import assert from "node:assert/strict";
import {mkdtemp, mkdir, cp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, dirname, resolve} from "node:path";
import {spawn} from "node:child_process";
import {once} from "node:events";
import net from "node:net";
import {chromium, webkit} from "playwright";

const kernel = process.env.SIYUAN_KERNEL;
assert(kernel, "Set SIYUAN_KERNEL to an installed SiYuan kernel executable; run npm run build first.");
const workspace = await mkdtemp(join(tmpdir(), "pencil-host-test-"));
await mkdir(join(workspace, "data/plugins/pencil-annotation"), {recursive: true});
await cp(resolve("build"), join(workspace, "data/plugins/pencil-annotation"), {recursive: true});
const socket = net.createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
const port = socket.address().port; await new Promise(r => socket.close(r));
const base = `http://127.0.0.1:${port}`;
const authCode = `pencil-test-${port}`;
const child = spawn(kernel, ["serve", `--workspace=${workspace}`, `--port=${port}`, `--accessAuthCode=${authCode}`, "--lang=en",
    `--wd=${dirname(dirname(kernel))}`], {stdio: ["ignore", "pipe", "pipe"]});
let logs = "";
let startError;
child.on("error", error => { startError = error; });
child.stdout.on("data", b => { logs += b; }); child.stderr.on("data", b => { logs += b; });
let token;
const api = async (path, data = {}) => {
    const res = await fetch(base + path, {method: "POST", headers: {"Content-Type": "application/json", Authorization: `Token ${token}`}, body: JSON.stringify(data)});
    assert(res.ok, `${path}: HTTP ${res.status}`);
    const result = await res.json(); assert.equal(result.code, 0, `${path}: ${result.msg}`); return result.data;
};
try {
    for (let i = 0; i < 100; i++) {
        try {
            token = JSON.parse(await readFile(join(workspace, "conf/conf.json"), "utf8")).api.token;
            await api("/api/notebook/lsNotebooks"); break;
        } catch {
            if (i === 99 || startError || child.exitCode !== null) throw new Error(`Kernel did not boot: ${startError || logs}`);
            await new Promise(r => setTimeout(r, 100));
        }
    }
    await api("/api/system/setDownloadInstallPkg", {downloadInstallPkg: false});
    await api("/api/setting/setBazaar", {trust: true, petalDisabled: false});
    await api("/api/petal/setPetalEnabled", {packageName: "pencil-annotation", enabled: true});
    const notebook = (await api("/api/notebook/createNotebook", {name: "Pencil regression"})).notebook.id;
    const doc = await api("/api/filetree/createDocWithMd", {notebook, path: "/Pen regression", markdown:
        "- [ ] Do not toggle with pen\n\n| Column | Value |\n| --- | --- |\n| Drag with mouse | Test |\n\n" +
        Array.from({length: 30}, (_, i) => `Paragraph ${i}: native scrolling and persistent handwriting.`).join("\n\n")});
    for (const [name, mobile] of [["chromium", false], ["chromium", true], ["webkit", true]]) {
        const browser = await ({chromium, webkit}[name]).launch(name === "chromium" ? {channel: "chromium"} : {});
        try {
            const context = await browser.newContext({viewport: mobile ? {width: 390, height: 844} : {width: 1100, height: 800}, isMobile: mobile, hasTouch: mobile, ignoreHTTPSErrors: true});
            await context.request.post(base + "/api/system/loginAuth", {data: {authCode}});
            const page = await context.newPage();
            const errors = [];
            page.on("pageerror", error => {
                // SiYuan 3.7.2 also emits this navigation-abort rejection with all plugins disabled.
                if (name === "webkit" && error.message.endsWith("/api/storage/setLocalStorageVal due to access control checks.")) return;
                errors.push(error.message);
            });
            const open = async () => {
                await page.goto(base + (mobile ? "/stage/build/mobile/" : "/"));
                await page.waitForSelector("#loading", {state: "hidden"});
                await page.waitForSelector(".pa-handle");
                // The fresh-workspace guide opens asynchronously after plugin initialization.
                if (!mobile) await page.locator(".protyle-wysiwyg:visible").first().waitFor();
                // Mobile opens its document tree from the top-left menu.
                if (mobile) await page.mouse.click(24, 24);
                const note = page.getByText("Pen regression", {exact: true}).first();
                if (!await note.count()) {
                    if (mobile) await page.getByText("Pencil regression", {exact: true}).click();
                    else await page.getByText("Pencil regression", {exact: true}).dblclick();
                }
                await note.click();
                await page.waitForFunction(id => Array.from(window.siyuan.ws.app.plugins.find(p => p.name === "pencil-annotation").overlays.values()).some(o => o.docId === id && o.store.loaded), doc);
            };
            await open();
            const count = () => page.evaluate(id => Array.from(window.siyuan.ws.app.plugins.find(p => p.name === "pencil-annotation").overlays.values()).find(o => o.docId === id).store.strokes.length, doc);
            const before = await count();
            await page.locator(".pa-handle").click();
            const task = page.locator('[data-type="NodeListItem"][data-subtype="t"]:visible').first();
            const taskBefore = await task.getAttribute("data-task");
            const target = task.locator(".protyle-action").first();
            const rect = await target.boundingBox();
            if (name === "chromium") {
                const cdp = await context.newCDPSession(page);
                const x = rect.x + 10, y = rect.y + 10;
                const palmScroll = await page.evaluate(id => Array.from(window.siyuan.ws.app.plugins[0].overlays.values()).find(o => o.docId === id).protyle.contentElement.scrollTop, doc);
                await cdp.send("Input.dispatchMouseEvent", {type: "mousePressed", pointerType: "pen", button: "left", buttons: 1, clickCount: 1, x, y, force: .5});
                for (let i = 1; i <= 6; i++) {
                    await cdp.send("Input.dispatchMouseEvent", {type: "mouseMoved", pointerType: "pen", buttons: 1, x: x + i * 5, y: y + i * 6, force: .5});
                    if (mobile && i === 2) {
                        await cdp.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x: 280, y: 600}]});
                        await cdp.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{x: 280, y: 550}]});
                    }
                    if (mobile && i === 4) await cdp.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
                }
                await cdp.send("Input.dispatchMouseEvent", {type: "mouseReleased", pointerType: "pen", button: "left", buttons: 0, clickCount: 1, x: x + 30, y: y + 36});
                const strokeEnd = await page.evaluate(id => {
                    const o = Array.from(window.siyuan.ws.app.plugins[0].overlays.values()).find(o => o.docId === id);
                    const rect = o.protyle.wysiwyg.element.getBoundingClientRect();
                    const point = o.store.strokes.at(-1).points.at(-1);
                    return {x: point.x + rect.x, y: point.y + rect.y, scroll: o.protyle.contentElement.scrollTop};
                }, doc);
                assert(Math.abs(strokeEnd.x - x - 30) < 1 && Math.abs(strokeEnd.y - y - 36) < 1, "full pen endpoint must survive concurrent touch");
                assert.equal(strokeEnd.scroll, palmScroll, "palm must not pan during pen contact");
                if (mobile) {
                    const scrollBefore = await page.evaluate(id => Array.from(window.siyuan.ws.app.plugins[0].overlays.values()).find(o => o.docId === id).protyle.contentElement.scrollTop, doc);
                    await cdp.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x: 280, y: 700}]});
                    for (let y = 680; y >= 350; y -= 20) {
                        await cdp.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{x: 280, y}]});
                        await new Promise(r => setTimeout(r, 16));
                    }
                    await cdp.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
                    const scrollAfter = await page.evaluate(id => Array.from(window.siyuan.ws.app.plugins[0].overlays.values()).find(o => o.docId === id).protyle.contentElement.scrollTop, doc);
                    assert(scrollAfter > scrollBefore + 150, "real mobile editor must pan without interrupting ink");
                }
            } else {
                // WebKit automation does not expose hardware pen injection; dispatch the real handler path.
                await target.evaluate((el, rect) => {
                    for (const [type, dx, dy] of [["pointerdown", 0, 0], ["pointermove", 20, 20], ["pointerup", 30, 30]]) {
                        el.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true, pointerId: 20, pointerType: "pen", pressure: .5,
                            button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: rect.x + 10 + dx, clientY: rect.y + 10 + dy}));
                    }
                }, rect);
            }
            assert.equal(await task.getAttribute("data-task"), taskBefore, "pen must not toggle task");
            await page.waitForFunction(id => {
                const o = Array.from(window.siyuan.ws.app.plugins[0].overlays.values()).find(o => o.docId === id);
                return o.store.strokes.length > 0 && !o.store.dirty && !o.store.saving;
            }, doc);
            assert.equal(await count(), before + 1);
            const disk = JSON.parse(await readFile(join(workspace, `data/storage/petal/pencil-annotation/${doc}.json`), "utf8"));
            assert.equal(disk.strokes.length, before + 1);
            await open();
            assert.equal(await count(), before + 1, "reload must recover all saved ink");
            await page.locator(".pa-handle").click();
            const nativeTask = page.locator('[data-type="NodeListItem"][data-subtype="t"]:visible').first();
            const oldTask = await nativeTask.getAttribute("data-task");
            await nativeTask.locator(".protyle-action").first().click();
            await page.waitForFunction(old => document.querySelector('[data-type="NodeListItem"][data-subtype="t"]')?.getAttribute("data-task") !== old, oldTask);
            assert.equal(await count(), before + 1, "native mouse task click must not draw");
            if (process.env.PENCIL_ARTIFACT_DIR) {
                await mkdir(process.env.PENCIL_ARTIFACT_DIR, {recursive: true});
                await page.screenshot({path: join(process.env.PENCIL_ARTIFACT_DIR, `${name}-${mobile ? "mobile" : "desktop"}.png`)});
            }
            assert.deepEqual(errors, []);
            console.log(`SiYuan ${name}/${mobile ? "mobile" : "desktop"}: plugin load, task isolation, kernel save and reload passed`);
        } catch (error) {
            for (const ctx of browser.contexts()) for (const page of ctx.pages()) {
                await page.screenshot({path: `/tmp/pencil-host-failure-${name}.png`});
                console.error((await page.locator("body").innerText()).slice(0,1200));
            }
            throw error;
        } finally { await browser.close(); }
    }
} finally {
    if (!startError && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill("SIGTERM");
        const force = setTimeout(() => child.kill("SIGKILL"), 5000);
        await exited; clearTimeout(force);
    }
    await rm(workspace, {recursive: true, force: true});
}
