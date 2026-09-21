// sendFiles：把工作空间 assets 附件以 base64 注入工具参数字段。
// 语义是“上传 asset”——只接受 assets 命名空间内的相对路径，模型不能借此
// 读取工作空间外的任意本地文件，也不能把笔记本内文件外发。

import { readAssetBytes, resolveAssetPath } from "./assets";
import { bytesToBase64, ToolError } from "./util";

interface SendFileEntry {
    field?: unknown;
    path?: unknown;
}

export async function applySendFiles(args: Record<string, unknown>, sendFiles: unknown): Promise<void> {
    if (sendFiles === undefined || sendFiles === null) {
        return;
    }
    if (!Array.isArray(sendFiles)) {
        throw new ToolError("sendFiles 需为数组：[{field, path}]，field 为 args 中的顶层字段名，path 为 assets 内附件路径");
    }
    for (const raw of sendFiles) {
        const entry = (raw ?? {}) as SendFileEntry;
        const field = typeof entry.field === "string" ? entry.field.trim() : "";
        if (!field) {
            throw new ToolError(`sendFiles 条目缺少 field（args 顶层字段名）：${JSON.stringify(raw).slice(0, 120)}`);
        }
        const rel = await resolveAssetPath(entry.path);
        const bytes = await readAssetBytes(rel);
        if (!bytes.length) {
            throw new ToolError(`附件内容为空：assets/${rel}`);
        }
        args[field] = bytesToBase64(bytes);
    }
}
