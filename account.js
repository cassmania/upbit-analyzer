/* 개인 화면은 공개 분석과 분리하고 계정 데이터를 메모리에만 잠시 보관한다. */
(function () {
    "use strict";
    const $ = id => document.getElementById(id);
    const errors = {
        SETUP_REQUIRED: "본인 인증을 위한 서버 설정이 아직 완료되지 않았습니다.",
        LOGIN_REQUIRED: "본인 계정으로 로그인해 주세요.", SESSION_EXPIRED: "로그인이 만료되었습니다. 다시 로그인해 주세요.",
        LOGIN_FAILED: "이메일 또는 비밀번호를 확인해 주세요.", OWNER_ONLY: "이 계정은 개인 화면에 접근할 수 없습니다.",
        ORIGIN_DENIED: "요청이 차단되었습니다. 이 사이트에서 다시 시도해 주세요.",
        AUTH_UNAVAILABLE: "로그인 서비스 연결 또는 설정을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
        RATE_LIMITED: "요청이 많습니다. 1분 뒤 다시 시도해 주세요.",
        INVALID_KEY: "Access Key와 Secret Key 형식을 확인해 주세요.", READ_ONLY_REQUIRED: "읽기 전용 키인지 확인해 주세요.",
        MEXC_KEY_CHECK_FAILED: "계정 조회에 실패했습니다. MEXC 키·조회 권한·IP 제한을 확인해 주세요. 기존 연결은 유지됩니다.",
        KEY_DECRYPT_FAILED: "저장된 키를 읽을 수 없습니다. 연결 설정에서 키를 다시 등록해 주세요.",
        MEXC_PERMISSION_OR_REQUEST_FAILED: "MEXC 조회 권한·키 유효기간·IP 제한을 확인해 주세요.",
        MEXC_RATE_LIMITED: "MEXC 요청 제한에 도달했습니다. 잠시 후 새로고침해 주세요.",
        MEXC_UNAVAILABLE: "MEXC 연결에 실패했습니다.", MEXC_RESPONSE_INVALID: "MEXC 응답 형식을 확인할 수 없습니다."
    };
    let busy = false, timer = null, generation = 0, authenticated = false;
    function status(text, error = false) { $("status").textContent = text; $("status").className = error ? "error" : ""; }
    function clearPrivate() {
        generation++;
        clearTimeout(timer);
        $("accountData").replaceChildren();
        $("lastUpdated").textContent = "아직 조회하지 않았습니다";
        $("apiKey").value = ""; $("secret").value = ""; $("password").value = "";
    }
    function showLogin() { authenticated = false; clearPrivate(); $("privateArea").hidden = true; $("login").hidden = false; }
    async function api(path, method = "GET", payload) {
        const response = await fetch("/api/private/" + path, { method, credentials: "same-origin", cache: "no-store",
            headers: { "X-Private-Request": "1", ...(payload ? { "Content-Type": "application/json" } : {}) },
            ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(25000) });
        const data = await response.json();
        if (!response.ok) {
            if (["LOGIN_REQUIRED", "SESSION_EXPIRED", "OWNER_ONLY"].includes(data.error)) showLogin();
            if (data.error === "SETUP_REQUIRED") { showLogin(); $("login").hidden = true; $("setup").hidden = false; }
            throw new Error(errors[data.error] || "요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.");
        }
        return data;
    }
    function node(tag, text, className) {
        const el = document.createElement(tag);
        if (text !== undefined) el.textContent = text;
        if (className) el.className = className;
        return el;
    }
    const number = value => value === null || value === undefined ? "미제공" : Number(value).toLocaleString("ko-KR", { maximumFractionDigits: 8 });
    function section(title, data) {
        const card = node("section", undefined, "card"); card.append(node("h2", title));
        if (data.status !== "ok") card.append(node("p", errors[data.error] || "이 항목을 조회할 수 없습니다.", "section-error"));
        else if (!data.rows.length) card.append(node("p", "현재 해당 내역이 없습니다.", "empty"));
        return card;
    }
    function table(card, headers, rows) {
        const wrap = node("div", undefined, "tablewrap"), tableEl = node("table"), head = node("thead"), row = node("tr");
        headers.forEach(text => row.append(node("th", text))); head.append(row); tableEl.append(head);
        const body = node("tbody"); rows.forEach(values => { const tr = node("tr"); values.forEach(value => tr.append(node("td", value))); body.append(tr); });
        tableEl.append(body); wrap.append(tableEl); card.append(wrap);
    }
    function render(data) {
        $("accountData").replaceChildren(); $("disconnect").hidden = !data.connected;
        $("connection").open = !data.connected;
        if (!data.connected) { $("lastUpdated").textContent = "MEXC 연결 전"; status("로그인했습니다. 읽기 전용 MEXC API 키를 연결해 주세요."); return; }
        $("lastUpdated").textContent = "조회 " + new Date(data.fetchedAt).toLocaleString("ko-KR");
        const s = data.sections;
        const pos = section("활성 포지션", s.positions);
        if (s.positions.status === "ok" && s.positions.rows.length) {
            const grid = node("div", undefined, "grid");
            s.positions.rows.forEach(p => {
                const card = node("article", undefined, "position");
                card.append(node("h3", `${p.symbol} · ${p.direction}`), node("p", `${p.mode} · ${number(p.leverage)}배`));
                const metrics = node("div", undefined, "metrics");
                [["미실현 손익 (결제통화)", number(p.unrealized), p.unrealized > 0 ? "positive" : p.unrealized < 0 ? "negative" : ""],
                    ["보유 계약 수", number(p.contracts)], ["평균 진입가", number(p.entryPrice)],
                    ["격리 청산가", p.mode === "교차" ? "교차 모드 · 미제공" : number(p.liquidationPrice)]].forEach(([name, value, css]) => {
                    const cell = node("div"); cell.append(node("small", name), node("strong", value, css)); metrics.append(cell);
                });
                card.append(metrics); grid.append(card);
            });
            pos.append(grid, node("p", "수량은 코인 수량이 아닌 계약 수입니다. 교차 모드의 청산가는 거래소에서 확인하세요.", "footnote"));
        }
        $("accountData").append(pos);
        const assets = section("선물 자산", s.assets);
        if (s.assets.status === "ok" && s.assets.rows.length) table(assets, ["통화", "총 자산", "사용 가능", "증거금", "미실현 손익"],
            s.assets.rows.map(r => [r.currency, number(r.equity), number(r.available), number(r.margin), number(r.unrealized)]));
        $("accountData").append(assets);
        const spot = section("현물 잔고", s.spot);
        if (s.spot.status === "ok" && s.spot.rows.length) table(spot, ["자산", "사용 가능", "주문 등에 묶인 수량"], s.spot.rows.map(r => [r.asset, number(r.free), number(r.locked)]));
        $("accountData").append(spot);
        [["spotOrders", "현물 미체결 주문"], ["futuresOrders", "선물 미체결 주문"]].forEach(([key, title]) => {
            const card = section(title, s[key]);
            if (s[key].status === "ok" && s[key].rows.length) table(card, ["종목", "방향", "가격", "수량", "체결 수량", "상태"],
                s[key].rows.map(r => [r.symbol, r.side, number(r.price), `${number(r.quantity)} ${r.unit}`, number(r.filled), r.status]));
            if (key === "futuresOrders") card.append(node("p", data.futuresOrdersMayHaveMore ? "첫 100건입니다. 나머지 주문은 MEXC에서 확인하세요." : "일반 주문 기준 · 예약/TP/SL 주문은 MEXC에서 확인하세요.", "footnote"));
            $("accountData").append(card);
        });
        const partial = Object.values(s).some(x => x.status !== "ok");
        status(partial ? "일부 항목의 조회에 실패했습니다. 각 항목의 안내를 확인해 주세요." : "MEXC 계정 정보를 갱신했습니다.", partial);
    }
    function schedule() {
        clearTimeout(timer);
        if (authenticated && $("autoRefresh").checked && !document.hidden) timer = setTimeout(refresh, 30000);
    }
    async function run(action) {
        if (busy) return;
        busy = true; document.querySelectorAll("button").forEach(b => { b.disabled = true; });
        try { await action(); } catch (error) { status(error.message || "연결에 실패했습니다.", true); }
        finally { busy = false; document.querySelectorAll("button").forEach(b => { b.disabled = false; }); schedule(); }
    }
    async function refresh() {
        return run(async () => {
            const current = generation;
            try { const data = await api("mexc"); if (current === generation && !document.hidden) render(data); }
            catch (error) { $("accountData").replaceChildren(); $("lastUpdated").textContent = "조회 실패 · 이전 값 숨김"; throw error; }
        });
    }
    $("loginForm").addEventListener("submit", event => { event.preventDefault(); run(async () => {
        const input = { action: "login", email: $("email").value.trim(), password: $("password").value };
        $("password").value = "";
        // 요청 중임을 버튼과 입력창 아래에 함께 표시해 중복 클릭을 줄인다.
        $("loginButton").textContent = "로그인 확인 중…";
        $("loginForm").setAttribute("aria-busy", "true");
        $("loginFeedback").hidden = false; $("loginFeedback").className = "";
        $("loginFeedback").textContent = "계정을 확인하고 있습니다. 잠시 기다려 주세요.";
        status("계정을 확인하고 있습니다.");
        try {
            await api("session", "POST", input); authenticated = true; $("login").hidden = true; $("privateArea").hidden = false;
            render(await api("mexc"));
        } catch (error) {
            // 작은 화면에서도 실패 안내가 보이도록 입력창 가까이에 표시한다.
            const message = error.name === "TimeoutError" ? "로그인 응답이 지연되었습니다. 잠시 후 다시 시도해 주세요."
                : error.message === errors.LOGIN_FAILED ? "로그인이 거부되었습니다. 기존 사이트 인증 계정의 이메일·비밀번호를 확인해 주세요. Google·Vercel·MEXC 비밀번호와는 별개입니다."
                : error.message;
            $("loginFeedback").textContent = message; $("loginFeedback").className = "error";
            if (!$("login").hidden) $("loginFeedback").focus();
            throw new Error(message);
        } finally {
            $("loginButton").textContent = "로그인"; $("loginForm").removeAttribute("aria-busy");
        }
    }); });
    $("keyForm").addEventListener("submit", event => { event.preventDefault(); run(async () => {
        const input = { apiKey: $("apiKey").value.trim(), secret: $("secret").value.trim(), readOnly: $("readOnly").checked };
        $("apiKey").value = ""; $("secret").value = "";
        const data = await api("mexc", "POST", input); $("readOnly").checked = false; render(data);
    }); });
    $("logout").addEventListener("click", () => run(async () => {
        clearPrivate();
        await api("session", "POST", { action: "logout" }); showLogin(); status("로그아웃했습니다.");
    }));
    $("disconnect").addEventListener("click", () => run(async () => {
        if (!window.confirm("저장된 MEXC 연결을 해제할까요? 다시 연결하려면 API 키를 입력해야 합니다.")) return;
        render(await api("mexc", "DELETE")); status("저장된 MEXC 연결을 해제했습니다.");
    }));
    $("refresh").addEventListener("click", refresh); $("autoRefresh").addEventListener("change", schedule);
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) clearPrivate(); else if (authenticated) refresh();
    });
    // 뒤로 가기 캐시로 개인 값이 복원되는 것을 막는다.
    window.addEventListener("pagehide", clearPrivate);
    window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
    run(async () => {
        await api("session"); authenticated = true; $("privateArea").hidden = false; render(await api("mexc"));
    });
})();
