'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { dataQuality } = require('./fetch_snapshot.js');
const TAEngine = require('../ta_engine.js');
const LevelEngine = require('../level_analyzer.js');
const SignalEngine = require('../signal_engine.js');
const config = require('./config.js');

const DATA_DIR = path.join(__dirname, 'data');
const RESULT_DIR = path.join(__dirname, 'results');

function lastIndexAtOrBefore(rows, decisionTime) {
    let low = 0;
    let high = rows.length - 1;
    let answer = -1;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (rows[middle].endTime <= decisionTime) {
            answer = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return answer;
}

function confirmedWindow(rows, decisionTime, maximum = config.maximumBarsPerIndicator) {
    const end = lastIndexAtOrBefore(rows, decisionTime);
    if (end < 0) return [];
    return rows.slice(Math.max(0, end - maximum + 1), end + 1);
}

function analysisInput(rows) {
    return rows.map(row => ({
        time: row.time,
        endTime: row.endTime,
        o: row.o,
        h: row.h,
        l: row.l,
        c: row.c,
        v: row.v
    }));
}

function levelInput(rows) {
    return rows.map(row => ({ high: row.h, low: row.l, close: row.c, volume: row.v }));
}

function loadSnapshot() {
    const manifest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'manifest.json'), 'utf8'));
    const sets = manifest.symbols.map(item => {
        const compressed = fs.readFileSync(path.join(DATA_DIR, item.file));
        const raw = zlib.gunzipSync(compressed).toString('utf8');
        if (crypto.createHash('sha256').update(raw).digest('hex') !== item.sha256) throw new Error(`${item.symbol}: 스냅샷 해시 불일치`);
        const set = JSON.parse(raw);
        for (const [tf, rows] of Object.entries(set.timeframes)) {
            const q = dataQuality(rows, tf);
            if (rows.length !== item.timeframes[tf].bars || q.gaps || q.invalidOhlc || q.duplicateOrOutOfOrder
                || rows.some(r => ![r.time,r.endTime,r.o,r.h,r.l,r.c,r.v].every(Number.isFinite)
                    || r.v < 0 || r.endTime <= r.time || r.endTime > Date.parse(manifest.requestedRange.endExclusiveUtc)/1000)) {
                throw new Error(`${item.symbol} ${tf}: 입력 무결성 검사 실패`);
            }
        }
        return set;
    });
    return { manifest, sets };
}

function fillPending(pending, bar) {
    if (!pending) return null;
    const plan = pending.plan;
    // 신규 진입 전에 무효화 가격을 넘어선 갭은 유효한 계획으로 체결하지 않는다.
    if (plan.side === 'LONG' ? bar.o <= plan.stop : bar.o >= plan.stop) return null;
    if (plan.side === 'LONG' && bar.l <= plan.entry) {
        return { ...pending, fillPrice: bar.o <= plan.entry ? bar.o : plan.entry, entryTime: bar.time, intrabarEntry: bar.o > plan.entry };
    }
    if (plan.side === 'SHORT' && bar.h >= plan.entry) {
        return { ...pending, fillPrice: bar.o >= plan.entry ? bar.o : plan.entry, entryTime: bar.time, intrabarEntry: bar.o < plan.entry };
    }
    return null;
}

function closePosition(position, rawExitPrice, outcome, exitTime) {
    const plan = position.plan;
    const risk = Math.abs(position.fillPrice - plan.stop);
    if (!(risk > 0)) return null;
    const grossR = plan.side === 'LONG'
        ? (rawExitPrice - position.fillPrice) / risk
        : (position.fillPrice - rawExitPrice) / risk;
    const perSideCost = config.feeRatePerSide + config.slippageRatePerSide;
    const costR = (position.fillPrice + rawExitPrice) * perSideCost / risk;
    return {
        symbol: position.symbol,
        side: plan.side,
        signalTime: position.signalTime,
        entryTime: position.entryTime,
        exitTime,
        plannedEntry: plan.entry,
        entryPrice: position.fillPrice,
        stop: plan.stop,
        target: plan.target1,
        exitPrice: rawExitPrice,
        plannedR: plan.rr,
        grossR,
        costR,
        netR: grossR - costR,
        barsHeld: position.barsHeld,
        outcome
    };
}

