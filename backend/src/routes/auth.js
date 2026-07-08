const express = require("express");
const router = express.Router();
const { supabaseAnon, supabaseAdmin } = require("../services/supabase");

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: error.message });
  res.json({ session: data.session, user: data.user });
});

router.post("/logout", async (req, res) => {
  await supabaseAnon.auth.signOut();
  res.json({ ok: true });
});

// NEW: refresh an expiring session using its refresh_token, without
// requiring the user to log in again. This was completely missing before -
// login stored access_token once and nothing ever refreshed it, so once
// Supabase's ~1hr expiry hit, every request started failing with a real
// 401 and the frontend force-logged-out. This endpoint is what api.js now
// calls automatically when that happens (see api.js changes).
router.post("/refresh", async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: "No refresh_token provided" });
  const { data, error } = await supabaseAnon.auth.refreshSession({ refresh_token });
  if (error) return res.status(401).json({ error: error.message });
  res.json({ session: data.session, user: data.user });
});

router.get("/me", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });
  const { data: { user }, error } = await supabaseAnon.auth.getUser(token);
  if (error) return res.status(401).json({ error: error.message });

  const { data: profile } = await supabaseAdmin
    .from("profiles").select("*").eq("id", user.id).single();

  res.json({ user, profile });
});

module.exports = router;
