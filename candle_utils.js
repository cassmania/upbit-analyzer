/**
 * candle_utils.js — 거래소별 캔들 시간축과 완료 여부를 한 형식으로 맞춘다.
 *
 * 차트에는 진행 중인 봉도 필요하지만, 지표와 매매 조건은 완료된 봉으로만
 * 계산해야 새로고침할 때 값이 불필요하게 뒤집히지 않는다.
 */
(function (global) {
    "use strict";

    function num(v) {
        var n = Number(v);
        return isFinite(n) ? n : null;
    }

    /** 업비트의 UTC 문자열에는 Z가 없으므로 UTC임을 명시해 파싱한다. */
    function parseUtcSeconds(text) {
        if (!text) return null;
        var value = String(text);
        if (!/[zZ]|[+-]\d\d:\d\d$/.test(value)) value += "Z";
        var ms = Date.parse(value);
        return isFinite(ms) ? Math.floor(ms / 1000) : null;
    }

    /** 월봉·년봉처럼 길이가 고정되지 않은 봉까지 포함한 종료 시각 계산. */
    function closeTimeSeconds(openSec, tfKey, fixedSec) {
        if (!isFinite(openSec)) return null;
        var d;
        if (tfKey === "1M") {
            d = new Date(openSec * 1000);
            return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
        }
        if (tfKey === "1y") {
            d = new Date(openSec * 1000);
            return Date.UTC(d.getUTCFullYear() + 1, 0, 1) / 1000;
        }
        return openSec + fixedSec;
    }

    /** 업비트·빗썸 응답(최신순)을 과거→최신 순으로 정규화한다. */
    function fromUpbit(raw, tfKey, fixedSec, nowMs) {
        var now = isFinite(nowMs) ? nowMs : Date.now();
        if (!Array.isArray(raw)) return [];
        return raw.slice().reverse().map(function (k) {
            var open = parseUtcSeconds(k.candle_date_time_utc);
            var end = closeTimeSeconds(open, tfKey, fixedSec);
            return {
                time: open,
                endTime: end,
                closed: isFinite(end) && end * 1000 <= now,
                kst: k.candle_date_time_kst,
                o: num(k.opening_price), h: num(k.high_price), l: num(k.low_price),
                c: num(k.trade_price), v: num(k.candle_acc_trade_volume)
            };
        }).filter(validCandle);
    }

    /** 바이낸스·MEXC kline 응답(과거순)을 같은 형식으로 정규화한다. */
    function fromBinance(raw, tfKey, fixedSec, nowMs) {
        var now = isFinite(nowMs) ? nowMs : Date.now();
        if (!Array.isArray(raw)) return [];
        return raw.map(function (k) {
            var open = Math.floor(Number(k[0]) / 1000);
            var apiEndMs = Number(k[6]);
            var end = isFinite(apiEndMs) && apiEndMs > 0
                ? Math.floor((apiEndMs + 1) / 1000)
                : closeTimeSeconds(open, tfKey, fixedSec);
            return {
                time: open,
                endTime: end,
                closed: isFinite(end) && end * 1000 <= now,
                kst: isFinite(open) ? new Date(open * 1000).toISOString() : null,
                o: num(k[1]), h: num(k[2]), l: num(k[3]), c: num(k[4]), v: num(k[5])
            };
        }).filter(validCandle);
    }

    function validCandle(c) {
        return c && isFinite(c.time) && isFinite(c.o) && isFinite(c.h)
            && isFinite(c.l) && isFinite(c.c) && isFinite(c.v)
            && c.h >= c.l && c.v >= 0;
    }

    /**
     * 고정 길이 봉을 합성한다. 구성 봉이 빠짐없이 n개이고 모두 끝나야 완료봉이다.
     * 거래가 없어 원본 봉이 누락된 경우에는 해당 합성봉을 분석에서 제외한다.
     */
    function group(src, n, sourceSec, nowMs) {
        if (!Array.isArray(src) || !src.length || !(n > 0) || !(sourceSec > 0)) return [];
        var targetSec = sourceSec * n;
        var now = isFinite(nowMs) ? nowMs : Date.now();
        var out = [], cur = null, curKey = null;

        src.forEach(function (c) {
            var key = Math.floor(c.time / targetSec) * targetSec;
            if (cur && key === curKey) {
                if (c.h > cur.h) cur.h = c.h;
                if (c.l < cur.l) cur.l = c.l;
                cur.c = c.c;
                cur.v += c.v;
                cur.parts++;
                cur.allPartsClosed = cur.allPartsClosed && c.closed === true;
            } else {
                curKey = key;
                cur = {
                    time: key,
                    endTime: key + targetSec,
                    kst: c.kst,
                    o: c.o, h: c.h, l: c.l, c: c.c, v: c.v,
                    parts: 1,
                    allPartsClosed: c.closed === true,
                    closed: false
                };
                out.push(cur);
            }
        });

        out.forEach(function (c) {
            c.closed = c.parts === n && c.allPartsClosed && c.endTime * 1000 <= now;
        });
        return out;
    }

    function completed(candles) {
        return Array.isArray(candles) ? candles.filter(function (c) { return c.closed === true; }) : [];
    }

    var CandleUtils = {
        VERSION: "1.0.0",
        parseUtcSeconds: parseUtcSeconds,
        closeTimeSeconds: closeTimeSeconds,
        fromUpbit: fromUpbit,
        fromBinance: fromBinance,
        group: group,
        completed: completed
    };

    global.CandleUtils = CandleUtils;
    if (typeof module !== "undefined" && module.exports) module.exports = CandleUtils;
})(typeof window !== "undefined" ? window : globalThis);
