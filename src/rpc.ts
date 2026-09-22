// MCP Streamable HTTP 客户端：自连外部 http 类型服务器，也复用于内核内置 /mcp 桥。
// 每次调用走完整生命周期 initialize → notifications/initialized → tools/call → DELETE，
// 不持有跨调用状态。响应兼容 application/json 与 text/event-stream 两种帧格式。
// 跨源请求按环境选通道：桌面端走 Node http(s) 直连（渲染进程 fetch 受 Chromium 网络栈
// 管辖，系统代理等拦截会导致 Failed to fetch，而内核原生 MCP 客户端是直连的，行为需对齐）；
// 浏览器/移动端经内核 /api/network/forwardProxy 代发（与原生工具同一网络栈，不受
// 浏览器 CORS/代理限制）。同源（/mcp 桥）走 fetch。

import { nodeRequire, OAuthRequiredError, ToolError } from "./util";

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
export const CLIENT_INFO = {name: "file-tunnel", version: "0.1.6"};

let nextRpcId = 0;

interface JsonRpcResponse {
    jsonrpc?: string;
    id?: number | string | null;
    result?: unknown;
    error?: {code?: number; message?: string; data?: unknown};
}

/** 统一两种传输的响应面：状态码、响应头读取、正文文本。 */
interface FlatResponse {
    status: number;
    contentType: string;
    header(name: string): string | null;
    text: string;
}

interface NodeClientRequest {
    on(event: "error", fn: (err: Error) => void): NodeClientRequest;
    write(body: string): void;
    end(): void;
    destroy(err?: Error): void;
}

interface NodeIncomingMessage {
    statusCode?: number;
    headers: Record<string, string | string[] | undefined>;
    on(event: "data", fn: (chunk: {toString(encoding: string): string}) => void): NodeIncomingMessage;
    on(event: "end", fn: () => void): NodeIncomingMessage;
    on(event: "error", fn: (err: Error) => void): NodeIncomingMessage;
    destroy(): void;
}

interface NodeHttpModule {
    request(url: string, options: {method: string; headers: Record<string, string>},
        callback: (resp: NodeIncomingMessage) => void): NodeClientRequest;
}

function crossOrigin(url: string): boolean {
    if (!/^https?:\/\//i.test(url)) {
        return false; // 相对路径（内置 /mcp 桥）必为同源
    }
    try {
        return new URL(url).origin !== window.location.origin;
    } catch {
        return false;
    }
}

/** 传输通道：同源走 fetch；跨源时桌面走 Node 直连，浏览器/移动端经内核代发。 */
type Transport = "node" | "relay" | "fetch";

function chooseTransport(url: string): Transport {
    if (!crossOrigin(url)) {
        return "fetch";
    }
    return nodeRequire() !== null ? "node" : "relay";
}

const TRANSPORT_LABEL: Record<Transport, string> = {node: "桌面直连", relay: "内核转发", fetch: "浏览器 fetch"};

function nodeRequest(url: string, method: string, headers: Record<string, string>, body: string | null,
    timeoutMs: number, earlySseStop: boolean): Promise<FlatResponse> {
    return new Promise((resolve, reject) => {
        const req = nodeRequire();
        const mod = (req ? req(url.startsWith("https:") ? "https" : "http") : undefined) as NodeHttpModule | undefined;
        if (!mod) {
            reject(new ToolError("Node 传输不可用（非桌面环境）"));
            return;
        }
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const settle = (fn: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timer !== null) {
                clearTimeout(timer);
            }
            fn();
        };
        const request = mod.request(url, {method, headers}, (resp) => {
            const status = resp.statusCode ?? 0;
            const respHeaders = resp.headers ?? {};
            const contentType = String(respHeaders["content-type"] ?? "");
            const header = (name: string): string | null => {
                const value = respHeaders[name.toLowerCase()];
                if (value === undefined) {
                    return null;
                }
                return Array.isArray(value) ? value[0] ?? null : value;
            };
            let text = "";
            resp.on("data", (chunk) => {
                text += chunk.toString("utf8");
                // SSE 流可能在响应事件之后仍不关闭；拿到完整 JSON-RPC 响应即主动断流
                if (earlySseStop && contentType.includes("text/event-stream") && parseSsePayload(text)) {
                    resp.destroy();
                    settle(() => resolve({status, contentType, header, text}));
                }
            });
            resp.on("end", () => settle(() => resolve({status, contentType, header, text})));
            resp.on("error", (err) => settle(() => reject(err)));
        });
        request.on("error", (err) => settle(() => reject(err)));
        timer = setTimeout(() => {
            const err = new Error("node request timeout");
            err.name = "TimeoutError";
            request.destroy(err);
            settle(() => reject(err));
        }, timeoutMs);
        if (body !== null) {
            request.write(body);
        }
        request.end();
    });
}

/** UTF-8 安全且分块转换不吃调用栈的 base64。 */
function toBase64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

/** 浏览器/移动端跨源代发：经内核 /api/network/forwardProxy 转发，
 *  与内核原生 MCP 客户端同一网络栈（直连、不受浏览器 CORS/代理限制）。 */
