"use strict";
const test=require('node:test'), assert=require('node:assert/strict');
const E=require('../lib/public-evidence');
test('화면 거래쌍을 공식 API 형식으로 변환하고 뉴스 실패와 CVD 성공을 분리한다',async()=>{
    const vm=require('node:vm'), fs=require('node:fs'), calls=[];
    const context={window:{},URLSearchParams,AbortSignal,fetch:async url=>{calls.push(url);return {ok:!url.includes('kind=news'),json:async()=>({status:'ok'})};}};
    vm.runInNewContext(fs.readFileSync(require.resolve('../public-evidence.js'),'utf8'),context);
    const result=await context.window.PublicEvidence.fetch('mexc','USDT-BTC');
    assert.ok(calls[0].includes('market=BTCUSDT'));assert.equal(result.cvd.status,'ok');assert.equal(result.news.status,'unavailable');
});
test('매수 주도는 양수, 매도 주도는 음수이며 동일 체결 ID는 한 번만 계산한다',()=>{
    const rows=[{id:1,qty:'3',price:'10',time:1000,isBuyerMaker:false},{id:2,qty:'1',price:'11',time:2000,isBuyerMaker:true}];
    const r=E.summarizeTrades([...rows,rows[0]],'binance','BTCUSDT',3000);
    assert.equal(r.cvd,2);assert.equal(r.quoteDelta,19);assert.equal(r.count,2);assert.equal(r.start,1000);
});
test('ID 없는 동일 형태의 MEXC 체결을 임의 삭제하거나 이전 구간과 누적하지 않는다',()=>{
    const row={id:null,qty:2,price:10,time:1000,isBuyerMaker:false};
    assert.equal(E.summarizeTrades([row,row],'mexc','BTCUSDT',3000).cvd,4);
    assert.equal(E.summarizeTrades([row],'mexc','BTCUSDT',3000).cvd,2);
});
test('큰 순번·역순 체결과 오래된 체결을 정확히 처리한다',()=>{
    const row={trade_volume:1,trade_price:10,timestamp:1000,ask_bid:'ASK'};
    const r=E.summarizeTrades([{...row,sequential_id:'17892941852530002'},{...row,sequential_id:'17892941852530001'}],'upbit','KRW-BTC',200000);
    assert.equal(r.count,2);assert.equal(r.cvd,-2);assert.equal(r.stale,true);
});
test('방향 누락, 비정상 수치, 임의 거래소·URL을 거부한다',()=>{
    assert.throws(()=>E.summarizeTrades([{qty:1,price:2,time:1}],'mexc','BTCUSDT',3000));
    assert.throws(()=>E.tradeUrl('__proto__','BTCUSDT'));
    assert.throws(()=>E.tradeUrl('binance','https://example.com'));
});
test('뉴스는 허용 출처와 유효 시각만 남기며 HTML을 실행하지 않는다',()=>{
    const item=(url,title)=>`<item><title><![CDATA[${title}]]></title><link>${url}</link><pubDate>Sun, 13 Sep 2026 00:00:00 GMT</pubDate></item>`;
    const r=E.parseNews(item('https://www.coindesk.com/news/test','<b>Test</b> &amp; news')+item('javascript:alert(1)','bad'),Date.parse('2026-09-13T01:00:00Z'));
    assert.equal(r.rows.length,1);assert.equal(r.rows[0].title,'Test & news');
});
