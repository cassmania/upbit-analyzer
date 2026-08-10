/**
 * app.js — 업비트 데이터 조달 + 실시간 차트 + 렌더
 *
 * 지표 계산은 ta_engine.js(스킬 이식), 겹침 판정은 level_analyzer.js가 맡는다.
 * 이 파일은 API/WebSocket 조달과 화면 그리기만 한다.
 */
(function () {
    "use strict";

    // 업비트 REST는 전 엔드포인트에 CORS 헤더를 주지 않는다. 브라우저에서 직접 부르면
    // 무조건 막히므로 같은 도메인의 서버리스 함수(/api/upbit)를 거친다.
    // localhost에는 그 함수가 없으니 직접 호출로 떨어뜨린다.
    // (WebSocket은 CORS 대상이 아니라 어디서든 직접 연결된다.)
    var DIRECT = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

    function upbitUrl(path, params) {
        var sp = new URLSearchParams();
        if (!DIRECT) sp.set("path", path);
        Object.keys(params || {}).forEach(function (k) {
            if (params[k] !== undefined && params[k] !== null) sp.set(k, params[k]);
        });
        return DIRECT
            ? "https://api.upbit.com/v1/" + path + "?" + sp.toString()
            : "/api/upbit?" + sp.toString();
    }

    var TFS = [
        { key: "1h", label: "1시간", path: "candles/minutes/60", sec: 3600 },
        { key: "4h", label: "4시간", path: "candles/minutes/240", sec: 14400 },
        { key: "12h", label: "12시간", path: null, sec: 43200 },   // 4h×3 합성
        { key: "1d", label: "일봉", path: "candles/days", sec: 86400 }
    ];

    var state = {
        markets: [], sel: "KRW-BTC", chartTf: "4h",
        timer: null, busy: false,
        ws: null, wsAlive: false,
        tfCandles: null, levels: null, dp: 0, lastPrice: 0,
        usdPrice: null, usdtKrw: null, bankFx: null,  // 바이낸스 시세 / 김프 기준 환율 / 은행 환율
        renderedFor: null   // 전체 렌더가 끝난 종목. 같으면 부분 갱신만 한다
    };

    var chart = null, candleSeries = null, volumeSeries = null, priceLines = [];

    var $ = function (id) { return document.getElementById(id); };

    // ---------------------------------------------------------------- 유틸

    function decimals(v) {
        var a = Math.abs(v);
        if (a >= 1000) return 0;
        if (a >= 100) return 1;
        if (a >= 1) return 2;
        if (a >= 0.01) return 4;
        return 8;
    }
    function fmt(v, dp) {
        if (v === null || v === undefined || !isFinite(v)) return "—";
        if (dp === undefined) dp = decimals(v);
        return Number(v).toLocaleString("ko-KR", { minimumFractionDigits: dp, maximumFractionDigits: dp });
    }
    /** USDT 가격 자릿수. 원화와 스케일이 달라 따로 잡는다. */
    function usdDecimals(v) {
        var a = Math.abs(v);
        if (a >= 1000) return 2;
        if (a >= 1) return 3;
        if (a >= 0.01) return 5;
        return 8;
    }
    function fmtUsd(v) {
        if (v === null || v === undefined || !isFinite(v)) return "—";
        var d = usdDecimals(v);
        return "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
    }

    function pct(v) {
        if (v === null || v === undefined || !isFinite(v)) return "—";
        return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
    }
    function cls(v) { return v > 0 ? "up" : v < 0 ? "down" : "neu"; }
    function esc(s) {
        return String(s).replace(/[&<>"]/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
        });
    }
    function getJSON(url) {
        return fetch(url).then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.json();
        });
    }

    // ---------------------------------------------------------------- 데이터

    function loadMarkets() {
        return getJSON(upbitUrl("market/all", { isDetails: false })).then(function (all) {
            state.markets = all.filter(function (m) { return m.market.indexOf("KRW-") === 0; })
                .sort(function (a, b) { return a.korean_name.localeCompare(b.korean_name, "ko"); });
            renderMarketSelect("");
        });
    }

    function renderMarketSelect(filter) {
        var sel = $("market");
        var f = (filter || "").trim().toLowerCase();
        var list = state.markets.filter(function (m) {
            if (!f) return true;
            return m.market.toLowerCase().indexOf(f) !== -1
                || m.korean_name.toLowerCase().indexOf(f) !== -1
                || (m.english_name || "").toLowerCase().indexOf(f) !== -1;
        });
        sel.innerHTML = list.map(function (m) {
            return '<option value="' + m.market + '">' + esc(m.korean_name)
                + " (" + m.market.replace("KRW-", "") + ")</option>";
        }).join("");
        if (list.some(function (m) { return m.market === state.sel; })) sel.value = state.sel;
        else if (list.length) state.sel = sel.value = list[0].market;
    }

    /** 업비트 캔들 -> 엔진 형식. 응답은 최신순이라 뒤집는다. time은 차트용 UNIX초. */
    function toCandles(raw) {
        return raw.slice().reverse().map(function (k) {
            return {
                time: Math.floor(k.timestamp / 1000),
                kst: k.candle_date_time_kst,
                o: k.opening_price, h: k.high_price, l: k.low_price,
                c: k.trade_price, v: k.candle_acc_trade_volume
            };
        });
    }

    /** 업비트에 12시간봉이 없다. 4시간봉 3개를 묶어 합성한다. */
    function groupCandles(src, n) {
        var out = [];
        for (var i = 0; i + n <= src.length; i += n) {
            var win = src.slice(i, i + n);
            var hi = -Infinity, lo = Infinity, vol = 0;
            for (var j = 0; j < win.length; j++) {
                if (win[j].h > hi) hi = win[j].h;
                if (win[j].l < lo) lo = win[j].l;
                vol += win[j].v;
            }
            out.push({
                time: win[0].time, kst: win[0].kst,
                o: win[0].o, h: hi, l: lo, c: win[win.length - 1].c, v: vol
            });
        }
        return out;
    }

    function fetchAll(market) {
        return Promise.all([
            getJSON(upbitUrl("ticker", { markets: market })),
            getJSON(upbitUrl("candles/minutes/60", { market: market, count: 200 })).then(toCandles),
            getJSON(upbitUrl("candles/minutes/240", { market: market, count: 200 })).then(toCandles),
            getJSON(upbitUrl("candles/days", { market: market, count: 200 })).then(toCandles)
        ]).then(function (r) {
            return {
                ticker: r[0][0],
                tf: { "1h": r[1], "4h": r[2], "12h": groupCandles(r[2], 3), "1d": r[3] }
            };
        });
    }

    /**
     * 바이낸스 선물 보조. 업비트에는 펀딩비·미결제약정이 없다.
     *
     * 미상장 종목은 바이낸스가 400을 준다. 이건 정상 경로라 null로 삼켜
     * "데이터 없음"을 표시한다. 브라우저 콘솔에 400이 찍히는 건 막을 수 없다
     * (fetch가 상태코드를 받기 전에 네트워크 계층이 먼저 로그를 남긴다).
     */
    function fetchFutures(symbol) {
        var s = symbol + "USDT";
        var b = "https://fapi.binance.com/fapi/v1";
        var g = function (u) {
            return fetch(u).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
        };
        // 김프는 현물 기준이 표준이라 현물가도 같이 받는다. 선물가는 펀딩·OI 맥락용.
        var spot = fetch("https://api.binance.com/api/v3/ticker/price?symbol=" + s)
            .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
        return Promise.all([g(b + "/premiumIndex?symbol=" + s), g(b + "/openInterest?symbol=" + s), g(b + "/ticker/price?symbol=" + s), spot])
            .then(function (r) {
                if (!r[0] && !r[1] && !r[3]) return null;
                return {
                    funding: r[0] && r[0].lastFundingRate !== undefined ? parseFloat(r[0].lastFundingRate) * 100 : null,
                    oi: r[1] && r[1].openInterest ? parseFloat(r[1].openInterest) : null,
                    usdPrice: r[2] && r[2].price ? parseFloat(r[2].price) : null,
                    spotPrice: r[3] && r[3].price ? parseFloat(r[3].price) : null
                };
            }).catch(function () { return null; });
    }

    /**
     * 김치 프리미엄 기준 환율.
     *
     * 김프가·코인게코 등 표준 계산은 은행 환율이 아니라 **업비트 USDT 시세**를 쓴다.
     * 김프의 정의가 "달러로 환산했을 때의 차이"가 아니라
     * "USDT로 사서 국내로 옮겼을 때의 차이"이기 때문이다 — 실제 차익거래 경로와 맞다.
     *
     * 은행 환율을 쓰면 USDT 자체의 프리미엄(보통 -0.8% 안팎)이 통째로 빠져
     * 다른 사이트와 수치가 어긋난다.
     */
    function fetchUsdtKrw() {
        return getJSON(upbitUrl("ticker", { markets: "KRW-USDT" }))
            .then(function (d) { return d && d[0] ? d[0].trade_price : null; })
            .catch(function () { return null; });
    }

    /** 참고 표시용 은행 환율. 김프 계산에는 쓰지 않는다. */
    function fetchBankFx() {
        return fetch("https://open.er-api.com/v6/latest/USD")
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) { return d && d.rates && d.rates.KRW ? d.rates.KRW : null; })
            .catch(function () { return null; });
    }

    // ---------------------------------------------------------------- 실시간 WebSocket

    /**
     * 업비트 WebSocket은 CORS 대상이 아니라 브라우저에서 직접 붙는다.
     * REST 프록시와 달리 우회가 필요 없다.
     */
    function connectWS(market) {
        closeWS();
        var ws;
        try { ws = new WebSocket("wss://api.upbit.com/websocket/v1"); }
        catch (e) { setWsState(false, "연결 실패"); return; }
        ws.binaryType = "arraybuffer";
        state.ws = ws;

        ws.onopen = function () {
            setWsState(true, "실시간");
            ws.send(JSON.stringify([
                { ticket: "upbit-ta-" + market },
                { type: "ticker", codes: [market] },
                { format: "DEFAULT" }
            ]));
        };
        ws.onmessage = function (ev) {
            var d;
            try { d = JSON.parse(new TextDecoder("utf-8").decode(ev.data)); }
            catch (e) { return; }
            if (!d || d.code !== state.sel) return;   // 종목 전환 직후 이전 소켓 잔여 메시지 차단
            onTick(d);
        };
        ws.onclose = function () { setWsState(false, "연결 끊김"); };
        ws.onerror = function () { setWsState(false, "연결 오류"); };
    }

    function closeWS() {
        if (state.ws) {
            try { state.ws.onclose = null; state.ws.close(); } catch (e) {}
            state.ws = null;
        }
        setWsState(false, "연결 대기");
    }

    function setWsState(on, txt) {
        state.wsAlive = on;
        var d = $("wsdot"), t = $("wstxt");
        if (d) d.className = "dot" + (on ? " on" : "");
        if (t) t.textContent = txt;
    }

    /** 체결이 올 때마다 마지막 캔들과 헤더 시세를 갱신한다. 재분석은 하지 않는다. */
    function onTick(d) {
        var price = d.trade_price;
        state.lastPrice = price;

        var el = $("q-price");
        if (el) {
            var chg = d.signed_change_rate * 100;
            el.innerHTML = '<span class="' + cls(chg) + '">' + fmt(price, state.dp) + "</span>";
        }
        var ch = $("q-change");
        if (ch) {
            var c2 = d.signed_change_rate * 100;
            ch.innerHTML = '<span class="' + cls(c2) + '">' + pct(c2) + "</span>";
        }
        // 원화가 움직이면 환율로 환산한 달러값도 같이 갱신한다.
        // 바이낸스 USDT 시세 자체는 여기서 갱신하지 않는다(별도 소스라 30초 주기 재조회 몫).
        var us = $("q-usdsub");
        if (us && state.usdtKrw) {
            us.textContent = fmtUsd(price / state.usdtKrw) + " · USDT 환산";
        }

        if (!candleSeries || !state.tfCandles) return;
        var arr = state.tfCandles[state.chartTf];
        if (!arr || !arr.length) return;

        var tf = TFS.filter(function (x) { return x.key === state.chartTf; })[0];
        var last = arr[arr.length - 1];
        var now = Math.floor(Date.now() / 1000);

        if (now - last.time >= tf.sec) {
            // 새 봉 시작. 다음 갱신 때 REST로 정확한 값을 받으니 여기서는 임시로만 만든다.
            var nt = last.time + tf.sec;
            var nc = { time: nt, o: price, h: price, l: price, c: price, v: 0 };
            arr.push(nc);
            candleSeries.update({ time: nt, open: price, high: price, low: price, close: price });
        } else {
            last.c = price;
            if (price > last.h) last.h = price;
            if (price < last.l) last.l = price;
            candleSeries.update({ time: last.time, open: last.o, high: last.h, low: last.l, close: last.c });
        }
        updateLegend(arr[arr.length - 1]);
    }

    // ---------------------------------------------------------------- 차트

    /**
     * 차트에 데이터만 밀어넣는다. 차트를 파괴하지 않으므로 깜빡이지 않는다.
     * 자동갱신은 전부 이 경로를 탄다.
     */
    function updateChartData(candles, levels, dp) {
        if (!chart || !candleSeries) return false;
        candleSeries.setData(candles.map(function (c) {
            return { time: c.time, open: c.o, high: c.h, low: c.l, close: c.c };
        }));
        if (volumeSeries) {
            volumeSeries.setData(candles.map(function (c) {
                return { time: c.time, value: c.v, color: c.c >= c.o ? "rgba(14,203,129,.34)" : "rgba(246,70,93,.34)" };
            }));
        }
        drawLevelLines(levels, dp);
        updateLegend(candles[candles.length - 1]);
        return true;   // 보고 있던 확대/스크롤 위치는 건드리지 않는다
    }

    function buildChart(candles, levels, dp) {
        var host = $("chart");
        if (!host || !window.LightweightCharts) return;

        if (chart) { try { chart.remove(); } catch (e) {} chart = null; }
        priceLines = [];

        var css = getComputedStyle(document.documentElement);
        var C = function (n, f) { return (css.getPropertyValue(n) || "").trim() || f; };

        chart = LightweightCharts.createChart(host, {
            // 명시하지 않으면 300x150 기본값으로 그려진다. 컨테이너를 채우게 잡아준다.
            width: host.clientWidth,
            height: host.clientHeight,
            autoSize: true,
            layout: {
                background: { type: "solid", color: C("--surface-lowest", "#060e20") },
                textColor: C("--on-variant", "#9aa3bd"),
                fontFamily: "Inter, sans-serif", fontSize: 11
            },
            grid: {
                vertLines: { color: "rgba(42,51,80,.45)" },
                horzLines: { color: "rgba(42,51,80,.45)" }
            },
            rightPriceScale: { borderColor: C("--outline", "#2a3350"), scaleMargins: { top: .08, bottom: .26 } },
            timeScale: { borderColor: C("--outline", "#2a3350"), timeVisible: true, secondsVisible: false },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Normal,
                vertLine: { color: "rgba(154,163,189,.4)", width: 1, style: 3, labelBackgroundColor: C("--surface-high", "#222a3d") },
                horzLine: { color: "rgba(154,163,189,.4)", width: 1, style: 3, labelBackgroundColor: C("--surface-high", "#222a3d") }
            },
            localization: {
                locale: "ko-KR",
                priceFormatter: function (p) { return fmt(p, dp); }
            }
        });

        candleSeries = chart.addCandlestickSeries({
            upColor: C("--up", "#0ecb81"), downColor: C("--down", "#f6465d"),
            borderUpColor: C("--up", "#0ecb81"), borderDownColor: C("--down", "#f6465d"),
            wickUpColor: C("--up", "#0ecb81"), wickDownColor: C("--down", "#f6465d"),
            priceFormat: { type: "price", precision: dp, minMove: Math.pow(10, -dp) }
        });
        candleSeries.setData(candles.map(function (c) {
            return { time: c.time, open: c.o, high: c.h, low: c.l, close: c.c };
        }));

        volumeSeries = chart.addHistogramSeries({
            priceFormat: { type: "volume" },
            priceScaleId: "vol",
            color: "rgba(99,102,241,.4)"
        });
        chart.priceScale("vol").applyOptions({ scaleMargins: { top: .82, bottom: 0 } });
        volumeSeries.setData(candles.map(function (c) {
            return { time: c.time, value: c.v, color: c.c >= c.o ? "rgba(14,203,129,.34)" : "rgba(246,70,93,.34)" };
        }));

        drawLevelLines(levels, dp);
        chart.timeScale().fitContent();
        updateLegend(candles[candles.length - 1]);

        // 크로스헤어로 짚은 봉 값을 범례에 띄운다
        chart.subscribeCrosshairMove(function (p) {
            if (!p || !p.time || !p.seriesData) { updateLegend(candles[candles.length - 1]); return; }
            var d = p.seriesData.get(candleSeries);
            if (d) updateLegend({ o: d.open, h: d.high, l: d.low, c: d.close, time: p.time });
        });
    }

    /**
     * 겹침 강도 기반 레벨선. claude_chart의 createPriceLine 방식을 따르되,
     * 피벗 공식(마지막 봉 1개) 대신 level_analyzer의 다중 봉 겹침 결과를 쓴다.
     * 4중 겹침일수록 굵고 진하게 — 벽의 두께를 선 두께로 보여준다.
     */
    function drawLevelLines(lv, dp) {
        if (!candleSeries || !lv || lv.error) return;
        priceLines.forEach(function (l) { try { candleSeries.removePriceLine(l); } catch (e) {} });
        priceLines = [];

        function add(price, rank, label, kind) {
            var isRes = kind === "res";
            var base = isRes ? "246,70,93" : kind === "sup" ? "14,203,129" : "224,180,74";
            var alpha = rank >= 4 ? .92 : rank === 3 ? .74 : rank === 2 ? .56 : .34;
            var width = rank >= 4 ? 2 : rank === 3 ? 2 : 1;
            try {
                priceLines.push(candleSeries.createPriceLine({
                    price: price,
                    color: "rgba(" + base + "," + alpha + ")",
                    lineWidth: width,
                    lineStyle: rank >= 3 ? 0 : 2,      // 3중 이상 실선, 그 아래 파선
                    axisLabelVisible: true,
                    title: label
                }));
            } catch (e) {}
        }

        (lv.resistance || []).slice(0, 5).forEach(function (x) {
            add(x.price, x.strength.rank, x.tfCount >= 2 ? "저항 " + x.tfCount + "봉" : "저항", "res");
        });
        (lv.support || []).slice(0, 5).forEach(function (x) {
            add(x.price, x.strength.rank, x.tfCount >= 2 ? "지지 " + x.tfCount + "봉" : "지지", "sup");
        });
        if (lv.마지노선) add(lv.마지노선.price, 4, "마지노선 " + lv.마지노선.tf, "floor");
    }

    function updateLegend(c) {
        var el = $("legend");
        if (!el || !c) return;
        var dp = state.dp;
        var up = c.c >= c.o;
        var col = up ? "var(--up)" : "var(--down)";
        el.innerHTML =
            '<div class="lg-row"><span>시가</span><b>' + fmt(c.o, dp) + "</b></div>"
            + '<div class="lg-row"><span>고가</span><b>' + fmt(c.h, dp) + "</b></div>"
            + '<div class="lg-row"><span>저가</span><b>' + fmt(c.l, dp) + "</b></div>"
            + '<div class="lg-row"><span>종가</span><b style="color:' + col + '">' + fmt(c.c, dp) + "</b></div>";
    }

    function resizeChart() {
        if (!chart) return;
        var host = $("chart");
        if (host) chart.applyOptions({ width: host.clientWidth, height: host.clientHeight });
    }

    // ---------------------------------------------------------------- 렌더

    function render(market, data, fut, usdtKrw, bankFx) {
        var t = data.ticker;
        var price = t.trade_price;
        var dp = decimals(price);
        state.dp = dp;
        state.tfCandles = data.tf;
        state.lastPrice = price;
        state.usdPrice = fut && fut.usdPrice ? fut.usdPrice : null;
        state.usdtKrw = usdtKrw || null;     // 김프 기준 환율 (업비트 USDT)
        state.bankFx = bankFx || null;       // 참고용 은행 환율

        var name = (state.markets.filter(function (m) { return m.market === market; })[0] || {}).korean_name || market;
        var sym = market.replace("KRW-", "");

        // 지표 계산
        var results = {};
        TFS.forEach(function (tf) {
            var c = data.tf[tf.key];
            results[tf.key] = (c && c.length >= 30)
                ? TAEngine.analyzeTf(c.map(function (x) { return { o: x.o, h: x.h, l: x.l, c: x.c, v: x.v }; }))
                : { error: "캔들 부족 (" + (c ? c.length : 0) + "봉)" };
        });

        // 겹침 레벨
        var conv = {};
        Object.keys(data.tf).forEach(function (k) {
            var c = data.tf[k];
            if (c && c.length >= 20) {
                conv[k] = c.map(function (x) { return { high: x.h, low: x.l, close: x.c, volume: x.v }; });
            }
        });
        var lv = LevelEngine.analyze(conv, price, { limit: 7 });
        state.levels = lv;

        // 같은 종목·같은 봉을 다시 그릴 때는 DOM을 통째로 갈아끼우지 않는다.
        // innerHTML 교체 + 차트 재생성이 자동갱신마다 화면을 깜빡이게 만든다.
        var sameView = state.renderedFor === market && $("chart") && chart;

        if (sameView) {
            // 시세 스트립과 분석 표만 내용 교체. 차트는 데이터만 밀어넣는다.
            replaceSection("sec-quotes", renderQuotes(t, price, dp, name, sym, fut, usdtKrw, bankFx));
            replaceSection("sec-summary", renderSummary(results));
            replaceSection("sec-levels", renderLevels(lv, dp));
            replaceSection("sec-detail", renderDetail(results, dp));
            replaceSection("sec-scenario", renderScenario(lv, dp));
            if (!updateChartData(data.tf[state.chartTf], lv, dp)) {
                buildChart(data.tf[state.chartTf], lv, dp);
            }
        } else {
            var html = [];
            html.push('<div id="sec-quotes">' + renderQuotes(t, price, dp, name, sym, fut, usdtKrw, bankFx) + "</div>");
            html.push(renderChartSection(sym));
            html.push('<div id="sec-summary">' + renderSummary(results) + "</div>");
            html.push('<div id="sec-levels">' + renderLevels(lv, dp) + "</div>");
            html.push('<div id="sec-detail">' + renderDetail(results, dp) + "</div>");
            html.push('<div id="sec-scenario">' + renderScenario(lv, dp) + "</div>");
            $("out").innerHTML = html.join("");
            buildChart(data.tf[state.chartTf], lv, dp);
            state.renderedFor = market;
        }
        $("updatedAt") && ($("updatedAt").textContent = new Date().toLocaleTimeString("ko-KR"));

        window.분석결과 = { market: market, results: results, ticker: t, futures: fut };
        window.레벨결과 = lv;
    }

    /** 컨테이너 안쪽만 갈아끼운다. 컨테이너 자체는 유지돼 레이아웃이 흔들리지 않는다. */
    function replaceSection(id, html) {
        var el = $(id);
        if (el) el.innerHTML = html;
    }

    function qb(k, v, s) {
        return '<div class="qb"><div class="qk">' + k + '</div><div class="qv" '
            + (k.indexOf("현재가") === 0 ? 'id="q-price"' : k.indexOf("24시간 변동") === 0 ? 'id="q-change"' : "")
            + ">" + v + '</div><div class="qs">' + (s || "") + "</div></div>";
    }

    function renderQuotes(t, price, dp, name, sym, fut, usdtKrw, bankFx) {
        var chg = t.signed_change_rate * 100;
        var out = ['<div class="quotes">'];
        var usdSub = usdtKrw ? fmtUsd(price / usdtKrw) + " · USDT 환산" : "₩ · " + esc(name) + " (" + sym + ")";
        out.push(qb("현재가", '<span class="' + cls(chg) + '">' + fmt(price, dp) + "</span>",
            '<span id="q-usdsub">' + usdSub + "</span>"));
        out.push(qb("24시간 변동", '<span class="' + cls(chg) + '">' + pct(chg) + "</span>",
            "고 " + fmt(t.high_price, dp) + " / 저 " + fmt(t.low_price, dp)));
        out.push(qb("24시간 거래대금", (t.acc_trade_price_24h / 1e8).toFixed(1) + '<span style="font-size:13px;font-weight:600"> 억</span>',
            "체결량 " + fmt(t.acc_trade_volume_24h, 2)));
        if (fut) {
            out.push(qb("펀딩비 <span class='dim'>· 바이낸스</span>",
                fut.funding === null ? "—" : '<span class="' + (fut.funding >= 0 ? "up" : "down") + '">' + fut.funding.toFixed(4) + "%</span>",
                fut.funding === null ? "데이터 없음" : (fut.funding >= 0 ? "롱 우위" : "숏 과열 — 숏스퀴즈 조건")));
            out.push(qb("미결제약정 <span class='dim'>· 바이낸스</span>",
                fut.oi === null ? "—" : fmt(fut.oi, 0), fut.oi === null ? "데이터 없음" : sym + " 계약"));
            // 김프 표준은 현물가 기준이다. 현물이 없으면 선물로 대체하고 그 사실을 표기한다.
            var refUsd = fut.spotPrice || fut.usdPrice;
            var isSpot = !!fut.spotPrice;
            if (refUsd) {
                out.push(qb("USDT 가격 <span class='dim'>· 바이낸스" + (isSpot ? " 현물" : " 선물") + "</span>",
                    '<span id="q-usd">' + fmtUsd(refUsd) + "</span>",
                    usdtKrw ? "환산 " + fmt(refUsd * usdtKrw, dp) + "원" : "환율 데이터 없음"));
            }
            if (refUsd && usdtKrw) {
                var kp = (price / (refUsd * usdtKrw) - 1) * 100;
                out.push(qb("김치 프리미엄", '<span class="' + cls(kp) + '">' + pct(kp) + "</span>",
                    "USDT " + fmt(usdtKrw, 1) + "원 기준"
                    + (bankFx ? " · 은행 " + fmt(bankFx, 1) + "원" : "")));
            }
        } else {
            out.push(qb("펀딩비 · 미결제약정", '<span class="dim" style="font-size:17px">데이터 없음</span>', "바이낸스 USDT-M 미상장"));
        }
        out.push("</div>");
        return out.join("");
    }

    function renderChartSection(sym) {
        var lbl = (TFS.filter(function (x) { return x.key === state.chartTf; })[0] || {}).label || "";
        return '<section id="chart-sec"><div class="sec-head"><h2>' + esc(sym) + " " + lbl + ' 차트</h2>'
            + '<span class="tag">실시간 체결 반영</span>'
            + '<span class="tag" id="updatedAt">—</span></div>'
            + '<div class="card"><div class="chart-shell">'
            + '<div id="chart"></div><div class="chart-legend" id="legend"></div>'
            + "</div>"
            + '<div class="chart-note">'
            + '<span class="swatch"><i class="sw" style="background:rgba(246,70,93,.9)"></i> 저항</span>'
            + '<span class="swatch"><i class="sw" style="background:rgba(14,203,129,.9)"></i> 지지</span>'
            + '<span class="swatch"><i class="sw" style="background:rgba(224,180,74,.9)"></i> 마지노선</span>'
            + '<span class="dim">실선 = 3개 봉 이상이 지목 · 파선 = 1~2개. 선이 굵을수록 두꺼운 벽</span>'
            + "</div></div></section>";
    }

    function renderSummary(results) {
        var rows = TFS.map(function (tf) {
            var r = results[tf.key];
            if (r.error) return "<tr><td><b>" + tf.label + '</b></td><td colspan="5" class="dim">' + esc(r.error) + "</td></tr>";
            var cf = r.confluence;
            var netCls = cf.net_pct >= 40 ? "up" : cf.net_pct <= -40 ? "down" : "neu";
            var bCls = r.trend.bias === "강세" ? "up" : r.trend.bias === "약세" ? "down" : "neu";
            var rsi = r.oscillators.rsi14;
            var rCls = rsi >= 70 ? "down" : rsi <= 30 ? "up" : "";
            var st = r.trend.supertrend;
            return "<tr><td><b>" + tf.label + "</b></td>"
                + '<td class="' + bCls + '"><b>' + r.trend.bias + '</b> <span class="dim">(' + r.trend.score + ")</span></td>"
                + '<td class="num ' + netCls + '"><b>' + cf.net_pct + '%</b><div class="reason">' + cf.verdict + "</div></td>"
                + '<td class="num ' + rCls + '">' + (rsi === null ? "—" : rsi) + "</td>"
                + "<td>" + (st ? '<span class="' + (st.trend === "상승" ? "up" : "down") + '">' + st.trend + "</span>" : "—") + "</td>"
                + "<td>" + r.trend.signals.map(function (s) { return '<span class="sig">' + esc(s) + "</span>"; }).join("")
                + (r.candle_pattern ? "<br>" + r.candle_pattern.map(function (p) { return '<span class="sig" style="color:var(--warn)">' + esc(p) + "</span>"; }).join("") : "")
                + "</td></tr>";
        }).join("");
        return '<section><div class="sec-head"><h2>시간봉별 방향</h2>'
            + '<span class="tag">여러 봉이 같은 방향이면 신뢰도 상승</span></div>'
            + '<div class="card"><div class="scroll"><table><thead><tr>'
            + "<th>봉</th><th>추세</th><th>수렴(net%)</th><th>RSI</th><th>슈퍼트렌드</th><th>근거</th>"
            + "</tr></thead><tbody>" + rows + "</tbody></table></div></div></section>";
    }

    function renderLevels(lv, dp) {
        if (lv.error) {
            return '<section><div class="sec-head"><h2>지지 · 저항</h2></div><div class="err">' + esc(lv.error) + "</div></section>";
        }
        function rows(list, color) {
            if (!list.length) return '<tr><td colspan="3" class="neu">해당 방향에 벽이 없습니다 (공백 구간)</td></tr>';
            return list.map(function (x) {
                return "<tr>"
                    + '<td class="num ' + color + '"><b>' + fmt(x.price, dp) + "</b></td>"
                    + '<td class="num dim">' + (x.거리pct >= 0 ? "+" : "") + x.거리pct.toFixed(2) + "%</td>"
                    + '<td><span class="pill p' + x.strength.rank + '">' + esc(x.strength.label) + "</span>"
                    + '<div class="reason">' + esc(x.reason) + "</div></td></tr>";
            }).join("");
        }
        var warn = lv.경고.length
            ? '<div class="warn">' + lv.경고.map(function (w) { return "⚠ " + esc(w); }).join("<br>") + "</div>" : "";
        var floor = lv.마지노선
            ? "<b>" + fmt(lv.마지노선.price, dp) + '</b> <span class="dim">(' + lv.마지노선.tf + " 최저 · "
              + ((state.lastPrice - lv.마지노선.price) / state.lastPrice * 100).toFixed(1) + "% 아래)</span>" : "—";

        return '<section><div class="sec-head"><h2>지지 · 저항</h2>'
            + '<span class="tag">같은 가격을 지목한 봉이 많을수록 두꺼운 벽</span></div>'
            + '<div class="grid2">'
            + '<div class="card"><div class="scroll"><table><thead><tr><th>저항 (위로)</th><th>거리</th><th>강도 / 근거</th></tr></thead>'
            + "<tbody>" + rows(lv.resistance, "down") + "</tbody></table></div></div>"
            + '<div class="card"><div class="scroll"><table><thead><tr><th>지지 (아래)</th><th>거리</th><th>강도 / 근거</th></tr></thead>'
            + "<tbody>" + rows(lv.support, "up") + "</tbody></table></div></div>"
            + "</div>"
            + '<div class="card card-pad" style="margin-top:14px;font-size:13px">'
            + "마지노선 " + floor
            + ' <span class="dim">· 계산 봉 ' + lv.사용봉.map(function (u) { return u.tf + "(" + u.bars + ")"; }).join(" ") + "</span>"
            + warn + "</div></section>";
    }

    function renderDetail(results, dp) {
        var blocks = TFS.map(function (tf) {
            var r = results[tf.key];
            if (r.error) return "";
            var o = r.oscillators, bb = r.bollinger, v = r.volume;
            var L = [];
            function row(k, val) { return '<tr><td class="dim">' + k + '</td><td class="num mono">' + val + "</td></tr>"; }
            L.push(row("RSI(14)", o.rsi14 === null ? "—" : '<span class="' + (o.rsi14 >= 70 ? "down" : o.rsi14 <= 30 ? "up" : "") + '">' + o.rsi14 + "</span>"));
            if (o.stochastic) L.push(row("스토캐스틱 K/D", o.stochastic.k + " / " + o.stochastic.d));
            if (o.cci20 !== null) L.push(row("CCI(20)", '<span class="' + (o.cci20 >= 100 ? "down" : o.cci20 <= -100 ? "up" : "") + '">' + o.cci20 + "</span>"));
            if (o.macd) L.push(row("MACD 히스토그램", o.macd.hist === null ? "—" : '<span class="' + (o.macd.hist > 0 ? "up" : "down") + '">' + fmt(o.macd.hist, dp) + "</span>"));
            if (bb) {
                L.push(row("볼린저 %B", '<span class="' + (bb.pct_b >= 1 ? "down" : bb.pct_b <= 0 ? "up" : "") + '">' + bb.pct_b + "</span>"));
                L.push(row("밴드폭", bb.bandwidth_pct + "%" + (bb.bandwidth_pct < 3 ? ' <span class="neu">수축</span>' : "")));
            }
            if (r.vwap) L.push(row("VWAP", fmt(r.vwap, dp)));
            L.push(row("거래량 배수", (v.surge === null ? "—" : v.surge + "배") + ' <span class="dim" style="font-size:10px">' + esc(v.reliability || "") + "</span>"));
            if (r.levels.vpvr) {
                L.push(row("POC", fmt(r.levels.vpvr.poc, dp)));
                L.push(row("매물대(VA)", fmt(r.levels.vpvr.value_area_low, dp) + " ~ " + fmt(r.levels.vpvr.value_area_high, dp)));
            }
            L.push(row("200봉 최고/최저", fmt(r.levels.period_high, dp) + " / " + fmt(r.levels.period_low, dp)));
            if (o.rsi_divergence) L.push('<tr><td class="dim">다이버전스</td><td class="num neu" style="font-size:11px">' + esc(o.rsi_divergence) + "</td></tr>");
            return '<div class="card"><div class="card-pad" style="padding-bottom:6px"><b style="font-family:var(--font-h)">' + tf.label + "</b></div>"
                + "<table>" + L.join("") + "</table></div>";
        }).filter(Boolean).join("");
        return '<section><div class="sec-head"><h2>지표 상세</h2></div><div class="grid2">' + blocks + "</div></section>";
    }

    function renderScenario(lv, dp) {
        if (!lv || lv.error) return "";
        var out = [];
        if (lv.직상) {
            var nx = lv.resistance[1];
            out.push('<div class="scn"><span class="scn-i down">▲</span><div><b class="down">' + fmt(lv.직상.price, dp)
                + " 돌파 + 유지</b> → " + (nx ? "다음 목표 " + fmt(nx.price, dp)
                    : "위쪽 벽 소진, 천장 " + (lv.천장 ? fmt(lv.천장.price, dp) : "—") + "까지 공백") + "</div></div>");
        }
        if (lv.직하) {
            var nd = lv.support[1];
            out.push('<div class="scn"><span class="scn-i up">▼</span><div><b class="up">' + fmt(lv.직하.price, dp)
                + " 이탈</b> → " + (nd ? "다음 지지 " + fmt(nd.price, dp)
                    : "마지노선 " + (lv.마지노선 ? fmt(lv.마지노선.price, dp) : "—") + "까지 공백") + "</div></div>");
        }
        if (lv.마지노선) {
            out.push('<div class="scn"><span class="scn-i" style="color:var(--gold)">■</span><div class="dim">마지노선 <b style="color:var(--gold)">'
                + fmt(lv.마지노선.price, dp) + "</b> 이탈 시 이 구간에 지지가 없습니다.</div></div>");
        }
        return '<section><div class="sec-head"><h2>조건부 시나리오</h2></div>'
            + '<div class="card card-pad">' + out.join("")
            + '<div class="warn">움직임 원인(뉴스)과 락업·언락 일정은 웹 검색이 필요해 이 페이지에서 다루지 않습니다. '
            + "그 부분은 coin-ta-brief 스킬 브리핑을 쓰세요.</div></div></section>";
    }

    // ---------------------------------------------------------------- 실행

    function run() {
        if (state.busy) return;
        state.busy = true;
        var market = $("market").value || state.sel;
        state.sel = market;
        var sym = market.replace("KRW-", "");
        $("run").disabled = true;
        // 로딩 화면은 처음 그릴 때만. 자동갱신마다 띄우면 그 자체가 깜빡임이다.
        if (state.renderedFor !== market) {
            state.renderedFor = null;
            $("out").innerHTML = '<div class="loading"><span class="spin"></span>' + esc(sym) + " 분석 중…</div>";
        }

        fetchAll(market)
            .then(function (data) { return Promise.all([data, fetchFutures(sym), fetchUsdtKrw(), fetchBankFx()]); })
            .then(function (r) {
                render(market, r[0], r[1], r[2], r[3]);
                connectWS(market);
            })
            .catch(function (e) {
                $("out").innerHTML = '<div class="err"><b>데이터를 불러오지 못했습니다.</b><br>'
                    + esc(e && e.message ? e.message : String(e))
                    + '<div class="dim" style="margin-top:8px;font-size:12.5px">업비트 API 호출 제한(초당 10회)에 걸렸을 수 있습니다. 잠시 후 다시 시도하세요.</div></div>';
            })
            .then(function () { state.busy = false; $("run").disabled = false; });
    }

    function switchTf(tf) {
        state.chartTf = tf;
        [].forEach.call(document.querySelectorAll("#tfbar button"), function (b) {
            b.classList.toggle("act", b.getAttribute("data-tf") === tf);
        });
        if (state.tfCandles && state.tfCandles[tf]) {
            var head = document.querySelector("#chart-sec .sec-head h2");
            if (head) {
                var lbl = (TFS.filter(function (x) { return x.key === tf; })[0] || {}).label || "";
                head.textContent = state.sel.replace("KRW-", "") + " " + lbl + " 차트";
            }
            // 봉이 바뀌면 축 범위가 달라지므로 fitContent가 필요하다. 재생성이 맞다.
            buildChart(state.tfCandles[tf], state.levels, state.dp);
        }
    }

    /**
     * 자동갱신은 지표·레벨 재계산용이다. 시세 자체는 WebSocket이 항상 실시간으로 넣는다.
     *
     * 한 번 갱신에 업비트를 4번 호출한다(ticker + 1h/4h/1d 캔들).
     * 업비트 제한은 초당 10회라 1초 간격이면 초당 4회 — 한 탭이면 안전하지만
     * 여러 탭을 띄우면 넘긴다. 짧은 주기를 고르면 경고를 띄운다.
     */
    function autoIntervalMs() {
        var v = parseInt(($("interval") || {}).value, 10);
        return (isFinite(v) && v > 0 ? v : 10) * 1000;
    }

    function startAuto() {
        if (state.timer) clearInterval(state.timer);
        var ms = autoIntervalMs();
        state.timer = setInterval(run, ms);
        var b = $("auto");
        b.textContent = "자동갱신 ON · " + (ms / 1000) + "초";
        b.classList.add("on");
        showRateHint(ms);
    }

    function showRateHint(ms) {
        var el = $("rateHint");
        if (!el) return;
        if (ms <= 3000) {
            el.textContent = "⚠ 갱신 1회당 업비트 4회 호출 — 여러 탭을 함께 열면 호출 제한(초당 10회)에 걸릴 수 있습니다.";
            el.style.display = "";
        } else {
            el.style.display = "none";
        }
    }

    function toggleAuto() {
        var b = $("auto");
        if (state.timer) {
            clearInterval(state.timer); state.timer = null;
            b.textContent = "자동갱신 OFF"; b.classList.remove("on");
            showRateHint(Infinity);
        } else {
            startAuto();
            run();
        }
    }

    document.addEventListener("DOMContentLoaded", function () {
        $("run").addEventListener("click", run);
        $("auto").addEventListener("click", toggleAuto);
        $("q").addEventListener("input", function () { renderMarketSelect(this.value); });
        $("market").addEventListener("change", function () { state.sel = this.value; run(); });
        $("interval").addEventListener("change", function () {
            if (state.timer) startAuto();   // 켜져 있을 때만 주기를 갈아끼운다
        });
        [].forEach.call(document.querySelectorAll("#tfbar button"), function (b) {
            b.addEventListener("click", function () { switchTf(b.getAttribute("data-tf")); });
        });

        var rt = null;
        window.addEventListener("resize", function () {
            clearTimeout(rt);
            rt = setTimeout(resizeChart, 140);
        });
        window.addEventListener("beforeunload", closeWS);

        loadMarkets().then(run).catch(function (e) {
            $("out").innerHTML = '<div class="err">마켓 목록을 불러오지 못했습니다: ' + esc(e.message) + "</div>";
        });
    });
})();
