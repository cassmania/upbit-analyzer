/* AI 선물 터미널 — MEXC 선물. 원칙: 기본 관망·모의, 실매매는 승인 후에만 서버 경유.
   키 원문은 브라우저에 보관하지 않고 입력 즉시 서버로 전송 후 필드를 비운다. */
(function () {
"use strict";
const $ = id => document.getElementById(id);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });
const S = { symbol: "BTC_USDT", tf: "Min60", contractSize: 0.0001, priceScale: 1, maxLev: 10,
    last: 0, chart: null, candles: null, series: null, lines: {}, prices: [], armed: false,
    tradeEnabled: false, autoPaper: false, autoLive: false, lastAuto: 0, paper: [], timer: [],
    bank: 1000000, pxMap: {}, scan: { on: false, list: [], idx: 0, results: {}, cool: {} },
    cfg: { notional: 50, ratioPct: 1, maxPos: 5, coolMin: 5 } };
function loadCfg() {
    try {
        const c = JSON.parse(localStorage.getItem("krta-cfg") || "{}");
        if (Number(c.notional) > 0) S.cfg.notional = Math.min(50000, Math.max(5, Number(c.notional)));
        if (Number(c.ratioPct) > 0) S.cfg.ratioPct = Math.min(10, Math.max(0.1, Number(c.ratioPct)));
        if (Number(c.maxPos) > 0) S.cfg.maxPos = Math.min(10, Math.max(1, Math.round(Number(c.maxPos))));
        if (Number(c.coolMin) > 0) S.cfg.coolMin = Math.min(60, Math.max(1, Math.round(Number(c.coolMin))));
    } catch { /* 기본값 유지 */ }
    $("cfgNotional").value = S.cfg.notional;
    $("cfgRatio").value = S.cfg.ratioPct;
    $("cfgMaxPos").value = S.cfg.maxPos;
    $("cfgCool").value = S.cfg.coolMin;
}
function saveCfg() {
    try { localStorage.setItem("krta-cfg", JSON.stringify(S.cfg)); } catch { /* 무시 */ }
}

