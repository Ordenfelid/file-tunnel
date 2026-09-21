// MCP stdio 客户端：仅思源桌面版（渲染进程有 Node 集成时 window.require 可用）。
// NDJSON 帧协议：initialize → notifications/initialized → tools/call，用后即杀进程。

import { McpCallToolResult } from "./rpc";
import { IMCPServerConfig, nodeRequire, ToolError } from "./util";

interface ReadableLike {
    setEncoding(enc: string): ReadableLike;
    on(event: "data", fn: (chunk: string) => void): void;
}

interface ChildProcess {
    stdin: {write: (s: string) => void; end: () => void};
    stdout: ReadableLike;
    stderr: ReadableLike;
    on(event: "error", fn: (err: Error) => void): void;
    on(event: "close", fn: (code: number | null) => void): void;
    kill: () => void;
}

interface SpawnFn {
    (command: string, args: string[], options: {env: Record<string, string>; stdio: string[]; windowsHide: boolean}): ChildProcess;
}

/**
 * 构建子进程环境：内核语义是 inheritEnv 白名单 + env 映射（{{secrets}}/{{vars}} 插值）。
 * Node 的 spawn 需要最小路径变量才能定位可执行文件，故先垫一层进程查找必需项。
 */
function buildChildEnv(server: IMCPServerConfig, procEnv: Record<string, string | undefined>,
                      resolve: (tpl: string) => string): Record<string, string> {
    const isWin = siyuanOs() === "windows";
    const base: Record<string, string> = {};
    const essentials = isWin
        ? ["PATH", "SYSTEMROOT", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "TEMP", "TMP"]
        : ["PATH", "HOME", "TMPDIR", "LANG"];
    for (const name of essentials) {
        if (procEnv[name] !== undefined) {
            base[name] = procEnv[name] as string;
        }
    }
    for (const name of server.inheritEnv ?? []) {
        if (procEnv[name] !== undefined) {
            base[name] = procEnv[name] as string;
        }
    }
    for (const [name, value] of Object.entries(server.env ?? {})) {
        base[name] = resolve(value);
    }
    return base;
}

function siyuanOs(): string {
    const w = window as unknown as {siyuan?: {config?: {system?: {os?: string}}}};
    return w.siyuan?.config?.system?.os || "";
}

export async function callStdioTool(
    server: IMCPServerConfig,
    tool: string,
    toolArgs: Record<string, unknown>,
    timeoutMs: number,
    resolve: (tpl: string) => string,
): Promise<McpCallToolResult> {
    const req = nodeRequire();
    if (!req) {
        throw new ToolError(
            "stdio 类型 MCP 服务器只能在思源桌面版调用（当前环境无 Node 集成）。该服务器请直接用原生工具。/ stdio MCP servers need the SiYuan desktop app.",
        );
    }
    const {spawn} = req("child_process") as {spawn: SpawnFn};
    const procEnv = (req("process") as {env: Record<string, string | undefined>}).env;
    if (!server.command) {
        throw new ToolError(`MCP 服务器「${server.name}」缺少启动命令（command）`);
    }

    const child = spawn(server.command, server.args ?? [], {
        env: buildChildEnv(server, procEnv, resolve),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
    });

    let nextId = 0;
    let buffer = "";
    let stderrTail = "";
    let timedOut = false;
    let settled = false;
    const pending = new Map<number, {resolve: (v: JsonRpcMsg) => void; reject: (e: Error) => void}>();

    const watchdog = setTimeout(() => {
        timedOut = true;
        child.kill();
    }, timeoutMs);

    const failAll = (err: Error) => {
        if (settled) {
            return;
        }
        settled = true;
        clearTimeout(watchdog);
        for (const p of pending.values()) {
            p.reject(err);
        }
        pending.clear();
    };

    child.on("error", (err: Error) => {
        failAll(new ToolError(
            `启动 stdio MCP 服务器失败（${server.command}）：${err.message}${stderrTail ? `；stderr: ${stderrTail}` : ""}`,
        ));
    });
    child.on("close", (code: number | null) => {
        if (!settled) {
            failAll(new ToolError(
                timedOut
                    ? `stdio MCP 服务器「${server.name}」超时（${Math.round(timeoutMs / 1000)}s），进程已终止${stderrTail ? `；stderr: ${stderrTail}` : ""}`
                    : `stdio MCP 服务器「${server.name}」提前退出（code ${code ?? "?"}）${stderrTail ? `；stderr: ${stderrTail}` : ""}`,
            ));
        }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-2048);
    });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) {
                continue;
            }
            try {
                dispatch(JSON.parse(line) as JsonRpcMsg);
            } catch {
                // 非 JSON 行（服务器日志）直接忽略
            }
        }
    });

    interface JsonRpcMsg {
        id?: number | string | null;
        result?: unknown;
        error?: {message?: string};
    }

    function dispatch(msg: JsonRpcMsg) {
        if (msg.id === undefined || msg.id === null) {
            return; // 服务器侧通知，忽略
        }
        const waiter = pending.get(Number(msg.id));
        if (waiter) {
            pending.delete(Number(msg.id));
            waiter.resolve(msg);
        }
    }

    function call(method: string, params: unknown): Promise<JsonRpcMsg> {
        const id = ++nextId;
        return new Promise((resolveP, rejectP) => {
            pending.set(id, {resolve: resolveP, reject: rejectP});
            child.stdin.write(JSON.stringify({jsonrpc: "2.0", id, method, params}) + "\n");
        });
    }

    function unwrapM(msg: JsonRpcMsg, what: string): unknown {
        if (msg.error) {
            throw new ToolError(`MCP 错误（${what}）：${msg.error.message ?? JSON.stringify(msg.error)}`);
        }
        return msg.result;
    }

    try {
        const init = await call("initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: {name: "result2asset", version: "0.1.1"},
        });
        unwrapM(init, "initialize");
        child.stdin.write(JSON.stringify({jsonrpc: "2.0", method: "notifications/initialized"}) + "\n");
        const resp = await call("tools/call", {name: tool, arguments: toolArgs});
        const result = unwrapM(resp, "tools/call");
        if (!result || typeof result !== "object") {
            throw new ToolError(`MCP tools/call 返回异常：${JSON.stringify(result).slice(0, 200)}`);
        }
        return result as McpCallToolResult;
    } finally {
        settled = true;
        clearTimeout(watchdog);
        pending.clear();
        child.kill();
    }
}
