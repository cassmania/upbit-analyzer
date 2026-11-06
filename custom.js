/* 트레이딩 챠트 — 자체 지표 1·2·3위
 * 2026-11-06 연구: 기존 11종 + 후보 8계열 30여 변형을 사이트와 같은 규칙
 * (봉 마감 신호 → 다음 봉 시가, 수수료 편도 0.1%, 2.5×ATR 손절, 반대 신호 청산)으로
 * 바이낸스 8종목 × 1h·4h·12h·1d(앞 절반 개발 / 뒤 절반 검증)와 4h 4년치(2022-09~)에서 비교.
 * 무작위 진입 기준선을 두 구간 모두 넘은 추세 계열 3종을 골랐다. 15분봉은 수수료 때문에 전부 손실.
 * 연구 코드: 클로드/사이트-백테스트-비교/lab.js · candidates.js
 */
(function (root) {
  'use strict';
  const E = typeof module !== 'undefined' && module.exports ? require('./indicator_engine.js') : root.Engine;
  const cl = b => b.map(x => x.close);
  const edge = st => st.map((v, i) => i > 0 && v && !st[i - 1]);
  const flip = (dir, i, v) => i > 0 && dir[i] === v && dir[i - 1] === -v;

  const LIST = [
    {
      id: 'c1', rank: 1, name: '추세 합의', kind: '자체·추세',
      desc: 'EMA50 위·EMA20>50·슈퍼트렌드·MACD 히스토그램·EMA200 위, 5개가 모두 같은 방향이고 ADX≥20이면 진입. 4개 이상이 반대로 돌아서면 청산',
      lab: '검증 기대값 +0.35R · 승률 29% · 종목·봉 69%가 수익 (4h 4년치 +0.51R)',
      build(b) {
        const c = cl(b), e20 = E.ema(c, 20), e50 = E.ema(c, 50), e200 = E.ema(c, 200), st = E.supertrend(b, 10, 3), m = E.macd(b), d = E.adx(b, 14);
        const S = b.map((x, i) => e200[i] == null || st.dir[i] == null || m.hist[i] == null ? null
          : (x.close > e50[i] ? 1 : -1) + (e20[i] > e50[i] ? 1 : -1) + st.dir[i] + (m.hist[i] > 0 ? 1 : -1) + (x.close > e200[i] ? 1 : -1));
        return {
          long: edge(S.map((v, i) => v === 5 && d.adx[i] >= 20)), xl: S.map(v => v != null && v <= -3),
          short: edge(S.map((v, i) => v === -5 && d.adx[i] >= 20)), xs: S.map(v => v != null && v >= 3),
          overlay: [{ type: 'line', name: 'EMA 50', data: e50, color: 'accent' }, { type: 'line', name: 'EMA 200', data: e200, color: 'violet' }],
          osc: { type: 'score', data: S }
        };
      }
    },
    {
      id: 'c2', rank: 2, name: '터틀 돌파 40/15', kind: '자체·돌파',
      desc: 'EMA200 위에서 직전 40봉 고점을 종가로 돌파하면 매수, 직전 15봉 저점을 이탈하면 청산 (숏은 반대)',
      lab: '검증 기대값 +0.24R · 승률 31% · 종목·봉 63%가 수익 (4h 4년치 +0.32R)',
      build(b) {
        const c = cl(b), e200 = E.ema(c, 200), d40 = E.donchian(b, 40), d15 = E.donchian(b, 15);
        const p = (a, i) => i > 0 ? a[i - 1] : null;
        return {
          long: b.map((x, i) => p(d40.upper, i) != null && e200[i] != null && x.close > p(d40.upper, i) && x.close > e200[i]),
          xl: b.map((x, i) => p(d15.lower, i) != null && x.close < p(d15.lower, i)),
          short: b.map((x, i) => p(d40.lower, i) != null && e200[i] != null && x.close < p(d40.lower, i) && x.close < e200[i]),
          xs: b.map((x, i) => p(d15.upper, i) != null && x.close > p(d15.upper, i)),
          overlay: [{ type: 'band', label: '돈치안 40', upper: d40.upper, lower: d40.lower }, { type: 'line', name: 'EMA 200', data: e200, color: 'violet' }],
          osc: { type: 'rsi', data: E.rsi(b, 14) }
        };
      }
    },
    {
      id: 'c3', rank: 3, name: '슈퍼트렌드 필터', kind: '자체·추세',
      desc: '슈퍼트렌드(10, 2.5)가 상승 전환하고 EMA200 위·ADX≥15이면 매수, 하락 전환하면 청산 (숏은 반대)',
      lab: '검증 기대값 +0.24R · 승률 34% · 종목·봉 66%가 수익 (4h 4년치 +0.45R)',
      build(b) {
        const c = cl(b), st = E.supertrend(b, 10, 2.5), e200 = E.ema(c, 200), d = E.adx(b, 14);
        return {
          long: b.map((x, i) => flip(st.dir, i, 1) && e200[i] != null && x.close > e200[i] && d.adx[i] >= 15),
          xl: b.map((_, i) => flip(st.dir, i, -1)),
          short: b.map((x, i) => flip(st.dir, i, -1) && e200[i] != null && x.close < e200[i] && d.adx[i] >= 15),
          xs: b.map((_, i) => flip(st.dir, i, 1)),
          overlay: [{ type: 'st', data: st, label: '슈퍼트렌드 10/2.5' }, { type: 'line', name: 'EMA 200', data: e200, color: 'violet' }],
          osc: { type: 'adx', data: d }
        };
      }
    }
  ];
  const BY_ID = Object.fromEntries(LIST.map(s => [s.id, s]));

  // 엔진 simulate로 실행 (사이트와 같은 체결·수수료·손절 규칙). 반대 방향 진입 신호도 청산으로 본다.
  function run(b, atrArr, built, from, to, opt, src) {
    return E.simulate(b, atrArr, from, to,
      i => built.long[i] ? { dir: 1, src } : built.short[i] ? { dir: -1, src } : null,
      (s, dir, i) => dir === 1 ? (built.xl[i] || built.short[i]) : (built.xs[i] || built.long[i]), opt);
  }

  // a = Engine.analyze 결과 (같은 ATR·검증 시작점·신호 마감 봉을 공유)
  function analyze(b, a, opt) {
    const n = b.length, warm = Math.min(60, Math.floor(n * 0.15));
    const sopt = Object.assign({}, opt, { signalEnd: a.signalEnd }), out = {};
    for (const s of LIST) {
      const built = s.build(b);
      const full = run(b, a.prep.atr, built, warm, n, sopt, s.id), oos = run(b, a.prep.atr, built, a.adaptive.from, n, sopt, s.id);
      let last = null;
      for (let i = a.signalEnd - 1; i >= 0 && !last; i--) if (built.long[i] || built.short[i]) last = { idx: i, dir: built.long[i] ? 1 : -1, barsAgo: a.signalEnd - 1 - i };
      out[s.id] = { built, full: E.stats(full.trades, full.mdd), oos: E.stats(oos.trades, oos.mdd), trades: full.trades, open: full.open, pending: full.pending, last };
    }
    return out;
  }

  const api = { LIST, BY_ID, run, analyze };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Custom = api;
})(typeof window !== 'undefined' ? window : globalThis);
