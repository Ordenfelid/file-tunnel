// result2asset：唯一能力 exec——以二进制安全的方式代调 MCP 工具与内核工具。
// 定位是 overlay 包装层：不改变模型可见的原生工具，只提供一条包装通道；
// 文本结果直回、二进制落盘 assets/mcp、sendFiles 注入附件字节、OAuth 短路报错指路。

import { Plugin } from "siyuan";
import { applySendFiles } from "./inject";
import { callToolOverHttp, McpCallToolResult } from "./rpc";
import { handleToolResult } from "./result";
import { callStdioTool } from "./stdio";
import { resolveTarget } from "./target";
import { apiToken, IMCPServerConfig, interpolateTemplate, OAuthRequiredError, ToolError } from "./util";

const KERNEL_BRIDGE_TIMEOUT_MS = 120_000;

export default class Result2AssetPlugin extends Plugin {
    onload() {
        // addAgentCapability 的注册 id 由宿主登记在本插件实例上，卸载时自动清理
        this.addAgentCapability({
            name: "exec",
            title: "Exec (binary-safe)",
            description:
                "Binary-safe executor for MCP tools and SiYuan kernel tools. Prefer it over a native tool whenever " +
                "the result may contain binary content (image/audio/video/file — e.g. screenshot, image-generation, " +
                "render, export, tts tools) or when an argument needs file bytes. Text results are returned verbatim; " +
                "binary results are saved into the workspace at assets/mcp/ and only their paths + metadata come back, " +
                "so base64 never floods the conversation; saved paths can be embedded into documents directly. " +
                "To send a file to a tool, pass sendFiles: [{field, path}] — each entry reads a workspace asset and " +
                "injects its base64 bytes into args[field]. OAuth-authorized MCP servers cannot be proxied here " +
                "(credentials are kernel-managed); such calls fail fast and name the native tool to use instead.\n" +
                "二进制安全地代调 MCP 工具与思源内核工具。凡结果可能含二进制（图片/音频/视频/文件，如截图、生成图片、" +
                "渲染、导出、语音合成类工具）、或参数需要文件字节的场景，请用本工具代替原生工具：文本结果原样返回；" +
                "二进制结果落盘到 assets/mcp/ 并只返回路径与元数据（base64 不进对话），落盘路径可直接嵌入文档。" +
                "需要向工具传文件时用 sendFiles: [{field, path}]——逐项读取工作空间附件并把 base64 注入 args 对应字段。" +
                "OAuth 授权的 MCP 服务器无法经本工具代调（凭据由内核托管），此类调用会立刻报错并指明应改用的原生工具。",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    target: {
                        type: "string",
                        description:
                            "Native tool name exactly as it appears in the tool list: 'mcp_<server>_<tool>' for an MCP tool " +
                            "(reverse-resolved here), or a kernel tool name (executed via SiYuan's built-in /mcp bridge). " +
                            "原生工具名：mcp_<服务器>_<工具> 形态（自动反解），或内核工具名（经内置 /mcp 桥执行）。",
                    },
                    server: {
                        type: "string",
                        description:
                            "Explicit MCP server name (Settings → AI → MCP), paired with tool; use when the flattened name is ambiguous. " +
                            "显式 MCP 服务器名，与 tool 成对使用（扁平名有歧义时）。",
                    },
                    tool: {
                        type: "string",
                        description: "Tool name on that server. 该服务器上的工具名。",
                    },
                    args: {
                        type: "object",
                        additionalProperties: true,
                        description:
                            "The target tool's own arguments object, passed through verbatim. 目标工具自身的参数对象，原样透传。",
                    },
                    sendFiles: {
                        type: "array",
                        description:
                            "Files to attach: each {field, path} reads the workspace asset at path and injects its base64 bytes " +
                            "into args[field] before the call. Paths are workspace assets/... relative (exec's returned paths work " +
                            "as-is); a bare filename auto-matches SiYuan's timestamp-suffixed names. " +
                            "上传文件：逐项 {field, path} 读取工作空间附件并把 base64 注入 args[field]（exec 返回的路径可直接使用）。",
                        items: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                field: {
                                    type: "string",
                                    description: "Top-level key in args to overwrite. 注入 args 的顶层字段名（原值会被覆盖）。",
                                },
                                path: {
                                    type: "string",
                                    description: "Workspace asset path, e.g. assets/mcp/xxx.png. 附件路径。",
                                },
                            },
                            required: ["field", "path"],
                        },
                    },
                },
            },
            effects: {
                localRead: true, // sendFiles 读取工作空间 assets
                localWrite: true, // 二进制结果落盘 assets/mcp
                dataEgress: true, // 代调外部 MCP 服务器（含其参数）
            },
            handler: (args) => exec(this, args),
        });
    }
}

