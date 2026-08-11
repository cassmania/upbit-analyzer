/**
 * test_level_analyzer.js — 지지·저항 엔진 회귀 테스트
 *
 * 여기 있는 항목은 전부 실제로 화면에 잘못 나왔던 것들이다.
 * 실행: node test_level_analyzer.js
 */
const assert = require("assert");
const LE = require("./level_analyzer.js");

let 통과 = 0, 실패 = 0;
function 검증(이름, fn) {
    try { fn(); console.log("  OK  " + 이름); 통과++; }
    catch (e) { console.log("  X   " + 이름 + "\n      " + e.message); 실패++; }
}

/** 사인파 + 추세로 스윙 피벗이 여러 가격대에 흩어진 캔들 */
function 캔들(n, 시작, 기울기) {
    const out = [];
    for (let i = 0; i < n; i++) {
        const p = 시작 + i * 기울기 + Math.sin(i / 3) * 3;
        out.push({ high: p + 0.5, low: p - 0.5, close: p, volume: 100 });
    }
    return out;
}

console.log("\n[1] 클러스터링");

// 예전에는 앵커를 가중평균으로 옮기며 그 앵커 기준으로 창을 쟀다.
// 앵커가 움직이니 창도 끌려가서, 촘촘히 이어진 레벨이 스캔 순서에 따라 갈라졌다.
검증("촘촘히 이어진 레벨은 한 벽으로 묶인다", () => {
    const all = [
        { price: 100.0, kind: "POC", tf: "1d", label: "POC" },
        { price: 100.2, kind: "스윙", tf: "1h", label: "스윙고점" },
        { price: 100.4, kind: "스윙", tf: "4h", label: "스윙고점" },
        { price: 100.6, kind: "스윙", tf: "1h", label: "스윙고점" }
    ];
    const g = LE.cluster(all, 0.0022);
    assert.strictEqual(g.length, 1, `1개 그룹이어야 하는데 ${g.length}개`);
    assert.strictEqual(g[0].tfCount, 3, "3개 봉이 지목한 벽");
});

검증("실제로 벌어진 구간은 갈라진다", () => {
    const all = [
        { price: 100.0, kind: "POC", tf: "1d", label: "POC" },
        { price: 100.1, kind: "스윙", tf: "1h", label: "스윙고점" },
        { price: 105.0, kind: "스윙", tf: "4h", label: "스윙고점" },
        { price: 105.1, kind: "스윙", tf: "1h", label: "스윙고점" }
    ];
    assert.strictEqual(LE.cluster(all, 0.0022).length, 2);
});

검증("사슬이 무한히 이어져도 그룹 폭에 상한이 있다", () => {
    const all = [];
    for (let i = 0; i < 20; i++) {
        all.push({ price: 100 + i * 0.15, kind: "스윙", tf: "1h", label: "스윙고점" });
    }
    assert.ok(LE.cluster(all, 0.0022).length > 1, "폭 상한이 안 걸림");
});

검증("대표 가격은 무거운 근거 쪽으로 끌린다", () => {
    const all = [
        { price: 100.0, kind: "POC", tf: "1d", label: "POC" },   // 가중 3.0 x 2.0
        { price: 100.2, kind: "피보", tf: "1h", label: "피보 0.5" }  // 가중 0.8 x 1.0
    ];
    const g = LE.cluster(all, 0.0022);
    assert.strictEqual(g.length, 1);
    assert.ok(g[0].price < 100.05, `POC 쪽으로 끌려야 하는데 ${g[0].price}`);
});

console.log("\n[2] 스윙 선정");

// 예전에는 고점 내림차순·저점 오름차순 상위 6개만 남겨서
// 구간 꼭대기와 바닥만 뽑히고 현재가 근처는 통째로 버려졌다.
// 그 결과 현재가 위에 "스윙저점"이 저항으로 뜨는 모순이 화면에 나왔다.
검증("스윙은 현재가 근처에서 뽑힌다", () => {
    const c = 캔들(200, 80, 0.2);          // 대략 79 ~ 122 범위
    const ex = LE.extract(c, "1h", 100);   // 현재가 100
    const sw = ex.levels.filter(x => x.kind === "스윙").map(x => x.price);
    assert.ok(sw.length > 0, "스윙이 없음");
    const 최소거리 = Math.min(...sw.map(p => Math.abs(p - 100)));
    assert.ok(최소거리 < 3, `현재가 근처 스윙이 없음 (가장 가까운 게 ${최소거리.toFixed(1)} 떨어짐)`);
});