function evaluatePosition(position, bar) {
    const plan = position.plan;
    position.barsHeld += 1;
    const stopHit = plan.side === 'LONG' ? bar.l <= plan.stop : bar.h >= plan.stop;
    const targetHit = plan.side === 'LONG' ? bar.h >= plan.target1 : bar.l <= plan.target1;

    // 한 봉 안의 가격 경로를 알 수 없으므로 보수적으로 손절을 우선합니다.
    if (stopHit) {
        const exit = plan.side === 'LONG' ? Math.min(plan.stop, bar.o) : Math.max(plan.stop, bar.o);
        return closePosition(position, exit, 'STOP', bar.endTime);
    }
    // 봉 중간 지정가 진입이면 고가/저가가 진입 전에 발생했을 수 있어 당일 익절을 인정하지 않는다.
    if (targetHit && !(position.intrabarEntry && position.barsHeld === 1)) {
        const exit = plan.side === 'LONG' ? Math.max(plan.target1, bar.o) : Math.min(plan.target1, bar.o);
        return closePosition(position, exit, 'TARGET', bar.endTime);
    }
    if (position.barsHeld >= config.maximumHoldBars) {
        return closePosition(position, bar.c, 'TIME', bar.endTime);
    }
    return null;
}

function increment(map, key) {
    map[key] = (map[key] || 0) + 1;
}

function simulateSymbol(set, period = {}) {
    const startSeconds = period.start ?? Date.parse(config.startUtc) / 1000;
    const endSeconds = period.end ?? set.timeframes['1h'].at(-1).endTime;
    const hourly = set.timeframes['1h'].filter(bar => bar.endTime >= startSeconds && bar.endTime <= endSeconds);
    const cache = new Map();
    const convertedCache = new Map();
    const trades = [];
    const signals = [];
    const blocked = {};
    let pending = null;
    let position = null;

    function analyzeTimeframe(timeframe, decisionTime) {
        const rows = confirmedWindow(set.timeframes[timeframe] || [], decisionTime);
        if (rows.length < 30) return { error: `캔들 부족 (${rows.length}봉)` };
        const lastEnd = rows.at(-1).endTime;
        const cached = cache.get(timeframe);
        if (cached && cached.lastEnd === lastEnd) return cached.result;
        const result = TAEngine.analyzeTf(analysisInput(rows));
        cache.set(timeframe, { lastEnd, result });
        return result;
    }

    for (const bar of hourly) {
        if (bar.endTime < startSeconds) continue;

        if (!position && pending) {
            const filled = fillPending(pending, bar);
            pending.signalRecord.filled = Boolean(filled);
            if (filled) {
                position = { ...filled, symbol: set.symbol, barsHeld: 0 };
                const closed = evaluatePosition(position, bar);
                if (closed) {
                    trades.push(closed);
                    position = null;
                }
            }
            // 지정가 계획은 다음 한 봉까지만 유효하며 이후에는 새 확정봉으로 다시 계산합니다.
            pending = null;
        } else if (position) {
            const closed = evaluatePosition(position, bar);
            if (closed) {
                trades.push(closed);
                position = null;
            }
        }

        if (position) continue;
        if (bar.endTime >= endSeconds) continue;

        const decisionTime = bar.endTime;
        const results = {
            '1h': analyzeTimeframe('1h', decisionTime),
            '4h': analyzeTimeframe('4h', decisionTime),
            '12h': analyzeTimeframe('12h', decisionTime),
            '1d': analyzeTimeframe('1d', decisionTime)
        };
        const direction = SignalEngine.방향판정(results);
        if (!direction || direction.dir === 'NONE' || direction.n < 2) {
            increment(blocked, !direction ? '상위봉 데이터 부족' : direction.n < 2 ? '상위봉 표본 부족' : '방향성 부족');
            continue;
        }
        const timing = SignalEngine.타이밍확인(results, direction.dir);
        if (!timing.ok) {
            increment(blocked, '1시간봉 타이밍 차단');
            continue;
        }

        const converted = {};
        for (const timeframe of Object.keys(config.timeframes)) {
            const rows = confirmedWindow(set.timeframes[timeframe] || [], decisionTime);
            if (rows.length >= 20) {
                const lastEnd = rows.at(-1).endTime;
                let cached = convertedCache.get(timeframe);
                if (period.cacheConverted === false || !cached || cached.lastEnd !== lastEnd) {
                    cached = { lastEnd, rows: levelInput(rows) };
                    convertedCache.set(timeframe, cached);
                }
                converted[timeframe] = cached.rows;
            }
        }
        const levels = LevelEngine.analyze(converted, bar.c, { limit: 7 });
        const signal = SignalEngine.analyze(results, levels, bar.c, null);
        if (!signal.entry) {
            increment(blocked, signal.blocked || signal.error || '진입 계획 없음');
            continue;
        }

        const signalRecord = {
            symbol: set.symbol,
            side: signal.entry.side,
            signalTime: decisionTime,
            plannedEntry: signal.entry.entry,
            plannedR: signal.entry.rr,
            filled: false
        };
        signals.push(signalRecord);
        pending = { plan: signal.entry, signalTime: decisionTime, signalRecord };
    }

    if (position) {
        const bar = hourly.at(-1);
        const closed = closePosition(position, bar.c, 'END_OF_DATA', bar.endTime);
        if (closed) trades.push(closed);
    }
    return { symbol: set.symbol, trades, signals, blocked };
}

