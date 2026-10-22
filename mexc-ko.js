/* MEXC 한국어 사전. 로그인·API 호출 없음. 정적 표 + 검색 필터만. */
(function () {
"use strict";
const $ = id => document.getElementById(id);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const GROUPS = [
{ name: "왼쪽 메뉴", where: "MEXC 로그인 후 왼쪽 사이드바", items: [
["Profile", "프로필", "내 계정 요약·UID·가입일"],
["Security", "보안", "2FA·비밀번호·출금 보안 설정"],
["Identification", "본인인증", "KYC 신분증 인증"],
["Referral", "추천인", "친구 초대 수수료 공유"],
["Trading Fees", "거래 수수료", "등급별 수수료율"],
["Withdrawal Addresses/Contacts", "출금주소/연락처", "화이트리스트·주소록 관리"],
["Sub-Account Management", "서브계정 관리", "하위 계정 생성·관리"],
["API Management", "API 관리", "API 키 발급·권한·IP 제한"],
["Settings", "설정", "알림·언어 등 일반 설정"],
["Wallets", "지갑", "현물·선물 자산 조회"],
["Orders", "주문", "미체결·체결 내역"],
["Deposit", "입금", "코인 입금 주소 확인"],
["Transfer", "이체", "현물↔선물 등 내부 자금 이동"]
]},
{ name: "선물 주문창", where: "선물 거래 화면 오른쪽 주문 패널", items: [
["Isolated", "격리", "포지션별 증거금 분리 모드"],
["Cross", "교차", "계정 전체 잔고를 증거금으로 쓰는 모드"],
["Leverage", "레버리지", "배율 (예: 25X)"],
["Limit", "지정가", "가격을 정해 주문"],
["Market", "시장가", "현재가로 즉시 체결"],
["Trigger", "트리거(조건부)", "조건가 도달 시 발동되는 예약 주문"],
["Quantity (USDT)", "수량", "주문 금액 기준 수량"],
["Available", "가용", "사용 가능한 잔고"],
["Max Long / Max Short", "최대 롱 / 최대 숏", "현재 증거금으로 낼 수 있는 최대치"],
["Buy/Long", "매수/롱", "오르면 수익"],
["Sell/Short", "매도/숏", "내리면 수익"],
["Margin", "증거금", "포지션 유지에 묶이는 돈"],
["MTL", "MTL", "시장가 변형 주문 방식 중 하나"],
["Reduce-Only Orders", "리듀스 온리", "포지션 줄이는 방향의 주문만 허용"],
["TP/SL", "익절/손절", "목표가·손절가 예약"],
["Fee rate", "수수료율", "Maker/Taker 수수료"],
["Funding Rate", "펀딩비", "8시간마다 롱↔숏 정산 수수료"],
["Open Interest", "미결제약정", "청산 안 된 포지션 총합"],
["Mark Price", "마크가격", "청산·미실현손익 기준가"],
["Liquidation Price", "청산가", "강제청산되는 가격"],
["Unrealized PNL", "미실현 손익", "아직 실현 안 된 평가손익"],
["Realized PNL", "실현 손익", "확정된 손익"],
["Flash Close", "즉시 청산", "시장가로 바로 닫기"],
["Reverse", "역방향 전환", "반대 포지션으로 뒤집기"],
["Add Margin", "마진 추가", "증거금 보충해 청산가 밀어내기"]
]},
{ name: "본인인증(KYC)", where: "프로필 → 본인인증(Identification)", items: [
["Advanced KYC", "고급 본인인증", "한도 상향된 인증 단계"],
["Verified", "인증됨", "인증 완료 상태"],
["Account Benefits", "계정 혜택", "등급별 한도·혜택 표"],
["KYC Level", "본인인증 등급", "현재 인증 단계"],
["Crypto Deposit", "코인 입금", "입금 한도 (등급별 상이)"],
["Crypto Withdrawal", "코인 출금", "일 출금 한도 (예: 20M USDT)"],
["Fiat Trading", "법정화폐 거래", "원화·달러 직접 거래 한도"],
["Spot/Futures Trading", "현물/선물 거래", "거래 가능 여부"],
["Platform Events", "플랫폼 이벤트", "이벤트 참여 가능 여부"],
["My KYC Details", "내 인증 정보", "등록된 신분증 정보"],
["Country/Region", "국가/지역", "등록 국가"],
["ID Type / ID Number", "신분증 종류 / 번호", "ID card 등"],
["Birth Date", "생년월일", "등록 생년월일"],
["Update ID Document", "신분증 업데이트", "서류 다시 제출"]
]},
{ name: "보안", where: "프로필 → 보안(Security)", items: [
["Two-Factor Authentication (2FA)", "2단계 인증", "OTP·패스키 등 추가 인증"],
["Passkey", "패스키", "지문·얼굴 등 기기 인증"],
["Email Verification", "이메일 인증", "로그인·출금 확인용 메일"],
["Mobile Verification", "휴대폰 인증", "SMS 인증번호"],
["MEXC/Google Authenticator", "인증기 앱(OTP)", "6자리 일회용 번호 앱"],
["Palm Recognition", "손바닥 인식", "고위험 상황 추가 인증"],
["Anti-Phishing Code", "안티피싱 코드", "진짜 MEXC 메일 판별용 문구"],
["Login Password", "로그인 비밀번호", "계정 비밀번호 변경"],
["Fast Withdrawal", "빠른 출금", "소액 출금 시 인증 생략 (위험)"],
["Withdrawal Whitelist", "출금 화이트리스트", "등록 주소로만 출금 허용"],
["Withdrawal Protection", "출금 보호", "잠금 기간에 온체인 출금 자동 거부"],
["Third-Party Account Authorization", "제3자 계정 연동", "Google·Apple·지갑 로그인 연결"],
["Devices and Activities", "기기·활동 기록", "로그인 이력 조회"],
["Device Management", "기기 관리", "접속 허용 기기 관리"],
["Freeze Account", "계정 동결", "전 기능 즉시 정지"],
["MEXC Verify", "MEXC 공식 채널 확인", "텔레그램 등의 사칭 여부 조회"]
]},
{ name: "출금주소 관리", where: "프로필 → 출금주소/연락처", items: [
["Address Management", "주소 관리", "출금 주소 목록"],
["Contact Management", "연락처 관리", "자주 쓰는 상대 목록"],
["Crypto", "코인", "자산 종류 선택"],
["Whitelisted", "화이트리스트 등록 여부", "등록/미등록 필터"],
["Address Type", "주소 유형", "일반/화이트리스트 구분"],
["Bulk Adding", "일괄 추가", "여러 개 한 번에 등록"],
["Add Withdrawal Address", "출금주소 추가", "새 주소 등록"],
["Network", "네트워크", "TRX·ETH·APTOS 등 전송망"],
["Label", "라벨", "주소 별명 (예: 바이낸스 입금주소)"],
["Memo/Tag", "메모/태그", "XRP·EOS 등에 필요한 추가 번호"],
["On Whitelist", "화이트리스트 등록 여부", "Yes/No"]
]},
{ name: "자주 묻는 말(FAQ)", where: "본인인증 페이지 하단", items: [
["Why is KYC verification necessary?", "왜 본인인증이 필요한가요?", "규제·보안상 의무"],
["How to complete personal KYC verification?", "개인 본인인증은 어떻게 하나요?", "신분증+얼굴인증 절차"],
["What documents can I use?", "어떤 서류를 쓸 수 있나요?", "신분증·여권·운전면허 등"],
["Why did my KYC verification fail?", "본인인증이 왜 실패했나요?", "흔들림·정보 불일치 등"]
]}
];
function render(q) {
    q = (q || "").trim().toLowerCase();
    const box = $("koOut");
    box.innerHTML = "";
    GROUPS.forEach(g => {
        const rows = g.items.filter(([en, ko]) => !q || en.toLowerCase().includes(q) || ko.includes(q));
        if (!rows.length) return;
        const sec = document.createElement("section");
        sec.className = "card";
        const h = document.createElement("h2");
        h.textContent = g.name;
        const w = document.createElement("p");
        w.className = "ko-where";
        w.textContent = g.where;
        const wrap = document.createElement("div");
        wrap.className = "scroll";
        wrap.style.overflowX = "auto";
        const tb = document.createElement("table");
        const thead = document.createElement("thead");
        thead.innerHTML = "<tr><th>영어</th><th>한국어 뜻</th></tr>";
        const tb2 = document.createElement("tbody");
        rows.forEach(([en, ko]) => {
            const tr = document.createElement("tr");
            const a = document.createElement("td"); a.className = "en"; a.textContent = en;
            const b = document.createElement("td"); b.textContent = ko;
            tr.append(a, b); tb2.append(tr);
        });
        tb.append(thead, tb2); wrap.append(tb);
        sec.append(h, w, wrap); box.append(sec);
    });
    if (!box.children.length) {
        const p = document.createElement("p");
        p.className = "dim";
        p.textContent = "검색 결과 없음";
        box.append(p);
    }
}
$("koQ").addEventListener("input", e => render(e.target.value));
render("");
})();
