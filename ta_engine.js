/**
 * ta_engine.js — coin-ta-brief 스킬의 기술분석 로직 이식 (JS)
 *
 * 원본: C:/Users/Administrator/.claude/skills/coin-ta-brief/analyze.py
 * 계산식을 그대로 옮겼다. 임의로 개선하지 않는다 — 스킬 브리핑과 숫자가
 * 어긋나면 둘 중 뭐가 맞는지 판단할 수 없게 된다.
 *
 * 캔들 형식: [{o, h, l, c, v}]  (과거 -> 최신 순)
 */
(function (global) {
    "use strict";

    // ---------------------------------------------------------------- 기본

    function rp(x) {
        // 원본 rp(): 가격대별로 유효자릿수를 다르게 반올림한다.
        // 업비트 KRW는 억 단위까지 가므로 큰 수 구간을 추가했다.
        if (x === null || x === undefined || !isFinite(x)) return null;
        const a = Math.abs(x);
        if (a >= 1e7) return Math.round(x);
        if (a >= 1e4) return Math.round(x * 10) / 10;
        if (a >= 100) return Math.round(x * 100) / 100;
        if (a >= 1) return Math.round(x * 10000) / 10000;
        return Math.round(x * 1e8) / 1e8;
    }

    function sma(vals, n) {
        if (vals.length < n) return null;
        let s = 0;
        for (let i = vals.length - n; i < vals.length; i++) s += vals[i];
        return s / n;
    }

    function ema(vals, n) {
        if (vals.length < n) return null;
        const k = 2 / (n + 1);
        let e = sma(vals.slice(0, n), n);
        for (let i = n; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
        return e;
    }

    // ---------------------------------------------------------------- 오실레이터

    function rsi(closes, n) {
        n = n || 14;
        if (closes.length < n + 1) return null;
        let g = 0, l = 0;
        for (let i = closes.length - n; i < closes.length; i++) {
            const d = closes[i] - closes[i - 1];
            if (d > 0) g += d; else l += -d;
        }
        if (l === 0) return 100.0;
        const rs = (g / n) / (l / n);
        return Math.round((100 - 100 / (1 + rs)) * 10) / 10;
    }

    function rsiSeries(closes, n) {
        n = n || 14;
        const out = [];
        for (let i = 0; i < closes.length; i++) out.push(rsi(closes.slice(0, i + 1), n));
        return out;
    }

    function stoch(candles, k, d) {
        k = k || 14; d = d || 3;
        if (candles.length < k + d) return null;
        const ks = [];
        for (let i = k - 1; i < candles.length; i++) {
            const win = candles.slice(i - k + 1, i + 1);
            let hi = -Infinity, lo = Infinity;
            for (const c of win) { if (c.h > hi) hi = c.h; if (c.l < lo) lo = c.l; }
            const c = candles[i].c;
            ks.push(hi !== lo ? 100 * (c - lo) / (hi - lo) : 50.0);
        }
        const kv = ks[ks.length - 1];
        const dv = ks.slice(-d).reduce((a, b) => a + b, 0) / d;
        return { k: Math.round(kv * 10) / 10, d: Math.round(dv * 10) / 10 };
    }

    function cci(candles, n) {
        n = n || 20;
        if (candles.length < n) return null;
        const tp = candles.slice(-n).map(c => (c.h + c.l + c.c) / 3);
        const ma = tp.reduce((a, b) => a + b, 0) / n;
        const md = tp.reduce((a, x) => a + Math.abs(x - ma), 0) / n;
        if (md === 0) return 0.0;
        return Math.round((tp[tp.length - 1] - ma) / (0.015 * md) * 10) / 10;
    }

    function macd(closes) {
        const e12 = ema(closes, 12), e26 = ema(closes, 26);
        if (e12 === null || e26 === null) return null;
        const line = e12 - e26;
        if (closes.length < 35) return { macd: rp(line), signal: null, hist: null };
        const hist = [];
        for (let i = 26; i <= closes.length; i++) {
            const a = ema(closes.slice(0, i), 12), b = ema(closes.slice(0, i), 26);
            if (a !== null && b !== null) hist.push(a - b);
        }
        const sig = ema(hist, 9);
        return {
            macd: rp(line),
            signal: sig !== null ? rp(sig) : null,
            hist: sig !== null ? rp(line - sig) : null
        };
    }

    function bollinger(closes, n, k) {
        n = n || 20; k = k || 2;
        if (closes.length < n) return null;
        const m = sma(closes, n);
        const win = closes.slice(-n);
        const varr = win.reduce((a, x) => a + (x - m) * (x - m), 0) / n;
        const sd = Math.sqrt(varr);
        const up = m + k * sd, lo = m - k * sd;
        const price = closes[closes.length - 1];
        const pctb = up !== lo ? (price - lo) / (up - lo) : 0.5;
        return {
            upper: rp(up), mid: rp(m), lower: rp(lo),
            pct_b: Math.round(pctb * 1000) / 1000,
            bandwidth_pct: Math.round((up - lo) / m * 100 * 100) / 100
        };
    }

    // ---------------------------------------------------------------- 추세

    function atr(candles, n) {
        n = n || 14;
        if (candles.length < n + 1) return null;
        const trs = [];
        for (let i = 1; i < candles.length; i++) {
            const h = candles[i].h, l = candles[i].l, pc = candles[i - 1].c;
            trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
        }
        return trs.slice(-n).reduce((a, b) => a + b, 0) / n;
    }

    function supertrend(candles, n, mult) {
        n = n || 10; mult = mult || 3.0;
        if (candles.length < n + 2) return null;
        const a = atr(candles, n);
        if (!a) return null;
        const last = candles[candles.length - 1];
        const hl2 = (last.h + last.l) / 2;
        // 원본과 동일: 종가가 hl2 위면 상승. 밴드는 표시용.
        return {
            trend: last.c > hl2 ? "상승" : "하락",
            atr: rp(a),
            up_band: rp(hl2 - mult * a),
            dn_band: rp(hl2 + mult * a)
        };
    }

    function vwap(candles) {
        let num = 0, den = 0;
        for (const c of candles) {
            const tp = (c.h + c.l + c.c) / 3;
            num += tp * c.v; den += c.v;
        }
        return den ? rp(num / den) : null;
    }

    function trend(candles) {
        const closes = candles.map(c => c.c);
        const price = closes[closes.length - 1];
        const ma = {};
        for (const p of [20, 60, 120, 200]) {
            const v = sma(closes, p);
            ma[p] = v !== null ? rp(v) : null;
        }
        const r = rsi(closes), st = supertrend(candles);
        let score = 0;
        const sig = [];
        if (ma[20] && ma[60] && ma[120]) {
            if (price > ma[20] && ma[20] > ma[60] && ma[60] > ma[120]) {
                score += 2; sig.push("정배열(가격>20>60>120)");
            } else if (price < ma[20] && ma[20] < ma[60] && ma[60] < ma[120]) {
                score -= 2; sig.push("역배열(가격<20<60<120)");
            } else if (price > ma[20]) {
                score += 1; sig.push("MA20 상회");
            } else {
                score -= 1; sig.push("MA20 하회");
            }
        }
        if (ma[200]) {
            if (price > ma[200]) { score += 1; sig.push("200일선 상회(장기 강세)"); }
            else { score -= 1; sig.push("200일선 하회(장기 약세)"); }
        }
        if (st) {
            score += st.trend === "상승" ? 1 : -1;
            sig.push("슈퍼트렌드 " + st.trend);
        }
        if (r !== null) {
            if (r >= 70) { score -= 1; sig.push("RSI " + r + " 과매수"); }
            else if (r <= 30) { score += 1; sig.push("RSI " + r + " 과매도"); }
            else sig.push("RSI " + r + " 중립");
        }
        const label = score >= 3 ? "강세" : score <= -3 ? "약세" : "중립/횡보";
        return { bias: label, score: score, ma: ma, rsi14: r, supertrend: st, signals: sig };
    }

    // ---------------------------------------------------------------- 레벨

    function swings(candles, k) {
        k = k || 2;
        const hi = [], lo = [];
        for (let i = k; i < candles.length - k; i++) {
            let isHi = true, isLo = true;
            for (let j = -k; j <= k; j++) {
                if (j === 0) continue;
                if (candles[i].h < candles[i + j].h) isHi = false;
                if (candles[i].l > candles[i + j].l) isLo = false;
            }
            if (isHi) hi.push(candles[i].h);
            if (isLo) lo.push(candles[i].l);
        }
        return { high: hi, low: lo };
    }

    function vpvr(candles, bins) {
        bins = bins || 24;
        let lo = Infinity, hi = -Infinity;
        for (const c of candles) { if (c.l < lo) lo = c.l; if (c.h > hi) hi = c.h; }
        if (hi === lo) return null;
        const step = (hi - lo) / bins;
        const vol = new Array(bins).fill(0);
        for (const c of candles) {
            const mid = (c.h + c.l + c.c) / 3;
            const idx = Math.min(Math.floor((mid - lo) / step), bins - 1);
            vol[idx] += c.v;
        }
        const total = vol.reduce((a, b) => a + b, 0);
        if (!(total > 0)) return null;

        const order = vol.map((_, i) => i).sort((a, b) => vol[b] - vol[a]);
        const pocI = order[0];
        let acc = 0;
        const va = [];
        for (const i of order) {
            va.push(i); acc += vol[i];
            if (acc >= total * 0.7) break;
        }
        const top = order.slice(0, 3).sort((a, b) => a - b);
        return {
            poc: rp(lo + step * (pocI + 0.5)),
            value_area_low: rp(lo + step * Math.min(...va)),
            value_area_high: rp(lo + step * (Math.max(...va) + 1)),
            hvn_nodes: top.map(i => rp(lo + step * (i + 0.5)))
        };
    }

    function levels(candles, price) {
        const highs = candles.map(c => c.h), lows = candles.map(c => c.l);
        const ph = Math.max(...highs), pl = Math.min(...lows);
        const rng = ph - pl;
        const sw = swings(candles);
        const fib = {};
        for (const r of [0.236, 0.382, 0.5, 0.618, 0.786]) fib[String(r)] = rp(ph - rng * r);
        const prof = vpvr(candles);

        const cand = new Set([...sw.high, ...sw.low, ph, pl, ...Object.values(fib)]);
        if (prof) {
            cand.add(prof.poc); cand.add(prof.value_area_low); cand.add(prof.value_area_high);
            prof.hvn_nodes.forEach(n => cand.add(n));
        }
        const arr = [...cand].map(rp).filter(x => x !== null);
        return {
            period_high: rp(ph), period_low: rp(pl),
            resistance: arr.filter(x => x > price * 1.001).sort((a, b) => a - b).slice(0, 5),
            support: arr.filter(x => x < price * 0.999).sort((a, b) => b - a).slice(0, 5),
            fib: fib, vpvr: prof
        };
    }

    // ---------------------------------------------------------------- 패턴/검증

    function rsiDivergence(candles, closes) {
        const rs = rsiSeries(closes);
        if (candles.length < 20 || !rs[rs.length - 1]) return null;
        const lowsIdx = [], highsIdx = [];
        for (let i = 2; i < candles.length - 2; i++) {
            if (candles[i].l <= candles[i - 1].l && candles[i].l <= candles[i + 1].l) lowsIdx.push(i);
            if (candles[i].h >= candles[i - 1].h && candles[i].h >= candles[i + 1].h) highsIdx.push(i);
        }
        let msg = null;
        if (lowsIdx.length >= 2) {
            const a = lowsIdx[lowsIdx.length - 2], b = lowsIdx[lowsIdx.length - 1];
            if (rs[a] && rs[b] && candles[b].l < candles[a].l && rs[b] > rs[a]) {
                msg = "강세 다이버전스(가격 저점↓·RSI↑)";
            }
        }
        if (highsIdx.length >= 2) {
            const a = highsIdx[highsIdx.length - 2], b = highsIdx[highsIdx.length - 1];
            if (rs[a] && rs[b] && candles[b].h > candles[a].h && rs[b] < rs[a]) {
                msg = (msg ? msg + " / " : "") + "약세 다이버전스(가격 고점↑·RSI↓)";
            }
        }
        return msg;
    }

    function candlePattern(candles) {
        if (candles.length < 3) return null;
        const c = candles[candles.length - 1], p = candles[candles.length - 2];
        const o = c.o, h = c.h, l = c.l, cl = c.c;
        const body = Math.abs(cl - o), rng = h - l;
        if (rng === 0) return null;
        const upWick = h - Math.max(o, cl), dnWick = Math.min(o, cl) - l;
        const bull = cl > o;
        const pats = [];
        if (body <= rng * 0.1) pats.push("도지(추세 피로·반전 경계)");
        if (dnWick >= body * 2 && upWick <= body * 0.6 && body <= rng * 0.4) {
            pats.push("망치형(하방 지지·반등 신호)");
        }
        if (upWick >= body * 2 && dnWick <= body * 0.6 && body <= rng * 0.4) {
            pats.push("역망치/유성형(상방 저항·하락 경계)");
        }
        if (body >= rng * 0.7) pats.push(bull ? "장대양봉(강한 매수)" : "장대음봉(강한 매도)");
        const pHi = Math.max(p.o, p.c), pLo = Math.min(p.o, p.c);
        if (bull && cl >= pHi && o <= pLo && p.c < p.o) pats.push("강세 삼킴형(반등 신호)");
        if (!bull && o >= pHi && cl <= pLo && p.c > p.o) pats.push("약세 삼킴형(하락 신호)");
        return pats.length ? pats : null;
    }

    function volumeCheck(vols, priceUp) {
        const a = sma(vols, 20);
        if (!a || a <= 0) return null;
        const surge = vols[vols.length - 1] / a;
        let conf;
        if (surge >= 1.5) conf = priceUp ? "높음(대량 거래 동반)" : "높음(대량 매도)";
        else if (surge >= 0.8) conf = "보통";
        else conf = "낮음(거래량 빈약·가짜 움직임 경계)";
        return { surge: Math.round(surge * 100) / 100, confirmation: conf };
    }

    function confluence(tf) {
        let bull = 0, bear = 0;
        const notes = [];
        const tr = tf.trend, osc = tf.oscillators, bb = tf.bollinger;
        if (tr.score >= 2) { bull += 2; notes.push("추세 강세"); }
        else if (tr.score <= -2) { bear += 2; notes.push("추세 약세"); }

        const r = osc.rsi14;
        if (r !== null) {
            if (r >= 70) { bear += 1; notes.push("RSI 과매수"); }
            else if (r <= 30) { bull += 1; notes.push("RSI 과매도"); }
        }
        if (osc.stochastic) {
            if (osc.stochastic.k >= 80) bear += 1;
            else if (osc.stochastic.k <= 20) bull += 1;
        }
        if (osc.cci20 !== null && osc.cci20 !== undefined) {
            if (osc.cci20 >= 100) bear += 1;
            else if (osc.cci20 <= -100) bull += 1;
        }
        if (osc.macd && osc.macd.hist !== null && osc.macd.hist !== undefined) {
            if (osc.macd.hist > 0) bull += 1; else bear += 1;
        }
        if (bb) {
            if (bb.pct_b >= 1) { bear += 1; notes.push("볼린저 상단 과열"); }
            else if (bb.pct_b <= 0) { bull += 1; notes.push("볼린저 하단 과매도"); }
        }
        const dv = osc.rsi_divergence;
        if (dv) {
            if (dv.indexOf("강세") !== -1) bull += 1;
            if (dv.indexOf("약세") !== -1) bear += 1;
        }
        const total = bull + bear;
        const net = total ? Math.round((bull - bear) / total * 100) : 0;
        const verdict = net >= 40 ? "강세 수렴" : net <= -40 ? "약세 수렴" : "혼조/중립";
        return {
            bull_signals: bull, bear_signals: bear, net_pct: net, verdict: verdict,
            notes: notes,
            volume_reliability: tf.volume && tf.volume.reliability ? tf.volume.reliability : null
        };
    }

    // ---------------------------------------------------------------- 통합

    function analyzeTf(candles) {
        if (!candles || candles.length < 30) return { error: "캔들 부족 (30개 이상 필요)" };
        const closes = candles.map(c => c.c);
        const vols = candles.map(c => c.v);
        const price = closes[closes.length - 1];
        const priceUp = candles.length > 1 && price >= closes[closes.length - 2];

        const vc = volumeCheck(vols, priceUp);
        const out = {
            price: rp(price),
            candles: candles.length,
            trend: trend(candles),
            levels: levels(candles, price),
            oscillators: {
                rsi14: rsi(closes),
                rsi_divergence: rsiDivergence(candles, closes),
                stochastic: stoch(candles),
                cci20: cci(candles),
                macd: macd(closes)
            },
            bollinger: bollinger(closes),
            vwap: vwap(candles),
            candle_pattern: candlePattern(candles),
            volume: {
                last: vols[vols.length - 1],
                avg20: rp(sma(vols, 20)),
                surge: vc ? vc.surge : null,
                reliability: vc ? vc.confirmation : null
            }
        };
        out.confluence = confluence(out);
        return out;
    }

    const TAEngine = {
        VERSION: "1.0.0",
        rp, sma, ema, rsi, rsiSeries, stoch, cci, macd, bollinger,
        atr, supertrend, vwap, trend,
        swings, vpvr, levels,
        rsiDivergence, candlePattern, volumeCheck, confluence,
        analyzeTf
    };

    global.TAEngine = TAEngine;
    if (typeof module !== "undefined" && module.exports) module.exports = TAEngine;
})(typeof window !== "undefined" ? window : globalThis);
