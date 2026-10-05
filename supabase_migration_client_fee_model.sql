-- Copy-trading fee arrangement per client: profit split OR fixed monthly fee.
-- Re-runnable. Existing clients stay on profit_split with their current
-- performance_fee_pct, so nothing changes for them.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR *BEFORE* pushing the matching backend
-- code; the clients list selects these columns and fails without them.

ALTER TABLE public.client_accounts
  ADD COLUMN IF NOT EXISTS fee_model TEXT NOT NULL DEFAULT 'profit_split';

ALTER TABLE public.client_accounts
  ADD COLUMN IF NOT EXISTS fixed_fee_amount NUMERIC NOT NULL DEFAULT 0;

-- Date the next monthly fee is charged (fixed_fee clients only).
ALTER TABLE public.client_accounts
  ADD COLUMN IF NOT EXISTS fixed_fee_next_due DATE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_accounts_fee_model_check'
  ) THEN
    ALTER TABLE public.client_accounts
      ADD CONSTRAINT client_accounts_fee_model_check
      CHECK (fee_model IN ('profit_split', 'fixed_fee'));
  END IF;
END $$;
