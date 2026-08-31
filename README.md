# 업비트 코인 분석

업비트·빗썸·바이낸스·MEXC 현물 마켓을 다중 타임프레임으로 분석한다.
계산 로직은 `crypto-master-analyst V4.1`의 근거 우선 원칙을 바탕으로 하며,
완료봉 분리, Wilder ADX/ATR, SMA20/60/120/200, Stochastic(14,3,3),
확정 피벗, FVG·오더블록 후보, 범위분배 근사 VPVR과 조건부
롱·숏·관망 시나리오를 적용한다.

**라이브**: https://upbit-analyzer.vercel.app/

GitHub Pages(`cassmania.github.io/upbit-analyzer/`)는 **쓰지 않는다.**
서버리스 함수를 못 돌려 CORS를 우회할 수 없다 — 아래 "CORS 문제" 참고.

## 구성

| 파일 | 역할 |
|---|---|
| `candle_utils.js` | 거래소별 봉 시작 시각 정규화 + 완료봉 분리 + 합성봉 검증 |
| `ta_engine.js` | 스킬 지표 계산 이식 — RSI/스토캐스틱/CCI/MACD/볼린저/ATR/슈퍼트렌드/VWAP/VPVR/패턴/confluence |
| `v3_analysis.js` | 검증된 구조 분석 기반 — ADX 국면, 좌우 5봉 피벗, BOS, FVG, 오더블록 후보, 피보나치 |
| `v41_analysis.js` | V4.1 데이터 계약·근거군·가용성 호환 계층 |
| `level_analyzer.js` | 다중 타임프레임 지지·저항 겹침 판정 (crypto-futures-simulator와 동일 엔진) |
| `signal_engine.js` | 다중 시간봉 방향·구조적 진입/손절/목표를 계산하는 규칙 기반 신호 |
| `app.js` | 거래소 API 조달 + 실시간 차트 + USDT 도미넌스 + 화면 렌더 |
| `index.html` | 화면 |
| `api/coingecko.js` | CoinGecko 전체 시장·USDT 시가총액 서버리스 프록시 |
| `test_ta_engine.js` | 기술 지표 회귀 검증 |
| `test_v41_analysis.js` | V4.1 프로토콜 회귀 검증 |
| `backtest/` | Binance 확정봉 스냅샷 수집 + 비용 포함 시간순 홀드아웃 백테스트 |
| `test_signal_backtest.js` | 다음 봉 진입·비용·동일 봉 손절 우선·PF·MDD 검증 |

외부 라이브러리 0개. 차트도 캔버스 직접 그리기다.

## 데이터 출처

| 항목 | 출처 | 비고 |
|---|---|---|
| 시세·캔들 | 선택한 거래소 현물 공개 API | 무인증, 봉당 최대 200개 |
| 펀딩비·미결제약정 | 바이낸스 USDT-M 선물 | **현물 분석의 보조자료다.** 미상장 종목은 "데이터 없음" |
| 김치 프리미엄 | 업비트 원화가 ÷ (바이낸스 달러가 × 환율) | 환율은 open.er-api.com |
| USDT 도미넌스 | USDT 시가총액 ÷ 전체 암호화폐 시가총액 × 100 | CoinGecko `/global` + `/simple/price` |
| 청산맵·온체인·매크로 | — | 무료 API 미제공. **표시하지 않는다** |

## 진행봉과 합성봉

차트에는 거래소처럼 진행 중인 최신 봉도 보이지만 RSI·ATR·VPVR·지지저항·타점은
완료된 봉만 사용한다. 업비트·빗썸은 `candle_date_time_utc`, 바이낸스·MEXC는
kline open/close time으로 완료 여부를 판단한다.

업비트·빗썸의 8시간·12시간봉과 MEXC 12시간봉은 합성이다.

업비트에 12시간봉 엔드포인트가 없다. **4시간봉 3개를 묶어 만든다.**

1시간봉을 12개씩 묶는 방법도 있지만, 업비트가 한 번에 200개까지만 주므로
12시간봉이 16개밖에 안 나와 지표가 계산되지 않는다. 4시간봉 200개를 묶으면
약 66개가 확보된다. 구성 4시간봉이 빠짐없이 모두 완료된 합성봉만 분석에 사용한다.

## 지지·저항 판정

`level_analyzer.js`가 여러 봉의 후보를 가격 0.22% 이내로 묶어 **겹치는 봉 개수**로
강도를 매긴다. 4중 겹침이 최강.

VPVR은 캔들 거래량을 대표가격 한 칸에 몰지 않고 고가~저가와 겹치는 가격 구간에
비례 배분한다. 공개 OHLCV로 체결별 분포를 복원할 수는 없으므로 이는 보수적 근사다.

근거 가중: POC 3.0 > 마지노선 2.8 > VA 경계 2.0 > HVN 1.6 > 스윙 1.2 > 피보 0.8.
봉 가중: 1d 2.0 > 12h 1.7 > 4h 1.3 > 1h 1.0.

지지·저항은 현재가 기준으로만 가른다. **이탈한 지지는 저항으로 자동 전환**되므로
저항 목록에 "스윙저점"이 뜨는 건 버그가 아니라 전환된 벽이라는 뜻이다.

## 검증

```bash
node test_candle_utils.js
node test_ta_engine.js
node test_level_analyzer.js
node test_signal_engine.js
node test_market_search.js
node test_v3_analysis.js
node test_v41_analysis.js
node test_signal_backtest.js
```

### 비용 포함 신호 백테스트 — 2026-08-31

