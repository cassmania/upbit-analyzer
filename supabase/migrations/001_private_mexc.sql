-- API 키 원문은 서버에서 암호화한 후 이 테이블로 전달된다.
-- 기존 업무 테이블과 이름을 분리하며 이메일·잔고·비밀번호는 저장하지 않는다.
create table public.upbit_private_credentials (
    user_id uuid primary key references auth.users(id) on delete cascade,
    ciphertext text not null check (length(ciphertext) between 40 and 8192),
    updated_at timestamptz not null default now()
);
alter table public.upbit_private_credentials enable row level security;
revoke all on public.upbit_private_credentials from anon;
grant select, insert, update, delete on public.upbit_private_credentials to authenticated;
create policy "자신의 암호문만 조회" on public.upbit_private_credentials for select to authenticated using ((select auth.uid()) = user_id);
create policy "자신의 암호문만 등록" on public.upbit_private_credentials for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "자신의 암호문만 변경" on public.upbit_private_credentials for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "자신의 연결만 해제" on public.upbit_private_credentials for delete to authenticated using ((select auth.uid()) = user_id);

-- 로그인 취소 직후 이전 쿠키를 재전송해도 통과하지 않도록 실제 세션을 검사한다.
create function public.upbit_private_session_active() returns boolean
language sql stable security definer set search_path = '' as $$
    select exists (
        select 1 from auth.sessions s
        where s.id = (auth.jwt()->>'session_id')::uuid and s.user_id = auth.uid()
          and (s.not_after is null or s.not_after > now())
    );
$$;
revoke all on function public.upbit_private_session_active() from public, anon;
grant execute on function public.upbit_private_session_active() to authenticated;

-- 함수 외에는 읽거나 수정할 수 없는 요청 횟수 저장소다. 사용자당 한 행만 사용한다.
create table public.upbit_private_limits (
    bucket text primary key,
    window_start timestamptz not null,
    hits integer not null
);
alter table public.upbit_private_limits enable row level security;
revoke all on public.upbit_private_limits from public, anon, authenticated;
create function public.upbit_private_rate_limit() returns boolean
language plpgsql security definer set search_path = '' as $$
declare current_hits integer;
begin
    if auth.uid() is null or not public.upbit_private_session_active() then return false; end if;
    insert into public.upbit_private_limits as lim(bucket, window_start, hits)
    values ('account:' || auth.uid()::text, date_trunc('minute', now()), 1)
    on conflict (bucket) do update set
      hits = case when lim.window_start = date_trunc('minute', now()) then least(lim.hits + 1, 1000) else 1 end,
      window_start = date_trunc('minute', now())
    returning hits into current_hits;
    return current_hits <= 30;
end;
$$;
revoke all on function public.upbit_private_rate_limit() from public, anon;
grant execute on function public.upbit_private_rate_limit() to authenticated;

-- 익명 로그인도 전체 서버에서 분당 20회로 제한한다. 호출자가 제한값을 정할 수 없다.
create function public.upbit_private_login_limit() returns boolean
language plpgsql security definer set search_path = '' as $$
declare current_hits integer;
begin
    insert into public.upbit_private_limits as lim(bucket, window_start, hits)
    values ('login', date_trunc('minute', now()), 1)
    on conflict (bucket) do update set
      hits = case when lim.window_start = date_trunc('minute', now()) then least(lim.hits + 1, 1000) else 1 end,
      window_start = date_trunc('minute', now())
    returning hits into current_hits;
    return current_hits <= 20;
end;
$$;
revoke all on function public.upbit_private_login_limit() from public;
grant execute on function public.upbit_private_login_limit() to anon, authenticated;
