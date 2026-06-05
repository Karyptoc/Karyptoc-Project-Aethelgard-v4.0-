-- ============================================================
-- AETHELGARD TRADING PLATFORM - SUPABASE SCHEMA
-- Run this entire file in Supabase SQL Editor
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- PROFILES (extends Supabase auth.users)
-- ============================================================
CREATE TABLE public.profiles (
  id UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  email TEXT NOT NULL,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'client')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'full_name');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- MT5 ACCOUNTS
-- ============================================================
CREATE TABLE public.mt5_accounts (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  owner_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  login TEXT NOT NULL,
  server TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'demo' CHECK (account_type IN ('demo', 'live')),
  balance NUMERIC(15,2) DEFAULT 0,
  equity NUMERIC(15,2) DEFAULT 0,
  margin NUMERIC(15,2) DEFAULT 0,
  free_margin NUMERIC(15,2) DEFAULT 0,
  profit NUMERIC(15,2) DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  leverage INTEGER DEFAULT 100,
  is_active BOOLEAN DEFAULT TRUE,
  is_connected BOOLEAN DEFAULT FALSE,
  last_sync TIMESTAMPTZ,
  risk_percent NUMERIC(5,2) DEFAULT 1.0,
  max_daily_loss NUMERIC(5,2) DEFAULT 5.0,
  max_trades INTEGER DEFAULT 5,
  allowed_pairs TEXT[] DEFAULT ARRAY['XAUUSD','EURUSD','GBPUSD','USDJPY'],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.mt5_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage all accounts"
  ON public.mt5_accounts FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

CREATE POLICY "Owners can view own accounts"
  ON public.mt5_accounts FOR SELECT
  USING (owner_id = auth.uid());

-- ============================================================
-- CLIENTS
-- ============================================================
CREATE TABLE public.clients (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  admin_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  subscription_type TEXT DEFAULT 'profit_split' CHECK (subscription_type IN ('monthly', 'profit_split', 'free')),
  subscription_amount NUMERIC(10,2) DEFAULT 0,
  profit_split_percent NUMERIC(5,2) DEFAULT 20.0,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
  notes TEXT,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage clients"
  ON public.clients FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- ============================================================
-- TRADES
-- ============================================================
CREATE TABLE public.trades (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  account_id UUID REFERENCES public.mt5_accounts(id) ON DELETE CASCADE,
  ticket BIGINT,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('BUY', 'SELL')),
  volume NUMERIC(10,2) NOT NULL,
  open_price NUMERIC(15,5),
  close_price NUMERIC(15,5),
  stop_loss NUMERIC(15,5),
  take_profit NUMERIC(15,5),
  profit NUMERIC(15,2),
  commission NUMERIC(10,2) DEFAULT 0,
  swap NUMERIC(10,2) DEFAULT 0,
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'closed', 'pending', 'cancelled')),
  open_time TIMESTAMPTZ,
  close_time TIMESTAMPTZ,
  signal_id UUID,
  regime TEXT,
  confidence NUMERIC(5,3),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage all trades"
  ON public.trades FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- ============================================================
-- SIGNALS (Claude AI generated)
-- ============================================================
CREATE TABLE public.signals (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('BUY', 'SELL', 'HOLD')),
  entry_price NUMERIC(15,5),
  stop_loss NUMERIC(15,5),
  take_profit NUMERIC(15,5),
  confidence NUMERIC(5,3),
  regime TEXT,
  regime_detail JSONB,
  sentiment_score NUMERIC(5,3),
  timeframe TEXT,
  rationale TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'executed', 'expired', 'cancelled')),
  executed_accounts INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

ALTER TABLE public.signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage signals"
  ON public.signals FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- ============================================================
-- ACCOUNT SNAPSHOTS (for equity curve)
-- ============================================================
CREATE TABLE public.account_snapshots (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  account_id UUID REFERENCES public.mt5_accounts(id) ON DELETE CASCADE,
  balance NUMERIC(15,2),
  equity NUMERIC(15,2),
  profit NUMERIC(15,2),
  open_trades INTEGER DEFAULT 0,
  snapshot_time TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.account_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view all snapshots"
  ON public.account_snapshots FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- ============================================================
-- SYSTEM LOGS
-- ============================================================
CREATE TABLE public.system_logs (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  level TEXT DEFAULT 'info' CHECK (level IN ('info', 'warning', 'error', 'critical')),
  source TEXT,
  message TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.system_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view logs"
  ON public.system_logs FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- ============================================================
-- PLATFORM SETTINGS
-- ============================================================
CREATE TABLE public.platform_settings (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  value JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage settings"
  ON public.platform_settings FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = auth.uid() AND role = 'admin'
    )
  );

-- Insert default settings
INSERT INTO public.platform_settings (key, value) VALUES
  ('trading_enabled', 'true'),
  ('signal_interval_minutes', '15'),
  ('max_concurrent_trades', '5'),
  ('default_risk_percent', '1.0'),
  ('allowed_pairs', '["XAUUSD","EURUSD","GBPUSD","USDJPY"]'),
  ('circuit_breaker_daily_loss_pct', '5.0'),
  ('platform_name', '"Aethelgard"');

-- ============================================================
-- HELPER FUNCTION: is_admin
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER update_mt5_accounts_updated_at
  BEFORE UPDATE ON public.mt5_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
