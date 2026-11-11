/* 자동 생성 — 손으로 고치지 말 것. indicator-autotune 스킬(scripts/autotune.js)이 검증할 때마다 다시 쓴다. */
(function (g) {
  var A = {
    "asOf": "2026-11-11",
    "dataEnd": "2026-11-10",
    "status": "ok",
    "trainEnd": "2024-10-09",
    "lastTune": "2026-11-10",
    "weights": {
      "maGap": -0.22,
      "supertrend": 0.05,
      "ma200": 0.05,
      "rsi": 0.08,
      "macd": 0.07,
      "band": -0.1,
      "volume": -0.06
    },
    "weak": 0.2,
    "strong": 0.29,
    "numbers": {
      "hitWeak": 0.5228,
      "hitStrong": 0.5355,
      "base": 0.4946,
      "n": 5417,
      "recentHit": 0.5295,
      "recentBase": 0.4931,
      "recentN": 1915,
      "ruleR": 0.265,
      "ruleWin": 0.292,
      "ruleN": 4339,
      "ruleOnlyR": 0.199,
      "randomR": 0.053
    },
    "text": {
      "asOf": "2026-11-11",
      "hitWeak": "52.3% · 평소 49.5%",
      "hitStrong": "53.6% · 평소 49.5%",
      "ttl": "적중 52% · 평소 49.5%",
      "trustScore": "24봉 뒤 적중 52.3% · 평소 49.5% · 최근 180일 53.0%(평소 49.3%)",
      "rule": "+0.26R · 무작위 +0.05R",
      "ruleShort": "+0.26R",
      "ruleOnly": "+0.20R",
      "random": "+0.05R",
      "win": "29%",
      "trustRule": "+0.26R · 무작위 진입 +0.05R · 승률 29% (크게 이기고 자주 짐)",
      "term4h": "+0.24~0.36R · 승률 약 40%",
      "feed4h": "검증 +0.47R",
      "feed1h": "검증 +0.13R · 약함",
      "chip": "기준보다 높음",
      "cls": "ok",
      "chipCls": "up",
      "note": "2026-11-11 자동 검증 · 가중치를 정한 구간(8종목 4시간봉 ~2024-10-09) 밖의 기간·봉·종목 · 표본 5417건 · 가중치 마지막 조정 2026-11-10"
    }
  };
  g.INDICATOR_AUDIT = A;
  if (typeof module !== 'undefined' && module.exports) module.exports = A;
})(typeof window !== 'undefined' ? window : globalThis);
