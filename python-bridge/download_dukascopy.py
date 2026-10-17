"""
Download free 1-minute history from Dukascopy for the independent Strategy A test.

Why: the XM data already tested covers Sep 2023 - Oct 2026. This fetches an independent
source (Dukascopy's CFD feed) back to 2013, so Strategy A can be checked on ~10 years it
has never been tested on.

Default instruments:  USATECHIDXUSD (Nasdaq 100)   DEUIDXEUR (DAX 40)   also: XAUUSD (gold)
Only the hours around each cash session are kept (smaller files):
  Nasdaq 12:00-22:00 UTC, DAX 06:00-17:00 UTC, gold 11:00-21:00 UTC (summer and winter time)

Output: research_data/dukascopy/<SYMBOL>/<YEAR>-<MM>.csv  (time_utc, open, high, low, close, volume)
Prices are written as Dukascopy's raw integers; the price scale is checked during analysis.

Dukascopy throttles fast downloaders (HTTP 503). This script is deliberately polite:
2 parallel requests, a short pause between requests, long back-off when throttled,
and an automatic 5-minute cool-down if the server keeps refusing.

Usage (any PC with internet; no MT5 needed):
  python download_dukascopy.py --from 2024 --to 2024    # quick test first (~5 minutes)
  python download_dukascopy.py                          # 2013 to today, both instruments
  python download_dukascopy.py --symbols XAUUSD          # gold
  python download_dukascopy.py --symbols USATECHIDXUSD,XAUUSD --side ASK --to 2023   # real spreads
It resumes where it stopped: finished months are skipped. Run it again until it reports
0 incomplete months. A full run can take a few hours; it can run overnight.
"""
import argparse
import csv
import lzma
import os
import struct
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

import requests

URL = "https://datafeed.dukascopy.com/datafeed/{sym}/{y}/{m:02d}/{d:02d}/{side}_candles_min_1.bi5"
HOURS = {"USATECHIDXUSD": (12, 22), "DEUIDXEUR": (6, 17), "XAUUSD": (11, 21)}
SIDE = "BID"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "research_data", "dukascopy")

session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Referer": "https://www.dukascopy.com/swiss/english/marketwatch/historical/",
})

_lock = threading.Lock()
_last_request = [0.0]
_throttle_streak = [0]
MIN_GAP = 0.35          # seconds between any two requests (all threads together)


def _pace():
    with _lock:
        wait = _last_request[0] + MIN_GAP - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_request[0] = time.time()


def fetch_day(sym, day):
    """Returns list of (utc_datetime, o, h, l, c, vol) for one UTC day, [] if no data, None if failed."""
    url = URL.format(sym=sym, y=day.year, m=day.month - 1, d=day.day, side=SIDE)  # Dukascopy months are 0-based
    backoff = [5, 15, 30, 60, 120, 180]
    for attempt in range(len(backoff) + 1):
        _pace()
        try:
            r = session.get(url, timeout=45)
            if r.status_code == 404:
                return []
            if r.status_code in (429, 503, 502, 504):
                raise requests.HTTPError(f"{r.status_code} (server busy/throttled)")
            r.raise_for_status()
            with _lock:
                _throttle_streak[0] = 0
            if not r.content:
                return []
            raw = lzma.decompress(r.content)
            start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
            lo, hi = HOURS.get(sym, (0, 24))
            rows = []
            for i in range(0, len(raw) - len(raw) % 24, 24):
                secs, o, c, l, h, v = struct.unpack(">IIIIIf", raw[i:i + 24])
                t = start + timedelta(seconds=secs)
                if lo <= t.hour < hi and v > 0:
                    rows.append((t, o, h, l, c, v))
            return rows
        except (requests.RequestException, lzma.LZMAError) as e:
            with _lock:
                _throttle_streak[0] += 1
                streak = _throttle_streak[0]
            if streak >= 20:
                print(f"  server keeps refusing ({e}); cooling down 5 minutes...")
                time.sleep(300)
                with _lock:
                    _throttle_streak[0] = 0
            if attempt == len(backoff):
                print(f"  failed {sym} {day}: {e}")
                return None
            time.sleep(backoff[attempt])


def month_days(year, month):
    d = date(year, month, 1)
    out = []
    while d.month == month:
        if d.weekday() < 5 and d <= date.today() - timedelta(days=1):
            out.append(d)
        d += timedelta(days=1)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", type=int, default=2013)
    ap.add_argument("--to", dest="end", type=int, default=date.today().year)
    ap.add_argument("--symbols", default="USATECHIDXUSD,DEUIDXEUR")
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--side", choices=["BID", "ASK"], default="BID", help="ASK is used to measure real historical spreads")
    args = ap.parse_args()
    global SIDE
    SIDE = args.side

    incomplete = 0
    with ThreadPoolExecutor(max_workers=max(1, min(args.threads, 4))) as ex:
        for sym in args.symbols.split(","):
            folder = os.path.join(OUT, sym if SIDE == "BID" else f"{sym}_ASK")
            os.makedirs(folder, exist_ok=True)
            for year in range(args.start, args.end + 1):
                for month in range(1, 13):
                    days = month_days(year, month)
                    if not days:
                        continue
                    path = os.path.join(folder, f"{year}-{month:02d}.csv")
                    done_marker = path + ".done"
                    if os.path.exists(done_marker):
                        continue
                    t0 = time.time()
                    results = dict(zip(days, ex.map(lambda d: fetch_day(sym, d), days)))
                    failed = sum(1 for v in results.values() if v is None)
                    n = 0
                    with open(path, "w", newline="") as fh:
                        w = csv.writer(fh)
                        w.writerow(["time_utc", "open", "high", "low", "close", "volume"])
                        for d in sorted(results):
                            for t, o, h, l, c, v in (results[d] or []):
                                w.writerow([t.strftime("%Y-%m-%d %H:%M:%S"), o, h, l, c, round(v, 4)])
                                n += 1
                    month_closed = (year, month) < (date.today().year, date.today().month)
                    status = "ok" if failed == 0 else f"{failed} days failed - will retry next run"
                    print(f"{sym} {year}-{month:02d}: {n:,} bars, {status}, {time.time() - t0:.0f}s")
                    if failed == 0 and month_closed:
                        open(done_marker, "w").close()
                    else:
                        incomplete += 1
    print(f"Finished this pass. Incomplete months: {incomplete}. Files in {OUT}")
    if incomplete:
        print("Run the same command again to fill the gaps (finished months are skipped).")


if __name__ == "__main__":
    main()
