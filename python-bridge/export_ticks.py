"""
export_ticks.py - save bid/ask TICKS around the daily rollover (and the US cash open) from your MT5 terminal.
Run it on the PC where MT5 is installed and logged in, like the other export scripts:

    cd python-bridge
    python export_ticks.py

READ-ONLY (never places or changes a trade). It writes a folder  tick_data/  and zips it to  aethelgard_ticks.zip.
Send me that zip plus the printed text.

Why: the hourly bar files only contain the BID price and one spread number per bar, so I cannot tell a real price move at
the daily rollover from a quote artifact. Real bid AND ask ticks settle it.

How far back? MT5 only keeps/serves tick history for a limited period that depends on the broker. The script asks for up to
--days days (default 45) and stops when the broker has no more; it prints what it found.

Options (all optional):
    --symbols EURUSD,GOLD     default: 12 symbols covering FX majors/crosses, gold and indices
    --days 45                 how many calendar days back to try
    --windows 21:30-02:30,16:00-18:00     SERVER-time windows (the daily rollover is server midnight; the US cash open is
                                          about 16:30 server time all year). Windows may cross midnight.
    --outdir tick_data
"""
import argparse
import csv
import os
import sys
import zipfile
from datetime import datetime, timedelta, timezone

DEFAULT_SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "EURCHF", "EURAUD", "AUDNZD", "GOLD",
                   "US30Cash", "US100Cash", "GER40Cash"]


def parse_windows(s):
    out = []
    for part in s.split(","):
        a, b = part.strip().split("-")
        ha, ma = [int(x) for x in a.split(":")]
        hb, mb = [int(x) for x in b.split(":")]
        out.append(((ha, ma), (hb, mb)))
    return out


def main():
    ap = argparse.ArgumentParser(description="Export bid/ask ticks around rollover for research")
    ap.add_argument("--symbols", default=",".join(DEFAULT_SYMBOLS))
    ap.add_argument("--days", type=int, default=45)
    ap.add_argument("--windows", default="21:30-02:30,16:00-18:00")
    ap.add_argument("--outdir", default="tick_data")
    args = ap.parse_args()

    import MetaTrader5 as mt5
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except Exception:
        pass
    if not mt5.initialize():
        raise SystemExit(f"Could not start MT5: {mt5.last_error()}. Open the MT5 terminal and log in first.")
    login, pw, server = os.getenv("MT5_LOGIN"), os.getenv("MT5_PASSWORD"), os.getenv("MT5_SERVER")
    if login and pw and not mt5.login(int(login), password=pw, server=server):
        raise SystemExit(f"MT5 login failed: {mt5.last_error()}")
    info = mt5.account_info()
    if info is None:
        raise SystemExit("MT5 returned no account info - is the terminal logged in?")
    print(f"Connected: account {info.login} @ {info.server}")

    windows = parse_windows(args.windows)
    os.makedirs(args.outdir, exist_ok=True)
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    written = []
    for sym in [s.strip() for s in args.symbols.split(",") if s.strip()]:
        if not mt5.symbol_select(sym, True):
            print(f"  {sym}: not available - skipped")
            continue
        path = os.path.join(args.outdir, f"{sym}_ticks.csv")
        total, first_day, last_day, empty_run = 0, None, None, 0
        with open(path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["time_msc", "bid", "ask"])   # time_msc = broker SERVER time in epoch milliseconds (not converted)
            for back in range(0, args.days + 1):
                day = today - timedelta(days=back)
                if day.weekday() >= 5 and day.weekday() != 6:   # Saturday has no ticks; Sunday can (week open)
                    continue
                got_day = 0
                for (ha, ma), (hb, mb) in windows:
                    start = day.replace(hour=ha, minute=ma)
                    end = day.replace(hour=hb, minute=mb)
                    if end <= start:
                        end += timedelta(days=1)
                    ticks = mt5.copy_ticks_range(sym, start, end, mt5.COPY_TICKS_ALL)
                    if ticks is None or len(ticks) == 0:
                        continue
                    for t in ticks:
                        w.writerow([int(t["time_msc"]), t["bid"], t["ask"]])
                    got_day += len(ticks)
                if got_day:
                    total += got_day
                    first_day = day.date() if first_day is None or day.date() < first_day else first_day
                    last_day = day.date() if last_day is None or day.date() > last_day else last_day
                    empty_run = 0
                else:
                    empty_run += 1
                    if empty_run >= 10 and total:     # broker history has run out
                        break
        print(f"  {sym}: {total:,} ticks  {first_day} -> {last_day}")
        if total:
            written.append(path)
        else:
            os.remove(path)

    if not written:
        raise SystemExit("No tick data was returned. Your broker may not serve tick history - tell me and we will use another way.")
    zip_path = "aethelgard_ticks.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for p in written:
            z.write(p, os.path.basename(p))
    mt5.shutdown()
    print(f"\nDone. {len(written)} files -> {zip_path} ({os.path.getsize(zip_path) / 1e6:.1f} MB). Send me that zip file and this printed text.")


if __name__ == "__main__":
    sys.exit(main())
