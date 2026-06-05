"""
AETHELGARD MT5 Bridge v4
- All new pairs: US30, SP500, GER40, BTCUSD
- DXY intermarket context
- Auto account detection
- Feedback loop support
"""

import MetaTrader5 as mt5
import requests
import time
import schedule
import logging
import os
import sys
from datetime import datetime, timezone
from dotenv import load_dotenv

load_dotenv()

BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:4000")
BRIDGE_SECRET = os.getenv("BRIDGE_SECRET", "")
SYNC_INTERVAL_SECONDS = int(os.getenv("SYNC_INTERVAL_SECONDS", "30"))
MT5_LOGIN = os.getenv("MT5_LOGIN")
MT5_PASSWORD = os.getenv("MT5_PASSWORD")
MT5_SERVER = os.getenv("MT5_SERVER")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler("aethelgard_bridge.log", encoding="utf-8"),
        logging.StreamHandler(open(sys.stdout.fileno(), mode='w', encoding='utf-8', closefd=False))
    ]
)
log = logging.getLogger("AethelgardBridge")

connected_accounts = {}

# XM symbol mapping - adjust if your broker uses different names
SYMBOL_MAP = {
    "GOLD": "GOLD",
    "EURUSD": "EURUSD",
    "GBPUSD": "GBPUSD",
    "USDJPY": "USDJPY",
    "US30Cash": "US30Cash",
    "SPX500Cash": "SPX500Cash",
    "GER40Cash": "GER40Cash",
    "BTCUSD": "BTCUSD",
    "DXY": "USDX",  # DXY for intermarket context
}

PAIRS = list(SYMBOL_MAP.keys())

TIMEFRAMES = {}

def api_headers():
    return {"Content-Type": "application/json", "x-bridge-secret": BRIDGE_SECRET}

def init_timeframes():
    global TIMEFRAMES
    TIMEFRAMES = {
        "M15": mt5.TIMEFRAME_M15,
        "H1": mt5.TIMEFRAME_H1,
        "H4": mt5.TIMEFRAME_H4,
    }

def verify_symbol(symbol):
    """Check if symbol exists and select it"""
    broker_symbol = SYMBOL_MAP.get(symbol, symbol)
    info = mt5.symbol_info(broker_symbol)
    if info is None:
        # Try common variations
        variations = [
            symbol, f"{symbol}.", f"{symbol}m",
            symbol.replace("Cash", ""),
            symbol.replace("Cash", ".cash"),
        ]
        for var in variations:
            if mt5.symbol_select(var, True):
                info = mt5.symbol_info(var)
                if info:
                    SYMBOL_MAP[symbol] = var
                    log.info(f"Symbol mapped: {symbol} -> {var}")
                    return var
        log.warning(f"Symbol {symbol} not found on this broker")
        return None
    mt5.symbol_select(broker_symbol, True)
    return broker_symbol

def connect_from_env():
    if not MT5_LOGIN or not MT5_PASSWORD:
        return False
    result = mt5.login(int(MT5_LOGIN), password=MT5_PASSWORD, server=MT5_SERVER)
    if not result:
        log.error(f"Login failed: {mt5.last_error()}")
        return False
    account_id = f"env_{MT5_LOGIN}"
    connected_accounts[account_id] = {
        "login": int(MT5_LOGIN), "password": MT5_PASSWORD,
        "server": MT5_SERVER, "account_id": account_id
    }
    log.info(f"Connected: {MT5_LOGIN}@{MT5_SERVER}")
    return True

def fetch_remote_accounts():
    try:
        r = requests.get(f"{BACKEND_URL}/api/bridge/accounts", headers=api_headers(), timeout=10)
        if r.status_code == 200:
            accounts = r.json().get("accounts", [])
            for acc in accounts:
                if MT5_LOGIN and str(acc.get("login")) == str(MT5_LOGIN):
                    acc["password"] = MT5_PASSWORD
                elif not acc.get("password"):
                    acc["password"] = MT5_PASSWORD or ""
            return accounts
        return []
    except Exception as e:
        log.warning(f"Cannot reach backend: {e}")
        return []

