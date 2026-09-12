"use strict";
// 실제 계정과 무관한 테스트 전용 데이터. 공개 배포 파일 목록에 포함되지 않는다.
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
function configure(origin = "http://localhost:4177") {
    Object.assign(process.env, { PRIVATE_APP_ORIGIN: origin, PRIVATE_SUPABASE_URL: "https://test-project.supabase.co",
        PRIVATE_SUPABASE_ANON_KEY: "fixture-anon", PRIVATE_OWNER_ID: OWNER, PRIVATE_OWNER_EMAIL: "fixture@example.test", PRIVATE_ENCRYPTION_KEY: "12".repeat(32) });
}
function fixture() {
    const state = { active: true, credential: null, calls: [], other: false, deniedMexc: false, limit: true };
    const reply = (data, status = 200) => new Response(data === null ? null : JSON.stringify(data), { status });
    state.fetch = async (url, options = {}) => {
        state.calls.push({ url, options });
        const u = new URL(url), path = u.pathname;
        if (u.hostname === "test-project.supabase.co") {
            if (path === "/auth/v1/token") { state.active = true; return reply({ access_token: "fixture-token", expires_in: 3600 }); }
            if (path === "/auth/v1/user") return reply({ id: state.other ? OTHER : OWNER, email: state.email || "fixture@example.test", email_confirmed_at: "2026-01-01T00:00:00Z" });
            if (path === "/auth/v1/logout") { state.active = false; return reply(null, 204); }
            if (path.endsWith("upbit_private_session_active")) return reply(state.active);
            if (path.endsWith("upbit_private_rate_limit") || path.endsWith("upbit_private_login_limit")) return reply(state.limit);
            if (path.endsWith("upbit_private_credentials")) {
                if (options.method === "POST") { state.credential = JSON.parse(options.body); return reply(null, 201); }
                if (options.method === "DELETE") { state.credential = null; return reply(null, 204); }
                return reply(state.credential ? [{ ciphertext: state.credential.ciphertext }] : []);
            }
        }
        if (u.hostname === "api.mexc.com") {
            if (state.deniedMexc) return reply({ message: "원문 비밀정보가 응답에 노출되면 안 됨", code: -1 }, 403);
            if (path === "/api/v3/account") return reply({ balances: [{ asset: "USDT", free: "125.50", locked: "10" }] });
            if (path === "/api/v3/openOrders") return reply([]);
            if (path.endsWith("account/assets")) return reply({ success: true, code: 0, data: [{ currency: "USDT", equity: 250, availableBalance: 200, positionMargin: 50, unrealized: -4.5 }] });
            if (path.endsWith("open_positions")) return reply({ success: true, code: 0, data: [
                { symbol: "BTC_USDT", positionType: 1, openType: 1, holdVol: 5, holdAvgPrice: 100000, liquidatePrice: 80000, leverage: 5, unRealizedPnl: 12 },
                { symbol: "ETH_USDT", positionType: 2, openType: 2, holdVol: 3, holdAvgPrice: 3000, liquidatePrice: 3200, leverage: 10, unRealizedPnl: -16.5 }
            ] });
            if (path.endsWith("open_orders")) return reply({ success: true, code: 0, data: [] });
        }
        throw new Error("허용되지 않은 테스트 요청");
    };
    return state;
}
module.exports = { configure, fixture, OWNER, OTHER };
