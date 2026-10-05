-- Remove duplicate trade rows and stop them coming back.
-- Safe to re-run. Run it in the Supabase SQL editor.
--
-- Background: the bridge sync checked for an existing row with .single(),
-- which errors once a ticket has 2+ rows, so it inserted yet another copy on
-- every sync (234 phantom rows in the Oct 2026 export, one ticket 68 times).
--
-- Order of operations:
--   1. Run STEP 1 on its own first and look at the numbers.
--   2. Run STEP 2 (backup + delete + unique index) as one block.
--   3. Deploy the matching bridge.js fix (otherwise the old code keeps
--      trying to insert; the index will reject those inserts, which is fine,
--      but the fix stops the attempts).
--   4. Then run reconcile_history.py on the PC to correct the profit figures.

-- ── STEP 1: preview (read-only) ─────────────────────────────────────────────
SELECT
  COUNT(*)                                        AS total_rows,
  COUNT(DISTINCT (account_id, ticket))            AS distinct_tickets,
  COUNT(*) - COUNT(DISTINCT (account_id, ticket)) AS rows_to_remove
FROM public.trades
WHERE ticket IS NOT NULL;

-- ── STEP 2: backup, delete duplicates, add the unique index ────────────────
BEGIN;

-- Keep ONE row per (account, ticket). Preference: the row that carries the
-- signal link, then the one with close data, then a closed one, then lowest id.
CREATE TABLE IF NOT EXISTS public.trades_duplicates_backup AS
SELECT t.*, NOW() AS backed_up_at
FROM public.trades t
WHERE FALSE;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY account_id, ticket
           ORDER BY (signal_id    IS NOT NULL) DESC,
                    (close_price  IS NOT NULL) DESC,
                    (close_reason IS NOT NULL) DESC,
                    (status = 'closed')        DESC,
                    id
         ) AS rn
  FROM public.trades
  WHERE ticket IS NOT NULL
),
doomed AS (SELECT id FROM ranked WHERE rn > 1)
INSERT INTO public.trades_duplicates_backup
SELECT t.*, NOW()
FROM public.trades t
JOIN doomed d ON d.id = t.id;

DELETE FROM public.trades
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY account_id, ticket
             ORDER BY (signal_id    IS NOT NULL) DESC,
                      (close_price  IS NOT NULL) DESC,
                      (close_reason IS NOT NULL) DESC,
                      (status = 'closed')        DESC,
                      id
           ) AS rn
    FROM public.trades
    WHERE ticket IS NOT NULL
  ) x
  WHERE x.rn > 1
);

-- From now on the database itself refuses a second row for the same ticket.
CREATE UNIQUE INDEX IF NOT EXISTS trades_account_ticket_uniq
  ON public.trades (account_id, ticket)
  WHERE ticket IS NOT NULL;

COMMIT;

-- ── STEP 3: confirm (should show rows_to_remove = 0) ───────────────────────
SELECT
  COUNT(*)                                        AS total_rows,
  COUNT(DISTINCT (account_id, ticket))            AS distinct_tickets,
  COUNT(*) - COUNT(DISTINCT (account_id, ticket)) AS rows_to_remove
FROM public.trades
WHERE ticket IS NOT NULL;
