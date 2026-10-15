"""
Aethelgard STRATEGY bridge — runs Strategies A/B on a dedicated MT5 terminal (HFM demo).

Separate from bridge.py on purpose: the MetaTrader5 Python package can talk to only one
terminal per process, and the old engine keeps using bridge.py on its own terminal.

Every minute (a few seconds after the minute closes) it:
  1. reads account, open strategy positions (magic 710001-710003) and recent deals
  2. sends the last closed 1-minute bars of each active instrument to the backend
  3. receives orders and executes them (market orders, server-side stop on every entry)
The backend makes every decision; this program only moves data and places orders.

Settings: python-bridge/.env (BACKEND_URL, BRIDGE_SECRET — shared with bridge.py)
          python-bridge/.env.strategy (STRATEGY_MT5_PATH, _LOGIN, _SERVER, _PASSWORD)
.env.strategy is git-ignored; never commit it.
"""
import json
import logging
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import requests
from dotenv import load_dotenv

try:
    import MetaTrader5 as mt5
except ImportError:
    mt5 = None

from symbol_resolver import resolve

HERE = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(HERE, ".env"))
load_dotenv(os.path.join(HERE, ".env.strategy"), override=True)

BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:4000").rstrip("/")
BRIDGE_SECRET = os.getenv("BRIDGE_SECRET", "")
MT5_PATH = os.getenv("STRATEGY_MT5_PATH")
MT5_LOGIN = os.getenv("STRATEGY_MT5_LOGIN")
MT5_SERVER = os.getenv("STRATEGY_MT5_SERVER")
MT5_PASSWORD = os.getenv("STRATEGY_MT5_PASSWORD")
ALLOW_REAL = os.getenv("STRATEGY_ALLOW_REAL_ACCOUNT", "0") == "1"   # second, local guard against real-money orders
DONE_FILE = os.path.join(HERE, "strategy_bridge_done.json")         # order keys already sent (duplicate guard)

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.FileHandler(os.path.join(HERE, "strategy_bridge.log"), encoding="utf-8"), logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("strategy-bridge")
HEADERS = {"Content-Type": "application/json", "x-bridge-secret": BRIDGE_SECRET}


# ---------------------------------------------------------------- helpers
def api(method, path, payload=None, timeout=60):
    url = f"{BACKEND_URL}/api/strategy-bridge{path}"
    for attempt in range(3):
        try:
            r = requests.request(method, url, headers=HEADERS, data=json.dumps(payload) if payload is not None else None, timeout=timeout)
            if r.status_code == 200:
                return r.json()
            log.warning(f"{method} {path} -> HTTP {r.status_code}: {r.text[:300]}")
        except requests.RequestException as e:
            log.warning(f"{method} {path} failed ({e}); attempt {attempt + 1}/3")
        time.sleep(3 * (attempt + 1))  # Render free tier may be waking up
    return None


def load_done():
    try:
        with open(DONE_FILE) as f:
            data = json.load(f)
        cutoff = time.time() - 3 * 86400
        return {k: v for k, v in data.items() if v > cutoff}
    except (OSError, ValueError):
        return {}


def save_done(done):
    try:
        with open(DONE_FILE, "w") as f:
            json.dump(done, f)
    except OSError as e:
        log.warning(f"could not save {DONE_FILE}: {e}")


def connect():
    if mt5.terminal_info() is not None and mt5.account_info() is not None:
        return True
    kwargs = {}
    if MT5_PATH:
        kwargs["path"] = MT5_PATH
    if MT5_LOGIN:
        kwargs.update(login=int(MT5_LOGIN), server=MT5_SERVER, password=MT5_PASSWORD)
    if not mt5.initialize(**kwargs):
        log.error(f"MT5 initialize failed: {mt5.last_error()}")
        return False
    acc = mt5.account_info()
    log.info(f"Connected: {acc.company} / {acc.server} / {acc.login} ({'DEMO' if acc.trade_mode == 0 else 'REAL'}) {acc.currency}")
    return True


def value_per_point_per_lot(symbol):
    """Account-currency value of a 1.0 price move for 1 lot, from MT5's own profit calculator.
    Used instead of trade_tick_value, which some brokers report unconverted (e.g. HFM indices on KES accounts)."""
    tick = mt5.symbol_info_tick(symbol)
    if tick is None or not tick.ask:
        return None
    p = mt5.order_calc_profit(mt5.ORDER_TYPE_BUY, symbol, 1.0, tick.ask, tick.ask + 1.0)
    return abs(p) if p else None


