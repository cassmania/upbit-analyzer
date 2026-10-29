/* 바이낸스 실시간 매매 신호 피드 — crypto-futures-simulator의 신호 엔진을 그대로 쓴다.
   코인마다 바이낸스 선물 1분봉을 받아, 봉이 확정될 때마다 StrategyBacktest.analyzeSignal
   (시뮬레이터 화면·백테스트와 같은 순수 함수)로 판정하고 피드에 쌓는다. 클릭하면 그 코인으로 전환. */
(function () {
    "use strict";
    if (typeof StrategyBacktest === "undefined") return;
    const $ = id => document.getElementById(id);
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const DEFAULT = ["BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "LINK", "AVAX", "SUI", "TRX", "ONDO", "ATOM"];
    const MAX_SYMS = 20, MAX_ITEMS = 50;

    const bars = new Map();      // BTCUSDT -> 확정 1분봉 배열
    const lastSig = new Map();   // BTCUSDT -> 마지막으로 신호 낸 봉 시각 (봉당 한 번)
    let ws = null, watching = [], retry = 0;

    function watchList() {
        let fav = [];
        try { fav = JSON.parse(localStorage.getItem("krta-fav") || "[]") || []; } catch {}
        const cur = $("symbol") && $("symbol").value;
        const bases = [cur, ...fav, ...DEFAULT].filter(s => typeof s === "string" && s)
            .map(s => s.replace(/[_/-]?USDT$/i, "").toUpperCase());
        return [...new Set(bases)].slice(0, MAX_SYMS).map(b => b + "USDT");
    }

    async function seed(sym) {
        try {
            const r = await fetch("https://fapi.binance.com/fapi/v1/klines?symbol=" + sym + "&interval=1m&limit=200");
            if (!r.ok) return;
            const now = Date.now();
            bars.set(sym, (await r.json()).filter(k => Number(k[6]) <= now).map(k => ({
                time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
            })));
        } catch {}
    }

    function onKline(k, sym) {
        if (!k.x) return;  // 확정봉만 — 봉 도중 조건이 사라지는 재도색 방지
        const arr = bars.get(sym) || [];
        const bar = { time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v };
        if (arr.length && arr[arr.length - 1].time === bar.time) arr[arr.length - 1] = bar; else arr.push(bar);
        if (arr.length > 300) arr.splice(0, arr.length - 300);
        bars.set(sym, arr);
        if (lastSig.get(sym) === bar.time) return;
        const sig = StrategyBacktest.analyzeSignal(arr);
        if (!sig.direction || !sig.reasons.length) return;
        lastSig.set(sym, bar.time);
        const closes = arr.slice(-150).map(b => b.close);
        const rsi = StrategyBacktest.rsi(closes, 14)[closes.length - 1];
        push(sym, sig.direction, sig.reasons, rsi, bar.close);
    }

    function push(sym, dir, reasons, rsi, price) {
        const list = $("sigFeed");
        if (!list) return;
        list.querySelector(".sig-empty")?.remove();
        const long = dir === "LONG";
        const t = new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
        const el = document.createElement("button");
        el.type = "button";
        el.className = "sig-item " + (long ? "sig-long" : "sig-short");
        el.title = sym.replace("USDT", "/USDT") + " 차트로 이동";
        el.innerHTML =
            '<span class="sig-meta"><b>' + esc(sym.replace("USDT", "")) + '</b><span class="mono">' + t + "</span>"
            + '<span class="mono sig-px">' + price.toLocaleString("en-US", { maximumSignificantDigits: 6 }) + "</span></span>"
            + '<span class="sig-body"><span class="sig-badge">' + (long ? "롱 매수" : "숏 매도") + "</span>"
            + esc(reasons.join(" + ")) + '<span class="sig-rsi mono">RSI ' + (Number.isFinite(rsi) ? rsi.toFixed(1) : "—") + "</span></span>";
        el.addEventListener("click", () => {
            const sel = $("symbol"), v = sym.replace("USDT", "_USDT");
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
        await Promise.all(watching.filter(s => !bars.has(s)).map(seed));
        // kline은 /market 경로로만 온다(/stream은 depth만 오고 kline은 조용히 빠짐).
        ws = new WebSocket("wss://fstream.binance.com/market/stream?streams=" + watching.map(s => s.toLowerCase() + "@kline_1m").join("/"));
        ws.onopen = () => { retry = 0; setState("분석 중", true); };
        ws.onmessage = e => { try { const m = JSON.parse(e.data); if (m.data && m.data.k) onKline(m.data.k, m.data.s); } catch {} };
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
