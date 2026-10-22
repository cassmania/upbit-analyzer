/**
 * v41_analysis.js — 코인분석스킬 V4.1 호환 계층.
 *
 * 검증된 V3 구조 계산을 복제하지 않고 그대로 재사용한다. 이 계층은 버전,
 * 데이터 계약, 근거군과 가용성 상태를 명시해 화면과 브리핑이 V4.1 규칙을
 * 일관되게 사용할 수 있도록 한다.
 */
(function (global) {
    "use strict";

    const base = typeof module !== "undefined" && module.exports
        ? require("./v3_analysis.js")
        : global.V3Analysis;

    if (!base) throw new Error("V4.1 분석을 시작하려면 v3_analysis.js가 먼저 필요합니다.");

    function availability() {
        return {
            technical: "공식 거래소 OHLCV·완료봉 기준",
            vpvr: "OHLCV 고가~저가 범위분배 근사",
            derivatives: "Binance USDT-M 상장 종목만 보조자료 제공",
            usdt_d: "CoinGecko 현재값만 제공·시계열 방향 확인 불가",
            liquidation_cvd: "현재 실시간 데이터 확인 불가",
            onchain_whale: "현재 실시간 데이터 확인 불가",
            news_unlock: "현재 실시간 데이터 확인 불가"
        };
    }

    function analyze(tfCandles, ta) {
        const result = base.analyze(tfCandles, ta);
        result.version = "4.1.0";
        result.protocol = "crypto-master-analyst V4.1";
        result.evidence_groups = {
            priority: ["가격 구조", "거래량·유동성", "추세", "모멘텀", "변동성"],
            momentum_rule: "RSI·CCI·Stochastic·MACD는 중복 독립 근거로 합산하지 않음"
        };
        result.availability = availability();
        return result;
    }

    const V41Analysis = {
        VERSION: "4.1.0",
        confirmedPivots: base.confirmedPivots,
        fibonacci: base.fibonacci,
        fairValueGaps: base.fairValueGaps,
        structure: base.structure,
        regime: base.regime,
        availability: availability,
        analyze: analyze
    };

    global.V41Analysis = V41Analysis;
    if (typeof module !== "undefined" && module.exports) module.exports = V41Analysis;
})(typeof window !== "undefined" ? window : globalThis);
