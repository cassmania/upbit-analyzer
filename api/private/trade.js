"use strict";
// api/private/trade.js — AI 터미널의 주문 게이트웨이. 기본은 관망·모의다.
// live 주문이 MEXC로 나가는 조건 (모두 충족해야 함):
//  1. Supabase 002 마이그레이션 적용 + trade_state.trade_enabled=true
//  2. 서버 환경변수 TRADE_KILL_SWITCH != "1"
//  3. 요청 본문에 live:true + 가드 통과 + 거래 권한 키 등록됨
// 키 원문·서명은 로그·응답에 절대 기록하지 않는다 (lib/private-security.fail 참조).
const S = require("../../lib/private-security");
const M = require("../../lib/mexc-account");
const T = require("../../lib/mexc-trade");
const G = require("../../lib/trade-guards");

const CONTRACT = "https://contract.mexc.com/api/v1/contract";
const quoteCache = new Map(); // symbol -> {at, lastPrice, contractSize}

async function quote(symbol) {
    const hit = quoteCache.get(symbol);
    if (hit && Date.now() - hit.at < 60000) return hit;
    const [tickRes, detailRes] = await Promise.all([
        fetch(CONTRACT + "/ticker", { signal: AbortSignal.timeout(10000) }),
        fetch(CONTRACT + "/detail", { signal: AbortSignal.timeout(10000) }),
    ]);
    if (!tickRes.ok || !detailRes.ok) throw new S.PrivateError(502, "MEXC_UNAVAILABLE");
    const tickers = (await tickRes.json()).data || [];
    const details = (await detailRes.json()).data || [];
    const tick = tickers.find(t => t.symbol === symbol);
    const info = details.find(d => d.symbol === symbol);
    const lastPrice = tick && Number.isFinite(Number(tick.lastPrice)) ? Number(tick.lastPrice) : null;
    const contractSize = info && Number.isFinite(Number(info.contractSize)) ? Number(info.contractSize) : null;
    if (!(lastPrice > 0) || !(contractSize > 0)) throw new S.PrivateError(502, "MEXC_RESPONSE_INVALID");
    const value = { at: Date.now(), lastPrice, contractSize };
    quoteCache.set(symbol, value);
    return value;
}

async function tradeState(session) {
    // 마이그레이션 미적용이면 빈 배열이 아니라 오류가 나며, live 경로는 fail-closed 된다
    const rows = await S.supabase("/rest/v1/upbit_trade_state?user_id=eq." + encodeURIComponent(session.user.id) +
        "&select=trade_enabled,max_notional&limit=1", session.token);
    if (!Array.isArray(rows)) throw new S.PrivateError(503, "AUTH_UNAVAILABLE");
    return rows[0] || null;
}

async function storedCredentials(session) {
    const rows = await S.supabase("/rest/v1/upbit_private_credentials?user_id=eq." + encodeURIComponent(session.user.id) +
        "&select=ciphertext&limit=1", session.token);
    if (!Array.isArray(rows) || !rows.length) throw new S.PrivateError(400, "TRADE_KEY_MISSING");
    try { return S.unseal(rows[0].ciphertext, "mexc:v1:" + session.user.id); }
    catch { throw new S.PrivateError(503, "KEY_DECRYPT_FAILED"); }
}

module.exports = async function handler(req, res) {
    try {
        S.protect(req, res);
        if (!["GET", "POST"].includes(req.method)) throw new S.PrivateError(405, "METHOD_NOT_ALLOWED");
        const session = await S.requireOwner(req);
        await S.rateLimit(session.token);
        if (process.env.TRADE_KILL_SWITCH === "1") throw new PrivateErrorKill();

        if (req.method === "GET") {
            const st = await tradeState(session).catch(() => null);
            return res.status(200).json({ dryRun: true, tradeEnabled: st ? st.trade_enabled === true : false,
                killSwitch: false, caps: { maxLeverage: G.CAPS.maxLeverage,
                    maxNotionalUsdt: st && Number(st.max_notional) > 0 ? Math.min(Number(st.max_notional), G.CAPS.maxNotionalUsdt) : G.CAPS.maxNotionalUsdt,
                    isolatedOnly: true } });
        }
        const input = S.body(req);
        if (input.action === "enable") {
            // 거래 권한 키 등록. 읽기 전용 키와 달리 명시적 확인 문구를 요구한다
            if (input.confirm !== "ENABLE-LIVE-TRADE") throw new S.PrivateError(400, "CONFIRM_REQUIRED");
            const credentials = T.validateTradeCredentials(input);
            const snapshot = await M.snapshot(credentials);
            if (snapshot.sections.assets.status !== "ok" && snapshot.sections.spot.status !== "ok") {
                return res.status(400).json({ error: "MEXC_KEY_CHECK_FAILED" });
            }
            const ciphertext = S.seal(credentials, "mexc:v1:" + session.user.id);
            await S.supabase("/rest/v1/upbit_private_credentials?on_conflict=user_id", session.token, {
                method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
                body: JSON.stringify({ user_id: session.user.id, ciphertext, updated_at: new Date().toISOString() }) });
            await S.supabase("/rest/v1/upbit_trade_state?on_conflict=user_id", session.token, {
                method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
                body: JSON.stringify({ user_id: session.user.id, trade_enabled: true, updated_at: new Date().toISOString() }) });
            return res.status(200).json({ tradeEnabled: true, dryRun: true });
        }
        if (input.action === "disable") {
            await S.supabase("/rest/v1/upbit_trade_state?user_id=eq." + encodeURIComponent(session.user.id), session.token, {
                method: "PATCH", body: JSON.stringify({ trade_enabled: false, updated_at: new Date().toISOString() }) });
            return res.status(200).json({ tradeEnabled: false });
        }
        if (input.action === "submit" || input.action === "cancel") {
            const live = input.live === true;
            if (input.action === "cancel") {
                const { orderIds } = G.validateCancel(input.orderIds);
                if (!live) return res.status(200).json({ dryRun: true, orderIds });
                const st = await tradeState(session);
                if (!st || st.trade_enabled !== true) throw new S.PrivateError(403, "TRADE_NOT_ENABLED");
                const credentials = await storedCredentials(session);
                const data = await T.post("/api/v1/private/order/cancel", { orderIds }, credentials);
                return res.status(200).json({ dryRun: false, result: data.map(d => ({ orderId: String(d.orderId), ok: Number(d.errorCode) === 0 })) });
            }
            const intent = { ...(input.intent || {}), idempotencyKey: input.idempotencyKey };
            const q = await quote(String(intent.symbol || "").toUpperCase());
            const checked = G.validateIntent(intent, q);
            if (!live) return res.status(200).json({ dryRun: true, order: checked.order, notional: checked.notional });
            const st = await tradeState(session);
            if (!st || st.trade_enabled !== true) throw new S.PrivateError(403, "TRADE_NOT_ENABLED");
            const cap = Number(st.max_notional) > 0 ? Math.min(Number(st.max_notional), G.CAPS.maxNotionalUsdt) : G.CAPS.maxNotionalUsdt;
            if (checked.notional > cap) throw new S.PrivateError(400, "NOTIONAL_TOO_LARGE");
            const credentials = await storedCredentials(session);
            const data = await T.post("/api/v1/private/order/create", checked.order, credentials);
            return res.status(200).json({ dryRun: false, orderId: String(data.orderId), notional: checked.notional });
        }
        throw new S.PrivateError(400, "UNKNOWN_ACTION");
    } catch (error) { return S.fail(res, error); }
};
function PrivateErrorKill() { return new S.PrivateError(403, "TRADE_KILLED"); }
