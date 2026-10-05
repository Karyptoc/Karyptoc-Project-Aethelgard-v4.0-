/**
 * AETHELGARD - POI Zone Watcher
 * backend/src/services/poiZoneEngine.js
 *
 * Roadmap Phase 4, second half of "POI/TP-hit notifier engine" (the TP/SL
 * half shipped separately in bridge.js/bridge.py — see
 * supabase_migration_trade_close_reason.sql).
 *
 * Order blocks and FVGs were already being detected (signalCore.js:
 * detectOBs/detectFVGs) but only ever computed fresh inside a single
 * signal-generation call, on whatever lookback window happened to still
 * contain them, then discarded — nothing persisted a zone across cycles,
 * so there was no way to ask "has price come back and touched this zone
 * yet?" over time, independent of whether a trade signal fires.
 *
 * This runs on EVERY OHLCV push for EVERY symbol (wired into bridge.js's
 * POST /ohlcv, ahead of signalEngine's signal-generation gates — kill
 * zone, session cap, duplicate-signal window, etc. — none of which should
 * stop price from being checked against a zone someone is watching).
 *
 * Deliberately simple for v1: zones expire on a flat time window rather
 * than any structural "price moved past it, won't come back" judgment —
 * that's a real refinement but not one worth guessing at without live
 * data on how often it would fire wrong.
 */

const { supabaseAdmin, log } = require("./supabase");
const { sendTelegramMessage, isConfigured: isTelegramConfigured } = require("./telegram");
const { atrCalc, detectOBs, detectFVGs } = require("./signalCore");

// Same lookback windows signalEngine.js uses for M15-scoped POI detection —
// kept identical so a zone this watcher tracks is the same zone the signal
// engine itself would see and react to.
const OB_LOOKBACK = 40;
const FVG_LOOKBACK = 40;

// Zones untouched after this long are stale — structure has likely moved on.
// Not a claim that the zone is invalid, just that watching it forever isn't
// useful. 72h ≈ 3 trading days.
const ZONE_MAX_AGE_HOURS = 72;

// A newly detected zone is treated as "the same zone" as an existing active
// one (skip re-inserting it) when their price ranges overlap by at least
// this fraction of the smaller zone's size — detectOBs/detectFVGs recompute
// over a sliding lookback window, so the same real zone reappears on every
// call until it ages out of that window.
const DEDUPE_OVERLAP_RATIO = 0.5;

function overlapRatio(aLow, aHigh, bLow, bHigh) {
  const overlap = Math.min(aHigh, bHigh) - Math.max(aLow, bLow);
  if (overlap <= 0) return 0;
  const smaller = Math.min(aHigh - aLow, bHigh - bLow);
  return smaller > 0 ? overlap / smaller : 0;
}

// ── Touch detection ──────────────────────────────────────────────────────────
// Two defects in the first version of this file, both found by replaying a
// realistic push sequence (bridge.py pushes every `signal interval` minutes,
// default 15, with the CURRENT, still-forming bar as the last element):
//
//  1. It only ever examined bars[last] — the forming bar. A wick into a zone
//     during the previous interval lives in a bar that has since COMPLETED
//     and is no longer last, so most real touches were never seen.
//  2. It used inclusive overlap (<= / >=). A bullish FVG's own third candle
//     has low EXACTLY equal to the zone's top edge (and a bearish one's high
//     equals its bottom edge), so a freshly formed FVG counted as "touched"
//     by the very candle that created it and alerted instantly.
//
// Fix: remember the last bar time seen per symbol and evaluate every bar
// from there forward (inclusive, since that bar was still forming last
// time), and require genuine PENETRATION (strict inequality) so edge-
// adjacent formation candles don't count. Zones inserted during THIS call
// are never evaluated against this call's bars at all — nothing has
// happened to them yet. State is in-memory: after a restart only the latest
// bar is checked once, then normal service resumes.
const lastSeenBarTime = new Map(); // symbol -> ISO time of the last bar processed
const MAX_BARS_PER_CHECK = 8;      // cap late-alert backlog after downtime (~2h of M15)
const EPS = 1e-9;

function barPenetratesZone(bar, zone) {
  return bar.low < zone.zone_high - EPS && bar.high > zone.zone_low + EPS;
}

function barsToCheck(bars, lastSeen) {
  if (!lastSeen) return bars.slice(-1);
  const idx = bars.findIndex(b => b.time >= lastSeen); // same ISO format => lexicographic order is chronological
  const slice = idx === -1 ? bars.slice(-1) : bars.slice(idx);
  return slice.slice(-MAX_BARS_PER_CHECK);
}

