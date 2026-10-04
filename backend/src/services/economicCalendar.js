/**
 * AETHELGARD - Real Economic Calendar Service
 * backend/src/services/economicCalendar.js
 *
 * FIX: signalCore.js's isNewsBlackout() used to be a hardcoded table of
 * "every Tuesday/Wednesday ~12:30 UTC = assume US CPI" day-of-week/time
 * patterns - not a real calendar. It fired every week regardless of
 * whether that event was actually scheduled, which is why signal
 * generation was going quiet on ordinary Tuesdays with nothing on the
 * real calendar. Confirmed live on 2026-09-29 (a Tuesday, no CPI
 * scheduled that week per the real calendar) - every pair got skipped
 * citing "US CPI".
 *
 * This service fetches the real weekly high-impact event schedule from
 * Forex Factory's public JSON feed (no API key required - this is the
 * same feed a large share of open-source ICT/SMC bots use) and caches
 * it in memory. signalEngine.js fetches it once per signal-generation
 * cycle and passes the events into the (still pure) isNewsBlackout() in
 * signalCore.js, instead of that function guessing from the calendar
 * date alone.
 *
 * Historical note: backtest.js calls isNewsBlackout(barTime) with NO
 * events array, because this feed only covers the CURRENT week - there
 * is no historical archive available here for arbitrary past dates a
 * 90-day backtest would need. With no events passed, isNewsBlackout now
 * blocks nothing (see signalCore.js) rather than falling back to the
 * old fake pattern-matching, which was actively wrong more often than
 * it was right. This is a known, deliberate limitation: backtests no
 * longer simulate news avoidance at all. If that turns out to matter,
 * the real fix is sourcing a paid historical calendar feed - a separate
 * piece of work from this one.
 */

const axios = require("axios");
const { log } = require("./supabase");

const FEED_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour - the weekly feed doesn't need to be re-fetched more often than that

