import React, { useState, useEffect, useCallback } from "react";
import api from "../lib/api";

// The portal link is built from the address this admin app is running on, so
// it always points at the real frontend (the backend's FRONTEND_URL setting can
// be wrong or stale).
const portalUrlFor = (token) => `${window.location.origin}/client-portal?token=${token}`;

const feeSummary = (c) => c.fee_model === "fixed_fee"
  ? `$${parseFloat(c.fixed_fee_amount || 0).toFixed(2)}/month fixed`
  : `${c.performance_fee_pct ?? 20}% profit split`;

// Shared by "Add client" and "Edit fee terms".
function FeeTermsFields({ value, onChange }) {
  const model = value.fee_model || "profit_split";
  const pct = parseFloat(value.performance_fee_pct);
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <div style={{ gridColumn: "1/-1", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 12 }}>
      <label className="form-label">How do you charge this client?</label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {[["profit_split", "Profit split"], ["fixed_fee", "Fixed monthly fee"]].map(([k, label]) => (
          <button type="button" key={k} className={`btn btn-sm ${model === k ? "btn-primary" : "btn-ghost"}`}
            onClick={() => set({ fee_model: k })}>{label}</button>
        ))}
      </div>
      {model === "profit_split" ? (
        <div style={{ maxWidth: 320 }}>
          <label className="form-label">Your share of the profit (%)</label>
          <input className="form-input" type="number" min="0" max="100" step="1"
            value={value.performance_fee_pct} onChange={e => set({ performance_fee_pct: e.target.value })} />
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.5 }}>
            {Number.isFinite(pct) && pct >= 0 && pct <= 100
              ? `You take ${pct}% and the client keeps ${(100 - pct).toFixed(0)}% of each winning trade. `
              : ""}
            It builds up as trades close. Losing trades carry no fee.
          </div>
        </div>
      ) : (
        <div style={{ maxWidth: 320 }}>
          <label className="form-label">Fee per month ($)</label>
          <input className="form-input" type="number" min="0" step="1"
            value={value.fixed_fee_amount} onChange={e => set({ fixed_fee_amount: e.target.value })} />
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, lineHeight: 1.5 }}>
            Charged once a month, whether or not trades win, and nothing is taken from individual trades.
            The first charge is one month after the client is added.
          </div>
        </div>
      )}
    </div>
  );
}

