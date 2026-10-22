/**
 * v3_analysis.js — AI MASTER CRYPTO TRADING ANALYST V3.1의 재현 가능한 구조 분석.
 *
 * 입력은 선택한 종목의 완료봉뿐이다. 전역 상태를 보관하지 않아 종목 전환 시
 * 이전 종목의 FVG·오더블록·피보나치가 섞일 수 없다.
 */
(function (global) {
    "use strict";

    function isNum(v) { return typeof v === "number" && isFinite(v); }
    function round(v) {
        if (!isNum(v)) return null;
        const a = Math.abs(v);
        const d = a >= 1000 ? 2 : a >= 1 ? 6 : 10;
        return Number(v.toFixed(d));
    }
    function average(values) {
        return values.length ? values.reduce(function (a, b) { return a + b; }, 0) / values.length : null;
    }
    function candleTime(candle, index) {
        return isNum(candle.time) ? candle.time : index;
    }

    /** 좌우 k개 완료봉보다 엄격히 높거나 낮은 피벗만 확정한다. */
    function confirmedPivots(candles, k) {
        k = k || 5;
        const out = [];
        if (!candles || candles.length < k * 2 + 1) return out;
        for (let i = k; i < candles.length - k; i++) {
            let high = true, low = true;
            for (let j = i - k; j <= i + k; j++) {
                if (j === i) continue;
                if (candles[i].h <= candles[j].h) high = false;
                if (candles[i].l >= candles[j].l) low = false;
            }
            if (high) out.push({ type: "high", index: i, confirmedAt: i + k, time: candleTime(candles[i], i), price: candles[i].h });
            if (low) out.push({ type: "low", index: i, confirmedAt: i + k, time: candleTime(candles[i], i), price: candles[i].l });
        }
        return out.sort(function (a, b) { return a.index - b.index; });
    }

    /** 가장 최근의 확정 고점·저점 한 쌍으로 되돌림 레벨을 만든다. */
    function fibonacci(candles, pivots) {
        const highs = pivots.filter(function (p) { return p.type === "high"; });
        const lows = pivots.filter(function (p) { return p.type === "low"; });
        if (!highs.length || !lows.length) return null;
        const high = highs[highs.length - 1], low = lows[lows.length - 1];
        const span = high.price - low.price;
        if (!(span > 0)) return null;
        const rising = low.index < high.index;
        const levels = {};
        [0.382, 0.5, 0.618, 0.786].forEach(function (ratio) {
            levels[String(ratio)] = round(rising ? high.price - span * ratio : low.price + span * ratio);
        });
        return {
            direction: rising ? "상승 스윙 되돌림" : "하락 스윙 반등",
            from: rising ? low : high,
            to: rising ? high : low,
            levels: levels
        };
    }

    function gapFill(candles, start, lower, upper, bullish) {
        const later = candles.slice(start + 1);
        if (!later.length) return { status: "미체결", filled_pct: 0 };
        let penetration;
        if (bullish) {
            const minLow = Math.min.apply(null, later.map(function (c) { return c.l; }));
            penetration = minLow >= upper ? 0 : minLow <= lower ? 1 : (upper - minLow) / (upper - lower);
        } else {
            const maxHigh = Math.max.apply(null, later.map(function (c) { return c.h; }));
            penetration = maxHigh <= lower ? 0 : maxHigh >= upper ? 1 : (maxHigh - lower) / (upper - lower);
        }
        const pct = Math.max(0, Math.min(100, penetration * 100));
        return { status: pct >= 100 ? "완전 메움" : pct > 0 ? "부분 메움" : "미체결", filled_pct: Math.round(pct) };
    }

    /** 3봉 불균형 정의로 FVG를 찾고 이후 봉의 메움 상태를 계산한다. */
    function fairValueGaps(candles) {
        const out = [];
        for (let i = 2; i < candles.length; i++) {
            const first = candles[i - 2], third = candles[i];
            let bullish = null, lower = null, upper = null;
            if (third.l > first.h) {
                bullish = true; lower = first.h; upper = third.l;
            } else if (third.h < first.l) {
                bullish = false; lower = third.h; upper = first.l;
            }
            if (bullish === null) continue;
            const fill = gapFill(candles, i, lower, upper, bullish);
            out.push({
                type: bullish ? "bullish" : "bearish",
                index: i,
                time: candleTime(third, i),
                lower: round(lower),
                upper: round(upper),
                status: fill.status,
                filled_pct: fill.filled_pct
            });
        }
        return out.slice(-12);
    }

    function lastOpposing(candles, from, to, bullishBreak) {
        for (let i = to; i >= from; i--) {
            if (bullishBreak ? candles[i].c < candles[i].o : candles[i].c > candles[i].o) return i;
        }
        return null;
    }

    /** 확인 피벗의 종가 돌파(BOS)와 직전 반대색 봉을 오더블록 후보로 연결한다. */
    function structure(candles, pivots, ta) {
        const bos = [], blocks = [];
        pivots.forEach(function (pivot) {
            const bullish = pivot.type === "high";
            let breakIndex = null;
            for (let i = pivot.confirmedAt + 1; i < candles.length; i++) {
                if ((bullish && candles[i].c > pivot.price) || (!bullish && candles[i].c < pivot.price)) {
                    breakIndex = i; break;
                }
            }
            if (breakIndex === null) return;
            const breakCandle = candles[breakIndex];
            const from = Math.max(pivot.index + 1, breakIndex - 12);
            const opposing = lastOpposing(candles, from, breakIndex - 1, bullish);
            bos.push({
                type: bullish ? "bullish" : "bearish",
                pivot_price: round(pivot.price),
                break_price: round(breakCandle.c),
                time: candleTime(breakCandle, breakIndex)
            });
            if (opposing === null) return;

            const source = candles[opposing];
            const history = candles.slice(0, breakIndex + 1);
            const atr = ta && ta.atr ? ta.atr(history, 14) : null;
            const volumeAverage = average(candles.slice(Math.max(0, breakIndex - 20), breakIndex).map(function (c) { return c.v; }));
            const displacement = Math.abs(breakCandle.c - breakCandle.o);
            const confirmed = isNum(atr) && atr > 0 && displacement >= atr
                && isNum(volumeAverage) && volumeAverage > 0 && breakCandle.v >= volumeAverage * 1.2;
            let invalidated = false;
            for (let j = breakIndex + 1; j < candles.length; j++) {
                if ((bullish && candles[j].c < source.l) || (!bullish && candles[j].c > source.h)) {
                    invalidated = true; break;
                }
            }
            blocks.push({
                type: bullish ? "bullish" : "bearish",
                index: opposing,
                time: candleTime(source, opposing),
                lower: round(source.l),
                upper: round(source.h),
                quality: confirmed ? "확인" : "후보",
                status: invalidated ? "무효" : "유효"
            });
        });

        function uniqueLatest(items) {
            const seen = {};
            return items.filter(function (item) {
                const key = item.type + ":" + item.lower + ":" + item.upper;
                if (seen[key]) return false;
                seen[key] = true;
                return true;
            }).slice(-8);
        }
        return { bos: bos.slice(-8), order_blocks: uniqueLatest(blocks) };
    }

    function regime(value) {
        if (!value || !isNum(value.adx)) return "표본 부족";
        if (value.adx < 20) return "약한 추세/횡보";
        if (value.adx < 25) return "추세 전환 구간";
        return value.plus_di >= value.minus_di ? "상승 추세 강화" : "하락 추세 강화";
    }

    function analyze(tfCandles, ta) {
        const frames = {};
        Object.keys(tfCandles || {}).forEach(function (key) {
            const candles = tfCandles[key] || [];
            const value = ta && ta.adx ? ta.adx(candles, 14) : null;
            frames[key] = { candles: candles.length, adx: value, regime: regime(value) };
        });
        const primaryKey = ["4h", "12h", "1d", "1h"].filter(function (key) {
            return tfCandles && tfCandles[key] && tfCandles[key].length >= 30;
        })[0] || null;
        if (!primaryKey) return { error: "구조 분석에 필요한 완료봉이 부족합니다.", frames: frames };

        const candles = tfCandles[primaryKey];
        const pivots = confirmedPivots(candles, 5);
        const marketStructure = structure(candles, pivots, ta);
        return {
            version: "3.1.0",
            primary_tf: primaryKey,
            frames: frames,
            pivots: pivots.slice(-12),
            fibonacci: fibonacci(candles, pivots),
            fvg: fairValueGaps(candles),
            bos: marketStructure.bos,
            order_blocks: marketStructure.order_blocks
        };
    }

    const V3Analysis = {
        VERSION: "3.1.0",
        confirmedPivots: confirmedPivots,
        fibonacci: fibonacci,
        fairValueGaps: fairValueGaps,
        structure: structure,
        regime: regime,
        analyze: analyze
    };

    global.V3Analysis = V3Analysis;
    if (typeof module !== "undefined" && module.exports) module.exports = V3Analysis;
})(typeof window !== "undefined" ? window : globalThis);
