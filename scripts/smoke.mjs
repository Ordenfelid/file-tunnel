// 冒烟测试：起一个 mock MCP 服务器 + 拦截内核 API fetch，驱动 src 全流程验证
// （HTTP 通道、{{secrets}} 头部插值、SSE/JSON 双帧解析、二进制落盘、OAuth 短路、
//  sendFiles 闭环注入、内核 /mcp 桥 Token 鉴权）。不依赖运行中的思源内核。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require2 = createRequire(path.join(root, "package.json"));
const ts = require2("typescript");

// 模块加载器：TS -> CommonJS，stub 掉 siyuan 依赖
function compile(file) {
    const src = fs.readFileSync(path.join(root, "src", file), "utf8");
    return ts.transpileModule(src, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021}}).outputText;
}

const registry = {};
function load(name) {
    if (registry[name]) {
        return registry[name].exports;
    }
    const mod = {exports: {}};
    registry[name] = mod;
    const req = (id) => {
        if (id === "siyuan") {
            return siyuanStub;
        }
        if (id.startsWith("./")) {
            return load(id.slice(2).replace(/\.ts$/, "") + ".ts");
        }
        throw new Error("unexpected require " + id);
    };
    new Function("require", "module", "exports", compile(name))(req, mod, mod.exports);
    return mod.exports;
}

const siyuanStub = {
    Plugin: class {
        constructor() {
            this.caps = {};
        }

        addAgentCapability(options) {
            this.caps[options.name] = options;
            return "plugin/frontend/result2asset/" + options.name;
        }

        getSecret(name) {
            return name === "TEST_KEY" ? "sekret" : "";
        }

        getVariable(name) {
            return name === "V1" ? "hello-var" : "";
        }
    },
};

// 1x1 透明 PNG
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_B64, "base64");

const recorded = {requests: [], upload: null, uploadArgs: null, readDirs: [], gets: []};
let mockBase = "";

const mock = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
        recorded.requests.push({method: req.method, headers: req.headers, body});
        if (req.method === "DELETE") {
            res.writeHead(204);
            res.end();
            return;
        }
        let msg = null;
        try {
            msg = JSON.parse(body);
        } catch {
            res.writeHead(400);
            res.end();
            return;
        }
        if (msg.method === "initialize") {
            res.writeHead(200, {"content-type": "application/json", "mcp-session-id": "sess-42"});
            res.end(JSON.stringify({
                jsonrpc: "2.0", id: msg.id,
                result: {protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {name: "mock", version: "0"}},
            }));
            return;
        }
        if (typeof msg.method === "string" && msg.method.startsWith("notifications/")) {
            res.writeHead(202);
            res.end();
            return;
        }
        if (msg.method === "tools/call") {
            const name = msg.params?.name;
            if (name === "echo_binary") {
                const result = {content: [
                    {type: "text", text: "rendered ok"},
                    {type: "image", mimeType: "image/png", data: PNG_B64},
                ]};
                res.writeHead(200, {"content-type": "text/event-stream"});
                res.end(`event: message\ndata: ${JSON.stringify({jsonrpc: "2.0", id: msg.id, result})}\n\n`);
                return;
            }
            if (name === "upload_receiver") {
                recorded.uploadArgs = msg.params?.arguments;
                res.writeHead(200, {"content-type": "application/json"});
                res.end(JSON.stringify({jsonrpc: "2.0", id: msg.id, result: {content: [{type: "text", text: "received"}]}}));
                return;
            }
            if (name === "oauth_guard") {
                res.writeHead(401, {"WWW-Authenticate": 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"'});
                res.end();
                return;
            }
            res.writeHead(200, {"content-type": "application/json"});
            res.end(JSON.stringify({jsonrpc: "2.0", id: msg.id, result: {content: [{type: "text", text: "kernel ok"}]}}));
            return;
        }
        res.writeHead(400);
        res.end();
    });
});

await new Promise((r) => mock.listen(0, "127.0.0.1", r));
mockBase = `http://127.0.0.1:${mock.address().port}`;

const jsonResp = (obj) => new Response(JSON.stringify(obj), {headers: {"content-type": "application/json"}});
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u === "/api/asset/upload") {
        assert.ok(opts.body instanceof FormData, "upload body is FormData");
        const dir = opts.body.get("assetsDirPath");
        const files = opts.body.getAll("file[]");
        recorded.upload = {dir, files: files.map((f) => ({name: f.name, type: f.type, size: f.size}))};
        const name = recorded.upload.files[0].name;
        return jsonResp({code: 0, data: {succMap: {[name]: `assets/mcp/${name}`}}});
    }
    if (u === "/api/file/readDir") {
        recorded.readDirs.push(JSON.parse(opts.body).path);
        return jsonResp({code: 0, data: [{name: "pic-20260921120000-abc123.png", isDir: false}]});
    }
    if (u === "/api/file/getFile") {
        recorded.gets.push(JSON.parse(opts.body).path);
        return new Response(new Uint8Array([1, 2, 3, 4, 5]));
    }
    if (u.startsWith("/")) {
        return realFetch(mockBase + u, opts); // 内核 /mcp 桥路由到 mock
    }
    return realFetch(u, opts);
};

