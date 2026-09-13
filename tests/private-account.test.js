"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const F = require("./private-fixture"); F.configure();
const S = require("../lib/private-security"), M = require("../lib/mexc-account");
const session = require("../api/private/session"), mexc = require("../api/private/mexc");
let state;
test.beforeEach(() => { F.configure(); state = F.fixture(); global.fetch = state.fetch; });
async function call(handler, method = "GET", input, cookie, extra = {}) {
    const headers = { "x-private-request": "1", origin: process.env.PRIVATE_APP_ORIGIN, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...extra };
    const res = { headers: {}, code: 200, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
    await handler({ method, body: input, headers }, res); return res;
}
async function login() {
    const res = await call(session, "POST", { action: "login", email: "fixture@example.test", password: "fixture-password" });
    assert.equal(res.code, 200); return res.headers["set-cookie"].split(";")[0];
}
test("미설정은 접근 거부하며 캐시를 허용하지 않는다", async () => {
    delete process.env.PRIVATE_OWNER_ID;
    const r = await call(mexc); assert.equal(r.code, 503); assert.equal(r.data.error, "SETUP_REQUIRED");
    assert.match(r.headers["cache-control"], /no-store/); assert.equal(state.calls.length, 0);
});
test("비로그인 계정 API는 MEXC 호출 전에 차단한다", async () => {
    const r = await call(mexc); assert.equal(r.code, 401); assert.equal(state.calls.length, 0);
});
test("교차 출처와 헤더 없는 요청은 거부한다", async () => {
    for (const headers of [{ origin: "https://evil.test" }, { "x-private-request": "" }, { "sec-fetch-site": "cross-site" }]) {
        const r = await call(session, "POST", { action: "login" }, null, headers); assert.equal(r.code, 403);
    }
    assert.equal(state.calls.length, 0);
});
test("다른 유효 사용자도 소유자가 아니면 쿠키가 발급되지 않는다", async () => {
    state.other = true; const r = await call(session, "POST", { action: "login", email: "other@example.test", password: "password" });
    assert.equal(r.code, 403); assert.equal(r.headers["set-cookie"], undefined);
});
test("세션 쿠키는 암호화 및 Secure HttpOnly SameSite를 적용한다", async () => {
    const r = await call(session, "POST", { action: "login", email: "fixture@example.test", password: "password" });
    assert.match(r.headers["set-cookie"], /HttpOnly; Secure; SameSite=Strict/);
    assert.ok(!r.headers["set-cookie"].includes("fixture-token")); assert.deepEqual(r.data, { authenticated: true });
});

test("사용자 ID가 같아도 지정 이메일과 다르면 로그인과 쿠키 발급을 거부한다", async () => {
    state.email = "different@example.test";
    const r = await call(session, "POST", { action: "login", email: state.email, password: "password" });
    assert.equal(r.code, 403); assert.equal(r.data.error, "OWNER_ONLY");
    assert.equal(r.headers["set-cookie"], undefined);
});

test("소유자 이메일 설정이 없으면 기존 소유자도 차단한다", async () => {
    delete process.env.PRIVATE_OWNER_EMAIL;
    const r = await call(session);
    assert.equal(r.code, 503); assert.equal(r.data.error, "SETUP_REQUIRED");
    assert.equal(state.calls.length, 0);
});

test("다른 이메일의 초대 토큰으로 비밀번호를 설정할 수 없다", async () => {
    state.email = "different@example.test";
    const r = await call(session, "POST", { action: "set-password", token: "fixture-invitation-token", password: "test-new-password-123" });
    assert.equal(r.code, 403);
    assert.ok(!state.calls.some(x => x.options.method === "PUT"));
});

test("본인 비밀번호 설정은 검증 후 수행하고 초대 세션을 폐기한다", async () => {
    const r = await call(session, "POST", { action: "set-password", token: "fixture-invitation-token", password: "test-new-password-123" });
    assert.equal(r.code, 200); assert.deepEqual(r.data, { passwordUpdated: true });
    assert.equal(state.active, false);
    assert.ok(state.calls.some(x => x.url.endsWith('/auth/v1/user') && x.options.method === 'PUT'));
    assert.ok(!JSON.stringify(r.data).includes('test-new-password'));
});
test("로그아웃 후 복사한 이전 쿠키의 재사용을 거부한다", async () => {
    const cookie = await login(); assert.equal((await call(session, "POST", { action: "logout" }, cookie)).code, 200);
    const r = await call(mexc, "GET", null, cookie); assert.equal(r.code, 401); assert.equal(r.data.error, "SESSION_EXPIRED");
    assert.ok(!state.calls.some(x => x.url.startsWith("https://api.mexc.com")));
});
test("암호문은 무작위이며 변경·목적·소유자 변경을 거부한다", () => {
    const a = S.seal({ secret: "secret-value" }, "mexc:v1:owner");
    assert.notEqual(a, S.seal({ secret: "secret-value" }, "mexc:v1:owner"));
    assert.deepEqual(S.unseal(a, "mexc:v1:owner"), { secret: "secret-value" });
    const bytes = Buffer.from(a, "base64url"); bytes[30] ^= 1;
    assert.throws(() => S.unseal(bytes.toString("base64url"), "mexc:v1:owner"));
    assert.throws(() => S.unseal(a, "session:v1")); assert.throws(() => S.unseal(a, "mexc:v1:other"));
});
test("실제 조회 검증 후 암호문만 DB로 전달한다", async () => {
    const cookie = await login();
    const r = await call(mexc, "POST", { apiKey: "fixture-access-key", secret: "fixture-secret-key", readOnly: true }, cookie);
    assert.equal(r.code, 200); assert.equal(r.data.sections.positions.rows.length, 2);
    assert.ok(!JSON.stringify(state.credential).includes("fixture-secret-key"));
    assert.ok(!JSON.stringify(r.data).includes("fixture-access-key"));
    assert.equal(S.unseal(state.credential.ciphertext, "mexc:v1:" + F.OWNER).secret, "fixture-secret-key");
    assert.equal((await call(mexc, "GET", null, cookie)).data.connected, true);
});
test("MEXC 키 검증 실패는 기존 연결을 덮어쓰지 않고 원문 오류를 숨긴다", async () => {
    const cookie = await login(); state.credential = { ciphertext: "existing" }; state.deniedMexc = true;
    const r = await call(mexc, "POST", { apiKey: "fixture-access-key", secret: "fixture-secret-key", readOnly: true }, cookie);
    assert.equal(r.code, 400); assert.equal(state.credential.ciphertext, "existing");
    assert.deepEqual(r.data.checks, { spot: "MEXC_ACCESS_DENIED", futures: "MEXC_ACCESS_DENIED" });
    assert.ok(!JSON.stringify(r.data).includes("원문"));
});
test("사용자 ID를 요청 본문에 주입해도 서버의 소유자 ID만 저장한다", async () => {
    const cookie = await login();
    await call(mexc, "POST", { apiKey: "fixture-access-key", secret: "fixture-secret-key", readOnly: true, user_id: F.OTHER }, cookie);
    assert.equal(state.credential.user_id, F.OWNER);
});
test("분산 요청 제한 실패는 거래소 호출 전에 차단한다", async () => {
    const cookie = await login(); state.limit = false;
    const r = await call(mexc, "GET", null, cookie); assert.equal(r.code, 429); assert.equal(r.headers["retry-after"], "60");
    assert.ok(!state.calls.some(x => x.url.startsWith("https://api.mexc.com")));
});
test("MEXC 선물 서명은 정렬 쿼리와 공식 원문 조합을 사용한다", () => {
    const keys = { apiKey: "fixture-access-key", secret: "fixture-secret-key" };
    const r = M.signedRequest("futures", "/api/v1/private/order/list/open_orders", keys, { page_size: 100, page_num: 1 }, 1234);
    assert.equal(r.headers.Signature, crypto.createHmac("sha256", keys.secret).update(keys.apiKey + "1234page_num=1&page_size=100").digest("hex"));
    assert.ok(r.url.startsWith("https://api.mexc.com/"));
    assert.throws(() => M.signedRequest("futures", "/api/v1/private/order/submit", keys));
});
test("MEXC 현물 서명은 쿼리 원문을 서명한다", () => {
    const keys = { apiKey: "fixture-access-key", secret: "fixture-secret-key" };
    const r = M.signedRequest("spot", "/api/v3/account", keys, {}, 1234), u = new URL(r.url);
    const signature = u.searchParams.get("signature"); u.searchParams.delete("signature");
    assert.equal(signature, crypto.createHmac("sha256", keys.secret).update(u.searchParams.toString()).digest("hex"));
    assert.equal(r.headers["X-MEXC-APIKEY"], keys.apiKey);
});
test("교차 청산가와 누락된 손익을 0이나 확정 가격으로 만들지 않는다", () => {
    const [p] = M.positions([{ symbol: "BTC_USDT", holdVol: 1, positionType: 2, openType: 2, liquidatePrice: 100, unRealizedPnl: null }]);
    assert.equal(p.liquidationPrice, null); assert.equal(p.unrealized, null); assert.equal(p.direction, "숏");
});
test("키 연결 해제는 서버 저장소에서 소유자 연결만 제거한다", async () => {
    const cookie = await login(); state.credential = { ciphertext: "test" };
    const r = await call(mexc, "DELETE", null, cookie); assert.equal(r.code, 200); assert.equal(state.credential, null);
});
