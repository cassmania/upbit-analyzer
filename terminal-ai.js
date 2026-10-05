/* terminal-ai.js — 터미널용 V4.1 파이프라인 접착 코드.
   TAEngine → LevelEngine → SignalEngine 순수 조합. DOM·fetch 없음.
   브라우저 전역 TerminalAI + node module.exports. */
(function (global) {
    "use strict";
    var TF_SEC = { "1h": 3600, "4h": 14400, "12h": 43200, "1d": 86400 };

    // MEXC 선물 kline 배열형 → 엔진 스키마 {time,o,h,l,c,v}
    function normalizeFutures(d) {
        if (!d || !Array.isArray(d.time)) return [];
        var out = [];
        for (var i = 0; i < d.time.length; i++) {
            var o = Number(d.open[i]), h = Number(d.high[i]), l = Number(d.low[i]),
                c = Number(d.close[i]), v = Number(d.vol[i]);
            if (![o, h, l, c, v].every(isFinite) || h < l || v < 0) continue;
            out.push({ time: d.time[i], o: o, h: h, l: l, c: c, v: v });
        }
        return out;
    }

    // 미완성 마지막 봉 제거. 경계 여유 60초
    function dropForming(candles, intervalSec, nowSec) {
        if (!candles.length) return candles;
        var last = candles[candles.length - 1];
        if (last.time + intervalSec > nowSec + 60) return candles.slice(0, -1);
        return candles;
    }

    function resample(candles, n) {
        var out = [];
        for (var i = 0; i < candles.length; i += n) {
            var g = candles.slice(i, i + n);
            if (!g.length) break;
            out.push({ time: g[0].time, o: g[0].o, h: Math.max.apply(null, g.map(function (k) { return k.h; })),
                l: Math.min.apply(null, g.map(function (k) { return k.l; })), c: g[g.length - 1].c,
                v: g.reduce(function (s, k) { return s + k.v; }, 0) });
        }
        return out;
    }

    function roundToScale(value, priceScale) {
        var p = Math.max(0, Math.min(8, Math.round(Number(priceScale) || 0)));
        var n = Number(value);
        return Number.isFinite(n) ? Number(n.toFixed(p)) : null;
    }

    // tfData: {"1h":MEXC배열,"4h":...,"12h":MEXC-Min60배열,"1d":...}, price, funding
    function runPipeline(deps, tfData, price, funding) {
        var TA = deps.TA, LV = deps.LV, SIG = deps.SIG;
        if (!TA || !LV || !SIG) return { ok: false, dir: "관망", reason: "엔진 미로드" };
        if (!Number.isFinite(price) || price <= 0) return { ok: false, dir: "관망", reason: "현재가 없음" };
        var nowSec = Math.floor(Date.now() / 1000);
        var tfCandles = {};
        ["1h", "4h", "12h", "1d"].forEach(function (tf) {
            var raw = normalizeFutures(tfData[tf]);
            if (tf === "12h") raw = resample(raw, 12);
            tfCandles[tf] = dropForming(raw, TF_SEC[tf], nowSec);
        });
        var results = {};
        Object.keys(tfCandles).forEach(function (tf) {
            try { results[tf] = TA.analyzeTf(tfCandles[tf]); }
            catch (e) { results[tf] = { error: String((e && e.message) || e) }; }
        });
        var lv;
        try { lv = LV.analyze(tfCandles, price); }
        catch (e) { return { ok: false, dir: "관망", reason: "레벨 분석 실패" }; }
        var sig;
        try { sig = SIG.analyze(results, lv, price, { funding: funding }); }
        catch (e) { return { ok: false, dir: "관망", reason: "신호 산출 실패" }; }
        if (sig.error) return { ok: false, dir: "관망", reason: sig.error };
        var dir = sig.entry ? sig.entry.side : "관망";
        return { ok: true, dir: dir, entry: sig.entry, blocked: sig.blocked || null,
            agree: sig.방향 ? sig.방향.agree : null, avg: sig.방향 ? sig.방향.avg : null,
            exits: sig.exits || { long: [], short: [] }, atr: sig.atr, raw: sig };
    }

    var TerminalAI = { VERSION: "1.0.0", normalizeFutures: normalizeFutures, dropForming: dropForming,
        resample: resample, roundToScale: roundToScale, runPipeline: runPipeline };
    global.TerminalAI = TerminalAI;
    if (typeof module !== "undefined" && module.exports) module.exports = TerminalAI;
})(typeof window !== "undefined" ? window : globalThis);
