-- Aethelgard — stage 3: account removal + strategy engine account details
-- Run once in the Supabase SQL editor. Safe to re-run. Only adds columns.

-- Removed accounts that still have trade history are archived (hidden, switched off), never deleted,
-- because deleting an mt5_accounts row also deletes its trades and snapshots (ON DELETE CASCADE).
alter table public.mt5_accounts add column if not exists archived boolean not null default false;

-- Balance and account details reported by the strategy bridge every minute (shown on the Accounts page).
alter table public.strategy_account_state add column if not exists equity numeric;
alter table public.strategy_account_state add column if not exists balance numeric;
alter table public.strategy_account_state add column if not exists currency text;
alter table public.strategy_account_state add column if not exists server text;
alter table public.strategy_account_state add column if not exists margin numeric;
alter table public.strategy_account_state add column if not exists margin_free numeric;
alter table public.strategy_account_state add column if not exists trade_mode int;
