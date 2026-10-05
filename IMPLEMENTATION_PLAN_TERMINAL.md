# AI 선물 터미널 (terminal.html)

스크린샷 형식의 MEXC 선물 터미널. 티커바·차트·오더북·주문·지갑·포지션·AI 전략을 한 페이지에 둔다.
원칙: **기본은 관망·모의. 실매매는 아래 5단계를 모두 마쳐야만 나간다.**

## 실매매 활성화 순서 (건너뛰면 영원히 모의로만 동작한다)

1. Supabase에 `supabase/migrations/002_trade_state.sql` 적용 (미적용이면 live 503 fail-closed)
2. Vercel 환경변수 기존 5종 + `TRADE_KILL_SWITCH=0` 확인
3. MEXC에서 **선물 주문 권한** 키 발급 (출금 권한 절대 금지, IP 화이트리스트 권장, KYC 필요)
4. 터미널 AI 패널 → 실매매 승인 → 키 등록 (확인 문구 `ENABLE-LIVE-TRADE` 필수, 키는 서버 암호문 저장)
5. ARMED 후 수동 주문·자동매매(실매매) ON

## 강제 상한 (lib/trade-guards.js)

- 격리(isolated) 고정, 교차 거부 / 지정가·시장가만 / **실주문 레버리지 1~10X (25X·500X 불가)** / 모의는 500X까지 허용
- 주문당 명목가 $5~$300 (실주문) / 지정가는 현재가 ±10% 밴드 / 손절·목표 방향 검증
- 멱등키 `KRTA-<uuid>`를 externalOid로 사용해 중복 제출 방지

## 파일

- `terminal.html/css/js` — 화면. 차트 라이브러리는 `vendor/` 자가 호스팅 (CSP `script-src 'self'` 유지)
- `api/mexc-futures.js` — 선물 공개 시세 프록시 (ticker/depth/kline/funding_rate/deals/detail/fair_price/index_price)
- `api/private/trade.js` — 주문 게이트웨이 (dry-run 기본, status/enable/disable/submit/cancel)
- `lib/mexc-trade.js` — 선물 POST 서명 (JSON 본문 서명, allowlist 2개 경로)
- `lib/trade-guards.js` — 순수 검증 (`node test_trade_guards.js`)
- `test_trade_guards.js`, `supabase/migrations/002_trade_state.sql`

## 한계 (v1)

- 12H봉은 MEXC에 없어 60m봉 리샘플로 표시한다
- 자동매매 진입은 주문당 $50 명목가 고정 시장가,同一 방향 쿨다운 5분
- OI·청산맵·온체인은 미지원 (기존 분석 페이지와 동일)
- 투자 권유가 아니며, 레버리지 선물은 원금 초과 손실이 가능하다
