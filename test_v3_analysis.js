/** v3_analysis.js 회귀 검증. 실행: node test_v3_analysis.js */
const assert = require("assert");
const TA = require("./ta_engine.js");
const V3 = require("./v3_analysis.js");

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log("  OK  " + name); }
    catch (error) { console.error("  FAIL " + name + "\n       " + error.message); process.exitCode = 1; }
}

function candles(values) {
    return values.map(function (close, index) {
        const open = index ? values[index - 1] : close;
        return {
            time: 1700000000 + index * 14400,
            o: open,
            h: Math.max(open, close) + 0.4,
            l: Math.min(open, close) - 0.4,
            c: close,
            v: 100
        };
    });
}

console.log("\n[V3.1 분석 프로토콜]");

test("좌우 5봉이 있어야 피벗을 확정한다", function () {
    const values = [10,11,12,13,14,15,16,17,30,17,16,15,14,13,12,11,10,9,8,7,1,7,8,9,10,11,12,13,14,15,16];
    // 피벗 정의만 검증하므로 이전 종가를 시가로 이어 붙여 같은 고가·저가가
    // 생기지 않게 각 봉의 몸통을 독립적으로 만든다.
    const pivotCandles = values.map(function (value, index) {
        return { time: index, o: value, h: value + 0.4, l: value - 0.4, c: value, v: 100 };
    });
    const pivots = V3.confirmedPivots(pivotCandles, 5);
    assert.ok(pivots.some(function (p) { return p.type === "high" && p.index === 8; }));
    assert.ok(pivots.some(function (p) { return p.type === "low" && p.index === 20; }));
    assert.ok(pivots.every(function (p) { return p.confirmedAt === p.index + 5; }));
});

test("상승·하락 FVG와 메움 상태를 기계적으로 계산한다", function () {
    const input = [
        { time: 1, o: 100, h: 101, l: 99, c: 100, v: 100 },
        { time: 2, o: 100, h: 104, l: 100, c: 103, v: 100 },
        { time: 3, o: 104, h: 107, l: 103, c: 106, v: 100 },
        { time: 4, o: 106, h: 108, l: 102, c: 103, v: 100 }
    ];
    const gaps = V3.fairValueGaps(input);
    assert.ok(gaps.some(function (g) { return g.type === "bullish" && g.lower === 101 && g.upper === 103; }));
    assert.ok(gaps.some(function (g) { return g.type === "bullish" && g.filled_pct > 0; }));
});

test("피보나치는 가장 최근 확정 스윙의 방향을 보존한다", function () {
    const input = candles(new Array(30).fill(100));
    const pivots = [
        { type: "low", index: 5, time: input[5].time, price: 80 },
        { type: "high", index: 20, time: input[20].time, price: 120 }
    ];
    const fib = V3.fibonacci(input, pivots);
    assert.strictEqual(fib.direction, "상승 스윙 되돌림");
    assert.strictEqual(fib.levels["0.5"], 100);
    assert.ok(fib.levels["0.618"] < fib.levels["0.382"]);
});

test("BOS 직전 반대색 봉을 오더블록 후보로 연결한다", function () {
    const input = candles(new Array(36).fill(100));
    input[10] = { time: input[10].time, o: 103, h: 105, l: 102, c: 104, v: 100 };
    for (let i = 11; i <= 17; i++) input[i] = { time: input[i].time, o: 101, h: 103, l: 99.5, c: 101, v: 100 };
    input[18] = { time: input[18].time, o: 102, h: 102.5, l: 99, c: 100, v: 100 };
    input[19] = { time: input[19].time, o: 100, h: 109, l: 99.5, c: 108, v: 500 };
    const pivots = V3.confirmedPivots(input, 5);
    const result = V3.structure(input, pivots, TA);
    assert.ok(result.bos.some(function (b) { return b.type === "bullish"; }), JSON.stringify(result));
    assert.ok(result.order_blocks.some(function (b) { return b.type === "bullish" && b.lower === 99; }), JSON.stringify(result));
});

test("analyze는 호출마다 전달된 종목 봉만 사용한다", function () {
    const rising = candles(Array.from({ length: 80 }, function (_, i) { return 100 + i + Math.sin(i / 3) * 3; }));
    const falling = candles(Array.from({ length: 80 }, function (_, i) { return 300 - i + Math.sin(i / 4) * 2; }));
    const first = V3.analyze({ "4h": rising }, TA);
    const second = V3.analyze({ "4h": falling }, TA);
    assert.strictEqual(first.primary_tf, "4h");
    assert.strictEqual(second.primary_tf, "4h");
    assert.notStrictEqual(JSON.stringify(first), JSON.stringify(second));
});

test("데이터가 부족하면 구조 수치를 만들지 않는다", function () {
    const result = V3.analyze({ "4h": candles([1, 2, 3]) }, TA);
    assert.ok(result.error);
    assert.strictEqual(result.frames["4h"].regime, "표본 부족");
});

console.log("\n총 " + passed + "개 검증 통과" + (process.exitCode ? " (실패 있음)" : "") + "\n");