def connect_account(acc):
    account_id = acc["id"]
    login = int(acc["login"])
    password = acc.get("password") or MT5_PASSWORD
    server = acc.get("server") or MT5_SERVER
    if not password:
        return False
    result = mt5.login(login, password=password, server=server)
    if not result:
        report_status(account_id, False)
        return False
    connected_accounts[account_id] = {
        "login": login, "password": password,
        "server": server, "account_id": account_id
    }
    report_status(account_id, True)
    log.info(f"Connected: {login}@{server}")
    return True

def refresh_accounts():
    remote = fetch_remote_accounts()
    if not remote:
        if not connected_accounts:
            connect_from_env()
        return
    remote_ids = {acc["id"] for acc in remote}
    for acc in remote:
        if acc["id"] not in connected_accounts:
            log.info(f"New account detected: {acc['login']}")
            connect_account(acc)
    for acc_id in list(connected_accounts.keys()):
        if not acc_id.startswith("env_") and acc_id not in remote_ids:
            del connected_accounts[acc_id]

def report_status(account_id, connected):
    try:
        requests.post(f"{BACKEND_URL}/api/bridge/status", headers=api_headers(),
            json={"account_id": account_id, "connected": connected}, timeout=5)
    except: pass

def get_account_info(login):
    info = mt5.account_info()
    if not info: return None
    return {
        "balance": round(info.balance, 2), "equity": round(info.equity, 2),
        "margin": round(info.margin, 2), "free_margin": round(info.margin_free, 2),
        "profit": round(info.profit, 2), "currency": info.currency,
        "leverage": info.leverage
    }

def get_positions(login):
    positions = mt5.positions_get()
    if not positions: return []
    return [{
        "ticket": p.ticket, "symbol": p.symbol,
        "direction": "BUY" if p.type == 0 else "SELL",
        "volume": p.volume, "open_price": p.price_open,
        "current_price": p.price_current, "stop_loss": p.sl,
        "take_profit": p.tp, "profit": round(p.profit, 2),
        "open_time": datetime.fromtimestamp(p.time, tz=timezone.utc).isoformat(),
    } for p in positions]

def get_ohlcv(symbol, tf_key, count=150):
    broker_symbol = SYMBOL_MAP.get(symbol, symbol)
    tf = TIMEFRAMES.get(tf_key, mt5.TIMEFRAME_H1)
    if not mt5.symbol_select(broker_symbol, True):
        return []
    rates = mt5.copy_rates_from_pos(broker_symbol, tf, 0, count)
    if rates is None: return []
    return [{
        "time": datetime.fromtimestamp(r["time"], tz=timezone.utc).isoformat(),
        "open": float(r["open"]), "high": float(r["high"]),
        "low": float(r["low"]), "close": float(r["close"]),
        "volume": int(r["tick_volume"])
    } for r in rates]

def execute_trade(account_id, order):
    acc = connected_accounts.get(account_id)
    if not acc:
        # Try env account
        env_id = f"env_{MT5_LOGIN}"
        if env_id in connected_accounts:
            acc = connected_accounts[env_id]
        else:
            return {"success": False, "error": "Account not connected"}

    symbol = order["symbol"]
    broker_symbol = SYMBOL_MAP.get(symbol, symbol)
    direction = order["direction"]
    volume = float(order["volume"])
    sl = float(order.get("stop_loss") or 0)
    tp = float(order.get("take_profit") or 0)

    if not mt5.symbol_select(broker_symbol, True):
        return {"success": False, "error": f"Symbol {broker_symbol} not available"}

    tick = mt5.symbol_info_tick(broker_symbol)
    if not tick: return {"success": False, "error": "Cannot get price"}

    # Get symbol info for minimum volume
    sym_info = mt5.symbol_info(broker_symbol)
    if sym_info:
        volume = max(volume, sym_info.volume_min)
        volume = round(volume / sym_info.volume_step) * sym_info.volume_step
        volume = round(volume, 2)

    order_type = mt5.ORDER_TYPE_BUY if direction == "BUY" else mt5.ORDER_TYPE_SELL
    price = tick.ask if direction == "BUY" else tick.bid

    req = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": broker_symbol, "volume": volume, "type": order_type,
        "price": price, "sl": sl, "tp": tp, "deviation": 30,
        "magic": 20260101, "comment": order.get("comment", "Aethelgard"),
        "type_time": mt5.ORDER_TIME_GTC, "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(req)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        log.error(f"Trade failed [{broker_symbol} {direction}]: {result.comment} (retcode: {result.retcode})")
        return {"success": False, "error": result.comment, "retcode": result.retcode}

    log.info(f"Trade: {direction} {volume} {broker_symbol} @ {result.price} | #{result.order}")
    return {"success": True, "ticket": result.order, "price": result.price, "volume": result.volume}

