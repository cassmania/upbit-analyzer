-- 실매매 승인 상태. 키 원문은 기존 upbit_private_credentials 행에 그대로 둔다.
-- live 주문은 이 행의 trade_enabled=true 일 때만 서버에서 MEXC로 전송된다.
-- 마이그레이션 미적용이면 trade.js가 SETUP_REQUIRED로 실패 종료(fail-closed)한다.
create table public.upbit_trade_state (
    user_id uuid primary key references auth.users(id) on delete cascade,
    trade_enabled boolean not null default false,
    max_notional numeric not null default 300 check (max_notional > 0 and max_notional <= 300),
    updated_at timestamptz not null default now()
);
alter table public.upbit_trade_state enable row level security;
revoke all on public.upbit_trade_state from anon;
grant select, insert, update on public.upbit_trade_state to authenticated;
create policy "자신의 매매 상태만 조회" on public.upbit_trade_state for select to authenticated using ((select auth.uid()) = user_id);
create policy "자신의 매매 상태만 등록" on public.upbit_trade_state for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "자신의 매매 상태만 변경" on public.upbit_trade_state for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
