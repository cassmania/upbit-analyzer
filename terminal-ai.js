/* terminal-ai.js — 터미널용 V4.1 파이프라인 접착 코드.
   TAEngine → LevelEngine → SignalEngine 순수 조합. DOM·fetch 없음.
   브라우저 전역 TerminalAI + node module.exports. */
(function (global) {
    "use strict";
    // 아래 nextCandle용 TF_SEC와 이름이 겹치면 var 호이스팅으로 덮여 dropForming이 undefined를 받는다.
    var PIPE_SEC = { "1h": 3600, "4h": 14400, "12h": 43200, "1d": 86400 };

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

    // 1h봉 n개 묶음. 인덱스 0부터 묶으면 봉 개수에 따라 경계가 밀리므로 절대 시각(UTC) 기준으로 묶는다.
    function resample(candles, n) {
        var out = [], win = n * 3600, i = 0;
        while (i < candles.length) {
            var w0 = Math.floor(candles[i].time / win) * win, g = [];
            while (i < candles.length && Math.floor(candles[i].time / win) * win === w0) g.push(candles[i++]);
            out.push({ time: w0, o: g[0].o, h: Math.max.apply(null, g.map(function (k) { return k.h; })),
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
            tfCandles[tf] = dropForming(raw, PIPE_SEC[tf], nowSec);
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
        // 상세 표시용: TF별 근거(frames)와 데이터 기준시각(가장 오래된 확정봉)을 함께 넘긴다.
        var asOf = null;
        Object.keys(tfCandles).forEach(function (tf) {
            var arr = tfCandles[tf];
            if (arr && arr.length) {
                var t = arr[arr.length - 1].time;
                if (Number.isFinite(t) && (asOf === null || t < asOf)) asOf = t;
            }
        });
        sig.frames = results;
        sig.asOf = asOf;
        var dir = sig.entry ? sig.entry.side : "관망";
        return { ok: true, dir: dir, entry: sig.entry, blocked: sig.blocked || null,
            agree: sig.방향 ? sig.방향.agree : null, avg: sig.방향 ? sig.방향.avg : null,
            exits: sig.exits || { long: [], short: [] }, atr: sig.atr,
            frames: sig.frames || null, asOf: sig.asOf || null, raw: sig };
    }

    /* 검증된 진입 규칙 (2026-11-11, 사이트-백테스트-비교/upbit-lab.js · upbit-tp.js).
       예전 판정(4h·12h·1d 수렴 + 지지·저항 타점)은 24종목 × 11개월에서 방향 적중 46.7%(기준 51.2%),
       자동매매 규칙 그대로 −0.105R(같은 손절·목표의 무작위 진입 −0.06R)이었다.
       새 판정: 4시간봉 확정봉에서 추세 합의 5/5 + ADX 20 이상이 "새로" 충족되고 방향 점수가 같은 쪽일 때만 진입.
       손절 2.5×ATR(4h), 목표 2R. 학습에 쓰지 않은 구간에서 +0.36R(기존 8종목)·+0.24R(다른 16종목), 승률 약 40%.
       새로 충족된 그 봉(다음 4시간봉이 마감되기 전)에만 유효하다 — 상태가 이어지는 동안 계속 진입하면 검증한 규칙이 아니다. */
    var V_STOP_ATR = 2.5, V_TARGET_R = 2;
    function validatedSignal(deps, h4raw, price) {
        var CA = deps.CA, EN = deps.EN, CU = deps.CU;
        if (!CA || !EN || !CU || !CU.LIST || !CU.LIST[0]) return { ok: false, reason: "검증 엔진 미로드" };
        var rows = dropForming(normalizeFutures(h4raw), 14400, Math.floor(Date.now() / 1000)).slice(-500).map(function (k) {
            return { time: k.time, open: k.o, high: k.h, low: k.l, close: k.c, volume: k.v };
        });
        if (rows.length < 260) return { ok: false, reason: "4시간봉 부족 (" + rows.length + "/260)" };
        var li = rows.length - 1, c1 = CU.LIST[0].build(rows), S = c1.osc.data[li];
        var adx = EN.adx(rows, 14).adx[li], atr = EN.atr(rows, 14)[li], cs = CA.compositeSignal(rows);
        var score = cs.ready ? cs.score : null;
        if (S == null || !isFinite(adx) || !isFinite(atr) || !(atr > 0) || score == null) return { ok: false, reason: "지표 계산 대기" };
        var dir = S === 5 ? 1 : S === -5 ? -1 : 0, fresh = dir === 1 ? !!c1.long[li] : dir === -1 ? !!c1.short[li] : false;
        var sgn = function (v, d) { return (v >= 0 ? "+" : "") + v.toFixed(d); };
        var reason = null;
        if (!dir) reason = "추세 합의 " + sgn(S, 0) + "/5";
        else if (!(adx >= 20)) reason = "ADX " + adx.toFixed(0) + " < 20";
        else if (dir * score < 0) reason = "방향 점수 " + sgn(score, 2) + " 반대";
        else if (!fresh) reason = "조건 유지 중 · 새 신호 아님";
        else if (!(price > 0)) reason = "현재가 없음";
        var entry = reason ? null : {
            side: dir === 1 ? "LONG" : "SHORT", entry: price, stop: price - dir * V_STOP_ATR * atr,
            target1: price + dir * V_STOP_ATR * V_TARGET_R * atr, target2: null, risk: V_STOP_ATR * atr, rr: V_TARGET_R,
            sigTime: rows[li].time
        };
        return { ok: true, dir: entry ? entry.side : "관망", entry: entry, reason: reason, agree: S, adx: adx, score: score, atr: atr,
            want: dir, barTime: rows[li].time, exitHint: S <= -3 ? "롱 보유 중이면 청산" : S >= 3 ? "숏 보유 중이면 청산" : null };
    }
    // 화면·자동매매가 쓰는 판정. 예전 파이프라인 결과(TF 수렴·오실레이터·지지저항 계획)는 참고용으로 함께 넘긴다.
    function runValidated(deps, tfData, price, funding) {
        var r = runPipeline(deps, tfData, price, funding), v;
        try { v = validatedSignal(deps, tfData["4h"], price); } catch (e) { v = { ok: false, reason: "검증 규칙 계산 실패" }; }
        r.plan = r.entry || (r.raw && r.raw.rejected) || null;   // 예전 지지·저항 계획(참고)
        r.planBlocked = r.blocked || null;
        r.validated = v;
        r.ok = !!v.ok;
        r.entry = v.ok ? v.entry : null;
        r.dir = r.entry ? r.entry.side : "관망";
        r.blocked = r.entry ? null : v.reason;
        r.reason = v.reason;
        r.agree = null;
        return r;
    }

    // 거래대금 상위 USDT 선물을 스캔 대상으로 고른다 (유동성 낮은 잡코인 제외)
    function pickTopSymbols(tickers, details, n) {
        var size = {};
        (details || []).forEach(function (d) {
            if (d && d.symbol) size[d.symbol] = { cs: Number(d.contractSize), ps: Number(d.priceScale) };
        });
        return (tickers || [])
            .filter(function (t) { return t && /_USDT$/.test(t.symbol) && Number(t.amount24) > 0 && size[t.symbol]
                && Number(size[t.symbol].cs) > 0; })
            .sort(function (a, b) { return Number(b.amount24) - Number(a.amount24); })
            .slice(0, Math.max(1, Math.min(30, n || 10)))
            .map(function (t) { return { symbol: t.symbol, contractSize: size[t.symbol].cs,
                priceScale: size[t.symbol].ps || 2, lastPrice: Number(t.lastPrice) }; });
    }

    // 시뮬레이터식 모의 정산: 진입수수료 0.04%·유지마진 0.5% 가정 청산가·종료수수료
    var PAPER_FEE = 0.0004, PAPER_MM = 0.005;
    function openCalc(price, vol, lev, cs) {
        var p = Number(price), v = Number(vol), l = Number(lev), c = Number(cs);
        if (!([p, v, l, c].every(isFinite)) || v <= 0 || l < 1 || c <= 0) return null;
        var notional = p * v * c;
        return { notional: notional, margin: notional / l, feeIn: notional * PAPER_FEE,
            liqLong: p * (1 - 1 / l + PAPER_MM), liqShort: p * (1 + 1 / l - PAPER_MM) };
    }
    // 실효 레버리지 = 명목가치 / 투입마진. 진입 직후엔 설정 레버리지와 일치한다.
    function effOf(pos) {
        var cs = Number(pos.cs);
        if (!(cs > 0)) return 0;
        var base = Number(pos.price) * Number(pos.vol) * cs;
        var margin = Number(pos.margin);
        if (!(base > 0) || !(margin > 0)) return 0;
        return base / margin;
    }
    // 실효 맞춤: 투입마진을 명목가치/설정레버리지로 되돌린다. 늘어난분(added)은 지갑으로 환불.
    // 반환 { margin, added, liqLong, liqShort, refund }. 잔고 부족(마진 부족분 충당 불가)時は refund 계산만 하고 적용은 호출자가 판단.
    function syncMargin(pos) {
        var cs = Number(pos.cs);
        var lev = Number(pos.lev);
        if (!(cs > 0) || !(lev >= 1)) return null;
        var base = Number(pos.price) * Number(pos.vol) * cs;
        if (!(base > 0)) return null;
        var target = Math.round((base / lev) * 100) / 100;
        var cur = Number(pos.margin) || 0;
        var refund = Math.round((cur - target) * 100) / 100;
        var p = Number(pos.price);
        return { margin: target, added: 0, refund: refund,
            liqLong: p * (1 - target / Math.max(base, 1e-9) + PAPER_MM),
            liqShort: p * (1 + target / Math.max(base, 1e-9) - PAPER_MM) };
    }
    function settleCalc(pos, exitPx) {
        var dir = (pos.side === 1 || pos.side === 4) ? 1 : -1;
        var pnl = (Number(exitPx) - pos.price) * pos.vol * pos.cs * dir;
        var feeOut = Number(exitPx) * pos.vol * pos.cs * PAPER_FEE;
        return { pnl: pnl, feeOut: feeOut, credit: pos.margin + pnl - feeOut };
    }

    // 실시간 체결가로 형성봉 갱신. 윈도우를 넘어서면 새 봉을 연다. candles 제자리 수정 + rolled 반환
    var TF_SEC = { Min15: 900, Min60: 3600, Hour4: 14400, Hour8: 28800, Hour12: 43200, Day1: 86400, Week1: 604800 };
    function nextCandle(candles, px, tSec, tf) {
        var win = TF_SEC[tf] || 3600;
        if (!Array.isArray(candles) || !candles.length || !(px > 0) || !(tSec > 0)) return { rolled: false };
        var last = candles[candles.length - 1];
        var w0 = Math.floor(tSec / win) * win;
        var lastW0 = Math.floor(last.time / win) * win;
        if (w0 > lastW0) {
            candles.push({ time: w0, open: px, high: px, low: px, close: px, vol: 0 });
            if (candles.length > 400) candles.splice(0, candles.length - 400);
            return { rolled: true };
        }
        if (px > last.high) last.high = px;
        if (px < last.low) last.low = px;
        last.close = px;
        return { rolled: false };
    }

    var TerminalAI = { VERSION: "1.4.0", normalizeFutures: normalizeFutures, dropForming: dropForming,
        resample: resample, roundToScale: roundToScale, runPipeline: runPipeline, runValidated: runValidated, validatedSignal: validatedSignal, pickTopSymbols: pickTopSymbols,
        openCalc: openCalc, settleCalc: settleCalc, PAPER_FEE: PAPER_FEE, nextCandle: nextCandle, TF_SEC: TF_SEC,
        effOf: effOf, syncMargin: syncMargin };
    global.TerminalAI = TerminalAI;
    if (typeof module !== "undefined" && module.exports) module.exports = TerminalAI;
})(typeof window !== "undefined" ? window : globalThis);
