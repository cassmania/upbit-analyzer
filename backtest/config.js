'use strict';

const HOUR_MS = 60 * 60 * 1000;

module.exports = {
    source: 'Binance Spot public API / api/v3/klines',
    symbols: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'SOLUSDT'],
    timeframes: {
        '1h': { interval: '1h', milliseconds: HOUR_MS, warmupBars: 250 },
        '4h': { interval: '4h', milliseconds: HOUR_MS * 4, warmupBars: 250 },
        '8h': { interval: '8h', milliseconds: HOUR_MS * 8, warmupBars: 250 },
        '12h': { interval: '12h', milliseconds: HOUR_MS * 12, warmupBars: 250 },
        '1d': { interval: '1d', milliseconds: HOUR_MS * 24, warmupBars: 250 },
        '1w': { interval: '1w', milliseconds: HOUR_MS * 24 * 7, warmupBars: 250 },
        // 월 길이는 고정되지 않으므로 충분한 상장 이력을 요청한 뒤 API 결과만 사용합니다.
        '1M': { interval: '1M', fetchStartUtc: '2017-01-01T00:00:00.000Z' }
    },
    startUtc: '2024-01-01T00:00:00.000Z',
    endUtc: new Date(Math.floor(Date.now() / HOUR_MS) * HOUR_MS).toISOString(),
    lastWindowRatio: 0.4,
    maximumBarsPerIndicator: 200,
    maximumHoldBars: 48,
    minimumSample: 30,
    feeRatePerSide: 0.001,
    slippageRatePerSide: 0.0002
};
