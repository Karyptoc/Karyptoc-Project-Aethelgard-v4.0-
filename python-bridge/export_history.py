"""
Export broker history and specs from a running, logged-in MT5 terminal.

What it writes (one folder per broker, e.g. exports/XM/):
  manifest.json            broker, server, detected clock offset, row counts, gaps
  symbol_map.json          canonical id -> broker symbol, plus unresolved near-misses
  specs.json               contract specs per symbol (incl. margin for 1 lot)
  spread_by_hour.csv       median and 90th-percentile spread per UTC hour
  M1/<CANON>.csv           1-minute bars, UTC time, tick volume, spread (points)
  D1/<CANON>.csv           daily bars, UTC time

Usage (Windows, MT5 open and logged in to the broker you want to profile):
  pip install MetaTrader5 pandas requests
  python export_history.py --broker XM --days 730
  python export_history.py --broker HFM --days 730 --upload   # also push specs/map to Supabase

With more than one MT5 installed, point at the right terminal and log in explicitly
(the password is asked for and never shown or saved):
  python export_history.py --broker HFM --days 730 --path "C:\\Program Files\\HFM MetaTrader 5\\terminal64.exe" --login 12345678 --server "HFMarketsGlobal-Demo"

Before running: in MT5 set Tools > Options > Charts > "Max. bars in chart" to Unlimited,
otherwise the terminal may return less history than the server has.
"""
import argparse
import getpass
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pandas as pd

try:
    import MetaTrader5 as mt5
except ImportError:  # allows syntax checks off Windows
    mt5 = None

from symbol_resolver import resolve

NY = ZoneInfo("America/New_York")
SERVER_TIME_MODES = {"XM": "ny_close", "HFM": "ny_close", "EXNESS": "utc", "PEPPERSTONE": "ny_close"}


# ---------------------------------------------------------------- clock
def detect_server_offset_hours(probe_symbol):
    """Server clock minus UTC, from the latest tick. Only valid while the market is open."""
    tick = mt5.symbol_info_tick(probe_symbol)
    if tick is None or tick.time == 0:
        return None
    diff = (tick.time - time.time()) / 3600.0
    if abs(diff - round(diff)) > 0.1:  # tick is stale (market closed)
        return None
    return int(round(diff))


def server_epoch_to_utc(series, mode, fixed_offset_h=0):
    """MT5 returns server wall-clock time encoded as if it were UTC. Convert to real UTC."""
    naive = pd.to_datetime(series, unit="s")
    if mode == "utc":
        return naive.dt.tz_localize("UTC")
    if mode == "ny_close":  # server = New York local time + 7h
        ny_local = naive - pd.Timedelta(hours=7)
        return ny_local.dt.tz_localize(NY, ambiguous="NaT", nonexistent="shift_forward").dt.tz_convert("UTC")
    return (naive - pd.Timedelta(hours=fixed_offset_h)).dt.tz_localize("UTC")


# ---------------------------------------------------------------- data
def fetch_m1(symbol, start, end, chunk_days=20):
    frames = []
    cur = start
    while cur < end:
        nxt = min(cur + timedelta(days=chunk_days), end)
        rates = mt5.copy_rates_range(symbol, mt5.TIMEFRAME_M1, cur, nxt)
        if rates is not None and len(rates):
            frames.append(pd.DataFrame(rates))
        cur = nxt
    if not frames:
        return pd.DataFrame()
    df = pd.concat(frames).drop_duplicates("time").sort_values("time")
    return df


def fetch_d1(symbol, count=4000):
    rates = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_D1, 0, count)
    return pd.DataFrame(rates) if rates is not None else pd.DataFrame()


def spec_of(symbol):
    i = mt5.symbol_info(symbol)
    if i is None:
        return None
    tick = mt5.symbol_info_tick(symbol)
    margin = None
    if tick and tick.ask:
        margin = mt5.order_calc_margin(mt5.ORDER_TYPE_BUY, symbol, 1.0, tick.ask)
    return {
        "broker_symbol": symbol,
        "contract_size": i.trade_contract_size,
        "tick_size": i.trade_tick_size,
        "tick_value": i.trade_tick_value,
        "point": i.point,
        "digits": i.digits,
        "volume_min": i.volume_min,
        "volume_step": i.volume_step,
        "volume_max": i.volume_max,
        "trade_stops_level": i.trade_stops_level,
        "filling_mode": i.filling_mode,
        "margin_per_lot": margin,
        "swap_long": i.swap_long,
        "swap_short": i.swap_short,
        "currency_profit": i.currency_profit,
        "trade_mode": i.trade_mode,
    }


