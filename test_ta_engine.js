/**
 * ta_engine.js 자체 검증. 실행: node test_ta_engine.js
 *
 * 기준값은 coin-ta-brief 스킬(analyze.py)의 계산 결과다.
 * 이 테스트가 깨지면 스킬 브리핑과 웹페이지 숫자가 어긋난다는 뜻이다.
 */
const assert = require('assert');
const TA = require('./ta_engine.js');

let 통과 = 0;
function 검증(이름, fn) {
    try { fn(); 통과++; console.log(`  OK  ${이름}`); }
    catch (e) { console.error(`  FAIL ${이름}\n       ${e.message}`); process.exitCode = 1; }
}
function 근사(a, b, tol, msg) {
    assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b} (허용 ${tol})`);
}

/** 가격 경로 -> 캔들 */
function 캔들(경로, opt = {}) {
    const { 무거운구간 = null, 기본볼륨 = 100, 무거운볼륨 = 5000 } = opt;
    return 경로.map((p, i) => {
        const prev = i > 0 ? 경로[i - 1] : p;
        let v = 기본볼륨;
        if (무거운구간 && p >= 무거운구간[0] && p <= 무거운구간[1]) v = 무거운볼륨;
        return { o: prev, h: Math.max(p, prev) * 1.002, l: Math.min(p, prev) * 0.998, c: p, v };
    });
}
function 경로(from, to, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(from + (to - from) * (i / (n - 1)));
    return out;
}

console.log('\n[1] 기본 통계');

검증('sma 산술평균', () => {
    assert.strictEqual(TA.sma([1, 2, 3, 4, 5], 5), 3);
    assert.strictEqual(TA.sma([1, 2, 3, 4, 5], 2), 4.5);
});

검증('sma 길이 부족이면 null', () => {
    assert.strictEqual(TA.sma([1, 2], 5), null);
});

검증('ema 초기값은 sma, 이후 가중', () => {
    // 전부 같은 값이면 ema도 그 값. 부동소수점 누적 오차가 있어 근사 비교한다.
    근사(TA.ema(new Array(20).fill(7), 10), 7, 1e-9, 'ema');
});

console.log('\n[2] RSI — 스킬 계산식 일치');

검증('단조 상승이면 RSI 100', () => {
    assert.strictEqual(TA.rsi(경로(100, 200, 30)), 100);
});

검증('단조 하락이면 RSI 0', () => {
    assert.strictEqual(TA.rsi(경로(200, 100, 30)), 0);
});

검증('상승/하락 균등이면 RSI 50 근처', () => {
    const zig = [];
    for (let i = 0; i < 40; i++) zig.push(100 + (i % 2 ? 1 : 0));
    근사(TA.rsi(zig), 50, 10, 'RSI');
});

검증('데이터 부족이면 null', () => {
    assert.strictEqual(TA.rsi([1, 2, 3]), null);
});

console.log('\n[3] 스토캐스틱 / CCI');

검증('최고가 마감이면 %K 100', () => {
    const c = 캔들(경로(100, 130, 30));
    const st = TA.stoch(c);
    근사(st.k, 100, 12, '%K');   // 고가에 꼬리가 있어 정확히 100은 아니다
});

검증('스토캐스틱 k·d 모두 0~100', () => {
    const c = 캔들([...경로(100, 130, 25), ...경로(130, 110, 20)]);
    const st = TA.stoch(c);
    assert.ok(st.k >= 0 && st.k <= 100, 'k 범위');
    assert.ok(st.d >= 0 && st.d <= 100, 'd 범위');
});

검증('CCI 상승 구간에서 양수', () => {
    assert.ok(TA.cci(캔들(경로(100, 140, 30))) > 0);
});

검증('CCI 하락 구간에서 음수', () => {
    assert.ok(TA.cci(캔들(경로(140, 100, 30))) < 0);
});

console.log('\n[4] MACD / 볼린저');

검증('MACD 상승 추세에서 line > 0', () => {
    const m = TA.macd(경로(100, 200, 60));
    assert.ok(m.macd > 0, `macd ${m.macd}`);
});

검증('MACD signal·hist 계산됨 (35봉 이상)', () => {
    const m = TA.macd(경로(100, 200, 60));
    assert.ok(m.signal !== null && m.hist !== null);
    근사(m.hist, m.macd - m.signal, 0.01, 'hist = macd - signal');
});

검증('MACD 35봉 미만이면 signal null', () => {
    const m = TA.macd(경로(100, 120, 30));
    assert.strictEqual(m.signal, null);
});

검증('볼린저 mid = SMA20', () => {
    const closes = 경로(100, 130, 40);
    const bb = TA.bollinger(closes);
    근사(bb.mid, TA.rp(TA.sma(closes, 20)), 0.01, 'mid');
});

검증('볼린저 lower <= mid <= upper', () => {
    const bb = TA.bollinger(경로(100, 130, 40));
    assert.ok(bb.lower <= bb.mid && bb.mid <= bb.upper);
});

검증('pct_b는 현재가 위치 비율', () => {
    const closes = 경로(100, 130, 40);
    const bb = TA.bollinger(closes);
    // 단조 상승 끝이면 상단 근처
    assert.ok(bb.pct_b > 0.5, `pct_b ${bb.pct_b}`);
});

console.log('\n[5] ATR / 슈퍼트렌드 / VWAP');

검증('ATR 양수', () => {
    assert.ok(TA.atr(캔들(경로(100, 130, 40))) > 0);
});

검증('슈퍼트렌드는 종가 vs hl2로 판정 (스킬 원본 로직)', () => {
    const c = 캔들(경로(100, 130, 40));
    const last = c[c.length - 1];
    const hl2 = (last.h + last.l) / 2;
    const st = TA.supertrend(c);
    assert.strictEqual(st.trend, last.c > hl2 ? '상승' : '하락');
});

검증('슈퍼트렌드 up_band < dn_band', () => {
    const st = TA.supertrend(캔들(경로(100, 130, 40)));
    assert.ok(st.up_band < st.dn_band);
});

검증('VWAP은 거래량 몰린 가격대로 끌린다', () => {
    const c = 캔들([...경로(100, 130, 30), ...경로(130, 100, 30)], { 무거운구간: [100, 105] });
    const v = TA.vwap(c);
    assert.ok(v < 115, `VWAP ${v}가 저가 구간으로 끌려야 한다`);
});

검증('거래량 0이면 VWAP null', () => {
    const c = 경로(100, 130, 40).map(p => ({ o: p, h: p, l: p, c: p, v: 0 }));
    assert.strictEqual(TA.vwap(c), null);
});

console.log('\n[6] 추세 판정');

검증('정배열이면 score 양수 + 강세', () => {
    const t = TA.trend(캔들(경로(100, 200, 210)));
    assert.ok(t.score >= 3, `score ${t.score}`);
    assert.strictEqual(t.bias, '강세');
    assert.ok(t.signals.some(s => s.includes('정배열')), t.signals.join('/'));
});

검증('역배열이면 score 음수 + 약세', () => {
    const t = TA.trend(캔들(경로(200, 100, 210)));
    assert.ok(t.score <= -3, `score ${t.score}`);
    assert.strictEqual(t.bias, '약세');
    assert.ok(t.signals.some(s => s.includes('역배열')));
});

검증('MA 200개 미만이면 ma.200 null', () => {
    const t = TA.trend(캔들(경로(100, 130, 50)));
    assert.strictEqual(t.ma[200], null);
});

console.log('\n[7] VPVR / 레벨 — 스킬과 동일해야 하는 핵심');

검증('POC가 거래량 몰린 가격대', () => {
    const c = 캔들([...경로(100, 130, 30), ...경로(130, 100, 30)], { 무거운구간: [112, 118] });
    const p = TA.vpvr(c);
    assert.ok(p.poc >= 108 && p.poc <= 122, `POC ${p.poc}`);
});

검증('VAL <= POC <= VAH', () => {
    const c = 캔들([...경로(100, 130, 30), ...경로(130, 105, 25)], { 무거운구간: [112, 118] });
    const p = TA.vpvr(c);
    assert.ok(p.value_area_low <= p.poc + 1e-6, `VAL ${p.value_area_low} <= POC ${p.poc}`);
    assert.ok(p.poc <= p.value_area_high + 1e-6, `POC <= VAH ${p.value_area_high}`);
});

검증('HVN 최대 3개, 가격 오름차순', () => {
    const c = 캔들([...경로(100, 130, 30), ...경로(130, 105, 25)], { 무거운구간: [112, 118] });
    const p = TA.vpvr(c);
    assert.ok(p.hvn_nodes.length <= 3);
    for (let i = 1; i < p.hvn_nodes.length; i++) {
        assert.ok(p.hvn_nodes[i] >= p.hvn_nodes[i - 1], 'HVN 오름차순');
    }
});

검증('저항은 현재가 위, 지지는 아래 (±0.1% 가드)', () => {
    const c = 캔들([...경로(100, 130, 30), ...경로(130, 110, 25)]);
    const price = c[c.length - 1].c;
    const lv = TA.levels(c, price);
    lv.resistance.forEach(x => assert.ok(x > price, `저항 ${x} > ${price}`));
    lv.support.forEach(x => assert.ok(x < price, `지지 ${x} < ${price}`));
});

검증('저항 오름차순 / 지지 내림차순, 각 최대 5개', () => {
    const c = 캔들([...경로(100, 130, 30), ...경로(130, 110, 25)]);
    const lv = TA.levels(c, c[c.length - 1].c);
    assert.ok(lv.resistance.length <= 5 && lv.support.length <= 5);
    for (let i = 1; i < lv.resistance.length; i++) assert.ok(lv.resistance[i] >= lv.resistance[i - 1]);
    for (let i = 1; i < lv.support.length; i++) assert.ok(lv.support[i] <= lv.support[i - 1]);
});

검증('피보 0.236~0.786이 period_low~high 사이', () => {
    const c = 캔들([...경로(100, 130, 30), ...경로(130, 110, 25)]);
    const lv = TA.levels(c, c[c.length - 1].c);
    Object.values(lv.fib).forEach(v => {
        assert.ok(v >= lv.period_low && v <= lv.period_high, `피보 ${v} 범위 밖`);
    });
});

console.log('\n[8] 패턴 / 다이버전스 / 거래량');

검증('장대양봉 감지', () => {
    const c = [
        { o: 100, h: 101, l: 99, c: 100, v: 10 },
        { o: 100, h: 101, l: 99, c: 100, v: 10 },
        { o: 100, h: 110.2, l: 99.8, c: 110, v: 10 }
    ];
    const p = TA.candlePattern(c);
    assert.ok(p && p.some(x => x.includes('장대양봉')), JSON.stringify(p));
});

검증('강세 삼킴형 감지', () => {
    const c = [
        { o: 100, h: 101, l: 99, c: 100, v: 10 },
        { o: 105, h: 106, l: 99, c: 100, v: 10 },   // 음봉
        { o: 99, h: 108, l: 98, c: 106, v: 10 }     // 감싸는 양봉
    ];
    const p = TA.candlePattern(c);
    assert.ok(p && p.some(x => x.includes('강세 삼킴형')), JSON.stringify(p));
});

검증('도지 감지 (몸통 10% 이하)', () => {
    const c = [
        { o: 100, h: 101, l: 99, c: 100, v: 10 },
        { o: 100, h: 101, l: 99, c: 100, v: 10 },
        { o: 100, h: 105, l: 95, c: 100.2, v: 10 }
    ];
    const p = TA.candlePattern(c);
    assert.ok(p && p.some(x => x.includes('도지')), JSON.stringify(p));
});

검증('거래량 급증이면 신뢰도 높음', () => {
    const v = new Array(20).fill(100).concat([300]);
    const r = TA.volumeCheck(v, true);
    // avg20은 마지막 20개(=100×19 + 300)의 평균 110이지 100이 아니다.
    // surge = 300/110 = 2.73. 스킬 sma()가 vals[-20:]을 쓰기 때문.
    근사(r.surge, 300 / 110, 0.01, 'surge');
    assert.ok(r.confirmation.includes('높음'));
});

검증('거래량 빈약이면 신뢰도 낮음', () => {
    const v = new Array(20).fill(100).concat([30]);
    assert.ok(TA.volumeCheck(v, true).confirmation.includes('낮음'));
});

검증('가격 하락 + 급증이면 대량 매도 표기', () => {
    const v = new Array(20).fill(100).concat([300]);
    assert.ok(TA.volumeCheck(v, false).confirmation.includes('대량 매도'));
});

console.log('\n[9] confluence');

검증('net_pct는 -100~+100', () => {
    const c = 캔들([...경로(100, 130, 60), ...경로(130, 110, 40)]);
    const r = TA.analyzeTf(c);
    assert.ok(r.confluence.net_pct >= -100 && r.confluence.net_pct <= 100);
});

검증('net >= 40 이면 강세 수렴 판정', () => {
    // 강한 상승 + 과매도 아님 -> 신호 구성 확인용
    const c = 캔들(경로(100, 200, 210));
    const r = TA.analyzeTf(c);
    if (r.confluence.net_pct >= 40) assert.strictEqual(r.confluence.verdict, '강세 수렴');
    else if (r.confluence.net_pct <= -40) assert.strictEqual(r.confluence.verdict, '약세 수렴');
    else assert.strictEqual(r.confluence.verdict, '혼조/중립');
});

검증('거래량 신뢰도가 confluence에 실린다', () => {
    const c = 캔들(경로(100, 130, 60));
    const r = TA.analyzeTf(c);
    assert.ok(r.confluence.volume_reliability, '신뢰도 필요');
    assert.strictEqual(r.confluence.volume_reliability, r.volume.reliability);
});

console.log('\n[10] analyzeTf 통합 / 방어');

검증('캔들 30개 미만이면 error', () => {
    assert.ok(TA.analyzeTf(캔들(경로(100, 110, 10))).error);
});

검증('빈 배열이어도 죽지 않는다', () => {
    assert.ok(TA.analyzeTf([]).error);
});

검증('필수 키 전부 존재', () => {
    const r = TA.analyzeTf(캔들([...경로(100, 130, 60), ...경로(130, 115, 40)]));
    ['price', 'trend', 'levels', 'oscillators', 'bollinger', 'vwap',
     'candle_pattern', 'volume', 'confluence'].forEach(k => {
        assert.ok(k in r, `키 없음: ${k}`);
    });
});

검증('업비트 KRW 큰 수(9천만원대)에서 반올림 정상', () => {
    const c = 캔들(경로(90000000, 93000000, 60));
    const r = TA.analyzeTf(c);
    assert.ok(r.price > 92000000, `price ${r.price}`);
    assert.ok(Number.isInteger(r.price), 'KRW 억 단위는 정수로 반올림해야 한다');
    assert.ok(r.levels.vpvr.poc > 0);
});

검증('소액 코인(0.5원대)에서 정밀도 유지', () => {
    const c = 캔들(경로(0.51, 0.62, 60));
    const r = TA.analyzeTf(c);
    assert.ok(r.price > 0.6 && r.price < 0.63, `price ${r.price}`);
    assert.ok(String(r.price).length > 3, '소수 자릿수가 뭉개지면 안 된다');
});

console.log(`\n총 ${통과}개 검증 통과${process.exitCode ? ' (실패 있음)' : ''}\n`);
