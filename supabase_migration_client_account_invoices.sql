-- ============================================================
-- AETHELGARD — Pesapal wiring for copy-trading performance fees
-- Roadmap Phase 3, item 17.
--
-- The `invoices` table (System A: billing on the admin's OWN mt5_accounts,
-- via the `clients` table) already has a full Pesapal flow: create ->
-- submitOrder -> pesapal_tracking_id/payment_url -> callback/IPN -> paid.
--
-- client_accounts (System B: independent copy-trading clients) accrues
-- a `pending_fee` balance (performance fee on winning trades, high-water-
-- mark based) but has NO collection mechanism at all today — nothing
-- ever creates an invoice or a payment link for it.
--
-- This migration extends the EXISTING invoices table with an optional
-- reference to client_accounts, instead of creating a second parallel
-- invoices table or duplicating the Pesapal service/webhook code. Each
-- invoice row now belongs to exactly one of the two systems:
--   - client_id IS NOT NULL, client_account_id IS NULL  -> System A (existing)
--   - client_id IS NULL, client_account_id IS NOT NULL  -> System B (new)
--
-- Run this entire file once in the Supabase SQL Editor.
-- ============================================================

-- 1. client_id must become nullable — a System B invoice has no `clients` row.
ALTER TABLE public.invoices
  ALTER COLUMN client_id DROP NOT NULL;

-- 2. Add the new, equally-nullable reference to client_accounts.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS client_account_id UUID REFERENCES public.client_accounts(id) ON DELETE CASCADE;

-- 3. Exactly one of the two must be set — never both, never neither.
ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_exactly_one_client_type;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_exactly_one_client_type
  CHECK (
    (client_id IS NOT NULL AND client_account_id IS NULL) OR
    (client_id IS NULL AND client_account_id IS NOT NULL)
  );

-- 4. Index for the new lookup path (client-portal "my fee invoices", and
--    decrementing pending_fee on payment confirmation).
CREATE INDEX IF NOT EXISTS idx_invoices_client_account_id
  ON public.invoices(client_account_id);
