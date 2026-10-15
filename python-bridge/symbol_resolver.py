"""
Resolve canonical instrument ids (NAS100, XAUUSD, ...) to the symbol names a
specific broker's MT5 terminal actually lists. Keep CANDIDATES in sync with
engine/strategy-engine/config/instruments.js.
"""

CANDIDATES = {
    "NAS100": ["US100Cash", "US100", "USTEC", "NAS100", "NDX100", "USA100", "Nasdaq", "NQ100", "USTECm", "USTEC.c"],
    "US500": ["US500Cash", "US500", "SPX500", "SP500", "USA500", "US500m"],
    "US30": ["US30Cash", "US30", "DJ30", "USA30", "WS30", "US30m"],
    "GER40": ["GER40Cash", "GER40", "DE40", "DE30", "GER30", "DAX40", "GERMANY40", "DE30m", "DE40m"],
    "XAUUSD": ["GOLD", "XAUUSD", "XAUUSDm", "XAUUSD.", "XAUUSD.r", "GOLDm"],
    "BTCUSD": ["BTCUSD", "BTCUSDm", "BITCOIN", "BTCUSD."],
    "EURUSD": ["EURUSD", "EURUSDm", "EURUSD.", "EURUSD.r", "EURUSD#"],
    "GBPUSD": ["GBPUSD", "GBPUSDm", "GBPUSD.", "GBPUSD.r", "GBPUSD#"],
    "AUDUSD": ["AUDUSD", "AUDUSDm", "AUDUSD.", "AUDUSD.r", "AUDUSD#"],
    "USDJPY": ["USDJPY", "USDJPYm", "USDJPY.", "USDJPY.r", "USDJPY#"],
}


def resolve(available_names, overrides=None):
    """
    available_names: iterable of symbol names from mt5.symbols_get().
    overrides: {canonical: broker_symbol} set by the admin; always wins.
    Returns ({canonical: broker_symbol}, {canonical: [near-misses]}).
    Matching order: exact -> case-insensitive -> broker suffix (candidate + '.', 'm', '#', '_' ...).
    """
    names = list(available_names)
    lower = {n.lower(): n for n in names}
    overrides = overrides or {}
    resolved, unresolved = {}, {}
    for cid, cands in CANDIDATES.items():
        if cid in overrides and overrides[cid] in names:
            resolved[cid] = overrides[cid]
            continue
        hit = next((c for c in cands if c in names), None)
        if hit is None:
            hit = next((lower[c.lower()] for c in cands if c.lower() in lower), None)
        if hit is None:
            for c in cands:
                pref = [n for n in names if n.lower().startswith(c.lower()) and len(n) - len(c) <= 4]
                if pref:
                    hit = sorted(pref, key=len)[0]
                    break
        if hit:
            resolved[cid] = hit
        else:
            key = cid[:3].lower()
            unresolved[cid] = [n for n in names if key in n.lower()][:10]
    return resolved, unresolved
