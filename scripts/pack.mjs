/**
 * Creates package.zip for the SiYuan marketplace with forward-slash entry
 * paths (PowerShell's Compress-Archive emits backslashes, which break on
 * other platforms). Uses Windows' bundled bsdtar; falls back to Compress-Archive.
 */
import {spawnSync} from "node:child_process";
import {existsSync, rmSync} from "node:fs";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const buildDir = join(root, "build");
const zipPath = join(root, "package.zip");
if (!existsSync(buildDir)) throw new Error("build/ missing — run npm run build first");
if (existsSync(zipPath)) rmSync(zipPath);

const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
const res = spawnSync(tar, ["-a", "-c", "-f", "package.zip", "-C", "build", "."], {
    cwd: root,
    stdio: "inherit",
});
if (res.status !== 0) {
    console.error("[pack] bsdtar failed, falling back to Compress-Archive");
    spawnSync(
        "powershell",
        ["-NoProfile", "-Command", `Compress-Archive -Path build/* -DestinationPath package.zip -Force`],
        {cwd: root, stdio: "inherit"},
    );
}
console.log(`[pack] package.zip ready at ${resolve(zipPath)}`);
