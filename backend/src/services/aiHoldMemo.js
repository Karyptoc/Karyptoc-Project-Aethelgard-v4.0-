/**
 * Stops the engine paying Claude to say "no setup" over and over.
 *
 * Hybrid/AI mode asks Claude about every pair that scores high, on every
 * 5-minute cycle. A HOLD answer is never saved as a signal, so the duplicate
 * check can't see it and the same pair is sent to Claude again 5 minutes
 * later, for the same market. This remembers the last HOLD per pair and skips
 * the re-ask for a while, unless the setup has clearly changed.
 *
 *   AI_HOLD_COOLDOWN_MIN   minutes to wait after a HOLD (default 30; 0 = off)
 *   AI_HOLD_RESCORE_DELTA  re-ask early if the score rose by this much (default 10)
 */
const COOLDOWN_MIN = parseFloat(process.env.AI_HOLD_COOLDOWN_MIN ?? "30");
const RESCORE_DELTA = parseFloat(process.env.AI_HOLD_RESCORE_DELTA ?? "10");

const memo = new Map(); // symbol -> { t, score, fullSeq }

// Returns { skip:false } or { skip:true, ageMin, prevScore }.
function shouldSkipAi(symbol, score, fullSeq, now = Date.now()) {
  if (!(COOLDOWN_MIN > 0)) return { skip: false };
  const m = memo.get(symbol);
  if (!m) return { skip: false };
  const ageMin = (now - m.t) / 60000;
  if (ageMin >= COOLDOWN_MIN) { memo.delete(symbol); return { skip: false }; }
  if (score >= m.score + RESCORE_DELTA) return { skip: false };   // setup got clearly better
  if (fullSeq && !m.fullSeq) return { skip: false };              // a full ICT sequence just formed
  return { skip: true, ageMin: Math.round(ageMin), prevScore: m.score };
}

function recordAiResult(symbol, score, fullSeq, wasHold, now = Date.now()) {
  if (wasHold) memo.set(symbol, { t: now, score, fullSeq: !!fullSeq });
  else memo.delete(symbol); // a real signal resets it
}

module.exports = { shouldSkipAi, recordAiResult, _memo: memo };
