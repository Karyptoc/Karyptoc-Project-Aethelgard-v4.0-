'use strict';
/**
 * Session clock: converts between UTC and exchange-local time using the IANA
 * time zone database built into Node (Intl). No hand-maintained DST tables.
 */

const fmtCache = new Map();
function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    }));
  }
  return fmtCache.get(tz);
}

/** Local calendar parts of a UTC instant in time zone tz. */
function zonedParts(date, tz) {
  const out = {};
  for (const p of formatter(tz).formatToParts(date)) out[p.type] = p.value;
  return {
    year: +out.year, month: +out.month, day: +out.day,
    hour: +out.hour, minute: +out.minute, second: +out.second,
    weekday: out.weekday, // 'Mon'...'Sun'
    dateKey: `${out.year}-${out.month}-${out.day}`,
    minuteOfDay: +out.hour * 60 + +out.minute,
  };
}

/** Offset of tz from UTC at a given instant, in minutes (e.g. New York winter = -300). */
function offsetMinutes(date, tz) {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/** UTC instant for a local wall-clock time in tz. */
function zonedToUtc(year, month, day, minuteOfDay, tz) {
  const guess = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  const off1 = offsetMinutes(new Date(guess), tz);
  let t = guess - off1 * 60000;
  const off2 = offsetMinutes(new Date(t), tz);
  if (off2 !== off1) t = guess - off2 * 60000;
  return new Date(t);
}

function isWeekday(date, tz) {
  const wd = zonedParts(date, tz).weekday;
  return wd !== 'Sat' && wd !== 'Sun';
}

/** Checkpoint minutes (local) for a session: first..last every `step` minutes. */
function checkpoints(session, step = 30) {
  const out = [];
  for (let m = session.firstCheckpoint; m <= session.lastCheckpoint; m += step) out.push(m);
  return out;
}

/**
 * Events due in the minute that starts at `now` (UTC), for a session.
 * Returns e.g. [{type:'checkpoint', minute:630}] or [{type:'flatten'}].
 */
function eventsAt(now, session, holidays = new Set()) {
  if (!isWeekday(now, session.tz)) return [];
  const p = zonedParts(now, session.tz);
  if (holidays.has(p.dateKey)) return [];
  const ev = [];
  if (p.minuteOfDay === session.open) ev.push({ type: 'open', dateKey: p.dateKey });
  if (checkpoints(session).includes(p.minuteOfDay)) ev.push({ type: 'checkpoint', minute: p.minuteOfDay, dateKey: p.dateKey });
  if (p.minuteOfDay === session.flattenAt) ev.push({ type: 'flatten', dateKey: p.dateKey });
  return ev;
}

/** Display a UTC instant in another zone, e.g. Africa/Nairobi for the dashboard. */
function toLocalLabel(date, tz) {
  const p = zonedParts(date, tz);
  return `${p.dateKey} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

module.exports = { zonedParts, offsetMinutes, zonedToUtc, isWeekday, checkpoints, eventsAt, toLocalLabel };
