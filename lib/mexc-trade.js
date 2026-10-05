"use strict";
// lib/mexc-trade.js — MEXC 선물 비공개 POST (주문 생성·취소 전용).
// GET 조회는 lib/mexc-account.js를 쓴다. 서명은 선물 문서 규칙을 따른다:
// POST는 JSON 본문 그대로(정렬 불필요)로 accessKey + reqTime + body를 HMAC-SHA256.
const crypto = require("node:crypto");
const { PrivateError } = require("./private-security");
const ORIGIN = "https://api.mexc.com";
const POST_ALLOW = new Set(["/api/v1/private/order/create", "/api/v1/private/order/cancel"]);

function validateTradeCredentials(input) {
    if (!input || !/^[A-Za-z0-9_-]{10,200}$/.test(input.apiKey || "") ||
        !/^[A-Za-z0-9_-]{10,200}$/.test(input.secret || "")) throw new PrivateError(400, "INVALID_KEY");
    return { apiKey: input.apiKey, secret: input.secret };
}

function signedPost(path, body, credentials, now = Date.now()) {
    const keys = validateTradeCredentials(credentials);
    if (!POST_ALLOW.has(path)) throw new PrivateError(400, "PATH_DENIED");
    const text = JSON.stringify(body || {});
    if (Buffer.byteLength(text) > 4096) throw new PrivateError(400, "INTENT_TOO_LARGE");
    const reqTime = String(now);
    const signature = crypto.createHmac("sha256", keys.secret).update(keys.apiKey + reqTime + text).digest("hex");
    return { url: ORIGIN + path, headers: { ApiKey: keys.apiKey, "Request-Time": reqTime, Signature: signature,
        "Recv-Window": "10", "Content-Type": "application/json", Accept: "application/json" }, text };
}

async function post(path, body, credentials) {
    const signed = signedPost(path, body, credentials);
    let response, data;
    try {
        response = await fetch(signed.url, { method: "POST", headers: signed.headers, body: signed.text,
            redirect: "error", signal: AbortSignal.timeout(10000), cache: "no-store" });
    } catch { throw new PrivateError(502, "MEXC_UNAVAILABLE"); }
    if (response.status === 429) throw new PrivateError(429, "MEXC_RATE_LIMITED");
    if ([401, 403, 451].includes(response.status)) throw new PrivateError(502, "MEXC_ACCESS_DENIED");
    try { data = await response.json(); } catch { throw new PrivateError(502, "MEXC_RESPONSE_INVALID"); }
    if (!response.ok || data.success !== true || Number(data.code) !== 0) {
        // 잔고 부족·권한 없음은 원문 노출 없이 내부 코드로만 전달한다
        throw new PrivateError(502, "MEXC_ORDER_FAILED");
    }
    return data.data;
}

module.exports = { validateTradeCredentials, signedPost, post, POST_ALLOW };
