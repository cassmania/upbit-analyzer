"use strict";
const S = require("../../lib/private-security");
const M = require("../../lib/mexc-account");
module.exports = async function handler(req, res) {
    try {
        S.protect(req, res);
        if (!["GET", "POST", "DELETE"].includes(req.method)) throw new S.PrivateError(405, "METHOD_NOT_ALLOWED");
        const session = await S.requireOwner(req);
        await S.rateLimit(session.token);
        const path = "/rest/v1/upbit_private_credentials?user_id=eq." + encodeURIComponent(session.user.id);
        if (req.method === "DELETE") {
            await S.supabase(path, session.token, { method: "DELETE" });
            return res.status(200).json({ connected: false });
        }
        if (req.method === "POST") {
            const input = S.body(req);
            if (input.readOnly !== true) throw new S.PrivateError(400, "READ_ONLY_REQUIRED");
            const credentials = M.validateCredentials(input);
            const snapshot = await M.snapshot(credentials);
            // 최소한 계정 잔고 조회에 성공한 키만 저장한다. 실패한 키로 기존 연결을 덮어쓰지 않는다.
            if (snapshot.sections.spot.status !== "ok" && snapshot.sections.assets.status !== "ok") {
                throw new S.PrivateError(400, "MEXC_KEY_CHECK_FAILED");
            }
            const ciphertext = S.seal(credentials, "mexc:v1:" + session.user.id);
            await S.supabase("/rest/v1/upbit_private_credentials?on_conflict=user_id", session.token, {
                method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
                body: JSON.stringify({ user_id: session.user.id, ciphertext, updated_at: new Date().toISOString() })
            });
            return res.status(200).json(snapshot);
        }
        const rows = await S.supabase(path + "&select=ciphertext&limit=1", session.token);
        if (!Array.isArray(rows)) throw new S.PrivateError(503, "AUTH_UNAVAILABLE");
        if (!rows.length) return res.status(200).json({ connected: false });
        let credentials;
        try { credentials = S.unseal(rows[0].ciphertext, "mexc:v1:" + session.user.id); }
        catch { throw new S.PrivateError(503, "KEY_DECRYPT_FAILED"); }
        return res.status(200).json(await M.snapshot(credentials));
    } catch (error) { return S.fail(res, error); }
};
