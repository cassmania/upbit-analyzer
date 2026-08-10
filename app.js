/**
 * app.js — 업비트 데이터 조달 + 렌더
 *
 * 지표 계산은 ta_engine.js(스킬 이식), 겹침 판정은 level_analyzer.js가 맡는다.
 * 이 파일은 API 호출과 화면 그리기만 한다.
 */
(function () {
    "use strict";

    var UPBIT = "https://api.upbit.com/v1";

    // 업비트 캔들 엔드포인트는 봉마다 경로가 다르다.
    var TFS = [
        { key: "1h", label: "1시간", path: "candles/minutes/60" },
        { key: "4h", label: "4시간", path: "candles/minutes/240" },
        { key: "12h", label: "12시간", path: null, from: "1h", group: 12 },
        { key: "1d", label: "일봉", path: "candles/days" }
    ];

    var state = { markets: [], sel: "KRW-BTC", timer: null, busy: false };
    var lastCandles = null;   // 리사이즈 시 재조회 없이 차트만 다시 그리려고 보관

    var $ = function (id) { return document.getElementById(id); };

    // ---------------------------------------------------------------- 유틸

    function fmt(v, dp) {
        if (v === null || v === undefined || !isFinite(v)) return "—";
        if (dp === undefined) dp = decimals(v);
        return Number(v).toLocaleString("ko-KR", { minimumFractionDigits: dp, maximumFractionDigits: dp });
    }

    /** 업비트는 1원 미만 코인부터 억 단위까지 있다. 자릿수를 값에 맞춘다. */
    function decimals(v) {
        var a = Math.abs(v);
        if (a >= 1000) return 0;
        if (a >= 100) return 1;
        if (a >= 1) return 2;
        if (a >= 0.01) return 4;
        return 8;
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
        return getJSON(UPBIT + "/market/all?isDetails=false").then(function (all) {
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
        // 필터 후에도 기존 선택이 목록에 있으면 유지한다
        if (list.some(function (m) { return m.market === state.sel; })) sel.value = state.sel;
        else if (list.length) state.sel = sel.value = list[0].market;
    }

    /** 업비트 캔들 -> 엔진 형식 {o,h,l,c,v}. 응답은 최신순이라 뒤집는다. */
    function toCandles(raw) {
        return raw.slice().reverse().map(function (k) {
            return {
                t: k.candle_date_time_kst,
                o: k.opening_price, h: k.high_price, l: k.low_price,
                c: k.trade_price, v: k.candle_acc_trade_volume
            };
        });
    }

    /** 업비트에 12시간봉이 없다. 1시간봉 12개를 묶어 합성한다. */
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
            out.push({ t: win[0].t, o: win[0].o, h: hi, l: lo, c: win[win.length - 1].c, v: vol });
        }
        return out;
    }

    function fetchAll(market) {
        var jobs = [
            getJSON(UPBIT + "/ticker?markets=" + market),
            getJSON(UPBIT + "/candles/minutes/60?market=" + market + "&count=200").then(toCandles),
            getJSON(UPBIT + "/candles/minutes/240?market=" + market + "&count=200").then(toCandles),
            getJSON(UPBIT + "/candles/days?market=" + market + "&count=200").then(toCandles)
        ];
        return Promise.all(jobs).then(function (r) {
            var h1 = r[1], h4 = r[2], d1 = r[3];
            // 12시간봉은 4시간봉 3개를 묶어 만든다. 1시간봉 200개(12h 16개)로는 지표가 안 나온다.
            var h12 = groupCandles(h4, 3);
            return {
                ticker: r[0][0],
                tf: { "1h": h1, "4h": h4, "12h": h12, "1d": d1 }
            };
        });
    }

    /**
     * 바이낸스 선물 보조. 업비트에는 펀딩비·미결제약정이 없다.
     * 해당 종목이 바이낸스 USDT-M에 없으면 조용히 null을 돌려준다.
     */
    function fetchFutures(symbol) {
        var s = symbol + "USDT";
        var base = "https://fapi.binance.com/fapi/v1";
        return Promise.all([
            fetch(base + "/premiumIndex?symbol=" + s).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
            fetch(base + "/openInterest?symbol=" + s).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
            fetch(base + "/ticker/price?symbol=" + s).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
        ]).then(function (r) {
            if (!r[0] && !r[1]) return null;
            return {
                funding: r[0] && r[0].lastFundingRate !== undefined ? parseFloat(r[0].lastFundingRate) * 100 : null,
                oi: r[1] && r[1].openInterest ? parseFloat(r[1].openInterest) : null,
                usdPrice: r[2] && r[2].price ? parseFloat(r[2].price) : null
            };
        }).catch(function () { return null; });
    }

    /** 김치 프리미엄: 업비트 원화가 vs 바이낸스 달러가 × 환율 */
    function fetchUsdKrw() {
        // 업비트가 제공하는 환율 엔드포인트가 공개 API에 없어 외부 소스를 쓴다.
        return fetch("https://open.er-api.com/v6/latest/USD")
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) { return d && d.rates && d.rates.KRW ? d.rates.KRW : null; })
            .catch(function () { return null; });
    }

    // ---------------------------------------------------------------- 렌더

    function render(market, data, fut, usdkrw) {
        var t = data.ticker;
        var price = t.trade_price;
        var dp = decimals(price);
        var name = (state.markets.find(function (m) { return m.market === market; }) || {}).korean_name || market;
        var sym = market.replace("KRW-", "");

        var html = [];

        // ---- 시세 헤더
        var chg = t.signed_change_rate * 100;
        var kimchi = null;
        if (fut && fut.usdPrice && usdkrw) {
            kimchi = (price / (fut.usdPrice * usdkrw) - 1) * 100;
        }
        html.push('<div class="quote">');
        html.push(qbox("현재가", '<span class="' + cls(chg) + '">' + fmt(price, dp) + '</span>',
            "₩ · " + esc(name) + " (" + sym + ")"));
        html.push(qbox("24시간 변동", '<span class="' + cls(chg) + '">' + pct(chg) + '</span>',
            "고 " + fmt(t.high_price, dp) + " / 저 " + fmt(t.low_price, dp)));
        html.push(qbox("24시간 거래대금",
            (t.acc_trade_price_24h / 1e8).toFixed(1) + "<span style='font-size:13px'>억</span>",
            "체결량 " + fmt(t.acc_trade_volume_24h, 2)));

        if (fut) {
            var fcls = fut.funding === null ? "" : fut.funding >= 0 ? "up" : "down";
            html.push(qbox("펀딩비 <span class='dim'>(바이낸스)</span>",
                fut.funding === null ? "—" : '<span class="' + fcls + '">' + fut.funding.toFixed(4) + "%</span>",
                fut.funding === null ? "데이터 없음" : (fut.funding >= 0 ? "롱 우위" : "숏 과열 — 숏스퀴즈 조건")));
            html.push(qbox("미결제약정 <span class='dim'>(바이낸스)</span>",
                fut.oi === null ? "—" : fmt(fut.oi, 0), fut.oi === null ? "데이터 없음" : sym + " 계약"));
        } else {
            html.push(qbox("펀딩비 · 미결제약정", '<span class="dim">데이터 없음</span>',
                "바이낸스 USDT-M 미상장"));
        }
        if (kimchi !== null) {
            html.push(qbox("김치 프리미엄", '<span class="' + cls(kimchi) + '">' + pct(kimchi) + '</span>',
                "환율 " + fmt(usdkrw, 1) + "원 기준"));
        }
        html.push("</div>");

        // ---- 시간봉별 분석
        var results = {};
        TFS.forEach(function (tf) {
            var c = data.tf[tf.key];
            results[tf.key] = (c && c.length >= 30) ? TAEngine.analyzeTf(c) : { error: "캔들 부족" };
        });

        html.push(renderSummary(results, dp));
        html.push(renderLevels(data.tf, price, dp));
        html.push(renderChart());
        html.push(renderDetail(results, dp));
        html.push(renderScenario(data.tf, price, dp, sym));

        $("out").innerHTML = html.join("");
        lastCandles = data.tf["4h"];       // 리사이즈 때 재계산 없이 다시 그리기 위해 보관
        drawChart(lastCandles, price);

        $("updated").textContent = "갱신 " + new Date().toLocaleTimeString("ko-KR");
        window.분석결과 = { market: market, results: results, ticker: t, futures: fut };
    }

    function qbox(label, val, sub) {
        return '<div class="qbox"><div class="qlabel">' + label + '</div>'
            + '<div class="qval mono">' + val + '</div>'
            + '<div class="qsub mono">' + (sub || "") + "</div></div>";
    }

    function renderSummary(results, dp) {
        var rows = TFS.map(function (tf) {
            var r = results[tf.key];
            if (r.error) {
                return "<tr><td><b>" + tf.label + '</b></td><td colspan="5" class="dim">'
                    + esc(r.error) + "</td></tr>";
            }
            var cf = r.confluence;
            var netCls = cf.net_pct >= 40 ? "up" : cf.net_pct <= -40 ? "down" : "neu";
            var bias = r.trend.bias;
            var bCls = bias === "강세" ? "up" : bias === "약세" ? "down" : "neu";
            var rsi = r.oscillators.rsi14;
            var rCls = rsi >= 70 ? "down" : rsi <= 30 ? "up" : "";
            var st = r.trend.supertrend;
            return "<tr>"
                + "<td><b>" + tf.label + "</b></td>"
                + '<td class="' + bCls + '"><b>' + bias + "</b> <span class='dim'>(" + r.trend.score + ")</span></td>"
                + '<td class="num ' + netCls + '"><b>' + cf.net_pct + "%</b><div class='reason'>" + cf.verdict + "</div></td>"
                + '<td class="num ' + rCls + '">' + (rsi === null ? "—" : rsi) + "</td>"
                + "<td>" + (st ? '<span class="' + (st.trend === "상승" ? "up" : "down") + '">' + st.trend + "</span>" : "—") + "</td>"
                + "<td>" + r.trend.signals.map(function (s) { return '<span class="sig">' + esc(s) + "</span>"; }).join("")
                + (r.candle_pattern ? "<br>" + r.candle_pattern.map(function (p) {
                    return '<span class="sig neu">' + esc(p) + "</span>"; }).join("") : "")
                + "</td></tr>";
        }).join("");

        return '<section><h2>시간봉별 방향 <span class="tag">여러 봉이 같은 방향이면 신뢰도 상승</span></h2>'
            + '<div class="scroll"><table><thead><tr>'
            + "<th>봉</th><th>추세</th><th>수렴(net%)</th><th>RSI</th><th>슈퍼트렌드</th><th>근거</th>"
            + "</tr></thead><tbody>" + rows + "</tbody></table></div></section>";
    }

    function renderLevels(tfCandles, price, dp) {
        // level_analyzer는 {high,low,close,volume} 키를 쓴다. 엔진 형식에서 변환한다.
        var conv = {};
        Object.keys(tfCandles).forEach(function (k) {
            var c = tfCandles[k];
            if (c && c.length >= 20) {
                conv[k] = c.map(function (x) {
                    return { high: x.h, low: x.l, close: x.c, volume: x.v };
                });
            }
        });
        var lv = LevelEngine.analyze(conv, price, { limit: 7 });
        if (lv.error) {
            return '<section><h2>지지 · 저항</h2><div class="err">' + esc(lv.error) + "</div></section>";
        }

        function rowsOf(list, color) {
            if (!list.length) {
                return '<tr><td colspan="3" class="neu">해당 방향에 벽이 없습니다 (공백 구간)</td></tr>';
            }
            return list.map(function (x) {
                var p = x.strength.rank;
                return "<tr>"
                    + '<td class="num ' + color + '"><b>' + fmt(x.price, dp) + "</b></td>"
                    + '<td class="num dim">' + (x.거리pct >= 0 ? "+" : "") + x.거리pct.toFixed(2) + "%</td>"
                    + '<td><span class="pill p' + p + '">' + esc(x.strength.label) + "</span>"
                    + '<div class="reason">' + esc(x.reason) + "</div></td>"
                    + "</tr>";
            }).join("");
        }

        var warn = lv.경고.length
            ? '<div class="warn">' + lv.경고.map(function (w) { return "⚠ " + esc(w); }).join("<br>") + "</div>"
            : "";

        var floorTxt = lv.마지노선
            ? fmt(lv.마지노선.price, dp) + " <span class='dim'>(" + lv.마지노선.tf + " 최저 · "
              + ((price - lv.마지노선.price) / price * 100).toFixed(1) + "% 아래)</span>"
            : "—";

        window.레벨결과 = lv;

        return '<section><h2>지지 · 저항 <span class="tag">겹치는 봉이 많을수록 두꺼운 벽</span></h2>'
            + '<div class="grid2">'
            + '<div><div class="qlabel" style="margin-bottom:5px">저항 (위로)</div>'
            + '<div class="scroll"><table><thead><tr><th>가격</th><th>거리</th><th>강도 / 근거</th></tr></thead>'
            + "<tbody>" + rowsOf(lv.resistance, "down") + "</tbody></table></div></div>"
            + '<div><div class="qlabel" style="margin-bottom:5px">지지 (아래)</div>'
            + '<div class="scroll"><table><thead><tr><th>가격</th><th>거리</th><th>강도 / 근거</th></tr></thead>'
            + "<tbody>" + rowsOf(lv.support, "up") + "</tbody></table></div></div>"
            + "</div>"
            + '<div style="margin-top:11px;font-size:12px">'
            + "<b>마지노선</b> " + floorTxt
            + ' <span class="dim">· 계산 봉 ' + lv.사용봉.map(function (u) { return u.tf + "(" + u.bars + ")"; }).join(" ") + "</span></div>"
            + warn + "</section>";
    }

    function renderChart() {
        return '<section><h2>4시간봉 차트 <span class="tag">지지·저항선 표시</span></h2>'
            + '<div class="chartbox"><canvas id="cv"></canvas></div></section>';
    }

    function renderDetail(results, dp) {
        var blocks = TFS.map(function (tf) {
            var r = results[tf.key];
            if (r.error) return "";
            var o = r.oscillators, bb = r.bollinger, v = r.volume;
            var lines = [];

            function row(k, val) { return "<tr><td class='dim'>" + k + "</td><td class='num mono'>" + val + "</td></tr>"; }

            lines.push(row("RSI(14)", o.rsi14 === null ? "—"
                : '<span class="' + (o.rsi14 >= 70 ? "down" : o.rsi14 <= 30 ? "up" : "") + '">' + o.rsi14 + "</span>"));
            if (o.stochastic) lines.push(row("스토캐스틱 K/D", o.stochastic.k + " / " + o.stochastic.d));
            if (o.cci20 !== null) lines.push(row("CCI(20)",
                '<span class="' + (o.cci20 >= 100 ? "down" : o.cci20 <= -100 ? "up" : "") + '">' + o.cci20 + "</span>"));
            if (o.macd) lines.push(row("MACD 히스토그램",
                o.macd.hist === null ? "—" : '<span class="' + (o.macd.hist > 0 ? "up" : "down") + '">' + fmt(o.macd.hist, dp) + "</span>"));
            if (bb) {
                lines.push(row("볼린저 %B",
                    '<span class="' + (bb.pct_b >= 1 ? "down" : bb.pct_b <= 0 ? "up" : "") + '">' + bb.pct_b + "</span>"));
                lines.push(row("밴드폭", bb.bandwidth_pct + "%" + (bb.bandwidth_pct < 3 ? " <span class='neu'>수축</span>" : "")));
            }
            if (r.vwap) lines.push(row("VWAP", fmt(r.vwap, dp)));
            lines.push(row("거래량 배수", (v.surge === null ? "—" : v.surge + "배")
                + " <span class='dim' style='font-size:10px'>" + esc(v.reliability || "") + "</span>"));
            if (r.levels.vpvr) {
                lines.push(row("POC", fmt(r.levels.vpvr.poc, dp)));
                lines.push(row("매물대(VA)", fmt(r.levels.vpvr.value_area_low, dp) + " ~ " + fmt(r.levels.vpvr.value_area_high, dp)));
            }
            lines.push(row("200봉 최고/최저", fmt(r.levels.period_high, dp) + " / " + fmt(r.levels.period_low, dp)));
            if (o.rsi_divergence) {
                lines.push("<tr><td class='dim'>다이버전스</td><td class='num neu' style='font-size:11px'>"
                    + esc(o.rsi_divergence) + "</td></tr>");
            }

            return "<div><div class='qlabel' style='margin-bottom:5px'><b>" + tf.label + "</b></div>"
                + "<table>" + lines.join("") + "</table></div>";
        }).filter(Boolean).join("");

        return '<section><h2>지표 상세</h2><div class="grid2">' + blocks + "</div></section>";
    }

    function renderScenario(tfCandles, price, dp, sym) {
        var lv = window.레벨결과;
        if (!lv || lv.error) return "";
        var out = [];
        if (lv.직상) {
            var nx = lv.resistance[1];
            out.push('<div style="padding:4px 0"><span class="down"><b>▲ ' + fmt(lv.직상.price, dp)
                + " 돌파 + 유지</b></span> → "
                + (nx ? "다음 목표 " + fmt(nx.price, dp)
                      : "위쪽 벽 소진, 천장 " + (lv.천장 ? fmt(lv.천장.price, dp) : "—") + "까지 공백") + "</div>");
        }
        if (lv.직하) {
            var nd = lv.support[1];
            out.push('<div style="padding:4px 0"><span class="up"><b>▼ ' + fmt(lv.직하.price, dp)
                + " 이탈</b></span> → "
                + (nd ? "다음 지지 " + fmt(nd.price, dp)
                      : "마지노선 " + (lv.마지노선 ? fmt(lv.마지노선.price, dp) : "—") + "까지 공백") + "</div>");
        }
        if (lv.마지노선) {
            out.push('<div style="padding:4px 0" class="dim">마지노선 <b>' + fmt(lv.마지노선.price, dp)
                + "</b> 이탈 시 이 구간에 지지가 없습니다.</div>");
        }
        out.push('<div class="warn" style="margin-top:10px">'
            + "움직임 원인(뉴스)과 락업·언락 일정은 웹 검색이 필요해 이 페이지에서 다루지 않습니다. "
            + "그 부분은 coin-ta-brief 스킬 브리핑을 쓰세요.</div>");

        return "<section><h2>조건부 시나리오</h2>" + out.join("") + "</section>";
    }

    // ---------------------------------------------------------------- 차트

    function drawChart(candles, price) {
        var cv = $("cv");
        if (!cv || !candles || !candles.length) return;
        var box = cv.parentNode.getBoundingClientRect();
        var dpr = window.devicePixelRatio || 1;
        cv.width = box.width * dpr;
        cv.height = box.height * dpr;
        var g = cv.getContext("2d");
        g.scale(dpr, dpr);
        var W = box.width, H = box.height;

        var css = getComputedStyle(document.documentElement);
        var C = {
            up: css.getPropertyValue("--green").trim() || "#0ecb81",
            dn: css.getPropertyValue("--red").trim() || "#f6465d",
            line: css.getPropertyValue("--line").trim() || "#2a3140",
            dim: css.getPropertyValue("--dim").trim() || "#8b949e",
            yellow: css.getPropertyValue("--yellow").trim() || "#f0b90b"
        };

        var view = candles.slice(-90);
        var padR = 62, padB = 16, padT = 8;
        var hi = -Infinity, lo = Infinity;
        view.forEach(function (c) { if (c.h > hi) hi = c.h; if (c.l < lo) lo = c.l; });

        // 레벨선이 차트 밖에 있으면 그릴 수 없다. 보이는 것만 포함해 범위를 넓힌다.
        var lv = window.레벨결과;
        var marks = [];
        if (lv && !lv.error) {
            (lv.resistance || []).slice(0, 3).forEach(function (x) { marks.push({ p: x.price, c: C.dn, t: x.strength.label }); });
            (lv.support || []).slice(0, 3).forEach(function (x) { marks.push({ p: x.price, c: C.up, t: x.strength.label }); });
        }
        marks = marks.filter(function (m) { return m.p > lo * 0.9 && m.p < hi * 1.1; });
        marks.forEach(function (m) { if (m.p > hi) hi = m.p; if (m.p < lo) lo = m.p; });

        var pad = (hi - lo) * 0.06 || 1;
        hi += pad; lo -= pad;
        var y = function (v) { return padT + (hi - v) / (hi - lo) * (H - padT - padB); };
        var cw = (W - padR) / view.length;

        g.clearRect(0, 0, W, H);

        // 격자 + 가격 눈금
        g.strokeStyle = C.line; g.fillStyle = C.dim;
        g.font = "10px ui-monospace,monospace"; g.textAlign = "left";
        g.lineWidth = 1;
        for (var i = 0; i <= 4; i++) {
            var v = lo + (hi - lo) * i / 4, yy = Math.round(y(v)) + 0.5;
            g.beginPath(); g.moveTo(0, yy); g.lineTo(W - padR, yy); g.stroke();
            g.fillText(fmt(v, decimals(v)), W - padR + 5, yy + 3);
        }

        // 캔들
        view.forEach(function (c, i) {
            var x = i * cw + cw / 2;
            var bull = c.c >= c.o;
            g.strokeStyle = g.fillStyle = bull ? C.up : C.dn;
            g.beginPath();
            g.moveTo(Math.round(x) + 0.5, y(c.h));
            g.lineTo(Math.round(x) + 0.5, y(c.l));
            g.stroke();
            var bw = Math.max(1, cw * 0.62);
            var yo = y(c.o), yc = y(c.c);
            g.fillRect(x - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
        });

        // 레벨선
        g.setLineDash([4, 3]);
        g.textAlign = "left";
        marks.forEach(function (m) {
            var yy = Math.round(y(m.p)) + 0.5;
            g.strokeStyle = m.c;
            g.beginPath(); g.moveTo(0, yy); g.lineTo(W - padR, yy); g.stroke();
            g.fillStyle = m.c;
            g.fillText(m.t, 4, yy - 3);
        });
        g.setLineDash([]);

        // 현재가
        var yp = Math.round(y(price)) + 0.5;
        g.strokeStyle = C.yellow; g.lineWidth = 1.4;
        g.beginPath(); g.moveTo(0, yp); g.lineTo(W - padR, yp); g.stroke();
        g.fillStyle = C.yellow;
        g.fillRect(W - padR + 2, yp - 8, padR - 4, 16);
        g.fillStyle = "#000"; g.font = "bold 10px ui-monospace,monospace";
        g.fillText(fmt(price, decimals(price)), W - padR + 5, yp + 3);
    }

    // ---------------------------------------------------------------- 실행

    function run() {
        if (state.busy) return;
        state.busy = true;
        var market = $("market").value || state.sel;
        state.sel = market;
        var sym = market.replace("KRW-", "");
        $("run").disabled = true;
        $("out").innerHTML = '<div class="loading"><span class="spin"></span>' + esc(sym) + " 분석 중…</div>";

        fetchAll(market)
            .then(function (data) {
                // 선물·환율은 실패해도 본 분석을 막지 않는다
                return Promise.all([data, fetchFutures(sym), fetchUsdKrw()]);
            })
            .then(function (r) { render(market, r[0], r[1], r[2]); })
            .catch(function (e) {
                $("out").innerHTML = '<div class="err"><b>데이터를 불러오지 못했습니다.</b><br>'
                    + esc(e && e.message ? e.message : String(e))
                    + '<div class="dim" style="margin-top:6px">업비트 API 호출 제한(초당 10회)에 걸렸을 수 있습니다. 잠시 후 다시 시도하세요.</div></div>';
            })
            .then(function () {
                state.busy = false;
                $("run").disabled = false;
            });
    }

    function toggleAuto() {
        var btn = $("auto");
        if (state.timer) {
            clearInterval(state.timer); state.timer = null;
            btn.textContent = "자동갱신 OFF";
            btn.classList.remove("primary");
        } else {
            state.timer = setInterval(run, 30000);   // 업비트 제한(초당 10회) 대비 넉넉히
            btn.textContent = "자동갱신 ON (30초)";
            btn.classList.add("primary");
            run();
        }
    }

    // ---------------------------------------------------------------- 초기화

    document.addEventListener("DOMContentLoaded", function () {
        $("run").addEventListener("click", run);
        $("auto").addEventListener("click", toggleAuto);
        $("q").addEventListener("input", function () { renderMarketSelect(this.value); });
        $("market").addEventListener("change", function () { state.sel = this.value; run(); });
        // 리사이즈 때는 API를 다시 때리지 않고 캔버스만 다시 그린다
        var rt = null;
        window.addEventListener("resize", function () {
            clearTimeout(rt);
            rt = setTimeout(function () {
                var d = window.분석결과;
                if (lastCandles && d && d.ticker) drawChart(lastCandles, d.ticker.trade_price);
            }, 150);
        });

        loadMarkets().then(run).catch(function (e) {
            $("out").innerHTML = '<div class="err">마켓 목록을 불러오지 못했습니다: ' + esc(e.message) + "</div>";
        });
    });
})();
