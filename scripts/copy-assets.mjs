/**
 * Copies static plugin assets into build/ after vite emits index.js.
 * Optionally deploys the build straight into a SiYuan workspace:
 *   SIYUAN_PLUGIN_DIR=/path/to/workspace/data/plugins node scripts/copy-assets.mjs
 * or pass the plugins dir as the first CLI argument.
 */
import {cpSync, existsSync, mkdirSync, readdirSync} from "node:fs";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const buildDir = join(root, "build");
mkdirSync(buildDir, {recursive: true});

const copies = [
    "plugin.json",
    "index.css",
    "icon.png",
    "i18n",
    "README.md",
    "README.zh_CN.md",
    "CHANGELOG.md",
    "LICENSE",
];
for (const name of copies) {
    const src = join(root, name);
    if (!existsSync(src)) {
        if (name.startsWith("README")) continue; // readme files are optional at dev time
        throw new Error(`missing asset: ${name} (run gen-icon first?)`);
    }
    cpSync(src, join(buildDir, name), {recursive: true});
}

let target = process.env.SIYUAN_PLUGIN_DIR || process.argv[2];
if (target) {
    target = resolve(target, "pencil-annotation");
    mkdirSync(target, {recursive: true});
    for (const entry of readdirSync(buildDir)) {
        cpSync(join(buildDir, entry), join(target, entry), {recursive: true});
    }
    console.log(`[copy-assets] deployed to ${target}`);
}
console.log(`[copy-assets] build assets ready in build/`);
