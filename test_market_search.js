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
    assert.ok(inputHandler.includes("renderMarketSelect(this.value)"));
    assert.ok(!inputHandler.includes("findExactMarket(this.value)"));
    assert.ok(!inputHandler.includes("selectMarketAndRun("));
});

test("Enter를 누르면 검색한 코인을 선택해 분석한다", function () {
    const keydownHandler = section(
        '$("q").addEventListener("keydown", function (e) {',
        '[].forEach.call(document.querySelectorAll("[data-market-tab]")'
    );
    assert.ok(keydownHandler.includes("findExactMarket(this.value)"));
    assert.ok(keydownHandler.includes("selectMarketAndRun(chosen.market)"));
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

console.log("\n총 " + passed + "개 검증 통과" + (process.exitCode ? " (실패 있음)" : "") + "\n");
