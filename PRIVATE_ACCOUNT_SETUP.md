# 내 MEXC 연결 안내

## 무엇을 구현했나요?

공개 분석 화면의 `내 MEXC · 본인 전용` 버튼으로 개인 화면을 연다. 개인 화면은 로그인 후 서버에서 허용 사용자 ID가 일치하는지 확인해야 작동한다. 화면 주소를 아는 다른 사람도 계정 API를 조회할 수 없다.

첫 단계는 조회 전용이다. 현물 잔고, 선물 자산, 롱/숏 포지션, 평균 진입가, 제공되는 미실현 손익, 격리 청산가, 일반 미체결 주문을 조회한다. 선물 주문은 첫 100건으로 제한하고, 예약/TP/SL 주문은 별도로 지원하지 않는다는 안내를 표시한다. 계정 값은 공개 브리핑에 들어가지 않는다.

## 배포 관리자 설정

1. 사용할 Supabase 프로젝트를 활성화한다. 기존 프로젝트가 다른 서비스용이면 별도 프로젝트를 사용한다.
2. SQL Editor에서 `supabase/migrations/001_private_mexc.sql`을 적용한다. 이미 적용했다면 다시 실행하지 않는다.
3. Supabase Authentication에서 본인 로그인 계정을 준비하고 이메일 확인을 완료한다. 사용자 UUID를 확인한다. 기존 사용자의 비밀번호를 임의 변경하지 않는다.
4. Vercel의 `upbit-analyzer` 프로젝트 → Settings → Environment Variables에 아래 서버 환경 변수를 등록한다.

| 이름 | 넣을 값 |
| --- | --- |
| PRIVATE_APP_ORIGIN | https://upbit-analyzer.vercel.app |
| PRIVATE_SUPABASE_URL | 선택한 프로젝트의 https://프로젝트참조.supabase.co 주소 |
| PRIVATE_SUPABASE_ANON_KEY | 해당 프로젝트 Settings → API의 legacy anon JWT 키. service_role 키는 사용하지 않는다 |
| PRIVATE_OWNER_ID | 본인으로 확인한 Supabase 사용자 UUID |
| PRIVATE_ENCRYPTION_KEY | 안전하게 생성한 무작위 32바이트의 64자리 16진수 값 |

환경 변수는 Production 서버용으로 등록하고 재배포한다. 암호화 키를 바꾸면 저장된 MEXC 키를 다시 연결해야 한다. 키는 채팅, Git, 프런트엔드 환경 변수에 넣지 않는다. 미설정 또는 서비스 장애 시 개인 기능은 차단된다.

로그인 시 분당 최대 20회, 로그인 후 MEXC 조회는 사용자당 분당 최대 30회로 DB에서 제한한다. 로그인은 전체 사용자 합산 제한이므로 인증 서비스 자체의 보안·속도 제한 설정도 유지한다. 최초 버전은 세션 최대 1시간이며 이후 다시 로그인한다.

## MEXC 연결

1. MEXC API 관리에서 읽기 전용 키를 발급한다. 필요한 권한은 현물 계정 조회, 선물 계정 정보 조회, 주문 정보 조회다. 출금·거래 권한은 켜지 않는다.
2. API 키에 IP 제한을 설정할 경우 먼저 Vercel 서버의 고정 송신 IP 지원 여부를 확인한다. 브라우저를 사용하는 PC의 IP는 중계 서버의 IP와 다를 수 있다.
3. 공개 사이트에서 `내 MEXC` → 본인 로그인 → `MEXC API 연결 설정`을 연다. 여기의 로그인 비밀번호는 사이트 인증 계정의 비밀번호이며 MEXC 비밀번호가 아니다.
4. Access Key와 Secret Key를 직접 입력하고 읽기 전용 여부를 확인한 뒤 저장한다. 서버가 최소 하나의 계정 잔고 조회에 성공해야 연결을 저장한다. 키의 모든 권한을 자동 검사했다고 주장하지 않으며 중계 서버 자체는 허용된 조회 경로만 호출한다.
5. 잔고·포지션을 확인하고 필요하면 30초 자동갱신을 켠다. 화면을 숨기면 개인 값을 지우며 돌아오면 다시 조회한다.
6. 로그아웃하면 서버 인증 세션을 폐기한다. 연결 해제는 저장된 암호문을 제거하며, MEXC에서 발급한 키 자체를 폐기하는 것은 아니다.

## 코드가 하는 일

- `lib/private-security.js`: 서버 설정 확인, AES-GCM 암복호화, 출처 검사, 로그인 검증, 요청 횟수 제한, 안전한 오류 응답을 담당한다. 데이터 암호문의 목적과 사용자 ID를 묶어 다른 사용자의 키로 해독하지 못하도록 한다.
- `api/private/session.js`: Supabase로 로그인하고, 허용된 본인에게만 암호화된 HttpOnly 쿠키를 발급한다. 로그아웃 후 이전 쿠키 재사용은 DB의 실제 세션 유무를 확인해 차단한다.
- `lib/mexc-account.js`: 공식 현물/선물 서명을 계산하고 조회 결과에서 화면에 필요한 필드만 추린다. 한 항목이 실패해도 성공한 항목은 표시한다.
- `api/private/mexc.js`: 인증 → 요청 제한 → 키 복호화 → 거래소 조회 순서를 지킨다. 키 등록 시 DB로 보내기 전에 암호화한다.
- `account.js`: 로그인 및 연결 폼을 처리하고 결과를 안전한 텍스트 노드로 표시한다. 비밀 키와 잔고를 localStorage에 저장하지 않는다.
- `scripts/build-public.js`: 공개 파일 목록만 복사한다. SQL, 서버 구현, 테스트, 환경 설정은 정적 사이트에 공개하지 않는다. 기존 백테스트 보고서 링크는 유지한다.

## 검증 범위와 남은 항목

- 로컬 보안 테스트: 비로그인·다른 사용자·위조 출처·로그아웃 세션·암호문 변조 차단, 요청 제한, 서명 계산, 연결 검증 실패 시 기존 키 보존.
- 브라우저: 가상 계정 로그인 → 테스트 키 연결 → 잔고·롱/숏 표시 → 로그아웃 → 새로고침 시 차단 확인. 390px 화면에서 가로 넘침 없음.
- 실제 MEXC 키와 활성 Supabase 설정이 없는 상태에서 실제 잔고 연결 성공으로 보고하지 않는다.
- 다음 단계: CVD·뉴스 및 전문 공급업체 청산맵·온체인·고래·언락 연결. 이 계정 기능만으로 해당 외부 지표가 연결되는 것은 아니다.

## 공식 문서

- MEXC 선물 서명: https://www.mexc.com/api-docs/futures/integration-guide
- MEXC 포지션: https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/get-open-positions
- MEXC 일반 주문: https://www.mexc.com/api-docs/futures/account-and-trading-endpoints/get-current-orders
- Supabase 세션 검증: https://supabase.com/docs/guides/auth/sessions
