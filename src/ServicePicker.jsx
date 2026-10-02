import { useEffect, useMemo, useRef, useState } from "react";
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

// Grouped <select> for picking one service. `allLabel` adds an "all" option (value "").
export function ServiceSelect({ catalog, value, onChange, id, allLabel, style }) {
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
          {g.services.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

// Service filter dropdown for the Find a Pro and Open Jobs filter bars. A
// custom listbox rather than a <select>, because browsers (macOS, iOS) ignore
// styling on <optgroup> labels and the category headings need to stand out.
// Values: "" (all), "group:<slug>" (a whole category), or a service name.
export function ServiceFilter({ catalog, value, onChange, id, allLabel = "All services" }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef(null);
  const btnRef = useRef(null);
  const listRef = useRef(null);
  const typed = useRef({ text: "", at: 0 });

  const { sections, items } = useMemo(() => {
    const items = [];
    const add = (val, label, kind) => { const it = { value: val, label, kind, idx: items.length }; items.push(it); return it; };
    const sections = [{ key: "_all", heading: null, items: [add("", allLabel, "top")] }];
    for (const g of catalog.groups) {
      if (!g.is_active) continue;
      const services = g.services.filter(s => s.is_active);
      if (!services.length) continue;
      sections.push({
        key: g.slug,
        heading: g.name,
        items: [add(`group:${g.slug}`, `All ${g.name}`, "group"), ...services.map(s => add(s.name, s.name, "service"))],
      });
    }
    return { sections, items };
  }, [catalog, allLabel]);

  const selectedIdx = items.findIndex(i => i.value === value);
  const currentLabel = selectedIdx >= 0 ? items[selectedIdx].label : value;
  const optId = idx => `${id}-opt-${idx}`;

  useEffect(() => {
    if (!open) return;
    setActive(selectedIdx >= 0 ? selectedIdx : 0);
    listRef.current?.focus();
    const onDown = e => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) document.getElementById(optId(active))?.scrollIntoView({ block: "nearest" });
  }, [open, active]); // eslint-disable-line react-hooks/exhaustive-deps

  function choose(idx) {
    onChange(items[idx].value);
    setOpen(false);
    btnRef.current?.focus();
  }

  function onButtonKey(e) {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      setOpen(true);
    }
  }

  function onListKey(e) {
    const last = items.length - 1;
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); setActive(a => Math.min(a + 1, last)); break;
      case "ArrowUp": e.preventDefault(); setActive(a => Math.max(a - 1, 0)); break;
      case "Home": e.preventDefault(); setActive(0); break;
      case "End": e.preventDefault(); setActive(last); break;
      case "PageDown": e.preventDefault(); setActive(a => Math.min(a + 8, last)); break;
      case "PageUp": e.preventDefault(); setActive(a => Math.max(a - 8, 0)); break;
      case "Enter": case " ": e.preventDefault(); choose(active); break;
      case "Escape": e.preventDefault(); setOpen(false); btnRef.current?.focus(); break;
      case "Tab": setOpen(false); break;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const now = Date.now();
          const t = typed.current;
          t.text = now - t.at > 700 ? e.key.toLowerCase() : t.text + e.key.toLowerCase();
          t.at = now;
          const start = t.text.length === 1 ? active + 1 : active;
          const order = [...items.slice(start), ...items.slice(0, start)];
          const hit = order.find(i => i.label.toLowerCase().startsWith(t.text));
          if (hit) setActive(hit.idx);
        }
    }
  }

  return (
    <div className="svc-filter" ref={rootRef}>
      <button
        id={id}
        ref={btnRef}
        type="button"
        className="svc-filter-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={`Filter by service: ${currentLabel}`}
        onClick={() => setOpen(o => !o)}
        onKeyDown={onButtonKey}
      >
        <span className="svc-filter-value">{currentLabel}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div
          id={`${id}-list`}
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          aria-label="Services"
          aria-activedescendant={optId(active)}
          className="svc-filter-menu"
          onKeyDown={onListKey}
        >
          {sections.map(sec => {
            const options = sec.items.map(it => (
              <div
                key={it.idx}
                id={optId(it.idx)}
                role="option"
                aria-selected={it.value === value}
                className={`svc-filter-opt ${it.kind}${it.idx === active ? " active" : ""}`}
                onPointerMove={() => { if (it.idx !== active) setActive(it.idx); }}
                onClick={() => choose(it.idx)}
              >
                <span>{it.label}</span>
                {it.value === value && <span aria-hidden="true">✓</span>}
              </div>
            ));
            if (!sec.heading) return <div key={sec.key}>{options}</div>;
            return (
              <div key={sec.key} role="group" aria-labelledby={`${id}-grp-${sec.key}`}>
                <div id={`${id}-grp-${sec.key}`} role="presentation" className="svc-filter-heading">{sec.heading}</div>
                {options}
              </div>
            );
          })}
        </div>
      )}
    </div>
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
