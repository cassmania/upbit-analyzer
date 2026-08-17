const assert = require("assert");
const C = require("./candle_utils.js");

let passed = 0;
function test(name, fn) {
    fn();
    passed++;
    console.log("  OK  " + name);
}

console.log("\n[캔들 시간축·완료봉]");

test("업비트 timestamp가 아니라 candle_date_time_utc를 시작 시각으로 쓴다", () => {
    const raw = [{
        timestamp: Date.parse("2026-08-17T01:59:59Z"),
        candle_date_time_utc: "2026-08-17T01:00:00",
        candle_date_time_kst: "2026-08-17T10:00:00",
        opening_price: 100, high_price: 110, low_price: 90,
        trade_price: 105, candle_acc_trade_volume: 12
    }];
    const out = C.fromUpbit(raw, "1h", 3600, Date.parse("2026-08-17T02:00:00Z"));
    assert.strictEqual(out[0].time, Date.parse("2026-08-17T01:00:00Z") / 1000);
    assert.strictEqual(out[0].closed, true);
});

test("진행 중인 업비트 봉은 완료봉 목록에서 제외한다", () => {
    const raw = [{
        candle_date_time_utc: "2026-08-17T01:00:00",
        opening_price: 100, high_price: 110, low_price: 90,
        trade_price: 105, candle_acc_trade_volume: 12
    }];
    const out = C.fromUpbit(raw, "1h", 3600, Date.parse("2026-08-17T01:30:00Z"));
    assert.strictEqual(out[0].closed, false);
    assert.strictEqual(C.completed(out).length, 0);
});

test("월봉 종료는 고정 30일이 아니라 다음 UTC 월초다", () => {
    const open = Date.parse("2026-02-01T00:00:00Z") / 1000;
    assert.strictEqual(C.closeTimeSeconds(open, "1M", 2592000), Date.parse("2026-03-01T00:00:00Z") / 1000);
});

test("바이낸스 close time으로 완료 여부를 판정한다", () => {
    const raw = [[Date.parse("2026-08-17T00:00:00Z"), "1", "2", "0.5", "1.5", "10", Date.parse("2026-08-17T00:59:59.999Z")]];
    const done = C.fromBinance(raw, "1h", 3600, Date.parse("2026-08-17T01:00:00Z"));
    assert.strictEqual(done[0].closed, true);
});

test("합성봉은 구성 봉 n개가 모두 완료돼야 완료다", () => {
    const start = Date.parse("2026-08-17T00:00:00Z") / 1000;
    const src = [0, 1, 2].map(i => ({
        time: start + i * 14400, o: 100 + i, h: 110 + i, l: 90 + i,
        c: 105 + i, v: 10, closed: true
    }));
    const grouped = C.group(src, 3, 14400, Date.parse("2026-08-17T12:00:00Z"));
    assert.strictEqual(grouped.length, 1);
    assert.strictEqual(grouped[0].parts, 3);
    assert.strictEqual(grouped[0].closed, true);
});

test("구성 봉이 빠진 합성봉은 분석 완료봉으로 인정하지 않는다", () => {
    const start = Date.parse("2026-08-17T00:00:00Z") / 1000;
    const src = [0, 1].map(i => ({
        time: start + i * 14400, o: 100, h: 110, l: 90, c: 105, v: 10, closed: true
    }));
    const grouped = C.group(src, 3, 14400, Date.parse("2026-08-17T12:00:00Z"));
    assert.strictEqual(grouped[0].closed, false);
    assert.strictEqual(C.completed(grouped).length, 0);
});

test("빗썸 티커는 잘못된 epoch보다 KST 날짜·시각을 우선한다", () => {
    const ms = C.tickerTimeMs({
        timestamp: Date.parse("2026-08-17T12:08:00Z"),
        trade_date_kst: "20260817",
        trade_time_kst: "120800"
    });
    assert.strictEqual(ms, Date.parse("2026-08-17T12:08:00+09:00"));
});

console.log("\n총 " + passed + "개 검증 통과");
