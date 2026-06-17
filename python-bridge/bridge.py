"""
AETHELGARD MT5 Bridge v12
python-bridge/bridge.py

v10 → v12:
  1. M5 timeframe added for precision kill zone entry
  2. Per-timeframe bar counts (M5:60, M15:100, H1:150, H4:200)
  3. Signal retry limit (max 3 attempts)
  4. SL minimum distance validation
  5. Copy trading execution
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

SYMBOL_MAP = {
    "GOLD": "GOLD", "EURUSD": "EURUSD", "GBPUSD": "GBPUSD",
    "USDJPY": "USDJPY", "US30Cash": "US30Cash", "GER40Cash": "GER40Cash",
    "BTCUSD": "BTCUSD", "AUDUSD": "AUDUSD", "USDCAD": "USDCAD",
    "USDCHF": "USDCHF", "NZDUSD": "NZDUSD", "GBPJPY": "GBPJPY",
    "EURJPY": "EURJPY",
}

PIP_SIZES = {
    "GOLD": 0.01, "EURUSD": 0.0001, "GBPUSD": 0.0001, "USDJPY": 0.01,
    "US30Cash": 1.0, "GER40Cash": 1.0, "BTCUSD": 1.0,
    "AUDUSD": 0.0001, "USDCAD": 0.0001, "USDCHF": 0.0001,
    "NZDUSD": 0.0001, "GBPJPY": 0.01, "EURJPY": 0.01,
}

MAX_SPREAD_PIPS = {
    "GOLD": 150, "EURUSD": 3, "GBPUSD": 5, "USDJPY": 3,
    "US30Cash": 50, "GER40Cash": 50, "BTCUSD": 300,
    "AUDUSD": 3, "USDCAD": 4, "USDCHF": 4,
    "NZDUSD": 4, "GBPJPY": 8, "EURJPY": 6,
}

PAIRS = list(SYMBOL_MAP.keys())
TIMEFRAMES = {}

# ── Fix 1: Signal retry tracking ─────────────────────────────────────────────
# Prevents infinite retry loops on failed signals (was causing 100+ retries)
_signal_attempts = {}   # signal_id -> attempt count
MAX_SIGNAL_ATTEMPTS = 3

# ── Fix 2: Minimum SL distance per instrument ─────────────────────────────────
# MT5 rejects orders where SL is too close to entry ("Invalid stops")
# These are conservative minimums in price units (not pips)
MIN_SL_DISTANCE = {
    "GOLD":      0.80,   # 80 cents minimum (was 0.50)
    "BTCUSD":  500.0,    # $500 minimum
    "US30Cash": 30.0,    # 30 points minimum (was 5)
    "GER40Cash":20.0,    # 20 points minimum (was 5)
    "EURUSD":   0.0010,  # 10 pips (was 5)
    "GBPUSD":   0.0010,  # 10 pips
    "AUDUSD":   0.0010,  # 10 pips
    "USDCAD":   0.0010,  # 10 pips
    "USDCHF":   0.0010,  # 10 pips
    "NZDUSD":   0.0010,  # 10 pips
    "USDJPY":   0.20,    # 20 pips (JPY pairs need much larger minimums)
    "GBPJPY":   0.50,    # 50 pips (volatile cross — broker requires large stops)
    "EURJPY":   0.30,    # 30 pips
}

# Track which bars already cached to avoid duplicates
_cached_bars = set()

# ── Fix 3: Copy trading client accounts cache ─────────────────────────────────
_client_accounts_cache = []
_client_accounts_last_fetch = 0

def api_headers():
    return {"Content-Type": "application/json", "x-bridge-secret": BRIDGE_SECRET}

def init_timeframes():
    global TIMEFRAMES
    # M5 added for precision kill zone entry (H4 analysis + M5 execution)
    TIMEFRAMES = {
        "M5":  mt5.TIMEFRAME_M5,   # Entry timing (kill zones only)
        "M15": mt5.TIMEFRAME_M15,  # Confirmation
        "H1":  mt5.TIMEFRAME_H1,   # Structure
        "H4":  mt5.TIMEFRAME_H4,   # Primary analysis
    }

def fetch_pair_controls():
    try:
        r = requests.get(f"{BACKEND_URL}/api/pairs/controls", headers=api_headers(), timeout=10)
        if r.status_code == 200:
            data = r.json().get("controls", [])
            return {item["symbol"]: item for item in data}
        return {}
    except:
        return {}

_pair_controls_cache = {}
_pair_controls_last_fetch = 0

def is_pair_enabled(symbol):
    global _pair_controls_cache, _pair_controls_last_fetch
    now = time.time()
    if now - _pair_controls_last_fetch > 60:
        _pair_controls_cache = fetch_pair_controls()
        _pair_controls_last_fetch = now
    ctrl = _pair_controls_cache.get(symbol)
    if ctrl is None:
        return True
    if not ctrl.get("enabled", True):
        log.info(f"{symbol}: HALTED (manually disabled)")
        return False
    if ctrl.get("auto_halted", False):
        log.info(f"{symbol}: AUTO-HALTED — {ctrl.get('auto_halt_reason', '')}")
        return False
    return True

def verify_symbol(symbol):
    broker_symbol = SYMBOL_MAP.get(symbol, symbol)
    if not mt5.symbol_select(broker_symbol, True):
        variations = [symbol, f"{symbol}.", symbol.replace("Cash", ""), f"{symbol}m"]
        for var in variations:
            if mt5.symbol_select(var, True):
                info = mt5.symbol_info(var)
                if info:
                    SYMBOL_MAP[symbol] = var
                    log.info(f"Symbol mapped: {symbol} -> {var}")
                    return var
        log.warning(f"Symbol {symbol} not available on this broker")
        return None
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
            connect_account(acc)
    for acc_id in list(connected_accounts.keys()):
        if not acc_id.startswith("env_") and acc_id not in remote_ids:
            del connected_accounts[acc_id]

def report_status(account_id, connected):
    try:
        requests.post(f"{BACKEND_URL}/api/bridge/status", headers=api_headers(),
            json={"account_id": account_id, "connected": connected}, timeout=5)
    except:
        pass

def get_account_info(login):
    info = mt5.account_info()
    if not info:
        return None
    return {
        "balance": round(info.balance, 2), "equity": round(info.equity, 2),
        "margin": round(info.margin, 2), "free_margin": round(info.margin_free, 2),
        "profit": round(info.profit, 2), "currency": info.currency, "leverage": info.leverage
    }

def get_positions(login):
    positions = mt5.positions_get()
    if not positions:
        return []
    return [{
        "ticket": p.ticket, "symbol": p.symbol,
        "direction": "BUY" if p.type == 0 else "SELL",
        "volume": p.volume, "open_price": p.price_open,
        "current_price": p.price_current, "stop_loss": p.sl,
        "take_profit": p.tp, "profit": round(p.profit, 2),
        "open_time": datetime.fromtimestamp(p.time, tz=timezone.utc).isoformat(),
    } for p in positions]

def get_spread(symbol):
    broker_symbol = SYMBOL_MAP.get(symbol, symbol)
    tick = mt5.symbol_info_tick(broker_symbol)
    if not tick:
        return None
    pip = PIP_SIZES.get(symbol, 0.0001)
    return round((tick.ask - tick.bid) / pip, 1)

def check_spread_ok(symbol):
    spread = get_spread(symbol)
    if spread is None:
        return True, 0
    max_spread = MAX_SPREAD_PIPS.get(symbol, 10)
    return spread <= max_spread, spread

def get_ohlcv(symbol, tf_key, count=150):
    broker_symbol = SYMBOL_MAP.get(symbol, symbol)
    tf = TIMEFRAMES.get(tf_key, mt5.TIMEFRAME_H1)
    if not mt5.symbol_select(broker_symbol, True):
        return []
    rates = mt5.copy_rates_from_pos(broker_symbol, tf, 0, count)
    if rates is None:
        return []
    return [{
        "time": datetime.fromtimestamp(r["time"], tz=timezone.utc).isoformat(),
        "open": float(r["open"]), "high": float(r["high"]),
        "low": float(r["low"]), "close": float(r["close"]),
        "volume": int(r["tick_volume"])
    } for r in rates]

def cache_ohlcv_for_backtest(symbol, tf_key, bars):
    """Save OHLCV bars to backend for backtesting storage"""
    if not bars or len(bars) < 2:
        return
    try:
        # Only send new bars not yet cached
        new_bars = []
        for bar in bars:
            cache_key = f"{symbol}_{tf_key}_{bar['time']}"
            if cache_key not in _cached_bars:
                new_bars.append(bar)
                _cached_bars.add(cache_key)

        if not new_bars:
            return

        r = requests.post(
            f"{BACKEND_URL}/api/backtest/cache",
            headers=api_headers(),
            json={"symbol": symbol, "timeframe": tf_key, "bars": new_bars},
            timeout=30
        )
        if r.status_code == 200:
            log.info(f"Cached {len(new_bars)} new {symbol} {tf_key} bars for backtesting")
    except Exception as e:
        log.warning(f"OHLCV cache error {symbol}: {e}")

def calc_atr(symbol, period=14):
    broker_symbol = SYMBOL_MAP.get(symbol, symbol)
    rates = mt5.copy_rates_from_pos(broker_symbol, mt5.TIMEFRAME_H1, 0, period + 2)
    if rates is None or len(rates) < period + 1:
        return None
    tr = [max(rates[i]["high"] - rates[i]["low"],
              abs(rates[i]["high"] - rates[i-1]["close"]),
              abs(rates[i]["low"] - rates[i-1]["close"]))
          for i in range(1, len(rates))]
    return sum(tr[-period:]) / period

def validate_sl_distance(symbol, direction, price, sl):
    """
    Fix 2: Validate SL is far enough from entry price.
    Returns (is_valid, corrected_sl).
    If SL too close, adjusts it to minimum distance instead of rejecting.
    """
    if sl == 0:
        return True, 0  # No SL set — let MT5 handle it

    min_dist = MIN_SL_DISTANCE.get(symbol, 0.0005)
    actual_dist = abs(price - sl)

    if actual_dist < min_dist:
        log.warning(f"{symbol}: SL distance {actual_dist:.5f} < minimum {min_dist:.5f} — adjusting")
        if direction == "BUY":
            corrected_sl = price - min_dist
        else:
            corrected_sl = price + min_dist
        return False, round(corrected_sl, 5)

    return True, sl


def fetch_client_accounts():
    """Fix 3: Get active copy trading client accounts from backend."""
    global _client_accounts_cache, _client_accounts_last_fetch
    now = time.time()
    if now - _client_accounts_last_fetch < 60:
        return _client_accounts_cache
    try:
        r = requests.get(
            f"{BACKEND_URL}/api/copy-trading/bridge/accounts",
            headers=api_headers(), timeout=10
        )
        if r.status_code == 200:
            _client_accounts_cache = r.json().get("accounts", [])
            _client_accounts_last_fetch = now
            log.info(f"Copy trading: {len(_client_accounts_cache)} client accounts loaded")
    except Exception as e:
        log.warning(f"Cannot fetch client accounts: {e}")
    return _client_accounts_cache


def execute_copy_trade(client, order, master_price, master_balance, master_ticket, signal_id):
    """Fix 3: Execute a scaled copy trade on a client MT5 account."""
    try:
        client_login = int(client["mt5_login"])
        client_password = client["mt5_password"]
        client_server = client["mt5_server"]
        client_balance = float(client.get("balance") or 1000)
        client_risk_pct = float(client.get("risk_percent") or 1.0)

        # Scale lot size proportionally to client balance
        master_lot = float(order["volume"])
        if master_balance and master_balance > 0:
            balance_ratio = client_balance / master_balance
            risk_ratio = client_risk_pct / 1.0
            client_lot = max(0.01, round(master_lot * balance_ratio * risk_ratio, 2))
        else:
            client_lot = 0.01

        # Login to client account
        if not mt5.login(client_login, password=client_password, server=client_server):
            log.warning(f"Copy trade: cannot login to client {client['name']} ({client_login})")
            return

        symbol = order["symbol"]
        broker_symbol = SYMBOL_MAP.get(symbol, symbol)
        direction = order["direction"]

        tick = mt5.symbol_info_tick(broker_symbol)
        if not tick:
            log.warning(f"Copy trade: no tick for {symbol} on client {client['name']}")
            return

        price = tick.ask if direction == "BUY" else tick.bid

        # Scale SL/TP proportionally
        sl = float(order.get("stop_loss") or 0)
        tp = float(order.get("take_profit") or 0)

        # Validate SL distance for client account
        sl_valid, sl = validate_sl_distance(symbol, direction, price, sl)

        sym_info = mt5.symbol_info(broker_symbol)
        if sym_info:
            client_lot = max(client_lot, sym_info.volume_min)
            client_lot = round(round(client_lot / sym_info.volume_step) * sym_info.volume_step, 2)

        order_type = mt5.ORDER_TYPE_BUY if direction == "BUY" else mt5.ORDER_TYPE_SELL
        req = {
            "action": mt5.TRADE_ACTION_DEAL, "symbol": broker_symbol,
            "volume": client_lot, "type": order_type, "price": price,
            "sl": sl, "tp": tp, "deviation": 30, "magic": 20260102,
            "comment": "Aethelgard_Copy",
            "type_time": mt5.ORDER_TIME_GTC, "type_filling": mt5.ORDER_FILLING_IOC
        }

        result = mt5.order_send(req)
        if result.retcode == mt5.TRADE_RETCODE_DONE:
            log.info(f"Copy trade: {direction} {client_lot} {symbol} -> {client['name']} #{result.order}")
            # Report to backend
            try:
                requests.post(f"{BACKEND_URL}/api/copy-trading/bridge/execute",
                    headers=api_headers(), timeout=5,
                    json={
                        "client_id": client["id"],
                        "master_signal_id": signal_id,
                        "master_ticket": master_ticket,
                        "client_ticket": result.order,
                        "symbol": symbol, "direction": direction,
                        "lot_size": client_lot, "open_price": result.price,
                        "stop_loss": sl, "take_profit": tp,
                    })
            except Exception as e:
                log.warning(f"Copy trade report failed: {e}")
        else:
            log.warning(f"Copy trade failed for {client['name']}: {result.comment}")

    except Exception as e:
        log.error(f"Copy trade error for {client.get('name','?')}: {e}")
    finally:
        # Re-login to master account after copy trade
        if MT5_LOGIN and MT5_PASSWORD:
            mt5.login(int(MT5_LOGIN), password=MT5_PASSWORD, server=MT5_SERVER)


def execute_trade(account_id, order):
    acc = connected_accounts.get(account_id) or connected_accounts.get(f"env_{MT5_LOGIN}")
    if not acc:
        return {"success": False, "error": "Account not connected"}

    symbol = order["symbol"]
    signal_id = order.get("signal_id", "unknown")

    # ── Fix 1: Retry limit check ──────────────────────────────────────────────
    attempts = _signal_attempts.get(signal_id, 0)
    if attempts >= MAX_SIGNAL_ATTEMPTS:
        log.warning(f"{symbol}: Signal {signal_id} hit max {MAX_SIGNAL_ATTEMPTS} attempts — expiring")
        _signal_attempts.pop(signal_id, None)
        # Expire the signal in the database
        try:
            requests.post(f"{BACKEND_URL}/api/signals/{signal_id}/expire",
                headers=api_headers(), timeout=5)
        except:
            pass
        return {"success": False, "error": f"Max attempts ({MAX_SIGNAL_ATTEMPTS}) reached — signal expired"}

    _signal_attempts[signal_id] = attempts + 1
    log.info(f"{symbol}: Attempt {attempts + 1}/{MAX_SIGNAL_ATTEMPTS} for signal {signal_id}")

    if not is_pair_enabled(symbol):
        _signal_attempts.pop(signal_id, None)
        return {"success": False, "error": f"{symbol} is halted"}

    broker_symbol = SYMBOL_MAP.get(symbol, symbol)
    direction = order["direction"]
    volume = float(order["volume"])
    sl = float(order.get("stop_loss") or 0)
    tp = float(order.get("take_profit") or 0)

    spread_ok, spread = check_spread_ok(symbol)
    if not spread_ok:
        log.warning(f"Spread too wide for {symbol}: {spread} pips — skipping")
        return {"success": False, "error": f"Spread too wide: {spread} pips"}

    if not mt5.symbol_select(broker_symbol, True):
        return {"success": False, "error": f"Symbol {broker_symbol} not available"}

    tick = mt5.symbol_info_tick(broker_symbol)
    if not tick:
        return {"success": False, "error": "Cannot get price"}

    sym_info = mt5.symbol_info(broker_symbol)
    if sym_info:
        volume = max(volume, sym_info.volume_min)
        volume = round(round(volume / sym_info.volume_step) * sym_info.volume_step, 2)

    order_type = mt5.ORDER_TYPE_BUY if direction == "BUY" else mt5.ORDER_TYPE_SELL
    price = tick.ask if direction == "BUY" else tick.bid

    # ── Fix 2: Validate and correct SL distance before sending ───────────────
    sl_valid, sl = validate_sl_distance(symbol, direction, price, sl)
    if not sl_valid:
        log.info(f"{symbol}: SL corrected to {sl:.5f} (was too close to entry {price:.5f})")

    # Also validate TP is on the correct side
    if tp > 0:
        if direction == "BUY" and tp <= price:
            tp = price + abs(price - sl) * 2.0
            log.warning(f"{symbol}: TP was below entry for BUY — corrected to {tp:.5f}")
        elif direction == "SELL" and tp >= price:
            tp = price - abs(price - sl) * 2.0
            log.warning(f"{symbol}: TP was above entry for SELL — corrected to {tp:.5f}")

    req = {
        "action": mt5.TRADE_ACTION_DEAL, "symbol": broker_symbol,
        "volume": volume, "type": order_type, "price": price,
        "sl": sl, "tp": tp, "deviation": 30, "magic": 20260101,
        "comment": order.get("comment", "Aethelgard"),
        "type_time": mt5.ORDER_TIME_GTC, "type_filling": mt5.ORDER_FILLING_IOC
    }

    result = mt5.order_send(req)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        log.error(f"Trade failed [{broker_symbol} {direction}]: {result.comment}")
        return {"success": False, "error": result.comment, "retcode": result.retcode}

    # ── Success: clear retry counter ──────────────────────────────────────────
    _signal_attempts.pop(signal_id, None)

    log.info(f"✅ Trade: {direction} {volume} {broker_symbol} @ {result.price} | #{result.order} | Spread:{spread}pips")

    # ── Fix 3: Dispatch copy trades to all client accounts ────────────────────
    master_info = mt5.account_info()
    master_balance = master_info.balance if master_info else None
    client_accounts = fetch_client_accounts()

    if client_accounts:
        log.info(f"Dispatching copy trades to {len(client_accounts)} client accounts...")
        for client in client_accounts:
            execute_copy_trade(client, order, master_balance, None, result.order, signal_id)

    return {"success": True, "ticket": result.order, "price": result.price, "volume": result.volume}

def modify_sl(ticket, symbol, new_sl, new_tp=None):
    broker_symbol = SYMBOL_MAP.get(symbol, symbol)
    positions = mt5.positions_get(ticket=ticket)
    if not positions:
        return {"success": False, "error": "Position not found"}
    pos = positions[0]
    req = {
        "action": mt5.TRADE_ACTION_SLTP, "symbol": broker_symbol,
        "position": ticket, "sl": new_sl, "tp": new_tp if new_tp else pos.tp
    }
    result = mt5.order_send(req)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {"success": False, "error": result.comment}
    return {"success": True}

def partial_close(ticket, symbol, vol_to_close, direction):
    broker_symbol = SYMBOL_MAP.get(symbol, symbol)
    tick = mt5.symbol_info_tick(broker_symbol)
    if not tick:
        return {"success": False, "error": "Cannot get price"}
    close_type = mt5.ORDER_TYPE_SELL if direction == "BUY" else mt5.ORDER_TYPE_BUY
    price = tick.bid if direction == "BUY" else tick.ask
    req = {
        "action": mt5.TRADE_ACTION_DEAL, "symbol": broker_symbol,
        "volume": round(vol_to_close, 2), "type": close_type, "position": ticket,
        "price": price, "deviation": 30, "magic": 20260101,
        "comment": "Aethelgard_PartialClose",
        "type_time": mt5.ORDER_TIME_GTC, "type_filling": mt5.ORDER_FILLING_IOC
    }
    result = mt5.order_send(req)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {"success": False, "error": result.comment}
    log.info(f"Partial close: {vol_to_close} {broker_symbol} @ {result.price}")
    return {"success": True, "price": result.price}

def manage_open_trades():
    positions = mt5.positions_get()
    if not positions:
        return
    for pos in positions:
        try:
            symbol = pos.symbol
            orig = next((k for k, v in SYMBOL_MAP.items() if v == symbol), symbol)
            pip = PIP_SIZES.get(orig, 0.0001)
            direction = "BUY" if pos.type == 0 else "SELL"
            price = pos.price_current
            open_price = pos.price_open
            current_sl = pos.sl
            profit_pips = (price - open_price) / pip if direction == "BUY" else (open_price - price) / pip
            atr_val = calc_atr(orig)
            if not atr_val:
                continue

            if profit_pips >= 10:
                be = open_price + pip * 3 if direction == "BUY" else open_price - pip * 3
                needs_update = (direction == "BUY" and be > (current_sl or 0)) or \
                               (direction == "SELL" and (current_sl == 0 or be < current_sl))
                if needs_update:
                    res = modify_sl(pos.ticket, orig, be)
                    if res["success"]:
                        log.info(f"Break-even: #{pos.ticket} {orig} SL->{be:.5f} (profit: {profit_pips:.1f}pips)")

            if profit_pips >= 15:
                trail = atr_val * 1.5
                if direction == "BUY":
                    new_sl = price - trail
                    if new_sl > (current_sl or 0):
                        res = modify_sl(pos.ticket, orig, new_sl)
                        if res["success"]:
                            log.info(f"Trail SL: #{pos.ticket} ->{new_sl:.5f}")
                else:
                    new_sl = price + trail
                    if current_sl == 0 or new_sl < current_sl:
                        res = modify_sl(pos.ticket, orig, new_sl)
                        if res["success"]:
                            log.info(f"Trail SL: #{pos.ticket} ->{new_sl:.5f}")
        except Exception as e:
            log.error(f"Trade management #{pos.ticket}: {e}")

def sync_all():
    for account_id, acc in list(connected_accounts.items()):
        try:
            info = get_account_info(acc["login"])
            if not info:
                continue
            positions = get_positions(acc["login"])
            requests.post(f"{BACKEND_URL}/api/bridge/sync", headers=api_headers(),
                json={"account_id": account_id, "account_info": info,
                      "positions": positions,
                      "timestamp": datetime.now(timezone.utc).isoformat()},
                timeout=10)
            log.info(f"Synced {acc['login']}: ${info['balance']} | P&L ${info['profit']}")
        except Exception as e:
            log.warning(f"Sync error {account_id}: {e}")

def push_ohlcv():
    available = []
    for symbol in PAIRS:
        broker_sym = verify_symbol(symbol)
        if broker_sym:
            available.append(symbol)

    log.info(f"Signal generation for {len(available)} pairs: {', '.join(available)}")

    # ── Warm-up ping — wakes Render before signal cycle ──────────────────────
    # /ping is a public no-auth endpoint that always returns instantly
    # This wakes Render from free-tier sleep before we start the 13-pair cycle
    for attempt in range(3):
        try:
            ping_r = requests.get(f"{BACKEND_URL}/ping",
                headers={"Content-Type": "application/json"}, timeout=60)
            if ping_r.status_code == 200:
                log.info(f"Backend warm (attempt {attempt+1}) — starting signal cycle")
                break
            else:
                log.warning(f"Backend ping attempt {attempt+1}: status {ping_r.status_code}")
        except Exception as e:
            log.warning(f"Backend ping attempt {attempt+1} failed: {e}")
            if attempt < 2:
                time.sleep(5)  # wait 5s then retry

    for symbol in available:
        try:
            if not is_pair_enabled(symbol):
                continue

            spread_ok, spread = check_spread_ok(symbol)
            if not spread_ok:
                log.info(f"Skipping {symbol} — spread: {spread} pips")
                continue

            ohlcv_data = {}
            # Bar counts per timeframe:
            # M5:  60 bars = 5 hours  (kill zone entry precision)
            # M15: 100 bars = 25 hours (confirmation)
            # H1:  150 bars = 6 days  (structure)
            # H4:  200 bars = 33 days (primary analysis + ICT sequence)
            bar_counts = {"M5": 60, "M15": 100, "H1": 150, "H4": 200}
            for tf in TIMEFRAMES:
                bars = get_ohlcv(symbol, tf, bar_counts.get(tf, 150))
                min_bars = 10 if tf == "M5" else 50
                if bars and len(bars) > min_bars:
                    ohlcv_data[tf] = bars
                    # Cache H4 for backtesting only
                    if tf == "H4":
                        cache_ohlcv_for_backtest(symbol, tf, bars)

            if not ohlcv_data:
                log.warning(f"No data for {symbol}")
                continue

            r = requests.post(f"{BACKEND_URL}/api/bridge/ohlcv", headers=api_headers(),
                json={"symbol": symbol, "data": ohlcv_data, "spread": spread},
                timeout=120)

            if r.status_code == 200:
                res = r.json()
                if res.get("signal"):
                    log.info(f"Signal: {symbol} -> {res['signal']}")
                else:
                    log.info(f"No signal: {symbol} (HOLD)")
            else:
                log.warning(f"OHLCV push failed {symbol}: {r.status_code}")

            time.sleep(0.5)  # reduced from 2s — backend stays warm between pairs

        except requests.exceptions.Timeout:
            log.warning(f"OHLCV timeout {symbol} — Render may have slept, continuing")
        except Exception as e:
            log.error(f"OHLCV error {symbol}: {e}")

def poll_commands():
    try:
        r = requests.get(f"{BACKEND_URL}/api/bridge/commands", headers=api_headers(), timeout=10)
        if r.status_code != 200:
            return
        for cmd in r.json().get("commands", []):
            cmd_type = cmd.get("type")
            if cmd_type == "EXECUTE_TRADE":
                order = cmd["order"]
                # Fix: inject signal_id into order so execute_trade can track retries correctly
                order["signal_id"] = cmd.get("signal_id") or cmd.get("id", "unknown")
                result = execute_trade(cmd["account_id"], order)
                result["order"] = order
            elif cmd_type == "MODIFY_SL":
                result = modify_sl(cmd["ticket"], cmd["symbol"], cmd["new_sl"], cmd.get("new_tp"))
            elif cmd_type == "PARTIAL_CLOSE":
                result = partial_close(cmd["ticket"], cmd["symbol"], cmd["volume"], cmd["direction"])
            else:
                continue
            try:
                requests.post(f"{BACKEND_URL}/api/bridge/commands/{cmd['id']}/ack",
                    headers=api_headers(), json=result, timeout=5)
            except:
                pass
    except Exception as e:
        log.error(f"Command poll: {e}")

def main():
    log.info("Aethelgard MT5 Bridge v12 starting...")
    log.info(f"Pairs: {', '.join(PAIRS)}")
    log.info("Features: M5 entry | H4 analysis | Retry limit | SL validation | Copy trading | BE@10pips | Trail@15pips")

    if not mt5.initialize():
        log.error(f"MT5 init failed: {mt5.last_error()}")
        return

    log.info(f"MT5: {mt5.version()} | Backend: {BACKEND_URL}")
    init_timeframes()

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

    sync_all()
    log.info("Pushing initial OHLCV for all pairs...")
    push_ohlcv()

    schedule.every(SYNC_INTERVAL_SECONDS).seconds.do(sync_all)
    schedule.every(30).seconds.do(manage_open_trades)
    schedule.every(60).seconds.do(refresh_accounts)
    schedule.every(10).seconds.do(poll_commands)

    # Read signal interval from Supabase — respects dashboard setting
    try:
        r = requests.get(f"{BACKEND_URL}/api/system/signal-interval",
            headers=api_headers(), timeout=10)
        if r.status_code == 200:
            interval_minutes = r.json().get("interval_minutes", 15)
        else:
            interval_minutes = 15
    except:
        interval_minutes = 15

    log.info(f"Signal interval: every {interval_minutes} minutes (from dashboard setting)")
    schedule.every(interval_minutes).minutes.do(push_ohlcv)

    log.info("Bridge v12 running. Ctrl+C to stop.")
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