def gap_count(df, max_gap_minutes=5):
    """Gaps longer than max_gap_minutes on weekdays (weekend closures excluded)."""
    if df.empty:
        return 0
    t = df["time_utc"]
    d = t.diff().dt.total_seconds().div(60)
    weekday = t.dt.weekday < 5
    return int(((d > max_gap_minutes) & (d < 60 * 40) & weekday).sum())


# ---------------------------------------------------------------- upload
def upload(broker, symbol_map, specs, spread_df):
    import requests
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        print("SUPABASE_URL / SUPABASE_SERVICE_KEY not set; skipping upload")
        return
    h = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json",
         "Prefer": "resolution=merge-duplicates"}
    today = datetime.now(timezone.utc).date().isoformat()
    rows = [{"broker_profile": broker, "instrument": c, "broker_symbol": s, "source": "resolver"} for c, s in symbol_map.items()]
    r = requests.post(f"{url}/rest/v1/symbol_map", headers=h, json=rows, timeout=30)
    print("symbol_map upload:", r.status_code)
    spec_rows = []
    for s in specs.values():
        row = {k: s[k] for k in ("broker_symbol", "contract_size", "tick_size", "tick_value", "point", "digits",
                                 "volume_min", "volume_step", "volume_max", "trade_stops_level", "filling_mode",
                                 "margin_per_lot", "swap_long", "swap_short", "currency_profit")}
        row.update({"broker_profile": broker, "spec_date": today, "raw": s})
        spec_rows.append(row)
    r = requests.post(f"{url}/rest/v1/symbol_specs", headers=h, json=spec_rows, timeout=30)
    print("symbol_specs upload:", r.status_code)
    if not spread_df.empty:
        sp = spread_df.assign(broker_profile=broker).to_dict("records")
        r = requests.post(f"{url}/rest/v1/spread_stats", headers=h, json=sp, timeout=30)
        print("spread_stats upload:", r.status_code)


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--broker", required=True, choices=["XM", "HFM", "EXNESS", "PEPPERSTONE"])
    ap.add_argument("--days", type=int, default=730, help="days of M1 history to request")
    ap.add_argument("--out", default="exports")
    ap.add_argument("--server-time", choices=["auto", "ny_close", "utc"], default="auto")
    ap.add_argument("--override", action="append", default=[], help="CANON=BrokerSymbol, e.g. NAS100=US100Cash")
    ap.add_argument("--upload", action="store_true")
    ap.add_argument("--path", help="full path to the broker's terminal64.exe (use when several MT5s are installed)")
    ap.add_argument("--login", type=int, help="MT5 account number (password is prompted)")
    ap.add_argument("--server", help="MT5 server name exactly as shown in the terminal login window")
    args = ap.parse_args()

    if mt5 is None:
        sys.exit("MetaTrader5 package not installed (pip install MetaTrader5); this script runs on Windows with MT5 open.")
    init_kwargs = {}
    if args.path:
        if not os.path.isfile(args.path):
            sys.exit(f"Terminal not found: {args.path}")
        init_kwargs["path"] = args.path
    if args.login:
        if not args.server:
            sys.exit("--server is required with --login")
        init_kwargs.update(login=args.login, server=args.server,
                           password=getpass.getpass("MT5 password (input hidden): "))
    if not mt5.initialize(**init_kwargs):
        err = mt5.last_error()
        hint = ""
        if err and err[0] == -6:
            hint = ("\nAuthorization failed: the terminal the script reached is not logged in, or the login/server/password is wrong."
                    "\nFix: open the broker's MT5, log in with 'Save password' ticked, or run again with --path, --login and --server.")
        sys.exit(f"MT5 initialize failed: {err}{hint}")

    acc, term = mt5.account_info(), mt5.terminal_info()
    print(f"Connected: {acc.company} / {acc.server} / account {acc.login} ({'DEMO' if acc.trade_mode == 0 else 'REAL/CONTEST'})")
    margin_mode = {0: "netting", 2: "hedging"}.get(acc.margin_mode, str(acc.margin_mode))
    print(f"Account margin mode: {margin_mode}  (hedging is needed for separate tickets per strategy)")

    overrides = dict(o.split("=", 1) for o in args.override)
    names = [s.name for s in mt5.symbols_get()]
    symbol_map, unresolved = resolve(names, overrides)
    for c, s in symbol_map.items():
        print(f"  {c:7s} -> {s}")
    for c, near in unresolved.items():
        print(f"  {c:7s} -> NOT FOUND. Similar names: {near}. Re-run with --override {c}=<name> if one is right.")

    for s in symbol_map.values():
        mt5.symbol_select(s, True)
    time.sleep(1.0)

    detected = None
    for probe in (symbol_map.get("EURUSD"), symbol_map.get("XAUUSD"), symbol_map.get("BTCUSD")):
        if probe and detected is None:
            detected = detect_server_offset_hours(probe)
    expected = SERVER_TIME_MODES[args.broker]
    mode = expected if args.server_time == "auto" else args.server_time
    print(f"Server clock offset detected now: {detected if detected is not None else 'unknown (market closed)'} h; "
          f"using mode '{mode}'")
    if detected is not None and mode == "utc" and detected != 0:
        print("  WARNING: mode 'utc' but server is not on UTC. Re-run with --server-time ny_close or check the broker.")
    if detected is not None and mode == "ny_close":
        now_ny_off = datetime.now(NY).utcoffset().total_seconds() / 3600 + 7
        if detected != int(now_ny_off):
            print(f"  WARNING: ny_close implies UTC+{int(now_ny_off)} now, but server shows UTC+{detected}. Check before using the data.")

    out = os.path.join(args.out, args.broker)
    os.makedirs(os.path.join(out, "M1"), exist_ok=True)
    os.makedirs(os.path.join(out, "D1"), exist_ok=True)

    end = datetime.now(timezone.utc) + timedelta(days=1)
    start = end - timedelta(days=args.days)
    manifest = {"broker": args.broker, "company": acc.company, "server": acc.server, "account_mode": margin_mode,
                "account_currency": acc.currency, "server_time_mode": mode, "detected_offset_h": detected,
                "exported_at": datetime.now(timezone.utc).isoformat(), "symbols": {}}
    specs, spread_rows = {}, []

    for canon, sym in symbol_map.items():
        print(f"Exporting {canon} ({sym}) ...", flush=True)
        specs[canon] = spec_of(sym)
        m1 = fetch_m1(sym, start, end)
        if not m1.empty:
            m1["time_utc"] = server_epoch_to_utc(m1["time"], mode)
            m1 = m1.dropna(subset=["time_utc"])
            cols = ["time_utc", "open", "high", "low", "close", "tick_volume", "spread"]
            m1[cols].rename(columns={"spread": "spread_points"}).to_csv(os.path.join(out, "M1", f"{canon}.csv"), index=False)
            hourly = m1.groupby(m1["time_utc"].dt.hour)["spread"]
            for hr, g in hourly:
                spread_rows.append({"broker_symbol": sym, "hour_utc": int(hr), "sample_days": int(g.size // 60) or 1,
                                    "median_spread_points": float(g.median()), "p90_spread_points": float(g.quantile(0.9))})
        d1 = fetch_d1(sym)
        if not d1.empty:
            d1["time_utc"] = server_epoch_to_utc(d1["time"], mode)
            d1[["time_utc", "open", "high", "low", "close", "tick_volume", "spread"]].to_csv(os.path.join(out, "D1", f"{canon}.csv"), index=False)
        manifest["symbols"][canon] = {
            "broker_symbol": sym,
            "m1_rows": int(len(m1)),
            "m1_from": str(m1["time_utc"].min()) if not m1.empty else None,
            "m1_to": str(m1["time_utc"].max()) if not m1.empty else None,
            "m1_gaps_over_5min_weekdays": gap_count(m1) if not m1.empty else None,
            "d1_rows": int(len(d1)),
            "d1_from": str(d1["time_utc"].min()) if not d1.empty else None,
        }

    spread_df = pd.DataFrame(spread_rows)
    spread_df.to_csv(os.path.join(out, "spread_by_hour.csv"), index=False)
    with open(os.path.join(out, "specs.json"), "w") as f:
        json.dump(specs, f, indent=2, default=str)
    with open(os.path.join(out, "symbol_map.json"), "w") as f:
        json.dump({"resolved": symbol_map, "unresolved": unresolved}, f, indent=2)
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2, default=str)

    print("\nSummary (M1 history is what the strategies need; D1 for Strategy C):")
    for c, m in manifest["symbols"].items():
        print(f"  {c:7s} M1 {m['m1_rows']:>9,} rows {m['m1_from']} -> {m['m1_to']}  gaps {m['m1_gaps_over_5min_weekdays']}  D1 {m['d1_rows']} rows")
    if args.upload:
        upload(args.broker, symbol_map, specs, spread_df)
    mt5.shutdown()
    print(f"\nDone. Files in {os.path.abspath(out)}")


if __name__ == "__main__":
    main()
