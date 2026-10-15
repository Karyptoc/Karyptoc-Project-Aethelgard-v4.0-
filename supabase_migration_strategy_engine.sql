-- Aethelgard strategy engine (Strategies A, B, C) + strategy admin controls
-- Run once in the Supabase SQL editor (project syyyiezattmsswardedr). Safe to re-run.
-- The backend uses the service-role key, which bypasses RLS.
-- Admin access reuses the existing profiles.role = 'admin' and public.is_admin().
-- Adds columns to public.trades (existing rows are untouched; new columns are null).

create table if not exists public.strategy_admin_settings (
  id int primary key check (id = 1),
  settings jsonb not null,
  version int not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.strategy_admin_audit (
  id bigserial primary key,
  path text not null,
  old_value jsonb,
  new_value jsonb,
  actor text not null,
  reason text,
  settings_version int,
  created_at timestamptz not null default now()
);

create table if not exists public.strategy_admin_commands (
  id bigserial primary key,
  command text not null check (command in ('flatten', 'flatten_all', 'reconcile_now', 'resync_specs')),
  strategy text,
  symbol text,
  requested_by text not null,
  reason text,
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  result jsonb,
  created_at timestamptz not null default now(),
  done_at timestamptz
);

create table if not exists public.strategies (
  id text primary key,                 -- 'A' | 'B' | 'C'
  name text not null,
  magic_number int not null unique
);
insert into public.strategies (id, name, magic_number) values
  ('A', 'Noise-area intraday momentum (indices)', 710001),
  ('B', 'Noise-area intraday momentum (gold)',    710002),
  ('C', 'Daily Donchian-ensemble trend',          710003)
on conflict (id) do nothing;

create table if not exists public.strategy_versions (
  strategy_id text references public.strategies(id),
  version int not null,
  params jsonb not null,
  code_commit text,
  approved_by text,
  approved_at timestamptz,
  approval_ref text,
  created_at timestamptz not null default now(),
  primary key (strategy_id, version)
);

create table if not exists public.symbol_map (
  broker_profile text not null,        -- 'XM' | 'HFM' | 'EXNESS' | 'PEPPERSTONE'
  instrument text not null,            -- canonical id, e.g. 'NAS100'
  broker_symbol text not null,         -- e.g. 'US100Cash'
  source text not null default 'resolver' check (source in ('resolver', 'admin')),
  updated_at timestamptz not null default now(),
  primary key (broker_profile, instrument)
);

create table if not exists public.symbol_specs (
  broker_profile text not null,
  broker_symbol text not null,
  spec_date date not null,
  contract_size numeric, tick_size numeric, tick_value numeric, point numeric, digits int,
  volume_min numeric, volume_step numeric, volume_max numeric,
  trade_stops_level int, filling_mode int, margin_per_lot numeric,
  swap_long numeric, swap_short numeric, currency_profit text,
  raw jsonb,
  primary key (broker_profile, broker_symbol, spec_date)
);

create table if not exists public.daily_profiles (
  instrument text not null,
  session_date date not null,
  strategy_id text not null,
  open_price numeric, prev_close numeric,
  sigma jsonb not null,                -- { "600": 0.0021, "630": 0.0029, ... } minute -> sigma
  lookback int not null,
  data_hash text not null,
  created_at timestamptz not null default now(),
  primary key (instrument, session_date, strategy_id)
);

create table if not exists public.evaluations (
  id bigserial primary key,
  strategy_id text not null,
  strategy_version int not null,
  instrument text not null,
  eval_time timestamptz not null,
  checkpoint_minute int,
  price numeric, ub numeric, lb numeric, vwap numeric, signal numeric,
  position_before int,
  target int,
  action text not null,                -- enter_long | enter_short | exit | reverse_* | hold | none
  reason text,
  unique (strategy_id, instrument, eval_time)   -- duplicate-evaluation guard
);

create table if not exists public.targets (
  id bigserial primary key,
  strategy_id text not null,
  instrument text not null,
  target_lots numeric not null,
  raw_signal numeric,
  evaluation_id bigint references public.evaluations(id),
  created_at timestamptz not null default now()
);

create table if not exists public.risk_decisions (
  id bigserial primary key,
  strategy_id text not null,
  symbol text not null,
  desired_lots numeric,
  final_lots numeric,
  approved boolean not null,
  shadow boolean not null default false,
  skip_reason text,
  steps jsonb not null,
  evaluation_id bigint references public.evaluations(id),
  created_at timestamptz not null default now()
);

create table if not exists public.reconciliations (
  id bigserial primary key,
  broker_positions jsonb not null,
  virtual_positions jsonb not null,
  mismatch boolean not null,
  details text,
  created_at timestamptz not null default now()
);

create table if not exists public.spread_stats (
  broker_profile text not null,
  broker_symbol text not null,
  hour_utc int not null check (hour_utc between 0 and 23),
  sample_days int not null,
  median_spread_points numeric,
  p90_spread_points numeric,
  updated_at timestamptz not null default now(),
  primary key (broker_profile, broker_symbol, hour_utc)
);

create table if not exists public.trial_registry (
  id bigserial primary key,
  strategy_id text not null,
  params jsonb not null,
  instrument text not null,
  data_from date, data_to date,
  cost_multiplier numeric not null default 1.0,
  sample text not null check (sample in ('development', 'validation', 'holdout', 'walk_forward', 'demo')),
  trades int, net_expectancy_r numeric, profit_factor numeric, sharpe numeric, max_dd numeric,
  notes text,
  created_at timestamptz not null default now()
);

-- Link trades to strategies (old ICT/SMC trades keep strategy_id = null).
alter table if exists public.trades add column if not exists strategy_id text;
alter table if exists public.trades add column if not exists strategy_version int;
alter table if exists public.trades add column if not exists evaluation_id bigint;
alter table if exists public.trades add column if not exists requested_price numeric;
alter table if exists public.trades add column if not exists slippage_points numeric;
alter table if exists public.trades add column if not exists shadow boolean default false;

-- RLS: lock everything to admins (service role bypasses RLS).
do $$
declare t text;
begin
  foreach t in array array['strategy_admin_settings','strategy_admin_audit','strategy_admin_commands','strategy_versions',
    'symbol_map','symbol_specs','daily_profiles','evaluations','targets','risk_decisions','reconciliations',
    'spread_stats','trial_registry','strategies']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists strategy_admin_read on public.%I', t);
    execute format('create policy strategy_admin_read on public.%I for select using (public.is_admin())', t);
  end loop;
end $$;
