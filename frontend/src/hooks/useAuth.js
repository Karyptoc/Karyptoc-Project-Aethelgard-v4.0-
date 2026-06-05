import { createContext, useContext, useState, useEffect } from "react";
import api from "../lib/api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const session = JSON.parse(localStorage.getItem("aethelgard_session") || "null");
    if (session?.access_token) {
      api.get("/api/auth/me")
        .then(r => setUser(r.data.profile || r.data.user))
        .catch(() => localStorage.removeItem("aethelgard_session"))
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (email, password) => {
    const { data } = await api.post("/api/auth/login", { email, password });
    localStorage.setItem("aethelgard_session", JSON.stringify(data.session));
    setUser(data.user);
    return data;
  };

  const logout = () => {
    localStorage.removeItem("aethelgard_session");
    setUser(null);
    window.location.href = "/login";
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
