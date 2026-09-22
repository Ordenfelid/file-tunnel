// 冒烟测试：起一个 mock MCP 服务器 + 拦截内核 API fetch，驱动 src 全流程验证
// （HTTP 通道、{{secrets}} 头部插值、SSE/JSON 双帧解析、二进制落盘、嵌入式 resource.blob 落盘、
//  OAuth 短路、{{file2b64.…}} 占位符展开、内核 /mcp 桥 Token 鉴权、浏览器环境经内核 forwardProxy 代发）。
// 不依赖运行中的思源内核。
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

const recorded = {requests: [], upload: null, uploadArgs: null, readDirs: [], gets: [], hangClosed: false};
let mockBase = "";
let nodeTransportCalls = 0;
let relayCalls = 0;

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
            if (name === "embed_resource") {
                const result = {content: [
                    {type: "resource", resource: {uri: "mem://pic.png", mimeType: "image/png", blob: PNG_B64}},
                    {type: "resource", resource: {uri: "mem://note", text: "embedded text resource"}},
                    {type: "resource", resource: {uri: "mem://empty"}},
                ]};
                res.writeHead(200, {"content-type": "application/json"});
                res.end(JSON.stringify({jsonrpc: "2.0", id: msg.id, result}));
                return;
            }
            if (name === "oauth_guard") {
                res.writeHead(401, {"WWW-Authenticate": 'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"'});
                res.end();
                return;
            }
            if (name === "hang_sse") {
                // SSE 帧写完响应事件后不关闭连接，验证客户端拿到响应即主动断流
                const result = {content: [{type: "text", text: "hung then closed"}]};
                res.writeHead(200, {"content-type": "text/event-stream"});
                res.write(`event: message\ndata: ${JSON.stringify({jsonrpc: "2.0", id: msg.id, result})}\n\n`);
                res.on("close", () => {
                    recorded.hangClosed = true;
                });
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
    if (u === "/api/network/forwardProxy") {
        // 模拟内核转发接口：按契约解析请求，用 Node fetch 直连目标（无 CORS，等同内核行为）
        relayCalls += 1;
        const relay = JSON.parse(opts.body);
        assert.equal(relay.contentType, "application/json", "relay contentType");
        assert.equal(relay.payloadEncoding, "base64", "relay payloadEncoding");
        assert.equal(relay.method, relay.method.toUpperCase(), "relay method case");
        const target = await realFetch(relay.url, {
            method: relay.method,
            headers: Object.assign({}, ...relay.headers),
            body: relay.method === "DELETE" ? undefined : Buffer.from(relay.payload, "base64").toString("utf8"),
        });
        const text = await target.text();
        const headers = {};
        target.headers.forEach((v, k) => {
            headers[k.toLowerCase()] = [v];
        });
        return jsonResp({code: 0, data: {url: relay.url, status: target.status,
            contentType: target.headers.get("content-type") ?? "", body: text,
            bodyEncoding: "text", headers, elapsed: 1}});
    }
    if (u.startsWith("/")) {
        return realFetch(mockBase + u, opts); // 内核 /mcp 桥路由到 mock
    }
    return realFetch(u, opts);
};

