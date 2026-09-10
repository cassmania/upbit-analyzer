"use strict";
const http = require("node:http"), fs = require("node:fs"), path = require("node:path");
const F = require("./private-fixture");
const mock = process.argv.includes("--mock");
if (mock) { F.configure(); global.fetch = F.fixture().fetch; }
const routes = { "/api/private/session": require("../api/private/session"), "/api/private/mexc": require("../api/private/mexc") };
const root = path.resolve(__dirname, "../public");
http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost:4177");
    if (routes[url.pathname]) {
        let body = ""; for await (const chunk of req) { body += chunk; if (body.length > 8192) { res.writeHead(413).end(); return; } }
        req.body = body; res.status = code => { res.statusCode = code; return res; };
        res.json = data => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); return res; };
        await routes[url.pathname](req, res); return;
    }
    const file = path.resolve(root, "." + (url.pathname === "/" ? "/index.html" : url.pathname));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
    res.setHeader("Content-Type", types[path.extname(file)] || "text/plain"); res.end(fs.readFileSync(file));
}).listen(4177, "127.0.0.1", () => console.log(mock ? "테스트 전용 가상 계정 서버: http://localhost:4177" : "미설정 차단 검증 서버: http://localhost:4177"));
