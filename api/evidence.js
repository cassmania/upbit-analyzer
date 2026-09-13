"use strict";
const E = require('../lib/public-evidence');
module.exports = async (req,res) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    if(req.method !== 'GET') return res.status(405).json({error:'METHOD_NOT_ALLOWED'});
    const {kind,exchange,market}=req.query || {};
    let url;
    try { url=kind==='cvd'?E.tradeUrl(exchange,market):kind==='news'?'https://www.coindesk.com/arc/outboundfeeds/rss':null; }
    catch { return res.status(400).json({error:'INVALID_MARKET'}); }
    if(!url) return res.status(400).json({error:'INVALID_KIND'});
    try {
        const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(8000),headers:{Accept:kind==='news'?'application/rss+xml':'application/json'}});
        if(!r.ok) throw Error(r.status===429?'RATE_LIMITED':'SOURCE_UNAVAILABLE');
        const raw=await r.text(); if(raw.length>1500000) throw Error('INVALID_RESPONSE');
        // 업비트·빗썸의 큰 체결 순번을 문자열로 보존한다.
        const data=kind==='cvd'?E.summarizeTrades(JSON.parse(raw.replace(/("sequential_id"\s*:\s*)(\d+)/g,'$1"$2"')),exchange,market):E.parseNews(raw);
        res.setHeader('Cache-Control',kind==='news'?'public, s-maxage=300, max-age=0':'public, s-maxage=10, max-age=0');
        return res.status(200).json(data);
    } catch(e) {
        res.setHeader('Cache-Control','no-store');
        return res.status(502).json({status:'unavailable',error:['RATE_LIMITED','NO_TRADES','NO_NEWS','INVALID_RESPONSE'].includes(e.message)?e.message:'SOURCE_UNAVAILABLE',fetchedAt:Date.now()});
    }
};