function metrics(trades) {
    const ordered = [...trades].sort((a, b) => a.exitTime - b.exitTime || a.symbol.localeCompare(b.symbol));
    let equityR = 0;
    let peakR = 0;
    let maxDrawdownR = 0;
    let wins = 0;
    let grossProfitR = 0;
    let grossLossR = 0;
    for (const trade of ordered) {
        equityR += trade.netR;
        peakR = Math.max(peakR, equityR);
        maxDrawdownR = Math.max(maxDrawdownR, peakR - equityR);
        if (trade.netR > 0) {
            wins += 1;
            grossProfitR += trade.netR;
        } else {
            grossLossR += Math.abs(trade.netR);
        }
    }
    return {
        sample: ordered.length,
        status: ordered.length >= config.minimumSample ? '검증 표본 충족' : '표본 부족',
        winRate: ordered.length ? wins / ordered.length : null,
        profitFactor: grossLossR > 0 ? grossProfitR / grossLossR : null,
        averageR: ordered.length ? equityR / ordered.length : null,
        totalR: equityR,
        maxDrawdownR
    };
}

function signalMetrics(signals) {
    const filled = signals.filter(signal => signal.filled).length;
    return {
        signals: signals.length,
        fills: filled,
        fillRate: signals.length ? filled / signals.length : null
    };
}

function groupMetrics(trades, key) {
    return Object.fromEntries([...new Set(trades.map(trade => trade[key]))].sort().map(value => [
        value,
        metrics(trades.filter(trade => trade[key] === value))
    ]));
}

function percent(value) {
    return value === null ? '데이터 없음' : `${(value * 100).toFixed(1)}%`;
}

function number(value, suffix = '') {
    return value === null ? '데이터 없음' : `${value.toFixed(3)}${suffix}`;
}