async function notifyZoneTouched(zone) {
  try {
    if (!(await isTelegramConfigured())) return;
    const dir = zone.zone_type.startsWith("OB") ? "Order Block" : "Fair Value Gap";
    const side = zone.zone_type.endsWith("BULL") ? "🟢 BULLISH" : "🔴 BEARISH";
    const msg =
      `📍 POI TOUCHED\n` +
      `${side} ${dir} — ${zone.symbol} (${zone.timeframe})\n` +
      `Zone: ${zone.zone_low} – ${zone.zone_high}`;
    const tgResult = await sendTelegramMessage(msg);
    if (!tgResult.ok) {
      await log("warning", "poiZoneEngine", `${zone.symbol}: touch alert not sent — ${tgResult.error}`);
    }
  } catch (tgErr) {
    await log("warning", "poiZoneEngine", `${zone.symbol}: touch alert threw unexpectedly — ${tgErr.message}`);
  }
}

/**
 * Detects fresh OB/FVG zones for `symbol` from `ohlcvData` (the same
 * {tf: bars[]} map signalEngine.generateSignalFromOHLCV receives),
 * persists genuinely new ones, checks all currently-active zones against
 * the latest bar's range for a touch, and expires stale untouched zones.
 * Never throws — best-effort, mirrors the Telegram alert pattern used
 * elsewhere in this pipeline; a failure here must never block signal
 * generation, which runs right after this in bridge.js.
 */
async function updatePOIZones(symbol, ohlcvData) {
  try {
    const bars = ohlcvData?.M15 || ohlcvData?.M5 || ohlcvData?.H4 || ohlcvData?.H1;
    if (!bars || bars.length < 30) return;
    const timeframe = ohlcvData?.M15 ? "M15" : ohlcvData?.M5 ? "M5" : ohlcvData?.H4 ? "H4" : "H1";

    const atrVal = atrCalc(bars, 14);
    const obs = detectOBs(bars, OB_LOOKBACK);
    const fvgs = atrVal ? detectFVGs(bars, atrVal, FVG_LOOKBACK) : [];

    const detected = [
      ...obs.map(o => ({ zone_type: o.type === "BULLISH_OB" ? "OB_BULL" : "OB_BEAR", high: o.high, low: o.low })),
      ...fvgs.map(f => ({ zone_type: f.type === "BULLISH_FVG" ? "FVG_BULL" : "FVG_BEAR", high: f.high, low: f.low })),
    ];
    // NOTE: deliberately NO early return when nothing new is detected — the
    // touch check and expiry sweep below must still run for zones already
    // being watched (an earlier version returned here and skipped both).

    // Every zone for this symbol still inside the 72h window, ANY status.
    // Dedupe must see touched/invalidated zones too, not just active ones:
    // a touched zone is still inside detectOBs/detectFVGs' lookback window on
    // the next push, and checking only active zones would re-insert it as
    // brand new and alert on it again every time price revisits it.
    const dedupeCutoff = new Date(Date.now() - ZONE_MAX_AGE_HOURS * 60 * 60 * 1000).toISOString();
    const { data: knownZones } = await supabaseAdmin
      .from("poi_zones")
      .select("*")
      .eq("symbol", symbol)
      .gte("detected_at", dedupeCutoff);
    const known = knownZones || [];
    const active = known.filter(z => z.status === "active"); // only these are watched for touches

    // Insert only zones not already tracked (overlap-based dedupe — see
    // DEDUPE_OVERLAP_RATIO above).
    const toInsert = detected.filter(d => {
      const sameType = known.filter(a => a.zone_type === d.zone_type);
      return !sameType.some(a => overlapRatio(d.low, d.high, a.zone_low, a.zone_high) >= DEDUPE_OVERLAP_RATIO);
    });
    if (toInsert.length) {
      await supabaseAdmin.from("poi_zones").insert(
        toInsert.map(d => ({
          symbol, timeframe, zone_type: d.zone_type,
          zone_high: d.high, zone_low: d.low, status: "active",
        }))
      );
    }

    // Touch check — see the block comment above barPenetratesZone for why
    // this evaluates every bar since the last push (not just the forming
    // bar), uses strict penetration, and skips zones inserted just now.
    const lastSeen = lastSeenBarTime.get(symbol);
    const checkBars = barsToCheck(bars, lastSeen);
    for (const zone of active) {
      if (checkBars.some(b => barPenetratesZone(b, zone))) {
        await supabaseAdmin.from("poi_zones")
          .update({ status: "touched", touched_at: new Date().toISOString() })
          .eq("id", zone.id);
        await notifyZoneTouched(zone);
      }
    }
    lastSeenBarTime.set(symbol, bars[bars.length - 1].time);

    // Housekeeping: expire stale untouched zones so the active set doesn't
    // grow unbounded and old zones don't keep firing alerts indefinitely.
    const cutoff = new Date(Date.now() - ZONE_MAX_AGE_HOURS * 60 * 60 * 1000).toISOString();
    await supabaseAdmin.from("poi_zones")
      .update({ status: "invalidated", invalidated_at: new Date().toISOString() })
      .eq("symbol", symbol).eq("status", "active").lt("detected_at", cutoff);
  } catch (e) {
    await log("warning", "poiZoneEngine", `${symbol}: updatePOIZones failed — ${e.message}`);
  }
}

module.exports = { updatePOIZones };
