import axios from "axios";

const API_URL = process.env.REACT_APP_API_URL || "http://localhost:4000";

const api = axios.create({ baseURL: API_URL });

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
