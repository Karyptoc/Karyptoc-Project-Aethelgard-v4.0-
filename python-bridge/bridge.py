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
from datetime import datetime, timezone, timedelta
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
_signal_blacklist = set()  # signal_ids permanently blocked after max attempts
_original_sl_cache = {}  # ticket -> original SL at open (for accurate R calculation)
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
    # FIX: D1 and W1 added — signalEngine.js's getHTFBias() and getADRStatus()
    # expect these and silently degrade to H4-only bias / permanently-open
    # ADR exhaustion checks without them. This was never wired up before.
    TIMEFRAMES = {
        "M5":  mt5.TIMEFRAME_M5,   # Entry timing (kill zones only)
        "M15": mt5.TIMEFRAME_M15,  # Confirmation
        "H1":  mt5.TIMEFRAME_H1,   # Structure
        "H4":  mt5.TIMEFRAME_H4,   # Primary analysis
        "D1":  mt5.TIMEFRAME_D1,   # HTF bias + ADR calculation
        "W1":  mt5.TIMEFRAME_W1,   # HTF bias (weekly alignment)
    }

def fetch_pair_controls():
    try:
        r = requests.get(f"{BACKEND_URL}/api/pairs/controls", headers=api_headers(), timeout=30)
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
        r = requests.get(f"{BACKEND_URL}/api/bridge/accounts", headers=api_headers(), timeout=30)
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

    # ── Retry limit + permanent blacklist ────────────────────────────────────
    # Once a signal hits max attempts it goes into _signal_blacklist so it
    # can never re-queue even if _signal_attempts is reset or the bridge restarts.
    # Without this, clearing _signal_attempts on expiry allowed infinite loops.
    if signal_id in _signal_blacklist:
        return {"success": False, "error": f"Signal {signal_id[:8]} is blacklisted — already expired"}

    attempts = _signal_attempts.get(signal_id, 0)
    if attempts >= MAX_SIGNAL_ATTEMPTS:
        log.warning(f"{symbol}: Signal {signal_id} hit max {MAX_SIGNAL_ATTEMPTS} attempts — expiring")
        _signal_blacklist.add(signal_id)   # permanent block — survives attempt counter reset
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

    # ── Determine execution type: MARKET, LIMIT, or STOP ────────────────────
    # Signal engine sends order_type = MARKET / BUY_LIMIT / SELL_LIMIT / BUY_STOP / SELL_STOP
    signal_order_type = order.get("order_type", "MARKET").upper()
    pending_price     = order.get("pending_price")
    market_price      = tick.ask if direction == "BUY" else tick.bid

    # ── Stale pending order guard ─────────────────────────────────────────────
    # Thresholds per instrument type — tighter for forex, wider for crypto/indices
    STALE_PCT = {
        "BTCUSD": 1.0,     # BTC: 1% = ~$627 at current levels — still a valid zone
        "US30Cash": 0.5,   # US30: 0.5% = ~$258
        "GER40Cash": 0.5,
        "GOLD": 0.8,       # Gold: 0.8% = ~$33
    }
    max_pct = STALE_PCT.get(symbol, 0.5)  # forex: 0.5% default

    if pending_price and signal_order_type != "MARKET":
        pct_away = abs(float(pending_price) - market_price) / market_price * 100
        if pct_away > max_pct:
            log.warning(f"{symbol}: Pending {pending_price:.5f} is {pct_away:.1f}% from market {market_price:.5f} (max {max_pct}%) — stale, skipping")
            _signal_blacklist.add(signal_id)  # blacklist stale pending so it never re-queues
            return {"success": False, "error": f"Pending price {pct_away:.1f}% from market — stale signal"}

    mt5_action     = mt5.TRADE_ACTION_DEAL
    mt5_order_type = mt5.ORDER_TYPE_BUY if direction == "BUY" else mt5.ORDER_TYPE_SELL
    exec_price     = market_price
    expiry         = None

    # ── Pending order time mode ───────────────────────────────────────────────
    # Using ORDER_TIME_DAY: order stays active until end of current trading day.
    # This avoids all datetime timezone issues (naive vs aware) on Windows MT5.
    # No expiry datetime field needed — MT5 handles end-of-day cancellation.
    expiry_dt = None  # not used with ORDER_TIME_DAY

    if signal_order_type == "BUY_LIMIT" and pending_price:
        if float(pending_price) < market_price:
            mt5_action     = mt5.TRADE_ACTION_PENDING
            mt5_order_type = mt5.ORDER_TYPE_BUY_LIMIT
            exec_price     = float(pending_price)
            expiry         = expiry_dt
            log.info(f"{symbol}: BUY LIMIT @ {exec_price:.5f} (market={market_price:.5f}, expires 4h)")
        else:
            log.info(f"{symbol}: BUY_LIMIT {pending_price} >= market — falling back to MARKET")

    elif signal_order_type == "SELL_LIMIT" and pending_price:
        if float(pending_price) > market_price:
            mt5_action     = mt5.TRADE_ACTION_PENDING
            mt5_order_type = mt5.ORDER_TYPE_SELL_LIMIT
            exec_price     = float(pending_price)
            expiry         = expiry_dt
            log.info(f"{symbol}: SELL LIMIT @ {exec_price:.5f} (market={market_price:.5f}, expires 4h)")
        else:
            log.info(f"{symbol}: SELL_LIMIT {pending_price} <= market — falling back to MARKET")

    elif signal_order_type == "BUY_STOP" and pending_price:
        if float(pending_price) > market_price:
            mt5_action     = mt5.TRADE_ACTION_PENDING
            mt5_order_type = mt5.ORDER_TYPE_BUY_STOP
            exec_price     = float(pending_price)
            expiry         = expiry_dt
            log.info(f"{symbol}: BUY STOP @ {exec_price:.5f} (market={market_price:.5f}, expires 4h)")
        else:
            log.info(f"{symbol}: BUY_STOP {pending_price} <= market — falling back to MARKET")

    elif signal_order_type == "SELL_STOP" and pending_price:
        if float(pending_price) < market_price:
            mt5_action     = mt5.TRADE_ACTION_PENDING
            mt5_order_type = mt5.ORDER_TYPE_SELL_STOP
            exec_price     = float(pending_price)
            expiry         = expiry_dt
            log.info(f"{symbol}: SELL STOP @ {exec_price:.5f} (market={market_price:.5f}, expires 4h)")
        else:
            log.info(f"{symbol}: SELL_STOP {pending_price} >= market — falling back to MARKET")

    else:
        log.info(f"{symbol}: MARKET {direction} @ {market_price:.5f}")

    price = exec_price

    # ── Validate SL distance ──────────────────────────────────────────────────
    sl_valid, sl = validate_sl_distance(symbol, direction, price, sl)
    if not sl_valid:
        log.info(f"{symbol}: SL corrected to {sl:.5f} (was too close to {price:.5f})")

    if tp > 0:
        if direction == "BUY" and tp <= price:
            tp = price + abs(price - sl) * 2.0
            log.warning(f"{symbol}: TP below entry for BUY — corrected to {tp:.5f}")
        elif direction == "SELL" and tp >= price:
            tp = price - abs(price - sl) * 2.0
            log.warning(f"{symbol}: TP above entry for SELL — corrected to {tp:.5f}")

    # ── Hard magnitude sanity check (independent of the backend) ─────────────
    # FIX: the backend was found sending SL/TP hundreds of pips from live
    # price for some EURUSD/USDCAD/USDCHF signals (all showing IDENTICAL
    # SL/TP regardless of actual entry - traced to signalCore.js, fixed
    # there). The direction-only check above would "fix" these to still be
    # on the correct side, but the distance stayed just as huge either way.
    # This is a second, independent layer here in the bridge itself: a hard
    # per-instrument pip ceiling that refuses to place ANY order whose SL/TP
    # is absurdly far from live price, regardless of what the backend sent
    # or whether a future regression reintroduces a similar bug upstream.
    # FIX: same pip-scale mismatch as the backend's copy of this table -
    # GOLD/BTCUSD ceilings were far too tight because they didn't account
    # for their non-standard pip_size. See signalCore.js for the full
    # explanation and the live-log evidence that confirmed this.
    MAX_SANE_PIPS = {
        "GOLD": 15000, "BTCUSD": 8000, "US30Cash": 1500, "GER40Cash": 1000,
        "GBPJPY": 300, "EURJPY": 300, "USDJPY": 150,
    }
    max_sane = MAX_SANE_PIPS.get(symbol, 150)  # forex majors default: 150 pips
    pip = PIP_SIZES.get(symbol, 0.0001)
    sl_pips_check = abs(price - sl) / pip if sl else 0
    tp_pips_check = abs(price - tp) / pip if tp else 0
    if sl_pips_check > max_sane or tp_pips_check > max_sane:
        log.error(f"{symbol}: REJECTED - SL/TP implausibly far from live price "
                   f"(SL {sl_pips_check:.0f}p, TP {tp_pips_check:.0f}p, ceiling {max_sane}p). "
                   f"price={price:.5f} sl={sl:.5f} tp={tp:.5f}. Not sending to broker.")
        return {"success": False, "error": f"SL/TP sanity check failed ({sl_pips_check:.0f}/{tp_pips_check:.0f}p > {max_sane}p ceiling)"}

    # ── Select correct filling mode ───────────────────────────────────────────
    # ORDER_FILLING_IOC is only valid for MARKET orders.
    # Pending orders (LIMIT/STOP) require ORDER_FILLING_RETURN on most brokers.
    # This was causing mt5.order_send() to return None entirely (silent rejection).
    if mt5_action == mt5.TRADE_ACTION_PENDING:
        filling_mode = mt5.ORDER_FILLING_RETURN
    else:
        # For market orders, use the broker's supported filling mode
        filling_mode = mt5.ORDER_FILLING_IOC
        if sym_info:
            filling_flags = sym_info.filling_mode
            if filling_flags & 1:    # FOK supported
                filling_mode = mt5.ORDER_FILLING_FOK
            elif filling_flags & 2:  # IOC supported
                filling_mode = mt5.ORDER_FILLING_IOC
            else:
                filling_mode = mt5.ORDER_FILLING_RETURN

    req = {
        "action":       mt5_action,
        "symbol":       broker_symbol,
        "volume":       volume,
        "type":         mt5_order_type,
        "price":        price,
        "sl":           sl,
        "tp":           tp,
        "deviation":    30,
        "magic":        20260101,
        "comment":      order.get("comment", "Aethelgard"),
        # ORDER_TIME_DAY: pending orders cancel at end of trading day automatically.
        # ORDER_TIME_GTC: market orders stay until manually cancelled.
        "type_time":    mt5.ORDER_TIME_DAY if mt5_action == mt5.TRADE_ACTION_PENDING else mt5.ORDER_TIME_GTC,
        "type_filling": filling_mode,
    }
    # No expiration field needed when using ORDER_TIME_DAY

    result = mt5.order_send(req)
    if result is None:
        err = mt5.last_error()
        log.error(f"Trade failed [{broker_symbol} {direction} {signal_order_type}]: mt5.order_send returned None — MT5 error: {err}")
        return {"success": False, "error": f"order_send returned None: {err}", "retcode": -1}
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        log.error(f"Trade failed [{broker_symbol} {direction} {signal_order_type}]: {result.comment} (retcode:{result.retcode})")
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
    # Clean up cache for any tickets no longer open
    active_tickets = {pos.ticket for pos in positions}
    stale_keys = [t for t in _original_sl_cache if t not in active_tickets]
    for t in stale_keys:
        del _original_sl_cache[t]

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

            # ── Kill Zone RR-Based SL Management ──────────────────────────────
            # Uses R multiples (risk units) rather than fixed pip counts so
            # the system scales correctly across all instruments and lot sizes.
            #
            # Ladder:
            #   @ 0.5R → move SL to breakeven (free trade, protect capital)
            #   @ 1.1R → start trailing at 0.5x ATR (lock in early profit)
            #   @ 2.0R → tighten trail to 0.3x ATR (squeeze toward 2-3R TP)
            #
            # Falls back to pip-based system if no original SL is recorded.

            # Use cached original SL for accurate R calculation.
            # pos.sl changes as BE/trail moves it — we need the SL at trade open.
            ticket = pos.ticket
            if ticket not in _original_sl_cache and pos.sl and pos.sl > 0:
                _original_sl_cache[ticket] = float(pos.sl)  # first time we see it

            original_sl = _original_sl_cache.get(ticket, float(pos.sl) if pos.sl else 0)

            if original_sl > 0:
                r_distance = abs(open_price - original_sl)  # 1R in price units

                if r_distance > 0:
                    current_r = abs(price - open_price) / r_distance

                    # Stage 1: Breakeven at 0.5R — free trade
                    if current_r >= 0.5:
                        if direction == "BUY":
                            be = open_price + pip * 2  # 2 pips above entry
                            if be > (current_sl or 0):
                                res = modify_sl(pos.ticket, orig, be)
                                if res["success"]:
                                    log.info(f"BE@0.5R: #{pos.ticket} {orig} SL->{be:.5f} ({profit_pips:.0f}p / {current_r:.2f}R)")
                        else:
                            be = open_price - pip * 2
                            if current_sl == 0 or be < current_sl:
                                res = modify_sl(pos.ticket, orig, be)
                                if res["success"]:
                                    log.info(f"BE@0.5R: #{pos.ticket} {orig} SL->{be:.5f} ({profit_pips:.0f}p / {current_r:.2f}R)")

                    # Stage 2: Trail at 1.1R — 0.5x ATR
                    if current_r >= 1.1 and atr_val > 0:
                        trail = atr_val * 0.5
                        if direction == "BUY":
                            new_sl = price - trail
                            if new_sl > (current_sl or 0):
                                res = modify_sl(pos.ticket, orig, new_sl)
                                if res["success"]:
                                    log.info(f"Trail@1.1R: #{pos.ticket} ->{new_sl:.5f} ({current_r:.2f}R)")
                        else:
                            new_sl = price + trail
                            if current_sl == 0 or new_sl < current_sl:
                                res = modify_sl(pos.ticket, orig, new_sl)
                                if res["success"]:
                                    log.info(f"Trail@1.1R: #{pos.ticket} ->{new_sl:.5f} ({current_r:.2f}R)")

                    # Stage 3: Tighter trail at 2.0R — 0.3x ATR
                    if current_r >= 2.0 and atr_val > 0:
                        trail = atr_val * 0.3
                        if direction == "BUY":
                            new_sl = price - trail
                            if new_sl > (current_sl or 0):
                                res = modify_sl(pos.ticket, orig, new_sl)
                                if res["success"]:
                                    log.info(f"Trail@2.0R: #{pos.ticket} ->{new_sl:.5f} ({current_r:.2f}R) — approaching TP")
                        else:
                            new_sl = price + trail
                            if current_sl == 0 or new_sl < current_sl:
                                res = modify_sl(pos.ticket, orig, new_sl)
                                if res["success"]:
                                    log.info(f"Trail@2.0R: #{pos.ticket} ->{new_sl:.5f} ({current_r:.2f}R) — approaching TP")

            else:
                # Fallback: no SL recorded — pip-based
                if profit_pips >= 20:
                    be = open_price + pip * 5 if direction == "BUY" else open_price - pip * 5
                    needs_update = (direction == "BUY" and be > (current_sl or 0)) or                                    (direction == "SELL" and (current_sl == 0 or be < current_sl))
                    if needs_update:
                        res = modify_sl(pos.ticket, orig, be)
                        if res["success"]:
                            log.info(f"BE(pip): #{pos.ticket} {orig} SL->{be:.5f} ({profit_pips:.1f}pips)")
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
                timeout=30)
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
            # M5:  60 bars = 5 hours   (kill zone entry precision)
            # M15: 100 bars = 25 hours (confirmation)
            # H1:  150 bars = 6 days   (structure)
            # H4:  200 bars = 33 days  (primary analysis + ICT sequence)
            # D1:  100 bars = 100 days (HTF bias + ADR — needs ~50+ for EMA50)
            # W1:  60 bars  = ~14 months (HTF bias — needs ~50+ for EMA50)
            bar_counts = {"M5": 60, "M15": 100, "H1": 150, "H4": 200, "D1": 100, "W1": 60}
            # D1/W1 need fewer confirming bars than intraday TFs since each
            # bar covers far more time — 30 bars is already a month+ of daily data.
            min_bars_by_tf = {"M5": 10, "D1": 30, "W1": 20}
            for tf in TIMEFRAMES:
                bars = get_ohlcv(symbol, tf, bar_counts.get(tf, 150))
                min_bars = min_bars_by_tf.get(tf, 50)
                if bars and len(bars) > min_bars:
                    ohlcv_data[tf] = bars
                    # Cache H4/D1/W1 for backtesting — these are the timeframes
                    # the rebuilt backtest engine needs to replicate live HTF logic.
                    # M5/M15 excluded to keep cache volume reasonable (entry-timing
                    # only, not used for the backtest's structural analysis).
                    if tf in ("H4", "D1", "W1"):
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
                elif res.get("reason"):
                    # FIX: the backend already tells us WHY (e.g. "Trading disabled"),
                    # but this was being silently discarded — every no-signal case
                    # printed identically, making it impossible to tell "trading is
                    # off" apart from "no setup right now" just from this log.
                    log.info(f"No signal: {symbol} ({res['reason']})")
                else:
                    log.info(f"No signal: {symbol} (HOLD)")
            else:
                log.warning(f"OHLCV push failed {symbol}: {r.status_code}")

            time.sleep(0.5)  # reduced from 2s — backend stays warm between pairs

        except requests.exceptions.Timeout:
            log.warning(f"OHLCV timeout {symbol} — Render may have slept, continuing")
        except Exception as e:
            log.error(f"OHLCV error {symbol}: {e}")

