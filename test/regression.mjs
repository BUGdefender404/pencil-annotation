import assert from "node:assert/strict";
import {readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {createServer} from "vite";
import {chromium, webkit} from "playwright";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url)));
assert(manifest.backends.includes("docker"));
assert(manifest.frontends.includes("browser-mobile"));
const packFixture = mkdtempSync(join(tmpdir(), "pencil-pack-test-"));
try {
    mkdirSync(join(packFixture, "scripts")); mkdirSync(join(packFixture, "build"));
    copyFileSync(new URL("../scripts/pack.mjs", import.meta.url), join(packFixture, "scripts/pack.mjs"));
    writeFileSync(join(packFixture, "build/index.js"), "// archive fixture\n");
    const args = [join(packFixture, "scripts/pack.mjs")];
    const failed = spawnSync(process.execPath, args, {env: {...process.env, PATH: "", SystemRoot: packFixture}});
    assert.notEqual(failed.status, 0, "a missing archiver must not report success");
    const packed = spawnSync(process.execPath, args);
    assert.equal(packed.status, 0, packed.stderr.toString());
    const zip = readFileSync(join(packFixture, "package.zip"));
    assert.equal(zip.subarray(0, 2).toString(), "PK");
    assert(zip.includes(Buffer.from("index.js")));
} finally { rmSync(packFixture, {recursive: true, force: true}); }
const server = await createServer({server: {host: "127.0.0.1", port: 5199, strictPort: true}});
await server.listen();
const engines = process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"];
try {
    for (const name of engines) {
        const browser = await ({chromium, webkit}[name]).launch(name === "chromium" ? {channel: "chromium"} : {});
        const context = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", e => errors.push(e.message));
        const open = async (query = "") => {
            await page.goto(`http://127.0.0.1:5199/test/harness.html${query}`);
            await page.waitForFunction(() => window.harness?.overlay.store.loaded);
        };
        try {
            await open();
            const settings = await page.evaluate(async () => {
                const h = window.harness;
                const p = h.createPlugin();
                p.data["settings.json"] = {penWidth: 9};
                const migrated = await h.loadSettings(p);
                h.palette.setMode(false);
                h.palette.setHandleVisible(false);
                const hidden = h.palette.handle.style.display === "none";
                h.palette.setMode(true);
                const toolbar = h.palette.toolbar.style.display !== "none";
                h.palette.setMode(false);
                const stillHidden = h.palette.handle.style.display === "none";
                h.palette.setHandleVisible(true);
                const restored = h.palette.handle.style.display !== "none";
                await p.onload();
                const row = p.setting.items.find(i => i.title === "Mouse drawing");
                const checkbox = row.createActionElement();
                checkbox.checked = true;
                checkbox.dispatchEvent(new Event("change"));
                const persisted = p.data["settings.json"].mouseDrawing;
                await p.onunload();
                return {migrated, hidden, toolbar, stillHidden, restored, persisted};
            });
            assert.equal(settings.migrated.mouseDrawing, false);
            assert.equal(settings.migrated.doubleTapToggle, false);
            assert.equal(settings.migrated.showFloatingBall, true);
            assert.equal(settings.migrated.penWidth, 9);
            for (const key of ["hidden", "toolbar", "stillHidden", "restored", "persisted"]) assert(settings[key], key);
            console.log(`${name}: defaults, setting persistence and floating button passed`);

            await open();
            await page.evaluate(() => window.harness.palette.setMode(false));
            await page.locator("#todo").click();
            assert.equal(await page.locator("#todo").isChecked(), true);
            assert.equal(await page.evaluate(() => window.harness.strokesCount()), 0);
            await page.locator("#todo").tap();
            assert.equal(await page.locator("#todo").isChecked(), true, "finger taps must not edit in writing mode");
            await page.locator("#todo").click();
            assert.equal(await page.locator("#todo").isChecked(), false);
            const routing = await page.evaluate(() => {
                const h = window.harness;
                h.settings.doubleTapToggle = false;
                const todo = document.getElementById("todo");
                const r = todo.getBoundingClientRect();
                const x = r.x + r.width / 2, y = r.y + r.height / 2;
                const before = {...h.nativeEvents};
                h.fire(todo, "pointerdown", x, y, {pointerId: 31});
                h.fire(todo, "pointermove", x + 10, y + 10, {pointerId: 31});
                h.fire(todo, "pointerup", x + 20, y + 20, {pointerId: 31});
                todo.dispatchEvent(new PointerEvent("click", {bubbles: true, cancelable: true, pointerType: "pen", pointerId: 31, detail: 1, clientX: x + 20, clientY: y + 20}));
                const blocked = !todo.checked && h.nativeEvents.down === before.down && h.nativeEvents.click === before.click;
                h.stroke([[100, 130], [120, 160], [160, 170]], {pointerType: "mouse"});
                const noMouseInk = h.strokesCount() === 1;
                h.settings.mouseDrawing = true;
                h.stroke([[100, 180], [120, 200], [160, 220]], {pointerType: "mouse"});
                const mouseInk = h.strokesCount() === 2;
                h.settings.mouseDrawing = false;
                h.fire(todo, "pointerdown", x, y, {pointerId: 33});
                window.dispatchEvent(new KeyboardEvent("keydown", {key: "Escape"}));
                h.overlay.setMode(false);
                h.fire(todo, "pointerup", x, y, {pointerId: 33});
                todo.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true, detail: 1, clientX: x, clientY: y}));
                const modeTransitionSafe = !todo.checked;
                h.fire(todo, "pointerdown", x, y, {pointerId: 32});
                h.fire(todo, "pointerup", x, y, {pointerId: 32});
                todo.dispatchEvent(new PointerEvent("click", {bubbles: true, cancelable: true, pointerType: "pen", detail: 1, clientX: x, clientY: y}));
                return {blocked, noMouseInk, mouseInk, modeTransitionSafe, nativePenOff: todo.checked};
            });
            Object.entries(routing).forEach(([key, value]) => assert(value, key));
            console.log(`${name}: pen/finger isolation and mode-off activation passed`);

            if (name === "chromium") {
                await open();
                await page.evaluate(() => { window.harness.palette.setMode(false); window.harness.settings.doubleTapToggle = false; });
                const cdp = await context.newCDPSession(page);
                const box = await page.locator("#todo").boundingBox();
                const x = box.x + box.width / 2, y = box.y + box.height / 2;
                await cdp.send("Input.dispatchMouseEvent", {type: "mousePressed", pointerType: "pen", button: "left", buttons: 1, clickCount: 1, x, y, force: .6});
                for (let i = 1; i <= 8; i++) {
                    await cdp.send("Input.dispatchMouseEvent", {type: "mouseMoved", pointerType: "pen", button: "left", buttons: 1, x: x + i * 4, y: y + i * 10, force: .6});
                }
                await cdp.send("Input.dispatchMouseEvent", {type: "mouseReleased", pointerType: "pen", button: "left", buttons: 0, clickCount: 1, x: x + 32, y: y + 80});
                assert.equal(await page.locator("#todo").isChecked(), false);
                assert.equal(await page.evaluate(() => window.harness.strokesCount()), 1);
                await page.locator("#todo").tap();
                assert.equal(await page.locator("#todo").isChecked(), false, "finger tap is not a task click in writing mode");
                await page.locator("#todo").click();
                assert.equal(await page.locator("#todo").isChecked(), true);
                await cdp.send("Input.dispatchMouseEvent", {type: "mouseMoved", pointerType: "pen", buttons: 0, x: 280, y: 500});
                const beforeScroll = await page.evaluate(() => window.harness.contentEl.scrollTop);
                await cdp.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [{x: 280, y: 500}]});
                for (let y = 480; y >= 200; y -= 20) {
                    await cdp.send("Input.dispatchTouchEvent", {type: "touchMove", touchPoints: [{x: 280, y}]});
                    await new Promise(r => setTimeout(r, 16));
                }
                await cdp.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
                const afterScroll = await page.evaluate(() => window.harness.contentEl.scrollTop);
                assert(afterScroll > beforeScroll + 150, `${beforeScroll} -> ${afterScroll}`);
                assert.equal(await page.evaluate(() => window.harness.strokesCount()), 1);
                await cdp.detach();
                console.log(`${name}: trusted pen input, mouse editing and frame-paced finger panning passed`);
            }

            await open();
            const continuity = await page.evaluate(() => {
                const h = window.harness, el = h.captureEl();
                h.settings.doubleTapToggle = true;
                const pixels = () => {
                    const canvas = h.overlay.root.querySelector("canvas");
                    const bytes = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
                    return bytes.reduce((sum, value) => (sum + value) >>> 0, 0);
                };
                const directions = [[30, 0], [-30, 0], [0, 30], [0, -30], [20, 20], [-20, 20], [20, -20], [-20, -20]];
                const shortStrokes = directions.every(([dx, dy]) => {
                    h.overlay.clearAll(); h.overlay.redrawAll();
                    h.stroke([[150, 200, .7], [150 + dx, 200 + dy]]);
                    const stroke = h.overlay.store.strokes[0];
                    if (!stroke) return false;
                    const end = stroke.points.at(-1);
                    const before = pixels(); h.overlay.redrawAll();
                    return end.x === 150 + dx && end.y === 200 + dy && Math.abs(end.p - .7) < 0.00001 && before === pixels();
                });
                h.settings.doubleTapToggle = false;
                h.overlay.clearAll();
                const p = h.toClient(120, 220);
                h.fire(el, "pointerdown", p.x, p.y, {pointerId: 61, pressure: .6});
                h.fire(el, "pointermove", p.x + 10, p.y + 10, {pointerId: 61});
                h.fire(h.fakeProtyle.element, "lostpointercapture", p.x + 10, p.y + 10, {pointerId: 61});
                const stillLive = h.strokesCount() === 0;
                h.config.tool = "eraser"; // even a concurrent config change cannot reinterpret this ink
                h.fire(el, "pointermove", p.x + 20, p.y + 20, {pointerId: 61});
                h.fire(el, "pointerup", p.x + 40, p.y + 40, {pointerId: 61, pressure: 0});
                const stroke = h.overlay.store.strokes[0];
                h.config.tool = "pen";
                return {shortStrokes, stillLive, continuous: h.strokesCount() === 1 && stroke.points.at(-1).x === 160,
                    frozenConfig: stroke.tool === "pen"};
            });
            Object.entries(continuity).forEach(([key, value]) => assert(value, key));
            console.log(`${name}: eight-direction down/up strokes, final pixels and capture-loss continuation passed`);

            await open();
            const legacyStreams = await page.evaluate(() => {
                const h = window.harness;
                const target = document.getElementById("table-drag");
                const rect = target.getBoundingClientRect();
                const x = rect.x + 5, y = rect.y + 5;
                const before = {...h.nativeEvents};
                const touch = type => {
                    const event = new Event(type, {bubbles: true, cancelable: true});
                    Object.defineProperty(event, "changedTouches", {value: [{identifier: 901, target, clientX: x, clientY: y}]});
                    target.dispatchEvent(event);
                };
                h.fire(target, "pointerdown", x, y, {pointerId: 62});
                touch("touchstart"); touch("touchmove");
                for (const type of ["mousedown", "mousemove", "mouseup", "click", "dblclick", "contextmenu", "dragstart"]) {
                    target.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true, clientX: x, clientY: y}));
                }
                h.fire(target, "pointerup", x + 20, y + 20, {pointerId: 62, pressure: 0});
                touch("touchend");
                target.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true, detail: 0, clientX: x, clientY: y}));
                const isolated = h.nativeEvents.mouse === before.mouse && h.nativeEvents.touch === before.touch &&
                    h.nativeEvents.click === before.click && h.nativeEvents.bridge === before.bridge;
                h.fire(target, "pointerdown", x, y, {pointerId: 1, pointerType: "mouse"});
                target.dispatchEvent(new MouseEvent("mousedown", {bubbles: true, cancelable: true}));
                return {isolated, nativeMouse: h.nativeEvents.mouse === before.mouse + 1};
            });
            Object.entries(legacyStreams).forEach(([key, value]) => assert(value, key));
            console.log(`${name}: Android-style Touch→Mouse bridge and detail=0 clicks isolated upstream`);

            await open();
            const palmsAndToolbar = await page.evaluate(async () => {
                const h = window.harness, el = h.captureEl();
                h.settings.doubleTapToggle = false;
                h.contentEl.scrollTop = 100;
                const p = h.toClient(100, 240);
                // Palm first: queued movement must be dropped as soon as the pen arrives.
                h.fire(el, "pointerdown", p.x + 80, p.y + 80, {pointerId: 81, pointerType: "touch"});
                h.fire(el, "pointermove", p.x + 80, p.y + 30, {pointerId: 81, pointerType: "touch"});
                h.fire(el, "pointerdown", p.x, p.y, {pointerId: 82});
                await h.sleep(40);
                const noQueuedPan = h.contentEl.scrollTop === 100;
                h.fire(el, "pointermove", p.x + 20, p.y + 20, {pointerId: 82});
                // Palm over the palette must not change tools during an active stroke.
                const button = h.palette.toolbar.querySelector("button");
                let paletteClicks = 0; button.addEventListener("click", () => paletteClicks++);
                h.fire(button, "pointerdown", 20, 20, {pointerId: 83, pointerType: "touch"});
                button.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true}));
                h.fire(el, "pointerup", p.x + 40, p.y + 40, {pointerId: 82, pressure: 0});
                // Rejected palm lifts AFTER the pen; both forms of ensuing click remain rejected.
                h.fire(button, "pointerup", 20, 20, {pointerId: 83, pointerType: "touch"});
                button.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true}));
                button.dispatchEvent(new PointerEvent("click", {bubbles: true, cancelable: true, pointerType: "touch", detail: 1}));
                h.fire(el, "pointermove", p.x + 80, p.y - 50, {pointerId: 81, pointerType: "touch"});
                h.fire(el, "pointerup", p.x + 80, p.y - 50, {pointerId: 81, pointerType: "touch"});
                await h.sleep(40);
                const palmHeld = h.contentEl.scrollTop === 100 && paletteClicks === 0 && h.strokesCount() === 1;
                h.fire(button, "pointerdown", 20, 20, {pointerId: 84, pointerType: "touch"});
                h.fire(button, "pointerup", 20, 20, {pointerId: 84, pointerType: "touch"});
                button.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true}));
                const freshPaletteTap = paletteClicks === 1;
                h.overlay.setMode(false); h.palette.setMode(false);
                h.fire(h.palette.handle, "pointerdown", 30, 30, {pointerId: 91});
                h.fire(h.palette.handle, "pointerup", 30, 30, {pointerId: 92});
                const foreignUpIgnored = !h.overlay.mode;
                h.fire(h.palette.handle, "pointercancel", 30, 30, {pointerId: 91});
                h.fire(h.palette.handle, "pointerup", 30, 30, {pointerId: 93});
                const cancelledTapIgnored = !h.overlay.mode;
                h.fire(h.palette.handle, "pointerdown", 30, 30, {pointerId: 94});
                h.fire(h.palette.handle, "pointerup", 30, 30, {pointerId: 94});
                return {noQueuedPan, palmHeld, freshPaletteTap, foreignUpIgnored, cancelledTapIgnored, realTap: h.overlay.mode};
            });
            Object.entries(palmsAndToolbar).forEach(([key, value]) => assert(value, key));
            console.log(`${name}: palm-first/pen-first, palette rejection and toolbar contact ownership passed`);

            await open();
            await page.evaluate(() => {
                const h = window.harness, p = h.toClient(120, 240);
                h.palette.setMode(false);
                h.fire(h.captureEl(), "pointerdown", p.x, p.y, {pointerId: 95});
            });
            const mouseTarget = await page.locator("#todo").boundingBox();
            await page.mouse.move(mouseTarget.x + mouseTarget.width / 2, mouseTarget.y + mouseTarget.height / 2);
            await page.mouse.down();
            await page.evaluate(() => {
                const h = window.harness, p = h.toClient(120, 240);
                h.fire(h.captureEl(), "pointermove", p.x + 10, p.y + 10, {pointerId: 95});
            });
            await page.mouse.up();
            assert.equal(await page.locator("#todo").isChecked(), true, "mouse-down → pen-move → mouse-up must remain native");
            const mouseWithPen = await page.evaluate(() => {
                const h = window.harness, el = h.captureEl(), p = h.toClient(120, 240);
                h.fire(el, "pointermove", p.x + 30, p.y + 20, {pointerId: 95});
                const todo = document.getElementById("todo");
                todo.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true}));
                const compatRejected = todo.checked;
                h.fire(h.fakeProtyle.element, "lostpointercapture", p.x + 30, p.y + 20, {pointerId: 95});
                h.fire(el, "pointermove", p.x + 30, p.y + 20, {pointerId: 95, buttons: 0, pressure: 0});
                const retired = !h.overlay.ownedPointers.has(95);
                h.palette.setMode(true);
                const toolbar = h.palette.toolbar;
                const rect = toolbar.getBoundingClientRect();
                h.fire(toolbar, "pointerdown", rect.x + 2, rect.y + 2, {pointerId: 95});
                h.fire(toolbar, "pointermove", rect.x + 2, rect.y + 62, {pointerId: 95});
                h.fire(toolbar, "pointerup", rect.x + 2, rect.y + 62, {pointerId: 95});
                return {compatRejected, retired, toolbarReleased: h.palette.stopDrag === null, ink: h.strokesCount() === 1};
            });
            Object.entries(mouseWithPen).forEach(([key, value]) => assert(value, key));
            console.log(`${name}: concurrent genuine mouse, compatibility rejection and hover-ID reuse passed`);

            await open();
            const splitPalm = await page.evaluate(async () => {
                const h = window.harness;
                h.fakeProtyle.element.style.height = "300px";
                const root = h.fakeProtyle.element.cloneNode(true);
                root.querySelectorAll(".pa-overlay").forEach(el => el.remove());
                document.getElementById("app").append(root);
                const content = root.querySelector(".protyle-content"), text = root.querySelector(".protyle-wysiwyg");
                const second = h.DocOverlay.attach({element: root, contentElement: content, wysiwyg: {element: text}, options: {rootId: "second-doc"}}, {
                    settings: h.settings, config: h.config, onDirty() {}, onStateChange() {}, onDoubleTapToggle() {}, loadPayload: async () => null,
                });
                second.setMode(true);
                await second.store.loading;
                const pair = [[h.overlay, second], [second, h.overlay]];
                let safe = true;
                let id = 300;
                for (const [pen, palm] of pair) {
                    const inkEl = pen.protyle.wysiwyg.element, touchEl = palm.protyle.wysiwyg.element;
                    const r = inkEl.getBoundingClientRect(), tr = touchEl.getBoundingClientRect();
                    const penID = id++, touchID = id++, identifier = id++;
                    const before = [pen.protyle.contentElement.scrollTop, palm.protyle.contentElement.scrollTop];
                    h.fire(inkEl, "pointerdown", r.x + 100, r.y + 200, {pointerId: penID});
                    h.fire(touchEl, "pointerdown", tr.x + 100, tr.y + 250, {pointerId: touchID, pointerType: "touch"});
                    const nativeTouch = type => {
                        const e = new Event(type, {bubbles: true, cancelable: true});
                        Object.defineProperty(e, "changedTouches", {value: [{identifier, target: touchEl}]});
                        touchEl.dispatchEvent(e);
                    };
                    nativeTouch("touchstart");
                    h.fire(touchEl, "pointermove", tr.x + 100, tr.y + 170, {pointerId: touchID, pointerType: "touch"});
                    await h.sleep(30);
                    h.fire(inkEl, "pointerup", r.x + 130, r.y + 220, {pointerId: penID, pressure: 0});
                    h.fire(touchEl, "pointerup", tr.x + 100, tr.y + 170, {pointerId: touchID, pointerType: "touch"});
                    nativeTouch("touchend");
                    safe &&= pen.protyle.contentElement.scrollTop === before[0] && palm.protyle.contentElement.scrollTop === before[1] &&
                        pen.ownedTouches.size === 0 && palm.ownedTouches.size === 0;
                }
                second.destroy(); root.remove();
                return safe;
            });
            assert(splitPalm, "split-view palm routing must not depend on listener registration order");

            await open();
            const panning = await page.evaluate(async () => {
                const h = window.harness, table = document.getElementById("table-drag");
                const scroller = table.closest("table").parentElement;
                const rect = table.getBoundingClientRect();
                const x = rect.x + 20, y = rect.y + 10;
                const nestedPolicy = getComputedStyle(scroller).touchAction === "none";
                h.fire(table, "pointerdown", x, y, {pointerId: 101, pointerType: "touch"});
                h.fire(table, "pointermove", x - 60, y - 30, {pointerId: 101, pointerType: "touch"});
                await new Promise(requestAnimationFrame);
                const nestedAxes = scroller.scrollLeft >= 59 && h.contentEl.scrollTop >= 29;
                h.fire(table, "pointercancel", x - 60, y - 30, {pointerId: 101, pointerType: "touch"});
                const top = h.contentEl.scrollTop;
                await h.sleep(60);
                const cancelled = h.contentEl.scrollTop === top;
                const raf = window.requestAnimationFrame, caf = window.cancelAnimationFrame;
                const frames = new Map(); let id = 0;
                window.requestAnimationFrame = cb => { frames.set(++id, cb); return id; };
                window.cancelAnimationFrame = key => frames.delete(key);
                let noResumeJump;
                try {
                    h.fire(h.captureEl(), "pointerdown", 250, 400, {pointerId: 102, pointerType: "touch"});
                    h.fire(h.captureEl(), "pointermove", 250, 350, {pointerId: 102, pointerType: "touch"});
                    h.fire(h.captureEl(), "pointerup", 250, 350, {pointerId: 102, pointerType: "touch"});
                    const afterFlush = h.contentEl.scrollTop;
                    const pending = [...frames.values()]; frames.clear();
                    pending.forEach(cb => cb(performance.now() + 5000));
                    noResumeJump = h.contentEl.scrollTop === afterFlush;
                } finally { window.requestAnimationFrame = raf; window.cancelAnimationFrame = caf; }
                h.overlay.setMode(false);
                const restored = getComputedStyle(scroller).touchAction !== "none";
                return {nestedPolicy, nestedAxes, cancelled, noResumeJump, restored};
            });
            Object.entries(panning).forEach(([key, value]) => assert(value, key));
            console.log(`${name}: nested two-axis pan, cancellation and suspended-frame bounds passed`);

            await open();
            const replacement = await page.evaluate(async () => {
                const h = window.harness;
                const content = h.contentEl.cloneNode(true);
                content.classList.remove("pa-writing");
                h.contentEl.replaceWith(content);
                await h.sleep(30);
                const policy = content.classList.contains("pa-writing") && !h.contentEl.classList.contains("pa-writing");
                const target = content.querySelector(".protyle-wysiwyg");
                const rect = target.getBoundingClientRect();
                h.fire(target, "pointerdown", rect.x + 100, rect.y + 200, {pointerId: 103});
                h.fire(target, "pointerup", rect.x + 130, rect.y + 220, {pointerId: 103, pressure: 0});
                return policy && h.strokesCount() === 1 && h.overlay.store.strokes[0].points.at(-1).x === 130;
            });
            assert(replacement, "replaced editor content must retain input policy and sampling");

            await open();
            const interruption = await page.evaluate(async () => {
                const h = window.harness, el = h.captureEl();
                h.settings.doubleTapToggle = false;
                const p = h.toClient(100, 200);
                h.fire(el, "pointerdown", p.x, p.y, {pointerId: 41});
                h.fire(el, "pointermove", p.x + 40, p.y + 20, {pointerId: 41});
                h.fire(el, "pointerdown", p.x + 70, p.y + 30, {pointerId: 42, pointerType: "touch"});
                h.fire(el, "pointerup", p.x + 70, p.y + 30, {pointerId: 42, pointerType: "touch"});
                h.fire(el, "pointerup", p.x + 60, p.y + 40, {pointerId: 41});
                const palmSafe = h.strokesCount() === 1;
                h.fire(el, "pointerdown", p.x, p.y + 60, {pointerId: 43});
                h.fire(el, "pointermove", p.x + 40, p.y + 80, {pointerId: 43});
                h.fire(el, "pointercancel", p.x + 40, p.y + 80, {pointerId: 43});
                const cancelSafe = h.strokesCount() === 2;
                h.settings.doubleTapToggle = true;
                h.stroke([[180, 300], [180, 300]]);
                h.overlay.destroy();
                const dotSafe = h.strokesCount() === 3;
                await h.sleep(450);
                return {palmSafe, cancelSafe, dotSafe, count: h.strokesCount()};
            });
            for (const key of ["palmSafe", "cancelSafe", "dotSafe"]) assert(interruption[key], key);
            assert.equal(interruption.count, 3);
            console.log(`${name}: palm contact, pointercancel and navigation preserve ink`);

            await open();
            const tools = await page.evaluate(async () => {
                const h = window.harness, el = h.captureEl();
                h.settings.doubleTapToggle = false;
                h.stroke([[100, 220], [140, 220], [180, 220]]);
                const original = h.overlay.store.strokes[0].points[0].x;
                h.config.tool = "select";
                const p = h.toClient(100, 220);
                h.fire(el, "pointerdown", p.x, p.y, {pointerId: 71});
                h.fire(el, "pointermove", p.x + 30, p.y + 20, {pointerId: 71});
                h.fire(el, "pointercancel", p.x + 30, p.y + 20, {pointerId: 71});
                const moveCommitted = h.overlay.store.strokes[0].points[0].x === original + 30;
                h.overlay.undo();
                const moveUndo = h.overlay.store.strokes[0].points[0].x === original;
                h.config.tool = "eraser";
                const dirty = h.counts.dirty;
                h.fire(el, "pointerdown", p.x, p.y, {pointerId: 72});
                h.fire(el, "pointercancel", p.x, p.y, {pointerId: 72});
                const eraseSaved = h.strokesCount() === 0 && h.counts.dirty > dirty;
                h.overlay.undo();
                const eraseUndo = h.strokesCount() === 1;
                h.overlay.clearAll(); h.config.tool = "pen"; h.settings.doubleTapToggle = true;
                h.stroke([[100, 250], [100, 250]]);
                h.stroke([[100, 250], [100, 250]]);
                await h.sleep(450);
                const doubleTap = h.counts.doubleTaps === 1 && h.strokesCount() === 0;
                h.config.tool = "pen";
                h.stroke([[100, 280], [100, 280]]);
                h.stroke([[250, 280], [250, 280]]);
                await h.sleep(450);
                return {moveCommitted, moveUndo, eraseSaved, eraseUndo, doubleTap, separateDots: h.strokesCount() === 2};
            });
            Object.entries(tools).forEach(([key, value]) => assert(value, key));
            console.log(`${name}: interrupted selection/eraser undo and optional double-tap passed`);

            await open();
            const clipping = await page.evaluate(async () => {
                const h = window.harness;
                h.settings.doubleTapToggle = false;
                h.stroke([[100, 350], [130, 350], [160, 350]]);
                const canvas = h.overlay.root.querySelector("canvas");
                const ink = () => {
                    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
                    let n = 0;
                    for (let i = 3; i < data.length; i += 4) if (data[i]) n++;
                    return n;
                };
                h.overlay.redrawAll();
                const before = ink();
                h.contentEl.style.height = "150px";
                h.overlay.redrawAll();
                h.contentEl.style.height = "100%";
                h.overlay.redrawAll();
                const after = ink();
                return {before, after, png: await h.exportBlob("white")};
            });
            assert(clipping.before > 0);
            assert.equal(clipping.after, clipping.before);
            assert(clipping.png > 0);
            console.log(`${name}: canvas clip reset and PNG export passed`);

            await page.goto("http://127.0.0.1:5199/test/harness.html?preset=1&loadDelay=400");
            await page.waitForFunction(() => !!window.harness);
            const duringLoad = await page.evaluate(() => {
                const h = window.harness;
                h.settings.doubleTapToggle = false;
                h.stroke([[100, 180], [130, 200], [160, 220]]);
                return h.strokesCount();
            });
            assert.equal(duringLoad, 0);
            await page.waitForFunction(() => window.harness.overlay.store.loaded);
            assert.equal(await page.evaluate(() => window.harness.strokesCount()), 2);
            console.log(`${name}: slow initial load cannot overwrite early ink`);

            await open();
            const persistence = await page.evaluate(async () => {
                const h = window.harness;
                h.overlay.destroy();
                h.palette.toolbar.remove(); h.palette.handle.remove();
                const calls = [];
                let disk = null, failLoad = false;
                const originalFetch = window.fetch;
                window.fetch = async (url, options) => {
                    if (String(url).endsWith("getFile")) {
                        if (failLoad) throw new Error("offline");
                        return disk ? Response.json(disk) : new Response("", {status: 404});
                    }
                    if (String(url).endsWith("putFile")) {
                        const payload = JSON.parse(await options.body.get("file").text());
                        return new Promise(resolve => calls.push({payload, finish(ok = true) {
                            if (ok) disk = payload;
                            resolve(Response.json({code: ok ? 0 : -1, msg: "test write failure"}));
                        }}));
                    }
                    return originalFetch(url, options);
                };
                const until = async predicate => {
                    for (let i = 0; i < 100; i++) { if (predicate()) return; await h.sleep(5); }
                    throw new Error("condition timed out");
                };
                const p = h.createPlugin();
                await p.onload();
                p.armSave = () => {}; // deterministic: invoke real drains explicitly
                p.attachProtyle(h.fakeProtyle);
                const o = p.overlays.get(h.fakeProtyle.element);
                await until(() => o.store.loaded);
                const add = () => { o.store.addStroke("pen", {color: "#000", width: 4, opacity: 1, simulate: false}, [{x: 1, y: 2, p: .5}]); p.scheduleSave(o); };
                add();
                const first = p.flushAll();
                await until(() => calls.length === 1);
                add();
                let barrierDone = false;
                const second = p.flushAll().then(() => { barrierDone = true; });
                await h.sleep(20);
                const serialized = calls.length === 1 && !barrierDone;
                calls[0].finish();
                await until(() => calls.length === 2);
                calls[1].finish();
                await Promise.all([first, second]);
                const newestSaved = disk.strokes.length === 2 && !o.store.dirty;
                add();
                p.detachProtyle(h.fakeProtyle);
                await until(() => calls.length === 3);
                calls[2].finish(false);
                await until(() => o.store.saving === null);
                const retained = p.pendingSaves.has(o.store) && o.store.dirty;
                p.attachProtyle(h.fakeProtyle);
                const shared = p.overlays.get(h.fakeProtyle.element).store === o.store;
                const retry = p.flushAll();
                await until(() => calls.length === 4);
                calls[3].finish(); await retry;
                const retrySaved = disk.strokes.length === 3;
                p.detachProtyle(h.fakeProtyle);
                const cleanEvicted = !p.documents.has(o.docId);
                disk = {...disk, strokes: [...disk.strokes, {...disk.strokes[0], i: "remote-addition"}]};
                p.attachProtyle(h.fakeProtyle);
                const reopened = p.overlays.get(h.fakeProtyle.element);
                await until(() => reopened.store.loaded);
                const freshBaseline = reopened.store !== o.store && reopened.store.strokes.length === 4;
                const secondElement = h.fakeProtyle.element.cloneNode(true);
                secondElement.querySelectorAll(".pa-overlay").forEach(el => el.remove());
                document.getElementById("app").append(secondElement);
                const secondProtyle = {...h.fakeProtyle, element: secondElement,
                    contentElement: secondElement.querySelector(".protyle-content"),
                    wysiwyg: {element: secondElement.querySelector(".protyle-wysiwyg")}};
                p.attachProtyle(secondProtyle);
                const secondView = p.overlays.get(secondElement);
                let repaints = 0;
                const redraw = secondView.redrawAll.bind(secondView);
                secondView.redrawAll = () => { repaints++; redraw(); };
                disk = {...disk, strokes: [...disk.strokes, {...disk.strokes[0], i: "remote-second-view"}]};
                await p.onDataChanged("sync");
                const syncRepaint = secondView.store === reopened.store && secondView.store.strokes.length === 5 && repaints > 0;
                p.detachProtyle(secondProtyle); secondElement.remove();
                failLoad = true;
                let readFailed = false;
                try { await h.loadPayload(p, o.docId); } catch { readFailed = true; }
                failLoad = false;
                const savedDisk = disk; disk = {version: 1, docId: o.docId, updatedAt: 1, strokes: [{}]};
                let malformedRejected = false;
                try { await h.loadPayload(p, o.docId); } catch { malformedRejected = true; }
                disk = savedDisk;
                reopened.setMode(true);
                reopened.store.addStroke("pen", {color: "#000", width: 4, opacity: 1, simulate: false}, [{x: 1, y: 2, p: .5}]);
                p.scheduleSave(reopened);
                const unload = p.onunload();
                await until(() => calls.length === 5);
                // An input arriving while unload awaits a write cannot create late unsaved ink.
                const point = h.toClient(100, 200);
                h.fire(h.captureEl(), "pointerdown", point.x, point.y, {pointerId: 88});
                h.fire(h.captureEl(), "pointermove", point.x + 30, point.y + 20, {pointerId: 88});
                h.fire(h.captureEl(), "pointerup", point.x + 50, point.y + 20, {pointerId: 88});
                calls[4].finish(); await unload;
                const unloadSafe = disk.strokes.length === 6 && !reopened.store.dirty;
                window.fetch = originalFetch;
                return {serialized, newestSaved, retained, shared, retrySaved, cleanEvicted, freshBaseline, syncRepaint, readFailed, malformedRejected, unloadSafe};
            });
            Object.entries(persistence).forEach(([key, value]) => assert(value, key));
            console.log(`${name}: serialized writes, detached retry, shared stores, read-error safety passed`);

            await open();
            const layout = await page.evaluate(() => {
                const h = window.harness;
                h.palette.setMode(true);
                h.palette.refresh();
                const rect = h.palette.toolbar.getBoundingClientRect();
                return {x: rect.x, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight,
                    scrollWidth: h.palette.toolbar.scrollWidth, clientWidth: h.palette.toolbar.clientWidth};
            });
            assert(layout.x >= 0 && layout.right <= layout.width && layout.bottom <= layout.height, JSON.stringify(layout));
            assert(layout.scrollWidth <= layout.clientWidth);
            assert.deepEqual(errors, []);
            console.log(`${name}: 390px phone toolbar fits and has no horizontal overflow`);
            for (const viewport of [{width: 320, height: 568}, {width: 568, height: 320}, {width: 820, height: 1180}]) {
                await page.setViewportSize(viewport);
                const fits = await page.evaluate(() => {
                    const h = window.harness;
                    h.palette.repositionForViewport();
                    const r = h.palette.toolbar.getBoundingClientRect();
                    return r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
                });
                assert(fits, `toolbar does not fit ${JSON.stringify(viewport)}`);
            }
            console.log(`${name}: narrow phone, landscape rotation and tablet layouts passed`);
        } finally {
            await browser.close();
        }
    }
} finally {
    await server.close();
}
