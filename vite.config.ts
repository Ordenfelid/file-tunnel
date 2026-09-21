import { resolve } from "path";
import { defineConfig, type PluginOption } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import zipPack from "vite-plugin-zip-pack";

// 源码在工作空间外，产物统一进 dist/（完整的插件目录，可直接部署/打包）；
// package.zip 仅发布构建时生成。安装到思源工作空间用 npm run deploy。
const isDev = process.env.NODE_ENV === "development";

export default defineConfig({
    build: {
        outDir: "dist",
        emptyOutDir: false,
        minify: !isDev,
        sourcemap: isDev ? "inline" : false,
        lib: {
            entry: resolve(import.meta.dirname, "src/index.ts"),
            name: "Result2AssetPlugin",
            fileName: () => "index.js",
            formats: ["cjs"],
        },
        rollupOptions: {
            external: ["siyuan"],
            output: {
                entryFileNames: "index.js",
            },
        },
    },
    plugins: ([
        viteStaticCopy({
            targets: [
                { src: "./plugin.json", dest: "./" },
                { src: "./icon.png", dest: "./" },
                { src: "./README.md", dest: "./" },
            ],
        }),
        ...(isDev
            ? []
            : [
                zipPack({
                    inDir: "./dist",
                    outDir: "./",
                    outFileName: "package.zip",
                }),
            ]),
    ]) as PluginOption[],
});
