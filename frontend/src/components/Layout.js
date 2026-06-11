import React, { useState, useEffect } from "react";
import { Outlet, NavLink } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useTheme } from "../hooks/useTheme";
import { createClient } from "@supabase/supabase-js";
import api from "../lib/api";

const supabase = createClient(
  process.env.REACT_APP_SUPABASE_URL,
  process.env.REACT_APP_SUPABASE_ANON_KEY
);

const NAV = [
  { to: "/",         icon: "◈", label: "Dashboard",     exact: true },
  { to: "/accounts", icon: "⬡", label: "Accounts" },
  { to: "/clients",  icon: "◎", label: "Clients" },
  { to: "/signals",  icon: "⚡", label: "Signals" },
  { to: "/trades",   icon: "◆", label: "Journal" },
  { to: "/analytics",icon: "📊", label: "Analytics" },
  { to: "/billing",  icon: "💳", label: "Billing" },
  { to: "/pairs",    icon: "⚙", label: "Pair Controls", badge: "halted" },
  { to: "/backtest", icon: "📈", label: "Backtest" },
  { to: "/system",   icon: "🖥", label: "System" },
  { to: "/settings", icon: "⚙", label: "Settings" },
];

export default function Layout() {
  const { logout } = useAuth();
  const { dark, toggle } = useTheme();
  const [status, setStatus] = useState({ bridge: "checking", accounts: 0 });
  const [pendingInvoices, setPendingInvoices] = useState(0);
  const [haltedPairs, setHaltedPairs] = useState(0);
  const [tradingEnabled, setTradingEnabled] = useState(false);

  useEffect(() => {
    const check = async () => {
      try {
        const [overviewR, settingsR] = await Promise.all([
          api.get("/api/dashboard/overview"),
          api.get("/api/system/settings").catch(() => ({ data: { settings: {} } }))
        ]);
        const { connected_accounts, total_accounts } = overviewR.data.summary;
        setStatus({
          bridge: connected_accounts > 0 ? "online" : total_accounts > 0 ? "warn" : "offline",
          accounts: connected_accounts
        });
        const s = settingsR.data.settings || {};
        setTradingEnabled(s["trading_enabled"] === true || s["trading_enabled"] === "true");
      } catch {
        setStatus(s => ({ ...s, bridge: "offline" }));
      }
    };

    const checkInvoices = async () => {
      try {
        const r = await api.get("/api/payments").catch(() => ({ data: { invoices: [] } }));
        const pending = (r.data.invoices || []).filter(i => i.status === "pending").length;
        setPendingInvoices(pending);
      } catch {}
    };

    const checkHaltedPairs = async () => {
      try {
        const { data } = await supabase
          .from("pair_controls")
          .select("symbol")
          .or("enabled.eq.false,auto_halted.eq.true");
        setHaltedPairs((data || []).length);
      } catch {}
    };

    check();
    checkInvoices();
    checkHaltedPairs();

    const iv = setInterval(() => {
      check();
      checkHaltedPairs();
    }, 30000);
    return () => clearInterval(iv);
  }, []);

  const statusLabel = {
    online: `${status.accounts} ACCOUNT${status.accounts > 1 ? "S" : ""} LIVE`,
    offline: "BRIDGE OFFLINE",
    warn: "NO CONNECTIONS",
    checking: "CHECKING..."
  }[status.bridge];

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <div className="brand-icon">Æ</div>
            <div>
              <div className="brand-name">AETHELGARD</div>
              <div className="brand-ver">QUANT ENGINE v5.0</div>
            </div>
          </div>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-group-label">Navigation</div>
          {NAV.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.exact}
              className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
              {item.badge === "halted" && haltedPairs > 0 && (
                <span style={{
                  marginLeft: "auto", background: "var(--bear)", color: "white",
                  borderRadius: 10, padding: "1px 7px", fontSize: 10, fontWeight: 700
                }}>
                  {haltedPairs}
                </span>
              )}
              {item.to === "/billing" && pendingInvoices > 0 && (
                <span style={{
                  marginLeft: "auto", background: "var(--warn)", color: "white",
                  borderRadius: 10, padding: "1px 7px", fontSize: 10, fontWeight: 700
                }}>
                  {pendingInvoices}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="status-pill">
            <div className={`status-dot ${status.bridge}`} />
            <span className="status-text">{statusLabel}</span>
          </div>
          <div className="status-pill" style={{ marginTop: 4 }}>
            <div className="status-dot" style={{
              background: tradingEnabled ? "var(--bull)" : "var(--warn)"
            }} />
            <span className="status-text">
              {tradingEnabled ? "AUTO-TRADING ON" : "AUTO-TRADING OFF"}
            </span>
          </div>
          {haltedPairs > 0 && (
            <div className="status-pill" style={{ marginTop: 4 }}>
              <div className="status-dot" style={{ background: "var(--bear)" }} />
              <span className="status-text" style={{ color: "var(--bear)" }}>
                {haltedPairs} PAIR{haltedPairs > 1 ? "S" : ""} HALTED
              </span>
            </div>
          )}
          <div className="sidebar-actions" style={{ marginTop: 4 }}>
            <button className="btn-theme" onClick={toggle} title="Toggle theme">
              {dark ? "☀️" : "🌙"}
            </button>
            <button className="btn-logout" onClick={logout}>DISCONNECT</button>
          </div>
        </div>
      </aside>

      <main className="main-content"><Outlet /></main>
    </div>
  );
}