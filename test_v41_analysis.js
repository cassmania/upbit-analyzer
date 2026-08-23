/** v41_analysis.js 회귀 검증. 실행: node test_v41_analysis.js */
const assert = require("assert");
const TA = require("./ta_engine.js");
const V41 = require("./v41_analysis.js");

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log("  OK  " + name); }
    catch (error) { console.error("  FAIL " + name + "\n       " + error.message); process.exitCode = 1; }
}

function candles(length, falling) {
    return Array.from({ length: length }, function (_, index) {
        const value = falling ? 300 - index : 100 + index;
        return {
            time: 1700000000 + index * 14400,
            o: value - 0.2,
            h: value + 0.8,
            l: value - 0.8,
            c: value + 0.2,
            v: 100 + index
        };
    });
}

console.log("\n[V4.1 분석 프로토콜]");

test("V4.1 버전과 프로토콜을 표시한다", function () {
    const result = V41.analyze({ "4h": candles(80) }, TA);
    assert.strictEqual(V41.VERSION, "4.1.0");
    assert.strictEqual(result.version, "4.1.0");
    assert.strictEqual(result.protocol, "crypto-master-analyst V4.1");
});

test("모멘텀 중복 방지 규칙과 근거 우선순위를 제공한다", function () {
    const result = V41.analyze({ "4h": candles(80) }, TA);
    assert.ok(result.evidence_groups.momentum_rule.includes("중복"));
    assert.deepStrictEqual(result.evidence_groups.priority.slice(0, 2), ["가격 구조", "거래량·유동성"]);
});

test("검증할 수 없는 데이터의 상태를 숫자 대신 표시한다", function () {
    const status = V41.availability();
    assert.strictEqual(status.liquidation_cvd, "현재 실시간 데이터 확인 불가");
    assert.strictEqual(status.onchain_whale, "현재 실시간 데이터 확인 불가");
    assert.strictEqual(status.news_unlock, "현재 실시간 데이터 확인 불가");
});

test("호출마다 전달된 종목 데이터만 사용한다", function () {
    const rising = V41.analyze({ "4h": candles(80, false) }, TA);
    const falling = V41.analyze({ "4h": candles(80, true) }, TA);
    assert.notStrictEqual(JSON.stringify(rising), JSON.stringify(falling));
});

console.log("\n총 " + passed + "개 검증 통과" + (process.exitCode ? " (실패 있음)" : "") + "\n");
