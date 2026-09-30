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

module.exports = { getCalendarEvents };