async function kernelRelayRequest(url: string, method: string, headers: Record<string, string>,
    body: string | null, timeoutMs: number): Promise<FlatResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const fr = await fetch("/api/network/forwardProxy", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({
                url,
                method,
                timeout: timeoutMs,
                headers: Object.entries(headers).map(([name, value]) => ({[name]: value})),
                contentType: "application/json",
                payload: body === null ? "" : toBase64(body),
                payloadEncoding: "base64",
                responseEncoding: "text",
            }),
            signal: controller.signal,
        });
        if (fr.status === 404) {
            throw new ToolError("当前内核没有 /api/network/forwardProxy 转发接口（SiYuan 版本过旧），浏览器/移动端无法访问外部 MCP 服务器，请升级内核或在桌面版使用");
        }
        if (fr.status === 401 || fr.status === 403) {
            throw new ToolError(`内核转发接口鉴权失败（HTTP ${fr.status}）`);
        }
        if (fr.status < 200 || fr.status >= 300) {
            throw new ToolError(`内核转发接口返回 HTTP ${fr.status}`);
        }
        const envelope = JSON.parse(await fr.text()) as {
            code?: number;
            msg?: string;
            data?: {status?: number; contentType?: string; body?: string; headers?: Record<string, string[]>};
        };
        if (envelope.code !== 0 || !envelope.data) {
            throw new ToolError(`内核转发失败（code=${envelope.code ?? "?"}）：${envelope.msg ?? ""}`);
        }
        const lowered: Record<string, string> = {};
        for (const [name, values] of Object.entries(envelope.data.headers ?? {})) {
            lowered[name.toLowerCase()] = values[0] ?? "";
        }
        return {
            status: envelope.data.status ?? 0,
            contentType: envelope.data.contentType ?? "",
            header: (name) => lowered[name.toLowerCase()] || null,
            text: envelope.data.body ?? "",
        };
    } finally {
        clearTimeout(timer);
    }
}

/** 从 SSE 文本里取第一条 JSON-RPC 响应（优先 id 匹配的）。 */
function parseSsePayload(text: string): JsonRpcResponse | null {
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

/** 单次 POST；401 一律转 OAuthRequiredError，由上层给“改调原生工具”的定向指引。 */
async function rpcPost(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
    message: unknown,
    sessionId: string | null,
    isNotification: boolean,
): Promise<{payload: JsonRpcResponse | null; sessionId: string | null}> {
    const body = JSON.stringify(message);
    const transport = chooseTransport(url);
    // Accept 按规范同时声明两种类型：单值 application/json 会被 MCPHub 等严格网关在内容协商层
    // 直接回 406（鉴权之前，连工具名都没解析）。转发通道无法中途断流，服务器若以不关闭的
    // SSE 响应会整段缓冲到超时——错误自带通道标签，属可辨认的残余风险。
    const sendHeaders: Record<string, string> = {
        ...headers,
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        ...(sessionId ? {"mcp-session-id": sessionId} : {}),
    };
    try {
        let resp: FlatResponse;
        if (transport === "node") {
            resp = await nodeRequest(url, "POST", {
                ...sendHeaders,
                "Content-Length": String(new TextEncoder().encode(body).length),
            }, body, timeoutMs, true);
        } else if (transport === "relay") {
            resp = await kernelRelayRequest(url, "POST", sendHeaders, body, timeoutMs);
        } else {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const fr = await fetch(url, {method: "POST", headers: sendHeaders, body, signal: controller.signal});
                resp = {
                    status: fr.status,
                    contentType: fr.headers.get("content-type") ?? "",
                    header: (name) => fr.headers.get(name),
                    text: await fr.text(),
                };
            } finally {
                clearTimeout(timer);
            }
        }
        if (resp.status === 401) {
            throw new OAuthRequiredError(resp.header("WWW-Authenticate") || "");
        }
        if (resp.status < 200 || resp.status >= 300) {
            throw new ToolError(`MCP 服务器返回 HTTP ${resp.status}（${url}，通道=${TRANSPORT_LABEL[transport]}）`);
        }
        const nextSessionId = resp.header("mcp-session-id") || sessionId;
        if (isNotification || resp.status === 202) {
            return {payload: null, sessionId: nextSessionId};
        }
        const payload = resp.contentType.toLowerCase().includes("text/event-stream")
            ? parseSsePayload(resp.text)
            : JSON.parse(resp.text) as JsonRpcResponse;
        return {payload: payload as JsonRpcResponse, sessionId: nextSessionId};
    } catch (e) {
        if (e instanceof OAuthRequiredError || e instanceof ToolError) {
            throw e;
        }
        const name = (e as Error).name;
        if (name === "AbortError" || name === "TimeoutError") {
            throw new ToolError(`MCP 请求超时（${Math.round(timeoutMs / 1000)}s）：${url}（通道=${TRANSPORT_LABEL[transport]}）`);
        }
        throw new ToolError(`MCP 请求失败：${(e as Error).message}（${url}，通道=${TRANSPORT_LABEL[transport]}）`);
    }
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
            const closeHeaders = {...headers, "mcp-session-id": sessionId};
            const transport = chooseTransport(url);
            if (transport === "node") {
                void nodeRequest(url, "DELETE", closeHeaders, null, 5_000, false).catch(() => undefined);
            } else if (transport === "relay") {
                void kernelRelayRequest(url, "DELETE", closeHeaders, null, 5_000).catch(() => undefined);
            } else {
                void fetch(url, {method: "DELETE", headers: closeHeaders}).catch(() => undefined);
            }
        }
    }
}
