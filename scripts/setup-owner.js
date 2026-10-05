"use strict";
// scripts/setup-owner.js — 본인 PC에서만 실행. 서비스 키를 어디에도 전송·저장하지 않는다.
// 사용법 (Windows PowerShell):
//   $env:SUPABASE_URL = "https://프로젝트참조.supabase.co"
//   $env:SERVICE_ROLE_KEY = "service_role 키 (Settings → API)"
//   node scripts/setup-owner.js you@example.com "새비밀번호12자이상"
// 동작: Auth 사용자 생성(이미 있으면 비밀번호 재설정) + 이메일 즉시 확인 + UUID 출력.
// 출력된 UUID와 이메일을 Vercel의 PRIVATE_OWNER_ID / PRIVATE_OWNER_EMAIL에 등록한다.
const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const serviceKey = process.env.SERVICE_ROLE_KEY || "";
const [email, password] = process.argv.slice(2);
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url)) {
    console.error("SUPABASE_URL 오류: https://프로젝트참조.supabase.co 형식이어야 합니다.");
    process.exit(1);
}
if (!serviceKey || serviceKey.length < 20) {
    console.error("SERVICE_ROLE_KEY 오류: Supabase Settings → API에서 service_role 키를 복사해 환경변수로 넣으세요.");
    process.exit(1);
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "") || typeof password !== "string" || password.length < 12) {
    console.error("사용법: node scripts/setup-owner.js 이메일 12자이상비밀번호");
    process.exit(1);
}
(async () => {
    const headers = { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" };
    // 1) 기존 사용자 조회
    const list = await (await fetch(url + "/auth/v1/admin/users", { headers })).json().catch(() => ({}));
    const existing = Array.isArray(list.users) ? list.users.find(u => (u.email || "").toLowerCase() === email.toLowerCase()) : null;
    let user;
    if (existing) {
        const r = await fetch(url + "/auth/v1/admin/users/" + existing.id, { method: "PUT", headers,
            body: JSON.stringify({ password, email_confirm: true }) });
        if (!r.ok) throw new Error("비밀번호 재설정 실패 HTTP " + r.status);
        user = await r.json();
        console.log("기존 사용자 비밀번호 재설정 + 이메일 확인 완료");
    } else {
        const r = await fetch(url + "/auth/v1/admin/users", { method: "POST", headers,
            body: JSON.stringify({ email, password, email_confirm: true }) });
        if (!r.ok) throw new Error("사용자 생성 실패 HTTP " + r.status + " " + (await r.text()).slice(0, 200));
        user = await r.json();
        console.log("사용자 생성 + 이메일 확인 완료");
    }
    console.log("PRIVATE_OWNER_ID=" + user.id);
    console.log("PRIVATE_OWNER_EMAIL=" + user.email);
    console.log("위 두 값을 Vercel 환경변수에 등록하고 재배포하세요.");
})().catch(e => { console.error("실패: " + e.message); process.exit(1); });
