/**
 * 다중 지표 신호와 비용 포함 백테스트의 공용 계산 모듈입니다.
 * 브라우저 화면과 Node 검증기가 같은 규칙을 사용하도록 DOM·전역 상태와 분리했습니다.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.StrategyBacktest = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
    const DEFAULT_COST = Object.freeze({ feeRate: 0.0004, slippageRate: 0.0002, holdoutRatio: 0.4 });

    function sma(values, period) {
        const out = Array(values.length).fill(null);
        let sum = 0;
        for (let index = 0; index < values.length; index++) {
            sum += values[index];
            if (index >= period) sum -= values[index - period];
            if (index >= period - 1) out[index] = sum / period;
        }
        return out;
    }

    function ema(values, period) {
        if (!values.length) return [];
        const alpha = 2 / (period + 1);
        const out = [values[0]];
        for (let index = 1; index < values.length; index++) {
            out[index] = values[index] * alpha + out[index - 1] * (1 - alpha);
        }
        return out;
    }

    function rsi(values, period = 14) {
        const out = Array(values.length).fill(null);
        if (values.length <= period) return out;
        let averageGain = 0;
        let averageLoss = 0;
        for (let index = 1; index <= period; index++) {
            const change = values[index] - values[index - 1];
            averageGain += Math.max(change, 0);
            averageLoss += Math.max(-change, 0);
        }
        averageGain /= period;
        averageLoss /= period;
        const value = () => averageLoss === 0 ? (averageGain === 0 ? 50 : 100) : 100 - 100 / (1 + averageGain / averageLoss);
        out[period] = value();
        for (let index = period + 1; index < values.length; index++) {
            const change = values[index] - values[index - 1];
            averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
            averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
            out[index] = value();
        }
        return out;
    }

    function cci(highs, lows, closes, period = 20) {
        const out = Array(closes.length).fill(null);
        const typical = closes.map((close, index) => (highs[index] + lows[index] + close) / 3);
        for (let index = period - 1; index < closes.length; index++) {
            const window = typical.slice(index - period + 1, index + 1);
            const mean = window.reduce((sum, value) => sum + value, 0) / period;
            const deviation = window.reduce((sum, value) => sum + Math.abs(value - mean), 0) / period;
            out[index] = deviation === 0 ? 0 : (typical[index] - mean) / (0.015 * deviation);
        }
        return out;
    }

    function finiteSma(values, period) {
        return values.map((_, index) => {
            if (index < period - 1) return null;
            const window = values.slice(index - period + 1, index + 1);
            if (window.some(value => !Number.isFinite(value))) return null;
            return window.reduce((sum, value) => sum + value, 0) / period;
        });
    }

    function stochastic(highs, lows, closes, periodK = 14, periodD = 3, smoothingK = 3) {
        const fastK = Array(closes.length).fill(null);
        for (let index = periodK - 1; index < closes.length; index++) {
            const high = Math.max(...highs.slice(index - periodK + 1, index + 1));
            const low = Math.min(...lows.slice(index - periodK + 1, index + 1));
            fastK[index] = high === low ? 50 : (closes[index] - low) / (high - low) * 100;
        }
        const k = finiteSma(fastK, smoothingK);
        return { k, d: finiteSma(k, periodD) };
    }

    function bollinger(closes, period = 20, multiplier = 2) {
        const basis = sma(closes, period);
        const upper = Array(closes.length).fill(null);
        const lower = Array(closes.length).fill(null);
        for (let index = period - 1; index < closes.length; index++) {
            const window = closes.slice(index - period + 1, index + 1);
            const variance = window.reduce((sum, value) => sum + Math.pow(value - basis[index], 2), 0) / period;
            const deviation = Math.sqrt(variance) * multiplier;
            upper[index] = basis[index] + deviation;
            lower[index] = basis[index] - deviation;
        }
        return { basis, upper, lower };
    }

    function fibonacci(high, low) {
        const difference = high - low;
        return {
            f11: high - difference * 0.114,
            f23: high - difference * 0.236,
            f38: high - difference * 0.382,
            f50: high - difference * 0.5,
            f78: high - difference * 0.786,
            f88: high - difference * 0.886
        };
    }

    function volumePoc(candles, bins = 20) {
        const high = Math.max(...candles.map(candle => candle.high));
        const low = Math.min(...candles.map(candle => candle.low));
        const size = (high - low) / bins || Math.max(high * 1e-8, 1e-8);
        const volumes = Array(bins).fill(0);
        candles.forEach(candle => {
            const typical = (candle.high + candle.low + candle.close) / 3;
            const bucket = Math.max(0, Math.min(bins - 1, Math.floor((typical - low) / size)));
            volumes[bucket] += candle.volume || 0;
        });
        const maxVolume = Math.max(...volumes);
        const index = volumes.indexOf(maxVolume);
        return low + size * (index + 0.5);
    }

    function evaluateConfluence(input) {
        const longSupport = input.price <= input.fib.f50 || input.price < input.poc || input.price <= input.bbLower;
        const shortResistance = input.price >= input.fib.f38 || input.price > input.poc || input.price >= input.bbUpper;
        const longTrend = input.ma20 >= input.ma60 || (input.price > input.ema20 && input.rsi > 48) || input.macd > input.macdSignal;
        const shortTrend = input.ma20 <= input.ma60 || (input.price < input.ema20 && input.rsi < 52) || input.macd < input.macdSignal;
        const macdLong = input.previousMacd < input.previousMacdSignal && input.macd >= input.macdSignal;
        const macdShort = input.previousMacd > input.previousMacdSignal && input.macd <= input.macdSignal;
        const maLong = input.previousEma5 < input.previousEma20 && input.ema5 >= input.ema20;
        // 기존 코드는 현재 EMA5를 이전 EMA20과 비교했습니다. 현재 시점끼리 비교해야 실제 데드크로스입니다.
        const maShort = input.previousEma5 > input.previousEma20 && input.ema5 <= input.ema20;
        const longTiming = input.rsi <= 38 || input.cci <= -100 || (input.stochK <= 30 && input.stochK > input.stochD) || macdLong || maLong;
        const shortTiming = input.rsi >= 62 || input.cci >= 100 || (input.stochK >= 70 && input.stochK < input.stochD) || macdShort || maShort;
        let direction = null;
        const reasons = [];
        if (longSupport && longTrend && longTiming) {
            direction = "LONG";
            if (input.rsi <= 38) reasons.push("RSI 과매도 수렴");
            if (input.cci <= -100) reasons.push("CCI 과매도 채널");
            if (input.stochK <= 30 && input.stochK > input.stochD) reasons.push("스토캐스틱 골든크로스");
            if (macdLong) reasons.push("MACD 골든크로스");
            if (maLong) reasons.push("이평 단기 골든크로스");
            if (input.price < input.poc) reasons.push("VPVR POC 하단 매집 지지");
        } else if (shortResistance && shortTrend && shortTiming) {
            direction = "SHORT";
            if (input.rsi >= 62) reasons.push("RSI 과매수 수렴");
            if (input.cci >= 100) reasons.push("CCI 과열 채널");
            if (input.stochK >= 70 && input.stochK < input.stochD) reasons.push("스토캐스틱 데드크로스");
            if (macdShort) reasons.push("MACD 데드크로스");
            if (maShort) reasons.push("이평 단기 데드크로스");
            if (input.price > input.poc) reasons.push("VPVR POC 상단 돌파 저항");
        }
        return { direction, reasons, flags: { macdLong, macdShort, maLong, maShort } };
    }

    function analyzeSignal(candles) {
        if (!Array.isArray(candles) || candles.length < 60) return { direction: null, reasons: [], error: "확정봉 부족" };
        const window = candles.slice(-150);
        const closes = window.map(candle => candle.close);
        const highs = window.map(candle => candle.high);
        const lows = window.map(candle => candle.low);
        const last = closes.length - 1;
        const ema5Values = ema(closes, 5);
        const ema20Values = ema(closes, 20);
        const ma20Values = sma(closes, 20);
        const ma60Values = sma(closes, 60);
        const rsiValues = rsi(closes, 14);
        const cciValues = cci(highs, lows, closes, 20);
        const stoch = stochastic(highs, lows, closes);
        const ema12Values = ema(closes, 12);
        const ema26Values = ema(closes, 26);
        const macdValues = ema12Values.map((value, index) => value - ema26Values[index]);
        const macdSignal = ema(macdValues, 9);
        const bb = bollinger(closes);
        const recentHigh = Math.max(...highs.slice(-101));
        const recentLow = Math.min(...lows.slice(-101));
        return evaluateConfluence({
            price: closes[last],
            fib: fibonacci(recentHigh, recentLow),
            poc: volumePoc(window),
            bbUpper: bb.upper[last], bbLower: bb.lower[last],
            ma20: ma20Values[last], ma60: ma60Values[last], ema20: ema20Values[last],
            rsi: rsiValues[last], cci: cciValues[last], stochK: stoch.k[last], stochD: stoch.d[last],
            macd: macdValues[last], macdSignal: macdSignal[last],
            previousMacd: macdValues[last - 1], previousMacdSignal: macdSignal[last - 1],
            ema5: ema5Values[last], previousEma5: ema5Values[last - 1],
            previousEma20: ema20Values[last - 1]
        });
    }

    function autoTargets(history, direction, entryPrice) {
        const window = history.slice(-150);
        const closes = window.map(candle => candle.close);
        const highs = window.map(candle => candle.high);
        const lows = window.map(candle => candle.low);
        const last = closes.length - 1;
        const fib = fibonacci(Math.max(...highs.slice(-101)), Math.min(...lows.slice(-101)));
        const bb = bollinger(closes);
        let target;
        let stop;
        if (direction === "LONG") {
            target = Math.max(entryPrice * 1.005, ((fib.f23 + fib.f38) / 2 + bb.upper[last]) / 2);
            const recommended = Math.min(entryPrice, (fib.f78 + bb.lower[last]) / 2);
            stop = Math.min(recommended * 0.992, fib.f88 * 0.998);
        } else {
            target = Math.min(entryPrice * 0.995, (fib.f78 + bb.lower[last]) / 2);
            const recommended = Math.max(entryPrice, ((fib.f23 + fib.f38) / 2 + bb.upper[last]) / 2);
            stop = Math.max(recommended * 1.008, fib.f11 * 1.002);
        }
        const valid = direction === "LONG" ? stop < entryPrice && target > entryPrice : stop > entryPrice && target < entryPrice;
        return valid ? { target, stop } : null;
    }

    function resolveExit(candles, entryIndex, direction, target, stop) {
        for (let index = entryIndex; index < candles.length; index++) {
            const candle = candles[index];
            const stopHit = direction === "LONG" ? candle.low <= stop : candle.high >= stop;
            const targetHit = direction === "LONG" ? candle.high >= target : candle.low <= target;
            // 봉 내부 체결 순서는 알 수 없으므로 둘 다 닿으면 손절을 먼저 적용합니다.
            if (stopHit) return { exitIndex: index, exitPrice: stop, reason: "STOP" };
            if (targetHit) return { exitIndex: index, exitPrice: target, reason: "TARGET" };
        }
        return null;
    }

    function calculateNetR(entryPrice, exitPrice, stop, direction, cost = DEFAULT_COST) {
        const risk = Math.abs(entryPrice - stop);
        if (!(risk > 0)) return null;
        const sign = direction === "LONG" ? 1 : -1;
        const gross = sign * (exitPrice - entryPrice);
        const oneWay = cost.feeRate + cost.slippageRate;
        return (gross - (entryPrice + exitPrice) * oneWay) / risk;
    }

    function runBacktest(candles, options = {}) {
        const cost = { ...DEFAULT_COST, ...(options.cost || {}) };
        const splitIndex = options.splitIndex ?? Math.floor(candles.length * (1 - cost.holdoutRatio));
        const trades = [];
        let occupiedUntil = -1;
        for (let signalIndex = 199; signalIndex < candles.length - 1; signalIndex++) {
            if (signalIndex < occupiedUntil) continue;
            const historyStart = Math.max(0, signalIndex - 149);
            const history = candles.slice(historyStart, signalIndex + 1);
            const signal = analyzeSignal(history);
            if (!signal.direction) continue;
            const entryIndex = signalIndex + 1;
            const entryPrice = candles[entryIndex].open;
            const levels = autoTargets(history, signal.direction, entryPrice);
            if (!levels) continue;
            const exit = resolveExit(candles, entryIndex, signal.direction, levels.target, levels.stop);
            if (!exit) continue;
            trades.push({
                signalIndex, entryIndex, exitIndex: exit.exitIndex, direction: signal.direction,
                entryTime: candles[entryIndex].time, exitTime: candles[exit.exitIndex].time,
                entryPrice, exitPrice: exit.exitPrice, target: levels.target, stop: levels.stop,
                reason: exit.reason, signalReasons: signal.reasons,
                netR: calculateNetR(entryPrice, exit.exitPrice, levels.stop, signal.direction, cost)
            });
            occupiedUntil = exit.exitIndex;
        }
        return {
            splitIndex,
            allTrades: trades,
            holdoutTrades: trades.filter(trade => trade.entryIndex >= splitIndex),
            all: summarize(trades),
            holdout: summarize(trades.filter(trade => trade.entryIndex >= splitIndex))
        };
    }

    function summarize(trades) {
        const wins = trades.filter(trade => trade.netR > 0);
        const grossProfit = wins.reduce((sum, trade) => sum + trade.netR, 0);
        const grossLoss = Math.abs(trades.filter(trade => trade.netR <= 0).reduce((sum, trade) => sum + trade.netR, 0));
        const totalR = trades.reduce((sum, trade) => sum + trade.netR, 0);
        let equity = 0;
        let peak = 0;
        let maxDrawdownR = 0;
        trades.forEach(trade => {
            equity += trade.netR;
            peak = Math.max(peak, equity);
            maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
        });
        return {
            trades: trades.length,
            winRate: trades.length ? wins.length / trades.length * 100 : 0,
            profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
            expectancyR: trades.length ? totalR / trades.length : 0,
            totalR,
            maxDrawdownR
        };
    }

    // 세션 VWAP: UTC 00:00마다 초기화 (트레이딩뷰 기본값과 같음). 시각은 초 단위.
    function sessionVwap(candles) {
        let day = null, pv = 0, vol = 0;
        return candles.map(candle => {
            const d = Math.floor(candle.time / 86400);
            if (d !== day) { day = d; pv = 0; vol = 0; }
            const v = candle.volume || 0;
            pv += (candle.high + candle.low + candle.close) / 3 * v;
            vol += v;
            return vol > 0 ? pv / vol : candle.close;
        });
    }

    // 가격선의 실제 반응 기록: 과거 확정봉이 선 근처(±tol)에 닿은 횟수와, 그 뒤 3봉 안에
    // 종가로 선을 뚫지 않고 버틴 횟수. 같은 접근이 여러 봉 이어지면 1회로 센다.
    // tol 기본값은 평균 봉 길이의 25% — 고정 0.3%면 1분봉에선 거의 모든 봉이 '닿고 버틴' 것으로 세진다.
    function levelReaction(candles, price, side, tol, after = 3) {
        let touches = 0, held = 0, skipUntil = -1;
        if (!(price > 0) || !candles.length) return { touches, held, rate: null };
        if (tol == null) {
            const avgRange = candles.reduce((sum, c) => sum + (c.high - c.low) / c.close, 0) / candles.length;
            tol = Math.max(0.0001, avgRange * 0.25);
        }
        for (let index = 0; index < candles.length - after; index++) {
            if (index <= skipUntil) continue;
            const candle = candles[index];
            const touched = side === "support"
                ? candle.low <= price * (1 + tol) && candle.close >= price * (1 - tol)
                : candle.high >= price * (1 - tol) && candle.close <= price * (1 + tol);
            if (!touched) continue;
            touches++;
            const next = candles.slice(index + 1, index + 1 + after);
            const broke = next.some(c => side === "support" ? c.close < price * (1 - tol) : c.close > price * (1 + tol));
            if (!broke) held++;
            skipUntil = index + after;
        }
        return { touches, held, rate: touches ? held / touches : null };
    }

    function reactionText(r, side) {
        if (!r || r.touches < 3) return `표본 부족 (과거 접근 ${r ? r.touches : 0}회)`;
        return `${r.held}/${r.touches}회 ${side === "support" ? "지지" : "저항"} (${Math.round(r.rate * 100)}%)`;
    }

    function verdict(summary) {
        if (summary.trades < 30) return "표본 부족";
        if (summary.expectancyR > 0 && summary.profitFactor > 1) return "양의 성과 관찰";
        return "전략 우위 미확인";
    }

    return {
        DEFAULT_COST, sma, ema, rsi, cci, stochastic, bollinger, fibonacci, volumePoc,
        evaluateConfluence, analyzeSignal, autoTargets, resolveExit, calculateNetR, runBacktest, summarize, verdict,
        sessionVwap, levelReaction, reactionText
    };
});
