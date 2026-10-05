"""
AETHELGARD - MT5 history reconciliation

Reads the REAL deal history straight from MetaTrader 5 and (optionally)
rewrites the database so it matches the broker, trade by trade.

Why this exists: before the Oct 2026 fixes, closed trades were stored with a
stale floating P&L, duplicate rows, no close price/reason and shifted
timestamps. This script rebuilds every trade from MT5's own deals.

SAFE BY DEFAULT: running it with no flags only READS MT5, prints a full
summary and writes two CSV files. Nothing is sent to the database until you
add --apply.

Usage (run on the PC that has MT5 open and logged in to the account):
    cd python-bridge
    python reconcile_history.py                       # report + CSVs only
    python reconcile_history.py --apply               # also fix the database
    python reconcile_history.py --server-offset-hours 3

Needs the same .env as bridge.py (BACKEND_URL, BRIDGE_SECRET, MT5_LOGIN, ...).

Column conventions written to the database (same as bridge.py):
    profit      = gross trade profit
    swap        = swap
    commission  = commission + fee
    so  profit + swap + commission = the real net result of the trade.
"""

import argparse
import csv
import os
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

# MT5 constants (duplicated so the pure functions below can be tested
# without the MetaTrader5 package installed).
DEAL_TYPE_BUY, DEAL_TYPE_SELL, DEAL_TYPE_BALANCE = 0, 1, 2
DEAL_ENTRY_IN, DEAL_ENTRY_OUT, DEAL_ENTRY_INOUT, DEAL_ENTRY_OUT_BY = 0, 1, 2, 3
DEAL_REASON_LABELS = {4: "sl", 5: "tp", 6: "stop_out"}

NON_TRADE_TYPE_NAMES = {
    2: "balance (deposit/withdrawal)", 3: "credit", 4: "charge", 5: "correction",
    6: "bonus", 7: "commission", 8: "daily commission", 9: "monthly commission",
    10: "agent daily commission", 11: "agent monthly commission", 12: "interest",
    13: "buy canceled", 14: "sell canceled", 15: "dividend", 16: "dividend franked",
    17: "tax",
}


def _g(deal, name, default=0):
    v = getattr(deal, name, default)
    return default if v is None else v


def to_utc_iso(epoch_seconds, server_offset_hours):
    """MT5 stamps deals in BROKER SERVER time but exposes it as if it were
    UTC. Subtract the server offset to get real UTC."""
    dt = datetime.fromtimestamp(epoch_seconds, tz=timezone.utc) - timedelta(hours=server_offset_hours)
    return dt.isoformat()


def build_positions(deals, server_offset_hours):
    """Group deals by position and compute the true result of each position.

    Returns (positions, other_ops):
      positions - list of dicts, one per position that has at least one
                  opening deal. status is 'closed' if a closing deal exists,
                  otherwise 'open' (live sync handles those).
      other_ops - list of non-trade account operations (deposits, withdrawals,
                  credits, charges...).
    """
    by_pos = defaultdict(list)
    other_ops = []
    for d in deals:
        dtype = _g(d, "type")
        if dtype in (DEAL_TYPE_BUY, DEAL_TYPE_SELL):
            pid = _g(d, "position_id")
            if pid:
                by_pos[pid].append(d)
        else:
            other_ops.append({
                "time": to_utc_iso(_g(d, "time"), server_offset_hours),
                "type": NON_TRADE_TYPE_NAMES.get(dtype, f"type {dtype}"),
                "amount": round(_g(d, "profit") + _g(d, "commission") + _g(d, "fee") + _g(d, "swap"), 2),
                "comment": _g(d, "comment", ""),
            })

    positions = []
    for pid, ds in by_pos.items():
        ds.sort(key=lambda x: (_g(x, "time_msc", 0) or _g(x, "time") * 1000, _g(x, "ticket")))
        ins = [x for x in ds if _g(x, "entry") in (DEAL_ENTRY_IN, DEAL_ENTRY_INOUT)]
        outs = [x for x in ds if _g(x, "entry") in (DEAL_ENTRY_OUT, DEAL_ENTRY_OUT_BY, DEAL_ENTRY_INOUT)]
        if not ins:
            # History window started after this position opened - cannot
            # rebuild it faithfully, skip rather than guess.
            continue
        vol_in = sum(_g(x, "volume") for x in ins)

        def vwap(group):
            v = sum(_g(x, "volume") for x in group)
            return (sum(_g(x, "price") * _g(x, "volume") for x in group) / v) if v else None

        direction = "BUY" if _g(ins[0], "type") == DEAL_TYPE_BUY else "SELL"
        profit = sum(_g(x, "profit") for x in ds)
        swap = sum(_g(x, "swap") for x in ds)
        commission = sum(_g(x, "commission") + _g(x, "fee") for x in ds)
        closed = bool(outs) and sum(_g(x, "volume") for x in outs) >= vol_in - 1e-9
        last_out = outs[-1] if outs else None
        positions.append({
            "ticket": int(pid),
            "symbol": _g(ins[0], "symbol", ""),
            "direction": direction,
            "volume": round(vol_in, 2),
            "open_price": round(vwap(ins), 5),
            "close_price": round(vwap(outs), 5) if outs and closed else None,
            "open_time": to_utc_iso(_g(ins[0], "time"), server_offset_hours),
            "close_time": to_utc_iso(_g(last_out, "time"), server_offset_hours) if closed else None,
            "profit": round(profit, 2),
            "swap": round(swap, 2),
            "commission": round(commission, 2),
            "close_reason": DEAL_REASON_LABELS.get(_g(last_out, "reason", -1), "manual") if closed else None,
            "status": "closed" if closed else "open",
            "comment": _g(ins[0], "comment", ""),
        })
    positions.sort(key=lambda p: p["open_time"])
    return positions, other_ops


