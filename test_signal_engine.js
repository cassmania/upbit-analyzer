/**
 * test_signal_engine.js — 타점 산출 검증
 *
 * 실행: node test_signal_engine.js
 *
 * 여기서 지키려는 것:
 *   - 손절이 구조(지지/저항) 바깥에 놓이는가
 *   - 손익비 계산이 맞는가, 미달이면 정말 막는가
 *   - 방향성이 없을 때 억지 신호를 만들지 않는가
 */
const assert = require("assert");
const SE = require("./signal_engine.js");

let 통과 = 0, 실패 = 0;
function 검증(이름, fn) {
    try { fn(); console.log("  OK  " + 이름); 통과++; }
    catch (e) { console.log("  X   " + 이름 + "\n      " + e.message); 실패++; }
}

/** 지정한 수렴도를 갖는 가짜 분석 결과 */
function 결과(map) {
    const out = {};
    Object.keys(map).forEach(tf => {
        out[tf] = {
            confluence: { net_pct: map[tf], verdict: "테스트" },
            trend: { supertrend: { trend: map[tf] >= 0 ? "상승" : "하락", atr: 100 } },
            oscillators: { rsi14: 50, rsi_divergence: null }
        };
    });
    return out;
}

/** 현재가 위아래로 벽이 있는 레벨 결과 */
function 레벨(price, 지지, 저항, tfCount) {
    return {
        resistance: 저항.map(p => ({ price: p, tfCount: tfCount || 2, reason: "테스트" })),
        support: 지지.map(p => ({ price: p, tfCount: tfCount || 2, reason: "테스트" })),
        마지노선: { tf: "1d", price: 지지.length ? Math.min(...지지) * 0.95 : price * 0.9 },
        천장: { tf: "1d", price: 저항.length ? Math.max(...저항) * 1.05 : price * 1.1 }
    };
}

console.log("\n[1] 방향 판정");

검증("상위봉이 모두 강세면 LONG", () => {
    const d = SE.방향판정(결과({ "4h": 60, "12h": 70, "1d": 55 }));
    assert.strictEqual(d.dir, "LONG");
    assert.strictEqual(d.agree, 100);
});

검증("상위봉이 모두 약세면 SHORT", () => {
    const d = SE.방향판정(결과({ "4h": -60, "12h": -70, "1d": -55 }));
    assert.strictEqual(d.dir, "SHORT");
});

검증("수렴 약하면 NONE (억지 신호 금지)", () => {
    const d = SE.방향판정(결과({ "4h": 20, "12h": 10, "1d": -5 }));
    assert.strictEqual(d.dir, "NONE");
});

검증("봉끼리 엇갈리면 일치율이 낮게 나온다", () => {
    const d = SE.방향판정(결과({ "4h": 60, "12h": -50, "1d": 55 }));
    assert.ok(d.agree < 100, `일치율 ${d.agree}%`);
});

검증("지표가 하나도 없으면 null", () => {
    assert.strictEqual(SE.방향판정({}), null);
});

console.log("\n[2] 진입 설계 — 손절 위치");

검증("롱 손절은 지지선보다 아래", () => {
    const p = SE.진입설계("LONG", 10000, 레벨(10000, [9500], [11000]), 100);
    assert.ok(p, "설계 실패");
    assert.ok(p.stop < 9500, `손절 ${p.stop}이 지지 9500 위에 있다`);
    assert.ok(p.entry > p.stop, "진입이 손절보다 아래");
});

검증("숏 손절은 저항선보다 위", () => {
    const p = SE.진입설계("SHORT", 10000, 레벨(10000, [9000], [10500]), 100);
    assert.ok(p, "설계 실패");
    assert.ok(p.stop > 10500, `손절 ${p.stop}이 저항 10500 아래에 있다`);
    assert.ok(p.entry < p.stop, "진입이 손절보다 위");
});

검증("ATR이 크면 손절 여유도 커진다", () => {
    const 좁 = SE.진입설계("LONG", 10000, 레벨(10000, [9500], [11000]), 50);
    const 넓 = SE.진입설계("LONG", 10000, 레벨(10000, [9500], [11000]), 400);
    assert.ok(넓.stop < 좁.stop, "ATR이 커도 손절 여유가 안 늘었다");
});

검증("받쳐줄 지지가 없으면 롱 설계 안 함", () => {
    assert.strictEqual(SE.진입설계("LONG", 10000, 레벨(10000, [], [11000]), 100), null);
});

검증("막아줄 저항이 없으면 숏 설계 안 함", () => {
    assert.strictEqual(SE.진입설계("SHORT", 10000, 레벨(10000, [9000], []), 100), null);
});

console.log("\n[3] 손익비");

검증("R 계산이 (목표-진입)/(진입-손절)", () => {
    const p = SE.진입설계("LONG", 10000, 레벨(10000, [9500], [11000]), 100);
    const 기대 = (p.target1 - p.entry) / (p.entry - p.stop);
    assert.ok(Math.abs(p.rr - 기대) < 1e-9, `rr ${p.rr} vs 기대 ${기대}`);
});

검증("목표가 진입보다 낮으면 롱 설계 안 함", () => {
    // 저항이 현재가보다 아래에 있을 수는 없으니, 위 벽이 아예 없는 상황을 만든다
    const lv = { resistance: [], support: [{ price: 9500, tfCount: 2 }], 천장: null, 마지노선: { price: 9000 } };
    assert.strictEqual(SE.진입설계("LONG", 10000, lv, 100), null);
});

console.log("\n[4] 통합 판정");

