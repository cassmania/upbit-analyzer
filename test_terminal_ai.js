"use strict";
// test_terminal_ai.js — node test_terminal_ai.js. 외부 호출 없음.
const assert = require("node:assert/strict");
const TA = require("./ta_engine");
const LV = require("./level_analyzer");
const SIG = require("./signal_engine");
const AI = require("./terminal-ai");

// 결정적 합성봉: 상승 추세 + 눌림. 과거→최신순 MEXC 배열형
function synth(n, base, drift, amp, seed) {
    const time = [], open = [], high = [], low = [], close = [], vol = [];
    let c = base, s = seed;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < n; i++) {
        const o = c, wave = Math.sin(i / 9) * amp;
        c = Math.max(1, base + drift * i + wave + (rnd() - 0.5) * amp * 0.3);
        time.push(1700000000 + i * 3600);
        open.push(o); high.push(Math.max(o, c) * 1.001); low.push(Math.min(o, c) * 0.999);
        close.push(c); vol.push(1000 + rnd() * 500);
    }
    return { time, open, high, low, close, vol };
}

const d1h = synth(220, 80000, 40, 900, 7);
const norm = AI.normalizeFutures(d1h);
assert.equal(norm.length, 220);
assert.ok(norm.every(k => ["time", "o", "h", "l", "c", "v"].every(key => key in k)));

// 불량행 제거
const bad = { time: [1, 2], open: [1, 1], high: [1, 0.5], low: [1, 1], close: [1, 1], vol: [1, -5] };
assert.equal(AI.normalizeFutures(bad).length, 1);

// 미완성봉 제거: 마지막 봉 time+3600 > now+60
const now = 1700000000 + 219 * 3600 + 1800;
assert.equal(AI.dropForming(norm, 3600, now).length, 219);
assert.equal(AI.dropForming(norm.slice(0, 100), 3600, now + 10 * 86400).length, 100);

// 리샘플 12개씩
assert.equal(AI.resample(norm, 12).length, Math.ceil(220 / 12));
assert.equal(AI.roundToScale(86547.456, 1), 86547.5);
assert.equal(AI.roundToScale(0.00064789, 8), 0.00064789);

// 풀 파이프라인 (12h는 1h 240봉을 리샘플, 1d는 별도 합성)
const d4h = synth(160, 80000, 160, 1400, 21);
const d1d = synth(120, 75000, 1200, 4000, 99);
const r = AI.runPipeline({ TA, LV, SIG },
    { "1h": synth(240, 80000, 40, 900, 7), "4h": d4h, "12h": synth(240, 80000, 40, 900, 7), "1d": d1d },
    88000, 0.000019);
assert.equal(r.ok, true);
assert.ok(["LONG", "SHORT", "관망"].includes(r.dir), "dir=" + r.dir);
assert.ok(Array.isArray(r.exits.long) && Array.isArray(r.exits.short));
assert.ok(r.entry || r.blocked, "entry/blocked 중 하나는 있어야 함");
if (r.entry) {
    assert.ok(r.entry.entry > 0 && r.entry.stop > 0 && r.entry.target1 > 0 && r.entry.rr >= 1.3);
    console.log("signal:", r.dir, "entry", Math.round(r.entry.entry), "rr", r.entry.rr.toFixed(2), "agree", r.agree + "%");
} else {
    console.log("blocked:", r.blocked);
}

// 엔진 미로드·현재가 없음 fail-soft
assert.equal(AI.runPipeline({}, {}, 0, null).dir, "관망");
console.log("terminal-ai: ALL PASS");