def spec_of(symbol):
    i = mt5.symbol_info(symbol)
    tick = mt5.symbol_info_tick(symbol)
    vpp = value_per_point_per_lot(symbol)
    if i is None or tick is None or not vpp:
        return None
    margin = mt5.order_calc_margin(mt5.ORDER_TYPE_BUY, symbol, 1.0, tick.ask) if tick.ask else None
    return {
        "value_per_point_per_lot": vpp, "point": i.point, "digits": i.digits,
        "volume_min": i.volume_min, "volume_step": i.volume_step, "volume_max": i.volume_max,
        "trade_stops_level": i.trade_stops_level, "margin_per_lot": margin, "filling_mode": i.filling_mode,
    }


def bars_of(symbol, count):
    rates = mt5.copy_rates_from_pos(symbol, mt5.TIMEFRAME_M1, 1, count)  # position 1 = skip the forming bar
    if rates is None:
        return []
    return [{"t": int(r["time"]), "o": float(r["open"]), "h": float(r["high"]), "l": float(r["low"]),
             "c": float(r["close"]), "v": int(r["tick_volume"]), "s": int(r["spread"])} for r in rates]


def filling_for(symbol):
    i = mt5.symbol_info(symbol)
    fm = i.filling_mode if i else 0
    if fm & 1:
        return mt5.ORDER_FILLING_FOK
    if fm & 2:
        return mt5.ORDER_FILLING_IOC
    return mt5.ORDER_FILLING_RETURN


# ---------------------------------------------------------------- order execution
def execute(order, done):
    key = order["key"]
    if key in done:
        log.info(f"skip duplicate {key}")
        return
    symbol = order["symbol"]
    acc = mt5.account_info()
    if order["action"] == "open" and acc.trade_mode != 0 and not ALLOW_REAL:
        log.error(f"REFUSED {key}: account {acc.login} is not a demo account (set STRATEGY_ALLOW_REAL_ACCOUNT=1 only after live approval)")
        api("POST", "/order-result", {"key": key, "ok": False, "action": order["action"], "symbol": symbol, "retcode": None, "message": "refused: real account"})
        return
    mt5.symbol_select(symbol, True)
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        log.error(f"no price for {symbol}")
        return
    is_buy = order["side"] == "buy"
    req = {
        "action": mt5.TRADE_ACTION_DEAL, "symbol": symbol, "volume": float(order["lots"]),
        "type": mt5.ORDER_TYPE_BUY if is_buy else mt5.ORDER_TYPE_SELL,
        "price": tick.ask if is_buy else tick.bid, "deviation": 30, "magic": int(order["magic"]),
        "type_time": mt5.ORDER_TIME_GTC, "type_filling": filling_for(symbol),
    }
    if order["action"] == "open":
        # an existing position with this key means it was already placed (e.g. bridge restarted mid-send)
        if any(p.comment == order["comment"] for p in (mt5.positions_get(symbol=symbol) or [])):
            done[key] = time.time()
            return
        req["sl"] = float(order["sl"])
        req["comment"] = order["comment"][:31]
    else:
        pos = mt5.positions_get(ticket=int(order["ticket"]))
        if not pos:
            done[key] = time.time()   # already closed (stop hit or earlier close)
            return
        req["position"] = int(order["ticket"])
        req["volume"] = float(pos[0].volume)
        req["comment"] = f"close {order.get('strategy', '')}"[:31]
    res = mt5.order_send(req)
    ok = res is not None and res.retcode == mt5.TRADE_RETCODE_DONE
    msg = res.comment if res is not None else str(mt5.last_error())
    log.info(f"{'OK ' if ok else 'FAIL'} {order['action']} {order['side']} {req['volume']} {symbol} key={key} retcode={getattr(res, 'retcode', None)} {msg}")
    api("POST", "/order-result", {"key": key, "ok": ok, "action": order["action"], "symbol": symbol, "lots": req["volume"],
                                   "retcode": getattr(res, "retcode", None), "message": msg,
                                   "price": getattr(res, "price", None), "ticket": getattr(res, "order", None)})
    if ok:
        done[key] = time.time()


