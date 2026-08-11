/**
 * signal_engine.js — 롱·숏 진입/청산 타점 산출
 *
 * 화면에 이미 있는 값(다중 타임프레임 수렴도, 지지·저항 클러스터, ATR, 펀딩비)에서
 * **기계적 규칙**으로 타점을 뽑는다. 새로 예측하는 게 아니라, 흩어져 있는 근거를
 * "어디서 들어가고 어디서 자르고 어디서 나오나" 한 줄로 모으는 것이다.
 *
 * ⚠️ 이건 수익 예측이 아니다. 규칙 기반 산출값이고, 규칙이 틀리면 값도 틀린다.
 * 그래서 모든 타점에 **근거와 무효화 조건**을 같이 낸다. 근거 없이 숫자만 주면
 * 사용자가 검증할 수 없다.
 *
 * 설계 원칙:
 *   1. 조건 미달이면 신호를 만들지 않는다. "관망"이 정상 출력이다.
 *      억지로 타점을 짜내면 상시 신호가 되어 아무 의미가 없어진다.
 *   2. 손절은 **구조**(지지/저항 이탈)에 두고, ATR로 노이즈 여유만 준다.
 *      고정 퍼센트 손절은 변동성이 다른 종목에서 그대로 깨진다.
 *   3. 손익비(R)가 최소 기준에 못 미치면 진입 신호를 내지 않는다.
 *      승률이 아무리 좋아도 R이 나쁘면 장기적으로 잃는다.
 */
