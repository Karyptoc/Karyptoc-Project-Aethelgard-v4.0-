import React, { useState, useEffect } from "react";
import api from "../lib/api";

const EMPTY = {
  full_name: "", email: "", phone: "",
  subscription_type: "profit_split",
  subscription_amount: 0,
  profit_split_percent: 20,
  notes: ""
};

export default function Clients() {
  const [clients, setClients] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      const r = await api.get("/api/clients");
      setClients(r.data.clients || []);
    } catch (e) {
      console.error("Clients load error:", e.response?.data?.error || e.message);
    }
  };

  useEffect(() => { load(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError("");
    try {
      // FIX: admin_id used to be attached client-side via supabase.auth.getUser()
      // after a direct-to-Supabase insert. The backend route now derives this
      // from the verified JWT (req.user.id) itself, so it's handled server-side.
      await api.post("/api/clients", { ...form, status: "active" });
      setShowModal(false);
      setForm(EMPTY);
      await load();
    } catch (err) {
      setError(err.response?.data?.error || "Failed to add client");
    } finally {
      setSaving(false);
    }
  };

  const deactivate = async (id) => {
    try {
      await api.delete(`/api/clients/${id}`);
      await load();
    } catch (e) {
      console.error("Deactivate error:", e.response?.data?.error || e.message);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Clients</div>
          <div className="page-subtitle">SUBSCRIPTION MANAGEMENT · {clients.length} CLIENTS</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>+ ADD CLIENT</button>
      </div>

      <div className="page-body">
        {clients.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">◎</div>
            <div className="empty-text">No clients yet. Add your first client.</div>
          </div>
        ) : (
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th>Name</th><th>Email</th><th>Phone</th>
                  <th>Subscription</th><th>Split %</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {clients.map(c => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 700, color: "var(--text-primary)" }}>{c.full_name}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{c.email}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{c.phone || "—"}</td>
                    <td><span className="badge accent">{c.subscription_type?.replace("_", " ").toUpperCase()}</span></td>
                    <td className="mono">{c.profit_split_percent}%</td>
                    <td>
                      <span className={`badge ${c.status === "active" ? "bull" : "muted"}`}>
                        {c.status?.toUpperCase()}
                      </span>
                    </td>
                    <td>
                      <button className="btn btn-danger btn-xs" onClick={() => deactivate(c.id)}>
                        REMOVE
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Add Client</div>
            {error && <div className="alert alert-error">{error}</div>}
            <form onSubmit={submit}>
              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">Full Name</label>
                  <input className="form-input" value={form.full_name}
                    onChange={e => setForm({...form, full_name: e.target.value})} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Email</label>
                  <input className="form-input" type="email" value={form.email}
                    onChange={e => setForm({...form, email: e.target.value})} required />
                </div>
              </div>
              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">Phone</label>
                  <input className="form-input" value={form.phone}
                    onChange={e => setForm({...form, phone: e.target.value})}
                    placeholder="+254700000000" />
                </div>
                <div className="form-group">
                  <label className="form-label">Subscription Type</label>
                  <select className="form-select" value={form.subscription_type}
                    onChange={e => setForm({...form, subscription_type: e.target.value})}>
                    <option value="profit_split">Profit Split</option>
                    <option value="monthly">Monthly Fee</option>
                    <option value="free">Free</option>
                  </select>
                </div>
              </div>
              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">Monthly Fee ($)</label>
                  <input className="form-input" type="number" value={form.subscription_amount}
                    onChange={e => setForm({...form, subscription_amount: parseFloat(e.target.value)})} />
                </div>
                <div className="form-group">
                  <label className="form-label">Profit Split %</label>
                  <input className="form-input" type="number" min="0" max="50"
                    value={form.profit_split_percent}
                    onChange={e => setForm({...form, profit_split_percent: parseFloat(e.target.value)})} />
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Notes</label>
                <input className="form-input" value={form.notes}
                  onChange={e => setForm({...form, notes: e.target.value})} />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-ghost" onClick={() => setShowModal(false)}>CANCEL</button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? "SAVING..." : "ADD CLIENT"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