function metricLines(result) {
    return [
        `- 거래: ${result.sample} (${result.status})`,
        `- 승률: ${percent(result.winRate)}`,
        `- Profit Factor: ${number(result.profitFactor)}`,
        `- 평균 기대값: ${number(result.averageR, 'R')}`,
        `- 누적: ${number(result.totalR, 'R')}`,
        `- 최대 낙폭: ${number(result.maxDrawdownR, 'R')}`
    ];
}

function metricDelta(after, before) {
    if (!before) return null;
    return {
        sample: after.sample - before.sample,
        winRate: after.winRate - before.winRate,
        profitFactor: after.profitFactor - before.profitFactor,
        averageR: after.averageR - before.averageR,
        totalR: after.totalR - before.totalR,
        maxDrawdownR: after.maxDrawdownR - before.maxDrawdownR
    };
}

function markdownReport(report) {
    const holdout = report.holdout.metrics;
    const lines = [
        '# upbit-analyzer 규칙 기반 신호 백테스트', '',
        `생성 시각(UTC): ${report.generatedAtUtc}`,
        `데이터: ${report.data.source}`,
        `기간: ${report.data.requestedRange.startUtc} ~ ${report.data.requestedRange.endExclusiveUtc} 미만`,
        `종목: ${report.data.symbols.map(item => item.symbol).join(', ')}`, '',
        '## 결론', '',
        `- 판정: **${report.verdict}**`,
        '- 승률은 지표 공식의 정확도와 같은 뜻이 아니며, 아래 수치는 고정된 진입·청산 규칙의 비용 반영 성과입니다.', '',
        '## 지표 공식 감사', '',
        '- RSI: Wilder 평활 및 완전 횡보 50 확인',
        '- EMA/MACD: SMA 시드 후 표준 지수평활 확인',
        '- 완료봉: 각 거래소 종료 시각을 기준으로 진행 중 봉 제외 확인',
        '- ATR/SuperTrend: 첫 봉의 high-low가 True Range 시드에서 빠진 오류 수정',
        report.formulaAudit.delta
            ? `- 동일 분할 기준 ATR 수정 전후 차이: 거래 ${report.formulaAudit.delta.sample}, PF ${number(report.formulaAudit.delta.profitFactor)}, 평균 ${number(report.formulaAudit.delta.averageR, 'R')}`
            : '- ATR 수정 전후 성과 차이: 데이터 기간·홀드아웃 분할이 달라 직접 비교하지 않음', '',
        '## 마지막 40% 시간순 홀드아웃', '',
        `- 시작: ${report.holdout.startUtc}`,
        `- 진입 신호: ${report.holdout.signalMetrics.signals}, 다음 봉 체결: ${report.holdout.signalMetrics.fills} (${percent(report.holdout.signalMetrics.fillRate)})`,
        ...metricLines(holdout), '',
        '## 앞 60% 참고 구간', '',
        ...metricLines(report.train.metrics), '',
        '## 체결 가정', '',
        '- 신호: 1시간봉 확정 직후, 미래 봉 미사용',
        '- 진입: 다음 1시간봉에서 계획 진입가에 도달한 경우만 체결',
        '- 시가가 손절선을 이미 넘었다면 신규 진입 취소. 봉 중간 진입의 당봉 익절은 가격 순서를 알 수 없어 인정하지 않음',
        '- 학습·홀드아웃은 포지션 없이 독립 시작, 경계의 잔여 포지션은 마지막 종가 청산. 저장된 기간 기준으로 분할 고정',
        `- 최대 보유: ${report.assumptions.maximumHoldBars}시간, 동일 봉 손절 우선`,
        `- 수수료: 편도 ${(report.assumptions.feeRatePerSide * 100).toFixed(2)}%, 슬리피지: 편도 ${(report.assumptions.slippageRatePerSide * 100).toFixed(2)}%`,
        '- 숏은 현물 가격을 사용한 가상 성과이며 현물 계정에서 직접 실행 가능한 주문이라는 뜻이 아닙니다.', '',
        '## 홀드아웃 종목별', '',
        '| 종목 | 거래 | 승률 | PF | 평균 R | 최대낙폭 R |',
        '|---|---:|---:|---:|---:|---:|',
        ...Object.entries(report.holdout.bySymbol).map(([symbol, row]) => `| ${symbol} | ${row.sample} | ${percent(row.winRate)} | ${number(row.profitFactor)} | ${number(row.averageR)} | ${number(row.maxDrawdownR)} |`), '',
        '## 홀드아웃 방향별', '',
        '| 방향 | 거래 | 승률 | PF | 평균 R | 최대낙폭 R |',
        '|---|---:|---:|---:|---:|---:|',
        ...Object.entries(report.holdout.bySide).map(([side, row]) => `| ${side} | ${row.sample} | ${percent(row.winRate)} | ${number(row.profitFactor)} | ${number(row.averageR)} | ${number(row.maxDrawdownR)} |`), '',
        '## 데이터 품질', '',
        '| 종목 | 시간봉 | 봉 수 | 간격 이상 | OHLC 이상 | 0 거래량 |',
        '|---|---|---:|---:|---:|---:|',
        ...report.data.symbols.flatMap(item => Object.entries(item.timeframes).map(([tf, row]) => `| ${item.symbol} | ${tf} | ${row.bars} | ${row.quality.gaps} | ${row.quality.invalidOhlc} | ${row.quality.zeroVolume} |`)), '',
        '## 한계', '',
        '- 지정가 체결 순서, 호가 잔량, 부분 체결, 세금, 주문 거절은 반영하지 않았습니다.',
        '- 최대낙폭은 청산 시점 누적 R 기준이며 미실현 손익·레버리지·계좌 잔고 배분을 반영하지 않습니다.',
        '- 이전에 반복 평가한 스냅샷의 재검증이며 신규 미관측 표본이 아닙니다. 다른 거래소·종목의 적중률을 뜻하지 않습니다.',
        '- 과거 성과는 미래 수익을 보장하지 않습니다.'
    ];
    return `${lines.join('\n')}\n`;
}

