/* 체결 근거와 시장 뉴스를 화면·복사 브리핑에서 같은 값으로 표시한다. */
(function(root){
    'use strict';
    const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const num=n=>Number(n).toLocaleString('ko-KR',{maximumFractionDigits:8});
    const time=t=>new Date(t).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false})+' KST';
    const unavailable='조회 실패 또는 미지원 · 현재값 확인 불가';
    async function get(params){try{const r=await fetch('/api/evidence?'+new URLSearchParams(params),{signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error();return await r.json();}catch{return {status:'unavailable'};}}
    function cvdText(d){if(!d||d.status!=='ok')return unavailable;return d.source+' · '+d.market+'\n구간 CVD '+num(d.cvd)+' '+d.unit+' · 매수 '+num(d.buy)+' / 매도 '+num(d.sell)+'\n순체결대금 '+num(d.quoteDelta)+' '+d.quote+'\n'+time(d.start)+' ~ '+time(d.end)+' · '+d.count+'건\n조회 '+time(d.fetchedAt)+(d.stale?' · 최근 체결 2분 이상 경과':'')+'\n최근 최대 200건의 이동 구간 합계. 매 갱신마다 구간이 바뀌며 장기 누적 CVD·선물 CVD가 아닙니다.'+(d.hasTradeIds?'':' 체결 ID 미제공으로 구간 간 연속성 검증 불가.');}
    function newsText(d){if(!d||d.status!=='ok')return unavailable;return d.source+' · '+d.scope+'\n조회 '+time(d.fetchedAt)+(d.stale?' · 최신 기사 48시간 이상 경과':'')+'\n'+d.rows.map(r=>time(r.publishedAt)+' · '+r.title+'\n'+r.url).join('\n');}
    function newsHtml(d){if(!d||d.status!=='ok')return unavailable;return '<p>'+esc(d.source+' · '+d.scope)+'</p><p class="dim">'+esc('조회 '+time(d.fetchedAt)+(d.stale?' · 최신 기사 48시간 이상 경과':''))+'</p>'+d.rows.map(r=>'<p><a target="_blank" rel="noopener noreferrer" href="'+esc(r.url)+'">'+esc(r.title)+'</a><br><small>'+esc(time(r.publishedAt))+'</small></p>').join('');}
    root.PublicEvidence={fetch:async(exchange,market)=>{
        // 화면은 USDT-BTC 형식을 쓰지만 바이낸스·MEXC 체결 API는 BTCUSDT를 받는다.
        const symbol=['binance','mexc'].includes(exchange)&&market.startsWith('USDT-')?market.slice(5)+'USDT':market;
        const [cvd,news]=await Promise.all([get({kind:'cvd',exchange,market:symbol}),get({kind:'news'})]);return {cvd,news};
    },cvdText,newsText,newsHtml,cvdHtml:d=>esc(cvdText(d)).replace(/\n/g,'<br>')};
})(window);
