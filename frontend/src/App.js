// App.js
import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { ThemeProvider } from "./hooks/useTheme";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Accounts from "./pages/Accounts";
import Clients from "./pages/Clients";
import Signals from "./pages/Signals";
import Trades from "./pages/Trades";
import Analytics from "./pages/Analytics";
import Billing from "./pages/Billing";
import SystemControl from "./pages/SystemControl";
import ClientPortal from "./pages/ClientPortal";
import Settings from "./pages/Settings";
import Layout from "./components/Layout";
import ClientLayout from "./components/ClientLayout";
import "./index.css";

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return (
    <div className="splash">
      <div className="splash-icon">⚡</div>
      <div className="splash-name">AETHELGARD</div>
      <div className="splash-sub">INITIALIZING ENGINE...</div>
    </div>
  );
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
              <Route index element={<Dashboard />} />
              <Route path="accounts" element={<Accounts />} />
              <Route path="clients" element={<Clients />} />
              <Route path="signals" element={<Signals />} />
              <Route path="trades" element={<Trades />} />
              <Route path="analytics" element={<Analytics />} />
              <Route path="billing" element={<Billing />} />
              <Route path="system" element={<SystemControl />} />
              <Route path="settings" element={<Settings />} />
            </Route>
            <Route path="/client" element={<ProtectedRoute><ClientLayout /></ProtectedRoute>}>
              <Route index element={<ClientPortal />} />
              <Route path="payment-success" element={<PaySuccess />} />
              <Route path="payment-failed" element={<PayFail />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}

function PaySuccess() {
  return (
    <div className="page-body" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 400 }}>
      <div style={{ fontSize: 64, marginBottom: 16 }}>✅</div>
      <div style={{ fontSize: 24, fontWeight: 800, marginBottom: 8 }}>Payment Successful!</div>
      <div style={{ color: "var(--text-muted)", marginBottom: 24 }}>Your payment has been received. Thank you!</div>
      <a href="/client" className="btn btn-primary">Back to Dashboard</a>
    </div>
  );
}

function PayFail() {
  return (
    <div className="page-body" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 400 }}>
      <div style={{ fontSize: 64, marginBottom: 16 }}>❌</div>
      <div style={{ fontSize: 24, fontWeight: 800, marginBottom: 8 }}>Payment Failed</div>
      <div style={{ color: "var(--text-muted)", marginBottom: 24 }}>Something went wrong. Please try again.</div>
      <a href="/client" className="btn btn-primary">Back to Dashboard</a>
    </div>
  );
}
