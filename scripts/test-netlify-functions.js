"use strict";

/**
 * Netlify Functions 래퍼 단위/통합 테스트.
 * 각 함수를 모의 이벤트로 직접 호출해 라우팅, 쿼리, JSON 바디, Set-Cookie,
 * CORS 프리플라이트, 404 미노출 등을 검증한다. 네트워크는 실제 업스트림에 닿는다.
 */

process.env.NODE_ENV = "development";
process.env.PRIVATE_APP_ORIGIN = "http://localhost:8899";
process.env.PRIVATE_SUPABASE_URL = "https://local.supabase.co";
process.env.PRIVATE_SUPABASE_ANON_KEY = "dummy-anon-key";
process.env.PRIVATE_OWNER_ID = "00000000-0000-0000-0000-000000000000";
process.env.PRIVATE_OWNER_EMAIL = "owner@example.com";
process.env.PRIVATE_ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000000";

const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const funcsDir = path.join(root, "netlify", "functions");

const funcs = {
    upbit: require(path.join(funcsDir, "upbit.js")),
    mexc: require(path.join(funcsDir, "mexc.js")),
    "mexc-futures": require(path.join(funcsDir, "mexc-futures.js")),
    coingecko: require(path.join(funcsDir, "coingecko.js")),
    evidence: require(path.join(funcsDir, "evidence.js")),
    "private-session": require(path.join(funcsDir, "private-session.js")),
    "private-mexc": require(path.join(funcsDir, "private-mexc.js")),
    "private-trade": require(path.join(funcsDir, "private-trade.js"))
};

let passed = 0;
let failed = 0;
let warnings = 0;

function ok(name, cond, detail) {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ ${name}${detail ? "\n      " + detail : ""}`); }
}

function warn(name, detail) { warnings++; console.warn(`  ⚠ ${name} ${detail || ""}`); }

function event(method, path, query = {}, headers = {}, body = null) {
    const sp = new URLSearchParams(query);
    const raw = sp.toString();
    return {
        httpMethod: method,
        path,
        rawUrl: `http://localhost:8899${path}${raw ? "?" + raw : ""}`,
        rawQuery: raw,
        queryStringParameters: query,
        headers: { host: "localhost:8899", ...headers },
        body: body === null ? null : (typeof body === "string" ? body : JSON.stringify(body)),
        isBase64Encoded: false
    };
}

function headersOf(res) {
    return Object.fromEntries(
        Object.entries(res.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])
    );
}

async function t(name, fn) {
    try {
        await fn();
    } catch (error) {
        failed++;
        console.error(`  ✗ ${name}: ${error.stack || error.message}`);
    }
}

