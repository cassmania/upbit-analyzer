/**
 * CoinGecko 공개 API 중계 (Vercel 서버리스)
 *
 * 브라우저에서 시장 전체 시가총액과 USDT 시가총액을 읽을 때 사용한다.
 * 임의의 URL을 전달하는 오픈 프록시가 되지 않도록 허용 경로와 파라미터를
 * 각각 고정한다.
 *
 * 호출 예:
 * /api/coingecko?path=global
 * /api/coingecko?path=simple/price&ids=tether&vs_currencies=usd&include_market_cap=true
 */

const ALLOW = new Set(["global", "simple/price"]);
const PARAMS = new Set([
    "ids",
    "vs_currencies",
    "include_market_cap",
    "include_24hr_change"
]);

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
            error: "허용되지 않은 CoinGecko path",
            allowed: [...ALLOW]
        });
    }

    const sp = new URLSearchParams();
    for (const key of PARAMS) {
        if (q[key] !== undefined && q[key] !== "") sp.set(key, String(q[key]));
    }

    // 현재 공개 API만 사용한다. 키가 필요한 유료 과거 시계열은 임의로 우회하지 않는다.
    const url = "https://api.coingecko.com/api/v3/" + path
        + (sp.toString() ? "?" + sp.toString() : "");

    try {
        const r = await fetch(url, { headers: { Accept: "application/json" } });
        const text = await r.text();

        if (!r.ok) return res.status(r.status).send(text);

        // 공개 시장 데이터는 최신값이므로 짧게만 캐시한다.
        res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return res.status(200).send(text);
    } catch (e) {
        return res.status(502).json({
            error: "CoinGecko 호출 실패",
            detail: String(e && e.message || e)
        });
    }
};
