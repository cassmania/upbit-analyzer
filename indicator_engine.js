/* 트레이딩 챠트 — 지표·전략·백테스트 엔진
 * 모든 계산은 인과적(과거 데이터만 사용)이며 신호는 봉 마감 기준, 체결은 다음 봉 시가입니다.
 * 브라우저(window.Engine)와 Node(require) 양쪽에서 동작합니다.
 */
(function (root) {
  'use strict';

  /* ===================== 기본 지표 ===================== */
  const nul = n => new Array(n).fill(null);

  function sma(src, n) {
    const out = nul(src.length);
    let s = 0, c = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (v == null) { s = 0; c = 0; continue; }
      s += v; c++;
      if (c > n) { s -= src[i - n]; c = n; }
      if (c === n) out[i] = s / n;
    }
    return out;
  }

  function ema(src, n) {
    const out = nul(src.length);
    const k = 2 / (n + 1);
    let prev = null, seed = 0, c = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (v == null) { prev = null; seed = 0; c = 0; continue; }
      if (prev == null) {
        seed += v; c++;
        if (c === n) { prev = seed / n; out[i] = prev; }
      } else {
        prev = v * k + prev * (1 - k);
        out[i] = prev;
      }
    }
    return out;
  }

  // Wilder 평활(RMA)
  function rma(src, n) {
    const out = nul(src.length);
    let prev = null, seed = 0, c = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (v == null) { prev = null; seed = 0; c = 0; continue; }
      if (prev == null) {
        seed += v; c++;
        if (c === n) { prev = seed / n; out[i] = prev; }
      } else {
        prev = (prev * (n - 1) + v) / n;
        out[i] = prev;
      }
    }
    return out;
  }

  function stdev(src, n) {
    const out = nul(src.length);
    for (let i = n - 1; i < src.length; i++) {
      let s = 0, ok = true;
      for (let j = i - n + 1; j <= i; j++) { if (src[j] == null) { ok = false; break; } s += src[j]; }
      if (!ok) continue;
      const m = s / n;
      let q = 0;
      for (let j = i - n + 1; j <= i; j++) q += (src[j] - m) ** 2;
      out[i] = Math.sqrt(q / n);
    }
    return out;
  }

  function trueRange(b) {
    return b.map((x, i) => i === 0 ? x.high - x.low
      : Math.max(x.high - x.low, Math.abs(x.high - b[i - 1].close), Math.abs(x.low - b[i - 1].close)));
  }

  const atr = (b, n = 14) => rma(trueRange(b), n);

  function rsi(b, n = 14) {
    const up = nul(b.length), dn = nul(b.length);
    for (let i = 1; i < b.length; i++) {
      const d = b[i].close - b[i - 1].close;
      up[i] = Math.max(d, 0); dn[i] = Math.max(-d, 0);
    }
    const au = rma(up, n), ad = rma(dn, n);
    return au.map((u, i) => (u == null || ad[i] == null) ? null : ad[i] === 0 ? 100 : 100 - 100 / (1 + u / ad[i]));
  }

  function macd(b, f = 12, s = 26, sig = 9) {
    const c = b.map(x => x.close);
    const ef = ema(c, f), es = ema(c, s);
    const line = ef.map((v, i) => (v == null || es[i] == null) ? null : v - es[i]);
    const signal = ema(line, sig);
    const hist = line.map((v, i) => (v == null || signal[i] == null) ? null : v - signal[i]);
    return { line, signal, hist };
  }

  function bollinger(b, n = 20, k = 2) {
    const c = b.map(x => x.close);
    const mid = sma(c, n), sd = stdev(c, n);
    const upper = mid.map((m, i) => m == null ? null : m + k * sd[i]);
    const lower = mid.map((m, i) => m == null ? null : m - k * sd[i]);
    const width = mid.map((m, i) => m == null || m === 0 ? null : (upper[i] - lower[i]) / m);
    return { mid, upper, lower, width };
  }

  function stoch(b, n = 14, ks = 3, ds = 3) {
    const raw = nul(b.length);
    for (let i = n - 1; i < b.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - n + 1; j <= i; j++) { hh = Math.max(hh, b[j].high); ll = Math.min(ll, b[j].low); }
      raw[i] = hh === ll ? 50 : 100 * (b[i].close - ll) / (hh - ll);
    }
    const K = sma(raw, ks);
    const D = sma(K, ds);
    return { K, D };
  }

  function cci(b, n = 20) {
    const tp = b.map(x => (x.high + x.low + x.close) / 3);
    const m = sma(tp, n);
    const out = nul(b.length);
    for (let i = n - 1; i < b.length; i++) {
      if (m[i] == null) continue;
      let md = 0;
      for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]);
      md /= n;
      out[i] = md === 0 ? 0 : (tp[i] - m[i]) / (0.015 * md);
    }
    return out;
  }

  function adx(b, n = 14) {
    const pdm = nul(b.length), mdm = nul(b.length), tr = nul(b.length);
    for (let i = 1; i < b.length; i++) {
      const up = b[i].high - b[i - 1].high, dn = b[i - 1].low - b[i].low;
      pdm[i] = up > dn && up > 0 ? up : 0;
      mdm[i] = dn > up && dn > 0 ? dn : 0;
      tr[i] = Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close));
    }
    const str = rma(tr, n), sp = rma(pdm, n), sm = rma(mdm, n);
    const pdi = str.map((t, i) => t == null || t === 0 ? null : 100 * sp[i] / t);
    const mdi = str.map((t, i) => t == null || t === 0 ? null : 100 * sm[i] / t);
    const dx = pdi.map((p, i) => p == null || mdi[i] == null ? null : (p + mdi[i] === 0 ? 0 : 100 * Math.abs(p - mdi[i]) / (p + mdi[i])));
    return { adx: rma(dx, n), pdi, mdi };
  }

  function supertrend(b, n = 10, mult = 3) {
    const a = atr(b, n);
    const line = nul(b.length), dir = nul(b.length);
    let fu = null, fl = null, d = 1;
    for (let i = 0; i < b.length; i++) {
      if (a[i] == null) continue;
      const hl2 = (b[i].high + b[i].low) / 2;
      const bu = hl2 + mult * a[i], bl = hl2 - mult * a[i];
      if (fu == null) { fu = bu; fl = bl; d = b[i].close >= hl2 ? 1 : -1; }
      else {
        const pc = b[i - 1].close;
        fu = (bu < fu || pc > fu) ? bu : fu;
        fl = (bl > fl || pc < fl) ? bl : fl;
        if (d === 1 && b[i].close < fl) d = -1;
        else if (d === -1 && b[i].close > fu) d = 1;
      }
      dir[i] = d;
      line[i] = d === 1 ? fl : fu;
    }
    return { line, dir };
  }

  function donchian(b, n = 20) {
    const upper = nul(b.length), lower = nul(b.length);
    for (let i = n - 1; i < b.length; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - n + 1; j <= i; j++) { hh = Math.max(hh, b[j].high); ll = Math.min(ll, b[j].low); }
      upper[i] = hh; lower[i] = ll;
    }
    return { upper, lower };
  }

  function psar(b, step = 0.02, max = 0.2) {
    const out = nul(b.length), dir = nul(b.length);
    if (b.length < 3) return { sar: out, dir };
    let up = b[1].close >= b[0].close;
    let sar = up ? b[0].low : b[0].high;
    let ep = up ? b[1].high : b[1].low;
    let af = step;
    for (let i = 1; i < b.length; i++) {
      sar = sar + af * (ep - sar);
      if (up) {
        sar = Math.min(sar, b[i - 1].low, i > 1 ? b[i - 2].low : b[i - 1].low);
        if (b[i].low < sar) { up = false; sar = ep; ep = b[i].low; af = step; }
        else if (b[i].high > ep) { ep = b[i].high; af = Math.min(af + step, max); }
      } else {
        sar = Math.max(sar, b[i - 1].high, i > 1 ? b[i - 2].high : b[i - 1].high);
        if (b[i].high > sar) { up = true; sar = ep; ep = b[i].high; af = step; }
        else if (b[i].low < ep) { ep = b[i].low; af = Math.min(af + step, max); }
      }
      out[i] = sar; dir[i] = up ? 1 : -1;
    }
    return { sar: out, dir };
  }

  // VPVR(거래량 프로파일): POC·VAH·VAL과 상위 매물대
  function volumeProfile(b, lookback = 300, bins = 48) {
    const s = b.slice(-lookback);
    if (s.length < 20) return null;
    let lo = Infinity, hi = -Infinity;
    for (const x of s) { lo = Math.min(lo, x.low); hi = Math.max(hi, x.high); }
    if (!(hi > lo)) return null;
    const step = (hi - lo) / bins;
    const vol = new Array(bins).fill(0);
    for (const x of s) {
      const a = Math.max(0, Math.floor((x.low - lo) / step));
      const z = Math.min(bins - 1, Math.floor((x.high - lo) / step));
      const share = (x.volume || 0) / (z - a + 1);
      for (let k = a; k <= z; k++) vol[k] += share;
    }
    let poc = 0;
    for (let k = 1; k < bins; k++) if (vol[k] > vol[poc]) poc = k;
    const total = vol.reduce((p, v) => p + v, 0);
    let lowK = poc, highK = poc, acc = vol[poc];
    while (acc < total * 0.7 && (lowK > 0 || highK < bins - 1)) {
      const dn = lowK > 0 ? vol[lowK - 1] : -1, up = highK < bins - 1 ? vol[highK + 1] : -1;
      if (up >= dn) { highK++; acc += vol[highK]; } else { lowK--; acc += vol[lowK]; }
    }
    const mid = k => lo + (k + 0.5) * step;
    // 국소 최대 매물대(노드)
    const nodes = [];
    for (let k = 1; k < bins - 1; k++) {
      if (vol[k] >= vol[k - 1] && vol[k] >= vol[k + 1] && vol[k] > total / bins * 1.2) nodes.push({ price: mid(k), vol: vol[k] });
    }
    nodes.sort((x, y) => y.vol - x.vol);
    return { poc: mid(poc), vah: lo + (highK + 1) * step, val: lo + lowK * step, nodes: nodes.slice(0, 6), bins: vol, lo, step };
  }

  /* ===================== 시장 국면 ===================== */
  // 'up' 상승 추세 · 'down' 하락 추세 · 'range' 횡보
  function regimes(b) {
    const c = b.map(x => x.close);
    const e50 = ema(c, 50);
    const d = adx(b, 14);
    return b.map((x, i) => {
      const a = d.adx[i], p = d.pdi[i], m = d.mdi[i], e = e50[i];
      if (a == null || e == null) return null;
      if (a >= 22 && p > m && x.close > e) return 'up';
      if (a >= 22 && m > p && x.close < e) return 'down';
      return 'range';
    });
  }

  const REGIME_NAME = { up: '상승 추세', down: '하락 추세', range: '횡보·박스권' };

  /* ===================== 전략 ===================== */
  const crossUp = (a, b, i) => a[i] != null && b[i] != null && a[i - 1] != null && b[i - 1] != null && a[i - 1] <= b[i - 1] && a[i] > b[i];
  const crossDn = (a, b, i) => a[i] != null && b[i] != null && a[i - 1] != null && b[i - 1] != null && a[i - 1] >= b[i - 1] && a[i] < b[i];
  const crossUpV = (a, v, i) => a[i] != null && a[i - 1] != null && a[i - 1] <= v && a[i] > v;
  const crossDnV = (a, v, i) => a[i] != null && a[i - 1] != null && a[i - 1] >= v && a[i] < v;

  // 각 전략: build(bars) → { sig: [+1 매수, -1 매도, 0], overlay, osc }
  const STRATEGIES = [
    {
      id: 'st_rsi', name: '슈퍼트렌드 + RSI', kind: '추세', desc: '슈퍼트렌드 상승 중 RSI 50 상향 돌파 매수, 슈퍼트렌드 하락 전환 시 매도',
      build(b) {
        const st = supertrend(b, 10, 3), r = rsi(b, 14);
        const sig = b.map((_, i) => {
          if (i < 1) return 0;
          if (st.dir[i] === 1 && crossUpV(r, 50, i)) return 1;
          if (st.dir[i] === 1 && st.dir[i - 1] === -1 && r[i] != null && r[i] > 50) return 1;
          if (st.dir[i] === -1 && st.dir[i - 1] === 1) return -1;
          if (st.dir[i] === -1 && crossDnV(r, 50, i)) return -1;
          return 0;
        });
        return { sig, overlay: [{ type: 'st', data: st }], osc: { type: 'rsi', data: r } };
      }
    },
    {
      id: 'supertrend', name: '슈퍼트렌드 10/3', kind: '추세', desc: '슈퍼트렌드 방향 전환',
      build(b) {
        const st = supertrend(b, 10, 3);
        const sig = b.map((_, i) => i < 1 || st.dir[i] == null || st.dir[i - 1] == null ? 0 : st.dir[i] !== st.dir[i - 1] ? st.dir[i] : 0);
        return { sig, overlay: [{ type: 'st', data: st }], osc: { type: 'rsi', data: rsi(b, 14) } };
      }
    },
    {
      id: 'ema_cross', name: 'EMA 9/21 크로스', kind: '추세', desc: 'EMA9가 EMA21을 상향/하향 돌파',
      build(b) {
        const c = b.map(x => x.close), f = ema(c, 9), s = ema(c, 21);
        const sig = b.map((_, i) => i < 1 ? 0 : crossUp(f, s, i) ? 1 : crossDn(f, s, i) ? -1 : 0);
        return { sig, overlay: [{ type: 'line', name: 'EMA 9', data: f, color: 'accent' }, { type: 'line', name: 'EMA 21', data: s, color: 'blue' }], osc: { type: 'rsi', data: rsi(b, 14) } };
      }
    },
    {
      id: 'ma_cross', name: 'MA 20/60 크로스', kind: '추세', desc: '20이평이 60이평을 골든/데드크로스',
      build(b) {
        const c = b.map(x => x.close), f = sma(c, 20), s = sma(c, 60);
        const sig = b.map((_, i) => i < 1 ? 0 : crossUp(f, s, i) ? 1 : crossDn(f, s, i) ? -1 : 0);
        return { sig, overlay: [{ type: 'line', name: 'MA 20', data: f, color: 'accent' }, { type: 'line', name: 'MA 60', data: s, color: 'violet' }], osc: { type: 'rsi', data: rsi(b, 14) } };
      }
    },
    {
      id: 'macd', name: 'MACD 12/26/9', kind: '모멘텀', desc: 'MACD선이 시그널선을 교차',
      build(b) {
        const m = macd(b);
        const sig = b.map((_, i) => i < 1 ? 0 : crossUp(m.line, m.signal, i) ? 1 : crossDn(m.line, m.signal, i) ? -1 : 0);
        return { sig, overlay: [], osc: { type: 'macd', data: m } };
      }
    },
    {
      id: 'donchian', name: '돈치안 20/10 돌파', kind: '돌파', desc: '직전 20봉 고점 돌파 매수, 직전 10봉 저점 이탈 매도',
      build(b) {
        const d20 = donchian(b, 20), d10 = donchian(b, 10);
        const sig = b.map((x, i) => {
          if (i < 1) return 0;
          if (d20.upper[i - 1] != null && x.close > d20.upper[i - 1]) return 1;
          if (d10.lower[i - 1] != null && x.close < d10.lower[i - 1]) return -1;
          return 0;
        });
        return { sig, overlay: [{ type: 'band', name: '돈치안', upper: d20.upper, lower: d10.lower }], osc: { type: 'rsi', data: rsi(b, 14) } };
      }
    },
    {
      id: 'psar', name: '파라볼릭 SAR', kind: '추세', desc: 'SAR 점이 캔들 위/아래로 전환',
      build(b) {
        const p = psar(b);
        const sig = b.map((_, i) => i < 2 || p.dir[i] == null || p.dir[i - 1] == null ? 0 : p.dir[i] !== p.dir[i - 1] ? p.dir[i] : 0);
        return { sig, overlay: [{ type: 'dots', name: 'SAR', data: p.sar }], osc: { type: 'rsi', data: rsi(b, 14) } };
      }
    },
    {
      id: 'rsi_rev', name: 'RSI 30/70 반전', kind: '역추세', desc: 'RSI 30 상향 돌파 매수, 70 하향 이탈 매도',
      build(b) {
        const r = rsi(b, 14);
        const sig = b.map((_, i) => i < 1 ? 0 : crossUpV(r, 30, i) ? 1 : crossDnV(r, 70, i) ? -1 : 0);
        return { sig, overlay: [], osc: { type: 'rsi', data: r } };
      }
    },
    {
      id: 'bb_rev', name: '볼린저 밴드 반전', kind: '역추세', desc: '하단 밴드 아래에서 복귀 시 매수, 상단 밴드 위에서 복귀 시 매도',
      build(b) {
        const bb = bollinger(b, 20, 2), c = b.map(x => x.close);
        const sig = b.map((_, i) => i < 1 ? 0 : crossUp(c, bb.lower, i) ? 1 : crossDn(c, bb.upper, i) ? -1 : 0);
        return { sig, overlay: [{ type: 'bb', data: bb }], osc: { type: 'rsi', data: rsi(b, 14) } };
      }
    },
    {
      id: 'stoch', name: '스토캐스틱 14/3/3', kind: '역추세', desc: '20 아래 %K↑%D 매수, 80 위 %K↓%D 매도',
      build(b) {
        const s = stoch(b);
        const sig = b.map((_, i) => {
          if (i < 1) return 0;
          if (crossUp(s.K, s.D, i) && s.D[i] < 25) return 1;
          if (crossDn(s.K, s.D, i) && s.D[i] > 75) return -1;
          return 0;
        });
        return { sig, overlay: [], osc: { type: 'stoch', data: s } };
      }
    },
    {
      id: 'cci', name: 'CCI 20 ±100', kind: '역추세', desc: 'CCI -100 상향 돌파 매수, +100 하향 이탈 매도',
      build(b) {
        const c = cci(b, 20);
        const sig = b.map((_, i) => i < 1 ? 0 : crossUpV(c, -100, i) ? 1 : crossDnV(c, 100, i) ? -1 : 0);
        return { sig, overlay: [], osc: { type: 'cci', data: c } };
      }
    }
  ];
  const STRAT_BY_ID = Object.fromEntries(STRATEGIES.map(s => [s.id, s]));

  /* ===================== 백테스트 ===================== */
  const DEFAULTS = { fee: 0.001, stopAtr: 2.5, mode: 'long' };

  /* simulate: 봉 마감 신호 → 다음 봉 시가 체결, 진입 시 ATR 손절 고정
   *  entryAt(i) → { dir, src } | null : 봉 i 마감 시 새 진입 신호
   *  exitAt(src, dir, i) → bool       : 봉 i 마감 시 보유 포지션 청산 신호
   *  signalEnd : 신호를 계산할 수 있는 마지막 봉(형성 중인 봉 제외) 인덱스 + 1
   */
  function simulate(b, atrArr, from, to, entryAt, exitAt, opt) {
    const o = Object.assign({}, DEFAULTS, opt);
    const trades = [];
    let pos = null, pending = null;
    let eq = 1, peak = 1, mdd = 0;
    const signalEnd = Math.min(to, o.signalEnd == null ? to : o.signalEnd);
    const close = (i, px, reason) => {
      const g = pos.dir === 1 ? px / pos.entry : pos.entry / px;
      const pnl = g * (1 - o.fee) * (1 - o.fee) - 1;
      eq *= 1 + pnl;
      trades.push({ dir: pos.dir, src: pos.src, entryIdx: pos.idx, entry: pos.entry, exitIdx: i, exit: px, pnl, reason, regime: pos.regime, stop: pos.stop });
      pos = null;
    };
    for (let i = from; i < to; i++) {
      const bar = b[i];
      // 1) 직전 봉 신호를 이번 봉 시가에 체결
      if (pending) {
        if (pending.type === 'exit' && pos) close(i, bar.open, 'signal');
        if (pending.type === 'enter') {
          if (pos && pos.dir !== pending.dir) close(i, bar.open, 'flip');
          if (!pos) {
            const a = atrArr[i - 1] || atrArr[i] || bar.open * 0.02;
            pos = { dir: pending.dir, src: pending.src, idx: i, entry: bar.open, regime: pending.regime,
              stop: pending.dir === 1 ? bar.open - o.stopAtr * a : bar.open + o.stopAtr * a };
          }
        }
        pending = null;
      }
      // 2) 손절 (갭이면 시가 체결)
      if (pos) {
        if (pos.dir === 1 && bar.low <= pos.stop) close(i, Math.min(bar.open, pos.stop), 'stop');
        else if (pos.dir === -1 && bar.high >= pos.stop) close(i, Math.max(bar.open, pos.stop), 'stop');
      }
      // 평가손익 기반 MDD
      const mark = pos ? eq * (1 + (pos.dir === 1 ? bar.close / pos.entry : pos.entry / bar.close) - 1) : eq;
      peak = Math.max(peak, mark);
      mdd = Math.max(mdd, 1 - mark / peak);
      // 3) 봉 마감 신호
      if (i >= signalEnd) continue;
      if (pos && exitAt(pos.src, pos.dir, i)) {
        const e = entryAt(i);
        if (e && e.dir !== pos.dir && (o.mode === 'both')) pending = { type: 'enter', ...e };
        else pending = { type: 'exit' };
        continue;
      }
      if (!pos) {
        const e = entryAt(i);
        if (e && (e.dir === 1 || o.mode === 'both')) pending = { type: 'enter', ...e };
      }
    }
    const open = pos ? Object.assign({}, pos, { lastIdx: to - 1, unreal: (pos.dir === 1 ? b[to - 1].close / pos.entry : pos.entry / b[to - 1].close) - 1 }) : null;
    return { trades, open, pending, equity: eq, mdd };
  }

  function wilsonLB(w, n, z = 1.2816) { // 80% 단측 하한
    if (!n) return 0;
    const p = w / n, d = 1 + z * z / n;
    return Math.max(0, (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d);
  }

  function stats(trades, mdd) {
    const n = trades.length;
    const wins = trades.filter(t => t.pnl > 0);
    const gw = wins.reduce((s, t) => s + t.pnl, 0);
    const gl = trades.filter(t => t.pnl <= 0).reduce((s, t) => s - t.pnl, 0);
    const ret = trades.reduce((e, t) => e * (1 + t.pnl), 1) - 1;
    const pf = gl === 0 ? (gw > 0 ? 9.99 : 0) : gw / gl;
    const wr = n ? wins.length / n : 0;
    const exp = n ? trades.reduce((s, t) => s + t.pnl, 0) / n : 0;
    // 신뢰 점수: 승률 하한(Wilson) × 손익비(PF, 최대 3) × 낙폭 패널티, 표본 부족 시 감점
    const lb = wilsonLB(wins.length, n);
    const sampleW = Math.min(1, n / 12);
    const score = n < 3 ? 0 : 100 * lb * Math.min(pf, 3) / 3 * 2 * sampleW * (1 - Math.min(0.6, mdd || 0));
    return { trades: n, winRate: wr, pf, ret, exp, mdd: mdd || 0, score: Math.min(100, score), lb };
  }

  // 국면별 성과 (진입 시점 국면 기준)
  function statsByRegime(trades) {
    const out = {};
    for (const r of ['up', 'down', 'range']) {
      const t = trades.filter(x => x.regime === r);
      out[r] = stats(t, 0);
    }
    return out;
  }

  function prepare(b) {
    const reg = regimes(b);
    const a = atr(b, 14);
    const built = {};
    for (const s of STRATEGIES) built[s.id] = s.build(b);
    return { reg, atr: a, built };
  }

  function singleRun(b, prep, id, from, to, opt) {
    const sig = prep.built[id].sig;
    return simulate(b, prep.atr, from, to,
      i => sig[i] ? { dir: sig[i], src: id, regime: prep.reg[i] } : null,
      (src, dir, i) => sig[i] === -dir, opt);
  }

  // 학습 구간 [from,to)에서 최적 전략 선택
  //  method 'regime' : 국면별 최적(표본 부족 국면은 전체 최적으로 대체)
  //  method 'single' : 국면과 무관하게 전체 최적 1개
  function fitSelection(b, prep, to, opt, warm, method) {
    const sel = {}, table = {}, overall = {};
    for (const s of STRATEGIES) {
      const r = singleRun(b, prep, s.id, warm, to, opt);
      table[s.id] = statsByRegime(r.trades);
      overall[s.id] = stats(r.trades, r.mdd);
    }
    let bestAll = null;
    for (const s of STRATEGIES) {
      const st = overall[s.id];
      if (st.trades < 4 || st.pf < 1.05 || st.exp <= 0) continue;
      if (!bestAll || st.score > overall[bestAll].score) bestAll = s.id;
    }
    for (const g of ['up', 'down', 'range']) {
      if (method === 'single') { sel[g] = bestAll; continue; }
      let best = null;
      for (const s of STRATEGIES) {
        const st = table[s.id][g];
        if (st.trades < 5 || st.pf < 1.1 || st.exp <= 0) continue;
        if (!best || st.score > best.score) best = { id: s.id, score: st.score };
      }
      sel[g] = best ? best.id : bestAll; // 둘 다 없으면 null = 관망
    }
    return { sel, table, overall, bestAll };
  }

  function adaptiveSignals(prep, selAt) {
    return {
      entryAt: i => {
        const g = prep.reg[i];
        const sel = selAt(i);
        const id = g && sel[g];
        if (!id) return null;
        const v = prep.built[id].sig[i];
        return v ? { dir: v, src: id, regime: g } : null;
      },
      exitAt: (src, dir, i) => prep.built[src].sig[i] === -dir
    };
  }

  /* 전체 분석
   *  - 개별 전략: 전체 구간 + 검증 구간(워크포워드 시작 이후) 성과
   *  - 적응형: 롤링 워크포워드(과거 데이터로만 선택 → 다음 구간 적용)로 검증
   *  - 현재 선택: 전체 데이터로 재학습한 국면별 전략
   */
  function analyze(b, opt) {
    opt = Object.assign({}, DEFAULTS, opt);
    const n = b.length;
    const signalEnd = opt.lastClosed === false ? n : n - 1; // 마지막 봉이 형성 중이면 신호 제외
    const sopt = Object.assign({}, opt, { signalEnd });
    const prep = prepare(b);
    const warm = Math.min(60, Math.floor(n * 0.15));
    const wfStart = Math.max(warm + 80, Math.floor(n * 0.4));
    const step = Math.max(20, Math.floor(n * 0.1));

    // 롤링 워크포워드: 각 재학습 시점까지의 데이터만으로 선택 → 다음 구간에 적용
    const fold = method => {
      const folds = [];
      if (wfStart < n - 5) for (let t = wfStart; t < n; t += step) folds.push({ t, sel: fitSelection(b, prep, t, sopt, warm, method).sel });
      const selAt = i => { let s = null; for (const f of folds) { if (f.t <= i) s = f.sel; else break; } return s || {}; };
      const sg = adaptiveSignals(prep, selAt);
      const run = folds.length ? simulate(b, prep.atr, wfStart, n, sg.entryAt, sg.exitAt, sopt) : { trades: [], open: null, pending: null, mdd: 0 };
      return { method, stats: stats(run.trades, run.mdd), trades: run.trades, open: run.open, pending: run.pending, from: wfStart, folds };
    };
    const metas = { regime: fold('regime'), single: fold('single') };
    const method = metas.single.stats.score > metas.regime.stats.score ? 'single' : 'regime';
    const adaptive = metas[method];

    // 개별 전략
    const rows = STRATEGIES.map(s => {
      const full = singleRun(b, prep, s.id, warm, n, sopt);
      const oos = singleRun(b, prep, s.id, wfStart, n, sopt);
      return {
        id: s.id, name: s.name, kind: s.kind, desc: s.desc,
        full: stats(full.trades, full.mdd), oos: stats(oos.trades, oos.mdd),
        byRegime: statsByRegime(full.trades), trades: full.trades, open: full.open, pending: full.pending
      };
    });
    rows.sort((x, y) => y.oos.score - x.oos.score || y.full.score - x.full.score);

    // 현재 국면 + 전체 데이터 재학습 선택
    const finalFit = fitSelection(b, prep, n, sopt, warm, method);
    const lastReg = (() => { for (let i = signalEnd - 1; i >= 0; i--) if (prep.reg[i]) return prep.reg[i]; return 'range'; })();
    const chosen = finalFit.sel[lastReg] || null;

    // 마지막 신호(완성봉 기준)
    const lastSignal = id => {
      const sig = prep.built[id].sig;
      for (let i = signalEnd - 1; i >= 0; i--) if (sig[i]) return { idx: i, dir: sig[i], barsAgo: signalEnd - 1 - i };
      return null;
    };

    const d = adx(b, 14);
    const bb = bollinger(b, 20, 2);
    const li = signalEnd - 1;
    const widths = bb.width.slice(Math.max(0, li - 120), li + 1).filter(v => v != null);
    const wNow = bb.width[li];
    const wPct = widths.length && wNow != null ? widths.filter(v => v <= wNow).length / widths.length : null;

    return {
      prep, rows, adaptive, metas, method, selection: finalFit.sel, regimeTable: finalFit.table, regime: lastReg, chosen,
      lastSignal, signalEnd,
      context: { adx: d.adx[li], pdi: d.pdi[li], mdi: d.mdi[li], bbPct: wPct, atr: prep.atr[li] }
    };
  }

  const api = {
    sma, ema, rma, stdev, atr, rsi, macd, bollinger, stoch, cci, adx, supertrend, donchian, psar,
    volumeProfile, regimes, REGIME_NAME, STRATEGIES, STRAT_BY_ID, simulate, stats, statsByRegime,
    wilsonLB, prepare, singleRun, fitSelection, analyze
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof window !== 'undefined' ? window : globalThis);
