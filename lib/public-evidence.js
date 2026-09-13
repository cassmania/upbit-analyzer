"use strict";
const venues = {
    binance: { name: "바이낸스", base: "https://data-api.binance.vision/api/v3/trades", quote: "USDT" },
    mexc: { name: "MEXC", base: "https://api.mexc.com/api/v3/trades", quote: "USDT" },
    upbit: { name: "업비트", base: "https://api.upbit.com/v1/trades/ticks", quote: "KRW" },
    bithumb: { name: "빗썸", base: "https://api.bithumb.com/v1/trades/ticks", quote: "KRW" }
};
function tradeUrl(exchange, market) {
    const v = Object.hasOwn(venues, exchange) ? venues[exchange] : null;
    if (!v || typeof market !== "string" || !(v.quote === "KRW" ? /^KRW-[A-Z0-9]{1,25}$/ : /^[A-Z0-9]{1,25}USDT$/).test(market)) throw Error("INVALID_MARKET");
    return v.base + (v.quote === "KRW" ? "?count=200&market=" : "?limit=200&symbol=") + encodeURIComponent(market);
}
function summarizeTrades(rows, exchange, market, now = Date.now()) {
    tradeUrl(exchange, market);
    if (!Array.isArray(rows) || !rows.length || rows.length > 200) throw Error("NO_TRADES");
    const seen = new Set(), trades = [];
    for (const row of rows) {
        const krw = venues[exchange].quote === "KRW";
        const id = krw ? row.sequential_id : row.id;
        // 순번이 없는 MEXC 응답은 같은 시각·수량의 서로 다른 체결을 임의로 합치지 않는다.
        if (id !== undefined && id !== null) { if (seen.has(String(id))) continue; seen.add(String(id)); }
        const qty = Number(krw ? row.trade_volume : row.qty), price = Number(krw ? row.trade_price : row.price);
        const time = Number(krw ? row.timestamp : row.time);
        const buy = krw ? row.ask_bid === "BID" : row.isBuyerMaker === false;
        if ((krw ? !["BID", "ASK"].includes(row.ask_bid) : typeof row.isBuyerMaker !== "boolean") ||
            !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0 || !Number.isFinite(time) || time <= 0 || time > now + 60000) throw Error("INVALID_RESPONSE");
        trades.push({ qty, price, time, buy });
    }
    trades.sort((a,b) => a.time-b.time);
    const buy = trades.filter(t=>t.buy).reduce((a,t)=>a+t.qty,0), sell = trades.filter(t=>!t.buy).reduce((a,t)=>a+t.qty,0);
    const delta = trades.reduce((a,t)=>a+(t.buy?1:-1)*t.qty*t.price,0);
    if (![buy,sell,delta].every(Number.isFinite)) throw Error("INVALID_RESPONSE");
    return { status: "ok", source: venues[exchange].name + " 공식 현물 체결 API", exchange, market,
        unit: venues[exchange].quote === "KRW" ? market.slice(4) : market.slice(0,-4), quote: venues[exchange].quote,
        count: trades.length, buy, sell, cvd: buy-sell, quoteDelta: delta,
        start: trades[0].time, end: trades[trades.length-1].time, fetchedAt: now,
        stale: now-trades[trades.length-1].time > 120000, hasTradeIds: exchange !== "mexc" };
}
function parseNews(xml, now = Date.now()) {
    const field = (s,tag) => { const m = s.match(new RegExp('<'+tag+'(?:\\s[^>]*)?>([\\s\\S]*?)</'+tag+'>','i')); return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').trim() : ''; };
    const decode = s => s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&apos;|&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    const rows = [], seen = new Set();
    for (const match of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
        const title = decode(field(match[1],'title')).replace(/<[^>]*>/g,'').slice(0,240);
        const url = decode(field(match[1],'link')), publishedAt = Date.parse(field(match[1],'pubDate'));
        let u; try { u=new URL(url); } catch { continue; }
        if (u.protocol !== 'https:' || !['coindesk.com','www.coindesk.com'].includes(u.hostname) || u.username || u.password || !title || !Number.isFinite(publishedAt) || publishedAt > now+60000 || seen.has(url)) continue;
        seen.add(url); rows.push({ title, url, publishedAt });
    }
    rows.sort((a,b)=>b.publishedAt-a.publishedAt);
    if(!rows.length) throw Error('NO_NEWS');
    return { status:'ok', source:'CoinDesk RSS', scope:'암호화폐 시장 전체 뉴스 · 선택 코인 전용 뉴스가 아님', fetchedAt:now, stale:now-rows[0].publishedAt>48*3600000, rows:rows.slice(0,5) };
}
module.exports = { tradeUrl, summarizeTrades, parseNews };
