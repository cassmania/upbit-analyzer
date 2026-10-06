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
    bank: 1000000, pxMap: {}, csMap: {}, scan: { on: false, list: [], idx: 0, results: {}, cool: {} },
    layout: 1, panes: [], mainPL: { lines: [] },
    cfg: { notional: 50, ratioPct: 1, maxPos: 5, coolSec: 300, autoLev: 3,
        tpMode: "ai", tpPct: 5, slMode: "ai", slPct: 3, noOverlap: true }, fav: [], allSymbols: [], hist: [], ptab: "active" };
function loadFav() {
    try { S.fav = (JSON.parse(localStorage.getItem("krta-fav") || "[]") || []).filter(s => typeof s === "string").slice(0, 50); }
    catch { S.fav = []; }
}
function saveFav() {
    try { localStorage.setItem("krta-fav", JSON.stringify(S.fav)); return true; }
    catch {
        log("즐겨찾기 저장 실패 — 브라우저 저장소가 차단됐습니다", "down");
        const m = $("aiMsg"); if (m) m.textContent = "즐겨찾기 저장 실패: 브라우저 저장소 허용 필요";
        return false;
    }
}
const isFav = s => S.fav.includes(s);
function renderFavBtn() {
    const on = isFav(S.symbol);
    $("favBtn").classList.toggle("on", on);
    $("favBtn").firstChild.textContent = on ? "★ " : "☆ ";
    $("favCount").textContent = S.fav.length;
}
function renderSymbolSelect() {
    const q = ($("symQ").value || "").trim().toUpperCase();
    const sym = x => String(x.symbol || "");
    const base = x => String(x.baseCoin || "");
    const match = x => !q || sym(x).includes(q) || base(x).toUpperCase().includes(q);
    const favs = S.allSymbols.filter(x => isFav(sym(x)) && match(x));
    const rest = S.allSymbols.filter(x => !isFav(sym(x)) && match(x)).slice(0, 200);
    const cur = S.allSymbols.find(x => sym(x) === S.symbol);
    const curOpt = (cur && !favs.includes(cur) && !rest.includes(cur))
        ? "<option value='" + esc(S.symbol) + "'>" + esc(String(cur.baseCoin || S.symbol)) + "/USDT</option>" : "";
    $("symbol").innerHTML = curOpt + favs.map(x => "<option value='" + esc(sym(x)) + "'>★ " + esc(base(x)) + "/USDT</option>").join("") +
        rest.map(x => "<option value='" + esc(sym(x)) + "'>" + esc(base(x)) + "/USDT</option>").join("");
    if ([...$("symbol").options].some(o => o.value === S.symbol)) $("symbol").value = S.symbol;
    // 검색 결과가 보이게: 상위 8개를 드롭다운으로 (select만 필터하면 입력해도 화면이 안 바뀌어 보인다)
    const box = $("symResults");
    if (!q) { box.hidden = true; box.innerHTML = ""; return; }
    const top = [...favs, ...rest].slice(0, 8);
    box.innerHTML = top.map(x => "<div class='symrow' data-sym='" + esc(sym(x)) + "'><button class='fstar" +
        (isFav(sym(x)) ? " on" : "") + "' data-fav='" + esc(sym(x)) + "' title='즐겨찾기'>" +
        (isFav(sym(x)) ? "★" : "☆") + "</button><span><b>" + esc(base(x)) + "/USDT</b></span>" +
        "<span class='px mono'>" + fmt.format(S.pxMap[sym(x)] || 0) + "</span></div>").join("") ||
        (S.allSymbols.length ? "<div class='symrow'><span>검색 결과 없음</span></div>"
            : "<div class='symrow'><span>심볼 목록 로딩 실패 — 상단 연결중 클릭</span></div>");
    box.hidden = false;
}
function selectSymbol(sym) {
    S.symbol = sym;
    renderSymbolSelect();
    $("symQ").value = "";
    $("symResults").hidden = true;
    renderFavBtn();
    markFocusedPane();
    applyDetail((S.detailList || []).find(x => x.symbol === S.symbol));
    loadChart().catch(e => log("차트 " + e.message, "down"));
    refreshTop().catch(() => {}); refreshBook().catch(() => {}); renderPaper();
    queueSaveUi();
}
function renderFavPanel() {
    $("favList").innerHTML = "<div class='favrow' data-add='1'><span>" + (isFav(S.symbol) ? "★" : "☆") +
        " 현재 심볼 " + esc(S.symbol) + (isFav(S.symbol) ? " 해제" : " 추가") + "</span></div>" +
        (S.fav.map(s => "<div class='favrow' data-sym='" + esc(s) + "'><span>★ " + esc(s.replace("_USDT", "")) +
        "/USDT</span><span class='dim mono'>" + fmt.format(S.pxMap[s] || 0) + "</span>" +
        "<button class='rm' data-rm='" + esc(s) + "' title='삭제'>✕</button></div>").join("") ||
        "<div class='dim'>즐겨찾기가 비어 있습니다. 검색 후 ☆로 추가하세요.</div>");
}
function loadCfg() {
    try {
        const c = JSON.parse(localStorage.getItem("krta-cfg") || "{}");
        if (Number(c.notional) > 0) S.cfg.notional = Math.min(50000, Math.max(5, Number(c.notional)));
        if (Number(c.ratioPct) > 0) S.cfg.ratioPct = Math.min(10, Math.max(0.01, Number(c.ratioPct)));
        if (Number(c.maxPos) > 0) S.cfg.maxPos = Math.min(100, Math.max(1, Math.round(Number(c.maxPos))));
        if (Number(c.coolSec) > 0) S.cfg.coolSec = Math.min(3600, Math.max(5, Math.round(Number(c.coolSec))));
        else if (Number(c.coolMin) > 0) S.cfg.coolSec = Math.min(3600, Math.max(5, Math.round(Number(c.coolMin)) * 60));
        if ([1, 2, 3, 5, 10].includes(Number(c.autoLev))) S.cfg.autoLev = Number(c.autoLev);
        if (["ai", "manual"].includes(c.tpMode)) S.cfg.tpMode = c.tpMode;
        if (Number(c.tpPct) > 0) S.cfg.tpPct = Math.min(500, Math.max(0.1, Number(c.tpPct)));
        if (["ai", "manual"].includes(c.slMode)) S.cfg.slMode = c.slMode;
        if (Number(c.slPct) > 0) S.cfg.slPct = Math.min(100, Math.max(0.1, Number(c.slPct)));
        if (typeof c.noOverlap === "boolean") S.cfg.noOverlap = c.noOverlap;
    } catch { /* 기본값 유지 */ }
    $("cfgMargin").value = S.cfg.ratioPct;
    $("cfgMaxPos2").value = String(S.cfg.maxPos);
    $("cfgCool2").value = String(S.cfg.coolSec);
    $("cfgLev").value = String(S.cfg.autoLev);
    document.querySelectorAll("input[name=tpMode]").forEach(r => r.checked = r.value === S.cfg.tpMode);
    document.querySelectorAll("input[name=slMode]").forEach(r => r.checked = r.value === S.cfg.slMode);
    $("cfgTpPct").value = S.cfg.tpPct;
    $("cfgSlPct").value = S.cfg.slPct;
    $("cfgOverlap").checked = S.cfg.noOverlap;
    cfgPreview();
}
function toggleCfg() {
    const b = $("cfgBody").classList.toggle("collapsed");
    $("cfgFold").textContent = b ? "∨" : "∧";
    queueSaveUi();
}
function cfgPreview() {
    $("cfgMarginPctView").textContent = S.cfg.ratioPct + "%";
    const usdt = Math.round(S.bank * S.cfg.ratioPct / 100);
    if (document.activeElement !== $("cfgMarginUsdtIn")) $("cfgMarginUsdtIn").value = usdt;
}
// 테마: 라이트/다크. 차트 색상까지 함께 바꾼다
function chartPalette() {
    return document.documentElement.dataset.theme === "light"
        ? { bg: "#ffffff", text: "#5b6472", grid: "#e6e9f0", border: "#d4dae4" }
        : { bg: "#12161f", text: "#8b93a7", grid: "#1a2130", border: "#222839" };
}
function applyThemeToChart() {
    if (!S.chart) return;
    const p = chartPalette();
    const opts = { layout: { background: { color: p.bg }, textColor: p.text },
        grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
        rightPriceScale: { borderColor: p.border }, timeScale: { borderColor: p.border } };
    S.chart.applyOptions(opts);
    (S.panes || []).forEach(P => { if (P && P.chart) P.chart.applyOptions(opts); });
}
function loadTheme() {
    let t = "dark";
    try { t = localStorage.getItem("krta-theme") || "dark"; } catch {}
    if (t !== "light") t = "dark";
    document.documentElement.dataset.theme = t;
    const b = $("themeBtn"); if (b) b.textContent = t === "light" ? "☾" : "☀";
}
// 자동매매 SL/TP: AI 모드는 신호값, 수동 모드는 진입가 대비 %
function autoTPSL(entry, px, long, ps) {
    const round = v => window.TerminalAI ? window.TerminalAI.roundToScale(v, ps) : v;
    const tp = S.cfg.tpMode === "manual"
        ? (long ? px * (1 + S.cfg.tpPct / 100) : px * (1 - S.cfg.tpPct / 100))
        : entry.target1;
    const sl = S.cfg.slMode === "manual"
        ? (long ? px * (1 - S.cfg.slPct / 100) : px * (1 + S.cfg.slPct / 100))
        : entry.stop;
    return { sl: round(sl), tp: round(tp) };
}
function saveCfg() {
    try { localStorage.setItem("krta-cfg", JSON.stringify(S.cfg)); } catch { /* 무시 */ }
}
// 화면 상태 저장/복원: 재접속해도 심볼·봉·주문창·토글 그대로
let uiSaveTimer = 0;
function saveUi() {
    try {
        const t = document.querySelector("#otype .act");
        localStorage.setItem("krta-ui", JSON.stringify({
            symbol: S.symbol, tf: S.tf,
            lev: $("lev").value, otype: t ? t.dataset.t : "1",
            oPrice: $("oPrice").value, oMargin: $("oMargin").value, oVol: $("oVol").value,
            oUsdt: $("oUsdt").value, oPct: $("oPct").value,
            oTpsl: $("oTpsl").checked, oSL: $("oSL").value, oTP: $("oTP").value, oReduce: $("oReduce").checked,
            scanN: $("scanN").value, ptab: S.ptab, autoPaper: S.autoPaper,
            cfgFold: $("cfgBody").classList.contains("collapsed"),
            layout: S.layout, panes: (S.panes || []).slice(0, 7).map(P => P ? { s: P.symbol, t: P.tf } : null)
        }));
    } catch { /* 무시 */ }
}
function queueSaveUi() {
    clearTimeout(uiSaveTimer);
    uiSaveTimer = setTimeout(saveUi, 400);
}
function loadUi() {
    let u = {};
    try { u = JSON.parse(localStorage.getItem("krta-ui") || "{}"); } catch { u = {}; }
    if (typeof u.symbol === "string" && u.symbol) S.symbol = u.symbol;
    const TFS = ["Min15", "Min60", "Hour4", "Hour8", "Hour12", "Day1", "Week1"];
    if (TFS.includes(u.tf)) {
        S.tf = u.tf;
        [...$("tfbar").children].forEach(x => x.classList.toggle("act", x.dataset.tf === u.tf));
    }
    const set = (id, v) => { if (v !== undefined && v !== null && $(id)) $(id).value = v; };
    const hasOpt = (id, v) => $(id) && [...$(id).options].some(o => o.value === String(v));
    if (hasOpt("lev", u.lev)) $("lev").value = u.lev;
    set("oPrice", u.oPrice); set("oMargin", u.oMargin); set("oVol", u.oVol);
    set("oUsdt", u.oUsdt); set("oPct", u.oPct); set("oSL", u.oSL); set("oTP", u.oTP);
    if (hasOpt("scanN", u.scanN)) $("scanN").value = u.scanN;
    if (u.otype) [...$("otype").children].forEach(x => x.classList.toggle("act", x.dataset.t === String(u.otype)));
    if ($("oTpsl")) $("oTpsl").checked = !!u.oTpsl;
    if ($("oReduce")) $("oReduce").checked = !!u.oReduce;
    if (typeof u.ptab === "string" && u.ptab) S.ptab = u.ptab;
    if ($("tpslBox")) $("tpslBox").hidden = !$("oTpsl").checked;
    if (u.cfgFold && $("cfgBody")) { $("cfgBody").classList.add("collapsed"); $("cfgFold").textContent = "∨"; }
    if ([1, 2, 4, 8].includes(Number(u.layout))) S.layout = Number(u.layout);
    if (Array.isArray(u.panes)) {
        S.panes = u.panes.slice(0, 7).map(p => (p && typeof p.s === "string" && TF_OPTS.includes(p.t))
            ? { symbol: p.s, tf: p.t, chart: null, series: null, lines: {}, pl: { lines: [] } } : null);
        while (S.panes.length < 7) S.panes.push(null);
    }
    if (u.autoPaper) {
        S.autoPaper = true;
        $("autoPaper").textContent = "자동매매(모의) ON"; $("autoPaper").classList.toggle("on", true);
    }
}

