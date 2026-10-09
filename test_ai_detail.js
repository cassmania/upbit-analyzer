"use strict";
// test_ai_detail.js — node test_ai_detail.js. AI 패널 상세 표시에 필요한 근거 passthrough 검증.
const assert = require("node:assert/strict");
const TA = require("./ta_engine");
const LV = require("./level_analyzer");
const SIG = require("./signal_engine");
const AI = require("./terminal-ai");

function synth(n, base, drift, amp, seed) {
    const time = [], open = [], high = [], low = [], close = [], vol = [];
    let c = base, s = seed;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < n; i++) {
        const o = c;
        c = Math.max(1, o + drift + (rnd() - 0.48) * amp);
        time.push(1700000000 + i * 3600);
        open.push(o); high.push(Math.max(o, c) * 1.001); low.push(Math.min(o, c) * 0.999);
        close.push(c); vol.push(1000 + rnd() * 500);
    }
    return { time, open, high, low, close, vol };
}

const r = AI.runPipeline({ TA, LV, SIG },
    { "1h": synth(240, 80000, 40, 900, 7), "4h": synth(160, 80000, 160, 1400, 21),
      "12h": synth(360, 80000, 40, 900, 11), "1d": synth(120, 75000, 1200, 4000, 99) },
    88000, 0.000019);

// TF별 근거가 함께 와야 AI 패널 상세를 그릴 수 있다
assert.ok(r.frames && ["1h", "4h", "12h", "1d"].every(k => r.frames[k]), "frames keys");
const h1 = r.frames["1h"];
assert.ok(h1 && h1.oscillators, "1h oscillators");
assert.ok(Number.isFinite(h1.oscillators.rsi14), "rsi14");
assert.ok(h1.oscillators.stochastic && Number.isFinite(h1.oscillators.stochastic.k), "stoch k");
assert.ok(Number.isFinite(h1.oscillators.cci20), "cci20");
assert.ok(h1.oscillators.macd && Number.isFinite(h1.oscillators.macd.hist), "macd hist");
assert.ok(h1.confluence && typeof h1.confluence.verdict === "string", "confluence verdict");

// 방향 수렴 표
assert.ok(r.raw && r.raw.방향 && Array.isArray(r.raw.방향.tfs) && r.raw.방향.tfs.length >= 1, "tfs");
for (const t of r.raw.방향.tfs) {
    assert.ok(typeof t.tf === "string" && Number.isFinite(t.net) && typeof t.verdict === "string", JSON.stringify(t));
}

// 데이터 기준시각: 가장 오래된 확정봉, 미래 시각 불가
const nowSec = Math.floor(Date.now() / 1000);
assert.ok(Number.isFinite(r.asOf) && r.asOf > 0 && r.asOf <= nowSec, "asOf=" + r.asOf);

// 펀딩 패스스루 + 청산감시 배열
assert.equal(r.raw.funding, 0.000019);
assert.ok(Array.isArray(r.exits.long) && Array.isArray(r.exits.short));

console.log("ai-detail: ALL PASS (dir=" + r.dir + " asOf=" + new Date(r.asOf * 1000).toISOString() + ")");