def get_open_trade_count():
    """Count currently open positions in MT5 — used for concurrent trade enforcement."""
    positions = mt5.positions_get()
    return len(positions) if positions else 0


def get_open_trade_count_for_symbol(symbol):
    """Count open positions for a specific symbol."""
    broker_symbol = SYMBOL_MAP.get(symbol, symbol)
    positions = mt5.positions_get(symbol=broker_symbol)
    return len(positions) if positions else 0


def poll_commands():
    try:
        r = requests.get(f"{BACKEND_URL}/api/bridge/commands", headers=api_headers(), timeout=30)
        if r.status_code != 200:
            return

        # Read max concurrent trades and per-pair limit from backend settings
        max_trades     = 15   # default — overridden by Supabase platform_settings
        max_per_pair   = 2    # default — overridden by Supabase platform_settings
        try:
            s_r = requests.get(f"{BACKEND_URL}/api/bridge/settings", headers=api_headers(), timeout=10)
            if s_r.status_code == 200:
                s_data       = s_r.json()
                max_trades   = s_data.get("max_concurrent_trades", 15)
                max_per_pair = s_data.get("max_open_per_pair", 2)
        except:
            pass

        for cmd in r.json().get("commands", []):
            cmd_type = cmd.get("type")
            if cmd_type == "EXECUTE_TRADE":
                order = cmd["order"]
                symbol = order.get("symbol", "")

                # ── Bridge-level guard 1: Global concurrent trade cap ─────────
                # Checks actual MT5 open positions (not DB — DB lags 30s)
                current_open = get_open_trade_count()
                if current_open >= max_trades:
                    log.warning(f"BLOCKED: Global max trades reached ({current_open}/{max_trades}) — skip {symbol}")
                    try:
                        requests.post(f"{BACKEND_URL}/api/bridge/commands/{cmd['id']}/ack",
                            headers=api_headers(),
                            json={"success": False, "error": f"Max concurrent trades {current_open}/{max_trades}"},
                            timeout=5)
                    except:
                        pass
                    continue

                # ── Bridge-level guard 2: Per-pair open position cap ──────────
                pair_open = get_open_trade_count_for_symbol(symbol)
                if pair_open >= max_per_pair:
                    log.warning(f"BLOCKED: {symbol} already has {pair_open}/{max_per_pair} open — skip")
                    try:
                        requests.post(f"{BACKEND_URL}/api/bridge/commands/{cmd['id']}/ack",
                            headers=api_headers(),
                            json={"success": False, "error": f"{symbol} already has {pair_open} open position(s)"},
                            timeout=5)
                    except:
                        pass
                    continue

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
    log.info("Features: M5 entry | H4/D1/W1 analysis | Retry limit | SL validation | Copy trading | BE@0.5R | Trail@1.1R/2.0R | Pending orders")

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
        r = requests.get(f"{BACKEND_URL}/api/bridge/signal-interval",
            headers=api_headers(), timeout=30)
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