검증("현재가를 안 주면 마지막 종가를 기준으로 쓴다", () => {
    const c = 캔들(200, 80, 0.2);
    const ex = LE.extract(c, "1h");
    assert.ok(ex && ex.levels.length > 0);
});

console.log("\n[3] Value Area");

// POC에서 연속 확장해야 한다. 예전처럼 상위 빈만 모아 min/max를 취하면
// 사이의 저거래 구간까지 들어가 VA가 전체 범위만큼 벌어진다.
// vpvr()는 normalize를 거친 {h,l,c,v} 형태를 받는다(extract 내부 규약).
//
// 예전에는 거래량 상위 빈만 모아 min/max를 경계로 썼다. 빈이 떨어져 있으면
// 사이의 저거래 구간까지 통째로 들어가, 거래량이 한 곳에 몰린 정상적인
// 분포에서도 VA가 전체 범위로 벌어졌다.
검증("거래량이 한 곳에 몰리면 VA는 그 구간으로 좁혀진다", () => {
    const c = [];
    for (let i = 0; i < 200; i++) {
        const p = 100 + Math.sin(i / 7) * 15;          // 85 ~ 115 범위
        const 몰린곳 = p > 108 && p < 114;
        c.push({ h: p + 0.5, l: p - 0.5, c: p, v: 몰린곳 ? 500 : 20 });
    }
    const p = LE.vpvr(c, 24);
    assert.ok(p, "vpvr null");
    assert.ok(p.val <= p.poc && p.poc <= p.vah, "VAL <= POC <= VAH");
    assert.ok(p.vah - p.val < (p.high - p.low) * 0.5,
        `VA ${(p.vah - p.val).toFixed(1)}가 전체 범위 ${(p.high - p.low).toFixed(1)} 대비 너무 넓음`);
    assert.ok(p.poc > 107 && p.poc < 115, `POC ${p.poc.toFixed(1)}가 거래량 몰린 구간 밖`);
});

// 반대로 양극단에 반반씩 몰린 분포에서는 70%를 채우려면 가운데를 지날 수밖에 없다.
// 이때 VA가 넓어지는 건 정상이다 — 연속 확장의 당연한 귀결.
검증("양봉 분포에서는 VA가 넓어지는 게 정상", () => {
    const c = [];
    for (let i = 0; i < 100; i++) {
        const p = 100 + (i % 2 === 0 ? 0 : 30);
        c.push({ h: p + 0.5, l: p - 0.5, c: p, v: 100 });
    }
    const p = LE.vpvr(c, 24);
    assert.ok(p.val <= p.poc && p.poc <= p.vah, "VAL <= POC <= VAH");
});

console.log("\n[4] analyze 통합");

검증("현재가 위는 저항, 아래는 지지로 갈린다", () => {
    const tf = { "1h": 캔들(200, 80, 0.2), "4h": 캔들(200, 80, 0.2), "1d": 캔들(200, 80, 0.2) };
    const r = LE.analyze(tf, 100, { limit: 7 });
    assert.ok(!r.error, r.error);
    r.resistance.forEach(x => assert.ok(x.price > 100, `저항 ${x.price}가 현재가 아래`));
    r.support.forEach(x => assert.ok(x.price < 100, `지지 ${x.price}가 현재가 위`));
});

검증("현재가가 유효하지 않으면 error", () => {
    assert.ok(LE.analyze({ "1h": 캔들(200, 80, 0.2) }, 0).error);
});

검증("캔들이 모자라면 error", () => {
    assert.ok(LE.analyze({ "1h": 캔들(5, 100, 0.1) }, 100).error);
});

console.log("\n총 " + (통과 + 실패) + "개 중 " + 통과 + "개 통과"
    + (실패 ? " / " + 실패 + "개 실패" : ""));
process.exit(실패 ? 1 : 0);