def sync_all():
    for account_id, acc in list(connected_accounts.items()):
        try:
            info = get_account_info(acc["login"])
            if not info: continue
            positions = get_positions(acc["login"])
            requests.post(f"{BACKEND_URL}/api/bridge/sync", headers=api_headers(),
                json={"account_id": account_id, "account_info": info,
                      "positions": positions, "timestamp": datetime.now(timezone.utc).isoformat()},
                timeout=10)
            log.info(f"Synced {acc['login']}: ${info['balance']} | P&L ${info['profit']}")
        except Exception as e:
            log.warning(f"Sync error {account_id}: {e}")

def push_ohlcv():
    """Push OHLCV for all pairs — backend generates signals"""
    available_pairs = []

    # First verify which symbols are available
    for symbol in PAIRS:
        if symbol == "DXY": continue
        broker_sym = verify_symbol(symbol)
        if broker_sym:
            available_pairs.append(symbol)
        else:
            log.warning(f"Skipping {symbol} — not available on this broker")

    log.info(f"Generating signals for: {', '.join(available_pairs)}")

    for symbol in available_pairs:
        try:
            ohlcv_data = {}
            for tf in TIMEFRAMES:
                bars = get_ohlcv(symbol, tf, 150)
                if bars and len(bars) > 50:
                    ohlcv_data[tf] = bars

            if not ohlcv_data:
                log.warning(f"No data for {symbol}")
                continue

            r = requests.post(f"{BACKEND_URL}/api/bridge/ohlcv", headers=api_headers(),
                json={"symbol": symbol, "data": ohlcv_data}, timeout=120)

            if r.status_code == 200:
                res = r.json()
                if res.get("signal"):
                    log.info(f"Signal: {symbol} -> {res['signal']}")
                else:
                    log.info(f"No signal for {symbol} (HOLD)")
            else:
                log.warning(f"OHLCV push failed {symbol}: {r.status_code}")

            time.sleep(3)
        except Exception as e:
            log.error(f"OHLCV error {symbol}: {e}")

def poll_commands():
    try:
        r = requests.get(f"{BACKEND_URL}/api/bridge/commands", headers=api_headers(), timeout=10)
        if r.status_code != 200: return
        for cmd in r.json().get("commands", []):
            if cmd.get("type") == "EXECUTE_TRADE":
                result = execute_trade(cmd["account_id"], cmd["order"])
                result["order"] = cmd["order"]
                try:
                    requests.post(f"{BACKEND_URL}/api/bridge/commands/{cmd['id']}/ack",
                        headers=api_headers(), json=result, timeout=5)
                except: pass
    except Exception as e:
        log.error(f"Command poll: {e}")

def main():
    log.info("Aethelgard MT5 Bridge v4 starting...")
    log.info(f"Pairs: {', '.join(PAIRS)}")

    if not mt5.initialize():
        log.error(f"MT5 init failed: {mt5.last_error()}")
        return

    log.info(f"MT5: {mt5.version()} | Backend: {BACKEND_URL}")
    init_timeframes()

    # Connect accounts
    remote = fetch_remote_accounts()
    if remote:
        for acc in remote:
            connect_account(acc)
    if not connected_accounts:
        connect_from_env()

    if not connected_accounts:
        log.error("No accounts connected")
        mt5.shutdown()
        return

    # Initial sync
    sync_all()

    # Push OHLCV immediately
    log.info("Pushing OHLCV for all pairs...")
    push_ohlcv()

    # Schedule
    schedule.every(SYNC_INTERVAL_SECONDS).seconds.do(sync_all)
    schedule.every(60).seconds.do(refresh_accounts)
    schedule.every(15).minutes.do(push_ohlcv)
    schedule.every(10).seconds.do(poll_commands)

    log.info("Bridge v4 running. Press Ctrl+C to stop.")
    try:
        while True:
            schedule.run_pending()
            time.sleep(1)
    except KeyboardInterrupt:
        log.info("Bridge stopped.")
    finally:
        mt5.shutdown()

if __name__ == "__main__":
    main()
