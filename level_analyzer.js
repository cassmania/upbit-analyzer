/**
 * level_analyzer.js — 다중 타임프레임 지지·저항 엔진
 *
 * coin-ta-brief 스킬의 레벨 선정 방법론을 이식한 것이다.
 * 기존 app.js의 계산매물대구간()은 단일 봉 VPVR만 봤다. 스킬의 핵심은
 * "여러 시간봉이 겹치는 레벨일수록 강하다"이고, 그 겹침 판정이 빠져 있었다.
 *
 * 우선순위 (스킬 3절):
 *   1. VPVR 매물대 (POC > VA 경계 > HVN)
 *   2. 스윙 고저
 *   3. 피보나치 되돌림 (VPVR과 겹치면 신뢰도 상승)
 *   4. 볼린저·MA 등 파생 레벨은 근거 병기용
 *
 * 강도 = 겹치는 타임프레임 수 + 근거 종류 가중. 4중 겹침이 최강.
 * 200봉 최저/최고는 마지노선 — 이탈 시 지지·저항 공백.
 */
(function (global) {
    "use strict";

    // 타임프레임별 가중치. 상위 봉의 벽이 더 두껍다.
    var TF_WEIGHT = { "1h": 1.0, "2h": 1.1, "4h": 1.3, "6h": 1.4, "8h": 1.5, "12h": 1.7, "1d": 2.0, "3d": 2.2, "1w": 2.4 };

    // 근거 종류별 가중치. 스킬 우선순위를 그대로 수치화한다.
    var KIND_WEIGHT = {
        POC: 3.0,        // 최대 거래 가격대 = 가장 두꺼운 벽
        마지노선: 2.8,    // 200봉 극값. 이탈 시 지지 공백
        VA: 2.0,         // 거래량 70% 구간 경계
        HVN: 1.6,        // 고밀도 매물대
        스윙: 1.2,        // 스윙 고저
        피보: 0.8         // 되돌림. 단독으로는 약하고 겹칠 때 의미
    };

    // 레벨 병합 허용 오차. 이 비율 안이면 같은 벽으로 본다.
    var MERGE_TOL = 0.0022;   // 0.22%
    // 현재가와 이만큼 안 떨어진 후보는 벽으로 치지 않는다(현재가에 붙은 노이즈 제거).
    var NEAR_GUARD = 0.0008;  // 0.08%

    function isFiniteNum(v) { return typeof v === "number" && isFinite(v); }

    /** 캔들 배열 정규화. {high,low,close,volume} / {h,l,c,v} 양쪽을 받는다. */
    function normalize(candles) {
        if (!Array.isArray(candles)) return [];
        var out = [];
        for (var i = 0; i < candles.length; i++) {
            var c = candles[i];
            if (!c) continue;
            var h = c.high !== undefined ? c.high : c.h;
            var l = c.low !== undefined ? c.low : c.l;
            var cl = c.close !== undefined ? c.close : c.c;
            var v = c.volume !== undefined ? c.volume : c.v;
            h = parseFloat(h); l = parseFloat(l); cl = parseFloat(cl); v = parseFloat(v);
            if (!isFiniteNum(h) || !isFiniteNum(l) || !isFiniteNum(cl)) continue;
            if (!isFiniteNum(v) || v < 0) v = 0;
            if (h < l) { var t = h; h = l; l = t; }
            out.push({ h: h, l: l, c: cl, v: v });
        }
        return out;
    }

    /**
     * 거래량 프로파일. analyze.py의 vpvr()과 동일한 계산이다.
     * Value Area는 거래량 상위 빈부터 채워 70%에 도달하는 구간의 최저~최고.
     */
    function vpvr(candles, bins) {
        bins = bins || 24;
        if (!candles.length) return null;
        var lo = Infinity, hi = -Infinity, i;
        for (i = 0; i < candles.length; i++) {
            if (candles[i].l < lo) lo = candles[i].l;
            if (candles[i].h > hi) hi = candles[i].h;
        }
        if (!(hi > lo)) return null;

        var step = (hi - lo) / bins;
        var vol = new Array(bins);
        for (i = 0; i < bins; i++) vol[i] = 0;

        var total = 0;
        for (i = 0; i < candles.length; i++) {
            var mid = (candles[i].h + candles[i].l + candles[i].c) / 3;
            var idx = Math.floor((mid - lo) / step);
            if (idx < 0) idx = 0;
            if (idx > bins - 1) idx = bins - 1;
            vol[idx] += candles[i].v;
            total += candles[i].v;
        }
        if (!(total > 0)) return null;

        var order = [];
        for (i = 0; i < bins; i++) order.push(i);
        order.sort(function (a, b) { return vol[b] - vol[a]; });

        var pocI = order[0];
        var acc = 0, va = [];
        for (i = 0; i < order.length; i++) {
            va.push(order[i]);
            acc += vol[order[i]];
            if (acc >= total * 0.7) break;
        }
        var vaMin = Math.min.apply(null, va), vaMax = Math.max.apply(null, va);

        // 상위 3개 빈을 가격 오름차순으로 — 고밀도 매물대(HVN)
        var top = order.slice(0, 3).sort(function (a, b) { return a - b; });
        var nodes = [];
        for (i = 0; i < top.length; i++) nodes.push(lo + step * (top[i] + 0.5));

        return {
            poc: lo + step * (pocI + 0.5),
            val: lo + step * vaMin,
            vah: lo + step * (vaMax + 1),
            hvn: nodes,
            low: lo,
            high: hi
        };
    }

    /** 좌우 k봉을 모두 이기는 로컬 극값 = 스윙 피벗. analyze.py swings()와 동일. */
    function swings(candles, k) {
        k = k || 2;
        var hi = [], lo = [];
        for (var i = k; i < candles.length - k; i++) {
            var isHi = true, isLo = true;
            for (var j = -k; j <= k; j++) {
                if (j === 0) continue;
                if (candles[i].h < candles[i + j].h) isHi = false;
                if (candles[i].l > candles[i + j].l) isLo = false;
                if (!isHi && !isLo) break;
            }
            if (isHi) hi.push(candles[i].h);
            if (isLo) lo.push(candles[i].l);
        }
        return { high: hi, low: lo };
    }

    /** 한 타임프레임에서 후보 레벨을 근거 태그와 함께 뽑는다. */
    function extract(candles, tf) {
        var norm = normalize(candles);
        if (norm.length < 20) return null;

        var i, out = [];
        var prof = vpvr(norm, 24);
        var sw = swings(norm, 2);

        var high = -Infinity, low = Infinity;
        for (i = 0; i < norm.length; i++) {
            if (norm[i].h > high) high = norm[i].h;
            if (norm[i].l < low) low = norm[i].l;
        }
        var rng = high - low;
        if (!(rng > 0)) return null;

        function push(price, kind, label) {
            if (!isFiniteNum(price) || price <= 0) return;
            out.push({ price: price, kind: kind, label: label, tf: tf });
        }

        if (prof) {
            push(prof.poc, "POC", "POC");
            push(prof.val, "VA", "VA하단");
            push(prof.vah, "VA", "VA상단");
            for (i = 0; i < prof.hvn.length; i++) {
                // POC와 사실상 같은 빈은 중복이라 뺀다
                if (Math.abs(prof.hvn[i] - prof.poc) / prof.poc > MERGE_TOL) push(prof.hvn[i], "HVN", "HVN");
            }
        }

        // 200봉 극값 = 마지노선. 이탈하면 그 아래로 지지가 없다.
        push(high, "마지노선", norm.length + "봉 최고");
        push(low, "마지노선", norm.length + "봉 최저");

        // 스윙은 개수가 많아 상위만 쓴다. 가격 내림/오름차순 끝단이 의미 있는 벽이다.
        var swHi = sw.high.slice().sort(function (a, b) { return b - a; }).slice(0, 6);
        var swLo = sw.low.slice().sort(function (a, b) { return a - b; }).slice(0, 6);
        for (i = 0; i < swHi.length; i++) push(swHi[i], "스윙", "스윙고점");
        for (i = 0; i < swLo.length; i++) push(swLo[i], "스윙", "스윙저점");

        var ratios = [0.236, 0.382, 0.5, 0.618, 0.786];
        for (i = 0; i < ratios.length; i++) {
            push(high - rng * ratios[i], "피보", "피보 " + ratios[i]);
        }

        return { levels: out, high: high, low: low, poc: prof ? prof.poc : null, bars: norm.length };
    }

    /**
     * 여러 타임프레임의 후보를 가격 근접도로 묶는다.
     * 겹치는 봉이 많을수록 강한 벽 — 스킬 강도 판정의 핵심.
     */
    function cluster(all, tol) {
        tol = tol || MERGE_TOL;
        var sorted = all.slice().sort(function (a, b) { return a.price - b.price; });
        var groups = [], cur = null;

        for (var i = 0; i < sorted.length; i++) {
            var lv = sorted[i];
            if (cur && Math.abs(lv.price - cur.anchor) / cur.anchor <= tol) {
                cur.items.push(lv);
                // 앵커는 가중 평균으로 계속 보정한다
                var wsum = 0, psum = 0;
                for (var j = 0; j < cur.items.length; j++) {
                    var w = (KIND_WEIGHT[cur.items[j].kind] || 1) * (TF_WEIGHT[cur.items[j].tf] || 1);
                    wsum += w; psum += cur.items[j].price * w;
                }
                cur.anchor = psum / wsum;
            } else {
                cur = { anchor: lv.price, items: [lv] };
                groups.push(cur);
            }
        }

        // 점수 = Σ(근거가중 × 봉가중). 서로 다른 타임프레임 개수는 별도로 센다.
        for (var g = 0; g < groups.length; g++) {
            var grp = groups[g];
            var score = 0, tfs = {}, kinds = {};
            for (var k = 0; k < grp.items.length; k++) {
                var it = grp.items[k];
                score += (KIND_WEIGHT[it.kind] || 1) * (TF_WEIGHT[it.tf] || 1);
                tfs[it.tf] = true;
                // 같은 봉에서 같은 종류가 여러 번이면 라벨은 한 번만
                kinds[it.tf + ":" + it.label] = it;
            }
            grp.price = grp.anchor;
            grp.score = score;
            grp.tfCount = Object.keys(tfs).length;
            grp.tfList = Object.keys(tfs);
            grp.reasons = Object.keys(kinds).map(function (key) { return kinds[key]; });
            grp.hasPOC = grp.items.some(function (x) { return x.kind === "POC"; });
            grp.hasFloor = grp.items.some(function (x) { return x.kind === "마지노선"; });
        }
        return groups;
    }

    /** 근거를 사람이 읽는 한 줄로. "4h POC · 1d VA하단" 형태. */
    function describe(group) {
        var byTf = {};
        for (var i = 0; i < group.reasons.length; i++) {
            var r = group.reasons[i];
            if (!byTf[r.tf]) byTf[r.tf] = [];
            if (byTf[r.tf].indexOf(r.label) === -1) byTf[r.tf].push(r.label);
        }
        var order = ["1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w"];
        var parts = [];
        for (var j = 0; j < order.length; j++) {
            if (byTf[order[j]]) parts.push(order[j] + " " + byTf[order[j]].join("/"));
        }
        // 정의된 순서 밖의 봉도 흘리지 않는다
        Object.keys(byTf).forEach(function (tf) {
            if (order.indexOf(tf) === -1) parts.push(tf + " " + byTf[tf].join("/"));
        });
        return parts.join(" · ");
    }

    /** 겹침 수를 등급 문자열로. 스킬의 "4중 겹침 = 최강"을 그대로 표기한다. */
    function strength(group) {
        var n = group.tfCount;
        if (n >= 4) return { label: "최강 " + n + "중 겹침", rank: 4 };
        if (n === 3) return { label: "강 3중 겹침", rank: 3 };
        if (n === 2) return { label: "중 2중 겹침", rank: 2 };
        if (group.hasPOC || group.hasFloor) return { label: "단일봉 핵심", rank: 2 };
        return { label: "단일봉", rank: 1 };
    }

    var LevelEngine = {
        VERSION: "1.0.0",
        TF_WEIGHT: TF_WEIGHT,
        KIND_WEIGHT: KIND_WEIGHT,
        vpvr: vpvr,
        swings: swings,
        extract: extract,
        cluster: cluster,

        /**
         * @param {Object} tfCandles  { "1h": [...], "4h": [...], "12h": [...], "1d": [...] }
         * @param {number} price      현재가
         * @param {Object} opt        { limit: 표시 개수 }
         * @returns {Object} { resistance:[], support:[], 마지노선, 천장, poc, 경고:[] }
         */
        analyze: function (tfCandles, price, opt) {
            opt = opt || {};
            var limit = opt.limit || 6;

            if (!isFiniteNum(price) || price <= 0) {
                return { error: "현재가가 유효하지 않습니다." };
            }

            var all = [], used = [], floors = [], ceils = [], pocs = [];
            var tfKeys = Object.keys(tfCandles || {});
            for (var i = 0; i < tfKeys.length; i++) {
                var tf = tfKeys[i];
                var ex = extract(tfCandles[tf], tf);
                if (!ex) continue;
                all = all.concat(ex.levels);
                used.push({ tf: tf, bars: ex.bars });
                floors.push({ tf: tf, price: ex.low });
                ceils.push({ tf: tf, price: ex.high });
                if (ex.poc) pocs.push({ tf: tf, price: ex.poc });
            }

            if (!all.length) {
                return { error: "레벨 산출에 필요한 캔들이 부족합니다. (봉당 20개 이상 필요)" };
            }

            var groups = cluster(all, MERGE_TOL);

            var res = [], sup = [];
            for (var g = 0; g < groups.length; g++) {
                var grp = groups[g];
                var gap = (grp.price - price) / price;
                var row = {
                    price: grp.price,
                    score: grp.score,
                    tfCount: grp.tfCount,
                    tfList: grp.tfList,
                    reason: describe(grp),
                    strength: strength(grp),
                    거리pct: gap * 100,
                    hasPOC: grp.hasPOC,
                    hasFloor: grp.hasFloor
                };
                // 이탈한 지지는 저항으로, 돌파한 저항은 지지로 — 현재가 기준으로만 가른다
                if (gap > NEAR_GUARD) res.push(row);
                else if (gap < -NEAR_GUARD) sup.push(row);
            }

            res.sort(function (a, b) { return a.price - b.price; });   // 가까운 위부터
            sup.sort(function (a, b) { return b.price - a.price; });   // 가까운 아래부터

            // 가장 낮은 마지노선 = 전체 구조의 최후 방어선
            var 마지노선 = null, 천장 = null;
            for (var f = 0; f < floors.length; f++) {
                if (!마지노선 || floors[f].price < 마지노선.price) 마지노선 = floors[f];
            }
            for (var c = 0; c < ceils.length; c++) {
                if (!천장 || ceils[c].price > 천장.price) 천장 = ceils[c];
            }

            var 경고 = [];
            if (!res.length) 경고.push("현재가가 전 구간 최고 위 — 저항 공백 상태");
            if (!sup.length) 경고.push("현재가가 전 구간 최저 아래 — 지지 공백 상태");
            if (마지노선 && price <= 마지노선.price * 1.005) {
                경고.push("마지노선(" + 마지노선.tf + " 최저) 근접 — 이탈 시 지지 공백");
            }
            if (used.length < 2) {
                경고.push("타임프레임 1개만 계산됨 — 겹침 강도 판정 불가");
            }

            return {
                price: price,
                resistance: res.slice(0, limit),
                support: sup.slice(0, limit),
                마지노선: 마지노선,
                천장: 천장,
                pocs: pocs,
                사용봉: used,
                경고: 경고,
                // 직상/직하 벽. 기존 project-levels 문구 대체용
                직상: res.length ? res[0] : null,
                직하: sup.length ? sup[0] : null
            };
        }
    };

    global.LevelEngine = LevelEngine;
    if (typeof module !== "undefined" && module.exports) module.exports = LevelEngine;
})(typeof window !== "undefined" ? window : globalThis);
