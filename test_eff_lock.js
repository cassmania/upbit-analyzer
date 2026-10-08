"use strict";
// test_eff_lock.js — node test_eff_lock.js 로 실행. 외부 호출 없음.
// 실효 레버리지 고정(openCalc/effOf/syncMargin) 검증.
const assert = require("node:assert/strict");
const T = require("./terminal-ai");

// 진입 직후 실효 == 설정 레버리지 (10x → 10.0x)
let c = T.openCalc(100, 5, 10, 0.1);
assert.ok(c, "openCalc null");
assert.equal(Math.round(c.margin * 100) / 100, 5);
const fresh = { price: 100, vol: 5, lev: 10, cs: 0.1, margin: c.margin };
assert.ok(Math.abs(T.effOf(fresh) - 10) < 1e-9, "eff=" + T.effOf(fresh));

// 자동마진 수혈 누적 시 실효 하락 재현: 마진 2.33배 → 실효 약 4.3x
const drifted = { price: 100, vol: 5, lev: 10, cs: 0.1, margin: c.margin * 2.3256, added: c.margin * 1.3256 };
assert.ok(Math.abs(T.effOf(drifted) - 4.3) < 0.05, "eff=" + T.effOf(drifted));

// 실효 맞춤: 마진을 명목/레버로 복원, 늘어난분 환불, added=0
const s = T.syncMargin(drifted);
assert.ok(s, "syncMargin null");
assert.equal(s.added, 0);
assert.ok(Math.abs(s.margin - c.margin) < 0.011, "margin=" + s.margin);
assert.ok(s.refund > 0, "refund=" + s.refund);
// 청산가는 openCalc와 같은 공식이어야 한다
assert.ok(Math.abs(s.liqLong - c.liqLong) < 1e-9, "liqLong mismatch");
assert.ok(Math.abs(T.effOf({ price: 100, vol: 5, lev: 10, cs: 0.1, margin: s.margin }) - 10) < 1e-9);

// 비정상 입력
assert.equal(T.syncMargin({ price: 100, vol: 5, lev: 0, cs: 0.1 }), null);
assert.equal(T.syncMargin({ price: 100, vol: 5, lev: 10, cs: 0 }), null);
assert.equal(T.effOf({ price: 100, vol: 5, cs: 0.1, margin: 0 }), 0);

console.log("eff-lock: ALL PASS");
