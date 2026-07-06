import axios from "axios";

const API_URL = process.env.REACT_APP_API_URL || "http://localhost:4000";

const api = axios.create({
  baseURL: API_URL,
  // FIX: no timeout meant a hung backend (which your connection-history
  // shows has happened) could leave requests spinning indefinitely with
  // no visible failure. 20s is generous for normal API calls while still
  // failing visibly if the backend is unreachable or stuck.
  timeout: 20000,
});

api.interceptors.request.use((config) => {
  const session = JSON.parse(localStorage.getItem("aethelgard_session") || "{}");
  if (session?.access_token) {
    config.headers.Authorization = `Bearer ${session.access_token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem("aethelgard_session");
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

export default api;