Binance 현물 BTC/ETH/BNB/XRP/SOL의 2024-01-01 이후 확정봉을 사용했다. 신호는
1시간봉 확정 후 계산하고, 다음 1시간봉에서 계획 진입가에 도달한 경우만 체결했다.
수수료 편도 0.10%, 슬리피지 편도 0.02%, 동일 봉 손절 우선, 최대 보유 48시간이다.

- 마지막 40% 홀드아웃: 88거래, 승률 42.0%, Profit Factor 0.773, 평균 -0.178R
- 롱: 36거래, PF 1.151, 평균 +0.095R
- 가상 숏: 52거래, PF 0.590, 평균 -0.367R
- 판정: 전체 규칙 기반 전략 우위 미확인

승률은 지표 공식의 정확도와 같은 뜻이 아니다. RSI·EMA·MACD·완료봉 처리는 기준값과
일치했고, ATR/SuperTrend의 첫 True Range가 한 봉 늦게 시작하는 오류를 수정했다.
200봉 입력에서는 해당 수정 전후 백테스트 거래와 성과가 동일했다.

상세 결과는 `backtest/results/signal-report.md`에서 확인할 수 있다.

화면의 `V4.1 브리핑`은 같은 계산 스냅샷에서 USDT(KRW), 데이터 시각,
PART 0~5, 멀티 타임프레임 추세, FVG·오더블록, 파생상품 가용성,
온체인·뉴스 데이터 한계, 롱·숏·관망 및 포지션 관리 조건을 만든다.
브라우저 OHLCV만으로 확인할 수 없는 뉴스·언락·고래·온체인·CVD·청산맵은
`현재 실시간 데이터 확인 불가`라고 명시한다.

2026-08-17 정확도 개선에서 업비트 `timestamp` 오용, 진행봉 지표 혼입,
단순평균 ATR, 대표가격 단일 칸 VPVR, 상관 높은 과열지표 중복 가중을 회귀 테스트로 고정했다.

### 라이브 검증

- BTC: 90,560,778원에서 **4중 겹침** 검출 (1h 스윙저점/VA하단/피보0.5 · 4h 스윙저점 · 12h VA하단/스윙저점 · 1d 스윙저점/VA하단)
- XRP: 4중 겹침 검출, 자릿수 처리 정상 (1,451원 → 정수 표시)
- 두 종목 모두 불변식(저항>현재가>지지) 위반 0건, 콘솔 에러 0건

## CORS 문제와 해결 (완료)

**업비트 API는 전 엔드포인트에 `Access-Control-Allow-Origin` 헤더를 주지 않는다.**
2026-08-10 실측: `market/all`, `ticker`, `candles/minutes/*`, `candles/days` 전부 없음.

따라서 브라우저에서 `api.upbit.com`을 직접 호출하는 정적 사이트는 원리적으로 불가능하다.
GitHub Pages 배포본은 이 이유로 실패한다. **Vercel로 옮겨 해결했다.**

localhost에서 되는 건 로컬 출처에 대한 브라우저 동작 차이일 뿐, 정적 배포에서는 재현되지 않는다.

### 해결: `api/upbit.js`

서버리스 프록시를 만들어 뒀다. 경로 화이트리스트를 둬서 임의 URL을 대신 때려주는
오픈 프록시가 되지 않게 했고, 5초 캐시로 업비트 호출 제한(초당 10회)을 던다.

`app.js`는 호스트를 보고 자동으로 갈라진다.
- `localhost` / `127.0.0.1` → 업비트 직접 호출
- 그 외 → `/api/upbit?path=...` 경유

**2026-08-10 Vercel 배포 완료.** GitHub 저장소를 Vercel에 연결하면
`api/upbit.js`가 자동으로 서버리스 함수가 된다. 이후 main에 푸시할 때마다 자동 재배포된다.

CLI(`npx vercel`)는 이 환경에서 한글 관련 오류로 로그인이 안 됐다
(`Cannot convert argument to a ByteString ... value of 44608`).
대시보드에서 Import하는 쪽이 확실하다.

시도한 무료 CORS 프록시(corsproxy.io / allorigins / codetabs / thingproxy)는
전부 실패하거나 유료 전환됐다. `r.jina.ai`만 응답하지만 마크다운으로 감싸 주고
서드파티 의존이라 채택하지 않았다.

### 배포 검증 (2026-08-10)

| 항목 | 결과 |
|---|---|
| `/api/upbit?path=ticker` | 200, 업비트 JSON 그대로 |
| `/api/upbit?path=candles/minutes/240&count=200` | 200, 캔들 200개 |
| CORS 헤더 | `Access-Control-Allow-Origin: *` |
| 화이트리스트 방어 | `path=orders` → 400 + 허용 목록 반환 |
| BTC(91,432,000원) | 4중 겹침 검출, 불변식 위반 0 |
| XEC(0.00947원) | 8자리 정밀도 유지, 4중 겹침, 불변식 위반 0 |
| 바이낸스 미상장 종목(XEC) | 펀딩·OI "데이터 없음" 표기 |
| 콘솔 에러 | 0건 |

## 로컬 실행

```bash
python -m http.server 8845 --directory "E:\AI 관련 자료\클로드\upbit_analyzer"
```

`file://`로 열면 CORS로 API 호출이 막힌다. 반드시 HTTP 서버로 띄운다.

## 안 하는 것

- **뉴스·락업 언락 조사**: 웹 검색이 필요해 브라우저 단독으로 불가능. `coin-ta-brief` 스킬 브리핑을 쓴다.
- **자동갱신 기본 ON**: 업비트 제한이 초당 10회다. 켜면 30초 간격으로 돌고, 기본은 꺼져 있다.
- **매매 신호·목표가 단정**: 조건부 시나리오(돌파 시 A / 이탈 시 B)만 낸다.