globalThis.window = {
    // origin 与 mock 服务器不同源 → 外部 http 请求走 Node 传输；相对路径（/mcp 桥）仍走 fetch
    location: {origin: "http://localhost:9"},
    require: (id) => {
        if (id === "http" || id === "https") {
            nodeTransportCalls += 1;
            return require2(id);
        }
        throw new Error("unexpected window.require " + id);
    },
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
    const out1 = await handler({target: "mcp_mock-srv_echo_binary", args: {q: 1, note: "中文备注"}});
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
    assert.ok(nodeTransportCalls > 0, "node transport not used for cross-origin http");
    assert.ok(posts.every((r) => Buffer.byteLength(r.body, "utf8") === Number(r.headers["content-length"])), "content-length mismatch");
    await new Promise((r) => setTimeout(r, 50)); // DELETE 是尽力而为的异步收尾
    assert.ok(recorded.requests.some((r) => r.method === "DELETE"), "session not closed");
    console.log("PASS 1: binary result landed, headers interpolated, SSE parsed, session closed");

    // 场景 1b：嵌入式资源（EmbeddedResource）——blob 落盘、text 资源直回、空资源维持占位
    const out1b = await handler({target: "mcp_mock-srv_embed_resource", args: {}});
    assert.ok(out1b.result.includes("embedded text resource"), `embedded text passthrough missing: ${JSON.stringify(out1b)}`);
    assert.ok(out1b.result.includes("assets/mcp/"), `embedded blob landed path missing: ${JSON.stringify(out1b)}`);
    assert.ok(!out1b.result.includes(PNG_B64.slice(0, 40)), "embedded blob base64 leaked into result");
    assert.ok(out1b.result.includes("[unsupported content item 2"), "empty resource should stay stubbed");
    assert.equal(out1b.structuredContent.files[0].mimeType, "image/png");
    assert.equal(out1b.structuredContent.files[0].bytes, PNG_BYTES.length);
    assert.equal(out1b.structuredContent.files[0].uri, "mem://pic.png");
    assert.match(recorded.upload.files[0].name, /^mock-srv_embed_resource_0.*\.png$/);
    console.log("PASS 1b: embedded resource blob lands, text resource passes through");

    // 场景 2：OAuth 401 挑战 → 定向报错指原生工具
    const out2 = await handler({target: "mcp_mock-srv_oauth_guard", args: {}});
    assert.ok(out2.error && out2.error.includes("mcp_mock-srv_oauth_guard"), `oauth hint missing: ${JSON.stringify(out2)}`);
    assert.ok(out2.error.includes("OAuth"));
    console.log("PASS 2: OAuth short-circuit points to native tool");

    // 场景 3：{{file2b64.…}} 占位符展开（整值替换 + 子串嵌入代码 + 嵌套结构递归 + 裸文件名时间戳模糊匹配）
    recorded.readDirs.length = 0;
    recorded.gets.length = 0;
    const out3 = await handler({
        target: "mcp_mock-srv_upload_receiver",
        args: {
            note: "hi",
            file_b64: "{{file2b64.assets/mcp/pic.png}}",
            code: `with open("a.png","wb") as f: f.write(base64.b64decode("{{file2b64.pic.png}}"))`,
            nested: {inner: ["untouched", "{{file2b64.pic.png}}"]},
        },
    });
    assert.equal(out3.result, "received");
    const B64 = Buffer.from([1, 2, 3, 4, 5]).toString("base64");
    assert.equal(recorded.uploadArgs.file_b64, B64, "whole-value placeholder must become pure base64");
    assert.equal(recorded.uploadArgs.note, "hi", "placeholder-free values pass through");
    assert.equal(recorded.uploadArgs.code, `with open("a.png","wb") as f: f.write(base64.b64decode("${B64}"))`,
        "substring placeholder must embed base64 in place");
    assert.equal(recorded.uploadArgs.nested.inner[0], "untouched");
    assert.equal(recorded.uploadArgs.nested.inner[1], B64, "expansion must recurse into nested objects/arrays");
    assert.ok(recorded.readDirs[0].includes("assets"), `readDir path: ${recorded.readDirs[0]}`);
    assert.equal(recorded.gets.length, 3, "each occurrence reads the file");
    assert.ok(recorded.gets.every((p) => p.endsWith("pic-20260921120000-abc123.png")), `getFile path: ${recorded.gets[0]}`);
    console.log("PASS 3: {{file2b64.…}} expands whole-value, in-code and nested, fuzzy path match");

    // 场景 3b：占位符路径不可解析 / 写法错误 → 硬报错，调用不发出
    const out3a = await handler({target: "mcp_mock-srv_upload_receiver", args: {f: "{{file2b64.nope.png}}"}});
    assert.ok(out3a.error && out3a.error.includes("nope.png"), `unresolved placeholder must hard-error: ${JSON.stringify(out3a)}`);
    const out3b = await handler({target: "mcp_mock-srv_upload_receiver", args: {f: "{{file2b64}}"}});
    assert.ok(out3b.error && out3b.error.includes("file2b64"), `malformed placeholder must hard-error: ${JSON.stringify(out3b)}`);
    assert.equal(recorded.uploadArgs.note, "hi", "failed expansions must not reach the server");
    console.log("PASS 3b: unresolved/malformed placeholder hard-errors before dispatch");

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

    // 场景 6：显式 server 名大小写宽容 + SSE 流不关闭时主动断流
    const out6a = await handler({server: "MOCK-SRV", tool: "echo_text", args: {}});
    assert.ok(out6a.result && out6a.result.includes("kernel ok"), `case-insensitive server match failed: ${JSON.stringify(out6a)}`);
    const out6 = await handler({target: "mcp_mock-srv_hang_sse", args: {}});
    assert.equal(out6.result, "hung then closed");
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(recorded.hangClosed, "client did not close the hanging SSE stream");
    console.log("PASS 6: case-insensitive server match + hanging SSE stream closed early");

    // 场景 7：浏览器/移动端（无 Node 集成）→ 跨源请求经内核 /api/network/forwardProxy 代发
    const savedRequire = window.require;
    window.require = undefined;
    const nodeCallsBefore = nodeTransportCalls;
    recorded.requests.length = 0;
    relayCalls = 0;
    try {
        const out7 = await handler({target: "mcp_mock-srv_echo_binary", args: {q: 2}});
        assert.ok(out7.result.includes("rendered ok"), `relay result: ${JSON.stringify(out7)}`);
        assert.ok(out7.result.includes("assets/mcp/"), "relay landed path missing");
        assert.equal(recorded.upload.dir, "assets/mcp", "relay upload missing");
        assert.ok(relayCalls >= 3, `relay call count: ${relayCalls}`); // initialize + notification + tools/call
        assert.equal(nodeTransportCalls, nodeCallsBefore, "node transport must not run without require");
        const posts7 = recorded.requests.filter((r) => r.method === "POST");
        assert.ok(posts7.length >= 3, "relay posts missing");
        assert.ok(posts7.every((r) => r.headers.accept === "application/json, text/event-stream"),
            "relay Accept must be spec-compliant dual (JSON-only gets 406 from strict gateways)");
        assert.equal(posts7[0].headers.authorization, "Bearer sekret", "relay auth header missing");
        assert.ok(posts7.every((r) => Buffer.byteLength(r.body, "utf8") === Number(r.headers["content-length"])),
            "relay content-length mismatch");
        await new Promise((r) => setTimeout(r, 50));
        assert.ok(recorded.requests.some((r) => r.method === "DELETE"), "relay session close missing");
        assert.ok(relayCalls >= 4, "relay DELETE missing");
        console.log("PASS 7: browser env relays via kernel forwardProxy (spec dual Accept, binary still lands)");
    } finally {
        window.require = savedRequire;
    }

    console.log("\nALL SMOKE TESTS PASSED");
} finally {
    await new Promise((r) => mock.close(r));
}
