// 共享原语：错误类型、内核 fetch、名称净化、占位符插值、base64。

/** 工具级错误：文案直接返回给模型，用于引导其自纠（换参数/换原生工具）。 */
export class ToolError extends Error {
}

/** OAuth 短路：401 时抛出，由调用方组装“改调原生工具”的定向指引。 */
export class OAuthRequiredError extends ToolError {
    constructor(readonly challenge: string) {
        super("oauth required");
    }
}

export interface IWindowSiyuan {
    siyuan: {
        config: {
            api: { token: string };
            system: { os: string };
            ai?: {
                mcp?: {
                    servers?: IMCPServerConfig[];
                };
            };
        };
    };
}

/** 原生 MCP 配置里每个 server 的可读字段（window.siyuan.config.ai.mcp.servers）。 */
export interface IMCPServerConfig {
    id: string;
    enabled: boolean;
    name: string;
    url: string;
    type: string; // "stdio" | "http"（内核仅支持这两种）
    command: string;
    args?: string[];
    inheritEnv?: string[];
    env?: Record<string, string>;
    headers?: Record<string, string>;
    timeout: number; // 秒，0 = 内核默认 30s
}

export function siyuanConfig(): IWindowSiyuan["siyuan"]["config"] {
    const w = window as unknown as Partial<IWindowSiyuan>;
    if (!w.siyuan?.config) {
        throw new ToolError("window.siyuan.config 不可用");
    }
    return w.siyuan.config;
}

export function apiToken(): string {
    return siyuanConfig().api.token;
}

export function enabledMcpServers(): IMCPServerConfig[] {
    return (siyuanConfig().ai?.mcp?.servers ?? []).filter((s) => s.enabled);
}

/** 桌面版渲染进程的 Node 集成入口；浏览器/移动端环境返回 null。 */
export function nodeRequire(): ((id: string) => unknown) | null {
    const req = (window as unknown as {require?: unknown}).require;
    return typeof req === "function" ? req as (id: string) => unknown : null;
}

/** 与内核 kernel/mcp/client/mcp.go sanitize 一致：[A-Za-z0-9_-] 外全部转下划线。 */
export function sanitizeName(s: string): string {
    return s.replace(/[^\w-]/g, "_");
}

/**
 * 解析 {{secrets.NAME}} / {{vars.NAME}} 占位符。
 * 与内核一致：未命中的占位符原样保留；命中但值为空同样视为未命中。
 */
export function interpolateTemplate(
    tpl: string,
    secret: (name: string) => string,
    variable: (name: string) => string,
): string {
    return tpl.replace(/\{\{\s*(secrets|vars)\.([^\s}]+?)\s*\}\}/g, (whole, kind: string, name: string) => {
        const value = kind === "secrets" ? secret(name) : variable(name);
        return value === "" ? whole : value;
    });
}

export function bytesToBase64(bytes: Uint8Array): string {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i);
    }
    return out;
}

export function formatSize(n: number): string {
    if (n < 1024) {
        return `${n} B`;
    }
    if (n < 1024 * 1024) {
        return `${(n / 1024).toFixed(1)} KB`;
    }
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 保证字符串以单个换行拼接，用于把落盘清单追加到文本结果尾部。 */
export function joinNonEmpty(parts: string[], sep = "\n\n"): string {
    return parts.filter((p) => p !== "").join(sep);
}
