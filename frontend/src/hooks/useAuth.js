import { createContext, useContext, useState, useEffect, useRef } from "react";
import api from "../lib/api";

const AuthContext = createContext(null);

// FIX: proactively refresh the session every 45 minutes (Supabase tokens
// typically expire at 60 min) instead of only reacting after a request
// already failed with 401. This means most people should never actually
// see a forced re-login from expiry - the reactive refresh in api.js is
// now just a safety net for edge cases (e.g. laptop asleep past 45 min).
const REFRESH_INTERVAL_MS = 45 * 60 * 1000;

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const refreshTimerRef = useRef(null);

  const scheduleProactiveRefresh = () => {
    if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    refreshTimerRef.current = setInterval(async () => {
      const session = JSON.parse(localStorage.getItem("aethelgard_session") || "null");
      if (!session?.refresh_token) return;
      try {
        const { data } = await api.post("/api/auth/refresh", { refresh_token: session.refresh_token });
        localStorage.setItem("aethelgard_session", JSON.stringify(data.session));
      } catch {
        // Reactive refresh in api.js will catch it on the next failed request
        // if this proactive attempt itself fails for some reason.
      }
    }, REFRESH_INTERVAL_MS);
  };

  useEffect(() => {
    const session = JSON.parse(localStorage.getItem("aethelgard_session") || "null");
    if (session?.access_token) {
      api.get("/api/auth/me")
        .then(r => {
          setUser(r.data.user);
          setProfile(r.data.profile);
          scheduleProactiveRefresh();
        })
        .catch(() => localStorage.removeItem("aethelgard_session"))
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    };
  }, []);

  const login = async (email, password) => {
    const { data } = await api.post("/api/auth/login", { email, password });
    localStorage.setItem("aethelgard_session", JSON.stringify(data.session));
    setUser(data.user);
    scheduleProactiveRefresh();

    // Get profile to check role
    const meR = await api.get("/api/auth/me");
    setProfile(meR.data.profile);

    // Redirect based on role
    const role = meR.data.profile?.role;
    if (role === "client") {
      window.location.href = "/client";
    } else {
      window.location.href = "/";
    }

    return data;
  };

  const logout = () => {
    if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    localStorage.removeItem("aethelgard_session");
    setUser(null);
    setProfile(null);
    window.location.href = "/login";
  };

  return (
    <AuthContext.Provider value={{ user, profile, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