function main() {
    const { manifest, sets } = loadSnapshot();
    // 저장된 기간으로만 분할한다. 실행 날짜가 바뀌어도 같은 스냅샷은 같은 결과가 나와야 한다.
    const start = Date.parse(manifest.requestedRange.startUtc) / 1000;
    const end = Date.parse(manifest.requestedRange.endExclusiveUtc) / 1000;
    const splitTime = Math.floor((start + (end - start) * (1 - config.lastWindowRatio))/3600)*3600;
    let allTrades = [];
    let allSignals = [];
    const diagnostics = [];
    for (const set of sets) {
        process.stdout.write(`${set.symbol} 시뮬레이션 중... `);
        const train = simulateSymbol(set, {start, end:splitTime});
        const test = simulateSymbol(set, {start:splitTime, end});
        const result = {symbol:set.symbol, trades:train.trades.concat(test.trades), signals:train.signals.concat(test.signals), blocked:{train:train.blocked,holdout:test.blocked}};
        allTrades = allTrades.concat(result.trades);
        allSignals = allSignals.concat(result.signals);
        diagnostics.push({ symbol: result.symbol, blocked: result.blocked });
        console.log(`${result.trades.length}거래`);
    }

    const trainTrades = allTrades.filter(trade => trade.entryTime < splitTime);
    const holdoutTrades = allTrades.filter(trade => trade.entryTime >= splitTime);
    const trainSignals = allSignals.filter(signal => signal.signalTime < splitTime);
    const holdoutSignals = allSignals.filter(signal => signal.signalTime >= splitTime);
    const holdoutMetrics = metrics(holdoutTrades);
    const baselinePath = path.join(RESULT_DIR, 'baseline-before-atr-fix.json');
    const baseline = fs.existsSync(baselinePath)
        ? JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
        : null;
    const holdoutStartUtc = new Date(splitTime * 1000).toISOString();
    // 기준선의 분할 시각이 현재 스냅샷과 정확히 같을 때만 공식 수정의 성과 차이를 계산한다.
    // 기간이 달라진 결과를 ATR 효과로 표시하면 데이터 변화와 공식 변화를 혼동하게 된다.
    const comparableBaseline = null; // 체결·분할 규칙이 달라 ATR 단독 효과로 비교하지 않는다.
    const verdict = holdoutMetrics.sample >= config.minimumSample
        && holdoutMetrics.averageR > 0
        && holdoutMetrics.profitFactor > 1
        ? '양의 성과 관찰'
        : '전략 우위 미확인';

    const report = {
        schemaVersion: 2,
        generatedAtUtc: new Date().toISOString(),
        verdict,
        engine: {
            ta: TAEngine.VERSION,
            level: LevelEngine.VERSION,
            signal: SignalEngine.VERSION
        },
        data: manifest,
        assumptions: {
            nextBarLimitEntry: true,
            maximumHoldBars: config.maximumHoldBars,
            sameBarPriority: 'STOP',
            intrabarEntryTarget: 'DEFER_TO_NEXT_BAR',
            invalidatedEntryGap: 'CANCEL',
            periodBoundary: 'FLAT_START_CLOSE_AT_END',
            feeRatePerSide: config.feeRatePerSide,
            slippageRatePerSide: config.slippageRatePerSide,
            minimumSample: config.minimumSample
        },
        formulaAudit: {
            atrFirstTrueRangeFixed: true,
            baseline: comparableBaseline ? comparableBaseline.holdout : null,
            delta: metricDelta(holdoutMetrics, comparableBaseline ? comparableBaseline.holdout : null)
        },
        train: {
            endUtc: new Date(splitTime * 1000).toISOString(),
            signalMetrics: signalMetrics(trainSignals),
            metrics: metrics(trainTrades)
        },
        holdout: {
            startUtc: holdoutStartUtc,
            signalMetrics: signalMetrics(holdoutSignals),
            metrics: holdoutMetrics,
            bySymbol: groupMetrics(holdoutTrades, 'symbol'),
            bySide: groupMetrics(holdoutTrades, 'side')
        },
        diagnostics,
        trades: allTrades
    };

    fs.mkdirSync(RESULT_DIR, { recursive: true });
    fs.writeFileSync(path.join(RESULT_DIR, 'signal-report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(RESULT_DIR, 'signal-report.md'), markdownReport(report));
    // 공개 요약을 같은 실행 결과에서 생성해 수동 복사로 인한 수치 불일치를 방지한다.
    const summary = {status:verdict, summary:`홀드아웃 ${holdoutMetrics.sample}거래 · 승률 ${percent(holdoutMetrics.winRate)} · PF ${number(holdoutMetrics.profitFactor)} · 평균 ${number(holdoutMetrics.averageR,'R')}`,
        detail:`Binance 현물 5종 · ${manifest.requestedRange.endExclusiveUtc} 미만 · 가상 숏 포함`, generatedAtUtc:report.generatedAtUtc};
    fs.writeFileSync(path.join(RESULT_DIR,'summary.js'),'/* 백테스트에서 자동 생성한 공개 요약 */\nglobalThis.UPBIT_SIGNAL_BACKTEST = Object.freeze('+JSON.stringify(summary)+');\n');
    console.log(`홀드아웃: ${holdoutMetrics.sample}건 · 승률 ${percent(holdoutMetrics.winRate)} · PF ${number(holdoutMetrics.profitFactor)} · 평균 ${number(holdoutMetrics.averageR, 'R')} · ${verdict}`);
}

if (require.main === module) main();

module.exports = {
    loadSnapshot,
    simulateSymbol,
    lastIndexAtOrBefore,
    confirmedWindow,
    fillPending,
    closePosition,
    evaluatePosition,
    metrics,
    signalMetrics
};
