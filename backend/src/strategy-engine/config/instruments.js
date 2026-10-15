'use strict';
/**
 * Canonical instrument catalogue.
 *
 * Strategies only ever use the canonical id (e.g. "NAS100"). The broker symbol
 * (e.g. "US100Cash" on XM, "USTEC" on Exness) is resolved per broker profile,
 * first by the MT5 bridge's symbol resolver (bridge/symbol_resolver.py), which
 * tries the candidates below against the symbols the terminal actually lists.
 * The resolved names are stored in Supabase (symbol_map) and can be overridden
 * from the admin page. Candidate lists are starting guesses, NOT verified
 * broker facts — the resolver and the admin page are the source of truth.
 */

const INSTRUMENTS = {
  NAS100: {
    label: 'Nasdaq 100',
    assetClass: 'index',
    cluster: 'US_EQUITY',
    clusterPriority: 1,
    strategies: ['A', 'C'],
    session: 'US_CASH',
    candidates: ['US100Cash', 'US100', 'USTEC', 'NAS100', 'NDX100', 'USA100', 'Nasdaq', 'NQ100', 'USTECm', 'USTEC.c'],
  },
  US500: {
    label: 'S&P 500',
    assetClass: 'index',
    cluster: 'US_EQUITY',
    clusterPriority: 2,
    strategies: ['A'],
    session: 'US_CASH',
    candidates: ['US500Cash', 'US500', 'SPX500', 'SP500', 'USA500', 'US500m'],
  },
  US30: {
    label: 'Dow Jones 30',
    assetClass: 'index',
    cluster: 'US_EQUITY',
    clusterPriority: 3,
    strategies: ['A', 'C'],
    session: 'US_CASH',
    candidates: ['US30Cash', 'US30', 'DJ30', 'USA30', 'WS30', 'US30m'],
  },
  GER40: {
    label: 'DAX 40',
    assetClass: 'index',
    cluster: 'EU_EQUITY',
    clusterPriority: 1,
    strategies: ['A', 'C'],
    session: 'XETRA',
    candidates: ['GER40Cash', 'GER40', 'DE40', 'DE30', 'GER30', 'DAX40', 'GERMANY40', 'DE30m', 'DE40m'],
  },
  XAUUSD: {
    label: 'Gold',
    assetClass: 'metal',
    cluster: 'GOLD',
    clusterPriority: 1,
    strategies: ['B', 'C'],
    session: 'COMEX_DAY',
    candidates: ['GOLD', 'XAUUSD', 'XAUUSDm', 'XAUUSD.', 'XAUUSD.r', 'GOLDm'],
  },
  BTCUSD: {
    label: 'Bitcoin',
    assetClass: 'crypto',
    cluster: 'CRYPTO',
    clusterPriority: 1,
    strategies: ['C'],
    longOnly: true,
    session: 'ALWAYS',
    candidates: ['BTCUSD', 'BTCUSDm', 'BITCOIN', 'BTCUSD.'],
  },
  EURUSD: {
    label: 'EUR/USD', assetClass: 'fx', cluster: 'USD', clusterPriority: 1,
    strategies: ['C'], session: 'FX', candidates: ['EURUSD', 'EURUSDm', 'EURUSD.', 'EURUSD.r', 'EURUSD#'],
  },
  GBPUSD: {
    label: 'GBP/USD', assetClass: 'fx', cluster: 'USD', clusterPriority: 2,
    strategies: ['C'], session: 'FX', candidates: ['GBPUSD', 'GBPUSDm', 'GBPUSD.', 'GBPUSD.r', 'GBPUSD#'],
  },
  AUDUSD: {
    label: 'AUD/USD', assetClass: 'fx', cluster: 'USD', clusterPriority: 3,
    strategies: ['C'], session: 'FX', candidates: ['AUDUSD', 'AUDUSDm', 'AUDUSD.', 'AUDUSD.r', 'AUDUSD#'],
  },
  USDJPY: {
    label: 'USD/JPY', assetClass: 'fx', cluster: 'USD', clusterPriority: 4,
    strategies: ['C'], session: 'FX', candidates: ['USDJPY', 'USDJPYm', 'USDJPY.', 'USDJPY.r', 'USDJPY#'],
  },
};

/**
 * Sessions are defined in the exchange's own time zone, so daylight-saving
 * changes are handled by the time zone database, never by hand-edited offsets.
 * Times are minutes after local midnight.
 */
const SESSIONS = {
  US_CASH: { tz: 'America/New_York', open: 9 * 60 + 30, close: 16 * 60, firstCheckpoint: 10 * 60, lastCheckpoint: 15 * 60 + 30, flattenAt: 15 * 60 + 59 },
  XETRA: { tz: 'Europe/Berlin', open: 9 * 60, close: 17 * 60 + 30, firstCheckpoint: 9 * 60 + 30, lastCheckpoint: 17 * 60, flattenAt: 17 * 60 + 29 },
  COMEX_DAY: { tz: 'America/New_York', open: 8 * 60 + 20, close: 13 * 60 + 30, firstCheckpoint: 9 * 60, lastCheckpoint: 13 * 60, flattenAt: 13 * 60 + 29 },
  LONDON_GOLD: { tz: 'Europe/London', open: 8 * 60, close: 16 * 60 + 30, firstCheckpoint: 8 * 60 + 30, lastCheckpoint: 16 * 60, flattenAt: 16 * 60 + 29 },
  FX: { tz: 'America/New_York', dailyClose: 17 * 60 },
  ALWAYS: { tz: 'UTC', dailyClose: 0 },
};

/** Daily signal time for Strategy C (New York close) and its execution time. */
const DAILY = {
  signal: { tz: 'America/New_York', minute: 17 * 60 + 5 },
  execute: { tz: 'Europe/London', minute: 8 * 60 },
};

/**
 * Broker profiles. serverTime: how the broker's MT5 server clock relates to UTC.
 *  - 'ny_close' : server = New York time + 7h (UTC+2 in winter, UTC+3 in US summer)
 *  - 'utc'      : server = UTC
 * These are commonly reported conventions and MUST be confirmed by the bridge's
 * auto-detection (export_history.py prints the detected offset) before use.
 */
const BROKER_PROFILES = {
  XM: { label: 'XM', serverTime: 'ny_close', status: 'available' },
  HFM: { label: 'HFM (HotForex)', serverTime: 'ny_close', status: 'available' },
  EXNESS: { label: 'Exness', serverTime: 'utc', status: 'candidate' },
  PEPPERSTONE: { label: 'Pepperstone', serverTime: 'ny_close', status: 'candidate' },
};

module.exports = { INSTRUMENTS, SESSIONS, DAILY, BROKER_PROFILES };
