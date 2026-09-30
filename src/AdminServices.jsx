import { useMemo, useState } from "react";
import { supabase } from "./lib/supabase";
import {
  APPLICABILITY, CREDENTIAL_TYPES, JURISDICTION_LEVELS, REQUIREMENTS_FALLBACK, STATE_CODES,
  normalize, searchCatalog,
} from "./services";

const APPLICABILITY_LABEL = { required: "Required", not_required: "Not required", conditional: "Conditional", unknown: "Unknown" };
const EMPTY_RULE = {
  jurisdiction_level: "state", state_code: "", county: "", city: "", credential_type: "license",
  applicability: "required", credential_label: "", conditions: "", source_url: "",
  effective_date: "", reviewed_at: new Date().toISOString().slice(0, 10), notes: "",
};

function contractorTrades(c) {
  return Array.isArray(c?.trades) && c.trades.length ? c.trades : c?.trade ? [c.trade] : [];
}

export default function AdminServices({ catalog, rules, contractors, jobs, adminList, user, notify, reload }) {
  const [filter, setFilter] = useState("");
  const [openGroups, setOpenGroups] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // service name
  const [editForm, setEditForm] = useState(null);
  const [rulesFor, setRulesFor] = useState(null); // service name
  const [ruleForm, setRuleForm] = useState(EMPTY_RULE);
  const [newService, setNewService] = useState({ name: "", group_slug: "" });
  const [newGroupName, setNewGroupName] = useState("");
  const [renamingGroup, setRenamingGroup] = useState(null); // { slug, name }
  const [audit, setAudit] = useState(null);

  const usage = useMemo(() => {
    const u = {};
    const get = n => (u[n] ||= { pros: 0, openJobs: 0, allJobs: 0 });
    for (const c of contractors) for (const t of new Set(contractorTrades(c))) get(t).pros++;
    for (const j of jobs) {
      const e = get(j.trade);
      e.allJobs++;
      if (!j.deleted_at && !j.accepted_by) e.openJobs++;
    }
    return u;
  }, [contractors, jobs]);

  const rulesByService = useMemo(() => {
    const m = {};
    for (const r of rules) (m[r.trade_name] ||= []).push(r);
    return m;
  }, [rules]);

  const filterHits = useMemo(
    () => (filter.trim() ? searchCatalog(catalog, filter, { includeInactive: true }).map(r => r.service) : null),
    [catalog, filter]
  );

  async function run(fn, success) {
    setBusy(true);
    try {
      await fn();
      await reload();
      if (success) notify(success);
      return true;
    } catch (err) {
      notify(err.message || String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const check = ({ error }) => { if (error) throw new Error(error.message); };

  function aliasOwner(term) {
    const n = normalize(term);
    return catalog.list.find(s => s.aliases.some(a => normalize(a) === n)) || null;
  }
  function serviceNamed(term) {
    const n = normalize(term);
    return catalog.list.find(s => normalize(s.name) === n) || null;
  }

  // ---------- Groups ----------
  async function addGroup(e) {
    e.preventDefault();
    const name = newGroupName.trim();
    if (!name) return;
    if (catalog.groups.some(g => normalize(g.name) === normalize(name))) { notify(`A group named "${name}" already exists.`); return; }
    let slug = normalize(name).replace(/ /g, "-").slice(0, 40) || "group";
    while (catalog.groups.some(g => g.slug === slug)) slug += "-2";
    const sort_order = Math.max(0, ...catalog.groups.filter(g => g.slug !== "__other").map(g => g.sort_order)) + 10;
    if (await run(async () => check(await supabase.from("service_groups").insert({ slug, name, sort_order })), `Added group ${name}.`)) {
      setNewGroupName("");
    }
  }

  async function saveGroupName(e) {
    e.preventDefault();
    const name = renamingGroup.name.trim();
    if (!name) return;
    if (await run(async () => check(await supabase.from("service_groups").update({ name }).eq("slug", renamingGroup.slug)), "Group renamed.")) {
      setRenamingGroup(null);
    }
  }

  async function reorder(table, key, items, index, dir) {
    const target = index + dir;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    await run(async () => {
      for (let i = 0; i < next.length; i++) {
        const want = (i + 1) * 10;
        if (next[i].sort_order !== want) check(await supabase.from(table).update({ sort_order: want }).eq(key, next[i][key]));
      }
    });
  }

  async function toggleGroupActive(g) {
    const live = g.services.filter(s => s.is_active).length;
    if (g.is_active && !confirm(`Hide the "${g.name}" group? Its ${live} active service(s) will stop appearing in pickers. Existing profiles and jobs keep them.`)) return;
    await run(async () => check(await supabase.from("service_groups").update({ is_active: !g.is_active }).eq("slug", g.slug)),
      g.is_active ? `Hid ${g.name}.` : `Showing ${g.name}.`);
  }

  async function deleteGroup(g) {
    if (!confirm(`Delete the empty group "${g.name}"?`)) return;
    await run(async () => check(await supabase.from("service_groups").delete().eq("slug", g.slug)), `Deleted ${g.name}.`);
  }

  // ---------- Services ----------
  async function addService(e) {
    e.preventDefault();
    const name = newService.name.trim();
    if (!name || !newService.group_slug) { notify("Enter a name and pick a group."); return; }
    const existing = serviceNamed(name);
    if (existing) { notify(`"${existing.name}" already exists.`); return; }
    const owner = aliasOwner(name);
    if (owner) { notify(`"${name}" is already a search term for ${owner.name}. Edit that service instead, or remove the alias first.`); return; }
    const group = catalog.groups.find(g => g.slug === newService.group_slug);
    const sort_order = Math.max(0, ...(group?.services || []).map(s => s.sort_order)) + 10;
    if (await run(async () => check(await supabase.from("trade_types").insert({
      name, group_slug: newService.group_slug, sort_order, is_active: true, trade_license_label: null, requires_bond: false,
    })), `Added ${name}. Use Edit to add search terms or a document policy.`)) {
      setNewService({ name: "", group_slug: newService.group_slug });
    }
  }

  function openEdit(s) {
    setRulesFor(null);
    setEditing(s.name);
    setEditForm({
      name: s.name,
      group_slug: s.group_slug || "",
      description: s.description || "",
      aliases: s.aliases.join(", "),
      originalAliases: s.aliases,
      license_label: s.trade_license_label || "",
      requires_bond: !!s.requires_bond,
    });
  }

  async function saveEdit(e) {
    e.preventDefault();
    const original = editing;
    const name = editForm.name.trim();
    if (!name) { notify("Name is required."); return; }
    const target = serviceNamed(name);
    const merging = target && target.name !== original;
    if (merging && !confirm(
      `"${target.name}" already exists. Merge "${original}" into it?\n\n` +
      `Providers, jobs, licenses, rules and search terms move to "${target.name}", and "${original}" becomes a search term. ` +
      `"${target.name}" keeps its own settings. This can't be undone automatically.`
    )) return;
    if (!merging) {
      const owner = aliasOwner(name);
      if (owner && owner.name !== original) { notify(`"${name}" is a search term for ${owner.name}. Remove it there first.`); return; }
    }
    const finalName = merging ? target.name : name;

    const desired = [...new Set(editForm.aliases.split(",").map(a => a.trim()).filter(Boolean))];
    const toRemove = editForm.originalAliases.filter(a => !desired.some(d => normalize(d) === normalize(a)));
    const toAdd = desired.filter(d => !editForm.originalAliases.some(a => normalize(a) === normalize(d)));
    for (const a of toAdd) {
      if (normalize(a) === normalize(finalName)) { notify(`"${a}" is the service name itself — no need to add it as a search term.`); return; }
      const other = serviceNamed(a);
      if (other && other.name !== original) { notify(`"${a}" is already its own service.`); return; }
      const owner = aliasOwner(a);
      if (owner && owner.name !== original) { notify(`"${a}" is already a search term for ${owner.name}.`); return; }
    }

    const saved = await run(async () => {
      if (finalName !== original || merging) {
        check(await supabase.rpc("rename_trade", { old_name: original, new_name: finalName }));
      }
      if (!merging) {
        check(await supabase.from("trade_types").update({
          group_slug: editForm.group_slug || null,
          description: editForm.description.trim() || null,
          trade_license_label: editForm.license_label.trim() || null,
          requires_bond: !!editForm.requires_bond,
        }).eq("name", finalName));
      }
      if (toRemove.length) check(await supabase.from("trade_aliases").delete().in("alias", toRemove));
      if (toAdd.length) check(await supabase.from("trade_aliases").insert(toAdd.map(alias => ({ alias, trade_name: finalName }))));
    }, merging ? `Merged ${original} into ${finalName}.` : `Saved ${finalName}.`);
    if (saved) { setEditing(null); setEditForm(null); }
  }

  async function toggleServiceActive(s) {
    const u = usage[s.name] || { pros: 0, openJobs: 0 };
    if (s.is_active && !confirm(
      `Deactivate "${s.name}"?\n\n${u.pros} provider(s) and ${u.openJobs} open job(s) use it. They keep it and it still displays on them, ` +
      `but no one can pick it for new profiles or jobs.`
    )) return;
    await run(async () => check(await supabase.from("trade_types").update({ is_active: !s.is_active }).eq("name", s.name)),
      s.is_active ? `Deactivated ${s.name}.` : `Activated ${s.name}.`);
  }

  async function deleteService(s) {
    if (!confirm(`Permanently delete "${s.name}"? No providers or jobs use it.`)) return;
    await run(async () => check(await supabase.from("trade_types").delete().eq("name", s.name)), `Deleted ${s.name}.`);
  }

  // ---------- Requirement rules ----------
  function openRules(s) {
    setEditing(null);
    setRulesFor(rulesFor === s.name ? null : s.name);
    setRuleForm(EMPTY_RULE);
  }

  async function addRule(e) {
    e.preventDefault();
    const f = ruleForm;
    if (f.jurisdiction_level !== "federal" && !f.state_code) { notify("Pick a state."); return; }
    if (f.jurisdiction_level === "county" && !f.county.trim()) { notify("Enter the county."); return; }
    if (f.jurisdiction_level === "city" && !f.city.trim()) { notify("Enter the city."); return; }
    if (f.applicability !== "unknown" && (!f.source_url.trim() || !f.reviewed_at)) {
      notify("Every determination needs an authoritative source URL and a review date."); return;
    }
    const row = {
      trade_name: rulesFor,
      jurisdiction_level: f.jurisdiction_level,
      state_code: f.jurisdiction_level === "federal" ? null : f.state_code,
      county: f.jurisdiction_level === "county" ? f.county.trim() : null,
      city: f.jurisdiction_level === "city" ? f.city.trim() : null,
      credential_type: f.credential_type,
      applicability: f.applicability,
      credential_label: f.credential_label.trim() || null,
      conditions: f.conditions.trim() || null,
      source_url: f.source_url.trim() || null,
      effective_date: f.effective_date || null,
      reviewed_at: f.reviewed_at || null,
      reviewed_by: user.id,
      notes: f.notes.trim() || null,
    };
    if (await run(async () => check(await supabase.from("requirement_rules").insert(row)), "Rule added.")) {
      setRuleForm(EMPTY_RULE);
    }
  }

  async function deleteRule(r) {
    if (!confirm("Delete this requirement rule?")) return;
    await run(async () => check(await supabase.from("requirement_rules").delete().eq("id", r.id)), "Rule deleted.");
  }

  async function toggleAudit() {
    if (audit) { setAudit(null); return; }
    const { data, error } = await supabase.from("admin_audit_log").select("*").order("created_at", { ascending: false }).limit(40);
    if (error) { notify("Audit log load failed: " + error.message); return; }
    setAudit(data || []);
  }

  // ---------- Render ----------
  const realGroups = catalog.groups.filter(g => g.slug !== "__other");
  const activeCount = catalog.list.filter(s => s.is_active).length;

  const ruleLine = r => [
    r.jurisdiction_level === "federal" ? "Federal" : [r.city, r.county && `${r.county} County`, r.state_code].filter(Boolean).join(", "),
    `${r.credential_type[0].toUpperCase()}${r.credential_type.slice(1)}: ${APPLICABILITY_LABEL[r.applicability]}`,
    r.credential_label,
    r.conditions,
  ].filter(Boolean).join(" · ");

  function serviceRow(s, index, siblings, showGroup = false) {
    const u = usage[s.name] || { pros: 0, openJobs: 0, allJobs: 0 };
    const sRules = rulesByService[s.name] || [];

    if (editing === s.name && editForm) {
      return (
        <form key={s.name} onSubmit={saveEdit} className="admin-svc-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
          <div className="job-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label htmlFor="svc-edit-name" className="field-label">Service name</label>
              <input id="svc-edit-name" required value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <label htmlFor="svc-edit-group" className="field-label">Group</label>
              <select id="svc-edit-group" value={editForm.group_slug} onChange={e => setEditForm(f => ({ ...f, group_slug: e.target.value }))}>
                {realGroups.map(g => <option key={g.slug} value={g.slug}>{g.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="svc-edit-desc" className="field-label">Short description <span style={{ color: "#64748b" }}>(helper text in pickers)</span></label>
            <input id="svc-edit-desc" value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} />
          </div>
          <div>
            <label htmlFor="svc-edit-aliases" className="field-label">Search terms / aliases <span style={{ color: "#64748b" }}>(comma-separated — old names and familiar wording)</span></label>
            <textarea id="svc-edit-aliases" rows={2} value={editForm.aliases} onChange={e => setEditForm(f => ({ ...f, aliases: e.target.value }))} />
          </div>
          <div style={{ border: "1px solid #334155", borderRadius: 8, padding: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#f59e0b", marginBottom: 4 }}>PLATFORM DOCUMENT POLICY</div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>
              What SubcontractorPros asks providers of this service to upload. This is platform policy, not a statement of what the law requires — use Rules for jurisdiction requirements.
            </div>
            <label htmlFor="svc-edit-lic" className="field-label">Trade license upload label <span style={{ color: "#64748b" }}>(blank = no trade license upload)</span></label>
            <input id="svc-edit-lic" placeholder="e.g. State Plumbing License" value={editForm.license_label} onChange={e => setEditForm(f => ({ ...f, license_label: e.target.value }))} />
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#f1f5f9", cursor: "pointer", marginTop: 8 }}>
              <input type="checkbox" checked={editForm.requires_bond} onChange={e => setEditForm(f => ({ ...f, requires_bond: e.target.checked }))} style={{ width: "auto", accentColor: "#f59e0b" }} />
              Require a surety bond upload
            </label>
          </div>
          <div style={{ fontSize: 12, color: "#64748b" }}>
            To merge a duplicate, rename it to the exact name of the service to keep.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="submit" className="btn btn-gold btn-sm" disabled={busy}>Save</button>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => { setEditing(null); setEditForm(null); }}>Cancel</button>
          </div>
        </form>
      );
    }

    return (
      <div key={s.name} className="admin-svc-row" style={{ opacity: s.is_active ? 1 : 0.65, flexDirection: "column", alignItems: "stretch" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600 }}>
              {s.name}
              {!s.is_active && <span className="badge unavail" style={{ marginLeft: 6 }}>Inactive</span>}
              {showGroup && s.group && <span style={{ color: "#64748b", fontWeight: 400 }}> · {s.group.name}</span>}
            </div>
            <div style={{ fontSize: 12, color: "#94a3b8" }}>
              {u.pros} pro{u.pros === 1 ? "" : "s"} · {u.openJobs} open job{u.openJobs === 1 ? "" : "s"}
              {" · "}
              Platform docs: {s.trade_license_label ? `${s.trade_license_label} upload` : "no trade license upload"}{s.requires_bond ? " + bond" : ""}
              {" · "}
              {sRules.length ? `${sRules.length} jurisdiction rule${sRules.length === 1 ? "" : "s"}` : "no reviewed rules"}
            </div>
            {s.aliases.length > 0 && (
              <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
                Also found as: {s.aliases.slice(0, 8).join(", ")}{s.aliases.length > 8 ? ` +${s.aliases.length - 8}` : ""}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {siblings && (
              <>
                <button type="button" className="btn btn-outline btn-sm" disabled={busy || index === 0} onClick={() => reorder("trade_types", "name", siblings, index, -1)} aria-label={`Move ${s.name} up`}>↑</button>
                <button type="button" className="btn btn-outline btn-sm" disabled={busy || index === siblings.length - 1} onClick={() => reorder("trade_types", "name", siblings, index, 1)} aria-label={`Move ${s.name} down`}>↓</button>
              </>
            )}
            <button type="button" className="btn btn-outline btn-sm" onClick={() => openEdit(s)}>Edit</button>
            <button type="button" className="btn btn-outline btn-sm" onClick={() => openRules(s)} aria-expanded={rulesFor === s.name}>Rules ({sRules.length})</button>
            <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => toggleServiceActive(s)}>{s.is_active ? "Deactivate" : "Activate"}</button>
            {u.pros === 0 && u.allJobs === 0 && (
              <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => deleteService(s)} style={{ borderColor: "#f87171", color: "#fca5a5" }}>Delete</button>
            )}
          </div>
        </div>

        {rulesFor === s.name && (
          <div style={{ marginTop: 10, borderTop: "1px solid #334155", paddingTop: 10 }}>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>
              Legal requirements by jurisdiction. Only record a determination you've confirmed from an authoritative source.
              Anywhere without a rule shows: “{REQUIREMENTS_FALLBACK}”
            </div>
            {sRules.length === 0 && <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 8 }}>No rules yet.</div>}
            {sRules.map(r => (
              <div key={r.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, padding: "6px 0", borderBottom: "1px solid #1e293b", flexWrap: "wrap" }}>
                <div style={{ minWidth: 0, flex: 1, color: "#f1f5f9" }}>
                  {ruleLine(r)}
                  <div style={{ color: "#64748b" }}>
                    {r.source_url && <a href={r.source_url} target="_blank" rel="noreferrer" style={{ color: "#34d399" }}>source</a>}
                    {r.reviewed_at && ` · reviewed ${r.reviewed_at}`}
                    {r.effective_date && ` · effective ${r.effective_date}`}
                    {r.notes && ` · ${r.notes}`}
                  </div>
                </div>
                <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => deleteRule(r)}>Delete</button>
              </div>
            ))}
            <form onSubmit={addRule} className="job-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
              <div>
                <label htmlFor="rule-level" className="field-label">Jurisdiction level</label>
                <select id="rule-level" value={ruleForm.jurisdiction_level} onChange={e => setRuleForm(f => ({ ...f, jurisdiction_level: e.target.value }))}>
                  {JURISDICTION_LEVELS.map(l => <option key={l} value={l}>{l[0].toUpperCase() + l.slice(1)}</option>)}
                </select>
              </div>
              {ruleForm.jurisdiction_level !== "federal" && (
                <div>
                  <label htmlFor="rule-state" className="field-label">State</label>
                  <select id="rule-state" value={ruleForm.state_code} onChange={e => setRuleForm(f => ({ ...f, state_code: e.target.value }))}>
                    <option value="">Pick a state</option>
                    {STATE_CODES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              )}
              {ruleForm.jurisdiction_level === "county" && (
                <div>
                  <label htmlFor="rule-county" className="field-label">County</label>
                  <input id="rule-county" value={ruleForm.county} onChange={e => setRuleForm(f => ({ ...f, county: e.target.value }))} />
                </div>
              )}
              {ruleForm.jurisdiction_level === "city" && (
                <div>
                  <label htmlFor="rule-city" className="field-label">City</label>
                  <input id="rule-city" value={ruleForm.city} onChange={e => setRuleForm(f => ({ ...f, city: e.target.value }))} />
                </div>
              )}
              <div>
                <label htmlFor="rule-type" className="field-label">Credential</label>
                <select id="rule-type" value={ruleForm.credential_type} onChange={e => setRuleForm(f => ({ ...f, credential_type: e.target.value }))}>
                  {CREDENTIAL_TYPES.map(t => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="rule-app" className="field-label">Applicability</label>
                <select id="rule-app" value={ruleForm.applicability} onChange={e => setRuleForm(f => ({ ...f, applicability: e.target.value }))}>
                  {APPLICABILITY.map(a => <option key={a} value={a}>{APPLICABILITY_LABEL[a]}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="rule-label" className="field-label">Credential name</label>
                <input id="rule-label" placeholder="e.g. Texas Master Plumber License" value={ruleForm.credential_label} onChange={e => setRuleForm(f => ({ ...f, credential_label: e.target.value }))} />
              </div>
              <div>
                <label htmlFor="rule-cond" className="field-label">Scope / conditions</label>
                <input id="rule-cond" placeholder="e.g. Jobs over $2,500" value={ruleForm.conditions} onChange={e => setRuleForm(f => ({ ...f, conditions: e.target.value }))} />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label htmlFor="rule-src" className="field-label">Authoritative source URL {ruleForm.applicability !== "unknown" && "*"}</label>
                <input id="rule-src" type="url" placeholder="https://… (licensing board or statute)" value={ruleForm.source_url} onChange={e => setRuleForm(f => ({ ...f, source_url: e.target.value }))} />
              </div>
              <div>
                <label htmlFor="rule-reviewed" className="field-label">Reviewed on {ruleForm.applicability !== "unknown" && "*"}</label>
                <input id="rule-reviewed" type="date" value={ruleForm.reviewed_at} onChange={e => setRuleForm(f => ({ ...f, reviewed_at: e.target.value }))} />
              </div>
              <div>
                <label htmlFor="rule-eff" className="field-label">Effective date</label>
                <input id="rule-eff" type="date" value={ruleForm.effective_date} onChange={e => setRuleForm(f => ({ ...f, effective_date: e.target.value }))} />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <label htmlFor="rule-notes" className="field-label">Notes</label>
                <input id="rule-notes" value={ruleForm.notes} onChange={e => setRuleForm(f => ({ ...f, notes: e.target.value }))} />
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <button type="submit" className="btn btn-gold btn-sm" disabled={busy}>Add rule</button>
              </div>
            </form>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 32 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>
        Services &amp; Categories ({activeCount} active · {catalog.list.length - activeCount} inactive)
      </h2>
      <p style={{ fontSize: 13, color: "#64748b", marginBottom: 12 }}>
        Groups organize the pickers. Deactivating a service hides it from new profiles and jobs; existing ones keep it.
      </p>

      <form onSubmit={addService} className="card" style={{ padding: 14, marginBottom: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <label htmlFor="svc-new-name" className="sr-only">New service name</label>
        <input id="svc-new-name" placeholder="Add a service (e.g. Chimney Sweep)" value={newService.name} onChange={e => setNewService(n => ({ ...n, name: e.target.value }))} style={{ flex: 2, minWidth: 200 }} />
        <label htmlFor="svc-new-group" className="sr-only">Group for the new service</label>
        <select id="svc-new-group" value={newService.group_slug} onChange={e => setNewService(n => ({ ...n, group_slug: e.target.value }))} style={{ flex: 1, minWidth: 180 }}>
          <option value="">Pick a group</option>
          {realGroups.map(g => <option key={g.slug} value={g.slug}>{g.name}</option>)}
        </select>
        <button type="submit" className="btn btn-gold" disabled={busy}>Add Service</button>
      </form>

      <form onSubmit={addGroup} className="card" style={{ padding: 14, marginBottom: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <label htmlFor="grp-new-name" className="sr-only">New group name</label>
        <input id="grp-new-name" placeholder="Add a group" value={newGroupName} onChange={e => setNewGroupName(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
        <button type="submit" className="btn btn-outline" disabled={busy}>Add Group</button>
      </form>

      <label htmlFor="svc-admin-filter" className="sr-only">Find a service</label>
      <input id="svc-admin-filter" type="search" placeholder="Find a service or search term…" value={filter} onChange={e => setFilter(e.target.value)} style={{ marginBottom: 10 }} />

      {filterHits ? (
        <div style={{ display: "grid", gap: 6 }}>
          {filterHits.length === 0 && <div style={{ color: "#475569", padding: 12 }}>No match.</div>}
          {filterHits.map(s => serviceRow(s, 0, null, true))}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 8 }}>
          {catalog.groups.map((g, gi) => {
            const open = openGroups.has(g.slug);
            const isReal = g.slug !== "__other";
            const active = g.services.filter(s => s.is_active).length;
            return (
              <div key={g.slug} className="card" style={{ padding: 0, opacity: g.is_active ? 1 : 0.7 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: 12, flexWrap: "wrap" }}>
                  {renamingGroup?.slug === g.slug ? (
                    <form onSubmit={saveGroupName} style={{ display: "flex", gap: 6, flex: 1, minWidth: 220 }}>
                      <label htmlFor="grp-rename" className="sr-only">Group name</label>
                      <input id="grp-rename" value={renamingGroup.name} onChange={e => setRenamingGroup(r => ({ ...r, name: e.target.value }))} />
                      <button type="submit" className="btn btn-gold btn-sm" disabled={busy}>Save</button>
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => setRenamingGroup(null)}>Cancel</button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className="svc-group-btn"
                      style={{ flex: 1, minWidth: 200, background: "transparent", border: "none", padding: 0 }}
                      aria-expanded={open}
                      onClick={() => setOpenGroups(prev => { const n = new Set(prev); if (n.has(g.slug)) n.delete(g.slug); else n.add(g.slug); return n; })}
                    >
                      <span>
                        {g.name}
                        {!g.is_active && <span className="badge unavail" style={{ marginLeft: 6 }}>Hidden</span>}
                        <span style={{ color: "#64748b", fontWeight: 400, fontSize: 12 }}> · {active} active / {g.services.length}</span>
                      </span>
                      <span aria-hidden="true">{open ? "▴" : "▾"}</span>
                    </button>
                  )}
                  {isReal && renamingGroup?.slug !== g.slug && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button type="button" className="btn btn-outline btn-sm" disabled={busy || gi === 0} onClick={() => reorder("service_groups", "slug", realGroups, gi, -1)} aria-label={`Move ${g.name} up`}>↑</button>
                      <button type="button" className="btn btn-outline btn-sm" disabled={busy || gi === realGroups.length - 1} onClick={() => reorder("service_groups", "slug", realGroups, gi, 1)} aria-label={`Move ${g.name} down`}>↓</button>
                      <button type="button" className="btn btn-outline btn-sm" onClick={() => setRenamingGroup({ slug: g.slug, name: g.name })}>Rename</button>
                      <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => toggleGroupActive(g)}>{g.is_active ? "Hide" : "Show"}</button>
                      {g.services.length === 0 && <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => deleteGroup(g)}>Delete</button>}
                    </div>
                  )}
                </div>
                {open && (
                  <div style={{ display: "grid", gap: 6, padding: "0 12px 12px" }}>
                    {g.services.length === 0 && <div style={{ color: "#475569", fontSize: 13 }}>No services in this group.</div>}
                    {g.services.map((s, i) => serviceRow(s, i, isReal ? g.services : null))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <button type="button" className="btn btn-outline btn-sm" style={{ marginTop: 12 }} onClick={toggleAudit} aria-expanded={!!audit}>
        {audit ? "Hide change history" : "Show change history"}
      </button>
      {audit && (
        <div className="card" style={{ padding: 12, marginTop: 8, fontSize: 12 }}>
          {audit.length === 0 && <div style={{ color: "#475569" }}>No changes recorded yet.</div>}
          {audit.map(a => {
            const who = adminList.find(x => x.user_id === a.actor)?.email || (a.actor ? a.actor.slice(0, 8) : "system");
            const proName = contractors.find(c => String(c.id) === a.row_key)?.name || `contractor ${a.row_key}`;
            const target = a.table_name === "contractors"
              ? `profile approval change on ${proName}`
              : a.table_name === "contractor_credentials"
                ? `credential review on ${proName}`
                : a.table_name === "contractor_denials"
                  ? `denial ${a.action === "delete" ? "cleared" : "recorded"} for ${proName}`
                  : `${a.table_name.replace(/_/g, " ")} ${a.action}: ${a.row_key}`;
            return (
              <div key={a.id} style={{ padding: "4px 0", borderBottom: "1px solid #1e293b", color: "#cbd5e1" }}>
                <span style={{ color: "#64748b" }}>{new Date(a.created_at).toLocaleString()}</span> · {who} · {target}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