# ---------------------------------------------------------------- main loop
def run():
    if mt5 is None:
        sys.exit("MetaTrader5 package not installed")
    if not BRIDGE_SECRET:
        sys.exit("BRIDGE_SECRET missing in .env")
    if not MT5_PATH or not MT5_LOGIN:
        sys.exit("Fill in python-bridge/.env.strategy (STRATEGY_MT5_PATH, STRATEGY_MT5_LOGIN, STRATEGY_MT5_SERVER, STRATEGY_MT5_PASSWORD)")
    log.info(f"Strategy bridge starting. Backend: {BACKEND_URL}")
    done = load_done()
    cfg, cfg_at, symbol_map = None, 0, {}
    last_minute = None
    ticks_ok = 0
    while True:
        try:
            now = datetime.now(timezone.utc)
            minute = now.replace(second=0, microsecond=0)
            if minute == last_minute or now.second < 3:   # run once per minute, 3s after the bar closes
                time.sleep(1)
                continue
            last_minute = minute
            if not connect():
                time.sleep(20)
                continue

            if cfg is None or time.time() - cfg_at > 300:
                new_cfg = api("GET", "/config")
                if new_cfg:
                    cfg, cfg_at = new_cfg, time.time()
                    names = [s.name for s in mt5.symbols_get()]
                    overrides = {i["id"]: i["override"] for i in cfg["instruments"] if i.get("override")}
                    resolved, unresolved = resolve(names, overrides)
                    symbol_map = {i["id"]: resolved.get(i["id"]) for i in cfg["instruments"]}
                    for cid, s in symbol_map.items():
                        if s:
                            mt5.symbol_select(s, True)
                        else:
                            log.warning(f"{cid}: no matching symbol on this broker {unresolved.get(cid, [])}")
            if cfg is None:
                time.sleep(10)
                continue

            acc = mt5.account_info()
            magics = set(cfg["magics"])
            positions = [{"ticket": p.ticket, "symbol": p.symbol, "type": p.type, "volume": p.volume, "price_open": p.price_open,
                          "sl": p.sl, "magic": p.magic, "comment": p.comment} for p in (mt5.positions_get() or []) if p.magic in magics]
            deals = [{"ticket": d.ticket, "position_id": d.position_id, "time": int(d.time), "type": d.type, "entry": d.entry,
                      "volume": d.volume, "price": d.price, "profit": d.profit, "swap": d.swap, "commission": d.commission,
                      "fee": getattr(d, "fee", 0.0), "magic": d.magic, "symbol": d.symbol, "comment": d.comment, "reason": d.reason}
                     for d in (mt5.history_deals_get(now - timedelta(days=3), now + timedelta(days=1)) or []) if d.magic in magics]
            instruments = {}
            for item in cfg["instruments"]:
                sym = symbol_map.get(item["id"])
                if not sym:
                    continue
                spec = spec_of(sym)
                if spec is None:
                    continue
                tick = mt5.symbol_info_tick(sym)
                spread_pts = round((tick.ask - tick.bid) / spec["point"]) if tick else None
                instruments[item["id"]] = {"brokerSymbol": sym, "spec": spec, "spreadPoints": spread_pts,
                                           "bars": bars_of(sym, cfg.get("barsPerTick", 600)) if item["needBars"] else []}
            payload = {"account": {"login": acc.login, "server": acc.server, "currency": acc.currency, "trade_mode": acc.trade_mode,
                                   "equity": acc.equity, "balance": acc.balance, "margin": acc.margin, "margin_free": acc.margin_free},
                       "positions": positions, "deals": deals, "instruments": instruments}
            resp = api("POST", "/tick", payload)
            if not resp:
                continue
            ticks_ok += 1
            if minute.minute % 15 == 0:   # heartbeat so the window shows the bridge is alive
                held = ", ".join(f"{p['symbol']} {'BUY' if p['type'] == 0 else 'SELL'} {p['volume']}" for p in positions) or "none"
                log.info(f"alive: {ticks_ok} check-ins OK since start | equity {acc.equity:,.2f} {acc.currency} | "
                         f"strategy positions: {held} | trading: {', '.join(k for k, v in instruments.items() if v['bars']) or 'none'}")
            for cid in resp.get("needHistory", []):
                sym = symbol_map.get(cid)
                if sym:
                    hist = bars_of(sym, cfg.get("historyBars", 30000))
                    log.info(f"sending {len(hist)} history bars for {cid} ({sym})")
                    api("POST", "/history", {"instrument": cid, "bars": hist}, timeout=120)
            for order in resp.get("orders", []):
                execute(order, done)
            save_done(done)
        except KeyboardInterrupt:
            log.info("stopped by user")
            break
        except Exception as e:  # keep running; the backend re-evaluates from broker state next minute
            log.exception(f"loop error: {e}")
            time.sleep(5)
    mt5.shutdown()


if __name__ == "__main__":
    run()