async function exec(plugin: Result2AssetPlugin, rawArgs: Record<string, unknown>): Promise<{
    result?: string;
    structuredContent?: unknown;
    error?: string;
}> {
    let nativeName = "";
    try {
        const target = resolveTarget(rawArgs);
        nativeName = target.kind === "mcp" ? target.nativeName : target.tool;

        const toolArgs = extractToolArgs(rawArgs.args);
        await applySendFiles(toolArgs, rawArgs.sendFiles);

        const result = target.kind === "kernel"
            ? await callKernelTool(target.tool, toolArgs)
            : await callMcpTool(plugin, target.server, target.tool, toolArgs);
        return await handleToolResult(nativeName, result);
    } catch (e) {
        if (e instanceof OAuthRequiredError) {
            return {error: oauthHint(e, nativeName)};
        }
        return {error: e instanceof ToolError ? e.message : `执行失败：${(e as Error).message}`};
    }
}

function extractToolArgs(raw: unknown): Record<string, unknown> {
    if (raw === undefined || raw === null) {
        return {};
    }
    if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new ToolError("args 需为对象（目标工具的参数）。/ args must be the tool's arguments object.");
    }
    return {...raw as Record<string, unknown>};
}

function serverTimeoutMs(server: IMCPServerConfig): number {
    return server.timeout > 0 ? server.timeout * 1000 : 30_000;
}

function makeTemplateResolver(plugin: Result2AssetPlugin): (tpl: string) => string {
    return (tpl: string) => interpolateTemplate(
        tpl,
        (name) => plugin.getSecret(name),
        (name) => plugin.getVariable(name),
    );
}

async function callMcpTool(
    plugin: Result2AssetPlugin,
    server: IMCPServerConfig,
    tool: string,
    toolArgs: Record<string, unknown>,
): Promise<McpCallToolResult> {
    const resolve = makeTemplateResolver(plugin);
    if (server.type === "http") {
        if (!server.url) {
            throw new ToolError(`MCP 服务器「${server.name}」缺少 URL`);
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(server.headers ?? {})) {
            headers[k] = resolve(v);
        }
        return callToolOverHttp(server.url, headers, tool, toolArgs, serverTimeoutMs(server));
    }
    if (server.type === "stdio") {
        return callStdioTool(server, tool, toolArgs, serverTimeoutMs(server), resolve);
    }
    throw new ToolError(`不支持的 MCP 服务器类型「${server.type}」（仅 http / stdio）`);
}

/** 内核原生工具：经内置 /mcp 端点以 API token 自连执行。 */
function callKernelTool(tool: string, toolArgs: Record<string, unknown>): Promise<McpCallToolResult> {
    return callToolOverHttp("/mcp", {Authorization: `Token ${apiToken()}`}, tool, toolArgs, KERNEL_BRIDGE_TIMEOUT_MS);
}

function oauthHint(e: OAuthRequiredError, nativeName: string): string {
    const challenge = e.challenge ? `（WWW-Authenticate: ${e.challenge.slice(0, 120)}）` : "";
    return `该 MCP 服务器要求 OAuth 授权${challenge}，凭据由思源内核托管，本工具无法代调。` +
        `请直接调用原生工具 ${nativeName || "（对应的 mcp_* 原生工具）"} 完成此操作。` +
        `/ This MCP server requires kernel-managed OAuth credentials; call the native tool ${nativeName} directly instead.`;
}