async function pub(path, params, tries) {
    tries = tries || 3;
    let last;
    for (let i = 0; i < tries; i++) {
        try {
            const q = new URLSearchParams({ path, ...params });
            const r = await fetch("/api/mexc-futures?" + q, { cache: "no-store" });
            if (!r.ok) throw new Error("시세 오류 " + r.status);
            const j = await r.json();
            if (j.success !== true || Number(j.code) !== 0) throw new Error("시세 오류");
            return j.data;
        } catch (e) {
            last = e;
            if (i + 1 < tries) await new Promise(r => setTimeout(r, 600 * (i + 1)));
        }
    }
    throw last;
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
    const p = chartPalette();
    S.chart = LightweightCharts.createChart($("chart"), { layout: { background: { color: p.bg }, textColor: p.text },
        grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
        rightPriceScale: { borderColor: p.border }, timeScale: { borderColor: p.border, timeVisible: true } });
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
    $("mainsym").textContent = S.symbol.replace("_USDT", "/USDT") + " · " + (typeof TF_LABEL !== "undefined" && TF_LABEL[S.tf] ? TF_LABEL[S.tf] : S.tf);
    drawSR(S.series, S.mainPL, candles);
    await refreshAI();
}

// ---- 멀티차트 (최대 8개, 각기 다른 코인) + 지지/저항선 ----
const TF_OPTS = ["Min15", "Min60", "Hour4", "Hour8", "Hour12", "Day1", "Week1"];
const TF_LABEL = { Min15: "15m", Min60: "1H", Hour4: "4H", Hour8: "8H", Hour12: "12H", Day1: "1D", Week1: "1W" };
function swingLevels(candles) {
    const Hs = [], Ls = [], k = 2, n = Math.min(candles.length, 150), start = Math.max(k, candles.length - n);
    for (let i = start; i < candles.length - k; i++) {
        let hi = true, lo = true;
        for (let j = 1; j <= k; j++) {
            if (candles[i].high < candles[i - j].high || candles[i].high < candles[i + j].high) hi = false;
            if (candles[i].low > candles[i - j].low || candles[i].low > candles[i + j].low) lo = false;
        }
        if (hi) Hs.push(candles[i].high);
        if (lo) Ls.push(candles[i].low);
    }
    const last = candles[candles.length - 1].close;
    return {
        res: [...new Set(Hs.filter(h => h > last))].sort((a, b) => a - b).slice(0, 3),
        sup: [...new Set(Ls.filter(l => l < last))].sort((a, b) => b - a).slice(0, 3)
    };
}
function drawSR(series, store, candles) {
    if (!series || !candles || !candles.length) return;
    (store.lines || []).forEach(l => { try { series.removePriceLine(l); } catch {} });
    store.lines = [];
    const lv = swingLevels(candles);
    lv.res.forEach((p, i) => store.lines.push(series.createPriceLine({ price: p, color: "#f6465d", lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: "저항" + (i + 1) })));
    lv.sup.forEach((p, i) => store.lines.push(series.createPriceLine({ price: p, color: "#2962ff", lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: "지지" + (i + 1) })));
}
function defaultPaneSymbols() {
    const have = s => S.allSymbols.some(x => x.symbol === s);
    const out = [];
    (S.fav || []).forEach(s => { if (have(s) && out.length < 7) out.push(s); });
    ["ETH_USDT", "SOL_USDT", "XRP_USDT", "DOGE_USDT", "BNB_USDT", "ADA_USDT", "TRX_USDT"].forEach(s => { if (have(s) && out.length < 7 && !out.includes(s)) out.push(s); });
    while (out.length < 7) out.push(S.symbol);
    return out;
}
function setLayout(n) {
    S.layout = [1, 2, 4, 8].includes(n) ? n : 1;
    document.querySelectorAll("#tfbar [data-layout]").forEach(x => x.classList.toggle("lact", Number(x.dataset.layout) === S.layout));
    $("charts").className = "charts g" + S.layout;
    while (S.panes.length < 7) S.panes.push(null);
    for (let i = 0; i < 7; i++) {
        const el = $("cpane" + (i + 1));
        if (i < S.layout - 1) {
            if (!S.panes[i]) {
                const defs = defaultPaneSymbols();
                S.panes[i] = { symbol: defs[i] || S.symbol, tf: "Hour4", chart: null, series: null, lines: {}, pl: { lines: [] } };
            }
            if (!el) ensurePane(i);
            else el.hidden = false;
            fillPaneHead(i);
            loadPane(i).catch(e => log("서브차트 " + (i + 2) + " " + e.message, "down"));
        } else if (el) el.hidden = true;
    }
    queueSaveUi();
}
function ensurePane(i) {
    const wrap = document.createElement("div");
    wrap.className = "cpane";
    wrap.id = "cpane" + (i + 1);
    wrap.innerHTML = "<div class='panehead'><select class='psym' aria-label='차트" + (i + 2) + " 심볼'></select>" +
        "<select class='ptf' aria-label='차트" + (i + 2) + " 봉'>" +
        TF_OPTS.map(t => "<option value='" + t + "'>" + TF_LABEL[t] + "</option>").join("") + "</select></div>" +
        "<div class='pchart' id='pchart" + (i + 1) + "'></div>" +
        "<div class='sr-legend'><span class='rr'>— 저항1~3</span><span class='ss'>— 지지1~3</span></div>";
    $("charts").appendChild(wrap);
    const P = S.panes[i], p = chartPalette();
    P.chart = LightweightCharts.createChart(wrap.querySelector(".pchart"), { layout: { background: { color: p.bg }, textColor: p.text },
        grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
        rightPriceScale: { borderColor: p.border }, timeScale: { borderColor: p.border, timeVisible: true } });
    P.series = P.chart.addCandlestickSeries({ upColor: "#0ecb81", downColor: "#f6465d", wickUpColor: "#0ecb81", wickDownColor: "#f6465d" });
    const mk = c => P.chart.addLineSeries({ color: c, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    P.lines = { ma5: mk("#e0b44a"), ma10: mk("#29b6f6"), ma30: mk("#9b59b6"), ma60: mk("#7f8c8d") };
    const box = wrap.querySelector(".pchart");
    new ResizeObserver(() => P.chart.resize(box.clientWidth, box.clientHeight)).observe(box);
    wrap.querySelector(".psym").addEventListener("change", e => { S.panes[i].symbol = e.target.value; loadPane(i).catch(() => {}); queueSaveUi(); });
    wrap.querySelector(".ptf").addEventListener("change", e => { S.panes[i].tf = e.target.value; loadPane(i).catch(() => {}); queueSaveUi(); });
    wrap.addEventListener("click", e => {
        if (e.target.closest("select")) return;
        if (S.panes[i] && S.panes[i].symbol !== S.symbol) selectSymbol(S.panes[i].symbol);
    });
}
function markFocusedPane() {
    document.querySelectorAll("#charts .cpane").forEach((el, idx) => {
        const sym = idx === 0 ? S.symbol : (S.panes[idx - 1] && S.panes[idx - 1].symbol);
        el.classList.toggle("focused", sym === S.symbol);
    });
}
function fillPaneHead(i) {
    const P = S.panes[i], wrap = $("cpane" + (i + 1));
    if (!P || !wrap) return;
    const sel = wrap.querySelector(".psym");
    sel.innerHTML = S.allSymbols.map(x => "<option value='" + esc(x.symbol) + "'>" + esc(x.baseCoin) + "/USDT</option>").join("");
    if ([...sel.options].some(o => o.value === P.symbol)) sel.value = P.symbol;
    else { P.symbol = sel.options[0] ? sel.options[0].value : S.symbol; sel.value = P.symbol; }
    wrap.querySelector(".ptf").value = P.tf;
}
async function loadPane(i) {
    const P = S.panes[i];
    if (!P || !P.chart) return;
    const iv = P.tf === "Hour12" ? "Min60" : P.tf;
    const d = await pub("kline", { symbol: P.symbol, interval: iv });
    let candles = d.time.map((t, j) => ({ time: t, open: d.open[j], high: d.high[j], low: d.low[j], close: d.close[j], vol: d.vol[j] || 0 }));
    if (P.tf === "Hour12") candles = resample12h(candles);
    candles = candles.slice(-300);
    P.series.setData(candles);
    const closes = candles.map(k => k.close);
    const mas = { ma5: sma(closes, 5), ma10: sma(closes, 10), ma30: sma(closes, 30), ma60: sma(closes, 60) };
    for (const k of Object.keys(mas)) P.lines[k].setData(candles.map((c, j) => ({ time: c.time, value: mas[k][j] })).filter(pt => pt.value !== null));
    drawSR(P.series, P.pl, candles);
    P.chart.timeScale().scrollToRealTime();
}
function refreshAllCharts() {
    loadChart().catch(() => {});
    for (let i = 0; i < S.layout - 1; i++) if (S.panes[i] && S.panes[i].chart) loadPane(i).catch(() => {});
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
// 모의 보유종목 가격 실시간화: pxMap만 갱신하고 화면을 안 그리면 숫자가 멈춰 보인다
async function refreshPaperPrices() {
    if (!S.paper.length) return;
    try {
        const all = await pub("ticker", {});
        all.forEach(t => { if (t.symbol && Number(t.lastPrice) > 0) S.pxMap[t.symbol] = Number(t.lastPrice); });
        renderPaper(); renderBank();
    } catch { /* 다음 틱에 */ }
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
function ticketPx() {
    const type = Number(document.querySelector("#otype .act").dataset.t);
    return (type === 1 && Number($("oPrice").value) > 0) ? Number($("oPrice").value) : S.last;
}
function ticketAvail() {
    return (S.armed && S.tradeEnabled && S.liveAvail > 0) ? S.liveAvail : S.bank;
}
function syncFromUsdt() {
    const px = ticketPx(), u = Number($("oUsdt").value);
    if (px > 0 && u > 0) {
        const vol = Math.max(0, Math.floor(u / (px * S.contractSize)));
        $("oVol").value = vol;
        syncFromVol();
    } else updateTicket();
}
function syncFromMargin() {
    const lev = Number($("lev").value) || 1, px = ticketPx(), m = Number($("oMargin").value);
    $("oVol").value = (px > 0 && m > 0) ? Math.max(0, Math.floor(m * lev / (px * S.contractSize))) : $("oVol").value;
    updateTicket();
}
function syncFromVol() {
    const lev = Number($("lev").value) || 1, px = ticketPx(), v = Number($("oVol").value);
    const n = (px > 0 && v > 0) ? v * px * S.contractSize : 0;
    if (n > 0) {
        $("oMargin").value = Math.round(n / lev * 100) / 100;
        $("oUsdt").value = Math.round(n * 100) / 100;
    }
    updateTicket();
}
function updateTicket() {
    const v = Number($("oVol").value), px = ticketPx(), lev = Number($("lev").value) || 1;
    const n = (v > 0 && px > 0) ? v * px * S.contractSize : 0;
    const m = n > 0 ? n / lev : 0;
    const avail = ticketAvail(), maxN = avail * lev;
    $("availAmt").textContent = fmt.format(Math.round(avail * 100) / 100);
    $("buyAmt").textContent = fmt.format(Math.round(n * 100) / 100) + " USDT";
    $("sellAmt").textContent = fmt.format(Math.round(n * 100) / 100) + " USDT";
    $("maxLong").textContent = fmt.format(Math.round(maxN)) + " USDT";
    $("maxShort").textContent = fmt.format(Math.round(maxN)) + " USDT";
    $("mBuy").textContent = fmt.format(Math.round(m * 100) / 100) + " USDT";
    $("mSell").textContent = fmt.format(Math.round(m * 100) / 100) + " USDT";
}
function updateNotional() { updateTicket(); }

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
function chartZoom(mode) {
    if (!S.chart) return;
    const ts = S.chart.timeScale();
    if (mode === "reset") {
        const n = S.candles ? S.candles.length : 0;
        const count = Math.min(120, n || 120);
        ts.setVisibleLogicalRange({ from: Math.max(0, n - count), to: Math.max(0, n - 1) });
        return;
    }
    const r = ts.getVisibleLogicalRange();
    if (!r) return;
    const f = mode === "in" ? 0.7 : 1.4;
    const center = (r.from + r.to) / 2, half = Math.max(6, (r.to - r.from) / 2 * f);
    ts.setVisibleLogicalRange({ from: center - half, to: center + half });
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
    // 자동매매는 AI 설정 레버리지, 수동은 주문창 값을 쓴다
    const lev = auto ? (Number(opts && opts.lev) || S.cfg.autoLev) : (Number($("lev").value) || S.cfg.autoLev);
    const type = Number(document.querySelector("#otype .act").dataset.t);
    let vol = Number($("oVol").value);
    if (auto && !(vol > 0)) {
        // 단일 자동매매도 AI 설정 증거금 비율로 진입한다
        vol = Math.max(1, Math.floor((S.bank * (S.cfg.ratioPct / 100)) * lev / (S.last * S.contractSize)));
    }
    if (!(vol > 0)) { $("oMsg").textContent = "수량을 입력하세요."; return; }
    const reduceOnly = $("oReduce").checked;
    if (reduceOnly && !S.paper.some(p => p.symbol === S.symbol)) { $("oMsg").textContent = "리듀스 온리: 보유 포지션이 없습니다."; return; }
    const intent = { symbol: S.symbol, side, type, leverage: lev, vol,
        ...(type === 1 && $("oPrice").value ? { price: Number($("oPrice").value) } : {}),
        ...(opts && opts.sl ? { stopLossPrice: opts.sl } : {}),
        ...(opts && opts.tp ? { takeProfitPrice: opts.tp } : {}),
        ...(!auto && $("oTpsl").checked && $("oSL").value ? { stopLossPrice: Number($("oSL").value) } : {}),
        ...(!auto && $("oTpsl").checked && $("oTP").value ? { takeProfitPrice: Number($("oTP").value) } : {}) };
    const live = S.armed && S.tradeEnabled && (auto ? S.autoLive : true);
    if (live && reduceOnly) { $("oMsg").textContent = "리듀스 온리는 모의 전용입니다."; return; }
    // 모의는 로그인 없이 로컬 체결한다 (서버 검증은 실주문 경로 전용)
    if (!live) {
        const px = type === 1 && intent.price ? intent.price : S.last;
        if (!(px > 0)) { $("oMsg").textContent = "현재가 없음 — 잠시 후 재시도"; return; }
        if (reduceOnly) {
            const idx = S.paper.findIndex(p => p.symbol === S.symbol);
            if (idx < 0) { $("oMsg").textContent = "리듀스 온리: 보유 포지션이 없습니다."; return; }
            const p = S.paper[idx], isOpp = (side === 1 && (p.side === 3 || p.side === 4)) || (side === 3 && p.side === 1);
            if (!isOpp) { $("oMsg").textContent = "리듀스 온리: 반대 방향만 됩니다."; return; }
            settlePaper(idx, px, "리듀스온리 청산");
            return;
        }
        const ok = paperFill(side, px, vol, lev, auto,
            { sl: intent.stopLossPrice || null, tp: intent.takeProfitPrice || null });
        if (ok) {
            $("oMsg").textContent = "모의 체결 약 $" + fmt.format(Math.round(px * vol * S.contractSize * 100) / 100);
            log((side === 1 ? "모의 LONG " : "모의 SHORT ") + vol + "계약 @" + fmt.format(px));
        }
        return;
    }
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
    const sym = opts.symbol || S.symbol;
    // 같은 코인은 롱·숏 통틀어 1포지션만 (역방향은 기존 청산 후 진입이라 통과)
    if (S.cfg.noOverlap && S.paper.some(p => p.symbol === sym)) { $("oMsg").textContent = "같은 코인은 1포지션만 — 청산·역방향 이용"; return false; }
    const cs = Number(opts.cs) || S.csMap[sym] || (sym === S.symbol ? S.contractSize : 0.0001);
    const calc = window.TerminalAI ? window.TerminalAI.openCalc(price, vol, lev, cs) : null;
    if (!calc) { $("oMsg").textContent = "수량·가격 오류"; return false; }
    const need = calc.margin + calc.feeIn;
    if (need > S.bank) { $("oMsg").textContent = "모의 증거금 부족(필요 $" + fmt.format(Math.round(need)) + ")"; return false; }
    S.bank = Math.round((S.bank - need) * 100) / 100;
    S.paper.push({ symbol: opts.symbol || S.symbol, side, price, vol, lev, cs, margin: calc.margin, feeIn: calc.feeIn, added: 0,
        liq: side === 1 ? calc.liqLong : calc.liqShort,
        sl: opts.sl || null, tp: opts.tp || null, at: Date.now(), auto: !!auto });
    savePaper();
    renderPaper();
    return true;
}
// 저장된 포지션의 계약단위·증거금·청산가를 해당 코인 기준으로 재계산 (구 저장분 자가치유)
function sanitizePaper() {
    let fixed = 0;
    S.paper.forEach(p => {
        const cs = S.csMap[p.symbol] || Number(p.cs) || 0.0001;
        const base = Math.round(p.price * p.vol * cs / Math.max(1, p.lev) * 100) / 100;
        const margin = Math.round((base + (Number(p.added) || 0)) * 100) / 100;
        const ratio = margin / Math.max(p.price * p.vol * cs, 1e-9);
        const liq = p.side === 1 ? p.price * (1 - ratio + 0.005) : p.price * (1 + ratio - 0.005);
        if (p.cs !== cs || Math.abs((p.margin || 0) - margin) > 0.005 || Math.abs((p.liq || 0) - liq) > 1e-9) fixed++;
        p.cs = cs; p.margin = margin; p.liq = Math.round(liq * 100) / 100;
    });
    if (fixed) { savePaper(); log("모의 포지션 " + fixed + "건 증거금·청산가 재계산"); }
}
function savePaper() {
    try { localStorage.setItem("krta-paper", JSON.stringify(S.paper.slice(-50)));
        localStorage.setItem("krta-bank", JSON.stringify({ bank: S.bank }));
        localStorage.setItem("krta-hist", JSON.stringify(S.hist.slice(-100))); } catch { /* 저장 실패 무시 */ }
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
    const uCls = unreal >= 0 ? "p-pos" : "p-neg", pCls = pnl >= 0 ? "p-pos" : "p-neg";
    const html = "모의 지갑 $" + fmt.format(Math.round(S.bank)) + " · 미실현 <span class='" + uCls + "'>" +
        (unreal >= 0 ? "+" : "") + fmt.format(Math.round(unreal)) + "</span> · 평가 $" + fmt.format(Math.round(eq)) +
        " (<span class='" + pCls + "'>" + (pnl >= 0 ? "+" : "") + fmt.format(Math.round(pnl)) + "</span>)";
    $("paperBank").innerHTML = html;
    if ($("paperBankTop")) $("paperBankTop").innerHTML = html;
    cfgPreview();
    if ($("wState").textContent !== "연결됨") {
        $("wUnreal").textContent = (unreal >= 0 ? "+" : "") + fmt.format(Math.round(unreal)) + " USDT";
        $("wUnreal").className = "mono " + (unreal >= 0 ? "p-pos" : "p-neg");
        $("wBal").textContent = fmt.format(Math.round(S.bank)) + " USDT";
        $("wEq").textContent = fmt.format(Math.round(eq)) + " USDT";
        $("wAvail").textContent = fmt.format(Math.round(S.bank)) + " USDT";
    }
}
function settlePaper(idx, px, reason) {
    const p = S.paper[idx];
    if (!p || !window.TerminalAI) return;
    const r = window.TerminalAI.settleCalc(p, px);
    S.bank = Math.round((S.bank + r.credit) * 100) / 100;
    S.paper.splice(idx, 1);
    S.hist.push({ symbol: p.symbol, side: p.side, pnl: Math.round(r.pnl * 100) / 100, reason,
        when: new Date().toLocaleString("ko-KR", { hourCycle: "h23" }) });
    savePaper();
    renderPaper();
    log("모의 청산[" + reason + "] " + p.symbol + " " + (p.side === 1 ? "롱" : "숏") + " 손익 " +
        (r.pnl >= 0 ? "+" : "") + fmt.format(Math.round(r.pnl * 100) / 100) + " (수수료 " + fmt.format(Math.round((p.feeIn + r.feeOut) * 100) / 100) + ")");
}
function renderPaper() {
    // 참고 화면식: 뱃지 방향·현재가·투입마진·자동마진·수익률·3액션
    const tb = document.querySelector("#paperT tbody");
    const tab = S.ptab || "active";
    document.querySelectorAll("#ptabs button").forEach(b => b.classList.toggle("act", b.dataset.pt === tab));
    $("pCount").textContent = S.paper.length;
    $("oCount").textContent = "0";
    if (tab === "history") {
        tb.innerHTML = S.hist.slice().reverse().slice(0, 20).map(h =>
            "<tr><td>" + esc(h.symbol) + "</td><td colspan='8' class='dim'>" + esc(h.reason) + " · " +
            esc(h.when) + "</td><td class='mono " + (h.pnl >= 0 ? "p-pos" : "p-neg") + "'>" +
            (h.pnl >= 0 ? "+" : "") + fmt.format(Math.round(h.pnl * 100) / 100) + "</td><td></td></tr>").join("") ||
            "<tr><td colspan='11' class='dim'>거래 이력 없음</td></tr>";
        renderBank();
        return;
    }
    if (tab === "pending") {
        tb.innerHTML = "<tr><td colspan='11' class='dim'>대기 주문 없음 (예약·트리거 주문 미지원)</td></tr>";
        renderBank();
        return;
    }
    tb.innerHTML = S.paper.slice().reverse().map((p) => {
        const px = S.pxMap[p.symbol] !== undefined ? S.pxMap[p.symbol] : undefined;
        const cur = px !== undefined ? px : p.price;
        const pnl = paperUnreal(p, px);
        const base = p.price * p.vol * (p.cs || S.contractSize);
        const pct = base > 0 ? pnl / p.margin * 100 : 0;
        const long = p.side === 1;
        const idx = S.paper.indexOf(p);
        return "<tr><td>" + esc(p.symbol) + "</td><td><span class='badge " + (long ? "long" : "short") + "'>" +
            (long ? "LONG" : "SHORT") + "</span></td><td>" + p.lev + "x</td><td>" + p.vol + "</td>" +
            "<td class='mono'>" + fmt.format(p.price) + "</td><td class='mono'>" + fmt.format(cur) + "</td>" +
            "<td class='mono down'>" + fmt.format(Math.round(p.liq * 100) / 100) + "</td>" +
            "<td class='mono'>" + fmt.format(Math.round(p.margin * 100) / 100) + "</td>" +
            "<td><label class='switch'><input type='checkbox' data-guard='" + idx + "'" + (p.guard === false ? "" : " checked") + "><i></i></label></td>" +
            "<td class='mono " + (pnl >= 0 ? "p-pos" : "p-neg") + "'>" + (pnl >= 0 ? "+" : "") +
            fmt.format(Math.round(pnl * 100) / 100) + " (" + (pct >= 0 ? "+" : "") + pct.toFixed(2) + "%)</td>" +
            "<td><button class='abtn' data-close='" + idx + "'>시장가 청산</button> " +
            "<button class='abtn go' data-rev='" + idx + "'>역방향</button> " +
            "<button class='abtn add' data-add='" + idx + "'>마진 추가</button></td></tr>";
    }).join("") || "<tr><td colspan='11' class='dim'>모의 포지션 없음</td></tr>";
    renderBank();
}

let modalCb = null;
function openModal(title, bodyHtml, label, defVal, okText, cb) {
    $("mTitle").textContent = title;
    $("mBody").innerHTML = bodyHtml;
    $("mLabel").textContent = label;
    $("mInput").value = defVal;
    $("mOk").textContent = okText;
    modalCb = cb;
    $("modalOv").hidden = false;
    $("mInput").focus();
    $("mInput").select();
}
function closeModal() { $("modalOv").hidden = true; modalCb = null; }

// ---- 비공개 (잔고·포지션·미체결) ----
async function refreshPrivate() {
    try {
        const s = await priv("mexc", "GET");
        $("wState").textContent = "연결됨";
        const usdt = (s.sections.assets.rows || []).find(r => r.currency === "USDT");
        S.liveAvail = usdt && usdt.available > 0 ? usdt.available : 0;
        const unreal = (s.sections.positions.rows || []).reduce((sum, p) => sum + (Number(p.unrealized) || 0), 0);
        const eq = (usdt ? usdt.equity : 0) || 0;
        $("wUnreal").textContent = (unreal >= 0 ? "+" : "") + fmt.format(Math.round(unreal * 100) / 100) + " USDT";
        $("wUnreal").className = "mono " + (unreal >= 0 ? "p-pos" : "p-neg");
        $("wBal").textContent = fmt.format(eq) + " USDT";
        $("wEq").textContent = fmt.format(eq) + " USDT";
        $("wAvail").textContent = fmt.format(S.liveAvail) + " USDT";
        updateTicket();
        const tb = document.querySelector("#posT tbody");
        tb.innerHTML = (s.sections.positions.rows || []).map(p =>
            "<tr><td>" + esc(p.symbol) + "</td><td>" + esc(p.direction) + "</td><td>" + esc(p.contracts) +
            "</td><td class='mono'>" + fmt.format(p.entryPrice) + "</td><td>" + esc(p.leverage) + "X</td><td class='mono " +
            ((p.unrealized || 0) >= 0 ? "up" : "down") + "'>" + fmt.format(p.unrealized) + "</td><td></td></tr>").join("") ||
            "<tr><td colspan='7' class='dim'>실포지션 없음</td></tr>";
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
            // 자동 마진: 청산가 2% 접근 시 투입마진 20% 수혈 (5분 쿨다운, 잔고 한도)
            if (p.guard !== false) {
                const dist = p.side === 1 ? (px - p.liq) / px : (p.liq - px) / px;
                if (dist < 0.02 && Date.now() - (p.guardAt || 0) > 5 * 60 * 1000) {
                    const add = Math.round(p.margin * 0.2 * 100) / 100;
                    if (add <= S.bank && add > 0) {
                        S.bank = Math.round((S.bank - add) * 100) / 100;
                        p.margin = Math.round((p.margin + add) * 100) / 100;
                        p.added = Math.round(((p.added || 0) + add) * 100) / 100;
                        const ratio = p.margin / (p.price * p.vol * (p.cs || S.contractSize));
                        p.liq = p.side === 1 ? p.price * (1 - ratio + 0.005) : p.price * (1 + ratio - 0.005);
                        p.guardAt = Date.now();
                        savePaper(); renderPaper();
                        log("자동 마진 " + p.symbol + " $" + add);
                    }
                }
            }
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
        if (Date.now() - (S.scan.cool[item.symbol] || 0) < S.cfg.coolSec * 1000) return;
        const lev = Math.min(S.cfg.autoLev, 10); // 스캔 자동은 10X 상한
        const px = S.pxMap[item.symbol] || item.lastPrice;
        const vol = Math.floor((S.bank * (S.cfg.ratioPct / 100)) * lev / (px * item.contractSize));
        if (!(vol >= 1)) return;
        const long = r.entry.side === "LONG";
        const tpsl = autoTPSL(r.entry, px, long, item.priceScale);
        S.scan.cool[item.symbol] = Date.now();
        const ok = paperFill(long ? 1 : 3, px, vol, lev, true,
            { symbol: item.symbol, cs: item.contractSize, sl: tpsl.sl, tp: tpsl.tp });
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
    if (Date.now() - S.lastAuto < S.cfg.coolSec * 1000) return;
    const sig = await refreshAI();
    if (sig.dir === "관망" || !sig.entry) return;
    if (S.autoLive && !(S.armed && S.tradeEnabled)) { log("실매매 루프: 승인 없음 — 모의로 전환"); }
    const liveLoop = S.autoLive && S.armed && S.tradeEnabled;
    S.lastAuto = Date.now();
    const side = sig.dir === "LONG" ? 1 : 3;
    const tpsl = autoTPSL(sig.entry, S.last, sig.dir === "LONG", S.priceScale);
    $("oVol").value = "";
    await submitOrder(side, true, { sl: tpsl.sl, tp: tpsl.tp, lev: S.cfg.autoLev });
    log("AI " + sig.dir + " " + sig.reason + (liveLoop ? " [실매매]" : " [모의]"));
}

// ---- 심볼 목록 ----
async function loadSymbols() {
    const d = await pub("detail", {});
    if (!Array.isArray(d) || !d.length) throw new Error("심볼 목록 형식 오류");
    const list = d.filter(x => x && x.quoteCoin === "USDT" && x.state === 0)
        .sort((a, b) => ((b.symbol === "BTC_USDT") - (a.symbol === "BTC_USDT")) || String(a.symbol).localeCompare(String(b.symbol)));
    S.allSymbols = list;
    S.detailList = S.allSymbols;
    S.csMap = {};
    list.forEach(x => { if (x && x.symbol && Number(x.contractSize) > 0) S.csMap[x.symbol] = Number(x.contractSize); });
    renderSymbolSelect();
    $("symbol").value = S.allSymbols.some(x => x.symbol === S.symbol) ? S.symbol : (S.allSymbols[0] ? S.allSymbols[0].symbol : S.symbol);
    S.symbol = $("symbol").value;
    applyDetail(S.allSymbols.find(x => x.symbol === S.symbol));
    renderFavBtn();
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
        const z = e.target.closest("[data-zoom]");
        if (z) { chartZoom(z.dataset.zoom); return; }
        const l = e.target.closest("[data-layout]");
        if (l) { setLayout(Number(l.dataset.layout)); return; }
        const b = e.target.closest("[data-tf]"); if (!b) return;
        [...$("tfbar").querySelectorAll("[data-tf]")].forEach(x => x.classList.remove("act")); b.classList.add("act");
        S.tf = b.dataset.tf; loadChart().catch(e => log("차트 " + e.message, "down"));
        queueSaveUi();
    });
    $("symbol").addEventListener("change", () => selectSymbol($("symbol").value));
    $("symQ").addEventListener("input", renderSymbolSelect);
    $("symQ").addEventListener("keydown", e => {
        if (e.key === "Escape") { $("symResults").hidden = true; return; }
        if (e.key !== "Enter") return;
        const first = $("symResults").querySelector("[data-sym]");
        if (first) selectSymbol(first.dataset.sym);
    });
    $("symResults").addEventListener("mousedown", e => {
        const star = e.target.closest("[data-fav]");
        if (star) {
            e.preventDefault(); e.stopPropagation();
            const s = star.dataset.fav;
            S.fav = isFav(s) ? S.fav.filter(x => x !== s) : [...S.fav, s].slice(0, 50);
            if (!saveFav()) return;
            renderFavBtn(); renderSymbolSelect(); renderFavPanel();
            return;
        }
        const row = e.target.closest("[data-sym]");
        if (row) { e.preventDefault(); selectSymbol(row.dataset.sym); }
    });
    document.addEventListener("click", e => {
        if (!e.target.closest(".searchWrap")) $("symResults").hidden = true;
    });
    $("favBtn").addEventListener("click", () => {
        $("favPanel").classList.toggle("open");
        renderFavPanel();
    });
    $("favList").addEventListener("click", e => {
        const rm = e.target.closest("[data-rm]");
        if (rm) { S.fav = S.fav.filter(s => s !== rm.dataset.rm); saveFav(); renderFavBtn(); renderSymbolSelect(); renderFavPanel(); return; }
        if (e.target.closest("[data-add]")) {
            S.fav = isFav(S.symbol) ? S.fav.filter(s => s !== S.symbol) : [...S.fav, S.symbol].slice(0, 50);
            saveFav(); renderFavBtn(); renderSymbolSelect(); renderFavPanel(); return;
        }
        const row = e.target.closest("[data-sym]");
        if (row) { selectSymbol(row.dataset.sym); $("favPanel").classList.remove("open"); }
    });
    $("otype").addEventListener("click", e => {
        const b = e.target.closest("[data-t]"); if (!b) return;
        [...$("otype").children].forEach(x => x.classList.remove("act")); b.classList.add("act");
        document.querySelector(".hide-when-market").style.display = b.dataset.t === "5" ? "none" : "";
        updateTicket();
    });
    $("oTpsl").addEventListener("change", () => { $("tpslBox").hidden = !$("oTpsl").checked; });
    $("oUsdt").addEventListener("input", syncFromUsdt);
    $("oVol").addEventListener("input", syncFromVol);
    $("oMargin").addEventListener("input", syncFromMargin);
    $("oPrice").addEventListener("input", syncFromMargin);
    $("oPct").addEventListener("input", () => {
        $("oMargin").value = Math.round(ticketAvail() * (Number($("oPct").value) / 100) * 100) / 100;
        syncFromMargin();
    });
    $("lev").addEventListener("change", () => { syncFromMargin(); updateTicket(); });
    $("buy").addEventListener("click", () => submitOrder(1, false));
    $("sell").addEventListener("click", () => submitOrder(3, false));
    $("refresh").addEventListener("click", () => { refreshPrivate(); refreshTop().catch(() => {}); });
    $("refreshPaper").addEventListener("click", () => { try { sanitizePaper(); } catch {} renderPaper(); });
    $("mOk").addEventListener("click", () => { const cb = modalCb, v = $("mInput").value; closeModal(); if (cb) cb(v); });
    $("mCancel").addEventListener("click", closeModal);
    $("modalOv").addEventListener("click", e => { if (e.target === $("modalOv")) closeModal(); });
    $("themeBtn").addEventListener("click", () => {
        const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
        document.documentElement.dataset.theme = next;
        try { localStorage.setItem("krta-theme", next); } catch {}
        $("themeBtn").textContent = next === "light" ? "☾" : "☀";
        applyThemeToChart();
        queueSaveUi();
    });
    bindCfgMargin();
    $("cfgFold").addEventListener("click", e => { e.stopPropagation(); toggleCfg(); });
    $("cfgHead").addEventListener("click", toggleCfg);
function setMaxPos(v) {
    S.cfg.maxPos = Math.min(100, Math.max(1, Math.round(Number(v) || 5)));
    $("cfgMaxPos2").value = String(S.cfg.maxPos);
    saveCfg();
    log("최대 포지션 " + S.cfg.maxPos + "개");
}
function setCoolSec(v) {
    S.cfg.coolSec = Math.min(3600, Math.max(5, Math.round(Number(v) || 300)));
    $("cfgCool2").value = String(S.cfg.coolSec);
    saveCfg();
    log("재진입 쿨다운 " + S.cfg.coolSec + "초");
}
function setRatioPct(v) {
    S.cfg.ratioPct = Math.min(10, Math.max(0.01, Number(v) || 1));
    $("cfgMargin").value = S.cfg.ratioPct;
    saveCfg(); cfgPreview();
}
function bindCfgMargin() {
    $("cfgMargin").addEventListener("input", () => setRatioPct($("cfgMargin").value));
    $("cfgMarginUsdtIn").addEventListener("input", () => {
        const usdt = Number($("cfgMarginUsdtIn").value);
        if (usdt > 0 && S.bank > 0) setRatioPct(usdt / S.bank * 100);
    });
}
    $("cfgLev").addEventListener("change", () => {
        S.cfg.autoLev = [1, 2, 3, 5, 10].includes(Number($("cfgLev").value)) ? Number($("cfgLev").value) : 3;
        saveCfg();
        log("자동매매 레버리지 " + S.cfg.autoLev + "x");
    });
    document.querySelectorAll("input[name=tpMode]").forEach(r => r.addEventListener("change", () => {
        S.cfg.tpMode = document.querySelector("input[name=tpMode]:checked").value; saveCfg();
    }));
    document.querySelectorAll("input[name=slMode]").forEach(r => r.addEventListener("change", () => {
        S.cfg.slMode = document.querySelector("input[name=slMode]:checked").value; saveCfg();
    }));
    $("cfgTpPct").addEventListener("change", () => {
        if (Number($("cfgTpPct").value) > 0) S.cfg.tpPct = Math.min(500, Math.max(0.1, Number($("cfgTpPct").value)));
        saveCfg(); loadCfg();
    });
    $("cfgSlPct").addEventListener("change", () => {
        if (Number($("cfgSlPct").value) > 0) S.cfg.slPct = Math.min(100, Math.max(0.1, Number($("cfgSlPct").value)));
        saveCfg(); loadCfg();
    });
    $("cfgOverlap").addEventListener("change", () => {
        S.cfg.noOverlap = $("cfgOverlap").checked; saveCfg();
        log("중복 진입 방지 " + (S.cfg.noOverlap ? "ON" : "OFF"));
    });
    $("cfgMaxPos2").addEventListener("change", () => setMaxPos(Number($("cfgMaxPos2").value)));
    $("cfgCool2").addEventListener("change", () => setCoolSec(Number($("cfgCool2").value)));
    document.querySelectorAll("[data-step]").forEach(b => b.addEventListener("click", () => {
        const [k, d] = b.dataset.step.split(",");
        const step = Number(d);
        if (k === "maxPos") setMaxPos(S.cfg.maxPos + step);
        else if (k === "coolSec") setCoolSec(S.cfg.coolSec + step);
    }));
    $("paperReset").addEventListener("click", () => {
        S.paper = []; S.bank = 1000000; savePaper(); renderPaper();
        log("모의자금 리셋 — $1,000,000");
    });
    document.querySelector("#paperT").addEventListener("click", e => {
        const g = e.target.closest("[data-guard]");
        if (g) {
            const p = S.paper[Number(g.dataset.guard)];
            if (p) { p.guard = g.checked; savePaper(); log("자동 마진 " + (g.checked ? "ON" : "OFF") + " " + p.symbol); }
            return;
        }
        const posPx = p => S.pxMap[p.symbol] !== undefined ? S.pxMap[p.symbol] : (p.symbol === S.symbol ? S.last : p.price);
        const c = e.target.closest("[data-close]");
        if (c) {
            const idx = Number(c.dataset.close), p = S.paper[idx];
            if (!p) return;
            const px = posPx(p), pnl = paperUnreal(p, px);
            openModal("시장가 청산", esc(p.symbol) + " " + (p.side === 1 ? "롱" : "숏") + " " + p.vol + "계약<br>현재가 " +
                fmt.format(px) + " · 예상 손익 " + (pnl >= 0 ? "+" : "") + fmt.format(Math.round(pnl * 100) / 100),
                "청산 수량 (보유 " + p.vol + ")", p.vol, "청산", v => {
                    const qty = Number(v);
                    if (!(qty > 0)) { $("oMsg").textContent = "수량을 입력하세요."; return; }
                    if (qty >= p.vol) { settlePaper(idx, px, "수동"); return; }
                    const ratio = qty / p.vol;
                    const share = p.margin * ratio, pnlShare = pnl * ratio;
                    const feeOut = px * qty * (p.cs || S.contractSize) * 0.0004;
                    const credit = share + pnlShare - feeOut;
                    p.vol = Math.round((p.vol - qty) * 1e8) / 1e8;
                    p.margin = Math.round((p.margin - share) * 100) / 100;
                    S.bank = Math.round((S.bank + credit) * 100) / 100;
                    savePaper(); renderPaper();
                    log("모의 부분청산 " + p.symbol + " " + qty + "계약 손익 " + (pnlShare >= 0 ? "+" : "") + fmt.format(Math.round(pnlShare * 100) / 100));
                });
            return;
        }
        const rv = e.target.closest("[data-rev]");
        if (rv) {
            const idx = Number(rv.dataset.rev), p = S.paper[idx];
            if (!p) return;
            const px = posPx(p);
            const need = (px * p.vol * (p.cs || S.contractSize)) / p.lev;
            openModal("역방향 진입", esc(p.symbol) + " " + (p.side === 1 ? "롱→숏" : "숏→롱") + "<br>필요 증거금 약 $" +
                fmt.format(Math.round(need)) + " (가용 $" + fmt.format(Math.round(S.bank)) + ")",
                "역방향 수량 (보유 " + p.vol + ")", p.vol, "역방향 진입", v => {
                    const qty = Number(v);
                    if (!(qty > 0)) { $("oMsg").textContent = "수량을 입력하세요."; return; }
                    const opposite = p.side === 1 ? 3 : 1;
                    const cs = p.cs, lev = p.lev, sym = p.symbol;
                    settlePaper(idx, px, "역방향 전환");
                    if (!paperFill(opposite, px, qty, lev, p.auto,
                        { symbol: sym, cs, sl: null, tp: null })) log("역방향 진입 실패 — 증거금 부족", "down");
                    else log("역방향 진입 " + sym);
                });
            return;
        }
        const ad = e.target.closest("[data-add]");
        if (ad) {
            const p = S.paper[Number(ad.dataset.add)];
            if (!p) return;
            const def = Math.round(p.margin * 0.2 * 100) / 100;
            openModal("마진 추가", esc(p.symbol) + " 투입마진 $" + fmt.format(p.margin) + "<br>현재 청산가 " +
                fmt.format(p.liq) + " · 가용 $" + fmt.format(Math.round(S.bank)),
                "추가 금액 USDT (기본 20%)", def, "추가", v => {
                    const add = Math.round(Number(v) * 100) / 100;
                    if (!(add > 0)) { $("oMsg").textContent = "금액을 입력하세요."; return; }
                    if (add > S.bank) { log("마진 추가 거부 — 잔고 부족", "down"); return; }
                    S.bank = Math.round((S.bank - add) * 100) / 100;
                    p.margin = Math.round((p.margin + add) * 100) / 100;
                    p.added = Math.round(((p.added || 0) + add) * 100) / 100;
                    const ratio = p.margin / (p.price * p.vol * (p.cs || S.contractSize));
                    p.liq = p.side === 1 ? p.price * (1 - ratio + 0.005) : p.price * (1 + ratio - 0.005);
                    savePaper(); renderPaper();
                    log("마진 추가 " + p.symbol + " $" + add + " 새 청산가 " + fmt.format(Math.round(p.liq * 100) / 100));
                });
            return;
        }
    });
    document.querySelector("#ptabs").addEventListener("click", e => {
        const b = e.target.closest("[data-pt]"); if (!b) return;
        S.ptab = b.dataset.pt; renderPaper(); queueSaveUi();
    });
    $("autoPaper").addEventListener("click", () => {
        if (!isFav(S.symbol)) { $("aiMsg").textContent = "즐겨찾기 코인만 자동매매됩니다. ☆ 패널에서 추가하세요."; return; }
        S.autoPaper = !S.autoPaper;
        $("autoPaper").textContent = "자동매매(모의) " + (S.autoPaper ? "ON" : "OFF");
        $("autoPaper").classList.toggle("on", S.autoPaper);
        log("모의 자동매매 " + (S.autoPaper ? "시작" : "중지"));
        queueSaveUi();
    });
    $("autoLive").addEventListener("click", () => {
        if (!isFav(S.symbol)) { $("aiMsg").textContent = "즐겨찾기 코인만 자동매매됩니다. ☆ 패널에서 추가하세요."; return; }
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
                if (!S.fav.length) throw new Error("즐겨찾기가 비어 있습니다. ☆ 패널에서 코인을 추가하세요.");
                const n = Number($("scanN").value) || 10;
                const [tickers, details] = await Promise.all([pub("ticker", {}), pub("detail", {})]);
                const size = {};
                details.forEach(d => { if (d && d.symbol) size[d.symbol] = d; });
                const favSet = S.fav.slice(0, Math.min(30, n));
                S.scan.list = favSet.map(s => {
                    const t = tickers.find(x => x.symbol === s), d = size[s] || {};
                    return { symbol: s, contractSize: Number(d.contractSize) || S.contractSize,
                        priceScale: Number(d.priceScale) || 2, lastPrice: Number(t && t.lastPrice) || 0 };
                }).filter(x => x.contractSize > 0 && x.lastPrice > 0);
                if (!S.scan.list.length) throw new Error("즐겨찾기 시세를 가져오지 못했습니다.");
                S.scan.idx = 0;
                log("다종목 스캔 시작 — 즐겨찾기 " + S.scan.list.length + "개 (15초당 1종목)");
            } catch (e) { S.scan.on = false; $("scanToggle").textContent = "다종목 스캔 OFF"; log("스캔 실패 " + e.message, "down"); }
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

let booting = false;
async function boot() {
    if (booting) return;
    booting = true;
    $("net").textContent = "연결 중";
    try {
        await loadSymbols();
    } catch (e) {
        $("net").textContent = "심볼 로딩 실패 — 클릭 재시도";
        log("부팅 실패(symbol): " + e.message, "down");
        booting = false;
        return;
    }
    try { await loadChart(); }
    catch (e) { log("부팅 실패(chart): " + e.message, "down"); }
    try { sanitizePaper(); }
    catch (e) { log("부팅 실패(포지션 보정): " + e.message, "down"); }
    try { setLayout(S.layout); markFocusedPane(); }
    catch (e) { log("부팅 실패(서브차트): " + e.message, "down"); }
    await refreshTop().catch(() => {});
    if (!S.last) $("net").textContent = "시세 실패 — 클릭 재시도";
    else $("net").textContent = "실시간";
    await refreshBook().catch(() => {});
    renderPaper();
    await refreshPrivate();
    booting = false;
}
(async function init() {
    // file:// 로컬 파일로 열면 서버 API가 없어 전부 실패한다. 안내 후 중단한다.
    if (location.protocol === "file:") {
        document.body.insertAdjacentHTML("afterbegin",
            "<div style='background:#7f1d1d;color:#fff;padding:12px 16px;font-size:14px'>로컬 파일로는 동작하지 않습니다. " +
            "https://upbit-analyzer.vercel.app/terminal.html 로 접속하세요. 폴더 안 파일을 더블클릭하면 안 됩니다.</div>");
        return;
    }
    try { S.paper = JSON.parse(localStorage.getItem("krta-paper") || "[]");
        S.bank = Number((JSON.parse(localStorage.getItem("krta-bank") || "{}")).bank) || 1000000;
        S.hist = JSON.parse(localStorage.getItem("krta-hist") || "[]") || [];
    } catch { S.paper = []; S.bank = 1000000; S.hist = []; }
    loadCfg();
    loadFav();
    loadUi();
    loadTheme();
    bind();
    document.addEventListener("input", queueSaveUi);
    document.addEventListener("change", queueSaveUi);
    window.addEventListener("beforeunload", saveUi);
    $("net").style.cursor = "pointer";
    $("net").title = "클릭하면 다시 연결합니다";
    $("net").addEventListener("click", boot);
    await boot();
    S.timer.push(setInterval(() => refreshTop().catch(() => {}), 3000));
    S.timer.push(setInterval(() => refreshBook().catch(() => {}), 3000));
    S.timer.push(setInterval(refreshPaperPrices, 5000));
    S.timer.push(setInterval(autoTick, 10000));
    S.timer.push(setInterval(scanTick, 15000));
    S.timer.push(setInterval(refreshAllCharts, 60000));
    log("터미널 시작 — 기본 모의. 실매매는 승인 후에만 동작합니다.");
    if (S.autoPaper) log("이전 설정 복원: 모의 자동매매가 켜진 상태로 재개됩니다.");
})();
})();
