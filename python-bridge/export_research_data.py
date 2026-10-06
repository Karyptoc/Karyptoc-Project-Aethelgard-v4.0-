"""
export_research_data.py - download LONG price history + swap/cost info from your MT5 terminal
for strategy research. Run it on the PC where MT5 is installed and logged in.

    cd python-bridge
    python export_research_data.py

It is READ-ONLY (never places or changes a trade). It writes a folder  research_data/  and zips it to
aethelgard_research_data.zip. Send me that zip.

What it exports, per symbol:
  * D1  (daily)    - as far back as your broker has it (up to --years-d1, default 20)
  * H1  (hourly)   - up to --months-h1 (default 96 = 8 years) or as far back as the broker has it
  * M15 (15-min)   - up to --months-m15 (default 36) or as far back as the broker has it
and  symbol_specs.csv  (point, tick value, contract size, lot limits, SWAP long/short, swap mode,
3-day-swap day, stops level, current spread, trading sessions) for every symbol.

It tries the 13 engine pairs plus a list of extra symbols (more FX crosses, silver, oil, US indices).
Any symbol your broker does not have is skipped quietly - that is fine.

Options (all optional):
    --symbols GOLD,US30Cash      only these (default: the 13 engine pairs + extras)
    --no-extras                  only the 13 engine pairs
    --years-d1 20 --months-h1 96 --months-m15 36
    --outdir research_data
"""
import argparse
import csv
import os
import sys
import zipfile
from datetime import datetime, timedelta, timezone

