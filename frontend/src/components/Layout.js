import React, { useState, useEffect } from "react";
import { Outlet, NavLink } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useTheme } from "../hooks/useTheme";
import api from "../lib/api";

const NAV = [
  { to: "/", icon: "◈", label: "Dashboard", exact: true },
  { to: "/accounts", icon: "⬡", label: "Accounts" },
  { to: "/clients", icon: "◎", label: "Clients" },
  { to: "/signals", icon: "⚡", label: "Signals" },
  { to: "/trades", icon: "◆", label: "Journal" },
  { to: "/analytics", icon: "📊", label: "Analytics" },
  { to: "/settings", icon: "⚙", label: "Settings" },
];

export default function Layout() {
  const { logout } = useAuth();
  const { dark, toggle } = useTheme();
  const [status, setStatus] = useState({ bridge: "checking", accounts: 0 });

  useEffect(() => {
    const check = async () => {
      try {
        const r = await api.get("/api/dashboard/overview");
        const { connected_accounts, total_accounts } = r.data.summary;
        setStatus({
          bridge: connected_accounts > 0 ? "online" : total_accounts > 0 ? "warn" : "offline",
          accounts: connected_accounts
        });
      } catch { setStatus(s => ({ ...s, bridge: "offline" })); }
    };
    check();
    const iv = setInterval(check, 30000);
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
              <div className="brand-ver">QUANT ENGINE v3.0</div>
            </div>
          </div>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-group-label">Navigation</div>
          {NAV.map(item => (
            <NavLink key={item.to} to={item.to} end={item.exact}
              className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="status-pill">
            <div className={`status-dot ${status.bridge}`} />
            <span className="status-text">{statusLabel}</span>
          </div>
          <div className="sidebar-actions">
            <button className="btn-theme" onClick={toggle} title="Toggle theme">
              {dark ? "☀️" : "🌙"}
            </button>
            <button className="btn-logout" onClick={logout}>DISCONNECT</button>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
