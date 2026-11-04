(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CoinAnalysis = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // 거래소 기본 500봉 응답에서 진행 봉을 뺀 분석 창을 화면·백테스트가 공유한다.
  const COMPOSITE_WINDOW = 499;

  const TF_SECONDS = Object.freeze({
    '1m': 60,
    '5m': 300,
    '15m': 900,
    '30m': 1800,
    '1h': 3600,
    '4h': 14400,
    '8h': 28800,
    '12h': 43200,
    '1d': 86400,
    '1w': 604800
  });

  function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function positivePeriod(period, fallback) {
    const value = Math.floor(Number(period));
    return value > 0 ? value : fallback;
  }

  function lastFinite(values) {
    for (let i = values.length - 1; i >= 0; i -= 1) {
      if (finiteNumber(values[i])) return values[i];
    }
    return null;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function averageFinite(values) {
    const finiteValues = values.filter(finiteNumber);
    if (!finiteValues.length) return null;
    return finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length;
  }

  function sma(values, period) {
    const p = positivePeriod(period, 1);
    const output = Array(values.length).fill(null);
    let sum = 0;
    let finiteCount = 0;

    for (let i = 0; i < values.length; i += 1) {
      const current = values[i];
      if (finiteNumber(current)) {
        sum += current;
        finiteCount += 1;
      }

      if (i >= p) {
        const removed = values[i - p];
        if (finiteNumber(removed)) {
          sum -= removed;
          finiteCount -= 1;
        }
      }

      if (i >= p - 1 && finiteCount === p) output[i] = sum / p;
    }
    return output;
  }

  // 첫 p개 유효값의 SMA를 시드로 사용하는 표준 EMA입니다.
  function ema(values, period) {
    const p = positivePeriod(period, 1);
    const output = Array(values.length).fill(null);
    const alpha = 2 / (p + 1);
    const seed = [];
    let previous = null;

    for (let i = 0; i < values.length; i += 1) {
      const value = values[i];
      if (!finiteNumber(value)) continue;

      if (previous === null) {
        seed.push(value);
        if (seed.length === p) {
          previous = seed.reduce((sum, item) => sum + item, 0) / p;
          output[i] = previous;
        }
        continue;
      }

      previous = value * alpha + previous * (1 - alpha);
      output[i] = previous;
    }
    return output;
  }

  // Wilder 지수평활(RMA): RSI와 ATR에서 사용하는 alpha=1/period 방식입니다.
  function rma(values, period) {
    const p = positivePeriod(period, 1);
    const output = Array(values.length).fill(null);
    const seed = [];
    let previous = null;

    for (let i = 0; i < values.length; i += 1) {
      const value = values[i];
      if (!finiteNumber(value)) continue;

      if (previous === null) {
        seed.push(value);
        if (seed.length === p) {
          previous = seed.reduce((sum, item) => sum + item, 0) / p;
          output[i] = previous;
        }
        continue;
      }

      previous = (previous * (p - 1) + value) / p;
      output[i] = previous;
    }
    return output;
  }

  function rsi(closes, period) {
    const p = positivePeriod(period, 14);
    const gains = Array(closes.length).fill(null);
    const losses = Array(closes.length).fill(null);

    for (let i = 1; i < closes.length; i += 1) {
      const change = closes[i] - closes[i - 1];
      gains[i] = Math.max(change, 0);
      losses[i] = Math.max(-change, 0);
    }

    const averageGain = rma(gains, p);
    const averageLoss = rma(losses, p);
    return closes.map((_, index) => {
      const gain = averageGain[index];
      const loss = averageLoss[index];
      if (!finiteNumber(gain) || !finiteNumber(loss)) return null;
      if (loss === 0) return gain === 0 ? 50 : 100;
      if (gain === 0) return 0;
      return 100 - 100 / (1 + gain / loss);
    });
  }

  function macd(closes, fastPeriod, slowPeriod, signalPeriod) {
    const fast = positivePeriod(fastPeriod, 12);
    const slow = positivePeriod(slowPeriod, 26);
    const signal = positivePeriod(signalPeriod, 9);
    const fastLine = ema(closes, fast);
    const slowLine = ema(closes, slow);
    const line = closes.map((_, index) => {
      if (!finiteNumber(fastLine[index]) || !finiteNumber(slowLine[index])) return null;
      return fastLine[index] - slowLine[index];
    });
    const signalLine = ema(line, signal);
    const histogram = line.map((value, index) => {
      if (!finiteNumber(value) || !finiteNumber(signalLine[index])) return null;
      return value - signalLine[index];
    });
    return { line, signal: signalLine, histogram };
  }

  function trueRange(rows) {
    return rows.map((candle, index) => {
      if (!candle || !finiteNumber(candle.high) || !finiteNumber(candle.low)) return null;
      if (index === 0 || !finiteNumber(rows[index - 1].close)) return candle.high - candle.low;
      const previousClose = rows[index - 1].close;
      return Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - previousClose),
        Math.abs(candle.low - previousClose)
      );
    });
  }

  function atr(rows, period) {
    return rma(trueRange(rows), positivePeriod(period, 14));
  }

  function standardDeviation(values, period) {
    const p = positivePeriod(period, 20);
    const output = Array(values.length).fill(null);
    for (let index = p - 1; index < values.length; index += 1) {
      const window = values.slice(index - p + 1, index + 1);
      if (!window.every(finiteNumber)) continue;
      const average = window.reduce((sum, value) => sum + value, 0) / p;
      const variance = window.reduce((sum, value) => sum + (value - average) ** 2, 0) / p;
      output[index] = Math.sqrt(variance);
    }
    return output;
  }

  function supertrend(rows, period, multiplier) {
    const p = positivePeriod(period, 10);
    const mult = finiteNumber(Number(multiplier)) ? Number(multiplier) : 3;
    const atrValues = atr(rows, p);
    const upper = Array(rows.length).fill(null);
    const lower = Array(rows.length).fill(null);
    const value = Array(rows.length).fill(null);
    const direction = Array(rows.length).fill(null);

    for (let i = 0; i < rows.length; i += 1) {
      const candle = rows[i];
      const atrValue = atrValues[i];
      if (!finiteNumber(atrValue)) continue;

      const midpoint = (candle.high + candle.low) / 2;
      const basicUpper = midpoint + mult * atrValue;
      const basicLower = midpoint - mult * atrValue;
      const previousIndex = i - 1;

      if (previousIndex < 0 || !finiteNumber(value[previousIndex])) {
        upper[i] = basicUpper;
        lower[i] = basicLower;
        direction[i] = candle.close >= midpoint ? 1 : -1;
        value[i] = direction[i] === 1 ? lower[i] : upper[i];
        continue;
      }

      const previousClose = rows[previousIndex].close;
      upper[i] = basicUpper < upper[previousIndex] || previousClose > upper[previousIndex]
        ? basicUpper
        : upper[previousIndex];
      lower[i] = basicLower > lower[previousIndex] || previousClose < lower[previousIndex]
        ? basicLower
        : lower[previousIndex];

      if (value[previousIndex] === upper[previousIndex]) {
        value[i] = candle.close <= upper[i] ? upper[i] : lower[i];
      } else {
        value[i] = candle.close >= lower[i] ? lower[i] : upper[i];
      }
      direction[i] = value[i] === lower[i] ? 1 : -1;
    }

    return { value, direction, upper, lower, atr: atrValues };
  }

  function utcAnchorKey(timestampSeconds, timeframe) {
    const date = new Date(timestampSeconds * 1000);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');

    if (['1m', '5m', '15m', '30m', '1h', '4h', '8h', '12h'].includes(timeframe)) {
      return `${year}-${month}-${day}`;
    }
    if (timeframe === '1d') return `${year}-${month}`;
    if (timeframe === '1w') return String(year);
    return 'fixed-range';
  }

  function vwapAnchorLabel(timeframe) {
    if (['1m', '5m', '15m', '30m', '1h', '4h', '8h', '12h'].includes(timeframe)) return 'UTC 일간';
    if (timeframe === '1d') return 'UTC 월간';
    if (timeframe === '1w') return 'UTC 연간';
    return '로드 구간';
  }

  function anchoredVwap(rows, timeframe) {
    const output = Array(rows.length).fill(null);
    let currentAnchor = null;
    let cumulativePriceVolume = 0;
    let cumulativeVolume = 0;

    rows.forEach((candle, index) => {
      const anchor = utcAnchorKey(candle.time, timeframe);
      if (anchor !== currentAnchor) {
        currentAnchor = anchor;
        cumulativePriceVolume = 0;
        cumulativeVolume = 0;
      }

      const volume = finiteNumber(candle.volume) && candle.volume > 0 ? candle.volume : 0;
      const typicalPrice = (candle.high + candle.low + candle.close) / 3;
      cumulativePriceVolume += typicalPrice * volume;
      cumulativeVolume += volume;
      output[index] = cumulativeVolume > 0 ? cumulativePriceVolume / cumulativeVolume : null;
    });

    return output;
  }

  // 각 캔들의 거래량을 고가~저가와 겹치는 가격 구간에 비례 배분합니다.
  // 체결 단위 원시 데이터가 없는 OHLCV 환경에서 POC 왜곡을 줄이기 위한 근사 방식입니다.
  function volumeProfile(rows, binCount) {
    const source = (Array.isArray(rows) ? rows : []).filter(candle =>
      candle && finiteNumber(candle.high) && finiteNumber(candle.low) &&
      finiteNumber(candle.close) && finiteNumber(candle.volume) && candle.volume >= 0
    );
    const count = Math.max(8, positivePeriod(binCount, 40));
    if (source.length < 2) return [];

    const rangeHigh = Math.max(...source.map(candle => candle.high));
    const rangeLow = Math.min(...source.map(candle => candle.low));
    const range = rangeHigh - rangeLow;
    if (!(range > 0)) return [];

    const binSize = range / count;
    const profile = Array.from({ length: count }, (_, index) => ({
      low: rangeLow + index * binSize,
      high: rangeLow + (index + 1) * binSize,
      price: rangeLow + (index + 0.5) * binSize,
      vol: 0
    }));

    source.forEach(candle => {
      const low = Math.max(rangeLow, Math.min(candle.low, candle.high));
      const high = Math.min(rangeHigh, Math.max(candle.low, candle.high));
      const candleRange = high - low;

      if (!(candleRange > 0)) {
        const index = Math.max(0, Math.min(count - 1, Math.floor((candle.close - rangeLow) / binSize)));
        profile[index].vol += candle.volume;
        return;
      }

      const startIndex = Math.max(0, Math.min(count - 1, Math.floor((low - rangeLow) / binSize)));
      const endIndex = Math.max(0, Math.min(count - 1, Math.floor((high - rangeLow - Number.EPSILON) / binSize)));
      const overlaps = [];
      let overlapTotal = 0;

      for (let index = startIndex; index <= endIndex; index += 1) {
        const overlap = Math.max(0, Math.min(high, profile[index].high) - Math.max(low, profile[index].low));
        overlaps.push({ index, overlap });
        overlapTotal += overlap;
      }

      if (!(overlapTotal > 0)) return;
      overlaps.forEach(item => {
        profile[item.index].vol += candle.volume * item.overlap / overlapTotal;
      });
    });

    return profile;
  }

  function volumeProfileZones(profile, valueAreaRatio) {
    const rows = Array.isArray(profile) ? profile : [];
    const ratio = Math.min(0.95, Math.max(0.5, Number(valueAreaRatio) || 0.7));
    if (!rows.length) return null;
    const total = rows.reduce((sum, bin) => sum + (finiteNumber(bin.vol) ? bin.vol : 0), 0);
    if (!(total > 0)) return null;

    const pocIndex = rows.reduce((best, bin, index) => bin.vol > rows[best].vol ? index : best, 0);
    let lowIndex = pocIndex;
    let highIndex = pocIndex;
    let accumulated = rows[pocIndex].vol;
    const target = total * ratio;

    while (accumulated < target && (lowIndex > 0 || highIndex < rows.length - 1)) {
      const lowerVolume = lowIndex > 0 ? rows[lowIndex - 1].vol : -1;
      const upperVolume = highIndex < rows.length - 1 ? rows[highIndex + 1].vol : -1;
      if (upperVolume >= lowerVolume) {
        highIndex += 1;
        accumulated += rows[highIndex].vol;
      } else {
        lowIndex -= 1;
        accumulated += rows[lowIndex].vol;
      }
    }

    const average = total / rows.length;
    const hvn = rows
      .map((bin, index) => ({ bin, index }))
      .filter(({ bin, index }) =>
        bin.vol >= average * 1.5 &&
        bin.vol >= (rows[index - 1]?.vol ?? -Infinity) &&
        bin.vol >= (rows[index + 1]?.vol ?? -Infinity)
      )
      .sort((a, b) => b.bin.vol - a.bin.vol)
      .slice(0, 3)
      .map(item => item.bin.price)
      .sort((a, b) => a - b);

    const lvn = rows
      .map((bin, index) => ({ bin, index }))
      .filter(({ bin, index }) =>
        index > 0 && index < rows.length - 1 &&
        bin.vol <= average * 0.5 &&
        bin.vol <= rows[index - 1].vol && bin.vol <= rows[index + 1].vol
      )
      .sort((a, b) => a.bin.vol - b.bin.vol)
      .slice(0, 3)
      .map(item => item.bin.price)
      .sort((a, b) => a - b);

    return {
      poc: rows[pocIndex].price,
      pocIndex,
      val: rows[lowIndex].low,
      vah: rows[highIndex].high,
      lowIndex,
      highIndex,
      hvn,
      lvn,
      totalVolume: total,
      valueAreaVolume: accumulated,
      valueAreaRatio: accumulated / total
    };
  }

  function pivotPeriodKey(timestampSeconds, timeframe) {
    const date = new Date(timestampSeconds * 1000);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');

    if (['1m', '5m', '15m', '30m', '1h', '4h', '8h', '12h'].includes(timeframe)) {
      return { key:`${year}-${month}-${day}`, label:'이전 UTC 일봉' };
    }
    if (timeframe === '1d') {
      const copy = new Date(Date.UTC(year, date.getUTCMonth(), date.getUTCDate()));
      const weekday = copy.getUTCDay() || 7;
      copy.setUTCDate(copy.getUTCDate() - weekday + 1);
      return { key:`week-${copy.toISOString().slice(0,10)}`, label:'이전 UTC 주봉' };
    }
    if (timeframe === '1w') return { key:`${year}-${month}`, label:'이전 UTC 월봉' };
    return { key:String(year), label:'이전 UTC 연봉' };
  }

  function previousPeriodOhlc(rows, timeframe, nowSeconds) {
    const source = (Array.isArray(rows) ? rows : [])
      .filter(candle => candle && finiteNumber(candle.time) && finiteNumber(candle.high) && finiteNumber(candle.low) && finiteNumber(candle.close))
      .sort((a, b) => a.time - b.time);
    if (!source.length) return null;

    const groups = [];
    source.forEach(candle => {
      const period = pivotPeriodKey(candle.time, timeframe);
      let group = groups.at(-1);
      if (!group || group.key !== period.key) {
        group = { key:period.key, label:period.label, high:candle.high, low:candle.low, close:candle.close, lastTime:candle.time };
        groups.push(group);
      } else {
        group.high = Math.max(group.high, candle.high);
        group.low = Math.min(group.low, candle.low);
        group.close = candle.close;
        group.lastTime = candle.time;
      }
    });

    const now = finiteNumber(nowSeconds) ? nowSeconds : Date.now() / 1000;
    const currentKey = pivotPeriodKey(now, timeframe).key;
    const completed = groups.filter(group => group.key !== currentKey);
    return completed.at(-1) || null;
  }

  function classicPivots(periodOhlc) {
    if (!periodOhlc) return null;
    const high = Number(periodOhlc.high);
    const low = Number(periodOhlc.low);
    const close = Number(periodOhlc.close);
    if (![high, low, close].every(finiteNumber) || !(high >= low)) return null;
    const pivot = (high + low + close) / 3;
    return {
      pivot,
      r1: 2 * pivot - low,
      s1: 2 * pivot - high,
      r2: pivot + (high - low),
      s2: pivot - (high - low),
      r3: high + 2 * (pivot - low),
      s3: low - 2 * (high - pivot),
      label: periodOhlc.label || '이전 완료 기간'
    };
  }

  function candleCloseTimeSeconds(candle, timeframe) {
    if (!candle || !finiteNumber(candle.time)) return null;
    if (timeframe === '1M') {
      const date = new Date(candle.time * 1000);
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000;
    }
    const duration = TF_SECONDS[timeframe];
    return duration ? candle.time + duration : null;
  }

  function isClosedCandle(candle, timeframe, nowSeconds) {
    const closeTime = candleCloseTimeSeconds(candle, timeframe);
    if (!finiteNumber(closeTime)) return false;
    const now = finiteNumber(nowSeconds) ? nowSeconds : Date.now() / 1000;
    return closeTime <= now;
  }

  function closedCandles(rows, timeframe, nowSeconds) {
    if (!Array.isArray(rows)) return [];
    return rows.filter(candle => isClosedCandle(candle, timeframe, nowSeconds));
  }

  /**
   * 서로 강하게 연관된 지표를 네 개의 독립 축 안에서 먼저 합친 뒤,
   * 네 축을 동일 비중으로 평균냅니다. 반환값은 확률이나 매수·매도 지시가 아니라
   * 현재 확정봉에서 관찰되는 방향 우위(-1~+1)입니다.
   */
  function compositeSignal(rows) {
    const source = Array.isArray(rows) ? rows.slice(-COMPOSITE_WINDOW) : [];
    // 월봉처럼 상장 이력이 짧은 구간도 최소 60봉부터 계산하되,
    // MA200은 실제 200봉이 있을 때만 추세축에 추가합니다.
    const requiredBars = 60;
    if (source.length < requiredBars) {
      return {
        ready: false,
        requiredBars,
        availableBars: source.length,
        score: null,
        label: '데이터 부족',
        direction: 'WAIT',
        axes: null
      };
    }

    const closes = source.map(candle => candle.close);
    const last = source.at(-1);
    const lastClose = last.close;
    const atrSeries = atr(source, 14);
    const atrNow = lastFinite(atrSeries);
    const ema20 = lastFinite(ema(closes, 20));
    const sma20 = lastFinite(sma(closes, 20));
    const sma60 = lastFinite(sma(closes, 60));
    const sma200 = lastFinite(sma(closes, 200));
    const rsiNow = lastFinite(rsi(closes, 14));
    const macdResult = macd(closes, 12, 26, 9);
    const macdHistogram = lastFinite(macdResult.histogram);
    const supertrendDirection = lastFinite(supertrend(source, 10, 3).direction);
    // 합성 점수에는 마지막 표준편차만 필요하므로 끝의 20봉만 계산한다.
    // 전체 시계열 함수를 그대로 재사용해 수식과 연산 순서를 유지한다.
    const deviation20 = lastFinite(standardDeviation(closes.slice(-20), 20));

    if (![lastClose, atrNow, ema20, sma20, sma60, rsiNow, macdHistogram, deviation20]
      .every(finiteNumber) || !(atrNow > 0)) {
      return {
        ready: false,
        requiredBars,
        availableBars: source.length,
        score: null,
        label: '지표 계산 대기',
        direction: 'WAIT',
        axes: null
      };
    }

    // 추세축: MA 간격, 장기 MA 위상, SuperTrend를 이 축 안에서만 결합합니다.
    const trendParts = [
      clamp((ema20 - sma60) / (atrNow * 2), -1, 1),
      supertrendDirection === 1 ? 1 : supertrendDirection === -1 ? -1 : 0
    ];
    if (finiteNumber(sma200)) trendParts.push(clamp((lastClose - sma200) / (atrNow * 4), -1, 1));
    const trend = averageFinite(trendParts);

    // 모멘텀축: RSI 중심선과 MACD 히스토그램을 ATR로 정규화합니다.
    const momentum = averageFinite([
      clamp((rsiNow - 50) / 20, -1, 1),
      clamp(macdHistogram / (atrNow * 0.12), -1, 1)
    ]);

    // 변동성축: 볼린저 위치에 현재 ATR 확장 정도를 곱해 돌파 방향만 제한적으로 반영합니다.
    const atrWindow = atrSeries.slice(-20).filter(finiteNumber);
    const atrAverage = averageFinite(atrWindow) || atrNow;
    const expansion = clamp((atrNow / atrAverage - 0.8) / 0.4, 0, 1);
    const bandPosition = deviation20 > 0
      ? clamp((lastClose - sma20) / (2 * deviation20), -1, 1)
      : 0;
    const volatility = bandPosition * (0.5 + expansion * 0.5);

    // 거래량축: 현재 봉 방향에 최근 평균 대비 거래량을 곱합니다.
    const previousVolumes = source.slice(-21, -1)
      .map(candle => candle.volume)
      .filter(value => finiteNumber(value) && value >= 0);
    const averageVolume = averageFinite(previousVolumes);
    const candleRange = last.high - last.low;
    const candleDirection = candleRange > 0 ? clamp((last.close - last.open) / candleRange, -1, 1) : 0;
    const volumeRatio = averageVolume > 0 && finiteNumber(last.volume) ? last.volume / averageVolume : 0;
    const volume = candleDirection * clamp(volumeRatio / 1.5, 0, 1);

    const axes = Object.freeze({ trend, momentum, volatility, volume });
    const score = averageFinite(Object.values(axes));
    let label = '관망';
    let direction = 'WAIT';
    if (score >= 0.35) { label = '상승 추세 우위'; direction = 'LONG_BIAS'; }
    else if (score >= 0.15) { label = '약한 상승 우위'; direction = 'LONG_BIAS'; }
    else if (score <= -0.35) { label = '하락 추세 우위'; direction = 'SHORT_BIAS'; }
    else if (score <= -0.15) { label = '약한 하락 우위'; direction = 'SHORT_BIAS'; }

    return {
      ready: true,
      requiredBars,
      availableBars: source.length,
      score,
      label,
      direction,
      axes,
      diagnostics: {
        atr: atrNow,
        rsi: rsiNow,
        macdHistogram,
        volumeRatio,
        supertrendDirection
      }
    };
  }

  /**
   * 시간봉별 독립 결과를 방향 개수로 요약합니다. 서로 반대 방향이 하나라도
   * 공존하면 평균값으로 덮지 않고 '시간봉 충돌'을 우선 표시합니다.
   */
  function summarizeTimeframes(entries) {
    const source = Array.isArray(entries) ? entries : [];
    const valid = source.filter(entry => entry?.signal?.ready);
    const up = valid.filter(entry => entry.signal.direction === 'LONG_BIAS').length;
    const down = valid.filter(entry => entry.signal.direction === 'SHORT_BIAS').length;
    const wait = valid.filter(entry => entry.signal.direction === 'WAIT').length;
    const missing = source.length - valid.length;
    const averageScore = averageFinite(valid.map(entry => entry.signal.score));

    let label = '관망 또는 데이터 부족';
    let state = 'WAIT';
    if (up > 0 && down > 0) {
      label = '시간봉 방향 충돌';
      state = 'CONFLICT';
    } else if (up >= 3) {
      label = '다중 시간봉 상승 우위';
      state = 'LONG_BIAS';
    } else if (down >= 3) {
      label = '다중 시간봉 하락 우위';
      state = 'SHORT_BIAS';
    } else if (up > 0) {
      label = '일부 시간봉 상승 우위';
      state = 'LONG_BIAS';
    } else if (down > 0) {
      label = '일부 시간봉 하락 우위';
      state = 'SHORT_BIAS';
    }

    return { label, state, up, down, wait, missing, valid: valid.length, total: source.length, averageScore };
  }

  return Object.freeze({
    COMPOSITE_WINDOW,
    TF_SECONDS,
    finiteNumber,
    lastFinite,
    sma,
    ema,
    rma,
    rsi,
    macd,
    trueRange,
    atr,
    standardDeviation,
    supertrend,
    anchoredVwap,
    vwapAnchorLabel,
    volumeProfile,
    volumeProfileZones,
    pivotPeriodKey,
    previousPeriodOhlc,
    classicPivots,
    candleCloseTimeSeconds,
    isClosedCandle,
    closedCandles,
    compositeSignal,
    summarizeTimeframes
  });
});
