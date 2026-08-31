/**
 * app.js — 4개 거래소 데이터 조달 + 실시간 차트 + 렌더
 *
 * 지표 계산은 ta_engine.js(스킬 이식), 겹침 판정은 level_analyzer.js가 맡는다.
 * 이 파일은 API/WebSocket 조달과 화면 그리기만 한다.
 */
(function () {
    "use strict";

    /**
     * 거래소 설정.
     *
     * 빗썸 API는 업비트와 경로·응답 키·WebSocket 프로토콜이 사실상 같다(실측 2026-08-11).
     * 결정적 차이는 두 가지뿐이다:
     *   - CORS: 업비트는 전 엔드포인트 차단, 빗썸은 Access-Control-Allow-Origin: * 허용.
     *     그래서 업비트만 서버리스 프록시(/api/upbit)를 거친다.
     *   - 년봉: 업비트는 candles/years가 있고, 빗썸은 404.
     */
    /**
     * 레퍼럴 링크.
     *
     * 여기 두 줄만 실제 링크로 바꾸면 배너가 살아난다.
     * 빈 문자열이면 배너를 아예 감춘다 — 코드 없이 껍데기만 노출하는 게 더 나쁘다.
     *
     * 링크 얻는 곳:
     *   바이낸스 https://www.binance.com/en/activity/referral
     *   MEXC     https://www.mexc.com/ko-KR/referral
     */
    var REFERRAL = {
        binance: "https://www.binance.com/referral/earn-together/refer2earn-usdc/claim?hl=en&ref=GRO_28502_927WY&utm_source=referral_entrance",
        mexc: "https://www.mexc.com/acquisition/custom-sign-up?shareCode=mexc-2jSch"
    };

    var EXCHANGES = {
        upbit: {
            name: "업비트",
            kind: "upbit",
            quote: "KRW",
            rest: "https://api.upbit.com/v1/",
            ws: "wss://api.upbit.com/websocket/v1",
            proxy: "/api/upbit",      // CORS 차단 -> 프록시 필요
            hasYear: true
        },
        bithumb: {
            name: "빗썸",
            kind: "upbit",
            rest: "https://api.bithumb.com/v1/",
            ws: "wss://ws-api.bithumb.com/websocket/v1",
            proxy: null,              // CORS 허용 -> 브라우저에서 직접
            hasYear: false,           // candles/years 404
            quote: "KRW"
        },
        binance: {
            name: "바이낸스",
            kind: "binance",          // 응답이 배열이라 별도 어댑터를 쓴다
            rest: "https://api.binance.com/api/v3/",
            ws: "wss://stream.binance.com:9443/ws/",
            proxy: null,              // CORS 허용
            hasYear: false,           // 년봉 없음. 월봉이 최장
            quote: "USDT",
            // 바이낸스 봉 표기. 8h·12h가 네이티브라 합성이 필요 없다.
            iv: { "1h": "1h", "4h": "4h", "8h": "8h", "12h": "12h", "1d": "1d", "1w": "1w", "1M": "1M" }
        },
        mexc: {
            name: "MEXC",
            kind: "binance",          // 바이낸스 호환 API — 같은 어댑터를 쓴다
            rest: "https://api.mexc.com/api/v3/",
            ws: null,                 // Protobuf만 제공. 아래 주석 참고
            proxy: "/api/mexc",       // CORS 차단 -> 프록시 필요
            hasYear: false,
            quote: "USDT",
            // MEXC 봉 표기는 바이낸스와 다르다(실측): 1h가 아니라 60m, 1w가 아니라 1W.
            // 12시간봉은 아예 없어서 4h를 3개 묶는다.
            iv: { "1h": "60m", "4h": "4h", "8h": "8h", "1d": "1d", "1w": "1W", "1M": "1M" },
            group: { "12h": { from: "4h", n: 3 } }
        }
    };

    // localhost에는 서버리스 함수가 없으니 프록시를 못 쓴다.
    // (그 경우 업비트는 브라우저 CORS에 막히지만, 로컬 확인용이라 그대로 둔다.)
    var LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

    function ex() { return EXCHANGES[state.exchange] || EXCHANGES.upbit; }

    function apiUrl(path, params) {
        var e = ex();
        // localhost엔 서버리스 함수가 없어 프록시를 못 쓴다.
        // MEXC는 CORS도 막혀 있어 로컬에서는 조회가 실패한다(배포본에서만 동작).
        var 프록시 = e.proxy && !LOCAL;
        var sp = new URLSearchParams();
        if (프록시) sp.set("path", path);
        Object.keys(params || {}).forEach(function (k) {
            if (params[k] !== undefined && params[k] !== null) sp.set(k, params[k]);
        });
        return 프록시 ? e.proxy + "?" + sp.toString()
                    : e.rest + path + "?" + sp.toString();
    }

    /**
     * 이 거래소에서 쓸 수 있는 봉만.
     * 빗썸·바이낸스는 년봉이 없다. 바이낸스는 8h·12h가 네이티브라 합성을 건너뛴다.
     */
    function activeTfs() {
        var e = ex();
        return TFS.filter(function (t) {
            if (t.key === "1y" && !e.hasYear) return false;
            // 바이낸스 계열은 iv 표에 없는 봉을 못 받는다.
            // MEXC엔 12시간봉이 없지만 group으로 합성하므로 살려둔다.
            if (e.iv && !e.iv[t.key] && !(e.group && e.group[t.key])) return false;
            return true;
        });
    }

    /** 이 거래소에서 API로 직접 받을 봉 (나머지는 합성) */
    function directTfs() {
        var e = ex();
        if (e.kind === "binance") {
            return activeTfs().filter(function (t) { return e.iv && e.iv[t.key]; });
        }
        return activeTfs().filter(function (t) { return t.path; });
    }

    /** 합성이 필요한 봉 (업비트/빗썸의 8h·12h) */
    function groupedTfs() {
        var e = ex();
        if (e.kind === "binance") {
            // 바이낸스는 전 봉 네이티브라 비어 있고, MEXC는 12시간봉만 합성한다.
            if (!e.group) return [];
            return Object.keys(e.group).map(function (k) {
                return { key: k, from: e.group[k].from, group: e.group[k].n };
            });
        }
        return activeTfs().filter(function (t) { return t.group; });
    }

    // ---------------------------------------------------------------- 바이낸스 어댑터

    /**
     * 바이낸스는 업비트와 응답 형식이 완전히 다르다.
     *   - klines: 객체가 아니라 배열 [열림시각, 시가, 고가, 저가, 종가, 거래량, ...]
     *   - ticker: lastPrice/priceChangePercent 등 다른 키
     *   - 심볼: KRW-BTC가 아니라 BTCUSDT
     * 여기서 전부 업비트 형태로 바꿔 나머지 코드가 거래소를 몰라도 되게 한다.
     */
    function bnSymbol(market) {
        // 내부 표기는 "USDT-BTC"로 통일한다(업비트 KRW-BTC와 같은 모양).
        var p = market.split("-");
        return (p[1] || p[0]) + (p[0] || "USDT");
    }

    function bnKlines(market, tfKey, count) {
        var iv = ex().iv[tfKey];
        if (!iv) return Promise.resolve([]);
        var u = apiUrl("klines", { symbol: bnSymbol(market), interval: iv, limit: count });
        return getJSON(u).then(function (raw) {
            if (!Array.isArray(raw)) return [];
            // 바이낸스는 오래된 것부터 준다. 업비트는 최신순이라 toCandles가 뒤집는데,
            // 여기서는 이미 시간순이므로 그대로 매핑한다.
            var tf = TFS.filter(function (t) { return t.key === tfKey; })[0];
            return CandleUtils.fromBinance(raw, tfKey, tf ? tf.sec : 0);
        }).catch(function () { return []; });
    }

    /** 바이낸스 24hr ticker -> 업비트 ticker 형태 */
    function bnTicker(market) {
        return getJSON(apiUrl("ticker/24hr", { symbol: bnSymbol(market) })).then(function (d) {
            // 같은 키인데 단위가 다르다(실측): 바이낸스는 퍼센트(-1.52), MEXC는 비율(-0.0152).
            // 문서에 없는 차이라 이름만 믿으면 100배 어긋난다. 종가·전일종가로 실제 비율을
            // 계산해 어느 쪽인지 판별한다.
            var raw = parseFloat(d.priceChangePercent);
            var last = parseFloat(d.lastPrice), prev = parseFloat(d.prevClosePrice);
            var chg;
            if (isFinite(last) && isFinite(prev) && prev > 0) {
                var 실제 = (last - prev) / prev;
                // raw가 실제 비율에 가까우면 그대로, 100배에 가까우면 나눈다
                chg = Math.abs(raw - 실제) <= Math.abs(raw - 실제 * 100) ? raw : raw / 100;
            } else {
                chg = raw / 100;   // 판별 불가 시 바이낸스 기준
            }
            return {
                market: market,
                trade_price: parseFloat(d.lastPrice),
                signed_change_rate: chg,
                change_rate: Math.abs(chg),
                high_price: parseFloat(d.highPrice),
                low_price: parseFloat(d.lowPrice),
                acc_trade_price_24h: parseFloat(d.quoteVolume),
                acc_trade_volume_24h: parseFloat(d.volume),
                prev_closing_price: parseFloat(d.prevClosePrice),
                timestamp: isFinite(Number(d.closeTime)) ? Number(d.closeTime) : Date.now()
            };
        });
    }

    /** 바이낸스 USDT 마켓 목록 -> 업비트 market/all 형태 */
    function bnMarkets() {
        return getJSON(apiUrl("exchangeInfo", {})).then(function (d) {
            return (d.symbols || [])
                // 거래중 표기가 다르다: 바이낸스 "TRADING", MEXC "1"
                .filter(function (x) {
                    return x.quoteAsset === "USDT"
                        && (x.status === "TRADING" || x.status === "1" || x.status === "ENABLED");
                })
                .map(function (x) {
                    return {
                        market: "USDT-" + x.baseAsset,
                        korean_name: x.baseAsset,
                        english_name: x.baseAsset
                    };
                });
        });
    }

    /**
     * 타임프레임 정의.
     *
     * 업비트·빗썸 모두 분봉은 1/3/5/10/15/30/60/240만 있다(480·720은 400).
     * 8시간·12시간은 4시간봉을 각각 2개·3개씩 묶어 합성한다.
     * 주·월봉은 양쪽 다 있다. 년봉은 업비트만 있고 빗썸은 404다(activeTfs가 걸러낸다).
     *
     * group: 합성 배수 (없으면 API 직접 조회)
     * levels: 지지·저항 계산에 넣을지 여부.
     *   년봉은 상장 이래 10개 남짓이라 매물대·스윙을 뽑을 표본이 안 된다.
     *   차트로 보는 건 되지만 레벨 계산에서는 뺀다.
     */
    var TFS = [
        { key: "1h",  label: "1시간",  path: "candles/minutes/60",  sec: 3600,     levels: true },
        { key: "4h",  label: "4시간",  path: "candles/minutes/240", sec: 14400,    levels: true },
        { key: "8h",  label: "8시간",  path: null, from: "4h", group: 2, sec: 28800,  levels: true },
        { key: "12h", label: "12시간", path: null, from: "4h", group: 3, sec: 43200,  levels: true },
        { key: "1d",  label: "일봉",   path: "candles/days",   sec: 86400,     levels: true },
        { key: "1w",  label: "주봉",   path: "candles/weeks",  sec: 604800,    levels: true },
        { key: "1M",  label: "월봉",   path: "candles/months", sec: 2592000,   levels: true },
        { key: "1y",  label: "년봉",   path: "candles/years",  sec: 31536000,  levels: false }
    ];

    /** 레벨 계산에 넣을 봉만. 년봉처럼 표본이 부족한 건 제외된다. */
    function levelTfs() {
        return TFS.filter(function (t) { return t.levels; });
    }

    var state = {
        // 첫 진입은 USDT 기준의 바이낸스 현물 가격을 표시한다.
        // 사용자가 거래소 버튼을 누르면 기존처럼 해당 거래소로 전환된다.
        exchange: "binance",
        markets: [], favorites: [], marketTab: "search", sel: "USDT-BTC", chartTf: "4h",
        timer: null, busy: false, auto: false,
        alertOn: false, lastSignalKey: null, signal: null,
        ws: null, wsAlive: false,
        tfCandles: null, analysisTfCandles: null, levels: null, dp: 0, lastPrice: 0,
        usdPrice: null, usdtKrw: null, bankFx: null,  // 바이낸스 시세 / 김프 기준 환율 / 은행 환율
        analysisAt: null, tickerAt: null, fxAt: null, v41: null,
        usdtDominance: null,                         // CoinGecko 기준 USDT 시가총액 비중
        renderedFor: null   // 전체 렌더가 끝난 종목. 같으면 부분 갱신만 한다
    };

    // 2026-08-30 이전 Binance 현물 확정봉 5종목, 마지막 40% 홀드아웃 결과입니다.
    // 신호의 방향을 수익 보장처럼 보이지 않게 하기 위해 화면 근거로 함께 표시합니다.
    var SIGNAL_BACKTEST = {
        status: "전체 전략 우위 미확인",
        summary: "홀드아웃 88거래 · 승률 42.0% · PF 0.773 · 평균 -0.178R",
        detail: "롱 36건 PF 1.151 · 가상 숏 52건 PF 0.590"
    };

    var chart = null, candleSeries = null, volumeSeries = null, priceLines = [];
    var maSeries = {};   // 이동평균선. 봉을 바꿔도 재사용한다

    /**
     * 차트 팔레트 — 밝은 배경.
     *
     * 페이지는 딥 네이비 다크지만 차트만 밝게 간다. 캔들·이동평균·레벨선이
     * 한 화면에 열몇 개씩 겹치는데, 어두운 바탕에서는 선 색이 서로 묻힌다.
     * 흰 바탕이면 같은 색이라도 구분이 확실히 된다(사용자 요청 레퍼런스 기준).
     */
    var CHART = {
        bg: "#ffffff",
        text: "#3f4a5a",
        grid: "rgba(120,134,158,.14)",
        border: "#d4dae4",
        up: "#26a69a",          // 상승 캔들 — 청록
        down: "#ef5350",        // 하락 캔들 — 빨강
        // V3 표준 이동평균. 지표선은 아래에서 완료봉만 사용한다.
        ma: [
            { n: 20,  color: "#f0b90b", label: "SMA(20)" },
            { n: 50,  color: "#1e5eff", label: "SMA(50)" },
            { n: 200, color: "#c026d3", label: "SMA(200)" }
        ],
        // 레벨선. 강도가 셀수록 진하고 두껍다.
        res: ["#8b0000", "#d32f2f", "#f06292"],   // 3차·2차·1차 저항
        sup: ["#0277bd", "#29b6f6", "#81d4fa"],   // 3차·2차·1차 지지
        floor: "#ff9800"
    };

    /** 단순이동평균. 앞쪽 n-1개는 값이 없어 건너뛴다. */
    function sma(candles, n) {
        var out = [], sum = 0;
        for (var i = 0; i < candles.length; i++) {
            sum += candles[i].c;
            if (i >= n) sum -= candles[i - n].c;
            if (i >= n - 1) out.push({ time: candles[i].time, value: sum / n });
        }
        return out;
    }

    var $ = function (id) { return document.getElementById(id); };

    // ---------------------------------------------------------------- 유틸

    /**
     * 표시 자릿수. 원화와 USDT는 스케일이 달라 기준을 나눈다.
     * 원화 BTC는 9천만이라 소수점이 필요 없지만, USDT BTC는 6만이라 2자리가 필요하다.
     */
    function decimals(v) {
        var a = Math.abs(v);
        if ((ex().quote || "KRW") !== "KRW") return usdDecimals(v);
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

    /** V3 출력 규칙: USDT를 먼저, 확인된 KRW 환산을 괄호 안에 둔다. */
    function fmtPair(v, dp) {
        if (!isFinite(v)) return "—";
        var 원화시장 = (ex().quote || "KRW") === "KRW";
        var usdt = 원화시장 ? (state.usdtKrw ? v / state.usdtKrw : null) : v;
        var krw = 원화시장 ? v : (state.usdtKrw ? v * state.usdtKrw : null);
        var left = usdt ? fmtUsd(usdt) : "USDT 확인 불가";
        var krwDp = !krw || Math.abs(krw) >= 1000 ? 0 : Math.abs(krw) >= 100 ? 1
            : Math.abs(krw) >= 1 ? 2 : Math.abs(krw) >= 0.01 ? 4 : 8;
        var right = krw ? fmt(krw, 원화시장 ? dp : krwDp) + "원" : "KRW 환산 확인 불가";
        return left + " (" + right + ")";
    }

    function kst(ms) {
        if (!isFinite(ms) || ms <= 0) return "확인 불가";
        if (ms < 1e12) ms *= 1000;
        return new Date(ms).toLocaleString("ko-KR", {
            timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
        }) + " KST";
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
        var e = ex();
        // API 응답이 늦거나 실패해도 저장된 즐겨찾기 개수는 먼저 복원한다.
        state.favorites = loadFavorites();
        renderFavoriteCount();
        var p = e.kind === "binance"
            ? bnMarkets()
            : getJSON(apiUrl("market/all", { isDetails: false })).then(function (all) {
                return all.filter(function (m) { return m.market.indexOf("KRW-") === 0; });
            });
        return p.then(function (list) {
            state.markets = list.sort(function (a, b) {
                return a.korean_name.localeCompare(b.korean_name, "ko");
            });
            renderMarketSelect("");
            renderFavoriteResults();
        });
    }

    /** 기축통화 접두사를 뗀 코인 심볼 */
    function coinOf(market) { return (market || "").split("-")[1] || market; }

    /** 검색창에서 테더 도미넌스 지표를 선택했는지 판별한다. */
    function isUsdtDominanceMarket(value) {
        var q = String(value || "").trim().toLowerCase();
        return q === "__usdt_dominance__"
            || q === "usdt.d"
            || q === "usdt dominance"
            || q === "tether dominance"
            || q === "테더 도미넌스"
            || q === "테더도미넌스";
    }

    /** 즐겨찾기는 로그인 없이도 새로고침 후 유지되도록 거래소별로 저장한다. */
    function favoriteStorageKey() {
        return "upbit-analyzer:favorites:" + state.exchange;
    }
    function loadFavorites() {
        try {
            var saved = JSON.parse(localStorage.getItem(favoriteStorageKey()) || "[]");
            return Array.isArray(saved) ? saved.filter(function (m) { return typeof m === "string"; }) : [];
        } catch (e) {
            return [];
        }
    }
    function saveFavorites() {
        try { localStorage.setItem(favoriteStorageKey(), JSON.stringify(state.favorites)); } catch (e) { /* 저장 불가 환경에서는 화면만 유지 */ }
    }

    /**
     * 마지막 거래소와 코인을 기억한다.
     *
     * 즐겨찾기 목록은 거래소별로 이미 안전하게 나뉘어 저장되고 있다. 다만 재접속 때
     * 거래소가 항상 바이낸스로 돌아가면, MEXC 등에 저장한 즐겨찾기가 0개처럼 보인다.
     * 따라서 민감하지 않은 화면 설정 두 가지만 별도 키에 보관해 같은 화면으로 복원한다.
     */
    var PREFERENCE_STORAGE_KEY = "upbit-analyzer:preferences:v1";
    function loadPreferences() {
        try {
            var saved = JSON.parse(localStorage.getItem(PREFERENCE_STORAGE_KEY) || "{}");
            if (saved && EXCHANGES[saved.exchange]) {
                state.exchange = saved.exchange;
            } else {
                // 이번 버전 이전에 등록한 즐겨찾기도 첫 재접속부터 바로 보이게 한다.
                // 마지막 거래소 기록이 없으면 즐겨찾기가 가장 많은 거래소를 합리적인 복원값으로 쓴다.
                var best = Object.keys(EXCHANGES).map(function (key) {
                    var list;
                    try {
                        list = JSON.parse(localStorage.getItem("upbit-analyzer:favorites:" + key) || "[]");
                    } catch (e) {
                        list = [];
                    }
                    return { key: key, count: Array.isArray(list) ? list.length : 0 };
                }).sort(function (a, b) { return b.count - a.count; })[0];
                if (best && best.count > 0) state.exchange = best.key;
            }
            if (saved && typeof saved.sel === "string" && saved.sel) state.sel = saved.sel;
        } catch (e) { /* 손상되었거나 저장소를 쓸 수 없으면 기본값을 사용한다 */ }
    }
    function savePreferences() {
        try {
            localStorage.setItem(PREFERENCE_STORAGE_KEY, JSON.stringify({
                exchange: state.exchange,
                sel: state.sel
            }));
        } catch (e) { /* 저장 불가 환경에서는 현재 접속 중인 화면만 유지한다 */ }
    }
    function isFavorite(market) { return state.favorites.indexOf(market) !== -1; }
    function toggleFavorite(market) {
        var i = state.favorites.indexOf(market);
        if (i === -1) state.favorites.push(market);
        else state.favorites.splice(i, 1);
        saveFavorites();
        renderMarketSelect($("q").value);
        renderFavoriteResults();
    }

    /** 검색과 즐겨찾기 목록을 탭으로 전환한다. */
    function setMarketTab(tab) {
        state.marketTab = tab === "favorites" ? "favorites" : "search";
        [].forEach.call(document.querySelectorAll("[data-market-tab]"), function (b) {
            var active = b.getAttribute("data-market-tab") === state.marketTab;
            b.classList.toggle("act", active);
            b.setAttribute("aria-selected", active ? "true" : "false");
        });
        var searchPanel = $("marketSearchPanel");
        var favoritePanel = $("marketFavoritesPanel");
        if (searchPanel) searchPanel.hidden = state.marketTab !== "search";
        if (favoritePanel) favoritePanel.hidden = state.marketTab !== "favorites";
        if (state.marketTab === "search") {
            renderMarketResults($("q").value, state.markets);
        } else {
            renderFavoriteResults();
        }
    }

    /** 검색어가 코인의 마켓 코드, 심볼, 한글명 또는 영문명에 포함되는지 확인한다. */
    function marketMatchesSearch(m, filter) {
        var f = (filter || "").trim().toLowerCase();
        if (!f) return true;
        return m.market.toLowerCase().indexOf(f) !== -1
            || coinOf(m.market).toLowerCase().indexOf(f) !== -1
            || m.korean_name.toLowerCase().indexOf(f) !== -1
            || (m.english_name || "").toLowerCase().indexOf(f) !== -1;
    }

    /** 불완전한 글자를 입력하는 도중에는 실행하지 않도록 정확히 일치하는 코인만 찾는다. */
    function findExactMarket(query) {
        var q = (query || "").trim().toLowerCase();
        if (!q) return null;
        return state.markets.find(function (m) {
            return m.market.toLowerCase() === q
                || coinOf(m.market).toLowerCase() === q
                || m.korean_name.toLowerCase() === q
                || (m.english_name || "").toLowerCase() === q;
        }) || null;
    }

    /**
     * 종목 목록을 그린다.
     *
     * 오른쪽 기본 선택 상자에는 현재 분석 종목을 남겨 화면이 엉뚱한 종목으로 보이지
     * 않게 한다. 검색 결과 목록에는 실제 일치한 코인만 보여 TAO를 분석하면서 PUMP를
     * 검색했을 때 TAO가 검색 결과에 섞이는 문제를 막는다.
     */
    function renderMarketSelect(filter) {
        var sel = $("market");
        var f = (filter || "").trim().toLowerCase();
        var showDominance = isUsdtDominanceMarket(f)
            || f.indexOf("테더") !== -1
            || f.indexOf("usdt.d") !== -1
            || f.indexOf("tether dominance") !== -1;
        var matches = state.markets.filter(function (m) { return marketMatchesSearch(m, f); });
        var list = matches.slice();
        if (f && !list.some(function (m) { return m.market === state.sel; })) {
            var current = state.markets.find(function (m) { return m.market === state.sel; });
            if (current) list.unshift(current);
        }
        var dominanceOption = showDominance
            ? '<option value="__USDT_DOMINANCE__">테더 도미넌스 (USDT.D) · 차트</option>'
            : "";
        sel.innerHTML = dominanceOption + list.map(function (m) {
            return '<option value="' + m.market + '">' + esc(m.korean_name)
                + " (" + coinOf(m.market) + ")</option>";
        }).join("");
        if (state.sel === "__USDT_DOMINANCE__" && showDominance) {
            sel.value = state.sel;
        } else if (list.some(function (m) { return m.market === state.sel; })) {
            sel.value = state.sel;
        }
        renderMarketResults(f, matches);
        renderFavoriteCount();
    }

    function renderFavoriteCount() {
        var count = $("favoriteCount");
        if (count) count.textContent = String(state.favorites.length);
    }

    function marketResultMarkup(m) {
        var fav = isFavorite(m.market);
        return '<div class="market-result" role="option">'
            + '<button type="button" class="market-open" data-market-open="' + esc(m.market) + '">'
            + '<b>' + esc(m.korean_name) + '</b><span>' + esc(coinOf(m.market)) + '</span></button>'
            + '<button type="button" class="favorite-toggle' + (fav ? ' is-favorite' : '') + '"'
            + ' data-favorite="' + esc(m.market) + '" aria-label="' + (fav ? '즐겨찾기 해제' : '즐겨찾기 등록') + '"'
            + ' aria-pressed="' + (fav ? 'true' : 'false') + '" title="' + (fav ? '즐겨찾기 해제' : '즐겨찾기 등록') + '">'
            + (fav ? '★' : '☆') + '</button></div>';
    }

    /** 검색 탭에서만 일치하는 코인을 표시한다. 빈 검색어에서는 목록을 열지 않는다. */
    function renderMarketResults(filter, filteredList) {
        var box = $("marketResults");
        if (!box) return;
        var f = (filter || "").trim().toLowerCase();
        var list = filteredList || state.markets;
        if (!f || state.marketTab !== "search") {
            box.hidden = true;
            return;
        }
        list = list.slice(0, 12);
        if (!list.length) {
            box.innerHTML = '<div class="market-results-note">일치하는 코인이 없습니다.</div>';
            box.hidden = false;
            return;
        }
        box.innerHTML = list.map(marketResultMarkup).join("");
        box.hidden = false;
    }

    /** 즐겨찾기 탭의 전체 목록을 거래소별로 그린다. */
    function renderFavoriteResults() {
        var box = $("favoriteResults");
        if (!box) return;
        var list = state.markets.filter(function (m) { return isFavorite(m.market); });
        box.innerHTML = list.length
            ? list.map(marketResultMarkup).join("")
            : '<div class="market-results-note">등록된 즐겨찾기가 없습니다.<br>코인 검색 탭에서 ☆를 눌러 추가하세요.</div>';
        box.hidden = false;
        renderFavoriteCount();
    }

    /** 검색 결과, 즐겨찾기, Enter, 기본 선택 상자의 종목 선택을 한 경로로 처리한다. */
    function selectMarketAndRun(market) {
        if (!market) return;
        state.sel = market;
        $("q").value = "";
        setMarketTab("search");
        renderMarketSelect("");
        $("market").value = state.sel;
        $("marketResults").hidden = true;
        savePreferences();
        run();
    }

    /** 업비트 캔들 -> 엔진 형식. 봉 시작 시각과 완료 여부도 함께 정규화한다. */
    function toCandles(raw, tf) {
        return CandleUtils.fromUpbit(raw, tf.key, tf.sec);
    }

    /**
     * 업비트에 12시간봉이 없다. 4시간봉 n개를 묶어 합성한다.
     *
     * 묶는 기준은 배열 위치가 아니라 **봉의 시각**이다.
     *
     * 예전에는 인덱스 0부터 n개씩 잘랐다. 문제가 둘이었다:
     *   1. 200 % 3 = 2라 최신 4시간봉 2개(최대 8시간)가 통째로 버려졌다.
     *      지금 형성 중인 봉이 12시간 합성봉에 영원히 안 들어갔다.
     *   2. 봉이 하나 롤오버될 때마다 배열 시작점이 밀려 합성 경계가 매번 달라졌다.
     *      같은 종목을 새로고침만 해도 12시간 지지·저항이 흔들렸다.
     *
     * UNIX 시각을 구간 길이로 내림하면 경계가 절대 시간에 고정된다.
     * 12시간봉이면 항상 같은 시각에 열리고, 새로고침해도 값이 같다.
     * 마지막 구간은 차트에는 남기되 `closed:false`로 표시해 지표 계산에서는 뺀다.
     */
    function groupCandles(src, n, secPerBar) {
        return CandleUtils.group(src, n, secPerBar);
    }

    /**
     * 8개 봉을 한 번에 받는다. 합성봉(8h·12h)은 4시간봉에서 만들므로 호출하지 않는다.
     * 실제 API 호출은 ticker + 6개 캔들 = 7회.
     *
     * 장기봉은 종목마다 이력이 짧을 수 있다. 실패하거나 비면 빈 배열로 두고
     * 뒤에서 "데이터 부족"으로 표시한다 — 전체를 실패시키지 않는다.
     */
    function fetchAll(market) {
        var e = ex();
        var direct = directTfs();

        var tickerCall = e.kind === "binance"
            ? bnTicker(market)
            : getJSON(apiUrl("ticker", { markets: market })).then(function (d) { return d[0]; });

        var calls = [tickerCall];
        direct.forEach(function (t) {
            calls.push(e.kind === "binance"
                ? bnKlines(market, t.key, 200)
                : getJSON(apiUrl(t.path, { market: market, count: 200 }))
                    .then(function (raw) { return toCandles(raw, t); })
                    .catch(function () { return []; }));   // 이력 짧은 종목은 여기서 흡수
        });

        return Promise.all(calls).then(function (r) {
            var tf = {};
            direct.forEach(function (t, i) { tf[t.key] = r[i + 1] || []; });
            // 합성봉(업비트·빗썸의 8h·12h, MEXC의 12h). 바이낸스는 네이티브라 목록이 비어 있다.
            // 원본 봉의 길이를 넘겨야 합성 경계를 절대 시간에 고정할 수 있다.
            groupedTfs().forEach(function (t) {
                var 원본 = TFS.filter(function (x) { return x.key === t.from; })[0];
                tf[t.key] = groupCandles(tf[t.from] || [], t.group, 원본 ? 원본.sec : 0);
            });
            return { ticker: r[0], tf: tf };
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
        // 바이낸스를 보고 있으면 현재가가 이미 그 현물가라 다시 받을 이유가 없다.
        var spot = (ex().quote || "KRW") === "KRW"
            ? fetch("https://api.binance.com/api/v3/ticker/price?symbol=" + s)
                .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
            : Promise.resolve(null);
        return Promise.all([g(b + "/premiumIndex?symbol=" + s), g(b + "/openInterest?symbol=" + s), g(b + "/ticker/price?symbol=" + s), spot])
            .then(function (r) {
                if (!r[0] && !r[1] && !r[2] && !r[3]) return null;
                return {
                    funding: r[0] && r[0].lastFundingRate !== undefined ? parseFloat(r[0].lastFundingRate) * 100 : null,
                    oi: r[1] && r[1].openInterest ? parseFloat(r[1].openInterest) : null,
                    oiUnit: "Binance openInterest API 원단위(명목 USDT 아님)",
                    usdPrice: r[2] && r[2].price ? parseFloat(r[2].price) : null,
                    spotPrice: r[3] && r[3].price ? parseFloat(r[3].price) : null,
                    fundingTime: r[0] && r[0].time ? Number(r[0].time) : null,
                    nextFundingTime: r[0] && r[0].nextFundingTime ? Number(r[0].nextFundingTime) : null,
                    fetchedAt: Date.now(),
                    source: "Binance USDT-M 공개 API"
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
        // 선택 거래소와 무관하게 같은 환산 기준을 쓴다. 배포본에서는 기존 업비트
        // 화이트리스트 프록시를 사용하므로 바이낸스/MEXC를 선택해도 KRW를 병기할 수 있다.
        var url = LOCAL
            ? "https://api.upbit.com/v1/ticker?markets=KRW-USDT"
            : "/api/upbit?path=ticker&markets=KRW-USDT";
        return getJSON(url)
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

    /**
     * CoinGecko에서 USDT 도미넌스 계산에 필요한 두 원자료를 받는다.
     *
     * USDT.D는 USDT 가격이 아니라 시가총액 비중이다.
     * 따라서 전체 시장 시가총액과 USDT 시가총액을 같은 조회 시점에 받아
     * USDT 시가총액 ÷ 전체 시장 시가총액 × 100으로 계산한다.
     * 과거 시계열 API가 확인되지 않으면 현재값만 표시하고 값을 만들어내지 않는다.
     */
    function fetchUsdtDominance() {
        var base = "/api/coingecko";
        var globalUrl = base + "?path=global";
        var tetherUrl = base + "?path=simple%2Fprice&ids=tether"
            + "&vs_currencies=usd&include_market_cap=true&include_24hr_change=true";
        return Promise.all([
            getJSON(globalUrl),
            getJSON(tetherUrl)
        ]).then(function (r) {
            var g = r[0] && r[0].data;
            var tether = r[1] && r[1].tether;
            var total = g && g.total_market_cap && Number(g.total_market_cap.usd);
            var usdt = tether && Number(tether.usd_market_cap);
            if (!(total > 0) || !(usdt > 0)) return null;
            return {
                value: usdt / total * 100,
                totalMarketCap: total,
                usdtMarketCap: usdt,
                totalChange24h: g.market_cap_change_percentage_24h_usd,
                usdtChange24h: tether.usd_market_cap_change_24h,
                source: "CoinGecko /global + /simple/price",
                observedAt: new Date().toISOString()
            };
        }).catch(function () {
            // 도미넌스 데이터가 없어도 코인 분석 자체는 계속 진행한다.
            return null;
        });
    }

    // ---------------------------------------------------------------- 실시간 WebSocket

    /**
     * WebSocket은 CORS 대상이 아니라 브라우저에서 직접 붙는다.
     * REST 프록시와 달리 우회가 필요 없다. 빗썸도 업비트와 같은 프로토콜을 쓴다
     * (ticket/type/format 배열을 보내면 ticker가 흘러온다 — 실측 확인).
     */
    function connectWS(market) {
        closeWS();
        var e = ex();

        // MEXC는 WebSocket을 Protobuf로만 준다(구 JSON 채널은 "Blocked!"로 차단됨, 실측).
        // 스키마 파일과 디코더 라이브러리가 필요해 외부 의존성 없이는 붙일 수 없다.
        // 실시간 대신 자동갱신(폴링)으로 대체하고 그 사실을 화면에 밝힌다.
        if (!e.ws) {
            setWsState(false, "폴링");
            return;
        }

        var 바이낸스 = e.kind === "binance";
        var ws;
        // 바이낸스는 구독 메시지 없이 URL에 스트림을 박는다(btcusdt@ticker).
        var url = 바이낸스 ? e.ws + bnSymbol(market).toLowerCase() + "@ticker" : e.ws;
        try { ws = new WebSocket(url); }
        catch (err) { setWsState(false, "연결 실패"); return; }
        ws.binaryType = "arraybuffer";
        state.ws = ws;

        ws.onopen = function () {
            setWsState(true, "실시간");
            if (바이낸스) return;   // URL 구독이라 보낼 게 없다
            ws.send(JSON.stringify([
                { ticket: "kr-ta-" + market },
                { type: "ticker", codes: [market] },
                { format: "DEFAULT" }
            ]));
        };
        ws.onmessage = function (ev) {
            var d;
            try {
                var txt = typeof ev.data === "string" ? ev.data
                    : new TextDecoder("utf-8").decode(ev.data);
                d = JSON.parse(txt);
            } catch (err) { return; }
            if (!d) return;

            if (바이낸스) {
                // 바이낸스 틱을 업비트 형태로 바꿔 onTick에 넘긴다
                if (d.s !== bnSymbol(state.sel)) return;
                onTick({
                    code: state.sel,
                    trade_price: parseFloat(d.c),
                    signed_change_rate: parseFloat(d.P) / 100,
                    high_price: parseFloat(d.h),
                    low_price: parseFloat(d.l),
                    acc_trade_price_24h: parseFloat(d.q),
                    acc_trade_volume_24h: parseFloat(d.v)
                });
                return;
            }
            if (d.code !== state.sel) return;   // 종목 전환 직후 이전 소켓 잔여 메시지 차단
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
        // 폴링은 실시간(초록)과 끊김(회색) 어느 쪽도 아니다. 노란 점으로 구분한다.
        if (d) d.className = "dot" + (on ? " on" : txt === "폴링" ? " poll" : "");
        if (t) t.textContent = txt;
    }

    /** 체결이 올 때마다 마지막 캔들과 헤더 시세를 갱신한다. 재분석은 하지 않는다. */
    function onTick(d) {
        var price = d.trade_price;
        state.lastPrice = price;

        var el = $("q-price");
        if (el) {
            var chg = d.signed_change_rate * 100;
            // 첫 렌더와 동일하게 실시간 틱도 USDT 우선·KRW 병기 규칙을 유지한다.
            el.innerHTML = '<span class="' + cls(chg) + '">'
                + fmtPair(price, state.dp) + "</span>";
        }
        var ch = $("q-change");
        if (ch) {
            var c2 = d.signed_change_rate * 100;
            ch.innerHTML = '<span class="' + cls(c2) + '">' + pct(c2) + "</span>";
        }
        // 보조줄도 선택 시장의 원 통화와 환산 근거가 어긋나지 않게 같이 갱신한다.
        var us = $("q-usdsub");
        if (us) {
            if ((ex().quote || "KRW") === "KRW") {
                us.textContent = fmt(price, state.dp) + "원 · " + ex().name + " 현물";
            } else {
                us.textContent = state.usdtKrw
                    ? fmt(price * state.usdtKrw, 0) + "원 · 업비트 USDT/KRW 환산"
                    : "KRW 환산 확인 불가 · " + ex().name;
            }
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
                return { time: c.time, value: c.v, color: c.c >= c.o ? "rgba(38,166,154,.45)" : "rgba(239,83,80,.45)" };
            }));
        }
        var completedForMa = CandleUtils.completed(candles);
        CHART.ma.forEach(function (m) {
            if (maSeries[m.n]) maSeries[m.n].setData(sma(completedForMa, m.n));
        });
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
                background: { type: "solid", color: CHART.bg },
                textColor: CHART.text,
                fontFamily: "Inter, sans-serif", fontSize: 11
            },
            grid: {
                vertLines: { color: CHART.grid },
                horzLines: { color: CHART.grid }
            },
            rightPriceScale: { borderColor: CHART.border, scaleMargins: { top: .08, bottom: .26 } },
            timeScale: { borderColor: CHART.border, timeVisible: true, secondsVisible: false },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Normal,
                vertLine: { color: "rgba(63,74,90,.45)", width: 1, style: 3, labelBackgroundColor: "#3f4a5a" },
                horzLine: { color: "rgba(63,74,90,.45)", width: 1, style: 3, labelBackgroundColor: "#3f4a5a" }
            },
            localization: {
                locale: "ko-KR",
                priceFormatter: function (p) { return fmt(p, dp); }
            },
            // 확대·이동. 맨휠 확대는 차트 위에서 페이지 스크롤을 먹어 답답해진다.
            // Ctrl(⌘)+휠일 때만 확대하고, 드래그 이동과 축 드래그는 항상 켜 둔다.
            handleScroll: {
                mouseWheel: false,
                pressedMouseMove: true,
                horzTouchDrag: true,
                vertTouchDrag: false
            },
            handleScale: {
                mouseWheel: false,
                pinch: true,
                axisPressedMouseMove: { time: true, price: true },
                axisDoubleClickReset: true
            }
        });

        window.차트 = chart;   // 디버깅·외부 제어용

        candleSeries = chart.addCandlestickSeries({
            upColor: CHART.up, downColor: CHART.down,
            borderUpColor: CHART.up, borderDownColor: CHART.down,
            wickUpColor: CHART.up, wickDownColor: CHART.down,
            priceFormat: { type: "price", precision: dp, minMove: Math.pow(10, -dp) }
        });
        candleSeries.setData(candles.map(function (c) {
            return { time: c.time, open: c.o, high: c.h, low: c.l, close: c.c };
        }));

        // 이동평균. 미완성 봉을 제외하고 캔들 위에 얹어야 가려지지 않는다.
        maSeries = {};
        var completedForMa = CandleUtils.completed(candles);
        CHART.ma.forEach(function (m) {
            if (completedForMa.length < m.n) return;   // 봉이 모자라면 아예 안 그린다
            var ls = chart.addLineSeries({
                color: m.color, lineWidth: 1.5,
                priceLineVisible: false, lastValueVisible: true,
                crosshairMarkerVisible: false,
                title: m.label,
                priceFormat: { type: "price", precision: dp, minMove: Math.pow(10, -dp) }
            });
            ls.setData(sma(completedForMa, m.n));
            maSeries[m.n] = ls;
        });

        volumeSeries = chart.addHistogramSeries({
            priceFormat: { type: "volume" },
            priceScaleId: "vol",
            color: "rgba(38,166,154,.4)"
        });
        chart.priceScale("vol").applyOptions({ scaleMargins: { top: .82, bottom: 0 } });
        volumeSeries.setData(candles.map(function (c) {
            return { time: c.time, value: c.v, color: c.c >= c.o ? "rgba(38,166,154,.45)" : "rgba(239,83,80,.45)" };
        }));

        drawLevelLines(levels, dp);
        chart.timeScale().fitContent();
        updateLegend(candles[candles.length - 1]);
        bindZoom(host);

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

        /**
         * 레벨선.
         * 밝은 배경에서는 투명도로 강약을 주면 흐려서 안 보인다.
         * 색 자체를 단계로 나눈다 — 가까운 벽일수록 진하고 두껍게.
         */
        function add(price, 순번, rank, label, kind) {
            var 팔레트 = kind === "res" ? CHART.res : kind === "sup" ? CHART.sup : null;
            var color = 팔레트 ? 팔레트[Math.min(순번, 팔레트.length - 1)] : CHART.floor;
            // 3개 봉 이상이 지목한 벽은 굵은 실선, 나머지는 얇은 파선
            var width = rank >= 4 ? 2 : rank === 3 ? 2 : 1;
            try {
                priceLines.push(candleSeries.createPriceLine({
                    price: price,
                    color: color,
                    lineWidth: width,
                    lineStyle: rank >= 3 ? 0 : 2,
                    axisLabelVisible: true,
                    lineVisible: true,
                    title: label
                }));
            } catch (e) {}
        }

        // 가까운 순으로 1차·2차·3차. 스크린샷의 "1차 저항선 / 2차 저항선 / 3차 강력 저항선" 표기를 따른다.
        var 차수 = ["1차", "2차", "3차"];
        (lv.resistance || []).slice(0, 5).forEach(function (x, i) {
            var 이름 = i < 3 ? 차수[i] + " 저항" : "저항";
            if (i === 2) 이름 = "★3차 강력 저항";
            add(x.price, i, x.strength.rank, 이름 + (x.tfCount >= 2 ? " " + x.tfCount + "봉" : ""), "res");
        });
        (lv.support || []).slice(0, 5).forEach(function (x, i) {
            var 이름 = i < 3 ? 차수[i] + " 지지" : "지지";
            if (i === 2) 이름 = "★3차 강력 지지";
            add(x.price, i, x.strength.rank, 이름 + (x.tfCount >= 2 ? " " + x.tfCount + "봉" : ""), "sup");
        });
        if (lv.마지노선) add(lv.마지노선.price, 0, 4, "마지노선 " + lv.마지노선.tf, "floor");
        updateLevelLegend(lv, dp);
    }

    /** 차트 안에서 지지·저항선의 색과 가격을 함께 보여준다. */
    function updateLevelLegend(lv, dp) {
        var el = $("levelLegend");
        if (!el || !lv || lv.error) return;
        var html = [];
        (lv.resistance || []).slice(0, 3).forEach(function (x, i) {
            html.push('<div class="ll-item" style="color:' + CHART.res[Math.min(i, CHART.res.length - 1)] + '">━ ' + (i + 1) + '차 저항 ' + fmt(x.price, dp) + '</div>');
        });
        (lv.support || []).slice(0, 3).forEach(function (x, i) {
            html.push('<div class="ll-item" style="color:' + CHART.sup[Math.min(i, CHART.sup.length - 1)] + '">━ ' + (i + 1) + '차 지지 ' + fmt(x.price, dp) + '</div>');
        });
        if (lv.마지노선) {
            html.push('<div class="ll-item" style="color:' + CHART.floor + '">┅ 마지노선 ' + fmt(lv.마지노선.price, dp) + '</div>');
        }
        el.innerHTML = html.join('');
    }

    /** 범례. 밝은 차트 위에 얹히므로 배경도 밝게 간다. */
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

    function render(market, data, fut, usdtKrw, bankFx, usdtDominance) {
        var t = data.ticker;
        var price = t.trade_price;
        var dp = decimals(price);
        state.dp = dp;
        state.tfCandles = data.tf;
        var analysisTf = {};
        activeTfs().forEach(function (tf) {
            analysisTf[tf.key] = CandleUtils.completed(data.tf[tf.key] || []);
        });
        state.analysisTfCandles = analysisTf;
        state.lastPrice = price;
        state.usdPrice = fut && fut.usdPrice ? fut.usdPrice : null;
        state.usdtKrw = usdtKrw || null;     // 김프 기준 환율 (업비트 USDT)
        state.bankFx = bankFx || null;       // 참고용 은행 환율
        state.analysisAt = Date.now();
        state.tickerAt = CandleUtils.tickerTimeMs(t);
        state.fxAt = usdtKrw ? Date.now() : null;
        state.usdtDominance = usdtDominance || null;

        var name = (state.markets.filter(function (m) { return m.market === market; })[0] || {}).korean_name || market;
        var sym = coinOf(market);

        // 지표 계산
        var results = {};
        activeTfs().forEach(function (tf) {
            var c = analysisTf[tf.key];
            results[tf.key] = (c && c.length >= 30)
                ? TAEngine.analyzeTf(c.map(function (x) {
                    return { time: x.time, endTime: x.endTime, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v };
                }))
                : { error: "캔들 부족 (" + (c ? c.length : 0) + "봉)" };
        });

        // 지지·저항. levels:false인 봉(년봉)은 표본이 부족해 levelTfs()가 이미 뺀다.
        var conv = {};
        levelTfs().forEach(function (tf) {
            var c = analysisTf[tf.key];
            if (c && c.length >= 20) {
                conv[tf.key] = c.map(function (x) { return { high: x.h, low: x.l, close: x.c, volume: x.v }; });
            }
        });
        var lv = LevelEngine.analyze(conv, price, { limit: 7 });
        state.levels = lv;

        // 타점 산출. 지표·레벨이 다 나온 뒤라야 계산할 수 있다.
        var sig = typeof SignalEngine !== "undefined"
            ? SignalEngine.analyze(results, lv, price, fut)
            : { error: "signal_engine.js가 로드되지 않았습니다." };
        state.signal = sig;
        var v41 = typeof V41Analysis !== "undefined"
            ? V41Analysis.analyze(analysisTf, TAEngine)
            : { error: "v41_analysis.js가 로드되지 않았습니다.", frames: {} };
        state.v41 = v41;
        syncApiHint(analysisTf, CandleUtils.tickerTimeMs(t));

        // 같은 종목·같은 봉을 다시 그릴 때는 DOM을 통째로 갈아끼우지 않는다.
        // innerHTML 교체 + 차트 재생성이 자동갱신마다 화면을 깜빡이게 만든다.
        var sameView = state.renderedFor === market && $("chart") && chart;

        if (sameView) {
            // 시세 스트립과 분석 표만 내용 교체. 차트는 데이터만 밀어넣는다.
            replaceSection("sec-quotes", renderQuotes(t, price, dp, name, sym, fut, usdtKrw, bankFx));
            replaceSection("sec-v41", renderV41Panel(market, results, v41, lv, sig, fut, t, dp));
            replaceSection("sec-dominance", renderDominance(usdtDominance));
            replaceSection("sec-summary", renderSummary(results));
            replaceSection("sec-levels", renderLevels(lv, dp));
            replaceSection("sec-signal", renderSignal(sig, dp));
            replaceSection("sec-detail", renderDetail(results, dp));
            replaceSection("sec-scenario", renderScenario(lv, dp));
            if (!updateChartData(data.tf[state.chartTf], lv, dp)) {
                buildChart(data.tf[state.chartTf], lv, dp);
            }
        } else {
            var html = [];
            html.push('<div id="sec-quotes">' + renderQuotes(t, price, dp, name, sym, fut, usdtKrw, bankFx) + "</div>");
            html.push(renderV41Panel(market, results, v41, lv, sig, fut, t, dp));
            html.push('<div id="sec-dominance">' + renderDominance(usdtDominance) + "</div>");
            html.push(renderChartSection(sym));
            html.push('<div id="sec-summary">' + renderSummary(results) + "</div>");
            html.push('<div id="sec-levels">' + renderLevels(lv, dp) + "</div>");
            html.push(renderSignal(sig, dp));
            html.push('<div id="sec-detail">' + renderDetail(results, dp) + "</div>");
            html.push('<div id="sec-scenario">' + renderScenario(lv, dp) + "</div>");
            $("out").innerHTML = html.join("");
            buildChart(data.tf[state.chartTf], lv, dp);
            state.renderedFor = market;
        }
        $("updatedAt") && ($("updatedAt").textContent = new Date().toLocaleTimeString("ko-KR"));

        window.분석결과 = {
            market: market,
            results: results,
            ticker: t,
            futures: fut,
            v41: v41,
            v3: v41,
            usdtDominance: usdtDominance
        };
        window.레벨결과 = lv;
        window.타점결과 = sig;
        window.V41분석결과 = v41;
        window.V3분석결과 = v41;

        // 히어로 자리(설명 문구가 있던 곳)에도 타점을 띄운다.
        renderHeroSignal(sym, sig, dp);

        // 알림은 렌더 뒤에 돌린다. 화면과 알림 내용이 어긋나면 안 된다.
        checkSignalAlerts(market, sig, dp);
    }

    /**
     * 확대 조작을 붙인다. 차트를 다시 만들어도 host는 같은 노드라 한 번만 배선한다.
     *
     * 맨휠을 확대에 쓰면 차트 위에서 페이지가 안 내려간다.
     * Ctrl/⌘ + 휠일 때만 확대하고, 맨휠은 페이지 스크롤로 흘려보낸다.
     * (Ctrl+휠은 브라우저 기본 확대이기도 해서 preventDefault가 필요하다.)
     */
    function bindZoom(host) {
        if (!host || host.dataset.zoomBound === "1") return;
        host.dataset.zoomBound = "1";

        host.addEventListener("wheel", function (e) {
            if (!chart) return;
            if (!(e.ctrlKey || e.metaKey)) return;   // 맨휠은 페이지 스크롤에 양보
            e.preventDefault();
            zoomBy(e.deltaY < 0 ? 0.8 : 1.25);
        }, { passive: false });

        host.addEventListener("dblclick", function () {
            if (chart) chart.timeScale().fitContent();   // 전체 구간으로 복귀
        });
    }

    /**
     * 보이는 봉 개수를 factor배로 바꾼다. factor<1이면 확대(봉이 적게 보임).
     * 화면 가운데를 축으로 잡아야 보던 구간이 튀지 않는다.
     */
    function zoomBy(factor) {
        if (!chart) return;
        var ts = chart.timeScale();
        var r = ts.getVisibleLogicalRange();
        if (!r) return;
        var span = r.to - r.from;
        var mid = (r.to + r.from) / 2;
        var next = span * factor;
        if (next < 8) next = 8;          // 더 확대하면 캔들 몇 개만 남아 쓸모없다
        if (next > 1500) next = 1500;
        ts.setVisibleLogicalRange({ from: mid - next / 2, to: mid + next / 2 });
    }

    /** 최근 n봉만 보여준다. n이 없거나 전체보다 크면 전체 구간. */
    function showRecent(n) {
        if (!chart || !state.tfCandles) return;
        var total = (state.tfCandles[state.chartTf] || []).length;
        if (!total) return;
        var ts = chart.timeScale();
        if (!n || n >= total) { ts.fitContent(); return; }
        ts.setVisibleLogicalRange({ from: total - n, to: total });
    }

    // ------------------------------------------------------------ 전체화면

    /**
     * 차트 카드를 전체화면으로 띄운다.
     *
     * 대상은 #chart가 아니라 카드 전체다. 캔버스만 띄우면 줌 툴바와
     * 범례가 빠져 조작을 못 한다.
     *
     * lightweight-charts는 autoSize로 컨테이너를 따라가지만, 전체화면 전환은
     * 리사이즈 이벤트가 늦게 와서 한 번 더 밀어줘야 크기가 맞는다.
     */
    function toggleFullscreen() {
        var card = document.querySelector("#chart-sec .card");
        if (!card) return;

        // 이미 확대 상태면 해제
        if (document.fullscreenElement) {
            (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
            return;
        }
        if (card.classList.contains("is-fs")) { setPseudoFs(false); return; }

        var req = card.requestFullscreen || card.webkitRequestFullscreen;
        if (!req) { setPseudoFs(true); return; }

        // Fullscreen API는 iframe·임베디드 브라우저에서 권한 없이 거부된다
        // ("Permissions check failed"). 그때는 페이지 안에서 꽉 채우는 모드로 대체한다.
        var p;
        try { p = req.call(card); } catch (e) { setPseudoFs(true); return; }
        if (p && p.catch) p.catch(function () { setPseudoFs(true); });
    }

    /** 브라우저 전체화면을 못 쓸 때의 대체 — 뷰포트를 덮는 고정 레이어 */
    function setPseudoFs(on) {
        var card = document.querySelector("#chart-sec .card");
        if (!card) return;
        card.classList.toggle("is-fs", on);
        card.classList.toggle("pseudo-fs", on);
        document.body.style.overflow = on ? "hidden" : "";
        var b = $("fsBtn");
        if (b) {
            b.textContent = on ? "⛶ 해제" : "⛶ 전체화면";
            b.classList.toggle("on", on);
        }
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                resizeChart();
                if (chart) chart.timeScale().fitContent();
            });
        });
    }

    function onFsChange() {
        var on = !!document.fullscreenElement;
        var card = document.querySelector("#chart-sec .card");
        if (card) card.classList.toggle("is-fs", on);
        var b = $("fsBtn");
        if (b) {
            b.textContent = on ? "⛶ 해제" : "⛶ 전체화면";
            b.classList.toggle("on", on);
        }
        // 전환 직후에는 컨테이너 크기가 아직 안 잡힌다. 두 프레임 뒤에 다시 맞춘다.
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                resizeChart();
                if (chart) chart.timeScale().fitContent();
            });
        });
    }

    // ------------------------------------------------------------ 브리핑 생성

    /**
     * coin-ta-brief 스킬의 A형(지지·저항 중심) 출력을 마크다운으로 만든다.
     *
     * 화면에 같은 수치가 이미 있지만, 스킬 형식 텍스트는 그대로 복사해
     * 메모·채팅에 붙이거나 다른 분석과 나란히 두기 좋다.
     *
     * 스킬 6절 규칙을 지킨다: 없는 데이터는 "데이터 없음"이라 쓰고 지어내지 않는다.
     * 뉴스·언락은 웹 검색이 필요해 브라우저에서 만들 수 없으므로 그대로 밝힌다.
     */
    function buildBrief() {
        var r = window.분석결과, lv = window.레벨결과;
        if (!r || !lv) return "분석 결과가 없습니다. 먼저 분석을 실행하세요.";

        var t = r.ticker, price = t.trade_price, dp = state.dp;
        var sym = coinOf(r.market);
        var name = (state.markets.filter(function (m) { return m.market === r.market; })[0] || {}).korean_name || sym;
        // 통화에 맞춘 포맷. 바이낸스는 $를 붙여야 원화와 헷갈리지 않는다.
        var 원화브리핑0 = (ex().quote || "KRW") === "KRW";
        var f = function (v) { return 원화브리핑0 ? fmt(v, dp) : fmtUsd(v); };
        var L = [];

        var 원화브리핑 = 원화브리핑0;
        // 바이낸스는 한글명이 없어 코인명이 곧 심볼이다. 중복 표기를 피한다.
        var 제목 = name === sym ? sym : name + "(" + sym + ")";
        L.push("## " + 제목 + " 지지·저항 — 현재 " + f(price) + (원화브리핑 ? "원" : ""));
        L.push("");

        var head = ex().name + " " + f(price) + " · 24h " + pct(t.signed_change_rate * 100);
        if (state.usdtKrw && 원화브리핑) head += " · USDT 환산 " + fmtUsd(price / state.usdtKrw);
        L.push(head);

        if (r.futures) {
            var fu = [];
            if (r.futures.funding !== null && r.futures.funding !== undefined) {
                fu.push("펀딩 " + r.futures.funding.toFixed(4) + "%");
            }
            if (r.futures.oi) fu.push("OI " + fmt(r.futures.oi, 0) + " (API 원단위)");
            if (r.futures.spotPrice && state.usdtKrw && 원화브리핑) {
                fu.push("김프 " + pct((price / (r.futures.spotPrice * state.usdtKrw) - 1) * 100));
            }
            if (fu.length) L.push(fu.join(" · ") + "  (바이낸스)");
        } else {
            L.push("바이낸스 선물 미상장 — 펀딩·OI·김프 데이터 없음");
        }
        L.push("");

        // 테더 도미넌스는 USDT 가격이 아니라 시가총액 비중이다.
        // 현재값을 받지 못한 경우 숫자를 만들지 않고 확인 불가로 남긴다.
        L.push("### 테더 도미넌스 (USDT.D)");
        if (r.usdtDominance && isFinite(r.usdtDominance.value)) {
            L.push("- 현재 USDT.D: " + r.usdtDominance.value.toFixed(3) + "%");
            L.push("- USDT 시가총액: " + fmtUsd(r.usdtDominance.usdtMarketCap));
            L.push("- 전체 시장 시가총액: " + fmtUsd(r.usdtDominance.totalMarketCap));
            L.push("- 방향성: 현재값만 확인했으며, 시계열 없이 상승·하락을 확정하지 않음");
            L.push("- 출처: " + r.usdtDominance.source);
        } else {
            L.push("- USDT 도미넌스 현재 데이터 확인 불가");
        }
        L.push("");

        var 표 = function (제목, 행들, 방향) {
            L.push("### " + 제목);
            if (!행들.length) {
                L.push("- " + (방향 === "up" ? "구간 최고 위 — 저항 공백" : "구간 최저 아래 — 지지 공백"));
                L.push("");
                return;
            }
            L.push("| 레벨 | 거리 | 근거 |");
            L.push("|---|---|---|");
            행들.forEach(function (x) {
                var 강조 = x.strength.rank >= 3 ? "**" : "";
                L.push("| " + 강조 + f(x.price) + 강조
                    + " | " + (x.거리pct >= 0 ? "+" : "") + x.거리pct.toFixed(2) + "%"
                    + " | " + x.strength.label + " · " + x.reason + " |");
            });
            L.push("");
        };
        표("저항 (위로)", lv.resistance, "up");
        표("지지 (아래)", lv.support, "down");

        if (lv.마지노선) {
            L.push("**마지노선** " + f(lv.마지노선.price)
                + " (" + lv.마지노선.tf + " 최저, 현재가 대비 "
                + (((price - lv.마지노선.price) / price) * 100).toFixed(1) + "% 아래)");
            L.push("이탈 시 이 구간에 지지가 없습니다.");
            L.push("");
        }

        L.push("### 시간봉별");
        L.push("| 봉 | 추세 | 수렴 | RSI | 슈퍼트렌드 | 거래량 |");
        L.push("|---|---|---|---|---|---|");
        activeTfs().forEach(function (tf) {
            var d = r.results[tf.key];
            if (!d || d.error) {
                L.push("| " + tf.label + " | " + (d ? d.error : "데이터 없음") + " | — | — | — | — |");
                return;
            }
            // 지표는 표본이 모자라거나 완전 횡보면 null이 된다.
            // (ATR 0이면 슈퍼트렌드 null, 20봉 거래량이 0이면 신뢰도 null)
            var rsi = d.oscillators.rsi14;
            var st = d.trend.supertrend;
            var vr = d.volume.reliability;
            L.push("| " + tf.label
                + " | " + d.trend.bias
                + " | " + (d.confluence.net_pct >= 0 ? "+" : "") + d.confluence.net_pct + "%"
                + " | " + (rsi === null || rsi === undefined ? "—" : rsi.toFixed(1))
                + " | " + (st ? st.trend : "—")
                + " | " + (vr ? vr.split("(")[0] : "—")
                + " |");
        });
        L.push("");

        // 스킬 기준: net_pct 절대값 40 이상만 방향성 신뢰
        var 강 = activeTfs().filter(function (tf) {
            var d = r.results[tf.key];
            return d && !d.error && Math.abs(d.confluence.net_pct) >= 40;
        });
        if (강.length) {
            L.push("**방향성 신뢰 구간(±40 이상)**: " + 강.map(function (tf) {
                var d = r.results[tf.key];
                return tf.label + " " + (d.confluence.net_pct > 0 ? "강세" : "약세")
                    + " " + d.confluence.net_pct + "%";
            }).join(" · "));
        } else {
            L.push("**전 봉 수렴도 ±40 미만 — 방향성 신뢰 구간 미달, 관망 구간**");
        }
        L.push("");

        L.push("### 시나리오");
        if (lv.직상) {
            var 다음R = lv.resistance[1];
            L.push("- **" + f(lv.직상.price) + " 돌파 + 유지** → "
                + (다음R ? f(다음R.price) : "위쪽 벽 소진"));
        }
        if (lv.직하) {
            var 다음S = lv.support[1];
            L.push("- **" + f(lv.직하.price) + " 이탈** → "
                + (다음S ? f(다음S.price)
                    : (lv.마지노선 ? f(lv.마지노선.price) + "(마지노선)까지 공백" : "지지 공백")));
        }
        if (lv.경고 && lv.경고.length) {
            lv.경고.forEach(function (w) { L.push("- (!) " + w); });
        }
        L.push("");

        L.push("### 움직임 원인 / 락업·언락");
        L.push("웹 검색이 필요한 항목이라 이 페이지에서는 조사할 수 없습니다.");
        L.push("터미널에서 coin-ta-brief 스킬을 쓰면 뉴스·언락 일정까지 포함됩니다.");
        L.push("");

        var 봉목록 = activeTfs().filter(function (tf) {
            var d = r.results[tf.key];
            return d && !d.error;
        }).map(function (tf) { return tf.label; }).join("/");
        var 제외 = activeTfs().filter(function (x) { return !x.levels; })
            .map(function (x) { return x.label; }).join(", ");
        L.push("---");
        L.push("계산 봉: " + 봉목록 + " · 각 200봉 · " + ex().name + " 공개 API");
        if (제외) L.push("지지·저항 계산 제외: " + 제외 + " (표본 부족)");
        L.push("기술적 수치 계산 결과이며 투자 권유가 아닙니다.");

        return L.join("\n");
    }

    /** 화면과 같은 스냅샷을 코인분석스킬 V4.1 출력 형식으로 직렬화한다. */
    function buildV41Brief() {
        var r = window.분석결과, lv = window.레벨결과, sig = window.타점결과;
        if (!r || !lv) return "분석 결과가 없습니다. 먼저 분석을 실행하세요.";
        var v41 = r.v41 || window.V41분석결과 || {};
        var t = r.ticker, price = t.trade_price, dp = state.dp;
        var sym = coinOf(r.market);
        var name = (state.markets.filter(function (m) { return m.market === r.market; })[0] || {}).korean_name || sym;
        var title = name === sym ? sym : name + "(" + sym + ")";
        var L = [];
        var completed = state.analysisTfCandles || {};
        var c4 = completed["4h"] || [];
        var last4 = c4.length ? c4[c4.length - 1] : null;

        L.push("# " + title + " — AI MASTER CRYPTO ANALYST V4.1");
        L.push("");
        L.push("## ■ 분석 기준");
        L.push("- 종목/시장: " + r.market + " · " + ex().name + " 현물");
        L.push("- 현재가: " + fmtPair(price, dp));
        L.push("- 시세 기준 시각: " + kst(state.tickerAt));
        L.push("- 마지막 확정 4시간봉: " + (last4 && isFinite(last4.endTime) ? kst(last4.endTime * 1000) : "확인 불가"));
        L.push("- OHLCV 출처: " + ex().name + " 현물 공개 API · 최대 200봉 · 지표는 완료봉만 사용");
        L.push("- KRW 환산: 업비트 KRW-USDT 공개 시세 · " + kst(state.fxAt));
        L.push("- 데이터 계약: 같은 종목·거래소 현물 OHLCV · 완료봉 기준 · 미완성 봉 지표 제외");
        L.push("");

        L.push("## ■ PART 0. USDT 도미넌스와 시장 위험선호");
        if (r.usdtDominance && isFinite(r.usdtDominance.value)) {
            var dominanceAt = r.usdtDominance.observedAt ? Date.parse(r.usdtDominance.observedAt) : r.usdtDominance.fetchedAt;
            L.push("- 현재 USDT.D: " + r.usdtDominance.value.toFixed(3) + "% · " + kst(dominanceAt));
            L.push("- 계산: USDT 시가총액 ÷ 전체 암호화폐 시가총액 × 100");
            L.push("- 방향성: 현재값만 확인 가능해 1W/1D/4H/1H 상승·하락은 확인 불가");
            L.push("- BTC·BTC.D·전체 시가총액과의 교차검증: 브라우저 원자료 부족으로 현재 확인 불가");
            L.push("- 단독 매매 신호로 사용하지 않음 · 출처: " + r.usdtDominance.source);
        } else {
            L.push("- USDT 도미넌스 현재 데이터 확인 불가");
        }
        L.push("");

        L.push("## ■ PART 1. 기술적 차트 분석");
        L.push("### 멀티 타임프레임");
        ["1M", "1w", "1d", "12h", "4h", "1h"].forEach(function (key) {
            var d = r.results[key];
            if (!d) return;
            if (d.error) { L.push("- " + key + ": " + d.error); return; }
            var a = d.trend.adx;
            var adxText = a ? "ADX " + a.adx + "(" + (a.plus_di >= a.minus_di ? "+DI" : "-DI") + " 우세)" : "ADX 표본 부족";
            L.push("- " + key + ": " + d.trend.bias + " · " + adxText
                + " · 수렴 " + (d.confluence.net_pct >= 0 ? "+" : "") + d.confluence.net_pct + "%"
                + " · RSI " + (d.oscillators.rsi14 === null ? "—" : d.oscillators.rsi14)
                + " · SuperTrend " + (d.trend.supertrend ? d.trend.supertrend.trend : "—"));
        });
        var primary = v41.primary_tf && r.results[v41.primary_tf] ? r.results[v41.primary_tf] : null;
        if (primary) {
            L.push("- SMA20/60/120/200기간(" + v41.primary_tf + "): "
                + [20, 60, 120, 200].map(function (n) {
                    return "SMA" + n + " " + (primary.trend.ma[n] ? fmtPair(primary.trend.ma[n], dp) : "표본 부족");
                }).join(" · "));
            var osc = primary.oscillators || {};
            L.push("- 모멘텀 근거군(중복 점수화 금지): RSI " + (osc.rsi14 === null ? "—" : osc.rsi14)
                + " · CCI " + (osc.cci20 === null ? "—" : osc.cci20)
                + " · Stochastic(14,3,3) " + (osc.stochastic ? osc.stochastic.k + "/" + osc.stochastic.d : "—")
                + " · MACD hist " + (osc.macd && osc.macd.hist !== null ? osc.macd.hist : "—"));
            L.push("- Bollinger(20,2): " + (primary.bollinger
                ? "상단 " + fmtPair(primary.bollinger.upper, dp) + " · 중앙 " + fmtPair(primary.bollinger.mid, dp)
                    + " · 하단 " + fmtPair(primary.bollinger.lower, dp) + " · 폭 " + primary.bollinger.bandwidth_pct + "%"
                : "표본 부족"));
            L.push("- VWAP: " + (primary.vwap ? fmtPair(primary.vwap, dp) + " · 조회 구간 첫 확정 봉 앵커" : "표본 부족"));
        }
        L.push("- 근거 품질: 기술 데이터 A(공식 공개 API·완료봉), 나머지는 항목별 가용성");
        L.push("");

        function levelTable(label, rows) {
            L.push("### " + label);
            if (!rows || !rows.length) { L.push("- 확인 구간 없음"); L.push(""); return; }
            L.push("| 가격 | 거리 | 근거 |");
            L.push("|---|---:|---|");
            rows.slice(0, 4).forEach(function (x) {
                L.push("| " + fmtPair(x.price, dp) + " | " + (x.거리pct >= 0 ? "+" : "") + x.거리pct.toFixed(2) + "% | " + x.strength.label + " · " + x.reason + " |");
            });
            L.push("");
        }
        L.push("## ■ 핵심 유동성 구간");
        levelTable("강한 저항대", lv.resistance);
        levelTable("핵심 지지대", lv.support);
        var activeFvg = (v41.fvg || []).filter(function (x) { return x.status !== "완전 메움"; }).slice(-3).reverse();
        var activeOb = (v41.order_blocks || []).filter(function (x) { return x.status !== "무효"; }).slice(-3).reverse();
        L.push("- FVG: " + (activeFvg.length ? activeFvg.map(function (x) {
            return (x.type === "bullish" ? "상승" : "하락") + " " + fmtPair(x.lower, dp) + " ~ " + fmtPair(x.upper, dp) + "(" + x.status + " " + x.filled_pct + "%)";
        }).join(" / ") : "확인된 활성 구간 없음"));
        L.push("- 오더블록: " + (activeOb.length ? activeOb.map(function (x) {
            return (x.type === "bullish" ? "상승" : "하락") + " " + fmtPair(x.lower, dp) + " ~ " + fmtPair(x.upper, dp) + "(" + x.quality + ")";
        }).join(" / ") : "확인된 유효 구간 없음"));
        L.push("- 근사 VPVR POC/VAH/VAL/HVN: OHLCV 범위분배 · 체결별 원자료 아님 · LVN 미산출");
        L.push("");

        L.push("### 모멘텀 및 파동 구조");
        L.push("- RSI 다이버전스: " + (primary && primary.oscillators.rsi_divergence ? primary.oscillators.rsi_divergence : "확인된 일반 다이버전스 없음"));
        if (v41.fibonacci) {
            L.push("- 피보나치 " + v41.fibonacci.direction + ": 0.382 " + fmtPair(v41.fibonacci.levels["0.382"], dp)
                + " · 0.5 " + fmtPair(v41.fibonacci.levels["0.5"], dp)
                + " · 0.618 " + fmtPair(v41.fibonacci.levels["0.618"], dp)
                + " · 0.786 " + fmtPair(v41.fibonacci.levels["0.786"], dp));
        } else {
            L.push("- 피보나치: 확정 스윙 한 쌍 부족");
        }
        L.push("- 엘리엇 파동: 규칙 기반 유일 카운트를 검증할 수 없어 자동 단정하지 않음");
        L.push("");

        L.push("## ■ PART 2. 선물 시장과 군중 심리");
        if (r.futures) {
            L.push("- 펀딩비: " + (r.futures.funding === null ? "현재 실시간 데이터 확인 불가" : r.futures.funding.toFixed(4) + "%"));
            L.push("- 다음 펀딩 시각: " + (r.futures.nextFundingTime ? kst(r.futures.nextFundingTime) : "확인 불가"));
            L.push("- OI: " + (r.futures.oi === null ? "현재 실시간 데이터 확인 불가" : fmt(r.futures.oi, 0) + " · " + r.futures.oiUnit));
            L.push("- 출처/시각: " + (r.futures.source || "Binance USDT-M 공개 API") + " · " + kst(r.futures.fetchedAt));
            L.push("- 시장 구분: 현재 기술분석은 " + ex().name + " 현물, 펀딩·OI는 Binance USDT-M 선물 보조자료");
        } else {
            L.push("- 펀딩비/OI: 바이낸스 USDT-M 미상장 또는 조회 실패 — 현재 실시간 데이터 확인 불가");
        }
        L.push("- CVD/청산맵: 현재 실시간 데이터 확인 불가");
        L.push("");

        L.push("## ■ PART 3. 온체인 데이터와 고래 동향");
        L.push("- 거래소 순유입·순유출: 현재 실시간 데이터 확인 불가");
        L.push("- 고래 이동·주소 라벨: 현재 실시간 데이터 확인 불가");
        L.push("- MVRV/SOPR: 현재 실시간 데이터 확인 불가");
        L.push("");

        L.push("## ■ PART 4. 토큰노믹스와 프로젝트 펀더멘털");
        L.push("- 토큰 언락·고래 이동·파트너십·뉴스: 브라우저 OHLCV만으로 검증 불가 — 현재 실시간 데이터 확인 불가");
        L.push("- 뉴스: 현재 실시간 데이터 확인 불가 · 웹 조사 미수행이며 실제 뉴스 부재를 뜻하지 않음");
        L.push("");

        L.push("## ■ PART 5. 리스크 관리와 실행 전략");
        L.push("### 롱 셋업");
        if (sig && sig.entry && sig.entry.side === "LONG") {
            L.push("- 발동 조건: 상위봉 방향과 1시간 타이밍 조건 충족");
            L.push("- 진입: " + fmtPair(sig.entry.entry, dp));
            L.push("- 손절/무효화: " + fmtPair(sig.entry.stop, dp));
            L.push("- 목표 1/2: " + fmtPair(sig.entry.target1, dp) + (sig.entry.target2 ? " / " + fmtPair(sig.entry.target2, dp) : ""));
            L.push("- 손익비: " + sig.entry.rr.toFixed(2) + "R · 수수료·슬리피지 미반영");
        } else {
            L.push("- 발동 조건: " + (lv.직상 ? fmtPair(lv.직상.price, dp) + " 돌파 후 확정 봉 유지·재지지" : "상단 돌파 기준 확인 불가"));
            L.push("- 현재 판단: 관망 · " + (sig && sig.blocked ? sig.blocked : "롱 조건 미충족"));
        }
        L.push("");

        L.push("### 포지션 관리");
        L.push("- 계좌 위험액 = 계좌 평가액 × 허용 위험률");
        L.push("- 기본 포지션 수량 = 계좌 위험액 ÷ |진입가-손절가|");
        L.push("- 계좌 규모·위험 성향이 없어 고정 레버리지와 수량은 산정하지 않음");
        L.push("- 청산가가 구조적 손절보다 먼저 오는 레버리지는 사용 금지");
        L.push("");
        L.push("### 숏 셋업 또는 관망");
        if (sig && sig.entry && sig.entry.side === "SHORT") {
            L.push("- 발동 조건: 상위봉 방향과 1시간 타이밍 조건 충족");
            L.push("- 진입: " + fmtPair(sig.entry.entry, dp));
            L.push("- 손절/무효화: " + fmtPair(sig.entry.stop, dp));
            L.push("- 목표 1/2: " + fmtPair(sig.entry.target1, dp) + (sig.entry.target2 ? " / " + fmtPair(sig.entry.target2, dp) : ""));
            L.push("- 손익비: " + sig.entry.rr.toFixed(2) + "R · 수수료·슬리피지 미반영");
        } else {
            L.push("- 발동 조건: " + (lv.직하 ? fmtPair(lv.직하.price, dp) + " 이탈 후 되돌림 저항" : "하단 이탈 기준 확인 불가"));
            L.push("- 현재 판단: " + (sig && sig.entry && sig.entry.side === "LONG" ? "롱 우위이므로 숏 관망" : "조건 확인 전 관망"));
        }
        L.push("");

        L.push("## ■ 최종 판단");
        L.push("- 우세 시나리오: " + (sig && sig.entry ? (sig.entry.side === "LONG" ? "조건부 롱" : "조건부 숏") : "관망"));
        L.push("- 판단 변경 조건: 상위봉 방향 전환 또는 핵심 지지·저항의 확정 봉 돌파/이탈");
        L.push("- 확인 불가: 뉴스·언락·고래·온체인·CVD·청산맵");
        L.push("- 주요 위험: API 지연, 거래소 간 가격 차이, 미반영 수수료·슬리피지, 급변 이벤트");
        L.push("- 멘탈케어: 좋은 자리는 쫓아가는 자리가 아니라, 조건이 먼저 와서 기다려 주는 자리입니다.");
        L.push("");
        L.push("## ■ Executive Summary");
        L.push("1. 현재 구조: " + (primary ? primary.trend.bias + " · " + v41.primary_tf + " 기준" : "표본 부족"));
        L.push("2. 핵심 조건: " + (lv.직상 ? fmtPair(lv.직상.price, dp) + " 돌파" : "상단 확인 불가")
            + " / " + (lv.직하 ? fmtPair(lv.직하.price, dp) + " 이탈" : "하단 확인 불가"));
        L.push("3. 실행 판단: " + (sig && sig.entry ? (sig.entry.side === "LONG" ? "조건부 롱" : "조건부 숏") : "관망"));
        L.push("");
        L.push("---");
        L.push("규칙 기반 조건부 분석이며 투자 권유나 수익 보장이 아닙니다. 백테스트 없는 승률·확률은 표시하지 않습니다.");
        return L.join("\n");
    }

    function openBrief() {
        var box = $("brief");
        if (!box) return;
        $("briefText").value = buildV41Brief();
        box.style.display = "";
        box.scrollIntoView({ block: "center", behavior: "smooth" });
    }

    function copyBrief() {
        var ta = $("briefText");
        if (!ta) return;
        ta.select();
        var ok = false;
        try { ok = document.execCommand("copy"); } catch (e) {}
        if (ok) { flashCopied(); return; }
        if (navigator.clipboard) {
            navigator.clipboard.writeText(ta.value).then(flashCopied, function () {});
        }
    }

    function flashCopied() {
        var b = $("briefCopy");
        if (!b) return;
        var 원래 = b.textContent;
        b.textContent = "복사됨";
        setTimeout(function () { b.textContent = 원래; }, 1400);
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
        var 원화 = (ex().quote || "KRW") === "KRW";

        // V3 규칙에 맞춰 USDT를 주값으로, KRW를 보조값으로 표시한다.
        var primaryPrice = fmtPair(price, dp);
        var usdSub = 원화
            ? esc(name) + " (" + sym + ") · " + ex().name + " 현물 · " + (usdtKrw ? "업비트 USDT/KRW 환산" : "USDT 환산 확인 불가")
            : esc(name) + " · " + ex().name + " 현물 · " + (usdtKrw ? "업비트 USDT/KRW 환산" : "KRW 환산 확인 불가");
        out.push(qb("현재가", '<span class="' + cls(chg) + '">'
            + primaryPrice + "</span>",
            '<span id="q-usdsub">' + usdSub + "</span>"));
        out.push(qb("24시간 변동", '<span class="' + cls(chg) + '">' + pct(chg) + "</span>",
            "고 " + (원화 ? fmt(t.high_price, dp) : fmtUsd(t.high_price))
            + " / 저 " + (원화 ? fmt(t.low_price, dp) : fmtUsd(t.low_price))));

        // 거래대금 단위: 원화는 억, USDT는 백만 달러
        var 대금 = 원화
            ? (t.acc_trade_price_24h / 1e8).toFixed(1) + '<span style="font-size:13px;font-weight:600"> 억</span>'
            : (t.acc_trade_price_24h / 1e6).toFixed(1) + '<span style="font-size:13px;font-weight:600"> M$</span>';
        out.push(qb("24시간 거래대금", 대금, "체결량 " + fmt(t.acc_trade_volume_24h, 2)));
        if (fut) {
            out.push(qb("펀딩비 <span class='dim'>· 바이낸스</span>",
                fut.funding === null ? "—" : '<span class="' + (fut.funding >= 0 ? "up" : "down") + '">' + fut.funding.toFixed(4) + "%</span>",
                fut.funding === null ? "데이터 없음" : (fut.funding > 0
                    ? "롱이 숏에 비용 지급 · 롱 과열 가능"
                    : fut.funding < 0 ? "숏이 롱에 비용 지급 · 숏 과열 가능" : "중립")));
            out.push(qb("미결제약정 <span class='dim'>· 바이낸스</span>",
                fut.oi === null ? "—" : fmt(fut.oi, 0), fut.oi === null ? "데이터 없음" : "Binance openInterest API 원단위 · 명목 USDT 아님"));
            // 김프 표준은 현물가 기준이다. 현물이 없으면 선물로 대체하고 그 사실을 표기한다.
            var refUsd = fut.spotPrice || fut.usdPrice;
            var isSpot = !!fut.spotPrice;
            // 이미 USDT로 보고 있으면 "USDT 가격" 칸은 현재가와 같은 값이라 뺀다
            if (refUsd && 원화) {
                out.push(qb("USDT 가격 <span class='dim'>· 바이낸스" + (isSpot ? " 현물" : " 선물") + "</span>",
                    '<span id="q-usd">' + fmtUsd(refUsd) + "</span>",
                    usdtKrw ? "환산 " + fmt(refUsd * usdtKrw, dp) + "원" : "환율 데이터 없음"));
            }
            // 김치 프리미엄은 원화 시세 + **현물** 달러가가 있어야 성립한다.
            //
            // 선물가로 계산하면 안 된다. 선물엔 베이시스(만기·펀딩에 따른 괴리)가
            // 섞여 있어서, 그 값은 "국내 프리미엄"이 아니라 "국내 프리미엄 + 베이시스"다.
            // 현물이 없으면 숫자를 지어내는 대신 없다고 밝힌다.
            if (usdtKrw && 원화) {
                if (fut.spotPrice) {
                    var kp = (price / (fut.spotPrice * usdtKrw) - 1) * 100;
                    out.push(qb("김치 프리미엄", '<span class="' + cls(kp) + '">' + pct(kp) + "</span>",
                        "바이낸스 현물 · USDT " + fmt(usdtKrw, 1) + "원 기준"
                        + (bankFx ? " · 은행 " + fmt(bankFx, 1) + "원" : "")));
                } else {
                    out.push(qb("김치 프리미엄", '<span class="dim" style="font-size:17px">데이터 없음</span>',
                        "바이낸스 현물 미상장 — 선물가로는 계산하지 않습니다"));
                }
            }
        } else {
            out.push(qb("펀딩비 · 미결제약정", '<span class="dim" style="font-size:17px">데이터 없음</span>', "바이낸스 USDT-M 미상장"));
        }
        out.push("</div>");
        return out.join("");
    }

    /** V4.1의 PART 0~5 분석을 현재 선택 종목의 같은 계산 스냅샷으로 표시한다. */
    function renderV41Panel(market, results, v41, lv, sig, fut, ticker, dp) {
        var sym = coinOf(market);
        var price = ticker.trade_price;
        var primary = v41 && v41.primary_tf ? results[v41.primary_tf] : null;
        var completed = state.analysisTfCandles || {};
        var c4 = completed["4h"] || [];
        var last4 = c4.length ? c4[c4.length - 1] : null;

        function item(label, value) {
            return '<div class="scn"><span class="scn-i">◆</span><div><b>' + esc(label) + '</b> · ' + value + "</div></div>";
        }
        function levelList(items, kind) {
            var visible = (items || []).filter(function (x) {
                return kind === "fvg" ? x.status !== "완전 메움" : x.status !== "무효";
            }).slice(-3).reverse();
            if (!visible.length) return "확인된 활성 구간 없음";
            return visible.map(function (x) {
                var label = x.type === "bullish" ? "상승" : "하락";
                var suffix = kind === "fvg" ? x.status + " " + x.filled_pct + "%" : x.quality + " · " + x.status;
                return label + " " + fmtPair(x.lower, dp) + " ~ " + fmtPair(x.upper, dp) + " (" + suffix + ")";
            }).join("<br>");
        }

        var frames = ["1M", "1w", "1d", "12h", "4h", "1h"].filter(function (key) { return results[key]; });
        var frameSummary = frames.map(function (key) {
            var d = results[key];
            if (!d || d.error) return key + " 표본 부족";
            var a = d.trend && d.trend.adx;
            return key + " " + d.trend.bias + " · ADX " + (a ? a.adx : "—")
                + (a ? " (" + (a.plus_di >= a.minus_di ? "+DI 우세" : "-DI 우세") + ")" : "");
        }).join("<br>");

        var ma = primary && primary.trend ? primary.trend.ma : {};
        var fib = v41 && v41.fibonacci;
        var fibText = fib
            ? fib.direction + " · 0.382 " + fmtPair(fib.levels["0.382"], dp)
                + " · 0.5 " + fmtPair(fib.levels["0.5"], dp)
                + " · 0.618 " + fmtPair(fib.levels["0.618"], dp)
            : "확정 스윙 한 쌍 부족";
        var divergence = primary && primary.oscillators && primary.oscillators.rsi_divergence
            ? esc(primary.oscillators.rsi_divergence) : "확인된 일반 다이버전스 없음";

        var derivatives = fut
            ? "펀딩 " + (fut.funding === null ? "데이터 없음" : fut.funding.toFixed(4) + "%")
                + " · OI " + (fut.oi === null ? "데이터 없음" : fmt(fut.oi, 0) + " " + esc(fut.oiUnit || "API 원단위"))
                + "<br><span class=\"dim\">" + esc(fut.source || "Binance USDT-M 공개 API") + " · " + kst(fut.fetchedAt) + "</span>"
            : "바이낸스 USDT-M 미상장 또는 조회 실패 — 현재 실시간 데이터 확인 불가";

        var execution;
        if (sig && sig.entry) {
            var entry = sig.entry;
            execution = (entry.side === "LONG" ? "롱" : "숏") + " 조건 충족 · 진입 " + fmtPair(entry.entry, dp)
                + " · 손절/무효화 " + fmtPair(entry.stop, dp)
                + " · 목표 " + fmtPair(entry.target1, dp)
                + " · " + entry.rr.toFixed(2) + "R (수수료·슬리피지 미반영)";
        } else {
            execution = "관망 · " + esc(sig && sig.blocked ? sig.blocked : "조건부 신호 데이터 부족");
        }
        var conditional = [];
        if (lv && lv.직상) conditional.push("롱 대안: " + fmtPair(lv.직상.price, dp) + " 돌파 후 확정 봉 유지·재지지 확인");
        if (lv && lv.직하) conditional.push("숏 대안: " + fmtPair(lv.직하.price, dp) + " 이탈 후 되돌림 저항 확인");

        var part1a = item("멀티 타임프레임", frameSummary || "표본 부족")
            + item("MA 20/60/120/200기간 · " + (v41 && v41.primary_tf ? v41.primary_tf : "—"),
                [20, 60, 120, 200].map(function (n) { return "SMA" + n + " " + (ma && ma[n] ? fmtPair(ma[n], dp) : "표본 부족"); }).join("<br>"))
            + item("FVG", levelList(v41 && v41.fvg, "fvg"))
            + item("오더블록", levelList(v41 && v41.order_blocks, "ob"));
        var part1b = item("피보나치", fibText)
            + item("RSI 다이버전스", divergence)
            + item("모멘텀", "RSI·CCI·Stochastic(14,3,3)·MACD는 한 근거군 · 중복 점수화 금지")
            + item("VPVR·VWAP", "VPVR은 OHLCV 범위분배 근사 · VWAP은 조회 구간 첫 확정 봉 앵커");
        var part2 = item("펀딩·OI", derivatives)
            + item("CVD·청산맵", "현재 실시간 데이터 확인 불가");
        var part3 = item("거래소 순유입·고래·MVRV·SOPR", "검증 가능한 온체인 원자료 없음 · 현재 실시간 데이터 확인 불가");
        var part4 = item("뉴스·토큰 언락·기관·생태계", "브라우저 OHLCV만으로 검증 불가 · 현재 실시간 데이터 확인 불가");
        var part5 = item("현재 실행 판단", execution)
            + (conditional.length ? item("조건부 대안", conditional.join("<br>")) : "")
            + item("포지션 관리", "계좌 위험액=평가액×허용 위험률 · 계좌 정보가 없어 고정 레버리지/수량 산정 안 함")
            + item("근거 품질", "기술 데이터 A(공식 공개 API·완료봉) · 파생/온체인/펀더멘털은 항목별 가용성 적용");

        return '<section id="sec-v41"><div class="sec-head"><h2>V4.1 PART 0~5 통합 분석</h2>'
            + '<span class="tag">확정 봉 · 근거 우선 · 승률 추정 없음</span></div>'
            + '<div class="card card-pad" style="margin-bottom:14px">'
            + item("분석 기준", esc(sym + " · " + ex().name + " 현물") + " · 현재 " + fmtPair(price, dp)
                + "<br><span class=\"dim\">시세 " + kst(state.tickerAt) + " · 최근 완료 4h "
                + (last4 && isFinite(last4.endTime) ? kst(last4.endTime * 1000) : "확인 불가")
                + " · USDT/KRW 업비트 공개 API " + kst(state.fxAt) + "</span>")
            + "</div>"
            + '<div class="grid2">'
            + '<div class="card card-pad"><b>PART 1 · 기술적 추세와 유동성</b>' + part1a + "</div>"
            + '<div class="card card-pad"><b>PART 1 · 모멘텀과 구조</b>' + part1b + "</div>"
            + '<div class="card card-pad"><b>PART 2 · 파생상품 심리</b>' + part2 + "</div>"
            + '<div class="card card-pad"><b>PART 3 · 온체인과 고래</b>' + part3 + "</div>"
            + '<div class="card card-pad"><b>PART 4 · 펀더멘털</b>' + part4 + "</div>"
            + "</div>"
            + '<div class="card card-pad" style="margin-top:14px"><b>PART 5 · 리스크 관리와 실행</b>' + part5
            + '<div class="warn">규칙 기반 조건부 분석이며 투자 권유나 수익 보장이 아닙니다.</div></div></section>';
    }

    /**
     * 테더 도미넌스 패널.
     *
     * CoinGecko 공개 현재값만으로 계산하므로 방향성을 과장하지 않는다.
     * 과거 시계열을 확보하지 못한 경우에도 현재 도미넌스와 계산 원자료는
     * 보여주되, 상승·하락 결론은 "확인 불가"로 남긴다.
     */
    function renderDominance(d) {
        if (!d) {
            return '<section><div class="sec-head"><h2>PART 0 · 테더 도미넌스 (USDT.D)</h2>'
                + '<span class="tag">시장 전체 보조지표</span></div>'
                + '<div class="card card-pad"><div class="dim">USDT 도미넌스 현재 데이터 확인 불가</div>'
                + '<div class="reason">CoinGecko 공개 API 또는 네트워크 응답을 확인하지 못했습니다. 코인별 분석은 계속 표시합니다.</div></div></section>';
        }

        var value = Number(d.value);
        var total = Number(d.totalMarketCap);
        var usdt = Number(d.usdtMarketCap);
        var money = function (n) {
            if (!(n > 0)) return "확인 불가";
            if (n >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T";
            if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
            return "$" + (n / 1e6).toFixed(1) + "M";
        };
        var observed = d.observedAt ? new Date(d.observedAt).toLocaleString("ko-KR") : "확인 불가";

        return '<section><div class="sec-head"><h2>PART 0 · 테더 도미넌스 (USDT.D)</h2>'
            + '<span class="tag">USDT 시가총액 ÷ 전체 시장 시가총액</span></div>'
            + '<div class="grid2">'
            + '<div class="card card-pad">'
            + '<div class="qk">현재 USDT.D</div>'
            + '<div class="qv" style="font-size:30px;color:#7c5cff">' + value.toFixed(3) + '%</div>'
            + '<div class="qs">현재값 확인 · 방향성은 시계열 추가 확인 필요</div>'
            + '</div>'
            + '<div class="card card-pad">'
            + '<table><tbody>'
            + '<tr><td class="dim">USDT 시가총액</td><td class="num">' + money(usdt) + '</td></tr>'
            + '<tr><td class="dim">전체 시장 시가총액</td><td class="num">' + money(total) + '</td></tr>'
            + '<tr><td class="dim">BTC·알트코인 해석</td><td>USDT.D 단독 확정 금지</td></tr>'
            + '<tr><td class="dim">자료 시각</td><td class="num">' + esc(observed) + '</td></tr>'
            + '</tbody></table>'
            + '</div></div>'
            + '<div class="card card-pad" style="margin-top:14px;font-size:13px">'
            + '<b>해석 규칙</b> · USDT.D 상승은 위험회피 가능성, 하락은 위험선호 가능성을 뜻할 수 있습니다. '
            + '단, BTC 가격·BTC 도미넌스·전체 시가총액·거래량과 함께 확인해야 하며 현재값만으로 롱·숏을 결정하지 않습니다.'
            + '<div class="reason">출처: ' + esc(d.source || "CoinGecko") + ' · 근거 품질: B</div>'
            + '</div></section>';
    }

    function renderChartSection(sym) {
        var lbl = (TFS.filter(function (x) { return x.key === state.chartTf; })[0] || {}).label || "";
        return '<section id="chart-sec"><div class="sec-head"><h2>' + esc(sym) + " " + lbl + ' 차트</h2>'
            + '<span class="tag">실시간 체결 반영</span>'
            + '<span class="tag" id="updatedAt">—</span></div>'
            + '<div class="card">'
            + '<div class="zoom-bar">'
            +   '<button type="button" data-zoom="in" title="확대 (Ctrl+휠 위)">＋</button>'
            +   '<button type="button" data-zoom="out" title="축소 (Ctrl+휠 아래)">－</button>'
            +   '<span class="zoom-sep"></span>'
            +   '<button type="button" data-recent="30">30봉</button>'
            +   '<button type="button" data-recent="60">60봉</button>'
            +   '<button type="button" data-recent="120">120봉</button>'
            +   '<button type="button" data-recent="0" title="전체 (차트 더블클릭)">전체</button>'
            +   '<span class="zoom-sep"></span>'
            +   '<button type="button" id="fsBtn" class="fs-btn" title="전체화면 (F 또는 Esc로 해제)">⛶ 전체화면</button>'
            + "</div>"
            + '<div class="chart-shell">'
            + '<div id="chart"></div><div class="chart-legend" id="legend"></div><div class="level-legend" id="levelLegend"></div>'
            + "</div>"
            + '<div class="chart-note">'
            + '<span class="swatch"><i class="sw" style="background:' + CHART.res[0] + '"></i> 저항</span>'
            + '<span class="swatch"><i class="sw" style="background:' + CHART.sup[0] + '"></i> 지지</span>'
            + '<span class="swatch"><i class="sw" style="background:' + CHART.floor + '"></i> 마지노선</span>'
            + '<span class="swatch">' + CHART.ma.map(function (m) {
                return '<i class="sw" style="background:' + m.color + '"></i> ' + m.label;
              }).join(" ") + "</span>"
            + '<span class="dim">실선 = 3개 봉 이상이 지목 · 파선 = 1~2개. 선이 굵을수록 두꺼운 벽</span>'
            + '<span class="dim">확대: Ctrl+휠 · 드래그로 이동 · 더블클릭 전체</span>'
            + "</div></div></section>";
    }

    function renderSummary(results) {
        var rows = activeTfs().map(function (tf) {
            var r = results[tf.key];
            // 거래소가 지원하지 않는 봉은 아예 없을 수 있다(빗썸엔 년봉이 없다)
            if (!r) return "";
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
        var blocks = activeTfs().map(function (tf) {
            var r = results[tf.key];
            if (!r || r.error) return "";
            var o = r.oscillators, bb = r.bollinger, v = r.volume;
            var L = [];
            function row(k, val) { return '<tr><td class="dim">' + k + '</td><td class="num mono">' + val + "</td></tr>"; }
            L.push(row("RSI(14)", o.rsi14 === null ? "—" : '<span class="' + (o.rsi14 >= 70 ? "down" : o.rsi14 <= 30 ? "up" : "") + '">' + o.rsi14 + "</span>"));
            if (o.stochastic) L.push(row("스토캐스틱(14,3,3) K/D", o.stochastic.k + " / " + o.stochastic.d));
            if (o.cci20 !== null) L.push(row("CCI(20)", '<span class="' + (o.cci20 >= 100 ? "down" : o.cci20 <= -100 ? "up" : "") + '">' + o.cci20 + "</span>"));
            if (o.macd) L.push(row("MACD 히스토그램", o.macd.hist === null ? "—" : '<span class="' + (o.macd.hist > 0 ? "up" : "down") + '">' + fmt(o.macd.hist, dp) + "</span>"));
            if (bb) {
                L.push(row("볼린저 %B", '<span class="' + (bb.pct_b >= 1 ? "down" : bb.pct_b <= 0 ? "up" : "") + '">' + bb.pct_b + "</span>"));
                L.push(row("밴드폭", bb.bandwidth_pct + "%" + (bb.bandwidth_pct < 3 ? ' <span class="neu">수축</span>' : "")));
            }
            if (r.vwap) L.push(row("VWAP · 조회 구간 첫 확정 봉 앵커", fmt(r.vwap, dp)));
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

    /**
     * 타점 패널.
     *
     * 진입 신호가 없을 때 빈 화면을 두지 않고 **왜 없는지**를 쓴다.
     * "지금은 신호 없음"이 정상 출력이고, 그 이유가 보여야 사용자가 판단할 수 있다.
     */
    function renderSignal(sig, dp) {
        if (!sig || sig.error) {
            return '<section id="sec-signal"><div class="sec-head"><h2>롱·숏 타점</h2></div>'
                + '<div class="card card-pad"><div class="dim">' + esc(sig ? sig.error : "데이터 없음")
                + "</div></div></section>";
        }

        var L = [];
        var 방향 = sig.방향;

        // 방향 요약
        var dirTxt = 방향.dir === "LONG" ? '<b class="down">롱 우위</b>'
            : 방향.dir === "SHORT" ? '<b class="up">숏 우위</b>'
            : '<b class="dim">방향성 부족</b>';
        L.push('<div class="scn"><span class="scn-i">◆</span><div>' + dirTxt
            + ' · 상위봉 평균 수렴 ' + (방향.avg >= 0 ? "+" : "") + 방향.avg + "%"
            + ' <span class="dim">(' + 방향.tfs.map(function (x) {
                return x.tf + " " + (x.net >= 0 ? "+" : "") + x.net + "%";
            }).join(" · ") + " · 일치율 " + 방향.agree + "%)</span></div></div>");

        if (sig.entry) {
            var e = sig.entry;
            var 롱 = e.side === "LONG";
            var cls = 롱 ? "down" : "up";
            L.push('<div class="scn"><span class="scn-i ' + cls + '">' + (롱 ? "▲" : "▼") + "</span><div>"
                + '<b class="' + cls + '">' + (롱 ? "롱" : "숏") + " 진입 " + fmt(e.entry, dp) + "</b>"
                + " · 손절 <b>" + fmt(e.stop, dp) + "</b>"
                + " · 목표 <b>" + fmt(e.target1, dp) + "</b>"
                + (e.target2 ? " → " + fmt(e.target2, dp) : "")
                + ' <span class="dim">(손익비 ' + e.rr.toFixed(2) + "R)</span>"
                + '<div class="dim" style="margin-top:4px">기준 ' + (롱 ? "지지" : "저항") + " "
                + fmt(e.기준벽.price, dp) + " · " + esc(e.기준벽.reason || "")
                + "</div></div></div>");
            L.push('<div class="scn"><span class="scn-i" style="color:var(--gold)">■</span>'
                + '<div class="dim">무효화: ' + fmt(e.stop, dp) + " 이탈 시 이 계획은 폐기됩니다.</div></div>");
        } else if (sig.blocked) {
            L.push('<div class="scn"><span class="scn-i dim">—</span><div><b>진입 신호 없음</b> · '
                + esc(sig.blocked) + "</div></div>");
            // 기각된 계획도 참고로 보여준다. 그 자리까지 오면 유효해질 수 있다.
            if (sig.rejected) {
                var r = sig.rejected;
                L.push('<div class="scn"><span class="scn-i dim">·</span><div class="dim">참고 계획: '
                    + (r.side === "LONG" ? "롱" : "숏") + " 진입 " + fmt(r.entry, dp)
                    + " · 손절 " + fmt(r.stop, dp) + " · 목표 " + fmt(r.target1, dp)
                    + " (" + r.rr.toFixed(2) + "R)</div></div>");
            }
        }

        // 청산 신호
        var 청산 = [];
        ["long", "short"].forEach(function (k) {
            (sig.exits[k] || []).forEach(function (x) {
                청산.push({ side: k, level: x.level, text: x.text, price: x.price });
            });
        });
        if (청산.length) {
            청산.forEach(function (x) {
                var 색 = x.level === "긴급" ? "var(--red)" : "var(--gold)";
                L.push('<div class="scn"><span class="scn-i" style="color:' + 색 + '">!</span><div>'
                    + '<b style="color:' + 색 + '">' + (x.side === "long" ? "롱" : "숏") + " 보유 시 청산 검토 · " + x.level + "</b> — "
                    + esc(x.text)
                    + (isFinite(x.price) ? " <b>" + fmt(x.price, dp) + "</b>" : "")
                    + "</div></div>");
            });
        }

        return '<section id="sec-signal"><div class="sec-head"><h2>롱·숏 타점</h2>'
            + '<span class="dim" style="font-size:12.5px">규칙 기반 산출 · ' + esc(SIGNAL_BACKTEST.status) + '</span></div>'
            + '<div class="card card-pad">' + L.join("")
            + '<div class="warn">' + esc(SIGNAL_BACKTEST.summary) + ' · ' + esc(SIGNAL_BACKTEST.detail) + '<br>지표에서 기계적으로 계산한 값입니다. 규칙이 틀리면 결과도 틀립니다. '
            + "손절을 반드시 함께 쓰고, 이 화면만 보고 매매하지 마세요.</div></div></section>";
    }

    /**
     * 히어로(화면 최상단) 자리의 타점 알림.
     *
     * 분석 전에는 서비스 설명이 있던 자리다. 분석하면 그 자리를 타점이 차지한다.
     * 스크롤 없이 바로 보이는 위치라, 여기 있는 내용이 가장 먼저 읽힌다.
     * 그래서 진입가·손절·목표만 굵게 넣고 근거는 작게 붙인다.
     */
    function renderHeroSignal(sym, sig, dp) {
        var el = $("heroSignal");
        if (!el) return;
        el.classList.add("sig");

        if (!sig || sig.error) {
            el.innerHTML = '<div class="hsig none"><span class="ico">—</span><div>'
                + esc(sig ? sig.error : "분석 데이터 없음") + "</div></div>";
            return;
        }

        var H = [];

        if (sig.entry) {
            var e = sig.entry;
            var 롱 = e.side === "LONG";
            H.push('<div class="hsig ' + (롱 ? "long" : "short") + '">'
                + '<span class="ico">' + (롱 ? "▲" : "▼") + "</span><div>"
                + "<b>" + esc(sym) + " " + (롱 ? "롱" : "숏") + " 진입 "
                + '<span class="nums">' + fmt(e.entry, dp) + "</span></b>"
                + ' <span class="nums">· 손절 ' + fmt(e.stop, dp)
                + " · 목표 " + fmt(e.target1, dp)
                + (e.target2 ? " → " + fmt(e.target2, dp) : "")
                + " · " + e.rr.toFixed(2) + "R</span>"
                + '<span class="sub">' + esc(e.기준벽.reason || "") + '<br>'
                + esc(SIGNAL_BACKTEST.status + " · " + SIGNAL_BACKTEST.summary) + "</span>"
                + "</div></div>");
        } else if (sig.blocked) {
            H.push('<div class="hsig none"><span class="ico">—</span><div>'
                + "<b>" + esc(sym) + " 진입 신호 없음</b>"
                + '<span class="sub">' + esc(sig.blocked) + '<br>'
                + esc(SIGNAL_BACKTEST.status + " · " + SIGNAL_BACKTEST.summary) + "</span>"
                + "</div></div>");
        }

        // 청산 신호는 포지션을 들고 있는 사람에게 더 급한 정보라 진입 아래 붙인다.
        ["long", "short"].forEach(function (k) {
            (sig.exits[k] || []).forEach(function (x) {
                var 긴급 = x.level === "긴급";
                H.push('<div class="hsig ' + (긴급 ? "urgent" : "warn-x") + '">'
                    + '<span class="ico">' + (긴급 ? "!" : "·") + "</span><div>"
                    + "<b>" + (k === "long" ? "롱" : "숏") + " 보유 시 청산 검토 · " + esc(x.level) + "</b> "
                    + esc(x.text)
                    + (isFinite(x.price) ? ' <span class="nums">' + fmt(x.price, dp) + "</span>" : "")
                    + "</div></div>");
            });
        });

        el.innerHTML = H.join("");
    }

    // ---------------------------------------------------------------- 타점 알림

    /**
     * 신호가 **새로 생겼을 때만** 알린다.
     *
     * 자동갱신이 10초마다 도는데 조건이 유지되는 동안 계속 알리면
     * 알림이 무의미해지고 사용자가 꺼버린다. 그래서 신호의 정체성을
     * 문자열 키로 만들어, 직전과 같으면 건너뛴다.
     *
     * 키에 진입가를 넣는 이유: 같은 롱이라도 기준 벽이 바뀌면 다른 계획이다.
     * 반올림해서 넣어야 소수점 흔들림으로 중복 알림이 뜨지 않는다.
     */
    function signalKey(market, sig) {
        if (!sig || sig.error) return null;
        var parts = [market];
        if (sig.entry) {
            parts.push("E", sig.entry.side, Math.round(sig.entry.entry), Math.round(sig.entry.stop));
        }
        // 청산 사유는 종류만 넣는다. 문구의 숫자까지 넣으면 매 틱 달라진다.
        ["long", "short"].forEach(function (k) {
            (sig.exits[k] || []).forEach(function (x) {
                parts.push("X", k, x.level, x.text.slice(0, 12));
            });
        });
        return parts.length > 1 ? parts.join("|") : null;
    }

    function notify(title, body) {
        try {
            if (!("Notification" in window)) return;
            if (Notification.permission !== "granted") return;
            new Notification(title, { body: body, tag: "upbit-signal" });
        } catch (e) {
            console.warn("알림 실패:", e);
        }
    }

    function checkSignalAlerts(market, sig, dp) {
        if (!state.alertOn) return;
        var key = signalKey(market, sig);
        if (!key) { state.lastSignalKey = null; return; }
        if (key === state.lastSignalKey) return;   // 같은 신호 반복 금지
        state.lastSignalKey = key;

        var sym = coinOf(market);
        var 줄 = [];

        if (sig.entry) {
            var e = sig.entry;
            줄.push((e.side === "LONG" ? "롱" : "숏") + " 진입 " + fmt(e.entry, dp)
                + " / 손절 " + fmt(e.stop, dp) + " / 목표 " + fmt(e.target1, dp)
                + " (" + e.rr.toFixed(2) + "R)");
        }
        ["long", "short"].forEach(function (k) {
            (sig.exits[k] || []).forEach(function (x) {
                줄.push((k === "long" ? "롱" : "숏") + " 청산(" + x.level + ") " + x.text
                    + (isFinite(x.price) ? " " + fmt(x.price, dp) : ""));
            });
        });

        if (!줄.length) return;
        notify(sym + " 타점 신호", 줄.join("\n"));
    }

    function toggleAlert() {
        var b = $("alertBtn");
        if (state.alertOn) {
            state.alertOn = false;
            state.lastSignalKey = null;
            b.textContent = "타점 알림 OFF";
            b.classList.remove("on");
            return;
        }
        // 권한이 없으면 먼저 요청한다. 거부하면 화면 패널만 쓰도록 안내한다.
        if (!("Notification" in window)) {
            alert("이 브라우저는 알림을 지원하지 않습니다. 화면의 '롱·숏 타점' 패널을 보세요.");
            return;
        }
        if (Notification.permission === "denied") {
            alert("브라우저에서 이 사이트 알림이 차단돼 있습니다.\n주소창 옆 자물쇠 > 알림 허용으로 바꿔주세요.\n(차단 상태에서도 화면의 '롱·숏 타점' 패널은 그대로 동작합니다.)");
            return;
        }
        var 켜기 = function () {
            state.alertOn = true;
            state.lastSignalKey = null;   // 켠 직후 현재 신호를 한 번 알린다
            b.textContent = "타점 알림 ON";
            b.classList.add("on");
            if (state.signal) checkSignalAlerts(state.sel, state.signal, state.dp);
        };
        if (Notification.permission === "granted") 켜기();
        else Notification.requestPermission().then(function (p) {
            if (p === "granted") 켜기();
            else alert("알림이 허용되지 않았습니다. 화면의 '롱·숏 타점' 패널을 보세요.");
        });
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
            + '<div class="warn">뉴스·락업·언락·고래·온체인은 브라우저 OHLCV만으로 검증할 수 없어 '
            + "현재 실시간 데이터 확인 불가로 표시합니다.</div></div></section>";
    }

    // ---------------------------------------------------------------- 실행

    /** TradingView의 USDT.D 시계열 차트를 보여주는 전용 화면을 만든다. */
    function renderUsdtDominanceChart(d) {
        var chartUrl = "https://www.tradingview.com/widgetembed/?frameElementId=tradingview_usdtd"
            + "&symbol=CRYPTOCAP%3AUSDT.D&interval=D&hidesidetoolbar=0&symboledit=0"
            + "&saveimage=1&toolbarbg=f1f3f6&studies=PivotPointsStandard%40tv-basicstudies&theme=light&style=1"
            + "&timezone=Asia%2FSeoul&withdateranges=1&hideideas=1&hidelegend=0"
            + "&hidevolume=1&allow_symbol_change=0";
        var current = d ? renderDominance(d) : renderDominance(null);
        return '<div class="loading" style="display:none"></div>'
            + current
            + '<section id="chart-sec"><div class="sec-head"><h2>테더 도미넌스 (USDT.D) 차트</h2>'
            + '<span class="tag">TradingView · CRYPTOCAP:USDT.D · 피벗 지지/저항</span>'
            + '<span class="tag">일봉</span></div>'
            + '<div class="card" style="overflow:hidden">'
            + '<div style="height:560px;background:#fff">'
            + '<iframe title="테더 도미넌스 차트" src="' + chartUrl + '" '
            + 'style="width:100%;height:100%;border:0" loading="eager" allowfullscreen></iframe>'
            + '</div>'
            + '<div class="chart-note" style="padding:12px 16px">'
            + '<span class="swatch"><i class="sw" style="background:#7c5cff"></i> USDT 도미넌스</span>'
            + '<span class="dim">검색어: 테더 도미넌스 · USDT.D</span>'
            + '</div></div>'
            + '<div class="card card-pad" style="margin-top:14px;font-size:13px">'
            + '<b>읽는 방법</b> · USDT.D 상승은 시장 자금의 위험회피 가능성, 하락은 위험선호 가능성을 시사할 수 있습니다. '
            + 'BTC 가격·BTC 도미넌스·전체 시가총액과 함께 확인해야 하며, 이 지표 하나만으로 매매 방향을 확정하지 않습니다.'
            + '<div class="reason">차트 출처: TradingView CRYPTOCAP:USDT.D · 피벗 지지/저항: TradingView 표준 지표 · 현재값 출처: CoinGecko · 투자 권유 아님</div>'
            + '</div></section>';
    }

    /** 특수 지표 선택 시 일반 코인 분석 대신 USDT.D 화면을 표시한다. */
    function showUsdtDominanceChart() {
        if (state.busy) return;
        state.busy = true;
        state.sel = "__USDT_DOMINANCE__";
        state.renderedFor = "__USDT_DOMINANCE__";
        var layout = $("mainLayout");
        if (layout) layout.classList.add("usdtd-mode");
        closeWS();
        if (state.timer) { clearTimeout(state.timer); state.timer = null; }
        $("run").disabled = true;
        $("out").innerHTML = '<div class="loading"><span class="spin"></span>테더 도미넌스 차트 준비 중…</div>';
        fetchUsdtDominance().then(function (d) {
            state.usdtDominance = d;
            $("out").innerHTML = renderUsdtDominanceChart(d);
            $("updatedAt") && ($("updatedAt").textContent = new Date().toLocaleTimeString("ko-KR"));
            window.분석결과 = { market: "USDT.D", usdtDominance: d, chartSource: "TradingView CRYPTOCAP:USDT.D" };
        }).catch(function () {
            $("out").innerHTML = renderUsdtDominanceChart(null);
        }).then(function () {
            state.busy = false;
            $("run").disabled = false;
        });
    }

    function run() {
        var selected = $("market").value || state.sel;
        if (isUsdtDominanceMarket(selected)) {
            showUsdtDominanceChart();
            return;
        }
        var layout = $("mainLayout");
        if (layout) layout.classList.remove("usdtd-mode");
        if (state.busy) return;
        state.busy = true;
        var market = selected;
        state.sel = market;
        var sym = coinOf(market);
        $("run").disabled = true;
        // 로딩 화면은 처음 그릴 때만. 자동갱신마다 띄우면 그 자체가 깜빡임이다.
        if (state.renderedFor !== market) {
            state.renderedFor = null;
            $("out").innerHTML = '<div class="loading"><span class="spin"></span>' + esc(sym) + " 분석 중…</div>";
        }

        fetchAll(market)
            .then(function (data) {
                return Promise.all([
                    data,
                    fetchFutures(sym),
                    fetchUsdtKrw(),
                    fetchBankFx(),
                    fetchUsdtDominance()
                ]);
            })
            .then(function (r) {
                render(market, r[0], r[1], r[2], r[3], r[4]);
                connectWS(market);
            })
            .catch(function (e) {
                // 실패해도 상태 표시는 맞춰둔다. WebSocket이 없는 거래소는 "폴링"이다.
                setWsState(false, ex().ws ? "연결 대기" : "폴링");
                $("out").innerHTML = '<div class="err"><b>데이터를 불러오지 못했습니다.</b><br>'
                    + esc(e && e.message ? e.message : String(e))
                    + '<div class="dim" style="margin-top:8px;font-size:12.5px">'
                    + (ex().proxy && LOCAL
                        ? ex().name + '은(는) CORS 차단 때문에 서버리스 프록시가 필요합니다. 로컬(localhost)에서는 조회되지 않고 배포본에서만 동작합니다.'
                        : ex().name + ' API 호출 제한에 걸렸을 수 있습니다. 잠시 후 다시 시도하세요.')
                    + '</div></div>';
            })
            .then(function () {
                state.busy = false;
                $("run").disabled = false;
                scheduleNext();
            });
    }

    /**
     * 다음 자동갱신을 예약한다.
     *
     * setInterval을 쓰면 응답이 주기보다 느릴 때 state.busy 가드에 걸려
     * 갱신이 조용히 사라졌다. 사용자는 화면이 왜 안 바뀌는지 알 수 없다.
     * 한 번 끝난 뒤에 다음을 예약하면 호출이 겹치지도, 사라지지도 않는다.
     */
    function scheduleNext() {
        if (!state.auto) return;
        if (state.timer) clearTimeout(state.timer);
        state.timer = setTimeout(run, autoIntervalMs());
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
                head.textContent = coinOf(state.sel) + " " + lbl + " 차트";
            }
            // 봉이 바뀌면 축 범위가 달라지므로 fitContent가 필요하다. 재생성이 맞다.
            buildChart(state.tfCandles[tf], state.levels, state.dp);
        }
    }

    /**
     * 자동갱신은 지표·레벨 재계산용이다. 시세 자체는 WebSocket이 항상 실시간으로 넣는다.
     *
     * 한 번 갱신에 업비트를 7번 호출한다(ticker + 직접 조회 캔들 6종).
     * 업비트 제한은 초당 10회라 1초 간격이면 초당 4회 — 한 탭이면 안전하지만
     * 여러 탭을 띄우면 넘긴다. 짧은 주기를 고르면 경고를 띄운다.
     */
    function autoIntervalMs() {
        var v = parseInt(($("interval") || {}).value, 10);
        return (isFinite(v) && v > 0 ? v : 10) * 1000;
    }

    function startAuto() {
        if (state.timer) clearTimeout(state.timer);
        state.auto = true;
        var ms = autoIntervalMs();
        var b = $("auto");
        b.textContent = "자동갱신 ON · " + (ms / 1000) + "초";
        b.classList.add("on");
        showRateHint(ms);
        scheduleNext();
    }

    /**
     * 호출 빈도 경고.
     *
     * 예전에는 3초 이하를 뭉뚱그려 같은 경고를 띄웠다. 실제 부담은 주기가 아니라
     * "초당 호출 수"인데, 갱신 1회에 나가는 호출은 거래소마다 다르다
     * (ticker 1 + 직접 조회하는 봉 수). 업비트 기준 7회다.
     * 1초 주기면 초당 7회로 제한(10회)에 거의 붙는다 — 탭 두 개면 확실히 넘긴다.
     *
     * 실제 수치를 계산해서 보여준다.
     */
    function showRateHint(ms) {
        var el = $("rateHint");
        if (!el) return;
        if (!isFinite(ms) || ms <= 0) { el.style.display = "none"; return; }

        var 회 = 1 + directTfs().length;          // ticker + 직접 조회 봉
        var 초당 = 회 / (ms / 1000);
        if (초당 < 2) { el.style.display = "none"; return; }

        el.textContent = "⚠ 갱신 1회당 " + ex().name + " " + 회 + "회 호출 — 현재 주기면 초당 약 "
            + 초당.toFixed(1) + "회입니다. 제한은 초당 10회라 탭을 여러 개 열면 걸립니다.";
        el.style.display = "";
    }

    /**
     * 거래소를 바꾼다.
     *
     * 종목 구성이 다르다(업비트 281 / 빗썸 478). 같은 심볼이 양쪽에 있으면 유지하고,
     * 없으면 첫 종목으로 떨어뜨린다. 그래야 BTC를 보다 전환했을 때 BTC가 이어진다.
     */
    function switchExchange(key) {
        if (!EXCHANGES[key]) return;
        state.exchange = key;
        state.renderedFor = null;      // 전체 렌더로 되돌린다
        closeWS();

        [].forEach.call(document.querySelectorAll("#exbar button"), function (b) {
            b.classList.toggle("act", b.getAttribute("data-ex") === key);
        });
        // 빗썸에는 년봉이 없다. 년봉을 보던 중이었다면 월봉으로 내린다.
        if (!ex().hasYear && state.chartTf === "1y") switchTf("1M");
        syncTfButtons();
        syncApiHint();

        // 거래소마다 기축이 다르다(KRW-BTC <-> USDT-BTC). 코인 이름만 떼어 이어붙인다.
        var 코인 = state.sel.split("-")[1] || "BTC";
        var 원하던 = (ex().quote || "KRW") + "-" + 코인;
        $("out").innerHTML = '<div class="loading"><span class="spin"></span>'
            + esc(ex().name) + " 마켓을 불러오는 중…</div>";

        loadMarkets().then(function () {
            // 같은 종목이 새 거래소에도 있으면 그대로 이어본다
            if (state.markets.some(function (m) { return m.market === 원하던; })) {
                state.sel = $("market").value = 원하던;
            } else if (state.markets.length) {
                state.sel = $("market").value = state.markets[0].market;
            }
            savePreferences();
            run();
        }).catch(function (e) {
            $("out").innerHTML = '<div class="err">마켓 목록을 불러오지 못했습니다: ' + esc(e.message) + "</div>";
        });
    }

    /**
     * 레퍼럴 배너를 채운다.
     * 링크가 비어 있는 거래소 카드는 숨기고, 둘 다 비면 배너 자체를 감춘다.
     */
    function syncReferral() {
        var lane = $("reflane");
        if (!lane) return;
        var 살아있는거 = 0;
        [["ref-binance", REFERRAL.binance], ["ref-mexc", REFERRAL.mexc]].forEach(function (p) {
            var el = $(p[0]);
            if (!el) return;
            if (p[1]) {
                el.href = p[1];
                el.style.display = "";
                살아있는거++;
            } else {
                el.style.display = "none";
            }
        });
        lane.style.display = 살아있는거 ? "" : "none";
    }

    function syncApiHint(analysisTf, sourceTimestamp) {
        var el = $("apiHint");
        if (!el) return;
        var parts = [ex().name + " 현물 공개 API", "무인증", "최대 200봉"];
        if (analysisTf) {
            parts.push("지표·신호는 완료봉 기준");
            var c4 = analysisTf["4h"] || [];
            var last = c4.length ? c4[c4.length - 1] : null;
            if (last && isFinite(last.endTime)) {
                parts.push("최근 완료 4h " + new Date(last.endTime * 1000).toLocaleString("ko-KR", {
                    timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit",
                    hour: "2-digit", minute: "2-digit", hour12: false
                }));
            }
        }
        var ts = Number(sourceTimestamp);
        if (isFinite(ts) && ts > 0) {
            if (ts < 1e12) ts *= 1000;
            parts.push("시세 " + new Date(ts).toLocaleTimeString("ko-KR", {
                timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
            }));
        }
        el.textContent = parts.join(" · ");
    }

    /** 거래소가 지원하지 않는 봉 버튼은 숨긴다. */
    function syncTfButtons() {
        var 가능 = {};
        activeTfs().forEach(function (t) { 가능[t.key] = true; });
        [].forEach.call(document.querySelectorAll("#tfbar button"), function (b) {
            b.style.display = 가능[b.getAttribute("data-tf")] ? "" : "none";
        });
    }

    function toggleAuto() {
        var b = $("auto");
        if (state.auto) {
            state.auto = false;
            if (state.timer) { clearTimeout(state.timer); state.timer = null; }
            b.textContent = "자동갱신 OFF"; b.classList.remove("on");
            showRateHint(Infinity);
        } else {
            startAuto();
            run();
        }
    }

    document.addEventListener("DOMContentLoaded", function () {
        // 새로 접속해도 마지막 거래소와 코인으로 돌아가 즐겨찾기가 사라진 것처럼 보이지 않게 한다.
        loadPreferences();
        [].forEach.call(document.querySelectorAll("#exbar button"), function (b) {
            b.classList.toggle("act", b.getAttribute("data-ex") === state.exchange);
        });

        $("run").addEventListener("click", run);
        $("auto").addEventListener("click", toggleAuto);
        $("briefBtn").addEventListener("click", openBrief);
        $("briefCopy").addEventListener("click", copyBrief);
        $("briefClose").addEventListener("click", function () {
            $("brief").style.display = "none";
        });

        // 줌 버튼은 렌더할 때마다 새로 생긴다. out에 한 번만 위임해 둔다.
        $("out").addEventListener("click", function (e) {
            var b = e.target.closest ? e.target.closest("[data-zoom],[data-recent]") : null;
            if (!b || b.id === "fsBtn") return;
            if (b.hasAttribute("data-zoom")) {
                zoomBy(b.getAttribute("data-zoom") === "in" ? 0.7 : 1.43);
            } else {
                showRecent(parseInt(b.getAttribute("data-recent"), 10));
            }
        });

        // 전체화면 버튼도 렌더마다 새로 생긴다
        $("out").addEventListener("click", function (e) {
            if (e.target.closest && e.target.closest("#fsBtn")) toggleFullscreen();
        });
        document.addEventListener("fullscreenchange", onFsChange);
        document.addEventListener("webkitfullscreenchange", onFsChange);

        // 유사 전체화면은 브라우저가 Esc를 처리해주지 않으니 직접 받는다
        document.addEventListener("keydown", function (e) {
            if (e.key !== "Escape") return;
            var card = document.querySelector("#chart-sec .card");
            if (card && card.classList.contains("pseudo-fs")) setPseudoFs(false);
        });

        // F로 토글. 입력창에 타이핑 중일 때는 무시한다.
        document.addEventListener("keydown", function (e) {
            if (e.key !== "f" && e.key !== "F") return;
            var t = e.target.tagName;
            if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            e.preventDefault();
            toggleFullscreen();
        });
        $("q").addEventListener("input", function () {
            setMarketTab("search");
            renderMarketSelect(this.value);
            // 일반 코인 검색은 입력 도중 실행하지 않는다.
            // 예: MEXC에는 심볼 F가 실제로 있으므로 FET를 입력하려는 첫 글자 F만으로
            // 분석이 시작되면 검색어가 지워지고 즐겨찾기 별표를 누를 수 없게 된다.
            // 검색 결과의 코인명 클릭 또는 Enter에서만 분석을 시작한다.
            // USDT.D는 별도 검색 결과가 없는 특수 지표라 기존처럼 즉시 표시한다.
            if (isUsdtDominanceMarket(this.value)) {
                state.sel = "__USDT_DOMINANCE__";
                $("market").value = state.sel;
                savePreferences();
                run();
                return;
            }
        });
        $("q").addEventListener("keydown", function (e) {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (isUsdtDominanceMarket(this.value)) {
                state.sel = "__USDT_DOMINANCE__";
                $("market").value = state.sel;
                savePreferences();
                run();
                return;
            }
            var exact = findExactMarket(this.value);
            var candidates = state.markets.filter(function (m) {
                return marketMatchesSearch(m, $("q").value);
            });
            var chosen = exact || candidates[0];
            if (chosen) selectMarketAndRun(chosen.market);
        });
        [].forEach.call(document.querySelectorAll("[data-market-tab]"), function (b) {
            b.addEventListener("click", function () { setMarketTab(b.getAttribute("data-market-tab")); });
        });
        function onMarketResultClick(e) {
            var favorite = e.target.closest ? e.target.closest("[data-favorite]") : null;
            if (favorite) {
                toggleFavorite(favorite.getAttribute("data-favorite"));
                return;
            }
            var open = e.target.closest ? e.target.closest("[data-market-open]") : null;
            if (open) {
                selectMarketAndRun(open.getAttribute("data-market-open"));
            }
        }
        $("marketResults").addEventListener("click", onMarketResultClick);
        $("favoriteResults").addEventListener("click", onMarketResultClick);
        $("q").addEventListener("focus", function () {
            setMarketTab("search");
            renderMarketResults(this.value, state.markets);
        });
        document.addEventListener("click", function (e) {
            var picker = document.querySelector(".market-picker");
            if (picker && !picker.contains(e.target)) {
                $("marketResults").hidden = true;
                $("favoriteResults").hidden = true;
            }
        });
        $("market").addEventListener("change", function () { selectMarketAndRun(this.value); });
        $("alertBtn").addEventListener("click", toggleAlert);

        // 거래소 전환. 마켓 목록·상장 종목이 다르므로 목록부터 새로 받는다.
        [].forEach.call(document.querySelectorAll("#exbar button"), function (b) {
            b.addEventListener("click", function () {
                var key = b.getAttribute("data-ex");
                if (key === state.exchange) return;
                switchExchange(key);
            });
        });
        $("interval").addEventListener("change", function () {
            if (state.auto) startAuto();   // 켜져 있을 때만 주기를 갈아끼운다
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

        syncTfButtons();
        syncApiHint();
        syncReferral();
        loadMarkets().then(function () {
            // 저장된 코인이 상장 폐지되었거나 거래소 코드와 맞지 않으면 BTC, 그다음 첫 종목으로 안전하게 대체한다.
            if (state.sel !== "__USDT_DOMINANCE__"
                    && !state.markets.some(function (m) { return m.market === state.sel; })) {
                var btc = (ex().quote || "KRW") + "-BTC";
                state.sel = state.markets.some(function (m) { return m.market === btc; })
                    ? btc
                    : (state.markets[0] ? state.markets[0].market : state.sel);
                renderMarketSelect("");
            }
            $("market").value = state.sel;
            savePreferences();
            run();
        }).catch(function (e) {
            $("out").innerHTML = '<div class="err">마켓 목록을 불러오지 못했습니다: ' + esc(e.message) + "</div>";
        });
    });
})();
