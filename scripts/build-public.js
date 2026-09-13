"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
// 공개 파일을 명시한다. 서버 코드·SQL·테스트·설정 파일은 정적 배포물에서 제외한다.
const files = ["index.html", "app.js", "public-evidence.js", "candle_utils.js", "ta_engine.js", "v3_analysis.js", "v41_analysis.js",
    "level_analyzer.js", "signal_engine.js", "backtest/results/summary.js", "backtest/results/signal-report.md", "account.html", "account.css", "account.js"];
for (const file of files) {
    const destination = path.join(root, "public", file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, file), destination);
}
console.log(`공개 파일 ${files.length}개 준비 완료`);