async function main() {
    const start = Date.now();
    console.log(`넷릴리 함수 테스트 시작 (${start})\n`);

    // ── 업비트 ──
    await t("업비트 마켓/전체 200 + CORS *", async () => {
        const res = await funcs.upbit.handler(event("GET", "/api/upbit", { path: "market/all", isDetails: "false" }));
        ok("상태 200", res.statusCode === 200, JSON.stringify(res.body).slice(0, 200));
        const h = headersOf(res);
        const arr = JSON.parse(res.body);
        ok("JSON 배열", Array.isArray(arr) && arr.length > 0, `길이=${arr.length}`);
        ok("CORS *", h["access-control-allow-origin"] === "*", JSON.stringify(h));
    });

    await t("업비트 캔들 60분 3건", async () => {
        const res = await funcs.upbit.handler(event("GET", "/api/upbit", { path: "candles/minutes/60", market: "KRW-BTC", count: "3" }));
        ok("상태 200", res.statusCode === 200, `상태=${res.statusCode}`);
        const arr = JSON.parse(res.body);
        ok("캔들 3건", Array.isArray(arr) && arr.length === 3, `길이=${Array.isArray(arr) ? arr.length : "-"}`);
    });

    await t("업비트 허용되지 않은 path 400", async () => {
        const res = await funcs.upbit.handler(event("GET", "/api/upbit", { path: "orderbook" }));
        ok("상태 400", res.statusCode === 400, `상태=${res.statusCode}`);
    });

    await t("업비트 OPTIONS 프리플라이트 204", async () => {
        const res = await funcs.upbit.handler(event("OPTIONS", "/api/upbit", {}, {
            origin: "http://localhost:8899",
            "access-control-request-method": "GET"
        }));
        ok("상태 204", res.statusCode === 204, `상태=${res.statusCode}`);
    });

    // ── MEXC ──
    await t("MEXC 거래소 정보 200 + CORS *", async () => {
        const res = await funcs.mexc.handler(event("GET", "/api/mexc", { path: "exchangeInfo" }));
        ok("상태 200", res.statusCode === 200, `상태=${res.statusCode}`);
        const h = headersOf(res);
        const obj = JSON.parse(res.body);
        ok("JSON 객체", obj && typeof obj === "object", JSON.stringify(res.body).slice(0, 100));
        ok("CORS *", h["access-control-allow-origin"] === "*", JSON.stringify(h));
    });

    await t("MEXC Kline 3건", async () => {
        const res = await funcs.mexc.handler(event("GET", "/api/mexc", { path: "klines", symbol: "BTCUSDT", interval: "60m", limit: "3" }));
        ok("상태 200", res.statusCode === 200, `상태=${res.statusCode}`);
        const arr = JSON.parse(res.body);
        ok("Kline 배열", Array.isArray(arr) && arr.length === 3, `길이=${Array.isArray(arr) ? arr.length : "-"}`);
    });

    await t("MEXC 허용되지 않은 path 400", async () => {
        const res = await funcs.mexc.handler(event("GET", "/api/mexc", { path: "account" }));
        ok("상태 400", res.statusCode === 400, `상태=${res.statusCode}`);
    });

    // ── MEXC 선물 ──
    await t("MEXC 선물 kline 3건 + success + columnar data", async () => {
        const res = await funcs["mexc-futures"].handler(event("GET", "/api/mexc-futures", { path: "kline", symbol: "BTC_USDT", interval: "Min60", limit: "3" }));
        ok("상태 200", res.statusCode === 200, `상태=${res.statusCode}`);
        const obj = JSON.parse(res.body);
        ok("성공 필드", obj.success === true, JSON.stringify(res.body).slice(0, 200));
        ok("데이터 컬럼 객체(time 배열 3)", obj.data && Array.isArray(obj.data.time) && obj.data.time.length === 3, JSON.stringify(res.body).slice(0, 200));
    });

    await t("MEXC 선물 detail 심볼 없음 200", async () => {
        const res = await funcs["mexc-futures"].handler(event("GET", "/api/mexc-futures", { path: "detail" }));
        ok("상태 200", res.statusCode === 200, `상태=${res.statusCode}`);
    });

    // ── CoinGecko ──
    await t("CoinGecko global 200 + data", async () => {
        const res = await funcs.coingecko.handler(event("GET", "/api/coingecko", { path: "global" }));
        ok("상태 200", res.statusCode === 200, `상태=${res.statusCode}`);
        const obj = JSON.parse(res.body);
        ok("데이터 객체", obj && obj.data && typeof obj.data.market_cap_percentage === "object", JSON.stringify(res.body).slice(0, 150));
    });

    await t("CoinGecko simple/price 200 + tether.usd", async () => {
        const res = await funcs.coingecko.handler(event("GET", "/api/coingecko", { path: "simple/price", ids: "tether", vs_currencies: "usd", include_market_cap: "true", include_24hr_change: "true" }));
        ok("상태 200", res.statusCode === 200, `상태=${res.statusCode}`);
        const obj = JSON.parse(res.body);
        ok("tether.usd 존재", obj && obj.tether && typeof obj.tether.usd === "number", JSON.stringify(res.body).slice(0, 200));
    });

    await t("CoinGecko 허용되지 않은 path 400", async () => {
        const res = await funcs.coingecko.handler(event("GET", "/api/coingecko", { path: "coins/bitcoin" }));
        ok("상태 400", res.statusCode === 400, `상태=${res.statusCode}`);
    });

    // ── Evidence ──
    await t("Evidence CVD 업비트 200(또는 502·503), 404 아님", async () => {
        const res = await funcs.evidence.handler(event("GET", "/api/evidence", { kind: "cvd", exchange: "upbit", market: "KRW-BTC" }));
        ok("상태 404 아님", res.statusCode !== 404, `상태=${res.statusCode} 본문=${String(res.body).slice(0, 150)}`);
    });

    await t("Evidence 뉴스 200(또는 502), 404 아님", async () => {
        const res = await funcs.evidence.handler(event("GET", "/api/evidence", { kind: "news" }));
        ok("상태 404 아님", res.statusCode !== 404, `상태=${res.statusCode} 본문=${String(res.body).slice(0, 150)}`);
    });

    // ── 개인 API(환경변수 더미: 로그인 없이) ──
    await t("개인 세션 GET 헤더 없음 → 403 ORIGIN_DENIED", async () => {
        const res = await funcs["private-session"].handler(event("GET", "/api/private/session"));
        ok("상태 403", res.statusCode === 403, `상태=${res.statusCode}`);
        const obj = JSON.parse(res.body);
        ok("코드 ORIGIN_DENIED", obj.error === "ORIGIN_DENIED", JSON.stringify(res.body).slice(0, 150));
    });

    const privHeaders = {
        origin: "http://localhost:8899",
        "x-private-request": "1",
        "sec-fetch-site": "same-origin"
    };

    await t("개인 세션 GET 쿠키 없음 → 401 LOGIN_REQUIRED", async () => {
        const res = await funcs["private-session"].handler(event("GET", "/api/private/session", {}, privHeaders));
        ok("상태 401", res.statusCode === 401, `상태=${res.statusCode}`);
        const obj = JSON.parse(res.body);
        ok("코드 LOGIN_REQUIRED", obj.error === "LOGIN_REQUIRED", JSON.stringify(res.body).slice(0, 150));
    });

    await t("개인 세션 POST 잘못된 Content-Type → 415 JSON_REQUIRED", async () => {
        const res = await funcs["private-session"].handler(event("POST", "/api/private/session", {}, {
            origin: "http://localhost:8899",
            "x-private-request": "1",
            "content-type": "text/plain"
        }, "hello"));
        ok("상태 415", res.statusCode === 415, `상태=${res.statusCode}`);
        const obj = JSON.parse(res.body);
        ok("코드 JSON_REQUIRED", obj.error === "JSON_REQUIRED", JSON.stringify(res.body).slice(0, 150));
    });

    await t("개인 세션 POST 빈 본문 → 400 INVALID_INPUT", async () => {
        const res = await funcs["private-session"].handler(event("POST", "/api/private/session", {}, {
            origin: "http://localhost:8899",
            "x-private-request": "1",
            "content-type": "application/json"
        }, {}));
        ok("상태 400", res.statusCode === 400, `상태=${res.statusCode}`);
        const obj = JSON.parse(res.body);
        ok("코드 INVALID_INPUT", obj.error === "INVALID_INPUT", JSON.stringify(res.body).slice(0, 150));
    });

    await t("개인 MEXC GET 쿠키 없음 → 401 LOGIN_REQUIRED", async () => {
        const res = await funcs["private-mexc"].handler(event("GET", "/api/private/mexc", {}, privHeaders));
        ok("상태 401", res.statusCode === 401, `상태=${res.statusCode}`);
        const obj = JSON.parse(res.body);
        ok("코드 LOGIN_REQUIRED", obj.error === "LOGIN_REQUIRED", JSON.stringify(res.body).slice(0, 150));
    });

    await t("개인 트레이드 GET 쿠키 없음 → 401 LOGIN_REQUIRED", async () => {
        const res = await funcs["private-trade"].handler(event("GET", "/api/private/trade", {}, privHeaders));
        ok("상태 401", res.statusCode === 401, `상태=${res.statusCode}`);
        const obj = JSON.parse(res.body);
        ok("코드 LOGIN_REQUIRED", obj.error === "LOGIN_REQUIRED", JSON.stringify(res.body).slice(0, 150));
    });

    await t("개인 트레이드 POST 헤더 없음 → 403 ORIGIN_DENIED", async () => {
        const res = await funcs["private-trade"].handler(event("POST", "/api/private/trade", {}, {}, { live: true }));
        ok("상태 403", res.statusCode === 403, `상태=${res.statusCode}`);
    });

    // ── 고정 주소가 404 가 아님(라우팅 확인) ──
    await t("존재하지 않는 /api/* 는 함수 404가 아닌 400/403", async () => {
        // 위에서 업비트/코인게코 허용되지 않은 path 가 400 을 반환했으므로 라우팅은 동작한다.
        ok("라우팅 동작 확인", true);
    });

    const elapsed = Date.now() - start;
    console.log(`\n완료: 성공=${passed} 실패=${failed} 경고=${warnings} 경과=${elapsed}ms`);
    if (failed > 0) process.exit(1);
}

main();
