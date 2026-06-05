import React, { useState, useEffect, useCallback } from "react";
import api from "../lib/api";

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function StatusBadge({ status }) {
  const map = { paid: "bull", pending: "warn", cancelled: "muted", overdue: "bear" };
  return <span className={`badge ${map[status] || "muted"}`}>{status?.toUpperCase()}</span>;
}

export default function Billing() {
  const [invoices, setInvoices] = useState([]);
  const [clients, setClients] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [checking, setChecking] = useState(null);
  const [toast, setToast] = useState("");
  const [form, setForm] = useState({
    client_id: "", period_start: "", period_end: "",
    gross_profit: "", split_percent: "20", currency: "KES", notes: ""
  });

  const load = useCallback(async () => {
    const [invR, cliR] = await Promise.all([
      api.get("/api/payments"),
      api.get("/api/clients")
    ]);
    setInvoices(invR.data.invoices || []);
    setClients(cliR.data.clients || []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 4000);
  };

  const createInvoice = async (e) => {
    e.preventDefault();
    try {
      const r = await api.post("/api/payments/create", {
        ...form,
        gross_profit: parseFloat(form.gross_profit),
        split_percent: parseFloat(form.split_percent)
      });
      setShowModal(false);
      await load();
      showToast(`✅ Invoice created! Payment link: ${r.data.payment_url}`);
      // Copy payment link
      navigator.clipboard.writeText(r.data.payment_url);
    } catch (e) {
      showToast("❌ " + (e.response?.data?.error || e.message));
    }
  };

  const checkStatus = async (invoiceId) => {
    setChecking(invoiceId);
    try {
      const r = await api.post(`/api/payments/check/${invoiceId}`);
      await load();
      const status = r.data.status?.payment_status_description;
      showToast(`Payment status: ${status || "Unknown"}`);
    } catch (e) {
      showToast("❌ " + e.message);
    } finally { setChecking(null); }
  };

  const cancelInvoice = async (id) => {
    if (!window.confirm("Cancel this invoice?")) return;
    await api.delete(`/api/payments/${id}`);
    await load();
  };

  const copyLink = (url) => {
    navigator.clipboard.writeText(url);
    showToast("✅ Payment link copied!");
  };

  // Summary stats
  const totalDue = invoices.filter(i => i.status === "pending").reduce((s, i) => s + (i.amount_due || 0), 0);
  const totalPaid = invoices.filter(i => i.status === "paid").reduce((s, i) => s + (i.amount_due || 0), 0);

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Billing</div>
          <div className="page-subtitle">PROFIT SPLIT INVOICES · M-PESA & CARD PAYMENTS</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>
          + Create Invoice
        </button>
      </div>

      {toast && (
        <div style={{ position: "fixed", top: 20, right: 20, zIndex: 9999, maxWidth: 380 }}>
          <div className={`alert ${toast.startsWith("❌") ? "alert-error" : "alert-success"}`} style={{ margin: 0 }}>
            {toast}
          </div>
        </div>
      )}

      <div className="page-body">
        {/* Summary */}
        <div className="stats-grid" style={{ marginBottom: 20 }}>
          <div className="stat-card accent">
            <span className="stat-icon">📄</span>
            <div className="stat-label">Total Invoices</div>
            <div className="stat-value accent">{invoices.length}</div>
          </div>
          <div className="stat-card warn">
            <span className="stat-icon">⏳</span>
            <div className="stat-label">Pending</div>
            <div className="stat-value warn">KES {totalDue.toFixed(2)}</div>
            <div className="stat-sub">{invoices.filter(i => i.status === "pending").length} invoices</div>
          </div>
          <div className="stat-card bull">
            <span className="stat-icon">✅</span>
            <div className="stat-label">Collected</div>
            <div className="stat-value bull">KES {totalPaid.toFixed(2)}</div>
            <div className="stat-sub">{invoices.filter(i => i.status === "paid").length} paid</div>
          </div>
        </div>

        {/* Invoices table */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">Invoice History</span>
          </div>
          {invoices.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">📄</div>
              <div className="empty-text">No invoices yet — create your first profit split invoice</div>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Invoice #</th><th>Client</th><th>Period</th>
                    <th>Gross Profit</th><th>Split %</th><th>Amount Due</th>
                    <th>Currency</th><th>Status</th><th>Paid At</th><th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map(inv => (
                    <tr key={inv.id}>
                      <td className="mono" style={{ fontSize: 11 }}>{inv.invoice_number}</td>
                      <td style={{ fontWeight: 600, color: "var(--text-primary)" }}>
                        {inv.clients?.full_name || "—"}
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)" }}>
                          {inv.clients?.email}
                        </div>
                      </td>
                      <td className="mono" style={{ fontSize: 11 }}>
                        {inv.period_start} → {inv.period_end}
                      </td>
                      <td className="mono">{inv.gross_profit?.toFixed(2)}</td>
                      <td className="mono">{inv.split_percent}%</td>
                      <td style={{ fontWeight: 700, color: "var(--text-primary)" }}>
                        {inv.amount_due?.toFixed(2)}
                      </td>
                      <td><span className="badge blue">{inv.currency}</span></td>
                      <td><StatusBadge status={inv.status} /></td>
                      <td className="mono" style={{ fontSize: 10, color: "var(--text-muted)" }}>
                        {inv.paid_at ? new Date(inv.paid_at).toLocaleDateString() : "—"}
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 4 }}>
                          {inv.payment_url && (
                            <button className="btn btn-ghost btn-xs" onClick={() => copyLink(inv.payment_url)}
                              title="Copy payment link">📋</button>
                          )}
                          {inv.status === "pending" && (
                            <>
                              <button className="btn btn-ghost btn-xs"
                                onClick={() => checkStatus(inv.id)}
                                disabled={checking === inv.id}>
                                {checking === inv.id ? "..." : "↻"}
                              </button>
                              <button className="btn btn-danger btn-xs" onClick={() => cancelInvoice(inv.id)}>✕</button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* How it works */}
        <div className="card" style={{ marginTop: 16, borderColor: "var(--accent-dim)" }}>
          <div className="card-header"><span className="card-title">How Profit Split Billing Works</span></div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
            {[
              { step: "1", title: "Record Profits", desc: "At month end, note the gross profit made on each client account" },
              { step: "2", title: "Create Invoice", desc: "Enter gross profit and split %. System calculates amount due" },
              { step: "3", title: "Share Link", desc: "Client gets a Pesapal payment link — they pay via M-Pesa or card" },
              { step: "4", title: "Auto Confirmation", desc: "Payment confirmed automatically via Pesapal IPN webhook" },
            ].map(({ step, title, desc }) => (
              <div key={step} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                <div style={{
                  width: 32, height: 32, borderRadius: "50%", background: "var(--accent-dim)",
                  color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center",
                  fontWeight: 800, fontSize: 14, flexShrink: 0
                }}>{step}</div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>{title}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Create Invoice Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Create Profit Split Invoice</div>
            <form onSubmit={createInvoice}>
              <div className="form-group">
                <label className="form-label">Client</label>
                <select className="form-select" value={form.client_id}
                  onChange={e => setForm({ ...form, client_id: e.target.value })} required>
                  <option value="">Select client...</option>
                  {clients.map(c => (
                    <option key={c.id} value={c.id}>{c.full_name} ({c.email})</option>
                  ))}
                </select>
              </div>
              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">Period Start</label>
                  <input className="form-input" type="date" value={form.period_start}
                    onChange={e => setForm({ ...form, period_start: e.target.value })} required />
                </div>
                <div className="form-group">
                  <label className="form-label">Period End</label>
                  <input className="form-input" type="date" value={form.period_end}
                    onChange={e => setForm({ ...form, period_end: e.target.value })} required />
                </div>
              </div>
              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">Gross Profit (USD)</label>
                  <input className="form-input" type="number" step="0.01" min="0"
                    value={form.gross_profit}
                    onChange={e => setForm({ ...form, gross_profit: e.target.value })}
                    placeholder="e.g. 150.00" required />
                </div>
                <div className="form-group">
                  <label className="form-label">Split % (Your Share)</label>
                  <input className="form-input" type="number" step="1" min="1" max="50"
                    value={form.split_percent}
                    onChange={e => setForm({ ...form, split_percent: e.target.value })} />
                </div>
              </div>
              <div className="grid-2">
                <div className="form-group">
                  <label className="form-label">Currency</label>
                  <select className="form-select" value={form.currency}
                    onChange={e => setForm({ ...form, currency: e.target.value })}>
                    <option value="KES">KES (Kenya Shilling)</option>
                    <option value="USD">USD (US Dollar)</option>
                    <option value="UGX">UGX (Uganda Shilling)</option>
                    <option value="TZS">TZS (Tanzania Shilling)</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Amount Due (calculated)</label>
                  <div style={{
                    padding: "10px 14px", background: "var(--bg-elevated)",
                    borderRadius: "var(--radius)", border: "1.5px solid var(--border)",
                    fontFamily: "var(--font-mono)", fontSize: 16, fontWeight: 700,
                    color: "var(--bull)"
                  }}>
                    {form.gross_profit && form.split_percent
                      ? `${form.currency} ${(parseFloat(form.gross_profit) * parseFloat(form.split_percent) / 100).toFixed(2)}`
                      : "—"}
                  </div>
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Notes (optional)</label>
                <input className="form-input" value={form.notes}
                  onChange={e => setForm({ ...form, notes: e.target.value })}
                  placeholder="e.g. June 2026 profit split" />
              </div>
              <div className="alert alert-info" style={{ fontSize: 12 }}>
                A Pesapal payment link will be generated. The client can pay via M-Pesa, Visa, or Mastercard.
                The link will be automatically copied to your clipboard.
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-ghost" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Create & Generate Link</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