async function pub(path, params) {
    const q = new URLSearchParams({ path, ...params });
    const r = await fetch("/api/mexc-futures?" + q, { cache: "no-store" });
    if (!r.ok) throw new Error("시세 오류 " + r.status);
    const j = await r.json();
    if (j.success !== true || Number(j.code) !== 0) throw new Error("시세 오류");
    return j.data;
}
async function priv(api, method, body) {
    const r = await fetch("/api/private/" + api, { method: method || "GET", credentials: "same-origin",
        cache: "no-store", headers: { "X-Private-Request": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ("오류 " + r.status));
    return j;
}
function log(msg, cls) {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    d.textContent = new Date().toLocaleTimeString("ko-KR", { hourCycle: "h23" }) + " " + msg;
    $("log").prepend(d);
    while ($("log").children.length > 80) $("log").lastChild.remove();
}
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "-" + Math.floor(Math.random() * 1e9));

// ---- 지표 (터미널 자체 타임프레임용 경량 규칙. 관망이 정상 출력이다) ----
const ema = (a, n) => { const k = 2 / (n + 1); let p = a[0]; return a.map((v, i) => p = i ? v * k + p * (1 - k) : v); };
const rsi = (a, n = 14) => {
    if (a.length <= n) return 50;
    let g = 0, l = 0;
    for (let i = 1; i <= n; i++) { const d = a[i] - a[i - 1]; g += Math.max(d, 0); l += Math.max(-d, 0); }
    g /= n; l /= n;
    for (let i = n + 1; i < a.length; i++) { const d = a[i] - a[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; }
    return l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
};
const atr = (c, n = 14) => {
    const tr = c.map((k, i) => { const p = i ? c[i - 1].close : k.close;
        return Math.max(k.high - k.low, Math.abs(k.high - p), Math.abs(k.low - p)); });
    let a = tr.slice(0, n).reduce((s, v) => s + v, 0) / n;
    for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
    return a;
};
function aiSignal(fast, slow) {
    // fast: 진입봉 캔들, slow: 방향봉 캔들
    if (!fast || fast.length < 60 || !slow || slow.length < 60) return { dir: "관망", reason: "봉 부족" };
    const sc = slow.map(k => k.close), fc = fast.map(k => k.close);
    const e20 = ema(sc, 20), e50 = ema(sc, 50), l = sc.length - 1;
    const up = e20[l] > e50[l];
    const r = rsi(fc, 14), a = atr(fast, 14), f = fast[fast.length - 1];
    const dist = Math.abs(f.close - e20[l]) / Math.max(a, 1e-9);
    if (dist > 3) return { dir: "관망", reason: "이격 과대 " + dist.toFixed(1) + "ATR" };
    if (up && r >= 50 && r <= 75 && f.close > e20[l]) {
        return { dir: "LONG", entry: f.close, sl: f.close - a * 1.5, tp: f.close + a * 3, reason: "4H 상승·RSI " + r.toFixed(0) };
    }
    if (!up && r <= 50 && r >= 25 && f.close < e20[l]) {
        return { dir: "SHORT", entry: f.close, sl: f.close + a * 1.5, tp: f.close - a * 3, reason: "4H 하락·RSI " + r.toFixed(0) };
    }
    return { dir: "관망", reason: "조건 미달 RSI " + r.toFixed(0) };
}

// ---- 차트 ----
function ensureChart() {
    if (S.chart) return;
    S.chart = LightweightCharts.createChart($("chart"), { layout: { background: { color: "#12161f" }, textColor: "#8b93a7" },
        grid: { vertLines: { color: "#1a2130" }, horzLines: { color: "#1a2130" } },
        rightPriceScale: { borderColor: "#222839" }, timeScale: { borderColor: "#222839", timeVisible: true } });
    S.series = S.chart.addCandlestickSeries({ upColor: "#0ecb81", downColor: "#f6465d", wickUpColor: "#0ecb81", wickDownColor: "#f6465d" });
    const mk = c => S.chart.addLineSeries({ color: c, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    S.lines = { ma5: mk("#e0b44a"), ma10: mk("#29b6f6"), ma30: mk("#9b59b6"), ma60: mk("#7f8c8d") };
    new ResizeObserver(() => S.chart.resize($("chart").clientWidth, $("chart").clientHeight)).observe($("chart"));
}
const sma = (a, n) => a.map((_, i) => i < n - 1 ? null : a.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n);
function resample12h(c) {
    const out = [];
    for (let i = 0; i < c.length; i += 12) {
        const g = c.slice(i, i + 12);
        if (!g.length) break;
        out.push({ time: g[0].time, open: g[0].open, high: Math.max(...g.map(k => k.high)),
            low: Math.min(...g.map(k => k.low)), close: g[g.length - 1].close, vol: g.reduce((s, k) => s + k.vol, 0) });
    }
    return out;
}
async function loadChart() {
    ensureChart();
    const iv = S.tf === "Hour12" ? "Min60" : S.tf;
    const d = await pub("kline", { symbol: S.symbol, interval: iv });
    let candles = d.time.map((t, i) => ({ time: t, open: d.open[i], high: d.high[i], low: d.low[i], close: d.close[i], vol: d.vol[i] || 0 }));
    if (S.tf === "Hour12") candles = resample12h(candles);
    candles = candles.slice(-300);
    S.candles = candles;
    S.series.setData(candles);
    const closes = candles.map(k => k.close);
    const mas = { ma5: sma(closes, 5), ma10: sma(closes, 10), ma30: sma(closes, 30), ma60: sma(closes, 60) };
    for (const k of Object.keys(mas)) S.lines[k].setData(candles.map((c, i) => ({ time: c.time, value: mas[k][i] })).filter(p => p.value !== null));
    const last = candles[candles.length - 1];
    $("legend").textContent = "O " + fmt.format(last.open) + " H " + fmt.format(last.high) + " L " + fmt.format(last.low) +
        " C " + fmt.format(last.close) + " · MA5 " + fmt.format(mas.ma5[mas.ma5.length - 1] || 0);
    await refreshAI();
}

// ---- 티커·오더북 ----
async function refreshTop() {
    const all = await pub("ticker", {});
    const t = all.find(x => x.symbol === S.symbol);
    if (!t) return;
    S.last = Number(t.lastPrice);
    S.pxMap[S.symbol] = S.last;
    $("tLast").textContent = fmt.format(S.last);
    const chg = Number(t.riseFallRate) * 100;
    $("tChg").textContent = (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%";
    $("tChg").className = "mono " + (chg >= 0 ? "up" : "down");
    $("tLast").className = "mono " + (chg >= 0 ? "up" : "down");
    $("tIndex").textContent = fmt.format(t.indexPrice);
    $("tFair").textContent = fmt.format(t.fairPrice);
    $("tFund").textContent = (Number(t.fundingRate) * 100).toFixed(4) + "%";
    $("tHigh").textContent = fmt.format(t.high24Price);
    $("tLow").textContent = fmt.format(t.lower24Price);
    $("tVol").textContent = Math.round(Number(t.volume24)).toLocaleString() + " 계약";
    $("tOi").textContent = Math.round(Number(t.holdVol)).toLocaleString() + " 계약";
    try {
        const f = await pub("funding_rate", { symbol: S.symbol });
        const ms = Number(f.nextSettleTime) - Date.now();
        $("tFundT").textContent = ms > 0 ? Math.floor(ms / 3600000) + "h " + Math.floor(ms % 3600000 / 60000) + "m" : "-";
    } catch { /* 펀딩 카운트다운 실패는 무시 */ }
    const p = $("oPrice");
    if (!p.value && S.last) p.placeholder = String(S.last);
    updateNotional();
}
async function refreshBook() {
    const d = await pub("depth", { symbol: S.symbol, limit: "20" });
    const row = (p, q, a) => "<div><span class='" + a + "'>" + fmt.format(p) + "</span><span>" + fmt.format(q) + "</span><span class='dim'>" + fmt.format(p * q * S.contractSize) + "</span></div>";
    $("asks").innerHTML = d.asks.slice().reverse().map(x => row(x[0], x[1], "a")).join("");
    $("bids").innerHTML = d.bids.map(x => row(x[0], x[1], "b")).join("");
    const a1 = d.asks.length ? d.asks[d.asks.length - 1][0] : 0, b1 = d.bids.length ? d.bids[0][0] : 0;
    $("mid").textContent = fmt.format((a1 + b1) / 2 || S.last);
    $("spread").textContent = "스프레드 " + fmt.format(a1 - b1);
    const bv = d.bids.reduce((s, x) => s + x[1], 0), av = d.asks.reduce((s, x) => s + x[1], 0);
    $("bidPct").style.width = (bv / Math.max(bv + av, 1e-9) * 100) + "%";
}
function updateNotional() {
    const v = Number($("oVol").value);
    $("oNotional").textContent = "명목가 " + (v > 0 && S.last ? fmt.format(S.last * v * S.contractSize) : "-") + " USDT";
}

// ---- AI (V4.1 파이프라인: TAEngine→LevelEngine→SignalEngine. 실패 시 내장 경량 규칙) ----
async function refreshAI() {
    try {
        if (!window.TerminalAI || !window.TAEngine || !window.LevelEngine || !window.SignalEngine) throw new Error("engine-missing");
        const [h1, h4, h1b, d1] = await Promise.all([
            pub("kline", { symbol: S.symbol, interval: "Min60" }),
            pub("kline", { symbol: S.symbol, interval: "Hour4" }),
            pub("kline", { symbol: S.symbol, interval: "Min60" }),
            pub("kline", { symbol: S.symbol, interval: "Day1" }),
        ]);
        let funding = null;
        try { funding = Number((await pub("funding_rate", { symbol: S.symbol })).fundingRate); } catch { /* 펀딩 실패는 null */ }
        const r = window.TerminalAI.runPipeline(
            { TA: window.TAEngine, LV: window.LevelEngine, SIG: window.SignalEngine },
            { "1h": h1, "4h": h4, "12h": h1b, "1d": d1 }, S.last, funding);
        S.ai = r;
        $("aiSig").textContent = r.dir;
        if (r.ok && r.entry) {
            const e = r.entry;
            $("aiDetail").textContent = r.dir + " 진입 " + fmt.format(e.entry) + " SL " + fmt.format(e.stop) +
                " TP1 " + fmt.format(e.target1) + " " + e.rr.toFixed(2) + "R · 합의 " + r.agree + "%";
            markSignal(r.dir);
        } else {
            $("aiDetail").textContent = "관망 · " + (r.blocked || r.reason || "");
            markSignal(null);
        }
        return r.dir === "LONG" || r.dir === "SHORT" ? { dir: r.dir, entry: r.entry } : { dir: "관망" };
    } catch (e) {
        return legacyAI();
    }
}
function markSignal(dir) {
    if (!S.series || !S.candles || !S.candles.length) return;
    if (!dir) { S.series.setMarkers([]); return; }
    S.series.setMarkers([{ time: S.candles[S.candles.length - 1].time,
        position: dir === "LONG" ? "belowBar" : "aboveBar",
        color: dir === "LONG" ? "#0ecb81" : "#f6465d",
        shape: dir === "LONG" ? "arrowUp" : "arrowDown", text: dir }]);
}
async function legacyAI() {
    try {
        const [h1, h4] = await Promise.all([
            pub("kline", { symbol: S.symbol, interval: "Min60" }),
            pub("kline", { symbol: S.symbol, interval: "Hour4" }),
        ]);
        const map = d => d.time.map((t, i) => ({ time: t, open: d.open[i], high: d.high[i], low: d.low[i], close: d.close[i], vol: d.vol[i] || 0 }));
        const sig = aiSignal(map(h1).slice(-200), map(h4).slice(-200));
        S.ai = null;
        $("aiSig").textContent = sig.dir;
        $("aiDetail").textContent = sig.reason + (sig.entry ? " · 진입 " + fmt.format(sig.entry) + " SL " + fmt.format(sig.sl) + " TP " + fmt.format(sig.tp) : "");
        markSignal(null);
        return sig;
    } catch { $("aiSig").textContent = "오류"; return { dir: "관망" }; }
}

// ---- 주문 ----
async function submitOrder(side, auto, opts) {
    const lev = Number($("lev").value), type = Number(document.querySelector("#otype .act").dataset.t);
    let vol = Number($("oVol").value);
    if (auto && !(vol > 0)) {
        // 단일 자동매매는 설정 명목가로 고정한다
        vol = Math.max(1, Math.floor(S.cfg.notional / (S.last * S.contractSize)));
    }
    if (!(vol > 0)) { $("oMsg").textContent = "수량을 입력하세요."; return; }
    const intent = { symbol: S.symbol, side, type, leverage: lev, vol,
        ...(type === 1 && $("oPrice").value ? { price: Number($("oPrice").value) } : {}),
        ...(opts && opts.sl ? { stopLossPrice: opts.sl } : {}),
        ...(opts && opts.tp ? { takeProfitPrice: opts.tp } : {}) };
    const live = S.armed && S.tradeEnabled && (auto ? S.autoLive : true);
    // 10X 초과는 모의 전용. 실주문은 서버 상한에서 거부된다
    if (live && lev > 10) { $("oMsg").textContent = "10X 초과 실주문 차단 — 레버리지를 낮추세요."; return; }
    if (!live && lev > 10) {
        const px = type === 1 && intent.price ? intent.price : S.last;
        if (paperFill(side, px, vol, lev, auto)) {
            $("oMsg").textContent = "모의 체결(고레버리지 로컬) 약 $" + fmt.format(Math.round(px * vol * S.contractSize));
            log((side === 1 ? "모의 LONG " : "모의 SHORT ") + vol + "계약 " + lev + "X @" + fmt.format(S.last));
        }
        return;
    }
    try {
        $("oMsg").textContent = "서버 검증 중…";
        const r = await priv("trade", "POST", { action: "submit", intent, live, idempotencyKey: uuid() });
        if (r.dryRun) {
            const ok = paperFill(side, type === 1 && intent.price ? intent.price : S.last, vol, lev, auto,
                { sl: intent.stopLossPrice || null, tp: intent.takeProfitPrice || null });
            if (ok) {
                $("oMsg").textContent = "모의 체결(서버 검증 통과) 약 $" + fmt.format(r.notional);
                log((side === 1 ? "모의 LONG " : "모의 SHORT ") + vol + "계약 @" + fmt.format(S.last));
            }
        } else {
            $("oMsg").textContent = "실주문 접수 " + r.orderId;
            log("실주문 " + r.orderId + " 약 $" + fmt.format(r.notional), "down");
        }
        refreshPrivate();
    } catch (e) { $("oMsg").textContent = "거부: " + e.message; log("주문 거부 " + e.message, "down"); }
}
function paperFill(side, price, vol, lev, auto, opts) {
    opts = opts || {};
    const cs = Number(opts.cs) || S.contractSize;
    const calc = window.TerminalAI ? window.TerminalAI.openCalc(price, vol, lev, cs) : null;
    if (!calc) { $("oMsg").textContent = "수량·가격 오류"; return false; }
    const need = calc.margin + calc.feeIn;
    if (need > S.bank) { $("oMsg").textContent = "모의 증거금 부족(필요 $" + fmt.format(Math.round(need)) + ")"; return false; }
    S.bank = Math.round((S.bank - need) * 100) / 100;
    S.paper.push({ symbol: opts.symbol || S.symbol, side, price, vol, lev, cs, margin: calc.margin, feeIn: calc.feeIn,
        liq: side === 1 ? calc.liqLong : calc.liqShort,
        sl: opts.sl || null, tp: opts.tp || null, at: Date.now(), auto: !!auto });
    savePaper();
    renderPaper();
    return true;
}
function savePaper() {
    try { localStorage.setItem("krta-paper", JSON.stringify(S.paper.slice(-50)));
        localStorage.setItem("krta-bank", JSON.stringify({ bank: S.bank })); } catch { /* 저장 실패 무시 */ }
}
function paperUnreal(p, px) {
    if (px === undefined) px = (p.symbol === S.symbol && S.last > 0) ? S.last : p.price;
    return (px - p.price) * p.vol * (p.cs || S.contractSize) * (p.side === 1 || p.side === 4 ? 1 : -1);
}
function paperLocked() {
    return S.paper.reduce((s, p) => s + p.margin, 0);
}
function paperEquity(pxMap) {
    return S.bank + S.paper.reduce((s, p) => s + paperUnreal(p, pxMap && pxMap[p.symbol] !== undefined ? pxMap[p.symbol] : undefined), 0) + paperLocked();
}
function renderBank() {
    const unreal = S.paper.reduce((s, p) => s + paperUnreal(p, S.pxMap[p.symbol]), 0);
    const eq = S.bank + unreal + paperLocked();
    const pnl = eq - 1000000;
    $("paperBank").textContent = "모의 지갑 $" + fmt.format(Math.round(S.bank)) + " · 미실현 " +
        (unreal >= 0 ? "+" : "") + fmt.format(Math.round(unreal)) + " · 평가 $" + fmt.format(Math.round(eq)) +
        " (" + (pnl >= 0 ? "+" : "") + fmt.format(Math.round(pnl)) + ")";
}
function settlePaper(idx, px, reason) {
    const p = S.paper[idx];
    if (!p || !window.TerminalAI) return;
    const r = window.TerminalAI.settleCalc(p, px);
    S.bank = Math.round((S.bank + r.credit) * 100) / 100;
    S.paper.splice(idx, 1);
    savePaper();
    renderPaper();
    log("모의 청산[" + reason + "] " + p.symbol + " " + (p.side === 1 ? "롱" : "숏") + " 손익 " +
        (r.pnl >= 0 ? "+" : "") + fmt.format(Math.round(r.pnl * 100) / 100) + " (수수료 " + fmt.format(Math.round((p.feeIn + r.feeOut) * 100) / 100) + ")");
}
function renderPaper() {
    // 전 종목 모의 포지션을 최신순으로 보여준다
    const tb = document.querySelector("#posT tbody");
    const rows = S.paper.slice(-10).reverse().map((p) => {
        const px = S.pxMap[p.symbol] !== undefined ? S.pxMap[p.symbol] : undefined;
        const pnl = paperUnreal(p, px);
        return "<tr><td>[모의] " + esc(p.symbol) + "</td><td>" + (p.side === 1 ? "롱" : "숏") + "</td><td>" + p.vol +
            "</td><td class='mono'>" + fmt.format(p.price) + "</td><td>" + p.lev + "X</td><td class='mono " +
            (pnl >= 0 ? "up" : "down") + "'>" + fmt.format(Math.round(pnl * 100) / 100) + "</td><td><span class='dim mono'>liq " +
            fmt.format(Math.round(p.liq * 100) / 100) + "</span> <button data-paper='" + S.paper.indexOf(p) + "'>청산</button></td></tr>";
    }).join("");
    tb.dataset.paper = rows;
    mergePosTable();
    renderBank();
}
function mergePosTable() {
    const tb = document.querySelector("#posT tbody");
    const real = [...tb.querySelectorAll("tr[data-real]")].map(tr => tr.outerHTML).join("");
    tb.innerHTML = (tb.dataset.paper || "") + real || "<tr><td colspan='7' class='dim'>포지션 없음</td></tr>";
}

// ---- 비공개 (잔고·포지션·미체결) ----
async function refreshPrivate() {
    try {
        const s = await priv("mexc", "GET");
        $("wState").textContent = "연결됨";
        const usdt = (s.sections.assets.rows || []).find(r => r.currency === "USDT");
        $("wallet").innerHTML = "USDT 가용 " + fmt.format(usdt ? usdt.available : 0) + " · 평가 " + fmt.format(usdt ? usdt.equity : 0);
        const tb = document.querySelector("#posT tbody");
        const pos = (s.sections.positions.rows || []).map(p =>
            "<tr data-real='1'><td>" + esc(p.symbol) + "</td><td>" + esc(p.direction) + "</td><td>" + esc(p.contracts) +
            "</td><td class='mono'>" + fmt.format(p.entryPrice) + "</td><td>" + esc(p.leverage) + "X</td><td class='mono " +
            ((p.unrealized || 0) >= 0 ? "up" : "down") + "'>" + fmt.format(p.unrealized) + "</td><td></td></tr>").join("");
        tb.innerHTML = pos;
        [...tb.querySelectorAll("tr")].forEach(tr => tr.dataset.real = "1");
        mergePosTable();
        const ot = document.querySelector("#ordT tbody");
        ot.innerHTML = (s.sections.futuresOrders.rows || []).map((o, i) =>
            "<tr><td>" + esc(o.symbol) + "</td><td>" + esc(o.side) + "</td><td class='mono'>" + fmt.format(o.price) +
            "</td><td>" + esc(o.quantity) + "</td><td></td></tr>").join("") || "<tr><td colspan='5' class='dim'>미체결 없음</td></tr>";
    } catch (e) {
        $("wState").innerHTML = "로그인 필요 — <a href='account.html' style='color:#e0b44a'>내 MEXC</a>";
    }
    try {
        const st = await priv("trade", "GET");
        S.tradeEnabled = st.tradeEnabled === true;
        $("mode").textContent = S.tradeEnabled ? (S.armed ? "실매매 ARMED" : "실매매 승인됨") : "모의";
        $("mode").className = "pill " + (S.armed && S.tradeEnabled ? "live" : "paper");
    } catch { /* 비공개 미설정 환경에서는 모의만 동작 */ }
}

// ---- 다종목 스캔: 15초당 1종목씩 파이프라인 판정 + 모의 자동주문 + 보유분 SL/TP/청산가 감시 ----
async function scanTick() {
    // 보유 모의 포지션 감시는 스캔 OFF여도 동작한다
    try {
        const all = await pub("ticker", {});
        all.forEach(t => { if (t.symbol) S.pxMap[t.symbol] = Number(t.lastPrice); });
        for (let i = S.paper.length - 1; i >= 0; i--) {
            const p = S.paper[i], px = S.pxMap[p.symbol];
            if (!(px > 0)) continue;
            if (p.side === 1) {
                if (px <= p.liq) settlePaper(i, p.liq, "강제청산");
                else if (p.sl && px <= p.sl) settlePaper(i, p.sl, "손절");
                else if (p.tp && px >= p.tp) settlePaper(i, p.tp, "익절");
            } else {
                if (px >= p.liq) settlePaper(i, p.liq, "강제청산");
                else if (p.sl && px >= p.sl) settlePaper(i, p.sl, "손절");
                else if (p.tp && px <= p.tp) settlePaper(i, p.tp, "익절");
            }
        }
        renderBank();
    } catch { /* 감시 실패는 다음 틱에 */ }
    if (!S.scan.on || !S.scan.list.length) return;
    const item = S.scan.list[S.scan.idx % S.scan.list.length];
    S.scan.idx++;
    try {
        const [h1, h4, d1] = await Promise.all([
            pub("kline", { symbol: item.symbol, interval: "Min60" }),
            pub("kline", { symbol: item.symbol, interval: "Hour4" }),
            pub("kline", { symbol: item.symbol, interval: "Day1" }),
        ]);
        let funding = null;
        try { funding = Number((await pub("funding_rate", { symbol: item.symbol })).fundingRate); } catch { /* 무시 */ }
        const r = window.TerminalAI.runPipeline(
            { TA: window.TAEngine, LV: window.LevelEngine, SIG: window.SignalEngine },
            { "1h": h1, "4h": h4, "12h": h1, "1d": d1 }, S.pxMap[item.symbol] || item.lastPrice, funding);
        const dir = r.ok && r.entry ? r.entry.side : "관망";
        S.scan.results[item.symbol] = { dir, reason: r.entry ? ("R" + r.entry.rr.toFixed(2)) : (r.blocked || r.reason || ""), at: Date.now() };
        renderScan();
        if (!r.ok || !r.entry) return;
        if (S.paper.some(p => p.symbol === item.symbol)) return; // 종목당 1포지션
        if (S.paper.length >= S.cfg.maxPos) return;
        if (Date.now() - (S.scan.cool[item.symbol] || 0) < S.cfg.coolMin * 60 * 1000) return;
        const lev = Math.min(Number($("lev").value) || 5, 10); // 스캔 자동은 10X 상한
        const px = S.pxMap[item.symbol] || item.lastPrice;
        const vol = Math.floor((S.bank * (S.cfg.ratioPct / 100)) * lev / (px * item.contractSize));
        if (!(vol >= 1)) return;
        const round = v => window.TerminalAI.roundToScale(v, item.priceScale);
        S.scan.cool[item.symbol] = Date.now();
        const ok = paperFill(r.entry.side === "LONG" ? 1 : 3, px, vol, lev, true,
            { symbol: item.symbol, cs: item.contractSize, sl: round(r.entry.stop), tp: round(r.entry.target1) });
        if (ok) log("스캔 진입 " + item.symbol + " " + r.entry.side + " " + vol + "계약 " + lev + "X");
    } catch (e) { S.scan.results[item.symbol] = { dir: "오류", reason: e.message, at: Date.now() }; renderScan(); }
}
function renderScan() {
    const rows = Object.entries(S.scan.results).slice(-10).reverse().map(([s, r]) =>
        "<div>[" + new Date(r.at).toLocaleTimeString("ko-KR", { hourCycle: "h23" }) + "] " + esc(s) + " <b>" +
        esc(r.dir) + "</b> <span class='dim'>" + esc(String(r.reason).slice(0, 40)) + "</span></div>");
    $("scanList").innerHTML = rows.join("") || "<span class='dim'>스캔 대기</span>";
}

// ---- 자동매매 루프 ----
async function autoTick() {
    if (!S.autoPaper && !S.autoLive) return;
    if (Date.now() - S.lastAuto < 5 * 60 * 1000) return;
    const sig = await refreshAI();
    if (sig.dir === "관망" || !sig.entry) return;
    if (S.autoLive && !(S.armed && S.tradeEnabled)) { log("실매매 루프: 승인 없음 — 모의로 전환"); }
    const liveLoop = S.autoLive && S.armed && S.tradeEnabled;
    S.lastAuto = Date.now();
    const side = sig.dir === "LONG" ? 1 : 3;
    const round = v => window.TerminalAI ? window.TerminalAI.roundToScale(v, S.priceScale) : v;
    $("oVol").value = "";
    await submitOrder(side, true, { sl: round(sig.entry.stop), tp: round(sig.entry.target1) });
    log("AI " + sig.dir + " " + sig.reason + (liveLoop ? " [실매매]" : " [모의]"));
}

// ---- 심볼 목록 ----
async function loadSymbols() {
    const d = await pub("detail", {});
    const list = d.filter(x => x.quoteCoin === "USDT" && x.state === 0)
        .sort((a, b) => (b.symbol === "BTC_USDT") - (a.symbol === "BTC_USDT"));
    $("symbol").innerHTML = list.slice(0, 300).map(x => "<option value='" + esc(x.symbol) + "'>" + esc(x.baseCoin) + "/USDT</option>").join("");
    $("symbol").value = S.symbol;
    applyDetail(list.find(x => x.symbol === S.symbol));
    S.detailList = list;
}
function applyDetail(info) {
    if (!info) return;
    S.contractSize = Number(info.contractSize) || S.contractSize;
    S.maxLev = Math.min(Number(info.maxLeverage) || 10, 10);
    if (Number.isFinite(Number(info.priceScale))) S.priceScale = Number(info.priceScale);
}

// ---- 이벤트 ----
function bind() {
    $("tfbar").addEventListener("click", e => {
        const b = e.target.closest("[data-tf]"); if (!b) return;
        [...$("tfbar").children].forEach(x => x.classList.remove("act")); b.classList.add("act");
        S.tf = b.dataset.tf; loadChart().catch(e => log("차트 " + e.message, "down"));
    });
    $("symbol").addEventListener("change", () => {
        S.symbol = $("symbol").value; applyDetail((S.detailList || []).find(x => x.symbol === S.symbol));
        loadChart().catch(e => log("차트 " + e.message, "down"));
        refreshTop().catch(() => {}); refreshBook().catch(() => {}); renderPaper();
    });
    $("otype").addEventListener("click", e => {
        const b = e.target.closest("[data-t]"); if (!b) return;
        [...$("otype").children].forEach(x => x.classList.remove("act")); b.classList.add("act");
    });
    $("oVol").addEventListener("input", updateNotional);
    $("oPct").addEventListener("input", () => {
        // 슬라이더: 모의 가용금의 %를 증거금으로 쓰는 수량으로 환산한다
        const lev = Number($("lev").value) || 1;
        const margin = S.bank * (Number($("oPct").value) / 100);
        $("oVol").value = S.last > 0 ? Math.max(0, Math.floor(margin * lev / (S.last * S.contractSize))) : 0;
        updateNotional();
    });
    $("lev").addEventListener("change", () => $("oPct").dispatchEvent(new Event("input")));
    $("buy").addEventListener("click", () => submitOrder(1, false));
    $("sell").addEventListener("click", () => submitOrder(3, false));
    $("refresh").addEventListener("click", () => { refreshPrivate(); refreshTop().catch(() => {}); });
    $("clearLog").addEventListener("click", () => $("log").innerHTML = "");
    ["cfgNotional", "cfgRatio", "cfgMaxPos", "cfgCool"].forEach(id => {
        $(id).addEventListener("change", () => {
            const v = Number($(id).value);
            if (id === "cfgNotional" && v > 0) S.cfg.notional = Math.min(50000, Math.max(5, v));
            if (id === "cfgRatio" && v > 0) S.cfg.ratioPct = Math.min(10, Math.max(0.1, v));
            if (id === "cfgMaxPos" && v > 0) S.cfg.maxPos = Math.min(10, Math.max(1, Math.round(v)));
            if (id === "cfgCool" && v > 0) S.cfg.coolMin = Math.min(60, Math.max(1, Math.round(v)));
            saveCfg(); loadCfg();
            log("자동매매 설정 저장 — 명목가$" + S.cfg.notional + " 증거금" + S.cfg.ratioPct + "% 최대" + S.cfg.maxPos + " 쿨다운" + S.cfg.coolMin + "분");
        });
    });
    $("paperReset").addEventListener("click", () => {
        S.paper = []; S.bank = 1000000; savePaper(); renderPaper();
        log("모의자금 리셋 — $1,000,000");
    });
    document.querySelector("#posT").addEventListener("click", e => {
        const b = e.target.closest("[data-paper]"); if (!b) return;
        const idx = Number(b.dataset.paper), p = S.paper[idx];
        if (!p) return;
        const px = S.pxMap[p.symbol] !== undefined ? S.pxMap[p.symbol] : (p.symbol === S.symbol ? S.last : p.price);
        settlePaper(idx, px, "수동");
    });
    $("autoPaper").addEventListener("click", () => {
        S.autoPaper = !S.autoPaper;
        $("autoPaper").textContent = "자동매매(모의) " + (S.autoPaper ? "ON" : "OFF");
        $("autoPaper").classList.toggle("on", S.autoPaper);
        log("모의 자동매매 " + (S.autoPaper ? "시작" : "중지"));
    });
    $("autoLive").addEventListener("click", () => {
        if (!S.armed || !S.tradeEnabled) { $("aiMsg").textContent = "실매매 승인부터 하세요."; return; }
        S.autoLive = !S.autoLive;
        $("autoLive").textContent = "자동매매(실매매) " + (S.autoLive ? "ON" : "OFF");
        $("autoLive").classList.toggle("on", S.autoLive);
        log("실매매 자동 " + (S.autoLive ? "시작" : "중지"), "down");
    });
    $("scanToggle").addEventListener("click", async () => {
        S.scan.on = !S.scan.on;
        $("scanToggle").textContent = "다종목 스캔 " + (S.scan.on ? "ON" : "OFF");
        $("scanToggle").classList.toggle("on", S.scan.on);
        if (S.scan.on) {
            try {
                const n = Number($("scanN").value) || 10;
                const [tickers, details] = await Promise.all([pub("ticker", {}), pub("detail", {})]);
                S.scan.list = window.TerminalAI.pickTopSymbols(tickers, details, n);
                S.scan.idx = 0;
                log("다종목 스캔 시작 — 상위 " + S.scan.list.length + "개 (15초당 1종목)");
            } catch (e) { S.scan.on = false; $("scanToggle").textContent = "다종목 스캔 OFF"; log("스캔 목록 실패 " + e.message, "down"); }
        } else log("다종목 스캔 중지");
    });
    $("arm").addEventListener("click", async () => {
        if (!S.tradeEnabled) { $("aiMsg").textContent = "거래 권한 키 미등록 — account 페이지에서 키 등록 후 승인하세요."; return; }
        S.armed = !S.armed;
        $("arm").textContent = S.armed ? "실매매 ARMED" : "실매매 승인";
        $("arm").classList.toggle("armed", S.armed);
        $("mode").textContent = S.armed ? "실매매 ARMED" : "모의";
        $("mode").className = "pill " + (S.armed ? "live" : "paper");
        log(S.armed ? "실매매 ARMED — 수동·자동 주문이 실주문으로 나갑니다" : "실매매 해제 — 모의로 복귀", "down");
    });
    $("kill").addEventListener("click", async () => {
        S.autoPaper = S.autoLive = S.armed = false;
        $("autoPaper").textContent = "자동매매(모의) OFF"; $("autoLive").textContent = "자동매매(실매매) OFF";
        $("arm").textContent = "실매매 승인";
        try { await priv("trade", "POST", { action: "disable" }); S.tradeEnabled = false; } catch {}
        $("mode").textContent = "모의"; $("mode").className = "pill paper";
        log("전체 중지 — 자동매매 OFF, 실매매 승인 해제", "down");
    });
}

(async function init() {
    try { S.paper = JSON.parse(localStorage.getItem("krta-paper") || "[]");
        S.bank = Number((JSON.parse(localStorage.getItem("krta-bank") || "{}")).bank) || 1000000;
    } catch { S.paper = []; S.bank = 1000000; }
    loadCfg();
    bind();
    await loadSymbols();
    await loadChart();
    await refreshTop().catch(e => { $("net").textContent = "시세 실패"; });
    $("net").textContent = "실시간";
    await refreshBook().catch(() => {});
    renderPaper();
    await refreshPrivate();
    S.timer.push(setInterval(() => refreshTop().catch(() => {}), 3000));
    S.timer.push(setInterval(() => refreshBook().catch(() => {}), 3000));
    S.timer.push(setInterval(autoTick, 10000));
    S.timer.push(setInterval(scanTick, 15000));
    S.timer.push(setInterval(() => loadChart().catch(() => {}), 60000));
    log("터미널 시작 — 기본 모의. 실매매는 승인 후에만 동작합니다.");
})();
})();
