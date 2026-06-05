"""
AETHELGARD - MT5 Python Bridge v2
Pushes OHLCV data directly to backend for signal generation.
"""

import MetaTrader5 as mt5
import requests
import json
import time
import schedule
import logging
import os
import sys
from datetime import datetime, timezone
from dotenv import load_dotenv

load_dotenv()

BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:4000")
BRIDGE_SECRET = os.getenv("BRIDGE_SECRET", "change_this_secret")
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

active_accounts = {}
PAIRS = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY"]
TIMEFRAMES = {
    "M15": mt5.TIMEFRAME_M15,
    "H1": mt5.TIMEFRAME_H1,
    "H4": mt5.TIMEFRAME_H4,
}

def api_headers():
    return {
        "Content-Type": "application/json",
        "x-bridge-secret": BRIDGE_SECRET
    }

def connect_account(account):
    login = int(account["login"])
    password = account.get("password") or MT5_PASSWORD
    server = account.get("server") or MT5_SERVER
    account_id = account["id"]

    if not mt5.initialize():
        log.error(f"MT5 initialize() failed: {mt5.last_error()}")
        return False

    authorized = mt5.login(login, password=password, server=server)
    if not authorized:
        log.error(f"MT5 login failed for {login}: {mt5.last_error()}")
        report_connection_status(account_id, False)
        return False

    log.info(f"Connected: {login}@{server}")
    active_accounts[account_id] = {"login": login, "server": server, "account_id": account_id}
    report_connection_status(account_id, True)
    return True

def connect_from_env():
    """Connect directly from .env credentials"""
    if not MT5_LOGIN or not MT5_PASSWORD or not MT5_SERVER:
        log.warning("No MT5 credentials in .env file")
        return False

    if not mt5.initialize():
        log.error(f"MT5 initialize() failed: {mt5.last_error()}")
        return False

    authorized = mt5.login(int(MT5_LOGIN), password=MT5_PASSWORD, server=MT5_SERVER)
    if not authorized:
        log.error(f"MT5 login failed: {mt5.last_error()}")
        return False

    log.info(f"Connected: {MT5_LOGIN}@{MT5_SERVER}")
    account_id = f"env_{MT5_LOGIN}"
    active_accounts[account_id] = {"login": int(MT5_LOGIN), "server": MT5_SERVER, "account_id": account_id}
    return True

def report_connection_status(account_id, connected):
    try:
        requests.post(f"{BACKEND_URL}/api/bridge/status", headers=api_headers(),
            json={"account_id": account_id, "connected": connected}, timeout=5)
    except Exception as e:
        log.warning(f"Could not report status: {e}")

def get_account_info():
    info = mt5.account_info()
    if info is None:
        return None
    return {
        "balance": round(info.balance, 2),
        "equity": round(info.equity, 2),
        "margin": round(info.margin, 2),
        "free_margin": round(info.margin_free, 2),
        "profit": round(info.profit, 2),
        "currency": info.currency,
        "leverage": info.leverage
    }

def get_open_positions():
    positions = mt5.positions_get()
    if positions is None:
        return []
    result = []
    for p in positions:
        result.append({
            "ticket": p.ticket,
            "symbol": p.symbol,
            "direction": "BUY" if p.type == 0 else "SELL",
            "volume": p.volume,
            "open_price": p.price_open,
            "current_price": p.price_current,
            "stop_loss": p.sl,
            "take_profit": p.tp,
            "profit": round(p.profit, 2),
            "open_time": datetime.fromtimestamp(p.time, tz=timezone.utc).isoformat(),
            "comment": p.comment
        })
    return result

def get_ohlcv(symbol, timeframe_key, count=100):
    tf = TIMEFRAMES.get(timeframe_key, mt5.TIMEFRAME_H1)
    if not mt5.symbol_select(symbol, True):
        return []
    rates = mt5.copy_rates_from_pos(symbol, tf, 0, count)
    if rates is None:
        return []
    result = []
    for r in rates:
        result.append({
            "time": datetime.fromtimestamp(r["time"], tz=timezone.utc).isoformat(),
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "volume": int(r["tick_volume"])
        })
    return result