검증("조건 갖추면 진입 신호가 나온다", () => {
    const r = SE.analyze(결과({ "4h": 60, "12h": 65, "1d": 55 }),
        레벨(10000, [9900], [10400]), 10000, null);
    assert.ok(!r.error, r.error);
    assert.ok(r.entry, "진입 신호 없음: " + r.blocked);
    assert.strictEqual(r.entry.side, "LONG");
    assert.ok(r.entry.rr >= SE.최소_R, `R ${r.entry.rr}`);
});

검증("손익비 미달이면 진입을 막는다", () => {
    // 지지는 가까이(진입 성립), 목표는 코앞이라 R이 안 나오는 배치.
    // 지지를 멀리 두면 이격 가드에 먼저 걸려서 R 검증이 안 된다.
    // 진입 9,975(현재가 -0.25%) / 목표 10,010 → R 0.47
    const r = SE.analyze(결과({ "4h": 60, "12h": 65, "1d": 55 }),
        레벨(10000, [9950], [10010]), 10000, null);
    assert.strictEqual(r.entry, null, "R 미달인데 진입 신호가 나왔다");
    assert.ok(/손익비/.test(r.blocked), r.blocked);
});

// R은 벽이 멀수록 좋아진다. 그래서 R만 보면 "지금 못 사는 가격"이 최상급 신호로 둔갑한다.
// 현재가 10,000에 지지가 9,000이면 진입 9,025 / R 13.7이 나오지만 -9.75% 빠져야 성립한다.
검증("진입가가 현재가에서 멀면 R이 좋아도 막는다", () => {
    const r = SE.analyze(결과({ "4h": 60, "12h": 65, "1d": 55 }),
        레벨(10000, [9000], [11000]), 10000, null);
    assert.strictEqual(r.entry, null, "먼 진입가인데 신호가 나왔다");
    assert.ok(/떨어져/.test(r.blocked), r.blocked);
    // 계획 자체는 남겨서 "그 자리 오면 유효"임을 보여준다
    assert.ok(r.rejected && r.rejected.rr > 1, "기각된 계획이 보존되지 않음");
});

검증("방향성 없으면 관망", () => {
    const r = SE.analyze(결과({ "4h": 10, "12h": 5, "1d": -10 }),
        레벨(10000, [9500], [11000]), 10000, null);
    assert.strictEqual(r.entry, null);
    assert.ok(/관망|방향성/.test(r.blocked), r.blocked);
});

검증("1시간 과열이면 롱 진입을 미룬다", () => {
    const res = 결과({ "4h": 60, "12h": 65, "1d": 55 });
    res["1h"] = { confluence: { net_pct: 50 }, trend: { supertrend: { trend: "상승", atr: 100 } },
                  oscillators: { rsi14: 80, rsi_divergence: null } };
    // 이격·R 게이트를 통과하는 배치라야 RSI 과열이 차단 사유로 드러난다
    const r = SE.analyze(res, 레벨(10000, [9900], [10400]), 10000, null);
    assert.strictEqual(r.entry, null, "과열인데 진입 신호가 나왔다");
    assert.ok(/과열/.test(r.blocked), r.blocked);
});

// 신규 상장 코인은 12h·1d 이력이 없어 4h 하나만 잡힌다. 그 상태로 "일치율 100%"가
// 표시되면 봉 하나의 수렴도를 여러 봉의 합의로 오인하게 된다. (실제 KRW-USDG에서 발생)
검증("상위봉이 하나뿐이면 진입 보류", () => {
    const r = SE.analyze(결과({ "4h": 100 }), 레벨(10000, [9900], [10400]), 10000, null);
    assert.strictEqual(r.entry, null, "봉 1개인데 진입 신호가 나왔다");
    assert.ok(/하나|1개뿐/.test(r.blocked), r.blocked);
});

검증("상위봉 2개 이상이면 정상 판정", () => {
    const r = SE.analyze(결과({ "4h": 60, "12h": 65 }), 레벨(10000, [9900], [10400]), 10000, null);
    assert.ok(r.entry, "봉 2개인데 막혔다: " + r.blocked);
});

검증("데이터 부족하면 error", () => {
    assert.ok(SE.analyze(null, null, null, null).error);
    assert.ok(SE.analyze({}, { error: "x" }, 100, null).error);
});

console.log("\n[5] 청산 신호");

검증("추세가 반대로 꺾이면 긴급 청산", () => {
    const 사유 = SE.청산판정(결과({ "4h": -60, "12h": -70, "1d": -55 }), "LONG", 10000, 레벨(10000, [9500], [11000]));
    assert.ok(사유.some(x => x.level === "긴급"), JSON.stringify(사유));
});

검증("다중 저항 도달 시 분할 익절 안내", () => {
    // 현재가가 저항 바로 아래(0.5% 이내)
    const 사유 = SE.청산판정(결과({ "4h": 60, "12h": 65, "1d": 55 }), "LONG", 10000,
        레벨(10000, [9500], [10030], 4));
    assert.ok(사유.some(x => /익절/.test(x.text)), JSON.stringify(사유));
});

검증("아무 조건 없으면 청산 사유도 없다", () => {
    const 사유 = SE.청산판정(결과({ "4h": 55, "12h": 50, "1d": 52 }), "LONG", 10000,
        레벨(10000, [9000], [12000]));
    assert.strictEqual(사유.length, 0, JSON.stringify(사유));
});

console.log("\n총 " + (통과 + 실패) + "개 중 " + 통과 + "개 통과"
    + (실패 ? " / " + 실패 + "개 실패" : ""));
process.exit(실패 ? 1 : 0);