def net(p):
    return p["profit"] + p["swap"] + p["commission"]


def max_drawdown(values, start=0.0):
    peak = equity = start
    worst = 0.0
    for v in values:
        equity += v
        peak = max(peak, equity)
        worst = min(worst, equity - peak)
    return worst


def summarize(positions, other_ops, account_balance=None):
    closed = [p for p in positions if p["status"] == "closed"]
    closed.sort(key=lambda p: p["close_time"])
    lines = []
    add = lines.append

    deposits = sum(o["amount"] for o in other_ops if o["amount"] > 0 and o["type"].startswith("balance"))
    withdrawals = sum(o["amount"] for o in other_ops if o["amount"] < 0 and o["type"].startswith("balance"))
    other_adj = sum(o["amount"] for o in other_ops if not o["type"].startswith("balance"))
    trading_net = sum(net(p) for p in closed)
    gross = sum(p["profit"] for p in closed)
    swap = sum(p["swap"] for p in closed)
    comm = sum(p["commission"] for p in closed)

    add("=" * 64)
    add("MT5 TRUE HISTORY SUMMARY")
    add("=" * 64)
    add(f"Closed trades          : {len(closed)}   (still open: {len(positions) - len(closed)})")
    if closed:
        add(f"First trade opened     : {closed[0]['open_time'][:10]}   Last close: {closed[-1]['close_time'][:10]}")
    add("")
    add("ACCOUNT MONEY FLOW")
    add(f"  Deposits             : {deposits:>12,.2f}")
    add(f"  Withdrawals          : {withdrawals:>12,.2f}")
    add(f"  Other adjustments    : {other_adj:>12,.2f}   (credit/bonus/charge/correction/interest...)")
    add(f"  Trading result (net) : {trading_net:>12,.2f}   = gross {gross:,.2f} + swap {swap:,.2f} + commission/fees {comm:,.2f}")
    implied = deposits + withdrawals + other_adj + trading_net
    add(f"  => Implied balance   : {implied:>12,.2f}   (deposits + withdrawals + adjustments + trading net)")
    if account_balance is not None:
        diff = account_balance - implied
        add(f"  Actual MT5 balance   : {account_balance:>12,.2f}   difference {diff:+,.2f}"
            + ("   OK - history is complete" if abs(diff) < 1.0 else "   CHECK - history may be incomplete or a position is still open"))

    if closed:
        wins = [net(p) for p in closed if net(p) > 0]
        losses = [net(p) for p in closed if net(p) < 0]
        pf = (sum(wins) / abs(sum(losses))) if losses else float("inf")
        dd = max_drawdown([net(p) for p in closed], start=deposits)
        add("")
        add("TRADING STATISTICS (net of swap and commission)")
        add(f"  Win rate             : {100 * len(wins) / len(closed):.1f}%   ({len(wins)} wins / {len(losses)} losses)")
        add(f"  Profit factor        : {pf:.2f}")
        add(f"  Average win / loss   : {(sum(wins) / len(wins)) if wins else 0:,.2f} / {(sum(losses) / len(losses)) if losses else 0:,.2f}")
        add(f"  Largest loss         : {min(net(p) for p in closed):,.2f}")
        add(f"  Max drawdown (closed): {dd:,.2f}")

        add("")
        add("BY SYMBOL                  trades     net      win%   avg win  avg loss")
        sym = defaultdict(list)
        for p in closed:
            sym[p["symbol"]].append(net(p))
        for s, v in sorted(sym.items(), key=lambda kv: sum(kv[1])):
            w = [x for x in v if x > 0]
            l = [x for x in v if x < 0]
            add(f"  {s:<22}{len(v):>7}{sum(v):>11,.2f}{100 * len(w) / len(v):>8.0f}"
                f"{(sum(w) / len(w)) if w else 0:>10,.2f}{(sum(l) / len(l)) if l else 0:>10,.2f}")

        add("")
        add("BY MONTH (close date)     trades     net")
        mon = defaultdict(list)
        for p in closed:
            mon[p["close_time"][:7]].append(net(p))
        for m, v in sorted(mon.items()):
            add(f"  {m:<22}{len(v):>7}{sum(v):>11,.2f}")

        add("")
        add("BY CLOSE REASON          trades     net")
        rs = defaultdict(list)
        for p in closed:
            rs[p["close_reason"]].append(net(p))
        for r, v in sorted(rs.items(), key=lambda kv: sum(kv[1])):
            add(f"  {r:<22}{len(v):>7}{sum(v):>11,.2f}")
    add("=" * 64)
    return "\n".join(lines)


