"use strict";

/**
 * Netlify Functions 로컬 시뮬레이터.
 *
 * 실제 netlify dev 는 인증/사이트 연결이 필요할 수 있으므로, 정적 파일 제공 +
 * /api/* → Functions 핸들러 매핑을 직접 구현해 브라우저 검증을 수행한다.
 * Netlify 배포 전 라우팅·헤더·쿠키 동작을 확인하는 데만 사용한다.
 */

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "public");
const funcsDir = path.join(root, "netlify", "functions");

const PORT = Number(process.env.PORT || "8899");

// 개인 API 테스트용 더미 환경변수(실제 Supabase 는 연결되지 않음)
process.env.NODE_ENV = "development";
process.env.PRIVATE_APP_ORIGIN = `http://localhost:${PORT}`;
process.env.PRIVATE_SUPABASE_URL = "https://local.supabase.co";
process.env.PRIVATE_SUPABASE_ANON_KEY = "dummy-anon-key";
process.env.PRIVATE_OWNER_ID = "00000000-0000-0000-0000-000000000000";
process.env.PRIVATE_OWNER_EMAIL = "owner@example.com";
process.env.PRIVATE_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000000";

const funcs = {
    "/api/upbit": require(path.join(funcsDir, "upbit.js")).handler,
    "/api/mexc": require(path.join(funcsDir, "mexc.js")).handler,
    "/api/mexc-futures": require(path.join(funcsDir, "mexc-futures.js")).handler,
    "/api/coingecko": require(path.join(funcsDir, "coingecko.js")).handler,
    "/api/evidence": require(path.join(funcsDir, "evidence.js")).handler,
    "/api/private/session": require(path.join(funcsDir, "private-session.js")).handler,
    "/api/private/mexc": require(path.join(funcsDir, "private-mexc.js")).handler,
    "/api/private/trade": require(path.join(funcsDir, "private-trade.js")).handler
};

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf"
};

function urlSafe(name) {
    // 경로 순회 방지: .. 제거, basename 만 허용
    const parts = name.split("/").filter(Boolean);
    return parts.join("/");
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", chunk => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

function netlifyEvent(req, bodyBuffer) {
    const rawQuery = req.url.split("?", 2)[1] || "";
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
        headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    return {
        httpMethod: req.method,
        path: req.url.split("?", 1)[0] || "/",
        rawUrl: req.url,
        rawQuery,
        headers,
        body: bodyBuffer.length > 0 ? bodyBuffer.toString("utf8") : null,
        isBase64Encoded: false
    };
}

async function serveStatic(req, res) {
    let rel = urlSafe(req.url.split("?", 1)[0]);
    if (!rel || rel === "/") rel = "index.html";
    const full = path.join(publicDir, rel);
    try {
        const stat = await fs.promises.stat(full);
        if (!stat.isFile()) throw new Error("not file");
        const ext = path.extname(rel).toLowerCase();
        const ctype = MIME[ext] || "application/octet-stream";
        res.setHeader("Content-Type", ctype);
        res.setHeader("Cache-Control", "no-store");
        const stream = fs.createReadStream(full);
        stream.on("error", () => {
            if (!res.headersSent) res.writeHead(500).end("internal error");
        });
        stream.pipe(res);
    } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found\n");
    }
}

function corsHeaders(req) {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
        "Access-Control-Allow-Headers": "Content-Type, X-Private-Request, Cookie"
    };
}

async function handleApi(req, res, bodyBuffer) {
    const apiPath = req.url.split("?", 1)[0];
    const handler = funcs[apiPath];
    if (!handler) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "NOT_FOUND" }));
        return;
    }

    const event = netlifyEvent(req, bodyBuffer);
    let result;
    try {
        result = await handler(event);
    } catch (error) {
        console.error("[api]", apiPath, "handler error:", error.message);
        res.writeHead(500, corsHeaders(req));
        res.end(JSON.stringify({ error: "REQUEST_FAILED" }));
        return;
    }

    const statusCode = result.statusCode || 200;
    const outHeaders = { ...corsHeaders(req), ...(result.headers || {}) };
    if (result.multiValueHeaders) {
        for (const [k, v] of Object.entries(result.multiValueHeaders)) {
            if (k.toLowerCase() === "set-cookie") {
                outHeaders["set-cookie"] = Array.isArray(v) ? v.join("\n") : String(v);
            }
        }
    }
    res.writeHead(statusCode, outHeaders);
    res.end(result.body || "");
}

async function onRequest(req, res) {
    const started = Date.now();
    const apiPath = req.url.split("?", 1)[0];
    if (apiPath.startsWith("/api/")) {
        try {
            const body = await readBody(req);
            await handleApi(req, res, body);
        } catch (error) {
            if (!res.headersSent) res.writeHead(500).end("internal error");
        }
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} → api`);
        return;
    }
    await serveStatic(req, res);
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} → static`);
}

const server = http.createServer(onRequest);
server.listen(PORT, "localhost", () => {
    console.log(`넷릴리 시뮬레이터 http://localhost:${PORT}/`);
});

process.on("unhandledRejection", error => {
    console.error("unhandledRejection:", error);
});