PAIRS = ["GOLD", "EURUSD", "GBPUSD", "USDJPY", "US30Cash", "GER40Cash", "BTCUSD",
         "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "GBPJPY", "EURJPY"]
# Extra instruments widen the research universe (cross-sectional carry/momentum needs breadth).
EXTRAS = ["EURGBP", "AUDJPY", "CADJPY", "CHFJPY", "NZDJPY", "EURAUD", "EURCHF", "EURCAD", "GBPAUD",
          "GBPCAD", "GBPCHF", "AUDNZD", "AUDCAD", "SILVER", "OILCash", "US500Cash", "US100Cash",
          "JP225Cash", "UK100Cash", "ETHUSD"]


def fetch_range(mt5, symbol, tf, start, end, chunk_days, stop_after_empty=None):
    """Download in chunks (one huge request can come back empty).
    Walks BACKWARD from `end` so that, if the broker's history runs out, we can stop early."""
    rows, seen = [], set()
    hi, empty_in_a_row = end, 0
    while hi > start:
        lo = max(hi - timedelta(days=chunk_days), start)
        rates = mt5.copy_rates_range(symbol, tf, lo, hi)
        got = 0
        if rates is not None:
            for r in rates:
                t = int(r["time"])
                if t not in seen:
                    seen.add(t)
                    rows.append(r)
                    got += 1
        empty_in_a_row = 0 if got else empty_in_a_row + 1
        if stop_after_empty and empty_in_a_row >= stop_after_empty and rows:
            break  # we are past the start of the broker's history
        hi = lo
    rows.sort(key=lambda r: int(r["time"]))
    return rows


def write_bars(path, rows):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        # time = broker SERVER time written as a plain timestamp (not converted) - same as export_bars.py
        w.writerow(["time", "open", "high", "low", "close", "tick_volume", "spread_points"])
        for r in rows:
            t = datetime.fromtimestamp(int(r["time"]), tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
            w.writerow([t, r["open"], r["high"], r["low"], r["close"], int(r["tick_volume"]), int(r["spread"])])


def spec_row(mt5, sym, si):
    tick = mt5.symbol_info_tick(sym)
    row = {
        "symbol": sym, "digits": si.digits, "point": si.point,
        "tick_size": si.trade_tick_size, "tick_value": si.trade_tick_value,
        "tick_value_profit": getattr(si, "trade_tick_value_profit", ""),
        "tick_value_loss": getattr(si, "trade_tick_value_loss", ""),
        "contract_size": si.trade_contract_size, "volume_min": si.volume_min,
        "volume_max": si.volume_max, "volume_step": si.volume_step,
        "currency_base": si.currency_base, "currency_profit": si.currency_profit,
        "currency_margin": si.currency_margin,
        "swap_mode": si.swap_mode, "swap_long": si.swap_long, "swap_short": si.swap_short,
        "swap_rollover3days": si.swap_rollover3days,
        "stops_level_points": si.trade_stops_level, "freeze_level_points": si.trade_freeze_level,
        "spread_now_points": si.spread, "spread_floating": si.spread_float,
        "trade_calc_mode": si.trade_calc_mode, "margin_initial": si.margin_initial,
        "bid_now": tick.bid if tick else "", "ask_now": tick.ask if tick else "",
        "path": si.path, "description": si.description,
    }
    return row


def main():
    ap = argparse.ArgumentParser(description="Export long MT5 history + swap/cost info for research")
    ap.add_argument("--symbols", default="")
    ap.add_argument("--no-extras", action="store_true")
    ap.add_argument("--years-d1", type=int, default=20)
    ap.add_argument("--months-h1", type=int, default=96)
    ap.add_argument("--months-m15", type=int, default=36)
    ap.add_argument("--outdir", default="research_data")
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
    print(f"Connected: account {info.login} @ {info.server} ({info.currency}, leverage 1:{info.leverage})")

    os.makedirs(args.outdir, exist_ok=True)
    now = datetime.now(timezone.utc)
    # (label, timeframe, how far back, chunk size in days, stop early after N empty chunks)
    plans = [
        ("D1", mt5.TIMEFRAME_D1, args.years_d1 * 366, 1500, 2),
        ("H1", mt5.TIMEFRAME_H1, args.months_h1 * 31, 180, 3),
        ("M15", mt5.TIMEFRAME_M15, args.months_m15 * 31, 45, 3),
    ]
    if args.symbols.strip():
        symbols = [s.strip() for s in args.symbols.split(",") if s.strip()]
    else:
        symbols = PAIRS + ([] if args.no_extras else EXTRAS)

    written, spec_rows, skipped = [], [], []
    for sym in symbols:
        if not mt5.symbol_select(sym, True):
            skipped.append(sym)
            continue
        si = mt5.symbol_info(sym)
        if si is None:
            skipped.append(sym)
            continue
        spec_rows.append(spec_row(mt5, sym, si))
        for name, tf, days_back, chunk, stop_after in plans:
            rows = fetch_range(mt5, sym, tf, now - timedelta(days=days_back), now, chunk, stop_after)
            if not rows:
                print(f"  {sym} {name}: no data returned")
                continue
            path = os.path.join(args.outdir, f"{sym}_{name}.csv")
            write_bars(path, rows)
            first = datetime.fromtimestamp(int(rows[0]["time"]), tz=timezone.utc).date()
            last = datetime.fromtimestamp(int(rows[-1]["time"]), tz=timezone.utc).date()
            print(f"  {sym} {name}: {len(rows):,} bars  {first} -> {last}")
            written.append(path)

    if spec_rows:
        path = os.path.join(args.outdir, "symbol_specs.csv")
        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=list(spec_rows[0].keys()))
            w.writeheader()
            w.writerows(spec_rows)
        written.append(path)

    if skipped:
        print("\nNot available on this broker (skipped, that's fine): " + ", ".join(skipped))
    if not written:
        raise SystemExit("Nothing was exported.")
    zip_path = "aethelgard_research_data.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for p in written:
            z.write(p, os.path.basename(p))
    mt5.shutdown()
    size_mb = os.path.getsize(zip_path) / 1e6
    print(f"\nDone. {len(written)} files -> {zip_path} ({size_mb:.1f} MB). Send me that zip file.")


if __name__ == "__main__":
    sys.exit(main())
