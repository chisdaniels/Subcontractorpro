import { useState } from "react";
import { supabase } from "./lib/supabase";
import { CREDENTIAL_STATUS_LABEL, contractorCredentials, verifiedCredentialLabels } from "./services";

export const VERIFIED_PRO_MEANING =
  "Verified pro: a SubcontractorPros admin reviewed this business's documents and approved the profile to accept jobs.";

const STATUS_STYLE = {
  verified:     { background: "#064e3b", color: "#34d399" },
  pending:      { background: "#422006", color: "#fbbf24" },
  expired:      { background: "#3b1515", color: "#f87171" },
  rejected:     { background: "#3b1515", color: "#f87171" },
  not_provided: { background: "#334155", color: "#94a3b8" },
};

export function CredentialStatusBadge({ status }) {
  return <span className="badge" style={STATUS_STYLE[status]}>{CREDENTIAL_STATUS_LABEL[status]}</span>;
}

// Documents live in a private bucket; each click mints a short-lived link.
export function DocLink({ path, children = "View document" }) {
  const [failed, setFailed] = useState(false);
  async function open(e) {
    e.preventDefault();
    setFailed(false);
    // Open synchronously so popup blockers treat it as a user action.
    const win = window.open("", "_blank");
    const { data, error } = await supabase.storage.from("credentials").createSignedUrl(path, 300);
    if (error || !data?.signedUrl) {
      win?.close();
      setFailed(true);
      return;
    }
    if (win) {
      win.opener = null;
      win.location.href = data.signedUrl;
    } else {
      window.location.href = data.signedUrl;
    }
  }
  return (
    <>
      <a href="#" onClick={open} style={{ color: "#34d399", textDecoration: "underline", fontSize: 12 }}>{children}</a>
      {failed && <span style={{ color: "#f87171", fontSize: 12 }}> — couldn't open this document</span>}
    </>
  );
}

function detailLine(item) {
  return [
    item.trade && `for ${item.trade}`,
    item.number && `#${item.number}`,
    item.carrier,
    item.amount && `$${Number(item.amount).toLocaleString()}`,
    item.jurisdiction && `Jurisdiction: ${item.jurisdiction}`,
    item.scope && `Scope: ${item.scope}`,
    item.expiresOn && `${item.status === "expired" ? "Expired" : "Expires"} ${item.expiresOn}`,
  ].filter(Boolean).join(" · ");
}

// Full detail — for the pro themselves and the customer who hired them.
export function CredentialList({ contractor, reqMap, showDocs = false, showNotes = false }) {
  const items = contractorCredentials(contractor, reqMap);
  return (
    <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
      {items.map(item => (
        <li key={item.key} style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, color: "#f1f5f9", fontSize: 13 }}>{item.label}</div>
            {detailLine(item) && <div style={{ fontSize: 12, color: "#94a3b8" }}>{detailLine(item)}</div>}
            {showNotes && item.review?.note && item.review.doc_path === item.docPath && (
              <div style={{ fontSize: 12, color: "#fbbf24" }}>Reviewer note: {item.review.note}</div>
            )}
            {showDocs && item.docPath && <DocLink path={item.docPath} />}
          </div>
          <CredentialStatusBadge status={item.status} />
        </li>
      ))}
    </ul>
  );
}

// Public view — only what an admin has verified, in general terms.
export function VerifiedCredentialBadges({ contractor }) {
  const labels = verifiedCredentialLabels(contractor);
  if (!labels.length) return null;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
      {labels.map(l => <span key={l} className="badge avail" style={{ fontWeight: 500 }}>✓ {l} verified</span>)}
    </div>
  );
}

