"use strict";
// lib/trade-guards.js — 실주문前の 순수 검증. 브라우저 번들 없이 node/Vercel 양쪽에서 require한다.
// 원칙: 기본은 관망·모의. live 플래그가 명시되지 않으면 어떤 경로로도 MEXC에 주문이 나가지 않는다.
const CAPS = Object.freeze({
    maxLeverage: 10,          // 격리 최대 레버리지. 스크린샷의 25X는 허용하지 않는다
    maxNotionalUsdt: 300,     // 주문당 최대 명목가. 최초 운용 상한
    minNotionalUsdt: 5,       // dust 주문 차단
    allowedTypes: [1, 5],     // 1 지정가, 5 시장가만. 조건부·플랜 주문은 v1 제외
    allowedSides: [1, 2, 3, 4], // 1 롱진입 2 숏청산 3 숏진입 4 롱청산
    isolatedOnly: 1,          // openType=1 격리 강제. 교차는 서버에서 거부
    idempotencyPattern: /^[A-Za-z0-9-]{8,72}$/,
    symbolPattern: /^[A-Z0-9]{1,20}_[A-Z0-9]{2,10}$/,
});
const num = v => (typeof v === "number" || typeof v === "string") && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null;

// detail 엔드포인트의 contractSize로 계약vol을 USDT 명목가로 환산한다.
function notionalUsdt(price, vol, contractSize) {
    const p = num(price), v = num(vol), c = num(contractSize);
    if (!(p > 0) || !(v > 0) || !(c > 0)) return null;
    return p * v * c;
}

function validateIntent(intent, quote) {
    // intent: {symbol, side, type, price?, vol, leverage, idempotencyKey, stopLossPrice?, takeProfitPrice?}
    // quote: {lastPrice, contractSize} — 서버가 MEXC에서 직접 조회한 값만 사용한다
    if (!intent || typeof intent !== "object") throw new Error("INTENT_REQUIRED");
    const symbol = String(intent.symbol || "").toUpperCase();
    if (!CAPS.symbolPattern.test(symbol)) throw new Error("BAD_SYMBOL");
    const side = Number(intent.side), type = Number(intent.type);
    if (!CAPS.allowedSides.includes(side)) throw new Error("BAD_SIDE");
    if (!CAPS.allowedTypes.includes(type)) throw new Error("BAD_TYPE");
    const leverage = Number(intent.leverage);
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > CAPS.maxLeverage) throw new Error("BAD_LEVERAGE");
    const vol = num(intent.vol);
    if (!(vol > 0)) throw new Error("BAD_VOL");
    const key = String(intent.idempotencyKey || "");
    if (!CAPS.idempotencyPattern.test(key)) throw new Error("BAD_IDEMPOTENCY_KEY");

    const refPrice = num(quote && quote.lastPrice);
    if (!(refPrice > 0)) throw new Error("NO_QUOTE");
    // 지정가는 현재가 ±10% 밴드를 벗어나면 거부. 자릿수 실수·조작 주문 차단
    let price = null;
    if (type === 1) {
        price = num(intent.price);
        if (!(price > 0)) throw new Error("BAD_PRICE");
        if (Math.abs(price - refPrice) / refPrice > 0.10) throw new Error("PRICE_OUT_OF_BAND");
    } else {
        price = refPrice;
    }
    const contractSize = num(quote && quote.contractSize);
    const notional = notionalUsdt(price, vol, contractSize);
    if (notional === null) throw new Error("NO_CONTRACT_SIZE");
    if (notional < CAPS.minNotionalUsdt) throw new Error("NOTIONAL_TOO_SMALL");
    if (notional > CAPS.maxNotionalUsdt) throw new Error("NOTIONAL_TOO_LARGE");

    const sl = intent.stopLossPrice === undefined || intent.stopLossPrice === null || intent.stopLossPrice === "" ? null : num(intent.stopLossPrice);
    const tp = intent.takeProfitPrice === undefined || intent.takeProfitPrice === null || intent.takeProfitPrice === "" ? null : num(intent.takeProfitPrice);
    if ((intent.stopLossPrice !== undefined && intent.stopLossPrice !== null && intent.stopLossPrice !== "" && sl === null) ||
        (intent.takeProfitPrice !== undefined && intent.takeProfitPrice !== null && intent.takeProfitPrice !== "" && tp === null)) {
        throw new Error("BAD_TPSL");
    }
    // 손절은 진입 불리 방향에만. 롱 진입(side 1): sl < price, tp > price. 숏 진입(side 3): 반대
    if (side === 1) {
        if (sl !== null && !(sl < price)) throw new Error("SL_WRONG_SIDE");
        if (tp !== null && !(tp > price)) throw new Error("TP_WRONG_SIDE");
    } else if (side === 3) {
        if (sl !== null && !(sl > price)) throw new Error("SL_WRONG_SIDE");
        if (tp !== null && !(tp < price)) throw new Error("TP_WRONG_SIDE");
    }

    const body = { symbol, price, vol, side, type, openType: CAPS.isolatedOnly, leverage,
        externalOid: "KRTA-" + key.slice(0, 64) };
    if (sl !== null) body.stopLossPrice = sl;
    if (tp !== null) body.takeProfitPrice = tp;
    return { order: body, notional: Math.round(notional * 100) / 100, refPrice };
}

function validateCancel(orderIds) {
    if (!Array.isArray(orderIds) || !orderIds.length || orderIds.length > 20) throw new Error("BAD_ORDER_IDS");
    const clean = orderIds.map(v => String(v));
    if (clean.some(v => !/^[0-9]{1,32}$/.test(v))) throw new Error("BAD_ORDER_IDS");
    return { orderIds: clean };
}

module.exports = { CAPS, notionalUsdt, validateIntent, validateCancel };
