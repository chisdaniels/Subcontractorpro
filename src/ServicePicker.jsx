import { useMemo, useState } from "react";
import { searchCatalog } from "./services";

// Grouped, searchable multi-select with selected-service chips.
// With `withPrimary`, value[0] is the primary service.
export function ServicePicker({ catalog, value, onChange, idPrefix, withPrimary = false, label }) {
  const [query, setQuery] = useState("");
  const selected = new Set(value);
  const [expanded, setExpanded] = useState(() => new Set(
    catalog.groups.filter(g => g.services.some(s => selected.has(s.name))).map(g => g.slug)
  ));

  const results = useMemo(() => searchCatalog(catalog, query), [catalog, query]);
  const visibleGroups = catalog.groups
    .filter(g => g.is_active)
    .map(g => ({ ...g, services: g.services.filter(s => s.is_active) }))
    .filter(g => g.services.length);

  function toggle(name) {
    onChange(selected.has(name) ? value.filter(v => v !== name) : [...value, name]);
  }
  function makePrimary(name) {
    onChange([name, ...value.filter(v => v !== name)]);
  }
  function toggleGroup(slug) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug); else next.add(slug);
      return next;
    });
  }

  const option = (s, { showGroup = false, hint = null } = {}) => {
    const checked = selected.has(s.name);
    return (
      <label key={s.name} className={`svc-option${checked ? " checked" : ""}`}>
        <input type="checkbox" checked={checked} onChange={() => toggle(s.name)} />
        <span style={{ minWidth: 0 }}>
          <span style={{ display: "block", color: "#f1f5f9" }}>{s.name}</span>
          {(showGroup || hint || s.description) && (
            <span style={{ display: "block", fontSize: 11, color: "#64748b", lineHeight: 1.4 }}>
              {[showGroup && s.group?.name, hint, s.description].filter(Boolean).join(" · ")}
            </span>
          )}
        </span>
      </label>
    );
  };

  return (
    <div className="svc-picker">
      {label && <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>{label}</div>}
      {value.length > 0 && (
        <ul className="svc-chips" aria-label="Selected services">
          {value.map((name, i) => {
            const s = catalog.byName[name];
            const retired = s && (!s.is_active || s.group?.is_active === false);
            const isPrimary = withPrimary && i === 0;
            return (
              <li key={name} className={`svc-chip${isPrimary ? " primary" : ""}`}>
                {isPrimary && <span className="svc-chip-tag">★ Primary</span>}
                <span>{name}{retired && <span style={{ color: "#fca5a5" }}> (no longer offered)</span>}</span>
                {withPrimary && !isPrimary && (
                  <button type="button" className="svc-chip-btn" onClick={() => makePrimary(name)} aria-label={`Make ${name} your primary service`}>
                    Make primary
                  </button>
                )}
                <button type="button" className="svc-chip-btn" onClick={() => toggle(name)} aria-label={`Remove ${name}`}>✕</button>
              </li>
            );
          })}
        </ul>
      )}
      <label htmlFor={`${idPrefix}-search`} className="sr-only">Search services</label>
      <input
        id={`${idPrefix}-search`}
        type="search"
        placeholder="Search — e.g. drywall, janitorial, tree removal"
        value={query}
        onChange={e => setQuery(e.target.value)}
        autoComplete="off"
      />
      <div className="svc-list">
        {query.trim() ? (
          results.length ? (
            <div className="svc-results">
              {results.slice(0, 40).map(r => option(r.service, { showGroup: true, hint: r.matchedAlias ? `matches “${r.matchedAlias}”` : null }))}
            </div>
          ) : (
            <div style={{ color: "#64748b", fontSize: 13, padding: 10 }} role="status">
              No matching service. Try another word, or browse the categories.
            </div>
          )
        ) : (
          visibleGroups.map(g => {
            const count = g.services.filter(s => selected.has(s.name)).length;
            const open = expanded.has(g.slug);
            return (
              <div key={g.slug} className="svc-group">
                <button
                  type="button"
                  className="svc-group-btn"
                  aria-expanded={open}
                  aria-controls={`${idPrefix}-grp-${g.slug}`}
                  onClick={() => toggleGroup(g.slug)}
                >
                  <span>{g.name}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {count > 0 && <span className="badge" style={{ background: "#f59e0b", color: "#0f172a" }}>{count}</span>}
                    <span aria-hidden="true">{open ? "▴" : "▾"}</span>
                  </span>
                </button>
                {open && (
                  <div id={`${idPrefix}-grp-${g.slug}`} className="svc-group-body">
                    {g.services.map(s => option(s))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// Grouped <select>. `allLabel` adds an "all" option (value ""); `groupOptions`
// adds "All in <group>" options (value "group:<slug>") for filtering.
export function ServiceSelect({ catalog, value, onChange, id, allLabel, groupOptions = false, style }) {
  const groups = catalog.groups
    .filter(g => g.is_active)
    .map(g => ({ ...g, services: g.services.filter(s => s.is_active) }))
    .filter(g => g.services.length);
  const known = value === "" || value.startsWith("group:") || groups.some(g => g.services.some(s => s.name === value));
  return (
    <select id={id} value={value} onChange={e => onChange(e.target.value)} style={style}>
      {allLabel && <option value="">{allLabel}</option>}
      {!known && <option value={value}>{value}</option>}
      {groups.map(g => (
        <optgroup key={g.slug} label={g.name}>
          {groupOptions && <option value={`group:${g.slug}`}>All {g.name}</option>}
          {g.services.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

export function serviceFilterMatches(catalog, names, filter) {
  if (!filter) return true;
  if (filter.startsWith("group:")) {
    const slug = filter.slice(6);
    return names.some(n => catalog.byName[n]?.group_slug === slug);
  }
  return names.includes(filter);
}
