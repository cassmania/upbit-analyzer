"use strict";
const crypto = require("node:crypto");
const { PrivateError } = require("./private-security");
const ORIGIN = "https://api.mexc.com";
const FUTURES = new Set(["/api/v1/private/account/assets", "/api/v1/private/position/open_positions", "/api/v1/private/order/list/open_orders"]);
const SPOT = new Set(["/api/v3/account", "/api/v3/openOrders"]);

function validateCredentials(input) {
    // 임의 도메인이나 주문 경로는 사용자가 지정할 수 없다.
    if (!input || !/^[A-Za-z0-9_-]{10,200}$/.test(input.apiKey || "") ||
        !/^[A-Za-z0-9_-]{10,200}$/.test(input.secret || "")) throw new PrivateError(400, "INVALID_KEY");
    return { apiKey: input.apiKey, secret: input.secret };
}
function signedRequest(kind, path, credentials, params = {}, now = Date.now()) {
    const keys = validateCredentials(credentials);
    const allowed = kind === "spot" ? SPOT : kind === "futures" ? FUTURES : new Set();
    if (!allowed.has(path)) throw new PrivateError(400, "PATH_DENIED");
    const query = new URLSearchParams();
    Object.keys(params).sort().forEach(key => query.set(key, String(params[key])));
    let headers;
    if (kind === "spot") {
        query.set("recvWindow", "5000");
        query.set("timestamp", String(now));
        const signature = crypto.createHmac("sha256", keys.secret).update(query.toString()).digest("hex");
        query.set("signature", signature);
        headers = { "X-MEXC-APIKEY": keys.apiKey };
    } else {
        const signature = crypto.createHmac("sha256", keys.secret).update(keys.apiKey + now + query.toString()).digest("hex");
        headers = { ApiKey: keys.apiKey, "Request-Time": String(now), Signature: signature, "Recv-Window": "10" };
    }
    return { url: ORIGIN + path + (query.size ? "?" + query : ""), headers };
}
async function request(kind, path, credentials, params) {
    const signed = signedRequest(kind, path, credentials, params);
    let response, data;
    try {
        response = await fetch(signed.url, { method: "GET", headers: { ...signed.headers, Accept: "application/json" },
            redirect: "error", signal: AbortSignal.timeout(10000), cache: "no-store" });
        data = await response.json();
    } catch { throw new PrivateError(502, "MEXC_UNAVAILABLE"); }
    if (response.status === 429) throw new PrivateError(429, "MEXC_RATE_LIMITED");
    if (!response.ok || (kind === "futures" && (data.success !== true || Number(data.code) !== 0)) ||
        (kind === "spot" && Number(data.code) < 0)) throw new PrivateError(502, "MEXC_PERMISSION_OR_REQUEST_FAILED");
    return kind === "futures" ? data.data : data;
}
const numeric = value => (typeof value === "number" || typeof value === "string") && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
const label = value => typeof value === "string" ? value.slice(0, 80) : "";
function array(value) {
    if (!Array.isArray(value)) throw new PrivateError(502, "MEXC_RESPONSE_INVALID");
    return value;
}
function balances(data) {
    return array(data.balances).filter(row => numeric(row.free) > 0 || numeric(row.locked) > 0)
        .map(row => ({ asset: label(row.asset), free: numeric(row.free), locked: numeric(row.locked) }));
}
function assets(data) {
    return array(data).map(row => ({ currency: label(row.currency), equity: numeric(row.equity),
        available: numeric(row.availableBalance), margin: numeric(row.positionMargin), unrealized: numeric(row.unrealized) }));
}
function positions(data) {
    return array(data).filter(row => numeric(row.holdVol) > 0).map(row => ({
        symbol: label(row.symbol), direction: Number(row.positionType) === 1 ? "롱" : Number(row.positionType) === 2 ? "숏" : "미확인",
        mode: Number(row.openType) === 1 ? "격리" : Number(row.openType) === 2 ? "교차" : "미확인",
        contracts: numeric(row.holdVol), entryPrice: numeric(row.holdAvgPriceFullyScale ?? row.holdAvgPrice),
        leverage: numeric(row.leverage), unrealized: numeric(row.unRealizedPnl),
        // 공식 문서상 이 청산가는 격리 모드용이다. 교차 포지션에 그대로 사용하지 않는다.
        liquidationPrice: Number(row.openType) === 1 && numeric(row.liquidatePrice) > 0 ? numeric(row.liquidatePrice) : null,
        marginRatio: numeric(row.marginRatio), updatedAt: numeric(row.updateTime)
    }));
}
function orders(data, kind) {
    return array(data).map(row => ({ symbol: label(row.symbol),
        side: kind === "spot" ? ({ BUY: "매수", SELL: "매도" }[row.side] || "미확인") :
            ({ 1: "롱 진입", 2: "숏 청산", 3: "숏 진입", 4: "롱 청산" }[row.side] || "미확인"),
        price: numeric(row.priceStr ?? row.price), quantity: numeric(kind === "spot" ? row.origQty : row.vol),
        filled: numeric(kind === "spot" ? row.executedQty : row.dealVol), unit: kind === "spot" ? "코인" : "계약",
        status: kind === "spot" ? label(row.status) : ({ 1: "대기", 2: "미체결", 3: "체결", 4: "취소", 5: "무효" }[row.state] || "미확인")
    }));
}
async function snapshot(credentials) {
    // 한 시장의 API 권한이 없어도 나머지 시장의 성공한 조회 결과는 유지한다.
    const jobs = {
        spot: async () => balances(await request("spot", "/api/v3/account", credentials)),
        assets: async () => assets(await request("futures", "/api/v1/private/account/assets", credentials)),
        positions: async () => positions(await request("futures", "/api/v1/private/position/open_positions", credentials)),
        spotOrders: async () => orders(await request("spot", "/api/v3/openOrders", credentials), "spot"),
        futuresOrders: async () => orders(await request("futures", "/api/v1/private/order/list/open_orders", credentials,
            { page_num: 1, page_size: 100 }), "futures")
    };
    const entries = Object.entries(jobs);
    const results = await Promise.allSettled(entries.map(async ([, run]) => ({ rows: await run(), fetchedAt: Date.now() })));
    const sections = {};
    results.forEach((result, i) => {
        sections[entries[i][0]] = result.status === "fulfilled" ? { status: "ok", ...result.value } :
            { status: "error", error: result.reason instanceof PrivateError ? result.reason.code : "MEXC_UNAVAILABLE" };
    });
    return { connected: true, source: "MEXC 공식 계정 API", fetchedAt: Date.now(), sections,
        futuresOrdersPage: 1, futuresOrdersLimit: 100,
        futuresOrdersMayHaveMore: sections.futuresOrders.status === "ok" && sections.futuresOrders.rows.length === 100 };
}
module.exports = { validateCredentials, signedRequest, snapshot, positions, balances, assets, orders };
