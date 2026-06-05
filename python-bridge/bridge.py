"""
AETHELGARD - MT5 Python Bridge
Runs on your Windows machine. Connects MT5 accounts to the platform.
Install: pip install MetaTrader5 requests python-dotenv schedule
"""

import MetaTrader5 as mt5
import requests
import json
import time
import schedule
import logging
import os
from datetime import datetime, timezone
from dotenv import load_dotenv

load_dotenv()

# ── Configuration ──────────────────────────────────────────────────────────────
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:4000")
BRIDGE_SECRET = os.getenv("BRIDGE_SECRET", "change_this_secret")
SYNC_INTERVAL_SECONDS = int(os.getenv("SYNC_INTERVAL_SECONDS", "30"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL),
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler("aethelgard_bridge.log"),
        logging.StreamHandler()
    ]
)
log = logging.getLogger("AethelgardBridge")

# ── Account Registry ───────────────────────────────────────────────────────────
# Populated dynamically from backend
active_accounts = {}


def api_headers():
    return {
        "Content-Type": "application/json",
        "x-bridge-secret": BRIDGE_SECRET
    }


def fetch_accounts_from_backend():
    """Pull account list from backend API"""
    try:
        r = requests.get(
            f"{BACKEND_URL}/api/bridge/accounts",
            headers=api_headers(),
            timeout=10
        )
        if r.status_code == 200:
            return r.json().get("accounts", [])
        else:
            log.warning(f"Failed to fetch accounts: {r.status_code}")
            return []
    except Exception as e:
        log.error(f"Cannot reach backend: {e}")
        return []


def connect_account(account: dict) -> bool:
    """Initialize MT5 connection for a single account"""
    login = int(account["login"])
    password = account["password"]
    server = account["server"]
    account_id = account["id"]

    if not mt5.initialize():
        log.error(f"MT5 initialize() failed: {mt5.last_error()}")
        return False

    authorized = mt5.login(login, password=password, server=server)
    if not authorized:
        log.error(f"MT5 login failed for {login}@{server}: {mt5.last_error()}")
        report_connection_status(account_id, False)
        return False

    log.info(f"✅ Connected: {login}@{server}")
    active_accounts[account_id] = {
        "login": login,
        "server": server,
        "account_id": account_id
    }
    report_connection_status(account_id, True)
    return True


def report_connection_status(account_id: str, connected: bool):
    """Report connection status back to backend"""
    try:
        requests.post(
            f"{BACKEND_URL}/api/bridge/status",
            headers=api_headers(),
            json={"account_id": account_id, "connected": connected},
            timeout=5
        )
    except Exception as e:
        log.warning(f"Could not report status: {e}")


def get_account_info(login: int) -> dict | None:
    """Get live account metrics from MT5"""
    mt5.login(login)  # ensure correct account active
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


def get_open_positions(login: int) -> list:
    """Get all open positions for an account"""
    mt5.login(login)
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


def get_price(symbol: str) -> dict | None:
    """Get current bid/ask for a symbol"""
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return None
    return {
        "symbol": symbol,
        "bid": tick.bid,
        "ask": tick.ask,
        "spread": round((tick.ask - tick.bid) * 10000, 1),
        "time": datetime.fromtimestamp(tick.time, tz=timezone.utc).isoformat()
    }


def get_ohlcv(symbol: str, timeframe_str: str = "H1", count: int = 100) -> list:
    """Get OHLCV bars for signal generation"""
    tf_map = {
        "M1": mt5.TIMEFRAME_M1,
        "M5": mt5.TIMEFRAME_M5,
        "M15": mt5.TIMEFRAME_M15,
        "M30": mt5.TIMEFRAME_M30,
        "H1": mt5.TIMEFRAME_H1,
        "H4": mt5.TIMEFRAME_H4,
        "D1": mt5.TIMEFRAME_D1,
    }
    tf = tf_map.get(timeframe_str, mt5.TIMEFRAME_H1)
    rates = mt5.copy_rates_from_pos(symbol, tf, 0, count)
    if rates is None:
        return []
    result = []
    for r in rates:
        result.append({
            "time": datetime.fromtimestamp(r["time"], tz=timezone.utc).isoformat(),
            "open": r["open"],
            "high": r["high"],
            "low": r["low"],
            "close": r["close"],
            "volume": int(r["tick_volume"])
        })
    return result


def execute_trade(account_id: str, order: dict) -> dict:
    """Execute a trade order on MT5"""
    account = active_accounts.get(account_id)
    if not account:
        return {"success": False, "error": "Account not connected"}

    symbol = order["symbol"]
    direction = order["direction"]
    volume = float(order["volume"])
    sl = float(order.get("stop_loss", 0))
    tp = float(order.get("take_profit", 0))
    comment = order.get("comment", "Aethelgard")

    # Ensure symbol is selected
    if not mt5.symbol_select(symbol, True):
        return {"success": False, "error": f"Symbol {symbol} not available"}

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return {"success": False, "error": "Cannot get price"}

    order_type = mt5.ORDER_TYPE_BUY if direction == "BUY" else mt5.ORDER_TYPE_SELL
    price = tick.ask if direction == "BUY" else tick.bid

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": order_type,
        "price": price,
        "sl": sl,
        "tp": tp,
        "deviation": 20,
        "magic": 20260101,
        "comment": comment,
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        log.error(f"Trade failed [{symbol} {direction}]: {result.comment}")
        return {
            "success": False,
            "error": result.comment,
            "retcode": result.retcode
        }

    log.info(f"✅ Trade executed: {direction} {volume} {symbol} @ {result.price} | Ticket: {result.order}")
    return {
        "success": True,
        "ticket": result.order,
        "price": result.price,
        "volume": result.volume
    }


