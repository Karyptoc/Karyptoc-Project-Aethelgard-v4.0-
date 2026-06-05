import React, { useState, useEffect } from "react";
import { Outlet, NavLink, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import api from "../lib/api";

const NAV = [
  { to: "/", icon: "◈", label: "Dashboard", exact: true },
  { to: "/accounts", icon: "⬡", label: "Accounts" },
  { to: "/clients", icon: "◎", label: "Clients" },
  { to: "/signals", icon: "⚡", label: "Signals" },
  { to: "/trades", icon: "◆", label: "Trades" },
  { to: "/settings", icon: "⚙", label: "Settings" },
];

export default function Layout() {
  const { logout } = useAuth();
  const location = useLocation();
  const [bridgeStatus, setBridgeStatus] = useState("checking");
  const [connectedAccounts, setConnectedAccounts] = useState(0);

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const r = await api.get("/api/dashboard/overview");
        const { connected_accounts, total_accounts } = r.data.summary;
        setConnectedAccounts(connected_accounts);
        setBridgeStatus(connected_accounts > 0 ? "online" : total_accounts > 0 ? "warn" : "offline");
      } catch {
        setBridgeStatus("offline");
      }
    };
    checkStatus();
    const interval = setInterval(checkStatus, 30000);
    return () => clearInterval(interval);
  }, []);

  const statusLabel = {
    online: "BRIDGE ONLINE",
    offline: "BRIDGE OFFLINE",
    warn: "NO CONNECTIONS",
    checking: "CHECKING..."
  }[bridgeStatus];

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <div className="sidebar-logo-icon">Æ</div>
            <div>
              <div className="sidebar-logo-text">AETHELGARD</div>
              <div className="sidebar-logo-ver">QUANT ENGINE v1.0</div>
            </div>
          </div>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-section">
            <div className="nav-label">Navigation</div>
            {NAV.map(item => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.exact}
                className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}
              >
                <span className="nav-item-icon">{item.icon}</span>
                {item.label}
              </NavLink>
            ))}
          </div>
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-status">
            <div className={`status-dot ${bridgeStatus}`} />
            <span className="status-text">{statusLabel}</span>
          </div>
          {connectedAccounts > 0 && (
            <div className="sidebar-status" style={{ marginBottom: 8 }}>
              <div className="status-dot online" />
              <span className="status-text">{connectedAccounts} ACCOUNT{connectedAccounts > 1 ? "S" : ""} LIVE</span>
            </div>
          )}
          <button className="logout-btn" onClick={logout}>DISCONNECT</button>
        </div>
      </aside>

      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
