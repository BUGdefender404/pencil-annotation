/**
 * Creates package.zip for the SiYuan marketplace with forward-slash entry
 * paths. Uses Windows' bundled bsdtar or the native zip command on macOS/Linux.
 * Report success only after the archive command actually succeeds.
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

const windows = process.platform === "win32";
const command = windows ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "zip";
const args = windows
    ? ["-a", "-c", "-f", zipPath, "-C", buildDir, "."]
    : ["-q", "-r", zipPath, "."];
const result = spawnSync(command, args, {cwd: buildDir, stdio: "inherit"});
if (result.error) throw result.error;
if (result.status !== 0 || !existsSync(zipPath)) throw new Error(`Packaging failed (exit ${result.status})`);
console.log(`[pack] package.zip ready at ${resolve(zipPath)}`);
