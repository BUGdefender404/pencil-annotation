/**
 * Creates package.zip for the SiYuan marketplace with forward-slash entry
 * paths. Order: zip CLI (macOS/Linux) → bsdtar (bundled with Windows) →
 * PowerShell Compress-Archive (last resort; may emit backslash paths).
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

const attempts = [
    {cmd: "zip", args: ["-r", zipPath, "."], cwd: buildDir},
    {
        cmd: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
        args: ["-a", "-c", "-f", zipPath, "-C", buildDir, "."],
        cwd: root,
    },
];

for (const {cmd, args, cwd} of attempts) {
    const res = spawnSync(cmd, args, {cwd, stdio: "inherit"});
    if (res.status === 0 && existsSync(zipPath)) {
        console.log(`[pack] package.zip ready at ${resolve(zipPath)}`);
        process.exit(0);
    }
    if (existsSync(zipPath)) rmSync(zipPath);
}

console.error("[pack] zip/bsdtar unavailable, falling back to Compress-Archive");
const ps = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `Compress-Archive -Path build/* -DestinationPath package.zip -Force`],
    {cwd: root, stdio: "inherit"},
);
if (ps.status !== 0 || !existsSync(zipPath)) {
    console.error("[pack] failed to create package.zip");
    process.exit(1);
}
console.log(`[pack] package.zip ready at ${resolve(zipPath)}`);
