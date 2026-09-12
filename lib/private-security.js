"use strict";
const crypto = require("node:crypto");

// 세션과 API 키는 용도를 구분한 AES-GCM 암호문으로만 보관한다.
const COOKIE = "__Host-upbit-private";
class PrivateError extends Error {
    constructor(status, code) { super(code); this.status = status; this.code = code; }
}
function config() {
    const env = process.env;
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(env.PRIVATE_SUPABASE_URL || "") ||
        !env.PRIVATE_SUPABASE_ANON_KEY || !/^[a-f0-9-]{36}$/i.test(env.PRIVATE_OWNER_ID || "") ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.PRIVATE_OWNER_EMAIL || "") ||
        !/^[a-f0-9]{64}$/i.test(env.PRIVATE_ENCRYPTION_KEY || "")) {
        throw new PrivateError(503, "SETUP_REQUIRED");
    }
    let origin;
    try { origin = new URL(env.PRIVATE_APP_ORIGIN).origin; } catch { throw new PrivateError(503, "SETUP_REQUIRED"); }
    if (origin !== env.PRIVATE_APP_ORIGIN ||
        (!origin.startsWith("https://") && !(env.NODE_ENV !== "production" && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)))) {
        throw new PrivateError(503, "SETUP_REQUIRED");
    }
    return { url: env.PRIVATE_SUPABASE_URL, anon: env.PRIVATE_SUPABASE_ANON_KEY,
        owner: env.PRIVATE_OWNER_ID, ownerEmail: env.PRIVATE_OWNER_EMAIL.toLowerCase(), key: Buffer.from(env.PRIVATE_ENCRYPTION_KEY, "hex"), origin };
}
function seal(value, purpose) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", config().key, iv);
    cipher.setAAD(Buffer.from(purpose));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}
function unseal(value, purpose) {
    try {
        if (typeof value !== "string" || value.length > 12000 || !/^[\w-]+$/.test(value)) throw new Error();
        const bytes = Buffer.from(value, "base64url");
        const decipher = crypto.createDecipheriv("aes-256-gcm", config().key, bytes.subarray(0, 12));
        decipher.setAAD(Buffer.from(purpose));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
    } catch { throw new PrivateError(401, "SESSION_EXPIRED"); }
}
function protect(req, res) {
    // 오류 응답에도 캐시 금지를 적용한다. CORS 허용만으로는 계정 보호가 되지 않는다.
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("CDN-Cache-Control", "no-store");
    res.setHeader("Vercel-CDN-Cache-Control", "no-store");
    res.setHeader("Vary", "Cookie, Origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const cfg = config();
    if (req.headers["x-private-request"] !== "1" ||
        (req.headers.origin && req.headers.origin !== cfg.origin) ||
        (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(req.headers["sec-fetch-site"]))) {
        throw new PrivateError(403, "ORIGIN_DENIED");
    }
    if (req.method !== "GET" && req.headers.origin !== cfg.origin) throw new PrivateError(403, "ORIGIN_DENIED");
    return cfg;
}
function body(req) {
    if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) throw new PrivateError(415, "JSON_REQUIRED");
    const raw = req.body;
    try {
        if (Buffer.byteLength(typeof raw === "string" ? raw : JSON.stringify(raw || {})) > 4096) throw new Error();
        const result = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
        return result;
    } catch { throw new PrivateError(400, "INVALID_INPUT"); }
}
async function supabase(path, token, options = {}) {
    const cfg = config();
    let response;
    try {
        response = await fetch(cfg.url + path, { ...options, redirect: "error", signal: AbortSignal.timeout(10000),
            headers: { apikey: cfg.anon, Authorization: "Bearer " + (token || cfg.anon),
                "Content-Type": "application/json", ...options.headers } });
    } catch { throw new PrivateError(503, "AUTH_UNAVAILABLE"); }
    if (!response.ok) {
        if (response.status === 429) throw new PrivateError(429, "RATE_LIMITED");
        if (path.startsWith("/auth/v1/token")) throw new PrivateError(401, "LOGIN_FAILED");
        if ([401, 403].includes(response.status)) throw new PrivateError(401, "SESSION_EXPIRED");
        throw new PrivateError(503, "AUTH_UNAVAILABLE");
    }
    const text = await response.text();
    try { return text ? JSON.parse(text) : null; } catch { throw new PrivateError(503, "AUTH_UNAVAILABLE"); }
}
async function rateLimit(token) {
    // DB에서 원자적으로 제한하므로 여러 Vercel 인스턴스로 나뉘어도 제한이 유지된다.
    const name = token ? "upbit_private_rate_limit" : "upbit_private_login_limit";
    const allowed = await supabase("/rest/v1/rpc/" + name, token, { method: "POST", body: "{}" });
    if (allowed !== true) throw new PrivateError(429, "RATE_LIMITED");
}
async function verifyToken(token) {
    const user = await supabase("/auth/v1/user", token);
    // 다른 서비스의 기존 사용자를 소유자로 오인하지 않도록 확인된 이메일도 대조한다.
    const cfg = config();
    if (!user || user.id !== cfg.owner || typeof user.email !== "string" ||
        user.email.toLowerCase() !== cfg.ownerEmail || !user.email_confirmed_at) throw new PrivateError(403, "OWNER_ONLY");
    // JWT가 아직 만료되지 않았어도 로그아웃으로 삭제된 세션은 거부한다.
    const live = await supabase("/rest/v1/rpc/upbit_private_session_active", token, { method: "POST", body: "{}" });
    if (live !== true) throw new PrivateError(401, "SESSION_EXPIRED");
    return user;
}
async function requireOwner(req) {
    const cookies = (req.headers.cookie || "").split(";").map(x => x.trim()).filter(x => x.startsWith(COOKIE + "="));
    if (cookies.length !== 1) throw new PrivateError(401, "LOGIN_REQUIRED");
    const session = unseal(cookies[0].slice(COOKIE.length + 1), "session:v1");
    if (!session.token || !Number.isFinite(session.expires) || session.expires <= Date.now()) throw new PrivateError(401, "SESSION_EXPIRED");
    const user = await verifyToken(session.token);
    return { token: session.token, user };
}
function setSession(res, token, seconds) {
    const ttl = Math.max(1, Math.min(3600, Number(seconds) || 3600));
    const value = seal({ token, expires: Date.now() + ttl * 1000 }, "session:v1");
    if (value.length > 3800) throw new PrivateError(503, "AUTH_UNAVAILABLE");
    res.setHeader("Set-Cookie", `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttl}`);
}
function clearSession(res) {
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}
function fail(res, error) {
    const known = error instanceof PrivateError;
    if (known && error.status === 429) res.setHeader("Retry-After", "60");
    // 공급업체 원문, 토큰, 서명, 개인 잔고는 로그와 오류 본문에 기록하지 않는다.
    return res.status(known ? error.status : 500).json({ error: known ? error.code : "REQUEST_FAILED" });
}
module.exports = { PrivateError, config, seal, unseal, protect, body, supabase, rateLimit, verifyToken,
    requireOwner, setSession, clearSession, fail };
