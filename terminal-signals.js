/* 바이낸스 실시간 매매 신호 피드.
   2026-11-11 교체: 예전에는 1분봉마다 StrategyBacktest.analyzeSignal을 돌렸는데, 백테스트(12종목 × 3주)에서
   종목당 하루 374건이 뜨고 수수료를 빼면 거래당 −0.99R(무작위 진입 −1.04R)이라 쓸 수 없었다.
   지금은 차트 타점·AI 전략과 같은 검증 규칙만 쓴다: 추세 합의(custom.js 1위)가 새로 충족된 확정봉에서
   방향 점수(analysis-engine.js)가 같은 쪽일 때. 4시간봉 +0.47R, 1시간봉 +0.13R(수수료 0.04%, 학습에 쓰지 않은 구간).
   1시간봉 스트림 하나만 듣고, 4시간 경계에서만 4시간봉을 다시 받는다. 클릭하면 그 코인으로 전환. */
(function () {
    "use strict";
    if (!window.Custom || !window.Engine || !window.CoinAnalysis) return;
    const $ = id => document.getElementById(id);
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const DEFAULT = ["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "LINK", "AVAX", "SUI", "TRX", "ONDO", "ATOM"];
    const MAX_SYMS = 20, MAX_ITEMS = 50;
    // look = 처음 열었을 때 되짚어 보여 줄 기간
    const TF = { "4h": { sec: 14400, name: "4시간봉", lab: "검증 +0.47R", look: 14 * 86400 }, "1h": { sec: 3600, name: "1시간봉", lab: "검증 +0.13R · 약함", look: 2 * 86400 } };

    const bars = new Map();   // "BTCUSDT|4h" -> 확정봉 배열
    const seen = new Set();   // "BTCUSDT|4h|봉시각" — 같은 신호를 두 번 올리지 않는다
    let ws = null, watching = [], retry = 0;

    function watchList() {
        let fav = [];
        try { fav = JSON.parse(localStorage.getItem("krta-fav") || "[]") || []; } catch {}
        const cur = $("symbol") && $("symbol").value;
        const bases = [cur, ...fav, ...DEFAULT].filter(s => typeof s === "string" && s)
            .map(s => s.replace(/[_/-]?USDT$/i, "").toUpperCase());
        return [...new Set(bases)].slice(0, MAX_SYMS).map(b => b + "USDT");
    }

    async function seed(sym, tf) {
        try {
            const r = await fetch("https://fapi.binance.com/fapi/v1/klines?symbol=" + sym + "&interval=" + tf + "&limit=500");
            if (!r.ok) return;
            const now = Date.now();
            bars.set(sym + "|" + tf, (await r.json()).filter(k => Number(k[6]) <= now).map(k => ({
                time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
            })));
        } catch {}
    }

    // from번째 봉부터 진입 신호를 찾는다. 추세 합의가 새로 충족된 봉은 드물어 방향 점수 계산도 그때만 한다.
    function entries(sym, tf, from) {
        const rows = bars.get(sym + "|" + tf);
        if (!rows || rows.length < 260) return [];
        const c1 = Custom.LIST[0].build(rows), out = [];
        let adx = null;
        for (let i = Math.max(210, from); i < rows.length; i++) {
            const dir = c1.long[i] ? 1 : c1.short[i] ? -1 : 0;
            if (!dir) continue;
            const key = sym + "|" + tf + "|" + rows[i].time;
            if (seen.has(key)) continue;
            seen.add(key);
            const g = CoinAnalysis.compositeSignal(rows.slice(0, i + 1));
            if (!g.ready || dir * g.score < 0) continue;
            adx = adx || Engine.adx(rows, 14).adx;
            out.push({ sym, tf, dir, score: g.score, adx: adx[i], price: rows[i].close, at: (rows[i].time + TF[tf].sec) * 1000 });
        }
        return out;
    }

    function push(e) {
        const list = $("sigFeed");
        if (!list) return;
        list.querySelector(".sig-empty")?.remove();
        const long = e.dir === 1, d = new Date(e.at), p2 = n => String(n).padStart(2, "0");
        const t = p2(d.getMonth() + 1) + "." + p2(d.getDate()) + " " + p2(d.getHours()) + ":" + p2(d.getMinutes());
        const el = document.createElement("button");
        el.type = "button";
        el.className = "sig-item " + (long ? "sig-long" : "sig-short");
        el.title = e.sym.replace("USDT", "/USDT") + " 차트로 이동 · 손절 2.5×ATR, 추세 합의가 반대로 돌면 청산";
        el.innerHTML =
            '<span class="sig-meta"><b>' + esc(e.sym.replace("USDT", "")) + '</b><span class="mono">' + t + "</span>"
            + '<span class="mono sig-px">' + e.price.toLocaleString("en-US", { maximumSignificantDigits: 6 }) + "</span></span>"
            + '<span class="sig-body"><span class="sig-badge">' + (long ? "롱 진입" : "숏 진입") + "</span>"
            + TF[e.tf].name + " · 추세 합의 5/5 · ADX " + (Number.isFinite(e.adx) ? e.adx.toFixed(0) : "—")
            + " · 방향 점수 " + (e.score >= 0 ? "+" : "") + e.score.toFixed(2)
            + '<span class="sig-rsi mono">' + TF[e.tf].lab + "</span></span>";
        el.addEventListener("click", () => {
            const sel = $("symbol"), v = e.sym.replace("USDT", "_USDT");
            if (!sel) return;
            if (![...sel.options].some(o => o.value === v)) sel.add(new Option(v.replace("_", "/"), v));
            sel.value = v;
            sel.dispatchEvent(new Event("change"));
            window.scrollTo({ top: 0, behavior: "smooth" });
        });
        list.prepend(el);
        while (list.children.length > MAX_ITEMS) list.lastChild.remove();
        const n = $("sigCount");
        if (n) n.textContent = String(list.querySelectorAll(".sig-item").length);
    }

    async function onKline(k, sym) {
        if (!k.x) return;  // 확정봉만 — 봉 도중 조건이 사라지는 재도색 방지
        const arr = bars.get(sym + "|1h") || [];
        const bar = { time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v };
        if (arr.length && arr[arr.length - 1].time === bar.time) arr[arr.length - 1] = bar; else arr.push(bar);
        if (arr.length > 500) arr.splice(0, arr.length - 500);
        bars.set(sym + "|1h", arr);
        entries(sym, "1h", arr.length - 1).forEach(push);
        if ((bar.time + 3600) % 14400 === 0) {   // 4시간봉도 방금 마감
            await seed(sym, "4h");
            const a4 = bars.get(sym + "|4h") || [];
            entries(sym, "4h", a4.length - 1).forEach(push);
        }
    }

    function setState(txt, on) {
        const s = $("sigState");
        if (s) { s.textContent = txt; s.classList.toggle("on", !!on); }
    }

    async function connect() {
        const next = watchList();
        if (ws && next.join() === watching.join()) return;
        watching = next;
        if (ws) { ws.onclose = null; ws.close(); }
        const w = $("sigWatch");
        if (w) w.textContent = watching.length + "종목";
        if (w) w.title = watching.map(s => s.replace("USDT", "")).join(", ");
        setState("준비 중", false);
        const fresh = watching.filter(s => !bars.has(s + "|4h"));
        await Promise.all(fresh.flatMap(s => [seed(s, "4h"), seed(s, "1h")]));
        // 새로 감시하게 된 종목의 최근 신호를 시간순으로 채운다(피드가 비어 보이지 않게)
        const now = Date.now() / 1000, past = [];
        for (const s of fresh) for (const tf of ["4h", "1h"]) {
            const rows = bars.get(s + "|" + tf) || [], from = rows.findIndex(r => r.time >= now - TF[tf].look);
            if (from >= 0) past.push(...entries(s, tf, from));
        }
        past.sort((a, b) => a.at - b.at).forEach(push);
        // kline은 /market 경로로만 온다(/stream은 depth만 오고 kline은 조용히 빠짐).
        ws = new WebSocket("wss://fstream.binance.com/market/stream?streams=" + watching.map(s => s.toLowerCase() + "@kline_1h").join("/"));
        ws.onopen = () => { retry = 0; setState("감시 중", true); };
        ws.onmessage = e => { try { const m = JSON.parse(e.data); if (m.data && m.data.k && m.data.k.x) onKline(m.data.k, m.data.s); } catch {} };
        ws.onclose = () => { setState("재연결 대기", false); ws = null; setTimeout(connect, Math.min(30000, 2000 * 2 ** retry++)); };
    }

    document.addEventListener("DOMContentLoaded", () => {
        $("sigClear")?.addEventListener("click", () => {
            $("sigFeed").innerHTML = '<div class="sig-empty dim">다음 확정봉부터 신호가 쌓입니다</div>';
            $("sigCount").textContent = "0";
        });
        // terminal.js가 심볼 목록을 채운 뒤 시작하고, 즐겨찾기·선택 코인이 바뀌면 1분마다 감시 목록을 맞춘다.
        setTimeout(connect, 1500);
        setInterval(connect, 60000);
    });
})();
