import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true); setError("");
    try {
      await login(email, password);
      navigate("/");
    } catch (err) {
      setError(err.response?.data?.error || "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-bg" />
      <div className="login-grid" />
      <div className="login-box">
        <div className="login-logo">
          <span className="login-logo-icon">⚡</span>
          <div className="login-logo-name">AETHELGARD</div>
          <div className="login-logo-sub">AUTONOMOUS QUANT ENGINE</div>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Email Address</label>
            <input
              className="form-input"
              type="email" value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="admin@example.com"
              required
            />
          </div>
          <div className="form-group">
            <label className="form-label">Password</label>
            <input
              className="form-input"
              type="password" value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          <button
            className="btn btn-primary" type="submit"
            style={{ width: "100%", marginTop: 8, justifyContent: "center" }}
            disabled={loading}
          >
            {loading ? "AUTHENTICATING..." : "ACCESS SYSTEM"}
          </button>
        </form>

        <div style={{ marginTop: 20, textAlign: "center" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)", letterSpacing: 1 }}>
            SECURED · ENCRYPTED · MONITORED
          </span>
        </div>
      </div>
    </div>
  );
}
