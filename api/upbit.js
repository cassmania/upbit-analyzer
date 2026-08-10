/**
 * 업비트 API 중계 (Vercel 서버리스)
 *
 * 업비트는 전 엔드포인트에 Access-Control-Allow-Origin을 주지 않는다.
 * 브라우저에서 직접 호출하면 CORS로 죽으므로 서버를 한 번 거친다.
 *
 * 호출: /api/upbit?path=candles/minutes/60&market=KRW-BTC&count=200
 */

// 중계를 허용할 업비트 경로. 화이트리스트로 두는 이유는 이 함수가
// 임의 URL을 대신 때려주는 오픈 프록시가 되면 안 되기 때문이다.
const ALLOW = new Set([
    "market/all",
    "ticker",
    "candles/minutes/1",
    "candles/minutes/3",
    "candles/minutes/5",
    "candles/minutes/10",
    "candles/minutes/15",
    "candles/minutes/30",
    "candles/minutes/60",
    "candles/minutes/240",
    "candles/days",
    "candles/weeks",
    "candles/months"
]);

// 업비트에 넘길 쿼리 파라미터만 통과시킨다.
const PARAMS = ["market", "markets", "count", "to", "isDetails", "convertingPriceUnit"];

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

    const url = "https://api.upbit.com/v1/" + path + (sp.toString() ? "?" + sp : "");

    try {
        const r = await fetch(url, { headers: { Accept: "application/json" } });
        const text = await r.text();

        if (!r.ok) {
            // 업비트 에러 본문을 그대로 넘겨야 원인 파악이 된다
            return res.status(r.status).send(text);
        }

        // 캔들·시세는 초 단위로 낡는다. 짧게만 캐시해 업비트 호출 제한(초당 10회)을 던다.
        res.setHeader("Cache-Control", "public, s-maxage=5, stale-while-revalidate=25");
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return res.status(200).send(text);
    } catch (e) {
        return res.status(502).json({ error: "업비트 호출 실패", detail: String(e && e.message || e) });
    }
};