def write_csvs(positions, other_ops, outdir):
    p1 = os.path.join(outdir, "mt5_true_trades.csv")
    cols = ["ticket", "symbol", "direction", "volume", "open_price", "close_price", "open_time",
            "close_time", "profit", "swap", "commission", "close_reason", "status", "comment"]
    with open(p1, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(positions)
    p2 = os.path.join(outdir, "mt5_balance_ops.csv")
    with open(p2, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["time", "type", "amount", "comment"])
        w.writeheader()
        w.writerows(other_ops)
    return p1, p2


def apply_to_backend(positions, login, backend_url, secret, requests_mod, chunk=100):
    headers = {"Content-Type": "application/json", "x-bridge-secret": secret}
    r = requests_mod.get(f"{backend_url}/api/bridge/accounts", headers=headers, timeout=30)
    r.raise_for_status()
    accounts = r.json().get("accounts", [])
    match = [a for a in accounts if str(a.get("login")) == str(login)]
    if not match:
        known = ", ".join(str(a.get("login")) for a in accounts) or "none"
        raise SystemExit(f"No account with login {login} in the database (found: {known}). Nothing was changed.")
    account_id = match[0]["id"]
    closed = [p for p in positions if p["status"] == "closed"]
    totals = {"updated": 0, "inserted": 0, "duplicates_removed": 0, "errors": 0}
    for i in range(0, len(closed), chunk):
        batch = closed[i:i + chunk]
        rr = requests_mod.post(f"{backend_url}/api/bridge/reconcile", headers=headers,
                               json={"account_id": account_id, "trades": batch}, timeout=120)
        if rr.status_code != 200:
            raise SystemExit(f"Backend rejected batch starting at {i}: {rr.status_code} {rr.text[:300]}")
        res = rr.json()
        for k in totals:
            totals[k] += res.get(k, 0)
        print(f"  batch {i // chunk + 1}: {res}")
    return totals


def main():
    ap = argparse.ArgumentParser(description="Reconcile the database with real MT5 history")
    ap.add_argument("--apply", action="store_true", help="write corrections to the database (default: report only)")
    ap.add_argument("--server-offset-hours", type=float, default=3.0,
                    help="broker server time minus UTC, in hours (default 3 = summer EET; use 2 in winter)")
    ap.add_argument("--outdir", default=".", help="where to write the CSV files")
    args = ap.parse_args()

    import MetaTrader5 as mt5
    import requests
    from dotenv import load_dotenv
    load_dotenv()

    if not mt5.initialize():
        raise SystemExit(f"Could not start MT5: {mt5.last_error()}. Open the MT5 terminal and log in first.")
    login_env, pw, server = os.getenv("MT5_LOGIN"), os.getenv("MT5_PASSWORD"), os.getenv("MT5_SERVER")
    if login_env and pw:
        if not mt5.login(int(login_env), password=pw, server=server):
            raise SystemExit(f"MT5 login failed: {mt5.last_error()}")
    info = mt5.account_info()
    if info is None:
        raise SystemExit("MT5 returned no account info - is the terminal logged in?")
    print(f"Account {info.login} @ {info.server}  balance {info.balance:,.2f}  equity {info.equity:,.2f}")

    start = datetime(2015, 1, 1)
    end = datetime.now() + timedelta(days=2)
    deals = mt5.history_deals_get(start, end)
    if not deals:
        raise SystemExit(f"No deal history returned: {mt5.last_error()}")
    print(f"Fetched {len(deals)} deals. Server offset used: UTC+{args.server_offset_hours:g}h")

    positions, other_ops = build_positions(deals, args.server_offset_hours)
    print(summarize(positions, other_ops, account_balance=info.balance))
    p1, p2 = write_csvs(positions, other_ops, args.outdir)
    print(f"\nWrote {p1}\nWrote {p2}")

    if not args.apply:
        print("\nREPORT ONLY - nothing was changed in the database. Add --apply to fix it.")
        mt5.shutdown()
        return

    backend = os.getenv("BACKEND_URL")
    secret = os.getenv("BRIDGE_SECRET")
    if not backend or not secret:
        raise SystemExit("BACKEND_URL and BRIDGE_SECRET must be set in .env to use --apply")
    print("\nApplying to database...")
    totals = apply_to_backend(positions, info.login, backend.rstrip("/"), secret, requests)
    print(f"Done: {totals}")
    mt5.shutdown()


if __name__ == "__main__":
    main()