globalThis.window = {
    siyuan: {
        config: {
            api: {token: "test-token"},
            system: {os: "win32"},
            ai: {mcp: {servers: []}},
        },
    },
};
const setServers = (servers) => {
    window.siyuan.config.ai.mcp.servers = servers;
};

const {default: PluginClass} = load("index.ts");
const plugin = new PluginClass();
plugin.onload();
const handler = plugin.caps.exec.handler;
assert.ok(handler, "exec capability registered");

const mockServer = () => ({
    id: "s1", enabled: true, name: "mock-srv", url: `${mockBase}/mcp`, type: "http",
    headers: {Authorization: "Bearer {{secrets.TEST_KEY}}", "X-Var": "{{vars.V1}}"},
    timeout: 5, command: "",
});

try {
    // 场景 1：二进制结果落盘 + 头部插值 + SSE 帧解析 + 会话生命周期
    setServers([mockServer()]);
    recorded.requests.length = 0;
    const out1 = await handler({target: "mcp_mock-srv_echo_binary", args: {q: 1}});
    assert.ok(out1.result.includes("rendered ok"), `text passthrough missing: ${JSON.stringify(out1)}`);
    assert.ok(out1.result.includes("assets/mcp/"), `landed path missing: ${JSON.stringify(out1)}`);
    assert.ok(!out1.result.includes(PNG_B64.slice(0, 40)), "base64 leaked into result");
    assert.equal(out1.structuredContent.files[0].mimeType, "image/png");
    assert.equal(out1.structuredContent.files[0].bytes, PNG_BYTES.length);
    assert.equal(recorded.upload.dir, "assets/mcp");
    const up = recorded.upload.files[0];
    assert.match(up.name, /^mock-srv_echo_binary_1.*\.png$/);
    assert.equal(up.type, "image/png");
    assert.equal(up.size, PNG_BYTES.length);
    const posts = recorded.requests.filter((r) => r.method === "POST");
    assert.equal(posts[0].headers.authorization, "Bearer sekret", "secret interpolation failed");
    assert.ok(posts.some((r) => r.headers["mcp-session-id"] === "sess-42"), "session id not carried");
    await new Promise((r) => setTimeout(r, 50)); // DELETE 是尽力而为的异步收尾
    assert.ok(recorded.requests.some((r) => r.method === "DELETE"), "session not closed");
    console.log("PASS 1: binary result landed, headers interpolated, SSE parsed, session closed");

    // 场景 2：OAuth 401 挑战 → 定向报错指原生工具
    const out2 = await handler({target: "mcp_mock-srv_oauth_guard", args: {}});
    assert.ok(out2.error && out2.error.includes("mcp_mock-srv_oauth_guard"), `oauth hint missing: ${JSON.stringify(out2)}`);
    assert.ok(out2.error.includes("OAuth"));
    console.log("PASS 2: OAuth short-circuit points to native tool");

    // 场景 3：sendFiles 闭环（裸文件名时间戳模糊匹配 → base64 注入参数字段）
    recorded.readDirs.length = 0;
    const out3 = await handler({
        target: "mcp_mock-srv_upload_receiver",
        args: {note: "hi"},
        sendFiles: [{field: "file_b64", path: "assets/mcp/pic.png"}],
    });
    assert.equal(out3.result, "received");
    assert.equal(recorded.uploadArgs.file_b64, Buffer.from([1, 2, 3, 4, 5]).toString("base64"));
    assert.equal(recorded.uploadArgs.note, "hi");
    assert.ok(recorded.readDirs[0].includes("assets"), `readDir path: ${recorded.readDirs[0]}`);
    assert.ok(recorded.gets[0].endsWith("pic-20260921120000-abc123.png"), `getFile path: ${recorded.gets[0]}`);
    console.log("PASS 3: sendFiles resolves, reads and injects base64 into args");

    // 场景 4：内核原生工具经 /mcp 桥（Token 鉴权）
    recorded.requests.length = 0;
    const out4 = await handler({target: "kernel_echo", args: {}});
    assert.equal(out4.result, "kernel ok");
    const bridgePosts = recorded.requests.filter((r) => r.method === "POST");
    assert.equal(bridgePosts[0].headers.authorization, "Token test-token", "bridge auth failed");
    console.log("PASS 4: kernel tool via /mcp bridge with API token");

    // 场景 5：反解失败给出可用指引
    const out5 = await handler({target: "mcp_nosuch_thing", args: {}});
    assert.ok(out5.error && out5.error.includes("mock-srv"), `unresolved target hint: ${JSON.stringify(out5)}`);
    console.log("PASS 5: unresolvable target lists available servers");

    console.log("\nALL SMOKE TESTS PASSED");
} finally {
    await new Promise((r) => mock.close(r));
}
