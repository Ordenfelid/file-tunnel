// 工具结果归一化：文本直回，二进制（顶层 data 与嵌入式 resource.blob）落盘 assets/mcp 只回路径与元数据。

import { landBinary } from "./assets";
import { McpCallToolResult } from "./rpc";
import { base64ToBytes, formatSize, joinNonEmpty, sanitizeName, ToolError } from "./util";

export interface LandedFile {
    path: string;
    mimeType: string;
    bytes: number;
    uri?: string;
}

export interface HandlerResult {
    result?: string;
    structuredContent?: unknown;
    error?: string;
}

/** nameBase → 落盘文件名前缀：服务器/通道名 + 工具名，可读且文件系统安全。 */
export function fileLabel(target: string): string {
    return sanitizeName(target).replace(/^mcp_/, "").slice(0, 60) || "mcp";
}

export async function handleToolResult(target: string, raw: McpCallToolResult): Promise<HandlerResult> {
    if (!raw || typeof raw !== "object") {
        throw new ToolError(`工具返回内容无法解析：${JSON.stringify(raw).slice(0, 200)}`);
    }
    const items = Array.isArray(raw.content) ? raw.content : [];
    const label = fileLabel(target);
    const texts: string[] = [];
    const files: LandedFile[] = [];

    const landData = async (data: string, mimeRaw: unknown, uriRaw: unknown, i: number): Promise<void> => {
        const mime = typeof mimeRaw === "string" && mimeRaw !== "" ? mimeRaw : "application/octet-stream";
        const bytes = base64ToBytes(data);
        const path = await landBinary(`${label}_${i}`, mime, bytes, typeof uriRaw === "string" ? uriRaw : undefined);
        files.push({
            path,
            mimeType: mime,
            bytes: bytes.length,
            ...(typeof uriRaw === "string" && uriRaw !== "" ? {uri: uriRaw} : {}),
        });
    };

    for (const [i, item] of items.entries()) {
        if (item && item.type === "text" && typeof item.text === "string") {
            texts.push(item.text);
            continue;
        }
        if (item && typeof item.data === "string" && item.data !== "") {
            await landData(item.data, item.mimeType, item.uri, i);
            continue;
        }
        // 嵌入式资源（MCP 规范 EmbeddedResource）：blob 与顶层 data 同构落盘，text 资源按语义直回
        const res = item && item.type === "resource" && isRecord(item.resource) ? item.resource : null;
        if (res) {
            if (typeof res.blob === "string" && res.blob !== "") {
                await landData(res.blob, res.mimeType, res.uri, i);
                continue;
            }
            if (typeof res.text === "string") {
                texts.push(res.text);
                continue;
            }
        }
        // 未知形态不吞内容：给一行截断占位，模型可据此追问或改调原生工具
        texts.push(`[unsupported content item ${i}: ${JSON.stringify(item).slice(0, 160)}]`);
    }

    if (raw.isError) {
        return {
            error: texts.join("\n\n") || "工具标记 isError 但未返回文本内容",
            ...(files.length ? {structuredContent: withFiles(files, raw)} : {}),
        };
    }

    let result = texts.join("\n\n");
    if (files.length) {
        const manifest = files.map((f) => `${f.path} (${f.mimeType}, ${formatSize(f.bytes)})`).join("\n");
        result = joinNonEmpty([result, `[已落盘到工作空间，可直接在文档中引用]\n${manifest}`], "\n\n");
    }
    const structured = withFiles(files, raw);
    return {
        result: result || "(工具未返回内容)",
        ...(Object.keys(structured).length ? {structuredContent: structured} : {}),
    };
}

function withFiles(files: LandedFile[], raw: McpCallToolResult): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (files.length) {
        out.files = files;
    }
    if (raw.structuredContent !== undefined) {
        out.structured = raw.structuredContent;
    }
    return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object";
}
