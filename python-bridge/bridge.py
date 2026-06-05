"""
AETHELGARD - MT5 Python Bridge v3
- Auto-detects new accounts without restart
- Push-based OHLCV for signal generation
- No need to restart when accounts are added via dashboard
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

# Track connected accounts
connected_accounts = {}  # account_id -> {login, password, server}
PAIRS = ["GOLD", "EURUSD", "GBPUSD", "USDJPY"]
TIMEFRAMES = {}  # populated after mt5.initialize()

def api_headers():
    return {"Content-Type": "application/json", "x-bridge-secret": BRIDGE_SECRET}

def init_timeframes():
    global TIMEFRAMES
    TIMEFRAMES = {
        "M15": mt5.TIMEFRAME_M15,
        "H1": mt5.TIMEFRAME_H1,
        "H4": mt5.TIMEFRAME_H4,
    }

# ── Account Management ──────────────────────────────────────────────────────

def fetch_remote_accounts():
    """Fetch accounts from backend"""
    try:
        r = requests.get(f"{BACKEND_URL}/api/bridge/accounts", headers=api_headers(), timeout=10)
        if r.status_code == 200:
            accounts = r.json().get("accounts", [])
            # Inject password from env for matching login
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
    """Connect a single MT5 account"""
    account_id = acc["id"]
    login = int(acc["login"])
    password = acc.get("password") or MT5_PASSWORD
    server = acc.get("server") or MT5_SERVER

    if not password:
        log.warning(f"No password for account {login} — skipping")
        return False

    authorized = mt5.login(login, password=password, server=server)
    if not authorized:
        log.error(f"Login failed for {login}@{server}: {mt5.last_error()}")
        report_status(account_id, False)
        return False

    log.info(f"Connected: {login}@{server}")
    connected_accounts[account_id] = {"login": login, "password": password, "server": server, "account_id": account_id}
    report_status(account_id, True)
    return True

def connect_env_account():
    """Connect account from .env as fallback"""
    if not MT5_LOGIN or not MT5_PASSWORD:
        return False
    authorized = mt5.login(int(MT5_LOGIN), password=MT5_PASSWORD, server=MT5_SERVER)
    if not authorized:
        log.error(f"ENV account login failed: {mt5.last_error()}")
        return False
    account_id = f"env_{MT5_LOGIN}"
    log.info(f"ENV account connected: {MT5_LOGIN}@{MT5_SERVER}")
    connected_accounts[account_id] = {"login": int(MT5_LOGIN), "password": MT5_PASSWORD, "server": MT5_SERVER, "account_id": account_id}
    return True

def refresh_accounts():
    """Auto-detect new accounts from backend — runs every 60 seconds"""
    remote = fetch_remote_accounts()
    if not remote:
        # Ensure env account stays connected
        if not connected_accounts:
            connect_env_account()
        return

    remote_ids = {acc["id"] for acc in remote}

    # Connect new accounts
    for acc in remote:
        if acc["id"] not in connected_accounts:
            log.info(f"New account detected: {acc['login']} — connecting...")
            connect_account(acc)

    # Disconnect removed accounts
    for acc_id in list(connected_accounts.keys()):
        if not acc_id.startswith("env_") and acc_id not in remote_ids:
            log.info(f"Account {acc_id} removed from platform")
            del connected_accounts[acc_id]

def report_status(account_id, connected):
    try:
        requests.post(f"{BACKEND_URL}/api/bridge/status", headers=api_headers(),
            json={"account_id": account_id, "connected": connected}, timeout=5)
    except: pass

# ── MT5 Data ────────────────────────────────────────────────────────────────

def get_account_info(login):
    mt5.login(login)
    info = mt5.account_info()
    if not info: return None
    return {
        "balance": round(info.balance, 2),
        "equity": round(info.equity, 2),
        "margin": round(info.margin, 2),
        "free_margin": round(info.margin_free, 2),
        "profit": round(info.profit, 2),
        "currency": info.currency,
        "leverage": info.leverage
    }

def get_positions(login):
    mt5.login(login)
    positions = mt5.positions_get()
    if not positions: return []
    result = []
    for p in positions:
        result.append({
            "ticket": p.ticket, "symbol": p.symbol,
            "direction": "BUY" if p.type == 0 else "SELL",
            "volume": p.volume, "open_price": p.price_open,
            "current_price": p.price_current, "stop_loss": p.sl,
            "take_profit": p.tp, "profit": round(p.profit, 2),
            "open_time": datetime.fromtimestamp(p.time, tz=timezone.utc).isoformat(),
        })
    return result

def get_ohlcv(symbol, tf_key, count=100):
    tf = TIMEFRAMES.get(tf_key, mt5.TIMEFRAME_H1)
    if not mt5.symbol_select(symbol, True): return []
    rates = mt5.copy_rates_from_pos(symbol, tf, 0, count)
    if rates is None: return []
    return [{"time": datetime.fromtimestamp(r["time"], tz=timezone.utc).isoformat(),
             "open": float(r["open"]), "high": float(r["high"]),
             "low": float(r["low"]), "close": float(r["close"]),
             "volume": int(r["tick_volume"])} for r in rates]

def execute_trade(account_id, order):
    acc = connected_accounts.get(account_id)
    if not acc: return {"success": False, "error": "Account not connected"}

    symbol = order["symbol"]
    direction = order["direction"]
    volume = float(order["volume"])
    sl = float(order.get("stop_loss") or 0)
    tp = float(order.get("take_profit") or 0)

    mt5.login(acc["login"], password=acc["password"], server=acc["server"])
    if not mt5.symbol_select(symbol, True):
        return {"success": False, "error": f"Symbol {symbol} not available"}

    tick = mt5.symbol_info_tick(symbol)
    if not tick: return {"success": False, "error": "Cannot get price"}

    order_type = mt5.ORDER_TYPE_BUY if direction == "BUY" else mt5.ORDER_TYPE_SELL
    price = tick.ask if direction == "BUY" else tick.bid

    req = {
        "action": mt5.TRADE_ACTION_DEAL, "symbol": symbol,
        "volume": volume, "type": order_type, "price": price,
        "sl": sl, "tp": tp, "deviation": 20, "magic": 20260101,
        "comment": order.get("comment", "Aethelgard"),
        "type_time": mt5.ORDER_TIME_GTC, "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(req)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {"success": False, "error": result.comment, "retcode": result.retcode}

    log.info(f"Trade: {direction} {volume} {symbol} @ {result.price} | #{result.order}")
    return {"success": True, "ticket": result.order, "price": result.price, "volume": result.volume}

# ── Sync & Signal Push ───────────────────────────────────────────────────────

def sync_all():
    """Sync all connected accounts to backend"""
    for account_id, acc in list(connected_accounts.items()):
        try:
            info = get_account_info(acc["login"])
            if not info: continue
            positions = get_positions(acc["login"])
            requests.post(f"{BACKEND_URL}/api/bridge/sync", headers=api_headers(),
                json={"account_id": account_id, "account_info": info, "positions": positions,
                      "timestamp": datetime.now(timezone.utc).isoformat()}, timeout=10)
            log.info(f"Synced {acc['login']}: ${info['balance']} | equity ${info['equity']} | P&L ${info['profit']}")
        except Exception as e:
            log.warning(f"Sync error for {account_id}: {e}")

def push_ohlcv():
    """Push OHLCV data to backend — triggers Claude signal generation"""
    for symbol in PAIRS:
        try:
            ohlcv_data = {}
            for tf in TIMEFRAMES:
                bars = get_ohlcv(symbol, tf, 100)
                if bars: ohlcv_data[tf] = bars

            if not ohlcv_data:
                log.warning(f"No data for {symbol}")
                continue

            r = requests.post(f"{BACKEND_URL}/api/bridge/ohlcv", headers=api_headers(),
                json={"symbol": symbol, "data": ohlcv_data}, timeout=90)

            if r.status_code == 200:
                res = r.json()
                if res.get("signal"):
                    log.info(f"Signal: {symbol} → {res['signal']}")
                else:
                    log.info(f"No signal for {symbol} (HOLD)")
            else:
                log.warning(f"OHLCV push failed {symbol}: {r.status_code}")

            time.sleep(3)
        except Exception as e:
            log.error(f"OHLCV error {symbol}: {e}")

def poll_commands():
    """Poll for pending trade commands"""
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
        log.error(f"Command poll error: {e}")

# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    log.info("Aethelgard MT5 Bridge v3 starting...")

    if not mt5.initialize():
        log.error(f"MT5 init failed: {mt5.last_error()} — Make sure MetaTrader 5 is running!")
        return

    log.info(f"MT5: {mt5.version()} | Backend: {BACKEND_URL}")
    init_timeframes()

    # Connect accounts
    remote = fetch_remote_accounts()
    if remote:
        for acc in remote:
            connect_account(acc)
    if not connected_accounts:
        connect_env_account()

    if not connected_accounts:
        log.error("No accounts connected. Check credentials in .env")
        mt5.shutdown()
        return

    # Initial sync + signals
    sync_all()
    log.info("Pushing initial OHLCV for signal generation...")
    push_ohlcv()

    # Schedule
    schedule.every(SYNC_INTERVAL_SECONDS).seconds.do(sync_all)
    schedule.every(60).seconds.do(refresh_accounts)   # auto-detect new accounts
    schedule.every(15).minutes.do(push_ohlcv)
    schedule.every(10).seconds.do(poll_commands)

    log.info("Bridge running. Press Ctrl+C to stop.")
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
