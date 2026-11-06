/* 매매 타점 표시 공통 모듈 (coinchart · 모의 거래소 · upbit 터미널 · claude-chart · trading-chart 공용 사본)
 * - tradeMarkers(rows): trading-chart 자체 지표 1위 '추세 합의'를 같은 규칙(봉 마감 신호 → 다음 봉 시가,
 *   2.5×ATR 손절, 수수료 0.1%, 롱·숏)으로 돌린 거래 기록을 마커 배열로. window.Engine·window.Custom 필요.
 * - applyTradeMarks(series, marks, rows): 화살표는 차트 마커(글자 없이), 글자는 캔들·다른 글자와 겹치지 않는
 *   빈 자리를 찾아 그리고 화살표와 선으로 잇는다. 자리가 없으면 그 글자는 생략(화살표만).
 * lightweight-charts 4.1 이상(series primitive) 필요. 고치면 다섯 사본을 같이 바꿀 것.
 */
(function (root) {
  'use strict';
  const COL = { buy: '#12a150', sell: '#d64545', gray: '#8a857c', accent: '#c96442' };
  const px = v => v.toLocaleString('en-US', { maximumSignificantDigits: 6 });
  const pct = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';

  function tradeMarkers(rows) {
    const E = root.Engine, C = root.Custom;
    if (!E || !C || !rows || rows.length < 260) return [];
    const n = rows.length, d = C.LIST[0], atr = E.atr(rows, 14);
    const r = C.run(rows, atr, d.build(rows), 60, n, { mode: 'both', signalEnd: n - 1 }, d.id), ms = [];
    const entry = (i, dir, p, txt) => ms.push({ time: rows[i].time, position: dir === 1 ? 'belowBar' : 'aboveBar', shape: dir === 1 ? 'arrowUp' : 'arrowDown', color: dir === 1 ? COL.buy : COL.sell, text: txt + ' ' + px(p) });
    r.trades.forEach(t => {
      entry(t.entryIdx, t.dir, t.entry, t.dir === 1 ? '매수·롱' : '매도·숏');
      const stop = t.reason === 'stop';
      ms.push({ time: rows[t.exitIdx].time, position: t.dir === 1 ? 'aboveBar' : 'belowBar', shape: t.dir === 1 ? 'arrowDown' : 'arrowUp', color: stop ? COL.gray : (t.dir === 1 ? COL.sell : COL.buy), text: (stop ? '손절 ' : t.dir === 1 ? '롱 청산 ' : '숏 청산 ') + px(t.exit) + ' ' + pct(t.pnl) });
    });
    if (r.open) entry(r.open.idx, r.open.dir, r.open.entry, r.open.dir === 1 ? '롱 보유' : '숏 보유');
    if (r.pending) ms.push({ time: rows[n - 1].time, position: r.pending.dir === 1 ? 'belowBar' : 'aboveBar', shape: 'circle', color: COL.accent, text: r.pending.type === 'exit' ? '청산 신호' : r.pending.dir === 1 ? '롱 진입 신호' : '숏 진입 신호' });
    return ms.sort((a, b) => a.time - b.time);
  }

  // 차트 배경 밝기로 글자 상자 색을 정한다(사이트마다 테마 방식이 달라서)
  function darkBg(chart) {
    try {
      const c = chart.options().layout.background.color || '#ffffff';
      const m = c.match(/\d+(\.\d+)?/g), h = c[0] === '#' ? c.slice(1) : null;
      const [r, g, b] = h ? [0, 2, 4].map(i => parseInt(h.length === 3 ? h[i / 2] + h[i / 2] : h.slice(i, i + 2), 16)) : m.map(Number);
      return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
    } catch (e) { return false; }
  }

  class TradeLabels {
    constructor() { this.items = []; this.rows = []; }
    attached({ chart, series, requestUpdate }) { this.chart = chart; this.series = series; this.req = requestUpdate; }
    detached() { this.chart = null; }
    set(marks, rows) { this.items = (marks || []).filter(m => m.text); this.rows = rows || []; if (this.req) this.req(); }
    updateAllViews() {}
    paneViews() {
      return [{ zOrder: () => 'top', renderer: () => ({ draw: target => {
        if (!this.chart || !this.items.length) return;
        const ts = this.chart.timeScale(), s = this.series, byTime = new Map(this.rows.map(c => [c.time, c])), dark = darkBg(this.chart);
        target.useMediaCoordinateSpace(({ context: c, mediaSize }) => {
          c.font = '600 11px Inter, "Malgun Gothic", "Apple SD Gothic Neo", sans-serif'; c.textBaseline = 'middle';
          // 보이는 캔들의 화면 상자(고가~저가) — 글자가 캔들을 덮지 않게
          const bars = [];
          for (const k of this.rows) {
            const x = ts.timeToCoordinate(k.time);
            if (x == null || x < -20 || x > mediaSize.width + 20) continue;
            const y1 = s.priceToCoordinate(k.high), y2 = s.priceToCoordinate(k.low);
            if (y1 != null && y2 != null) bars.push({ x, y1, y2 });
          }
          const half = Math.max(2, (ts.width() / Math.max(1, bars.length)) / 2), placed = [];
          const hitLabel = b => placed.some(p => b.x1 < p.x2 + 3 && b.x2 > p.x1 - 3 && b.y1 < p.y2 + 2 && b.y2 > p.y1 - 2);
          const hitBar = b => bars.some(k => k.x + half > b.x1 && k.x - half < b.x2 && k.y1 < b.y2 && k.y2 > b.y1);
          for (const m of this.items) {
            const x = ts.timeToCoordinate(m.time), k = byTime.get(m.time);
            if (x == null || !k || x < 0 || x > mediaSize.width) continue;
            const up = m.position === 'aboveBar', anchor = s.priceToCoordinate(up ? k.high : k.low);
            if (anchor == null) continue;
            const w = c.measureText(m.text).width + 10, h = 17, cands = [];
            // 원래 쪽(롱 아래·숏 위)에서 점점 멀리, 그다음 반대쪽. 높이마다 가운데·왼쪽·오른쪽으로 비켜 본다
            for (const side of [up ? -1 : 1, up ? 1 : -1]) for (let step = 0; step < 16; step++) for (const dx of [0, -0.6, 0.6]) {
              const yc = anchor + side * (20 + step * 15), x1 = Math.min(Math.max(2, x - w / 2 + dx * w), mediaSize.width - w - 2);
              const b = { x1, x2: x1 + w, y1: yc - h / 2, y2: yc + h / 2 };
              if (b.y1 >= 2 && b.y2 <= mediaSize.height - 2) cands.push(b);
            }
            // 1순위 캔들·글자 모두 피함 → 2순위 글자만 피함 → 자리가 없으면 글자 생략
            const box = cands.find(b => !hitLabel(b) && !hitBar(b)) || cands.find(b => !hitLabel(b));
            if (!box) continue;
            placed.push(box);
            const below = box.y1 >= anchor;
            c.strokeStyle = m.color; c.globalAlpha = 0.55; c.lineWidth = 1;
            c.beginPath(); c.moveTo(x, up ? anchor - 10 : anchor + 10); c.lineTo(Math.min(Math.max(x, box.x1 + 4), box.x2 - 4), below ? box.y1 : box.y2); c.stroke();
            c.globalAlpha = 1;
            c.fillStyle = dark ? 'rgba(31,30,29,.93)' : 'rgba(251,250,246,.93)';
            c.beginPath(); if (c.roundRect) c.roundRect(box.x1, box.y1, w, h, 4); else c.rect(box.x1, box.y1, w, h); c.fill();
            c.strokeStyle = m.color; c.stroke();
            c.fillStyle = m.color; c.fillText(m.text, box.x1 + 5, (box.y1 + box.y2) / 2 + 0.5);
          }
        });
      } }) }];
    }
  }

  function applyTradeMarks(series, marks, rows) {
    if (!series) return;
    if (!series._tl) { series._tl = new TradeLabels(); series.attachPrimitive(series._tl); }
    series.setMarkers((marks || []).map(m => Object.assign({}, m, { text: '' })));
    series._tl.set(marks, rows);
  }

  root.TradeMarks = { tradeMarkers, applyTradeMarks, TradeLabels };
})(typeof window !== 'undefined' ? window : globalThis);
