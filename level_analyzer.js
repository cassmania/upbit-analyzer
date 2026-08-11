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
    var TF_WEIGHT = {
        "1h": 1.0, "2h": 1.1, "4h": 1.3, "6h": 1.4, "8h": 1.5, "12h": 1.7,
        "1d": 2.0, "3d": 2.2, "1w": 2.4, "1M": 2.7, "1y": 3.0
    };

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
    // 마지노선·천장으로 인정할 최대 거리. 월봉·주봉을 넣으면 상장 초기 가격까지
    // 후보에 들어와, 현재가 대비 -96% 같은 값이 "최후 방어선"으로 잡힌다.
    var FLOOR_MAX_GAP = 0.45;   // 현재가 -45%까지
    var CEIL_MAX_GAP = 1.20;    // 현재가 +120%까지 (상방은 여유를 더 준다)

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

        // Value Area는 POC에서 양옆으로 붙여가며 넓힌다(연속 구간 보장).
        // 예전처럼 상위 빈만 모아 min/max를 취하면 사이의 저거래 구간까지 들어가
        // VA가 전체 범위만큼 벌어진다. 표준은 POC 기준 확장이다.
        var vaMin = pocI, vaMax = pocI, acc = vol[pocI];
        while (acc < total * 0.7 && (vaMin > 0 || vaMax < bins - 1)) {
            var below = vaMin > 0 ? vol[vaMin - 1] : -1;
            var above = vaMax < bins - 1 ? vol[vaMax + 1] : -1;
            if (above >= below) { vaMax++; acc += vol[vaMax]; }
            else { vaMin--; acc += vol[vaMin]; }
        }

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

    /**
     * 한 타임프레임에서 후보 레벨을 근거 태그와 함께 뽑는다.
     *
     * price를 받는 이유: 스윙 피벗은 200봉에서 수십 개가 나와 전부 쓸 수 없는데,
     * 어느 것을 버릴지는 현재가를 알아야 정할 수 있다. 아래 swPick 주석 참고.
     * price가 없으면(테스트 등) 종가를 대신 쓴다.
     */
    function extract(candles, tf, price) {
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

        // 스윙은 200봉에서 수십 개가 나와 전부는 못 쓴다. 어느 것을 남길지가 문제다.
        //
        // 예전에는 고점은 내림차순, 저점은 오름차순으로 상위 6개를 잘랐다.
        // 그러면 구간 꼭대기 6개와 바닥 6개만 남고 현재가 근처는 통째로 버려진다.
        // 실제로 현재가 위에 "스윙저점"이 저항으로 뜨는 모순이 화면에 나왔다
        // (바닥권 저점만 살아남았는데, 이후 가격이 그 아래로 내려간 경우).
        //
        // 벽으로 의미 있는 건 극단값이 아니라 "지금 가격에서 곧 만날 것"이다.
        // 현재가에서 가까운 순으로 뽑는다.
        var 기준가 = isFiniteNum(price) && price > 0 ? price : norm[norm.length - 1].c;
        function swPick(list, n) {
            return list.slice().sort(function (a, b) {
                return Math.abs(a - 기준가) - Math.abs(b - 기준가);
            }).slice(0, n);
        }
        var swHi = swPick(sw.high, 6);
        var swLo = swPick(sw.low, 6);
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

        // 이웃 간 간격으로 자른다. "바로 옆 후보와 tol보다 더 벌어지면 다른 벽"이다.
        //
        // 예전에는 앵커(그룹 대표가)를 가중평균으로 계속 옮기면서 그 앵커 기준으로
        // 창을 쟀다. 앵커가 움직이니 창도 같이 끌려가서, 촘촘히 이어진 레벨이
        // 스캔 순서에 따라 임의의 위치에서 갈라졌다. 같은 벽인데 tfCount가
        // 반토막 나고 강도 등급이 낮게 나온다.
        //
        // 앵커를 첫 가격으로 고정하는 것만으로는 부족하다. 그러면 창 폭은 일정해도
        // 경계가 여전히 "창이 먼저 소진된 지점"에 생긴다 — 후보가 빽빽한 구간
        // 한가운데를 갈라놓을 수 있다.
        //
        // 이웃 간격으로 자르면 경계가 항상 실제로 비어 있는 곳에 생긴다.
        // 대표 가격(price)은 묶기가 끝난 뒤 가중평균으로 따로 계산한다.
        // 다만 이웃 간격만 보면 촘촘한 사슬이 끝없이 이어져 한 그룹이 지나치게
        // 넓어질 수 있다. 그룹 전체 폭은 tol의 3배까지만 허용한다.
        var 최대폭 = tol * 3;
        for (var i = 0; i < sorted.length; i++) {
            var lv = sorted[i];
            var prev = cur ? cur.items[cur.items.length - 1].price : 0;
            var 붙는다 = cur && prev > 0
                && Math.abs(lv.price - prev) / prev <= tol
                && Math.abs(lv.price - cur.base) / cur.base <= 최대폭;
            if (붙는다) {
                cur.items.push(lv);
            } else {
                cur = { base: lv.price, items: [lv] };
                groups.push(cur);
            }
        }

        // 점수 = Σ(근거가중 × 봉가중). 서로 다른 타임프레임 개수는 별도로 센다.
        for (var g = 0; g < groups.length; g++) {
            var grp = groups[g];
            var score = 0, tfs = {}, kinds = {}, psum = 0;
            for (var k = 0; k < grp.items.length; k++) {
                var it = grp.items[k];
                var w = (KIND_WEIGHT[it.kind] || 1) * (TF_WEIGHT[it.tf] || 1);
                score += w;
                psum += it.price * w;
                tfs[it.tf] = true;
                // 같은 봉에서 같은 종류가 여러 번이면 라벨은 한 번만
                kinds[it.tf + ":" + it.label] = it;
            }
            // 대표 가격 = 근거·봉 가중 평균. 무거운 근거(POC 등) 쪽으로 끌린다.
            grp.price = score > 0 ? psum / score : grp.base;
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
        var order = ["1h", "2h", "4h", "6h", "8h", "12h", "1d", "3d", "1w", "1M", "1y"];
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
        if (n >= 4) return { label: "최강 · " + n + "개 봉 일치", rank: 4 };
        if (n === 3) return { label: "강 · 3개 봉 일치", rank: 3 };
        if (n === 2) return { label: "중 · 2개 봉 일치", rank: 2 };
        if (group.hasPOC || group.hasFloor) return { label: "단일 봉 · 핵심", rank: 2 };
        return { label: "단일 봉", rank: 1 };
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
                var ex = extract(tfCandles[tf], tf, price);
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

            // 마지노선 = 최후 방어선. 현재가에서 너무 먼 값은 방어선 구실을 못한다.
            //
            // 월봉 200개는 상장 초기까지 닿는다. 그 시절 최저가(현재가 대비 -96% 같은 값)를
            // 마지노선이라 부르면 "이탈 시 지지 공백"이라는 의미가 사라진다.
            // FLOOR_MAX_GAP 안쪽에서 가장 낮은 것을 고르고, 전부 벗어나면
            // 그중 현재가에 가장 가까운 것으로 대체한다.
            var 후보바닥 = floors.filter(function (x) {
                return x.price >= price * (1 - FLOOR_MAX_GAP);
            });
            if (!후보바닥.length && floors.length) {
                후보바닥 = [floors.reduce(function (a, b) {
                    return b.price > a.price ? b : a;   // 가장 덜 먼 것
                })];
            }
            var 마지노선 = null, 천장 = null;
            for (var f = 0; f < 후보바닥.length; f++) {
                if (!마지노선 || 후보바닥[f].price < 마지노선.price) 마지노선 = 후보바닥[f];
            }

            // 천장도 같은 이유로 제한한다
            var 후보천장 = ceils.filter(function (x) {
                return x.price <= price * (1 + CEIL_MAX_GAP);
            });
            if (!후보천장.length && ceils.length) {
                후보천장 = [ceils.reduce(function (a, b) {
                    return b.price < a.price ? b : a;
                })];
            }
            for (var c = 0; c < 후보천장.length; c++) {
                if (!천장 || 후보천장[c].price > 천장.price) 천장 = 후보천장[c];
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
