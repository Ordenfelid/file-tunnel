// 把 dist/ 完整安装到思源工作空间插件目录（可用 SIYUAN_PLUGIN_DIR 覆盖目标）
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const distDir = resolve(import.meta.dirname, "../dist");
const target =
    process.env.SIYUAN_PLUGIN_DIR ||
    join(homedir(), "SiYuan", "data", "plugins", "file-tunnel");

if (!existsSync(resolve(distDir, "index.js"))) {
    console.error("dist/index.js 不存在，请先执行 npm run build");
    process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(distDir, target, { recursive: true });
console.log(`已部署 dist/ -> ${target}`);
