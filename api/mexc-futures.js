/**
 * MEXC 선물 공개 API 중계 (Vercel 서버리스)
 * contract.mexc.com은 CORS를 주지 않으므로 브라우저 직접 호출이 막힌다.
 * 호출: /api/mexc-futures?path=kline&symbol=BTC_USDT&interval=Min60
 */
const BASE = "https://contract.mexc.com/api/v1/contract";
const ALLOW = new Set(["ticker", "depth", "kline", "funding_rate", "deals", "detail", "fair_price", "index_price"]);
const INTERVALS = new Set(["Min1", "Min5", "Min15", "Min30", "Min60", "Hour4", "Hour8", "Day1", "Week1", "Month1"]);
const SYMBOL = /^[A-Z0-9]{1,20}_[A-Z0-9]{2,10}$/;
const PARAMS = ["symbol", "interval", "limit", "start", "end", "startTime", "endTime", "page_num", "page_size"];

module.exports = async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") return res.status(405).json({ error: "GET만 허용" });
    const q = req.query || {};
    const path = String(q.path || "");
    if (!ALLOW.has(path)) return res.status(400).json({ error: "허용되지 않은 path", allowed: [...ALLOW] });
    // 심볼이 필요한 경로는 형식을 강제한다. detail·ticker(전체)는 심볼 없이 호출한다
    const needsSymbol = !["ticker", "detail"].includes(path);
    const symbol = String(q.symbol || "").toUpperCase();
    if (needsSymbol && !SYMBOL.test(symbol)) return res.status(400).json({ error: "심볼 형식 오류" });
    if (q.interval !== undefined && q.interval !== "" && !INTERVALS.has(String(q.interval))) {
        return res.status(400).json({ error: "인터벌 오류" });
    }
    const sp = new URLSearchParams();
    for (const k of PARAMS) if (q[k] !== undefined && q[k] !== "") sp.set(k, String(q[k]).slice(0, 64));
    // depth limit은 5~200으로 고정한다
    if (path === "depth" && !sp.has("limit")) sp.set("limit", "20");
    const tail = needsSymbol ? "/" + encodeURIComponent(symbol) : "";
    const url = BASE + "/" + path + tail + (sp.toString() ? "?" + sp : "");
    try {
        const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
        const text = await r.text();
        if (!r.ok) return res.status(r.status).send(text);
        res.setHeader("Cache-Control", path === "detail"
            ? "public, s-maxage=600, stale-while-revalidate=3600"
            : "public, s-maxage=5, stale-while-revalidate=25");
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return res.status(200).send(text);
    } catch (e) {
        return res.status(502).json({ error: "MEXC 선물 호출 실패" });
    }
};
