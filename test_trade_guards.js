"use strict";
// test_trade_guards.js — node test_trade_guards.js 로 실행. 외부 호출 없음.
const assert = require("node:assert/strict");
const G = require("./lib/trade-guards");
const quote = { lastPrice: 86500, contractSize: 0.0001 }; // BTC 1계약 명목가 ≈ $8.65

// 정상: 지정가 롱 10계약 ≈ $86.5
let r = G.validateIntent({ symbol: "BTC_USDT", side: 1, type: 1, price: 86500, vol: 10, leverage: 5,
    idempotencyKey: "abc-123-XYZ", stopLossPrice: 86000, takeProfitPrice: 87500 }, quote);
assert.equal(r.order.openType, 1);
assert.equal(r.order.externalOid, "KRTA-abc-123-XYZ");
assert.ok(r.notional > 80 && r.notional < 90, "notional=" + r.notional);

// 시장가는 현재가 기준
r = G.validateIntent({ symbol: "ETH_USDT", side: 3, type: 5, vol: 20, leverage: 3, idempotencyKey: "k-00000001" }, quote);
assert.equal(r.order.price, 86500);

const bad = [
    [{ symbol: "BTCUSDT", side: 1, type: 1, price: 86500, vol: 10, leverage: 5, idempotencyKey: "valid-key-1" }, "BAD_SYMBOL"], // 언더스코어 필수
    [{ symbol: "BTC_USDT", side: 9, type: 1, price: 86500, vol: 10, leverage: 5, idempotencyKey: "valid-key-1" }, "BAD_SIDE"],
    [{ symbol: "BTC_USDT", side: 1, type: 2, price: 86500, vol: 10, leverage: 5, idempotencyKey: "valid-key-1" }, "BAD_TYPE"], // 조건부 차단
    [{ symbol: "BTC_USDT", side: 1, type: 1, price: 86500, vol: 10, leverage: 25, idempotencyKey: "valid-key-1" }, "BAD_LEVERAGE"], // 25X 거부
    [{ symbol: "BTC_USDT", side: 1, type: 1, price: 70000, vol: 10, leverage: 5, idempotencyKey: "valid-key-1" }, "PRICE_OUT_OF_BAND"], // -19%
    [{ symbol: "BTC_USDT", side: 1, type: 1, price: 86500, vol: 100000, leverage: 5, idempotencyKey: "valid-key-1" }, "NOTIONAL_TOO_LARGE"], // ≈$865
    [{ symbol: "BTC_USDT", side: 1, type: 1, price: 86500, vol: 10, leverage: 5, idempotencyKey: "x" }, "BAD_IDEMPOTENCY_KEY"],
    [{ symbol: "BTC_USDT", side: 1, type: 1, price: 86500, vol: 10, leverage: 5, idempotencyKey: "valid-key-1", stopLossPrice: 87000 }, "SL_WRONG_SIDE"],
    [{ symbol: "BTC_USDT", side: 1, type: 1, price: 86500, vol: 10, leverage: 5, idempotencyKey: "valid-key-1", takeProfitPrice: 86000 }, "TP_WRONG_SIDE"],
];
for (const [intent, code] of bad) {
    assert.throws(() => G.validateIntent(intent, quote), new RegExp(code), JSON.stringify(intent));
}
// 시세 없으면 어떤 주문도 나가지 않는다
assert.throws(() => G.validateIntent({ symbol: "BTC_USDT", side: 1, type: 5, vol: 10, leverage: 5, idempotencyKey: "valid-key-1" }, {}), /NO_QUOTE/);

// 취소: 숫자 ID만, 최대 20개
assert.deepEqual(G.validateCancel(["123", "456"]).orderIds, ["123", "456"]);
assert.throws(() => G.validateCancel([]), /BAD_ORDER_IDS/);
assert.throws(() => G.validateCancel(["abc"]), /BAD_ORDER_IDS/);
assert.throws(() => G.validateCancel(new Array(21).fill("1")), /BAD_ORDER_IDS/);

console.log("trade-guards: ALL PASS");
