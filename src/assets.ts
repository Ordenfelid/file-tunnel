// 附件落盘与读取：全部走内核官方 API（Token 鉴权，同源 fetch）。
// 落盘固定 assetsDirPath=assets/mcp，不给模型路径参数；
// 读取（sendFiles 用）限定全局 assets 命名空间，拒绝对路径与越段。

import { apiToken, ToolError } from "./util";

const LANDING_DIR = "assets/mcp";

interface DirEntry {
    name: string;
    isDir?: boolean;
}

/** 规范化为 assets 内的相对路径（无 assets/ 前缀；拒绝绝对路径、.. 与空段）。 */
export function normalizeAssetPath(raw: unknown): string {
    if (typeof raw !== "string" || !raw.trim()) {
        throw new ToolError("缺少附件路径：请提供 assets/ 下的相对路径（sendFiles 仅接受工作空间 assets 内的文件）");
    }
    let p = raw.trim().replace(/\\/g, "/");
    p = p.split("?")[0].split("#")[0].replace(/^\/+/, "");
    if (p.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) {
        throw new ToolError(`路径不合法（不允许绝对路径或相对段）：${raw}`);
    }
    if (p === "assets" || p === "assets/") {
        throw new ToolError("path 仅给出了 assets 目录本身，请附带文件名");
    }
    if (p.startsWith("assets/")) {
        p = p.slice("assets/".length);
    }
    return p;
}

/** 解析出全局 assets 内真实存在的相对路径；裸文件名自动匹配思源时间戳后缀。 */
export async function resolveAssetPath(raw: unknown): Promise<string> {
    const rel = normalizeAssetPath(raw);
    const slash = rel.lastIndexOf("/");
    const dir = slash === -1 ? "" : rel.slice(0, slash);
    const base = slash === -1 ? rel : rel.slice(slash + 1);

    const entries = await listAssetDir(dir);
    const files = entries.filter((e) => !e.isDir);
    const exact = files.find((e) => e.name === base);
    if (exact) {
        return dir ? `${dir}/${base}` : base;
    }

    const dot = base.lastIndexOf(".");
    if (dot > 0 && dot < base.length - 1) {
        const stem = base.slice(0, dot);
        const ext = base.slice(dot + 1);
        const re = new RegExp(`^${escapeRegExp(stem)}-\\d{14}-.+\\.${escapeRegExp(ext)}$`);
        const hits = files.filter((e) => re.test(e.name));
        if (hits.length === 1) {
            return dir ? `${dir}/${hits[0].name}` : hits[0].name;
        }
        if (hits.length > 1) {
            const names = hits.map((h) => h.name).sort().join("、");
            throw new ToolError(`assets/${dir ? dir + "/" : ""}下有多个与 ${base} 对应的时间戳后缀文件：${names}，请给出完整文件名`);
        }
    }
    throw new ToolError(
        `未在全局 assets 中找到 ${rel}。sendFiles 仅支持全局 assets/ 附件（exec 落盘返回的路径可直接使用）；笔记本内附件暂不支持`,
    );
}

async function listAssetDir(dir: string): Promise<DirEntry[]> {
    const resp = await fetch("/api/file/readDir", {
        method: "POST",
        headers: {Authorization: `Token ${apiToken()}`},
        body: JSON.stringify({path: `/data/assets/${dir ? dir + "/" : ""}`}),
    });
    if (!resp.ok) {
        throw new ToolError(`读取 assets 目录失败：HTTP ${resp.status}（/data/assets/${dir}）`);
    }
    const json = await resp.json() as {code?: number; data?: DirEntry[]; msg?: string};
    if (json.code !== 0) {
        throw new ToolError(`读取 assets 目录失败：${json.msg || json.code}`);
    }
    return json.data ?? [];
}

/** 经 /api/file/getFile 读取全局 assets 内的文件字节。 */
export async function readAssetBytes(rel: string): Promise<Uint8Array<ArrayBuffer>> {
    const resp = await fetch("/api/file/getFile", {
        method: "POST",
        headers: {Authorization: `Token ${apiToken()}`},
        body: JSON.stringify({path: `/data/assets/${rel}`}),
    });
    const ctype = resp.headers.get("content-type") || "";
    if (ctype.includes("application/json")) {
        const json = await resp.json().catch(() => null) as {msg?: string} | null;
        throw new ToolError(`读取附件失败：${json?.msg || "文件不存在或不可读"}（assets/${rel}）`);
    }
    if (!resp.ok) {
        throw new ToolError(`读取附件失败：HTTP ${resp.status}（assets/${rel}）`);
    }
    return new Uint8Array(await resp.arrayBuffer());
}

const MIME_EXT: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/webm": ".weba",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/quicktime": ".mov",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/gzip": ".gz",
    "application/json": ".json",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "text/html": ".html",
    "text/csv": ".csv",
};

function extFor(mime: string, uri?: string): string {
    const key = mime.split(";")[0].trim().toLowerCase();
    if (MIME_EXT[key]) {
        return MIME_EXT[key];
    }
    if (uri) {
        const m = /[.][\w]{1,8}(?:[?#]|$)/.exec(uri);
        if (m) {
            return m[0].split(/[?#]/)[0];
        }
    }
    return ".bin";
}

/**
 * 把二进制内容落盘到 assets/mcp 并返回工作空间相对路径。
 * 内核自带内容 hash 去重（同内容复用既有文件）与时间戳改名防覆盖。
 */
export async function landBinary(nameBase: string, mime: string, bytes: Uint8Array<ArrayBuffer>, uri?: string): Promise<string> {
    const form = new FormData();
    const filename = `${nameBase}${extFor(mime, uri)}`;
    form.append("file[]", new File([bytes], filename, {type: mime}));
    form.append("assetsDirPath", LANDING_DIR);

    const resp = await fetch("/api/asset/upload", {
        method: "POST",
        headers: {Authorization: `Token ${apiToken()}`},
        body: form,
    });
    if (!resp.ok) {
        throw new ToolError(`落盘失败：HTTP ${resp.status}（/api/asset/upload）`);
    }
    const json = await resp.json() as {
        code?: number;
        msg?: string;
        data?: {succMap?: Record<string, string>; errFiles?: string[]};
    };
    if (json.code !== 0) {
        throw new ToolError(`落盘失败：${json.msg || json.code}`);
    }
    const paths = Object.values(json.data?.succMap ?? {});
    if (!paths.length) {
        throw new ToolError(`落盘失败：${json.data?.errFiles?.join("、") || "未知错误"}`);
    }
    return paths[0];
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
