"""
export_bars.py - save historical price bars from your MT5 terminal to CSV files
so strategies can be backtested on real data with the broker's real spreads.

Run it on the PC where MT5 is installed and logged in (same place bridge.py runs):

    cd python-bridge
    python export_bars.py

It writes a folder called  bars/  and zips it into  aethelgard_bars.zip.
It only READS price history. It never places or changes a trade.

Options (all optional):
    --symbols GOLD,US30Cash     only these symbols (default: all 13 engine pairs)
    --months-m15 12             how far back to go for 15-minute bars (default 12)
    --months-h1 24              how far back to go for 1-hour bars (default 24)
    --outdir bars               output folder
"""
import argparse
import csv
import os
import sys
import zipfile
from datetime import datetime, timedelta, timezone

PAIRS = ["GOLD", "EURUSD", "GBPUSD", "USDJPY", "US30Cash", "GER40Cash", "BTCUSD",
         "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "GBPJPY", "EURJPY"]


def fetch_range(mt5, symbol, tf, start, end, chunk_days):
    """Download in small chunks (a single huge request can come back empty)."""
    rows, seen = [], set()
    cur = start
    while cur < end:
        nxt = min(cur + timedelta(days=chunk_days), end)
        rates = mt5.copy_rates_range(symbol, tf, cur, nxt)
        if rates is not None:
            for r in rates:
                t = int(r["time"])
                if t not in seen:
                    seen.add(t)
                    rows.append(r)
        cur = nxt
    rows.sort(key=lambda r: int(r["time"]))
    return rows


def main():
    ap = argparse.ArgumentParser(description="Export MT5 price history to CSV")
    ap.add_argument("--symbols", default=",".join(PAIRS))
    ap.add_argument("--months-m15", type=int, default=12)
    ap.add_argument("--months-h1", type=int, default=24)
    ap.add_argument("--outdir", default="bars")
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
    if login and pw:
        if not mt5.login(int(login), password=pw, server=server):
            raise SystemExit(f"MT5 login failed: {mt5.last_error()}")
    info = mt5.account_info()
    if info is None:
        raise SystemExit("MT5 returned no account info - is the terminal logged in?")
    print(f"Connected: account {info.login} @ {info.server}")

    os.makedirs(args.outdir, exist_ok=True)
    now = datetime.now(timezone.utc)
    plans = [("M15", mt5.TIMEFRAME_M15, args.months_m15 * 31, 30),
             ("H1", mt5.TIMEFRAME_H1, args.months_h1 * 31, 180)]
    symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    written, spec_rows = [], []

    for sym in symbols:
        if not mt5.symbol_select(sym, True):
            print(f"  {sym}: not available on this broker - skipped")
            continue
        si = mt5.symbol_info(sym)
        if si is not None:
            spec_rows.append({
                "symbol": sym, "digits": si.digits, "point": si.point,
                "tick_size": si.trade_tick_size, "tick_value": si.trade_tick_value,
                "contract_size": si.trade_contract_size, "volume_min": si.volume_min,
                "volume_step": si.volume_step, "currency_profit": si.currency_profit,
            })
        for name, tf, days_back, chunk in plans:
            rows = fetch_range(mt5, sym, tf, now - timedelta(days=days_back), now, chunk)
            if not rows:
                print(f"  {sym} {name}: no data returned")
                continue
            path = os.path.join(args.outdir, f"{sym}_{name}.csv")
            with open(path, "w", newline="") as f:
                w = csv.writer(f)
                # time = broker SERVER time written as a plain timestamp (not converted)
                w.writerow(["time", "open", "high", "low", "close", "tick_volume", "spread_points"])
                for r in rows:
                    t = datetime.fromtimestamp(int(r["time"]), tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
                    w.writerow([t, r["open"], r["high"], r["low"], r["close"],
                                int(r["tick_volume"]), int(r["spread"])])
            first = datetime.fromtimestamp(int(rows[0]["time"]), tz=timezone.utc).date()
            last = datetime.fromtimestamp(int(rows[-1]["time"]), tz=timezone.utc).date()
            print(f"  {sym} {name}: {len(rows):,} bars  {first} -> {last}")
            written.append(path)

    if spec_rows:
        path = os.path.join(args.outdir, "symbol_specs.csv")
        with open(path, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(spec_rows[0].keys()))
            w.writeheader()
            w.writerows(spec_rows)
        written.append(path)

    if not written:
        raise SystemExit("Nothing was exported.")
    zip_path = "aethelgard_bars.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for p in written:
            z.write(p, os.path.basename(p))
    mt5.shutdown()
    size_mb = os.path.getsize(zip_path) / 1e6
    print(f"\nDone. {len(written)} files -> {zip_path} ({size_mb:.1f} MB). Send me that zip file.")


if __name__ == "__main__":
    sys.exit(main())
