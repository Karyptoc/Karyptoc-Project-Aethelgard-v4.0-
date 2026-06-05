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