def close_trade(account_id: str, ticket: int, symbol: str, direction: str, volume: float) -> dict:
    """Close an open position"""
    account = active_accounts.get(account_id)
    if not account:
        return {"success": False, "error": "Account not connected"}

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return {"success": False, "error": "Cannot get price"}

    close_type = mt5.ORDER_TYPE_SELL if direction == "BUY" else mt5.ORDER_TYPE_BUY
    price = tick.bid if direction == "BUY" else tick.ask

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": close_type,
        "position": ticket,
        "price": price,
        "deviation": 20,
        "magic": 20260101,
        "comment": "Aethelgard Close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {"success": False, "error": result.comment}

    return {"success": True, "ticket": result.order, "price": result.price}


# ── Sync Jobs ─────────────────────────────────────────────────────────────────

def sync_all_accounts():
    """Push account snapshots and open positions to backend"""
    accounts = fetch_accounts_from_backend()
    if not accounts:
        return

    for account in accounts:
        account_id = account["id"]
        login = int(account["login"])

        # Connect if not already
        if account_id not in active_accounts:
            connect_account(account)

        if account_id not in active_accounts:
            continue

        info = get_account_info(login)
        positions = get_open_positions(login)

        if info:
            try:
                requests.post(
                    f"{BACKEND_URL}/api/bridge/sync",
                    headers=api_headers(),
                    json={
                        "account_id": account_id,
                        "account_info": info,
                        "positions": positions,
                        "timestamp": datetime.now(timezone.utc).isoformat()
                    },
                    timeout=10
                )
                log.debug(f"Synced account {account_id}: balance={info['balance']}")
            except Exception as e:
                log.warning(f"Sync failed for {account_id}: {e}")


def poll_backend_commands():
    """Check backend for pending trade commands"""
    try:
        r = requests.get(
            f"{BACKEND_URL}/api/bridge/commands",
            headers=api_headers(),
            timeout=10
        )
        if r.status_code != 200:
            return

        commands = r.json().get("commands", [])
        for cmd in commands:
            cmd_type = cmd.get("type")
            cmd_id = cmd.get("id")

            if cmd_type == "EXECUTE_TRADE":
                result = execute_trade(cmd["account_id"], cmd["order"])
                acknowledge_command(cmd_id, result)

            elif cmd_type == "CLOSE_TRADE":
                result = close_trade(
                    cmd["account_id"],
                    cmd["ticket"],
                    cmd["symbol"],
                    cmd["direction"],
                    cmd["volume"]
                )
                acknowledge_command(cmd_id, result)

            elif cmd_type == "GET_OHLCV":
                bars = get_ohlcv(cmd["symbol"], cmd.get("timeframe", "H1"), cmd.get("count", 100))
                acknowledge_command(cmd_id, {"success": True, "bars": bars})

            elif cmd_type == "GET_PRICE":
                price = get_price(cmd["symbol"])
                acknowledge_command(cmd_id, {"success": True, "price": price})

    except Exception as e:
        log.error(f"Command poll error: {e}")


def acknowledge_command(cmd_id: str, result: dict):
    """Report command execution result back to backend"""
    try:
        requests.post(
            f"{BACKEND_URL}/api/bridge/commands/{cmd_id}/ack",
            headers=api_headers(),
            json=result,
            timeout=5
        )
    except Exception as e:
        log.warning(f"Could not ack command {cmd_id}: {e}")


# ── Main Loop ─────────────────────────────────────────────────────────────────

def main():
    log.info("🚀 Aethelgard MT5 Bridge starting...")

    if not mt5.initialize():
        log.critical(f"MT5 failed to initialize: {mt5.last_error()}")
        log.critical("Make sure MetaTrader 5 is running on this machine.")
        return

    log.info(f"MT5 Version: {mt5.version()}")
    log.info(f"Backend: {BACKEND_URL}")
    log.info(f"Sync interval: {SYNC_INTERVAL_SECONDS}s")

    # Initial sync
    sync_all_accounts()

    # Schedule jobs
    schedule.every(SYNC_INTERVAL_SECONDS).seconds.do(sync_all_accounts)
    schedule.every(5).seconds.do(poll_backend_commands)

    log.info("✅ Bridge running. Press Ctrl+C to stop.")

    try:
        while True:
            schedule.run_pending()
            time.sleep(1)
    except KeyboardInterrupt:
        log.info("Bridge stopped by user.")
    finally:
        mt5.shutdown()
        log.info("MT5 connection closed.")


if __name__ == "__main__":
    main()