(function (global) {
    "use strict";

    // 진입 판정에 쓰는 타임프레임. 상위봉이 방향을 정하고 하위봉이 타이밍을 잡는다.
    var 방향봉 = ["4h", "12h", "1d"];   // 추세 방향
    var 타이밍봉 = "1h";                 // 진입 시점

    // 수렴도 임계값. |net_pct|가 이 아래면 방향성 자체를 신뢰하지 않는다.
    // ta_engine의 confluence는 40 이상을 "수렴"으로 본다. 진입은 더 보수적으로 간다.
    var 방향_최소 = 45;
    // 최소 손익비. 1차 목표 기준으로 이보다 낮으면 진입 안 한다.
    var 최소_R = 1.3;
    // 손절에 주는 ATR 배수 여유. 지지선 정확히 밑에 두면 꼬리 한 번에 털린다.
    var 손절_ATR = 0.5;
    // 진입가가 현재가에서 이보다 멀면 신호로 안 낸다.
    //
    // 벽이 멀리 있으면 손익비(R)는 자동으로 좋아진다. 진입 9,025 / 목표 10,050이면
    // R이 13이 나오지만, 현재가가 10,000이면 그 자리까지 -9.75% 빠져야 성립한다.
    // 지금 실행할 수 없는 계획이고, R만 보면 최상급 신호로 둔갑한다.
    // "지금 유효한 타점"만 신호로 취급한다.
    var 진입_최대이격 = 0.025;   // 현재가 ±2.5%

    function isNum(v) { return typeof v === "number" && isFinite(v); }

    /** 방향봉들의 수렴도를 합쳐 추세 방향과 강도를 낸다. */
    function 방향판정(results) {
        var 합 = 0, 표본 = 0, 상세 = [];
        방향봉.forEach(function (k) {
            var d = results[k];
            if (!d || d.error || !d.confluence) return;
            var net = d.confluence.net_pct;
            if (!isNum(net)) return;
            합 += net;
            표본++;
            상세.push({ tf: k, net: net, verdict: d.confluence.verdict });
        });
        if (!표본) return null;

        var 평균 = Math.round(합 / 표본);
        var dir = 평균 >= 방향_최소 ? "LONG" : 평균 <= -방향_최소 ? "SHORT" : "NONE";

        // 방향봉끼리 서로 반대를 보면 신뢰도를 깎는다.
        // (4h는 강세인데 1d는 약세면 어느 쪽으로도 확신할 수 없다)
        var 양수 = 상세.filter(function (x) { return x.net > 0; }).length;
        var 음수 = 상세.filter(function (x) { return x.net < 0; }).length;
        var 일치 = 표본 > 0 ? Math.max(양수, 음수) / 표본 : 0;

        return { dir: dir, avg: 평균, agree: Math.round(일치 * 100), tfs: 상세, n: 표본 };
    }

    /** 현재가 기준 가장 가까운 벽. levels 엔진 결과를 그대로 쓴다. */
    function 가까운벽(lv, price) {
        var 위 = null, 아래 = null;
        if (lv && Array.isArray(lv.resistance)) {
            위 = lv.resistance.filter(function (x) { return x.price > price; })[0] || null;
        }
        if (lv && Array.isArray(lv.support)) {
            아래 = lv.support.filter(function (x) { return x.price < price; })[0] || null;
        }
        return { 위: 위, 아래: 아래 };
    }

    /**
     * 진입 타점을 만든다.
     *
     * 롱: 아래 지지가 받쳐줄 때 눌림목 진입. 손절은 그 지지 아래.
     * 숏: 위 저항이 막을 때 되돌림 진입. 손절은 그 저항 위.
     *
     * 목표는 반대편 벽. 벽이 없으면 마지노선/천장을 쓴다.
     */
    function 진입설계(dir, price, lv, atr) {
        var 벽 = 가까운벽(lv, price);
        var 여유 = isNum(atr) && atr > 0 ? atr * 손절_ATR : price * 0.003;

        if (dir === "LONG") {
            var 지지 = 벽.아래;
            if (!지지) return null;   // 받쳐줄 게 없으면 손절 자리를 못 잡는다
            var 손절L = 지지.price - 여유;
            // 진입은 지지 살짝 위. 지지에 닿기 전에 반등하면 못 먹지만,
            // 지지 정확히 잡으려다 이탈에 물리는 것보다 낫다.
            var 진입L = 지지.price + 여유 * 0.5;
            var 목표1 = 벽.위 ? 벽.위.price : (lv && lv.천장 ? lv.천장.price : null);
            if (!isNum(목표1) || 목표1 <= 진입L) return null;
            var 리스크L = 진입L - 손절L;
            if (!(리스크L > 0)) return null;
            var 목표2 = null;
            if (lv && Array.isArray(lv.resistance) && lv.resistance.length > 1) {
                var 다음 = lv.resistance.filter(function (x) { return x.price > 목표1; })[0];
                if (다음) 목표2 = 다음.price;
            }
            return {
                side: "LONG",
                entry: 진입L, stop: 손절L, target1: 목표1, target2: 목표2,
                risk: 리스크L,
                rr: (목표1 - 진입L) / 리스크L,
                기준벽: 지지, 목표벽: 벽.위
            };
        }

        if (dir === "SHORT") {
            var 저항 = 벽.위;
            if (!저항) return null;
            var 손절S = 저항.price + 여유;
            var 진입S = 저항.price - 여유 * 0.5;
            var 목표1S = 벽.아래 ? 벽.아래.price : (lv && lv.마지노선 ? lv.마지노선.price : null);
            if (!isNum(목표1S) || 목표1S >= 진입S) return null;
            var 리스크S = 손절S - 진입S;
            if (!(리스크S > 0)) return null;
            var 목표2S = null;
            if (lv && Array.isArray(lv.support) && lv.support.length > 1) {
                var 다음S = lv.support.filter(function (x) { return x.price < 목표1S; })[0];
                if (다음S) 목표2S = 다음S.price;
            }
            return {
                side: "SHORT",
                entry: 진입S, stop: 손절S, target1: 목표1S, target2: 목표2S,
                risk: 리스크S,
                rr: (진입S - 목표1S) / 리스크S,
                기준벽: 저항, 목표벽: 벽.아래
            };
        }

        return null;
    }

    /** 타이밍봉이 진입을 지지하는지. 방향과 반대로 과열이면 진입을 미룬다. */
    function 타이밍확인(results, dir) {
        var d = results[타이밍봉];
        if (!d || d.error) return { ok: true, note: "타이밍봉 데이터 없음 — 확인 생략" };

        var rsi = d.oscillators ? d.oscillators.rsi14 : null;
        var st = d.trend ? d.trend.supertrend : null;

        if (dir === "LONG") {
            // 이미 과매수 구간이면 눌림목을 기다린다.
            if (isNum(rsi) && rsi >= 75) {
                return { ok: false, note: "1시간 RSI " + rsi + " 과열 — 눌림 대기" };
            }
            if (st && st.trend === "하락" && isNum(rsi) && rsi < 40) {
                return { ok: false, note: "1시간 하락 추세 진행 중 — 반등 확인 후 진입" };
            }
        } else if (dir === "SHORT") {
            if (isNum(rsi) && rsi <= 25) {
                return { ok: false, note: "1시간 RSI " + rsi + " 과매도 — 반등 대기" };
            }
            if (st && st.trend === "상승" && isNum(rsi) && rsi > 60) {
                return { ok: false, note: "1시간 상승 추세 진행 중 — 되돌림 확인 후 진입" };
            }
        }
        return { ok: true, note: null };
    }

    /**
     * 보유 중 청산 신호.
     * 진입가를 모르는 상태에서도 "지금 나가야 할 이유"는 판정할 수 있다.
     */
    function 청산판정(results, dir, price, lv) {
        var 사유 = [];
        var 방향 = 방향판정(results);

        // 1. 추세가 반대로 꺾였다 — 가장 강한 청산 사유
        if (방향) {
            if (dir === "LONG" && 방향.avg <= -방향_최소) {
                사유.push({ level: "긴급", text: "상위봉 수렴이 약세로 전환(" + 방향.avg + "%) — 롱 청산" });
            }
            if (dir === "SHORT" && 방향.avg >= 방향_최소) {
                사유.push({ level: "긴급", text: "상위봉 수렴이 강세로 전환(+" + 방향.avg + "%) — 숏 청산" });
            }
        }

        // 2. 목표 벽 도달 — 분할 청산 구간
        // 가격은 문자열로 굳히지 않고 price 필드로 넘긴다.
        // 여기서 toFixed로 찍으면 앱의 자릿수 포맷(fmt)을 못 타서
        // 89960883 같은 날숫자가 그대로 화면에 나간다.
        var 벽 = 가까운벽(lv, price);
        if (dir === "LONG" && 벽.위 && 벽.위.tfCount >= 3) {
            var 거리 = (벽.위.price - price) / price * 100;
            if (거리 <= 0.5) {
                사유.push({
                    level: "주의",
                    text: "다중 저항(" + 벽.위.tfCount + "개 봉) 도달 — 분할 익절 구간",
                    price: 벽.위.price
                });
            }
        }
        if (dir === "SHORT" && 벽.아래 && 벽.아래.tfCount >= 3) {
            var 거리S = (price - 벽.아래.price) / price * 100;
            if (거리S <= 0.5) {
                사유.push({
                    level: "주의",
                    text: "다중 지지(" + 벽.아래.tfCount + "개 봉) 도달 — 분할 익절 구간",
                    price: 벽.아래.price
                });
            }
        }

        // 3. 타이밍봉 과열/과매도 + 다이버전스
        var d1 = results[타이밍봉];
        if (d1 && !d1.error && d1.oscillators) {
            var rsi = d1.oscillators.rsi14;
            var dv = d1.oscillators.rsi_divergence;
            if (dir === "LONG" && isNum(rsi) && rsi >= 78) {
                사유.push({ level: "주의", text: "1시간 RSI " + rsi + " 과열 — 일부 익절 고려" });
            }
            if (dir === "SHORT" && isNum(rsi) && rsi <= 22) {
                사유.push({ level: "주의", text: "1시간 RSI " + rsi + " 과매도 — 일부 익절 고려" });
            }
            if (dv) {
                if (dir === "LONG" && dv.indexOf("약세") !== -1) {
                    사유.push({ level: "주의", text: "1시간 " + dv + " — 상승 동력 약화" });
                }
                if (dir === "SHORT" && dv.indexOf("강세") !== -1) {
                    사유.push({ level: "주의", text: "1시간 " + dv + " — 하락 동력 약화" });
                }
            }
        }

        return 사유;
    }

    var SignalEngine = {
        VERSION: "1.0.0",
        방향_최소: 방향_최소,
        최소_R: 최소_R,
        방향판정: 방향판정,
        진입설계: 진입설계,
        타이밍확인: 타이밍확인,
        청산판정: 청산판정,

        /**
         * 전체 신호 산출.
         * @param results TAEngine.analyzeTf 결과 맵 {tf: {...}}
         * @param lv      LevelEngine.analyze 결과
         * @param price   현재가
         * @param fut     선물 보조 데이터(펀딩비). 없으면 null.
         * @returns {dir, entry, exits, note}
         */
        analyze: function (results, lv, price, fut) {
            if (!results || !lv || lv.error || !isNum(price)) {
                return { error: "신호 산출에 필요한 데이터가 부족합니다." };
            }

            var 방향 = 방향판정(results);
            if (!방향) return { error: "상위 타임프레임 지표가 없습니다." };

            // ATR은 4시간봉 기준. 손절 여유의 단위가 된다.
            var atr = null;
            if (results["4h"] && !results["4h"].error && results["4h"].trend
                && results["4h"].trend.supertrend) {
                atr = results["4h"].trend.supertrend.atr;
            }

            var out = {
                price: price,
                방향: 방향,
                atr: atr,
                entry: null,
                blocked: null,
                exits: { long: [], short: [] },
                funding: fut && isNum(fut.funding) ? fut.funding : null
            };

            // 진입 신호
            if (방향.dir !== "NONE") {
                var 타이밍 = 타이밍확인(results, 방향.dir);
                var plan = 진입설계(방향.dir, price, lv, atr);

                var 이격 = plan ? Math.abs(plan.entry - price) / price : 0;

                if (!plan) {
                    out.blocked = 방향.dir === "LONG"
                        ? "아래 지지가 없어 손절 자리를 잡을 수 없습니다 — 진입 보류"
                        : "위 저항이 없어 손절 자리를 잡을 수 없습니다 — 진입 보류";
                } else if (이격 > 진입_최대이격) {
                    // R이 아무리 좋아도 지금 닿지 않는 가격이면 실행할 수 없는 계획이다.
                    out.blocked = "진입가가 현재가에서 " + (이격 * 100).toFixed(1)
                        + "% 떨어져 있습니다 — 그 자리까지 오면 다시 판정합니다";
                    out.rejected = plan;
                } else if (plan.rr < 최소_R) {
                    out.blocked = "손익비 " + plan.rr.toFixed(2) + "R — 최소 " + 최소_R + "R 미달로 진입 보류";
                    out.rejected = plan;
                } else if (!타이밍.ok) {
                    out.blocked = 타이밍.note;
                    out.rejected = plan;
                } else {
                    plan.타이밍 = 타이밍.note;
                    out.entry = plan;
                }
            } else {
                out.blocked = "상위봉 수렴 " + 방향.avg + "% — 방향성 부족(±" + 방향_최소 + "% 미만)으로 관망";
            }

            // 상위봉이 하나뿐이면 "다중 타임프레임 합의"라고 부를 수 없다.
            //
            // 신규 상장 코인은 12h·1d 이력이 없어 4h 하나만 잡히는데, 그 상태로
            // "일치율 100%"가 표시된다. 봉 하나의 수렴도를 여러 봉의 합의로
            // 오인하게 만드는 표기라, 진입 신호로는 쓰지 않는다.
            if (방향.n < 2 && out.entry) {
                out.rejected = out.entry;
                out.entry = null;
                out.blocked = "상위 타임프레임이 " + 방향.n + "개뿐입니다("
                    + 방향.tfs.map(function (x) { return x.tf; }).join(",")
                    + ") — 봉 간 합의를 확인할 수 없어 진입 보류";
            }

            // 청산 신호는 방향과 무관하게 양쪽 다 낸다.
            // 사용자가 어느 포지션을 들고 있는지 앱이 알 수 없기 때문이다.
            out.exits.long = 청산판정(results, "LONG", price, lv);
            out.exits.short = 청산판정(results, "SHORT", price, lv);

            return out;
        }
    };

    global.SignalEngine = SignalEngine;
    if (typeof module !== "undefined" && module.exports) module.exports = SignalEngine;
})(typeof window !== "undefined" ? window : globalThis);
