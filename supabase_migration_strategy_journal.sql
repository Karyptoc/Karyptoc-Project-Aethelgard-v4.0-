-- Strategy engine journal notes (stage 4).
-- Run once in Supabase -> SQL Editor. Safe to run again.
-- Lets the admin attach a note and tags to any strategy-engine trade on the Strategy Journal page.

create table if not exists public.strategy_trade_notes (
  account_login text not null,
  position_id bigint not null,
  note text not null default '',
  tags text[] not null default '{}',
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (account_login, position_id)
);

alter table public.strategy_trade_notes enable row level security;
drop policy if exists strategy_admin_read on public.strategy_trade_notes;
create policy strategy_admin_read on public.strategy_trade_notes for select using (public.is_admin());

-- Faster journal and signal pages
create index if not exists strategy_trades_open_time_idx on public.strategy_trades (open_time desc);
create index if not exists evaluations_eval_time_idx on public.evaluations (eval_time desc);
create index if not exists risk_decisions_evaluation_idx on public.risk_decisions (evaluation_id);
