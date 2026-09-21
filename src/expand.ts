// {{file2b64.路径}} 占位符展开：递归扫描 args 的所有字符串值，把占位符替换为
// 对应工作空间附件的 base64。语法对齐内核 {{secrets.NAME}}/{{vars.NAME}} 家族：
// 前缀 + 点 + assets 内相对路径（裸文件名自动匹配思源时间戳后缀）。
// 整值占位 = 纯 base64 字段；子串占位 = 字节嵌入字符串（解码壳由模型按目标语言自写）。
// 语义是“上传 asset”——只接受 assets 命名空间内的相对路径，模型不能借此
// 读取工作空间外的任意本地文件，也不能把笔记本内文件外发。

import { readAssetBytes, resolveAssetPath } from "./assets";
import { bytesToBase64, ToolError } from "./util";

const PLACEHOLDER_RE = /\{\{file2b64\.([^{}]+)\}\}/g;

export async function expandFilePlaceholders(args: Record<string, unknown>): Promise<void> {
    for (const key of Object.keys(args)) {
        args[key] = await expandNode(args[key]);
    }
}

async function expandNode(node: unknown): Promise<unknown> {
    if (typeof node === "string") {
        return expandString(node);
    }
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
            node[i] = await expandNode(node[i]);
        }
        return node;
    }
    if (node !== null && typeof node === "object") {
        const record = node as Record<string, unknown>;
        for (const key of Object.keys(record)) {
            record[key] = await expandNode(record[key]);
        }
        return node;
    }
    return node;
}

async function expandString(s: string): Promise<string> {
    // split 带捕获组：奇数下标即占位符里的路径，偶数下标是原样保留的片段
    const parts = s.split(PLACEHOLDER_RE);
    if (parts.length === 1) {
        if (s.includes("{{file2b64")) {
            throw new ToolError(`占位符写法应为 {{file2b64.assets/xxx.png}}（file2b64. 后跟 assets 内相对路径）：${s.slice(0, 120)}`);
        }
        return s;
    }
    for (let i = 1; i < parts.length; i += 2) {
        const rel = await resolveAssetPath(parts[i]);
        const bytes = await readAssetBytes(rel);
        if (!bytes.length) {
            throw new ToolError(`附件内容为空：assets/${rel}`);
        }
        parts[i] = bytesToBase64(bytes);
    }
    return parts.join("");
}
