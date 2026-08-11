/**
 * MEXC API 중계 (Vercel 서버리스)
 *
 * MEXC는 Access-Control-Allow-Origin을 주지 않는다(실측 2026-08-11).
 * 바이낸스는 열어두는데 MEXC는 막혀 있어, 업비트와 같은 이유로 서버를 한 번 거친다.
 *
 * 호출: /api/mexc?path=klines&symbol=BTCUSDT&interval=60m&limit=200
 *
 * 주의: MEXC 봉 표기는 바이낸스와 다르다. 1h가 아니라 60m, 1w가 아니라 1W다.
 *      변환은 클라이언트(app.js의 EXCHANGES.mexc.iv)가 맡는다.
 */

// 중계를 허용할 경로. 화이트리스트로 두는 이유는 이 함수가
// 임의 URL을 대신 때려주는 오픈 프록시가 되면 안 되기 때문이다.
const ALLOW = new Set([
    "exchangeInfo",
    "ticker/24hr",
    "ticker/price",
    "klines"
]);

// MEXC에 넘길 쿼리 파라미터만 통과시킨다.
const PARAMS = ["symbol", "symbols", "interval", "limit", "startTime", "endTime"];

module.exports = async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "GET") return res.status(405).json({ error: "GET만 허용" });

    const q = req.query || {};
    const path = String(q.path || "");

    if (!ALLOW.has(path)) {
        return res.status(400).json({
            error: "허용되지 않은 path",
            allowed: [...ALLOW]
        });
    }

    const sp = new URLSearchParams();
    for (const k of PARAMS) {
        if (q[k] !== undefined && q[k] !== "") sp.set(k, String(q[k]));
    }

    const url = "https://api.mexc.com/api/v3/" + path + (sp.toString() ? "?" + sp : "");

    try {
        const r = await fetch(url, { headers: { Accept: "application/json" } });
        const text = await r.text();

        if (!r.ok) {
            // MEXC 에러 본문을 그대로 넘겨야 원인 파악이 된다
            // (봉 표기가 틀리면 {"msg":"Invalid interval.","code":-1121}을 준다)
            return res.status(r.status).send(text);
        }

        // exchangeInfo는 1700개 넘는 심볼 목록이라 자주 바뀌지 않는다. 길게 캐시한다.
        const 캐시 = path === "exchangeInfo"
            ? "public, s-maxage=600, stale-while-revalidate=3600"
            : "public, s-maxage=5, stale-while-revalidate=25";
        res.setHeader("Cache-Control", 캐시);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return res.status(200).send(text);
    } catch (e) {
        return res.status(502).json({ error: "MEXC 호출 실패", detail: String(e && e.message || e) });
    }
};