def execute_trade(account_id, order):
    symbol = order["symbol"]
    direction = order["direction"]
    volume = float(order["volume"])
    sl = float(order.get("stop_loss") or 0)
    tp = float(order.get("take_profit") or 0)
    comment = order.get("comment", "Aethelgard")

    if not mt5.symbol_select(symbol, True):
        return {"success": False, "error": f"Symbol {symbol} not available"}

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return {"success": False, "error": "Cannot get price"}

    order_type = mt5.ORDER_TYPE_BUY if direction == "BUY" else mt5.ORDER_TYPE_SELL
    price = tick.ask if direction == "BUY" else tick.bid

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol, "volume": volume, "type": order_type,
        "price": price, "sl": sl, "tp": tp, "deviation": 20,
        "magic": 20260101, "comment": comment,
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        log.error(f"Trade failed [{symbol} {direction}]: {result.comment}")
        return {"success": False, "error": result.comment, "retcode": result.retcode}

    log.info(f"Trade executed: {direction} {volume} {symbol} @ {result.price} | Ticket: {result.order}")
    return {"success": True, "ticket": result.order, "price": result.price, "volume": result.volume}

def sync_account(account_id):
    info = get_account_info()
    positions = get_open_positions()
    if not info:
        return

    try:
        requests.post(f"{BACKEND_URL}/api/bridge/sync", headers=api_headers(),
            json={"account_id": account_id, "account_info": info, "positions": positions,
                  "timestamp": datetime.now(timezone.utc).isoformat()}, timeout=10)
        log.info(f"Synced {account_id}: balance=${info['balance']} equity=${info['equity']} profit=${info['profit']}")
    except Exception as e:
        log.warning(f"Sync failed: {e}")

def push_ohlcv_for_signals():
    """Push OHLCV data to backend for each pair — backend generates signals immediately"""
    for symbol in PAIRS:
        try:
            ohlcv_data = {}
            for tf_name in TIMEFRAMES:
                bars = get_ohlcv(symbol, tf_name, 100)
                if bars:
                    ohlcv_data[tf_name] = bars

            if not ohlcv_data:
                log.warning(f"No OHLCV data for {symbol}")
                continue

            r = requests.post(f"{BACKEND_URL}/api/bridge/ohlcv", headers=api_headers(),
                json={"symbol": symbol, "data": ohlcv_data}, timeout=60)

            if r.status_code == 200:
                result = r.json()
                if result.get("signal"):
                    log.info(f"Signal generated for {symbol}: {result['signal']}")
                else:
                    log.info(f"No signal for {symbol} (HOLD or low confidence)")
            else:
                log.warning(f"OHLCV push failed for {symbol}: {r.status_code} {r.text[:100]}")

            time.sleep(3)  # Small delay between pairs

        except Exception as e:
            log.error(f"OHLCV push error for {symbol}: {e}")

def poll_commands():
    """Poll for trade execution commands"""
    try:
        r = requests.get(f"{BACKEND_URL}/api/bridge/commands", headers=api_headers(), timeout=10)
        if r.status_code != 200:
            return
        commands = r.json().get("commands", [])
        for cmd in commands:
            cmd_type = cmd.get("type")
            cmd_id = cmd.get("id")
            if cmd_type == "EXECUTE_TRADE":
                account_id = cmd.get("account_id")
                result = execute_trade(account_id, cmd["order"])
                result["order"] = cmd["order"]
                ack_command(cmd_id, result)
    except Exception as e:
        log.error(f"Command poll error: {e}")

def ack_command(cmd_id, result):
    try:
        requests.post(f"{BACKEND_URL}/api/bridge/commands/{cmd_id}/ack",
            headers=api_headers(), json=result, timeout=5)
    except Exception as e:
        log.warning(f"Could not ack command {cmd_id}: {e}")

def main():
    log.info("Aethelgard MT5 Bridge v2 starting...")

    if not mt5.initialize():
        log.error(f"MT5 failed to initialize: {mt5.last_error()}")
        log.error("Make sure MetaTrader 5 is running on this machine.")
        return

    log.info(f"MT5 Version: {mt5.version()}")
    log.info(f"Backend: {BACKEND_URL}")

    # Connect using .env credentials directly
    if not connect_from_env():
        log.error("Failed to connect MT5 account. Check MT5_LOGIN, MT5_PASSWORD, MT5_SERVER in .env")
        mt5.shutdown()
        return

    account_id = f"env_{MT5_LOGIN}"

    # Initial sync
    sync_account(account_id)

    # Schedule jobs
    schedule.every(SYNC_INTERVAL_SECONDS).seconds.do(sync_account, account_id)
    schedule.every(15).minutes.do(push_ohlcv_for_signals)
    schedule.every(10).seconds.do(poll_commands)

    # Push OHLCV immediately on start
    log.info("Pushing initial OHLCV data for signal generation...")
    push_ohlcv_for_signals()

    log.info("Bridge running. Press Ctrl+C to stop.")

    try:
        while True:
            schedule.run_pending()
            time.sleep(1)
    except KeyboardInterrupt:
        log.info("Bridge stopped.")
    finally:
        mt5.shutdown()
        log.info("MT5 connection closed.")

if __name__ == "__main__":
    main()
