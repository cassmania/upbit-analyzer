"use strict";
const S = require("../../lib/private-security");
module.exports = async function handler(req, res) {
    try {
        S.protect(req, res);
        if (req.method === "GET") {
            await S.requireOwner(req);
            return res.status(200).json({ authenticated: true });
        }
        if (req.method !== "POST") throw new S.PrivateError(405, "METHOD_NOT_ALLOWED");
        const input = S.body(req);
        if (input.action === "set-password") {
            if (typeof input.token !== "string" || input.token.length < 20 || input.token.length > 3000 ||
                typeof input.password !== "string" || input.password.length < 12 || input.password.length > 128) {
                throw new S.PrivateError(400, "INVALID_INPUT");
            }
            // 메일을 확인한 본인 세션만 새 비밀번호를 설정할 수 있다.
            await S.verifyToken(input.token);
            await S.rateLimit(input.token);
            await S.supabase("/auth/v1/user", input.token, { method: "PUT", body: JSON.stringify({ password: input.password }) });
            await S.supabase("/auth/v1/logout?scope=local", input.token, { method: "POST" });
            S.clearSession(res);
            return res.status(200).json({ passwordUpdated: true });
        }
        if (input.action === "logout") {
            const session = await S.requireOwner(req);
            await S.supabase("/auth/v1/logout?scope=local", session.token, { method: "POST" });
            S.clearSession(res);
            return res.status(200).json({ authenticated: false });
        }
        if (input.action !== "login" || typeof input.email !== "string" || input.email.length > 254 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || typeof input.password !== "string" ||
            input.password.length < 1 || input.password.length > 1024) throw new S.PrivateError(400, "INVALID_INPUT");
        await S.rateLimit();
        const data = await S.supabase("/auth/v1/token?grant_type=password", null, {
            method: "POST", body: JSON.stringify({ email: input.email, password: input.password })
        });
        // 검증된 사용자 ID를 서버 허용 목록과 비교한 뒤에만 쿠키를 발급한다.
        try { await S.verifyToken(data.access_token); }
        catch (error) {
            if (data.access_token) await S.supabase("/auth/v1/logout?scope=local", data.access_token, { method: "POST" }).catch(() => {});
            throw error;
        }
        S.setSession(res, data.access_token, data.expires_in);
        return res.status(200).json({ authenticated: true });
    } catch (error) { return S.fail(res, error); }
};
