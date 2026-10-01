import {resolve} from "path";
import {fileURLToPath} from "url";
import {defineConfig} from "vite";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({command}) => ({
    resolve: command === "serve" ? {alias: {siyuan: resolve(__dirname, "test/siyuan.ts")}} : undefined,
    build: {
        outDir: "build",
        emptyOutDir: true,
        lib: {
            entry: resolve(__dirname, "src/index.ts"),
            formats: ["cjs"],
            fileName: () => "index.js",
        },
        rollupOptions: {
            external: ["siyuan"],
        },
        sourcemap: process.env.NODE_ENV === "development",
    },
}));
