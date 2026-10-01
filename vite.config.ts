import {resolve} from "path";
import {fileURLToPath} from "url";
import {defineConfig} from "vite";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
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
            // jspdf pulls optional deps via dynamic import — keep everything
            // in the single index.js the SiYuan plugin loader expects
            output: {inlineDynamicImports: true},
        },
        sourcemap: process.env.NODE_ENV === "development",
    },
});