// Currencies we actually trade (majors + the pairs' quote/base currencies).
// GOLD/US30Cash/GER40Cash/BTCUSD aren't currency pairs, but USD/EUR high-impact
// events still move them (GOLD especially), so USD/EUR events stay in scope
// for all symbols rather than trying to map index/crypto symbols to currencies.
const TRACKED_CURRENCIES = new Set(["USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "NZD"]);

let cache = { events: null, fetchedAt: 0 };

/**
 * Fetches (or returns cached) high-impact events for the current week.
 * Returns [] on any failure - a calendar outage must never block or crash
 * signal generation, it should just mean "no known news to avoid right now".
 */
async function getCalendarEvents() {
  const now = Date.now();
  if (cache.events && (now - cache.fetchedAt) < CACHE_TTL_MS) {
    return cache.events;
  }

  try {
    const r = await axios.get(FEED_URL, { timeout: 10000 });
    const raw = Array.isArray(r.data) ? r.data : [];

    const events = raw
      .filter(e => String(e.impact || "").toLowerCase() === "high" && TRACKED_CURRENCIES.has(e.country))
      .map(e => {
        // Feed gives date+time as separate fields in various formats across
        // mirrors of this feed; "date" is typically an ISO-ish string and
        // "time" like "8:30am". Prefer a combined parse, fall back safely.
        let ts = null;
        try {
          ts = new Date(e.date).getTime();
          if (Number.isNaN(ts)) ts = null;
        } catch { ts = null; }
        return {
          title: e.title || e.event || "High-impact event",
          country: e.country,
          impact: e.impact,
          timestamp: ts, // ms epoch, or null if unparseable (excluded below)
          // NEW (Oct 4 — Roadmap Phase 2, "extend economicCalendar.js for
          // consensus/surprise data"): the feed carries forecast/previous/
          // actual on every event, released or not — actual is just empty
          // until the event fires. Kept as raw strings here (the feed uses
          // mixed formats like "3.7%", "250K", "-0.3%") and parsed on
          // demand by getFundamentalBias() below, so a parsing bug never
          // breaks isNewsBlackout's blackout-window check, which only ever
          // needed the timestamp.
          forecast: e.forecast ?? null,
          previous: e.previous ?? null,
          actual: e.actual ?? null,
        };
      })
      .filter(e => e.timestamp !== null);

    cache = { events, fetchedAt: now };
    await log("info", "economicCalendar", `Fetched ${events.length} high-impact events for this week`);
    return events;
  } catch (e) {
    await log("warning", "economicCalendar", `Calendar fetch failed, treating as no known events: ${e.message}`);
    // Keep serving the last good cache if we have one, even if stale,
    // rather than suddenly trading blind because of a transient outage.
    if (cache.events) return cache.events;
    return [];
  }
}

// ── Fundamental Bias Module ───────────────────────────────────────────────────
// NEW (Oct 4 — Roadmap Phase 2, items 11-12): until now, nothing in the
// codebase used forecast/actual at all — the calendar only ever answered
// "is a high-impact event near enough to pause trading." This adds a second,
// independent question: "of this week's high-impact events that have
// ALREADY released, did the actual number beat or miss consensus, and in
// which direction does that lean each currency?" Feeds signalEngine.js's
// system prompt and scoreConfluence() as a modest, bounded, documented
// confluence factor — never a hard gate, consistent with how htfBias itself
// contributes points rather than blocking trades outright.
//
// Deliberately live-only, same limitation isNewsBlackout already has (see
// this file's header comment): there's no historical calendar archive
// available here, so backtest.js has nothing to pass and nothing changes
// for it — scoreConfluence()'s new parameter defaults to null/no-op.

// Values come back from the feed as strings in mixed formats: "3.7%",
// "250K", "-0.3%", "1.2M". Parses to a plain number; % is dropped (both
// forecast and actual share the same unit when a field is a percent, so
// the surprise math below is unaffected), K/M/B are scaled.
function parseEconValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const s = String(raw).trim();
  if (!s || s === "-") return null;
  const neg = /^-|^−/.test(s);
  const cleaned = s.replace(/[,%+−]/g, "").replace(/^-/, "");
  const m = cleaned.match(/^([\d.]+)\s*([KMB])?$/i);
  if (!m) {
    const n = parseFloat(cleaned);
    return Number.isNaN(n) ? null : (neg ? -n : n);
  }
  let n = parseFloat(m[1]);
  const suffix = (m[2] || "").toUpperCase();
  if (suffix === "K") n *= 1e3;
  if (suffix === "M") n *= 1e6;
  if (suffix === "B") n *= 1e9;
  return neg ? -n : n;
}

// A handful of recurring high-impact indicators where a bigger actual
// number is a BAD sign for the currency (more unemployment, more people
// filing claims) — everything else defaults to "bigger beat = bullish"
// (GDP, CPI, retail sales, PMI, NFP, etc.), which is the right default for
// the large majority of tracked high-impact releases.
const BEARISH_IF_HIGHER = [
  "unemployment rate", "unemployment claims", "jobless claims",
  "initial claims", "continuing claims",
];

/**
 * Surprise for one released event, as a value clamped to [-1, 1]:
 * positive = bullish surprise for that event's currency, negative = bearish.
 * Returns null (not a fabricated 0) when the event hasn't released yet or
 * forecast/actual can't be parsed — "unknown" is never treated as "neutral".
 */
function eventSurprise(ev) {
  const actual = parseEconValue(ev.actual);
  const forecast = parseEconValue(ev.forecast);
  if (actual === null || forecast === null) return null;

  const diff = actual - forecast;
  const scale = Math.max(Math.abs(forecast), 0.01); // avoid divide-by-near-zero on e.g. a 0.0% forecast
  let rel = diff / scale;

  const lower = (ev.title || "").toLowerCase();
  if (BEARISH_IF_HIGHER.some(k => lower.includes(k))) rel = -rel;

  return Math.max(-1, Math.min(1, rel));
}

/**
 * Averages this week's RELEASED high-impact surprises into a per-currency
 * bias score. Only currencies with at least one released, parseable event
 * appear in the result — a currency with no data simply isn't a key in
 * the returned object, never a fabricated "neutral" entry.
 */
async function getFundamentalBias() {
  const events = await getCalendarEvents();
  const byCurrency = {};
  for (const ev of events) {
    const surprise = eventSurprise(ev);
    if (surprise === null) continue;
    (byCurrency[ev.country] ||= []).push({ title: ev.title, surprise });
  }

  const bias = {};
  for (const [currency, evs] of Object.entries(byCurrency)) {
    const avg = evs.reduce((s, e) => s + e.surprise, 0) / evs.length;
    bias[currency] = {
      score: parseFloat(avg.toFixed(3)),
      label: avg > 0.15 ? "bullish" : avg < -0.15 ? "bearish" : "neutral",
      eventsUsed: evs.length,
      events: evs.map(e => `${e.title} (${e.surprise >= 0 ? "+" : ""}${e.surprise.toFixed(2)})`),
    };
  }
  return bias;
}

// Which currencies move a given symbol. Forex pairs get base+quote (net
// bias = base's score minus quote's — base strengthening AND quote
// weakening both push the pair the same direction); GOLD/BTCUSD/indices
// get only the single currency that actually moves them (mirrors the
// reasoning already used for TRACKED_CURRENCIES above).
const SYMBOL_CURRENCIES = {
  EURUSD: ["EUR", "USD"], GBPUSD: ["GBP", "USD"], USDJPY: ["USD", "JPY"],
  AUDUSD: ["AUD", "USD"], USDCAD: ["USD", "CAD"], USDCHF: ["USD", "CHF"],
  NZDUSD: ["NZD", "USD"], GBPJPY: ["GBP", "JPY"], EURJPY: ["EUR", "JPY"],
  GOLD: ["USD"], BTCUSD: ["USD"], US30Cash: ["USD"], GER40Cash: ["EUR"],
};

/**
 * Net fundamental bias for one symbol, from the per-currency map
 * getFundamentalBias() returns. Always returns a usable object — score 0 /
 * label "neutral" / eventsUsed 0 when there's no data for that symbol's
 * currencies this week, so callers never need a null check.
 */
function getFundamentalBiasForSymbol(symbol, biasMap) {
  const currencies = SYMBOL_CURRENCIES[symbol];
  if (!currencies || !biasMap) {
    return { score: 0, label: "neutral", eventsUsed: 0, detail: "No fundamental data for this symbol" };
  }

  if (currencies.length === 1) {
    const b = biasMap[currencies[0]];
    if (!b) return { score: 0, label: "neutral", eventsUsed: 0, detail: "No released high-impact events this week" };
    return { score: b.score, label: b.label, eventsUsed: b.eventsUsed, detail: `${currencies[0]}: ${b.label} (${b.eventsUsed} event${b.eventsUsed === 1 ? "" : "s"})` };
  }

  const [base, quote] = currencies;
  const baseBias = biasMap[base] || { score: 0, eventsUsed: 0 };
  const quoteBias = biasMap[quote] || { score: 0, eventsUsed: 0 };
  const net = parseFloat((baseBias.score - quoteBias.score).toFixed(3));
  const eventsUsed = (baseBias.eventsUsed || 0) + (quoteBias.eventsUsed || 0);

  return {
    score: net,
    label: net > 0.15 ? "bullish" : net < -0.15 ? "bearish" : "neutral",
    eventsUsed,
    detail: eventsUsed > 0
      ? `${base} ${baseBias.score >= 0 ? "+" : ""}${(baseBias.score || 0).toFixed(2)} vs ${quote} ${quoteBias.score >= 0 ? "+" : ""}${(quoteBias.score || 0).toFixed(2)}`
      : "No released high-impact events for either currency this week",
  };
}

module.exports = {
  getCalendarEvents,
  getFundamentalBias,
  getFundamentalBiasForSymbol,
  parseEconValue, // exported for unit testing
};