export function VerifiedCredentialsSummary({ contractor }) {
  const labels = verifiedCredentialLabels(contractor);
  if (!labels.length) {
    return <div style={{ fontSize: 13, color: "#94a3b8" }}>No credentials verified yet.</div>;
  }
  return (
    <ul style={{ listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
      {labels.map(l => (
        <li key={l} style={{ fontSize: 14, color: "#f1f5f9" }}>
          <span style={{ color: "#34d399", fontWeight: 700 }}>✓</span> {l} verified
        </li>
      ))}
    </ul>
  );
}

// Admin: review each credential independently.
export function CredentialReviewPanel({ contractor, reqMap, onSave }) {
  const items = contractorCredentials(contractor, reqMap);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {items.map(item => (
        <CredentialReviewRow key={`${contractor.id}-${item.key}-${item.review?.reviewed_at || ""}`} item={item} onSave={review => onSave(contractor, item.key, review)} />
      ))}
    </div>
  );
}

function CredentialReviewRow({ item, onSave }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = item.review && item.review.doc_path === item.docPath;
  const [form, setForm] = useState({
    status: current && item.review.status ? item.review.status : "verified",
    jurisdiction: item.review?.jurisdiction || "",
    scope: item.review?.scope || "",
    expires_on: item.review?.expires_on || item.expiresOn || "",
    note: item.review?.note || "",
  });
  const inputId = s => `cr-${item.key.replace(/[^a-z0-9]+/gi, "-")}-${s}`;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    const saved = await onSave({
      status: form.status,
      jurisdiction: form.jurisdiction.trim() || null,
      scope: form.scope.trim() || null,
      expires_on: form.expires_on || null,
      note: form.note.trim() || null,
      doc_path: item.docPath,
    });
    setBusy(false);
    if (saved) setOpen(false);
  }

  return (
    <div style={{ background: "#0f172a", borderRadius: 10, padding: 12, fontSize: 13 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 700, color: "#f1f5f9" }}>{item.label}</div>
          {detailLine(item) && <div style={{ fontSize: 12, color: "#94a3b8" }}>{detailLine(item)}</div>}
          {item.docPath
            ? <DocLink path={item.docPath} />
            : <span style={{ fontSize: 12, color: "#64748b" }}>No document uploaded</span>}
          {item.review?.note && <div style={{ fontSize: 12, color: "#fbbf24", marginTop: 4 }}>Note: {item.review.note}</div>}
          {item.review?.reviewed_at && current && (
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>Reviewed {new Date(item.review.reviewed_at).toLocaleString()}</div>
          )}
          {item.review && !current && item.docPath && (
            <div style={{ fontSize: 11, color: "#fbbf24", marginTop: 2 }}>New file uploaded since the last review.</div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <CredentialStatusBadge status={item.status} />
          {item.docPath && (
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setOpen(o => !o)} aria-expanded={open}>
              {open ? "Close" : "Review"}
            </button>
          )}
        </div>
      </div>
      {open && (
        <form onSubmit={submit} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }} className="job-grid">
          <div>
            <label htmlFor={inputId("status")} className="field-label">Decision</label>
            <select id={inputId("status")} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
              <option value="verified">Verified — evidence checked</option>
              <option value="rejected">Rejected</option>
              <option value="pending">Pending — needs more review</option>
            </select>
          </div>
          <div>
            <label htmlFor={inputId("exp")} className="field-label">Expires</label>
            <input id={inputId("exp")} type="date" value={form.expires_on} onChange={e => setForm(f => ({ ...f, expires_on: e.target.value }))} />
          </div>
          <div>
            <label htmlFor={inputId("jur")} className="field-label">Jurisdiction</label>
            <input id={inputId("jur")} placeholder="e.g. TX, or Austin, TX" value={form.jurisdiction} onChange={e => setForm(f => ({ ...f, jurisdiction: e.target.value }))} />
          </div>
          <div>
            <label htmlFor={inputId("scope")} className="field-label">Covered scope</label>
            <input id={inputId("scope")} placeholder="e.g. Master electrician" value={form.scope} onChange={e => setForm(f => ({ ...f, scope: e.target.value }))} />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <label htmlFor={inputId("note")} className="field-label">Note for the provider</label>
            <input id={inputId("note")} placeholder="e.g. Certificate is expired — upload the renewal" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
          </div>
          <div style={{ gridColumn: "1 / -1", display: "flex", gap: 8 }}>
            <button type="submit" className="btn btn-gold btn-sm" disabled={busy}>{busy ? "Saving…" : "Save review"}</button>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