export default function ClientManagement() {
  const [clients, setClients] = useState([]);
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedClient, setSelectedClient] = useState(null);
  const [clientTrades, setClientTrades] = useState([]);
  const [toast, setToast] = useState("");
  const [activeTab, setActiveTab] = useState("clients");

  const [newClient, setNewClient] = useState({
    name: "", email: "", phone: "",
    mt5_login: "", mt5_password: "", mt5_server: "",
    starting_balance: "", risk_percent: "1.0",
    fee_model: "profit_split", performance_fee_pct: "20", fixed_fee_amount: "",
    currency: "USD",
    connection_type: "credentials", notes: ""
  });
  const [newLink, setNewLink] = useState(null);   // { name, url } shown until dismissed
  const [feeEdit, setFeeEdit] = useState(null);   // { id, name, fee_model, performance_fee_pct, fixed_fee_amount }

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(""), 3500); };

  const copyText = async (text) => {
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ovR, clR] = await Promise.all([
        api.get("/api/copy-trading/overview"),
        api.get("/api/copy-trading/clients")
      ]);
      setOverview(ovR.data.summary);
      setClients(ovR.data.clients || []);
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const addClient = async () => {
    if (!newClient.name || !newClient.email) return showToast("❌ Name and email required");
    try {
      const r = await api.post("/api/copy-trading/clients", {
        ...newClient,
        starting_balance: parseFloat(newClient.starting_balance) || 0,
        risk_percent: parseFloat(newClient.risk_percent),
        fee_model: newClient.fee_model,
        performance_fee_pct: parseFloat(newClient.performance_fee_pct),
        fixed_fee_amount: parseFloat(newClient.fixed_fee_amount) || 0,
      });
      const url = portalUrlFor(r.data.client.portal_token);
      const copied = await copyText(url);
      setNewLink({ name: newClient.name, url });
      showToast(copied ? "✅ Client added. Portal link copied" : "✅ Client added");
      setShowAdd(false);
      setNewClient({ name:"",email:"",phone:"",mt5_login:"",mt5_password:"",mt5_server:"",starting_balance:"",risk_percent:"1.0",fee_model:"profit_split",performance_fee_pct:"20",fixed_fee_amount:"",currency:"USD",connection_type:"credentials",notes:"" });
      await load();
    } catch (e) { showToast("❌ " + (e.response?.data?.error || e.message)); }
  };

  const suspendClient = async (id, name) => {
    if (!window.confirm(`Suspend ${name}? This will stop copy trading for this client.`)) return;
    try {
      await api.delete(`/api/copy-trading/clients/${id}`);
      showToast(`⏸ ${name} suspended`);
      await load();
    } catch (e) { showToast("❌ " + e.message); }
  };

  const reactivateClient = async (id) => {
    try {
      await api.put(`/api/copy-trading/clients/${id}`, { status: "active", copy_enabled: true });
      showToast("✅ Client reactivated");
      await load();
    } catch (e) { showToast("❌ " + e.message); }
  };

  const regenerateLink = async (id, name) => {
    try {
      if (!window.confirm(`Create a new link for ${name}? Their current link will stop working.`)) return;
      const r = await api.post(`/api/copy-trading/clients/${id}/regenerate-token`);
      const url = portalUrlFor(r.data.portal_token);
      const copied = await copyText(url);
      setNewLink({ name, url });
      showToast(copied ? `✅ New link for ${name} copied` : `✅ New link for ${name} created`);
      await load();
    } catch (e) { showToast("❌ " + (e.response?.data?.error || e.message)); }
  };

  const copyPortalLink = async (client) => {
    const token = client.portal_token;
    if (!token) return showToast("❌ No portal token. Refresh the page and try again");
    const url = portalUrlFor(token);
    const copied = await copyText(url);
    setNewLink({ name: client.name, url });
    showToast(copied ? "✅ Portal link copied" : "Portal link shown below. Copy it from there");
  };

  const saveFeeTerms = async () => {
    const f = feeEdit;
    try {
      await api.put(`/api/copy-trading/clients/${f.id}`, {
        fee_model: f.fee_model,
        performance_fee_pct: parseFloat(f.performance_fee_pct),
        fixed_fee_amount: parseFloat(f.fixed_fee_amount) || 0,
      });
      showToast(`✅ Fee terms updated for ${f.name}`);
      setFeeEdit(null);
      await load();
    } catch (e) { showToast("❌ " + (e.response?.data?.error || e.message)); }
  };

  const viewClientTrades = async (client) => {
    setSelectedClient(client);
    try {
      const r = await api.get(`/api/copy-trading/clients/${client.id}/trades`);
      setClientTrades(r.data.trades || []);
    } catch {}
  };

  // Real Pesapal invoice: pending_fee is only cleared once Pesapal confirms
  // payment (backend onInvoicePaid), so a failed/abandoned payment never
  // wipes the fee owed.
  const sendFeeInvoice = async (clientId, name, amount) => {
    if (!window.confirm(`Create a payment link for $${amount.toFixed(2)} performance fee from ${name}?`)) return;
    try {
      const r = await api.post(`/api/copy-trading/fees/invoice/${clientId}`);
      const url = r.data.payment_url;
      try { await navigator.clipboard.writeText(url); showToast(`✅ Payment link copied — send it to ${name}`); }
      catch { window.prompt("Payment link (copy and send to client):", url); }
      await load();
    } catch (e) { showToast("❌ " + (e.response?.data?.error || e.message)); }
  };

  // Offline settlement only (cash/bank transfer outside Pesapal): clears
  // pending_fee immediately with no payment check.
  const markFeePaidOffline = async (clientId, name, amount) => {
    if (!window.confirm(`Mark $${amount.toFixed(2)} from ${name} as paid OFFLINE? This clears the fee without any payment check.`)) return;
    try {
      await api.post(`/api/copy-trading/fees/collect/${clientId}`);
      showToast(`✅ $${amount.toFixed(2)} marked paid for ${name}`);
      await load();
    } catch (e) { showToast("❌ " + e.message); }
  };

  const pnlColor = (v) => parseFloat(v) >= 0 ? "var(--bull)" : "var(--bear)";
  const pnlSign = (v) => parseFloat(v) >= 0 ? "+" : "";

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Copy-Trading Clients</div>
          {/* NEW (Oct 4 — Roadmap Phase 3, "separate the two client UI
              systems"): clarified from "Client Management" — this is the
              independent copy-trading engine (its own MT5 credentials per
              client, automatic performance fees, client portal). It is
              NOT the billing/subscription "Clients" page under the
              Billing Clients section — that's a different table, a
              different business model, and currently has no payment
              integration wired to it (a separate, still-open item). */}
          <div className="page-subtitle">COPY TRADING · PERFORMANCE FEES · PORTAL ACCESS · separate from Billing Clients</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={load}>↻ Refresh</button>
          <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(true)}>+ Add Client</button>
        </div>
      </div>

      {toast && (
        <div style={{ position: "fixed", top: 20, right: 20, zIndex: 9999 }}>
          <div className="alert alert-info" style={{ margin: 0, minWidth: 320 }}>{toast}</div>
        </div>
      )}

      <div className="page-body">

        {/* Overview stats */}
        {overview && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
            {[
              ["Total clients", overview.total_clients, "var(--text-primary)"],
              ["Active", overview.active_clients, "var(--bull)"],
              ["Connected", overview.connected_clients, "var(--accent)"],
              ["Total AUM", `$${parseFloat(overview.total_aum||0).toFixed(0)}`, "var(--text-primary)"],
              ["Today P&L", `${pnlSign(overview.today_pnl)}$${parseFloat(overview.today_pnl||0).toFixed(2)}`, pnlColor(overview.today_pnl)],
              ["Pending fees", `$${parseFloat(overview.pending_fees||0).toFixed(2)}`, "var(--warn)"],
            ].map(([label, value, color]) => (
              <div key={label} style={{ background: "var(--bg-elevated)", borderRadius: "var(--radius)", padding: "12px 14px" }}>
                <div style={{ fontSize: 9, letterSpacing: 2, color: "var(--text-muted)", marginBottom: 6 }}>{label.toUpperCase()}</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 18, fontWeight: 700, color }}>{value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Tabs */}
        <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
          {["clients","add"].map(tab => (
            <button key={tab} className={`btn btn-sm ${activeTab === tab || (tab === "add" && showAdd) ? "btn-primary" : "btn-ghost"}`}
              onClick={() => { setActiveTab(tab); if (tab === "add") setShowAdd(true); else setShowAdd(false); }}>
              {tab === "add" ? "+ Add client" : "All clients"}
            </button>
          ))}
        </div>

        {/* Portal link — stays on screen until dismissed (toasts vanish too fast to copy from) */}
        {newLink && (
          <div className="alert alert-info" style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Portal link for {newLink.name}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input className="form-input mono" readOnly value={newLink.url} style={{ flex: "1 1 360px", fontSize: 12 }}
                onFocus={e => e.target.select()} />
              <button className="btn btn-primary btn-sm" onClick={async () => showToast((await copyText(newLink.url)) ? "✅ Copied" : "Select the link and copy it")}>Copy</button>
              <a className="btn btn-ghost btn-sm" href={newLink.url} target="_blank" rel="noopener noreferrer">Open</a>
              <button className="btn btn-ghost btn-sm" onClick={() => setNewLink(null)}>Dismiss</button>
            </div>
            <div style={{ fontSize: 11, marginTop: 6, opacity: 0.8 }}>
              Anyone with this link can see this client's account, so send it only to them. "New link" replaces it if it leaks.
            </div>
          </div>
        )}

        {/* Edit fee terms */}
        {feeEdit && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-header"><span className="card-title">Fee terms — {feeEdit.name}</span></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12, marginBottom: 14 }}>
              <FeeTermsFields value={feeEdit} onChange={setFeeEdit} />
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12 }}>
              Changes apply from now on. Fees already owed are not recalculated.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary" onClick={saveFeeTerms}>Save fee terms</button>
              <button className="btn btn-ghost" onClick={() => setFeeEdit(null)}>Cancel</button>
            </div>
          </div>
        )}

        {/* Add client form */}
        {showAdd && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-header"><span className="card-title">Add new client</span></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
              <div>
                <label className="form-label">Full name *</label>
                <input className="form-input" value={newClient.name} onChange={e => setNewClient({...newClient, name: e.target.value})} />
              </div>
              <div>
                <label className="form-label">Email *</label>
                <input className="form-input" type="email" value={newClient.email} onChange={e => setNewClient({...newClient, email: e.target.value})} />
              </div>
              <div>
                <label className="form-label">Phone</label>
                <input className="form-input" value={newClient.phone} onChange={e => setNewClient({...newClient, phone: e.target.value})} />
              </div>
              <div>
                <label className="form-label">Starting balance ($)</label>
                <input className="form-input" type="number" value={newClient.starting_balance} onChange={e => setNewClient({...newClient, starting_balance: e.target.value})} />
              </div>
              <div>
                <label className="form-label">MT5 Login</label>
                <input className="form-input" value={newClient.mt5_login} onChange={e => setNewClient({...newClient, mt5_login: e.target.value})} />
              </div>
              <div>
                <label className="form-label">MT5 Password</label>
                <input className="form-input" type="password" value={newClient.mt5_password} onChange={e => setNewClient({...newClient, mt5_password: e.target.value})} />
              </div>
              <div>
                <label className="form-label">MT5 Server</label>
                <input className="form-input" value={newClient.mt5_server} onChange={e => setNewClient({...newClient, mt5_server: e.target.value})} />
              </div>
              <div>
                <label className="form-label">Risk per trade (%)</label>
                <input className="form-input" type="number" step="0.1" value={newClient.risk_percent} onChange={e => setNewClient({...newClient, risk_percent: e.target.value})} />
              </div>
              <div>
                <label className="form-label">Connection method</label>
                <select className="form-select" value={newClient.connection_type} onChange={e => setNewClient({...newClient, connection_type: e.target.value})}>
                  <option value="credentials">Credentials (hosted)</option>
                  <option value="bridge_script">Local bridge script</option>
                </select>
              </div>
              <FeeTermsFields value={newClient} onChange={setNewClient} />
              <div style={{ gridColumn: "1/-1" }}>
                <label className="form-label">Notes</label>
                <input className="form-input" value={newClient.notes} onChange={e => setNewClient({...newClient, notes: e.target.value})} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary" onClick={addClient}>Add client & generate portal link</button>
              <button className="btn btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button>
            </div>
          </div>
        )}

        {/* Client selected — show trades */}
        {selectedClient && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-header">
              <span className="card-title">Trades — {selectedClient.name}</span>
              <button className="btn btn-ghost btn-xs" onClick={() => setSelectedClient(null)}>✕ Close</button>
            </div>
            <div className="table-wrap" style={{ maxHeight: 300, overflowY: "auto" }}>
              <table>
                <thead><tr><th>Time</th><th>Symbol</th><th>Dir</th><th>Lots</th><th>P&L</th><th>Status</th></tr></thead>
                <tbody>
                  {clientTrades.length === 0 && <tr><td colSpan={6} style={{ textAlign: "center", color: "var(--text-muted)", padding: 20 }}>No trades yet</td></tr>}
                  {clientTrades.map((t, i) => (
                    <tr key={i}>
                      <td className="mono" style={{ fontSize: 10 }}>{new Date(t.open_time).toLocaleString()}</td>
                      <td style={{ fontWeight: 700 }}>{t.symbol}</td>
                      <td><span className={`badge ${t.direction === "BUY" ? "bull" : "bear"}`}>{t.direction}</span></td>
                      <td className="mono">{t.lot_size}</td>
                      <td className="mono"><span className={t.profit >= 0 ? "pnl-pos" : "pnl-neg"}>{pnlSign(t.profit)}${parseFloat(t.profit||0).toFixed(2)}</span></td>
                      <td><span className={`badge ${t.status === "open" ? "warn" : t.profit >= 0 ? "bull" : "bear"}`}>{t.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Clients table */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">All clients</span>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{clients.length} accounts</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th><th>Balance</th><th>Today P&L</th><th>Total P&L</th>
                  <th>Status</th><th>Pending fee</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={7} style={{ textAlign: "center", padding: 20, color: "var(--text-muted)" }}>Loading...</td></tr>}
                {clients.map(c => (
                  <tr key={c.id} style={{ opacity: c.status !== "active" ? 0.5 : 1 }}>
                    <td>
                      <div style={{ fontWeight: 700 }}>{c.name}</div>
                      <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{c.email}</div>
                      <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
                        <span className={`badge ${c.is_connected ? "bull" : "warn"}`} style={{ fontSize: 9, padding: "1px 5px" }}>
                          {c.is_connected ? "MT5" : "OFFLINE"}
                        </span>
                        <span className={`badge ${c.copy_enabled ? "accent" : "warn"}`} style={{ fontSize: 9, padding: "1px 5px" }}>
                          {c.copy_enabled ? "COPY ON" : "COPY OFF"}
                        </span>
                      </div>
                      <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 3 }}>{feeSummary(c)}</div>
                    </td>
                    <td className="mono">${parseFloat(c.equity||0).toFixed(2)}</td>
                    <td className="mono"><span className={c.today_pnl >= 0 ? "pnl-pos" : "pnl-neg"}>{pnlSign(c.today_pnl)}${parseFloat(c.today_pnl||0).toFixed(2)}</span></td>
                    <td className="mono"><span className={c.total_pnl >= 0 ? "pnl-pos" : "pnl-neg"}>{pnlSign(c.total_pnl)}${parseFloat(c.total_pnl||0).toFixed(2)}</span></td>
                    <td><span className={`badge ${c.status === "active" ? "bull" : "bear"}`}>{c.status}</span></td>
                    <td className="mono">
                      {parseFloat(c.pending_fee||0) > 0 ? (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                          <button className="btn btn-warning btn-xs" onClick={() => sendFeeInvoice(c.id, c.name, parseFloat(c.pending_fee))}
                            title="Create a Pesapal payment link">
                            Invoice ${parseFloat(c.pending_fee).toFixed(2)}
                          </button>
                          <button className="btn btn-ghost btn-xs" onClick={() => markFeePaidOffline(c.id, c.name, parseFloat(c.pending_fee))}
                            title="Paid outside Pesapal">Paid offline</button>
                        </div>
                      ) : <span style={{ color: "var(--text-muted)" }}>$0.00</span>}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        <button className="btn btn-ghost btn-xs" onClick={() => viewClientTrades(c)}>Trades</button>
                        <button className="btn btn-ghost btn-xs" onClick={() => copyPortalLink(c)} title="Copy portal link">Link</button>
                        <button className="btn btn-ghost btn-xs" onClick={() => regenerateLink(c.id, c.name)}>New link</button>
                        <button className="btn btn-ghost btn-xs" title="Change how this client is charged"
                          onClick={() => setFeeEdit({ id: c.id, name: c.name, fee_model: c.fee_model || "profit_split", performance_fee_pct: String(c.performance_fee_pct ?? 20), fixed_fee_amount: c.fixed_fee_amount ? String(c.fixed_fee_amount) : "" })}>Fees</button>
                        {c.status === "active"
                          ? <button className="btn btn-danger btn-xs" onClick={() => suspendClient(c.id, c.name)}>Suspend</button>
                          : <button className="btn btn-success btn-xs" onClick={() => reactivateClient(c.id)}>Reactivate</button>
                        }
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </>
  );
}
