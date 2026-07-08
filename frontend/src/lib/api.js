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

// FIX: this used to wipe the session and force a full re-login on EVERY
// 401, even though Supabase sessions include a refresh_token specifically
// meant to avoid that. Now it tries a refresh first, and only forces
// logout if the refresh itself fails (meaning the session is genuinely
// dead, not just expired). isRefreshing/failedQueue prevent multiple
// simultaneous requests from all trying to refresh at once if several
// calls hit a 401 around the same moment.
let isRefreshing = false;
let failedQueue = [];

function processQueue(error, token = null) {
  failedQueue.forEach(p => error ? p.reject(error) : p.resolve(token));
  failedQueue = [];
}

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const originalRequest = err.config;
    if (err.response?.status === 401 && !originalRequest._retry) {
      if (isRefreshing) {
        // Another request already triggered a refresh - wait for it
        // instead of firing a second, redundant refresh call.
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then(token => {
          originalRequest.headers.Authorization = `Bearer ${token}`;
          return api(originalRequest);
        }).catch(e => Promise.reject(e));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      const session = JSON.parse(localStorage.getItem("aethelgard_session") || "{}");
      if (!session?.refresh_token) {
        localStorage.removeItem("aethelgard_session");
        window.location.href = "/login";
        return Promise.reject(err);
      }

      try {
        const { data } = await axios.post(`${API_URL}/api/auth/refresh`, {
          refresh_token: session.refresh_token
        });
        localStorage.setItem("aethelgard_session", JSON.stringify(data.session));
        processQueue(null, data.session.access_token);
        originalRequest.headers.Authorization = `Bearer ${data.session.access_token}`;
        return api(originalRequest);
      } catch (refreshErr) {
        processQueue(refreshErr, null);
        localStorage.removeItem("aethelgard_session");
        window.location.href = "/login";
        return Promise.reject(refreshErr);
      } finally {
        isRefreshing = false;
      }
    }
    return Promise.reject(err);
  }
);

export default api;
