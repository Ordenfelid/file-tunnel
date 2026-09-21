// MCP Streamable HTTP 客户端：自连外部 http 类型服务器，也复用于内核内置 /mcp 桥。
// 每次调用走完整生命周期 initialize → notifications/initialized → tools/call → DELETE，
// 不持有跨调用状态。响应兼容 application/json 与 text/event-stream 两种帧格式。

import { OAuthRequiredError, ToolError } from "./util";

export interface McpContentItem {
    type?: string;
    text?: string;
    data?: string; // base64
    mimeType?: string;
    uri?: string;
    [key: string]: unknown;
}

export interface McpCallToolResult {
    content?: McpContentItem[];
    structuredContent?: unknown;
    isError?: boolean;
}

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = {name: "result2asset", version: "0.1.0"};

let nextRpcId = 0;

interface JsonRpcResponse {
    jsonrpc?: string;
    id?: number | string | null;
    result?: unknown;
    error?: {code?: number; message?: string; data?: unknown};
}

/** 单次 POST；401 一律转 OAuthRequiredError，由上层给“改调原生工具”的定向指引。 */
async function rpcPost(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
    message: unknown,
    sessionId: string | null,
    isNotification: boolean,
): Promise<{payload: JsonRpcResponse | null; sessionId: string | null}> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const resp = await fetch(url, {
            method: "POST",
            headers: {
                ...headers,
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                ...(sessionId ? {"mcp-session-id": sessionId} : {}),
            },
            body: JSON.stringify(message),
            signal: controller.signal,
        });
        if (resp.status === 401) {
            const challenge = resp.headers.get("WWW-Authenticate") || "";
            throw new OAuthRequiredError(challenge);
        }
        if (!resp.ok) {
            throw new ToolError(`MCP 服务器返回 HTTP ${resp.status}（${url}）`);
        }
        const nextSessionId = resp.headers.get("mcp-session-id") || sessionId;
        if (isNotification || resp.status === 202) {
            return {payload: null, sessionId: nextSessionId};
        }
        const ctype = (resp.headers.get("content-type") || "").toLowerCase();
        const payload = ctype.includes("text/event-stream") ? await parseSsePayload(await resp.text()) : await resp.json();
        return {payload: payload as JsonRpcResponse, sessionId: nextSessionId};
    } catch (e) {
        if (e instanceof OAuthRequiredError || e instanceof ToolError) {
            throw e;
        }
        if ((e as Error).name === "AbortError") {
            throw new ToolError(`MCP 请求超时（${Math.round(timeoutMs / 1000)}s）：${url}`);
        }
        throw new ToolError(`MCP 请求失败：${(e as Error).message}（${url}）`);
    } finally {
        clearTimeout(timer);
    }
}

/** 从 SSE 文本里取第一条 JSON-RPC 响应（优先 id 匹配的）。 */
async function parseSsePayload(text: string): Promise<JsonRpcResponse | null> {
    const datas: string[] = [];
    for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block
            .split(/\r?\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n");
        if (data && data !== "[DONE]") {
            datas.push(data);
        }
    }
    let fallback: JsonRpcResponse | null = null;
    for (const d of datas) {
        try {
            const parsed = JSON.parse(d) as JsonRpcResponse;
            if (parsed && (parsed.result !== undefined || parsed.error)) {
                if (parsed.id !== undefined && parsed.id !== null) {
                    return parsed;
                }
                fallback = parsed;
            }
        } catch {
            // 忽略非 JSON 的注释/心跳块
        }
    }
    return fallback;
}

function unwrap(payload: JsonRpcResponse | null, what: string): unknown {
    if (!payload) {
        throw new ToolError(`MCP 响应为空（${what}）`);
    }
    if (payload.error) {
        throw new ToolError(`MCP 错误（${what}）：${payload.error.message ?? JSON.stringify(payload.error)}`);
    }
    return payload.result;
}

/** 完整生命周期调用一个工具；无论成败都尽力 DELETE 会话。 */
export async function callToolOverHttp(
    url: string,
    headers: Record<string, string>,
    tool: string,
    toolArgs: Record<string, unknown>,
    timeoutMs: number,
): Promise<McpCallToolResult> {
    let sessionId: string | null = null;
    try {
        const initId = ++nextRpcId;
        const init = await rpcPost(url, headers, timeoutMs, {
            jsonrpc: "2.0", id: initId, method: "initialize",
            params: {protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO},
        }, null, false);
        sessionId = init.sessionId;
        unwrap(init.payload, "initialize");

        await rpcPost(url, headers, timeoutMs, {
            jsonrpc: "2.0", method: "notifications/initialized",
        }, sessionId, true);

        const callId = ++nextRpcId;
        const call = await rpcPost(url, headers, timeoutMs, {
            jsonrpc: "2.0", id: callId, method: "tools/call",
            params: {name: tool, arguments: toolArgs},
        }, sessionId, false);
        const result = unwrap(call.payload, "tools/call");
        if (!result || typeof result !== "object") {
            throw new ToolError(`MCP tools/call 返回异常：${JSON.stringify(result).slice(0, 200)}`);
        }
        return result as McpCallToolResult;
    } finally {
        if (sessionId) {
            void fetch(url, {
                method: "DELETE",
                headers: {...headers, ...(sessionId ? {"mcp-session-id": sessionId} : {})},
            }).catch(() => undefined);
        }
    }
}
