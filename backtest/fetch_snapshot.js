'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const config = require('./config.js');

const DATA_DIR = path.join(__dirname, 'data');

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function fetchStart(timeframe) {
    const info = config.timeframes[timeframe];
    if (info.fetchStartUtc) return Date.parse(info.fetchStartUtc);
    return Date.parse(config.startUtc) - info.milliseconds * info.warmupBars;
}

function normalizeKline(item) {
    return {
        time: Math.floor(Number(item[0]) / 1000),
        endTime: Math.floor((Number(item[6]) + 1) / 1000),
        o: Number(item[1]),
        h: Number(item[2]),
        l: Number(item[3]),
        c: Number(item[4]),
        v: Number(item[5])
    };
}

async function fetchJson(url, attempts = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await fetch(url, { headers: { accept: 'application/json' } });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const body = await response.json();
            if (!Array.isArray(body)) throw new Error('배열 응답이 아닙니다.');
            return body;
        } catch (error) {
            lastError = error;
            if (attempt < attempts) await sleep(500 * attempt);
        }
    }
    throw new Error(`${lastError?.message || '알 수 없는 오류'}: ${url}`);
}

async function fetchTimeframe(symbol, timeframe) {
    const info = config.timeframes[timeframe];
    const endExclusive = Date.parse(config.endUtc);
    let cursor = fetchStart(timeframe);
    const rows = new Map();

    while (cursor < endExclusive) {
        const query = new URLSearchParams({
            symbol,
            interval: info.interval,
            startTime: String(cursor),
            endTime: String(endExclusive - 1),
            limit: '1000'
        });
        const body = await fetchJson(`https://api.binance.com/api/v3/klines?${query}`);
        if (!body.length) break;
        for (const item of body) {
            const row = normalizeKline(item);
            if (row.endTime * 1000 <= endExclusive) rows.set(row.time, row);
        }
        const next = Number(body.at(-1)[0]) + info.milliseconds;
        if (!Number.isFinite(next) || next <= cursor || body.length < 1000) break;
        cursor = next;
        await sleep(80);
    }

    return [...rows.values()].sort((a, b) => a.time - b.time);
}

function dataQuality(rows, timeframe) {
    let invalidOhlc = 0;
    let zeroVolume = 0;
    let duplicateOrOutOfOrder = 0;
    let gaps = 0;
    const fixed = config.timeframes[timeframe].milliseconds;

    rows.forEach((row, index) => {
        if (!(row.l > 0 && row.h >= row.l && row.o >= row.l && row.o <= row.h
            && row.c >= row.l && row.c <= row.h)) invalidOhlc += 1;
        if (!(row.v > 0)) zeroVolume += 1;
        if (index > 0) {
            const difference = (row.time - rows[index - 1].time) * 1000;
            if (difference <= 0) duplicateOrOutOfOrder += 1;
            // 월봉은 월 길이가 달라 고정 간격 검사를 적용하지 않습니다.
            if (timeframe !== '1M' && difference !== fixed) gaps += 1;
        }
    });
    return { gaps, invalidOhlc, zeroVolume, duplicateOrOutOfOrder };
}

async function main() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const manifest = {
        schemaVersion: 1,
        fetchedAtUtc: new Date().toISOString(),
        source: config.source,
        requestedRange: { startUtc: config.startUtc, endExclusiveUtc: config.endUtc },
        symbols: []
    };

    for (const symbol of config.symbols) {
        const timeframes = {};
        const summary = { symbol, timeframes: {} };
        for (const timeframe of Object.keys(config.timeframes)) {
            process.stdout.write(`${symbol} ${timeframe} 다운로드 중... `);
            const rows = await fetchTimeframe(symbol, timeframe);
            if (!rows.length) throw new Error(`${symbol} ${timeframe}: 캔들 데이터가 없습니다.`);
            timeframes[timeframe] = rows;
            summary.timeframes[timeframe] = {
                bars: rows.length,
                firstTimeUtc: new Date(rows[0].time * 1000).toISOString(),
                lastEndTimeUtc: new Date(rows.at(-1).endTime * 1000).toISOString(),
                quality: dataQuality(rows, timeframe)
            };
            console.log(`${rows.length}봉`);
            await sleep(80);
        }

        const json = JSON.stringify({ symbol, timeframes });
        const compressed = zlib.gzipSync(Buffer.from(json), { level: 9 });
        const file = `${symbol}.json.gz`;
        fs.writeFileSync(path.join(DATA_DIR, file), compressed);
        summary.file = file;
        summary.uncompressedBytes = Buffer.byteLength(json);
        summary.compressedBytes = compressed.length;
        summary.sha256 = crypto.createHash('sha256').update(json).digest('hex');
        manifest.symbols.push(summary);
    }

    fs.writeFileSync(path.join(DATA_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(`스냅샷 저장 완료: ${DATA_DIR}`);
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = { fetchStart, normalizeKline, dataQuality, fetchTimeframe };
