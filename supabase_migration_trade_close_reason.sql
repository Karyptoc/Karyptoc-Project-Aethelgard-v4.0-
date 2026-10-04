-- ============================================================
-- AETHELGARD — trade close_reason column (Roadmap Phase 4: TP/SL-hit notifier)
--
-- Today, nothing in the pipeline distinguishes "take profit hit" from
-- "stop loss hit" from "closed manually" — bridge.py only pulled
-- profit/swap/commission/close_price/close_time from MT5's deal history,
-- never the deal's `reason` field. This column stores that classification
-- so the backend can react differently to a TP vs an SL close (notify,
-- analytics, etc.) instead of treating every close the same way.
--
-- Values: 'tp' | 'sl' | 'stop_out' (margin stop-out) | 'manual' | 'unknown'
-- (unknown = real deal history wasn't available this sync cycle — see
-- bridge.js's existing fallback-close path).
--
-- Run this entire file once in the Supabase SQL Editor.
-- ============================================================

ALTER TABLE public.trades
  ADD COLUMN IF NOT EXISTS close_reason TEXT
  CHECK (close_reason IN ('tp', 'sl', 'stop_out', 'manual', 'unknown'));

CREATE INDEX IF NOT EXISTS idx_trades_close_reason
  ON public.trades(close_reason)
  WHERE close_reason IS NOT NULL;
