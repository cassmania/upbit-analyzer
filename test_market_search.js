/** 코인 검색 입력과 즐겨찾기 동작의 정적 회귀 검증. 실행: node test_market_search.js */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "app.js"), "utf8");
let passed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log("  OK  " + name);
    } catch (error) {
        console.error("  FAIL " + name + "\n       " + error.message);
        process.exitCode = 1;
    }
}

/** 두 표식 사이의 코드만 잘라 이벤트별 책임이 섞이지 않았는지 확인한다. */
function section(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(start !== -1, "시작 표식을 찾을 수 없습니다: " + startMarker);
    assert.ok(end !== -1, "종료 표식을 찾을 수 없습니다: " + endMarker);
    return source.slice(start, end);
}

console.log("\n[코인 검색·즐겨찾기]");

test("입력 중에는 짧은 심볼과 일치해도 분석을 자동 실행하지 않는다", function () {
    const inputHandler = section(
        '$("q").addEventListener("input", function () {',
        '$("q").addEventListener("keydown", function (e) {'
    );
    assert.ok(inputHandler.includes("renderMarketSelect(this.value, false)"));
    assert.ok(!inputHandler.includes("findExactMarket(this.value)"));
    assert.ok(!inputHandler.includes("selectMarketAndRun("));
});

test("Enter를 누르면 검색한 코인을 선택해 분석한다", function () {
    const keydownHandler = section(
        '$("q").addEventListener("keydown", function (e) {',
        '[].forEach.call(document.querySelectorAll("[data-market-tab]")'
    );
    assert.ok(keydownHandler.includes("runMarketSearch()"));
});

test("검색 결과의 별표는 분석 없이 즐겨찾기만 변경한다", function () {
    const clickHandler = section(
        "function onMarketResultClick(e) {",
        '$("marketResults").addEventListener("click", onMarketResultClick)'
    );
    const favoriteBranch = sectionFrom(clickHandler, "if (favorite) {", "var open =");
    assert.ok(favoriteBranch.includes("toggleFavorite("));
    assert.ok(favoriteBranch.includes("return;"));
    assert.ok(!favoriteBranch.includes("selectMarketAndRun("));
});

/** 이미 잘라낸 작은 코드 조각 안에서 다시 범위를 선택한다. */
function sectionFrom(text, startMarker, endMarker) {
    const start = text.indexOf(startMarker);
    const end = text.indexOf(endMarker, start + startMarker.length);
    assert.ok(start !== -1 && end !== -1, "클릭 처리 범위를 찾을 수 없습니다.");
    return text.slice(start, end);
}

// 실제 검색 함수를 실행해 재포커스·거래쌍 검색·0건 분석 방지를 검증한다.
const vm = require("node:vm");
const elements = { q: { value: "", focus() {} }, marketResults: {} };
const context = {
    location: { hostname: "localhost" }, window: {},
    document: { addEventListener() {}, getElementById(id) { return elements[id]; } }
};
vm.createContext(context);
vm.runInContext(source.replace(/\}\)\(\);\s*$/, `
    window.searchTest = { state, marketMatchesSearch, findExactMarket, renderMarketResults, runMarketSearch };
    window.calls = [];
    run = function () { window.calls.push("run"); };
    selectMarketAndRun = function (market) { window.calls.push(market); };
    setMarketTab = function () { state.marketTab = "search"; };
})();`), context);
const search = context.window.searchTest;
search.state.exchange = "mexc";
search.state.marketTab = "search";
search.state.markets = [
    { market: "USDT-WLD", korean_name: "WLD", english_name: "Worldcoin" },
    { market: "USDT-BTC", korean_name: "BTC", english_name: "Bitcoin" }
];
test("거래쌍과 영문 정식 이름을 검색한다", () => {
    for (const query of ["BTCUSDT", "btc/usdt", "BTC USDT", "Bitcoin"]) {
        assert.equal(search.findExactMarket(query).market, "USDT-BTC");
    }
});
test("재포커스 시에도 검색어와 일치하는 종목만 표시한다", () => {
    search.renderMarketResults("BTC", search.state.markets);
    assert.ok(elements.marketResults.innerHTML.includes('data-market-open="USDT-BTC"'));
    assert.ok(!elements.marketResults.innerHTML.includes('data-market-open="USDT-WLD"'));
});
test("미지원 MTL 검색 후 분석을 눌러도 이전 WLD를 실행하지 않는다", () => {
    elements.q.value = "MTL";
    search.runMarketSearch();
    assert.equal(context.window.calls.length, 0);
    assert.ok(elements.marketResults.innerHTML.includes("MEXC 현물 USDT API 목록"));
});
test("거래쌍을 입력하고 분석하면 해당 종목이 선택된다", () => {
    elements.q.value = "BTCUSDT";
    search.runMarketSearch();
    assert.equal(context.window.calls[0], "USDT-BTC");
});
console.log("\n총 " + passed + "개 검증 통과" + (process.exitCode ? " (실패 있음)" : "") + "\n");
