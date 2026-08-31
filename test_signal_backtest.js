'use strict';

const assert = require('node:assert/strict');
const config = require('./backtest/config.js');
const {
    confirmedWindow,
    fillPending,
    closePosition,
    evaluatePosition,
    metrics
} = require('./backtest/signal_backtest.js');
const { dataQuality } = require('./backtest/fetch_snapshot.js');

const rows = [
    { time: 0, endTime: 3600, o: 100, h: 101, l: 99, c: 100, v: 1 },
    { time: 3600, endTime: 7200, o: 100, h: 102, l: 98, c: 101, v: 1 },
    { time: 7200, endTime: 10800, o: 101, h: 103, l: 100, c: 102, v: 1 }
];

assert.deepEqual(confirmedWindow(rows, 7199), [rows[0]]);
assert.deepEqual(confirmedWindow(rows, 7200), rows.slice(0, 2));

const record = { filled: false };
const pending = {
    symbol: 'BTCUSDT',
    signalTime: 3600,
    signalRecord: record,
    plan: { side: 'LONG', entry: 100, stop: 98, target1: 103, rr: 1.5 }
};
const filled = fillPending(pending, { ...rows[1], o: 99 });
assert.equal(filled.fillPrice, 99);

const stopped = evaluatePosition({ ...filled, symbol: 'BTCUSDT', barsHeld: 0 }, {
    time: 3600, endTime: 7200, o: 99, h: 104, l: 97, c: 101, v: 1
});
assert.equal(stopped.outcome, 'STOP');
assert.ok(stopped.netR < 0);

const noCostPosition = {
    symbol: 'BTCUSDT', signalTime: 0, entryTime: 1, fillPrice: 100, barsHeld: 1,
    plan: { side: 'LONG', entry: 100, stop: 90, target1: 120, rr: 2 }
};
const closed = closePosition(noCostPosition, 120, 'TARGET', 2);
assert.ok(closed.netR < 2, '수수료와 슬리피지가 기대 R에서 빠져야 합니다.');

const summary = metrics([
    { netR: 1, exitTime: 1, symbol: 'A' },
    { netR: -2, exitTime: 2, symbol: 'A' },
    { netR: 0.5, exitTime: 3, symbol: 'A' }
]);
assert.equal(summary.winRate, 2 / 3);
assert.equal(summary.profitFactor, 0.75);
assert.equal(summary.maxDrawdownR, 2);

const quality = dataQuality([
    { time: 0, o: 10, h: 11, l: 9, c: 10, v: 1 },
    { time: 7200, o: 10, h: 11, l: 9, c: 10, v: 0 }
], '1h');
assert.equal(quality.gaps, 1);
assert.equal(quality.invalidOhlc, 0);
assert.equal(quality.zeroVolume, 1);

assert.equal(config.minimumSample, 30);
console.log('백테스트 테스트 통과: 확정봉, 다음 봉 체결, 동일 봉 손절 우선, 비용, PF, MDD, 데이터 품질');
