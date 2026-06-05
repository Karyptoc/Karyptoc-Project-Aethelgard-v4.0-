import React from "react";
import { Outlet } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { useTheme } from "../hooks/useTheme";

export default function ClientLayout() {
  const { logout } = useAuth();
  const { dark, toggle } = useTheme();

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <div className="brand-icon">Æ</div>
            <div>
              <div className="brand-name">AETHELGARD</div>
              <div className="brand-ver">CLIENT PORTAL</div>
            </div>
          </div>
        </div>
        <nav className="sidebar-nav">
          <div className="nav-group-label">My Account</div>
          <a href="/client" className="nav-item active">
            <span className="nav-icon">◈</span> Dashboard
          </a>
        </nav>
        <div className="sidebar-footer">
          <div className="sidebar-actions">
            <button className="btn-theme" onClick={toggle}>{dark ? "☀️" : "🌙"}</button>
            <button className="btn-logout" onClick={logout}>LOGOUT</button>
          </div>
        </div>
      </aside>
      <main className="main-content"><Outlet /></main>
    </div>
  );
}
