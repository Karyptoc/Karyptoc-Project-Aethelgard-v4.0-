const express = require("express");
const router = express.Router();
const { supabaseAdmin } = require("../services/supabase");
const { verifyToken } = require("../middleware/auth");

router.use(verifyToken);

router.get("/", async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("clients").select("*, mt5_accounts(*)").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ clients: data });
});

router.post("/", async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("clients").insert({ ...req.body, admin_id: req.user.id }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ client: data });
});

router.put("/:id", async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from("clients").update(req.body).eq("id", req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ client: data });
});

router.delete("/:id", async (req, res) => {
  const { error } = await supabaseAdmin.from("clients").update({ status: "inactive" }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

module.exports = router;
