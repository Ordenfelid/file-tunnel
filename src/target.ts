// target 反解：把模型看到的三种原生工具名形态解析成可执行的目标。
// 1) target = "mcp_<server>_<tool>"  → 按内核 sanitize 规则前缀反解出 server + tool
// 2) server + tool 显式给出          → 扁平名有歧义时的逃生通道
// 3) target = 内核工具名（无 mcp_ 前缀）→ 经内置 /mcp 桥执行

import { enabledMcpServers, IMCPServerConfig, sanitizeName, ToolError } from "./util";

export type ResolvedTarget =
    | { kind: "mcp"; server: IMCPServerConfig; tool: string; nativeName: string }
    | { kind: "kernel"; tool: string };

interface ExecArgs {
    target?: unknown;
    server?: unknown;
    tool?: unknown;
}

function asString(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
}

export function resolveTarget(args: ExecArgs): ResolvedTarget {
    const target = asString(args.target);
    const serverName = asString(args.server);
    const tool = asString(args.tool);

    if (target && (serverName || tool)) {
        throw new ToolError("target 与 server/tool 互斥，请二选一提供。/ Pass either target, or server+tool — not both.");
    }

    if (serverName || tool) {
        if (!serverName || !tool) {
            throw new ToolError("server 与 tool 需成对提供。/ server and tool must be provided together.");
        }
        const servers = enabledMcpServers();
        let server = servers.find((s) => s.name === serverName);
        if (!server) {
            // 模型偶尔会记错大小写；唯一命中时不敏感匹配可救回，多重合仍报错
            const folded = servers.filter((s) => s.name.toLowerCase() === serverName.toLowerCase());
            if (folded.length === 1) {
                server = folded[0];
            } else if (folded.length > 1) {
                throw new ToolError(
                    `多个 MCP 服务器名称与「${serverName}」大小写不敏感地重合，请使用准确名称。` +
                    "/ Multiple servers match case-insensitively; use the exact name.",
                );
            }
        }
        if (!server) {
            const names = servers.map((s) => s.name).join("、") || "（无）";
            throw new ToolError(
                `未找到名为「${serverName}」的已启用 MCP 服务器。可用服务器：${names}（以 设置→AI→MCP 中的名称为准）。` +
                "/ No enabled MCP server with this name; names must match Settings → AI → MCP.",
            );
        }
        return {kind: "mcp", server, tool, nativeName: `mcp_${sanitizeName(server.name)}_${sanitizeName(tool)}`};
    }

    if (!target) {
        throw new ToolError("缺少目标：请提供 target（原生工具名），或 server + tool。/ Missing target: pass the native tool name, or server+tool.");
    }

    if (target.startsWith("mcp_")) {
        const candidates = enabledMcpServers()
            .map((server) => {
                const prefix = `mcp_${sanitizeName(server.name)}_`;
                return target.startsWith(prefix) ? {server, tool: target.slice(prefix.length)} : null;
            })
            .filter((c): c is {server: IMCPServerConfig; tool: string} => c !== null && c.tool !== "");
        if (candidates.length === 1) {
            return {kind: "mcp", server: candidates[0].server, tool: candidates[0].tool, nativeName: target};
        }
        if (candidates.length > 1) {
            const names = candidates.map((c) => `${c.server.name} → ${c.tool}`).join("；");
            throw new ToolError(
                `「${target}」可反解为多个服务器前缀（${names}）。请改用显式 server + tool 形态调用。` +
                "/ Ambiguous flattened name; retry with explicit server+tool.",
            );
        }
        const names = enabledMcpServers().map((s) => s.name).join("、") || "（无）";
        throw new ToolError(
            `没有已启用的 MCP 服务器与「${target}」匹配。可用服务器：${names}；内核原生工具请直接传工具名（不带 mcp_ 前缀）。` +
            "/ No enabled MCP server matches this name.",
        );
    }

    return {kind: "kernel", tool: target};
}
