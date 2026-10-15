-- Aethelgard strategy engine — stage 2 (demo trading runtime for Strategies A and B)
-- Run once in the Supabase SQL editor, after supabase_migration_strategy_engine.sql. Safe to re-run.
-- Only adds tables/columns; nothing existing is changed or removed.

alter table public.evaluations add column if not exists order_key text;
alter table public.evaluations add column if not exists mode text;
create index if not exists evaluations_order_key_idx on public.evaluations (order_key);

alter table public.daily_profiles add column if not exists daily_vol numeric;

-- Trade journal for the strategy engine, rebuilt from MT5 deals every minute.
-- Kept separate from public.trades so the old engine's journal, pair stats and
-- auto-halt logic never see strategy-engine trades.
create table if not exists public.strategy_trades (
  account_login text not null,
  position_id bigint not null,
  strategy_id text not null,
  strategy_version int,
  broker_symbol text not null,
  side text not null check (side in ('buy', 'sell')),
  lots numeric not null,
  order_key text,
  requested_price numeric,
  open_price numeric,
  open_time timestamptz,
  slippage_price numeric,
  status text not null check (status in ('open', 'closed')),
  close_price numeric,
  close_time timestamptz,
  close_reason text,
  profit numeric,
  swap numeric,
  commission numeric,
  updated_at timestamptz not null default now(),
  primary key (account_login, position_id)
);

-- Equity reference points for the daily / weekly / drawdown limits.
create table if not exists public.strategy_account_state (
  login text primary key,
  day_key date not null,
  start_of_day_equity numeric not null,
  week_key date not null,
  start_of_week_equity numeric not null,
  peak_equity numeric not null,
  updated_at timestamptz not null default now()
);

alter table public.strategy_trades enable row level security;
alter table public.strategy_account_state enable row level security;
drop policy if exists strategy_admin_read on public.strategy_trades;
create policy strategy_admin_read on public.strategy_trades for select using (public.is_admin());
drop policy if exists strategy_admin_read on public.strategy_account_state;
create policy strategy_admin_read on public.strategy_account_state for select using (public.is_admin());
