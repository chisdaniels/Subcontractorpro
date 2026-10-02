import { useState } from "react";

// Collapsible Admin dashboard section, optionally with an All / Active /
// Inactive filter. Open/closed and the chosen filter are remembered per
// browser (a convenience only — the dashboard works without storage).
// `children` is called with the current filter: "all" | "active" | "inactive".
const STORE_KEY = "admin_sections";

function readStore() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function writeStore(id, patch) {
  try {
    const all = readStore();
    all[id] = { ...all[id], ...patch };
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {}
}

export function AdminSection({ id, title, summary, counts, hint, defaultOpen = false, children }) {
  const saved = readStore()[id] || {};
  const [open, setOpen] = useState(saved.open ?? defaultOpen);
  const [filter, setFilter] = useState(counts ? saved.filter || "all" : "all");

  function toggle() {
    setOpen(o => { writeStore(id, { open: !o }); return !o; });
  }
  function choose(f) {
    setFilter(f);
    writeStore(id, { filter: f });
  }

  const options = counts && [
    ["all", `All (${counts.active + counts.inactive})`],
    ["active", `Active (${counts.active})`],
    ["inactive", `Inactive (${counts.inactive})`],
  ];

  return (
    <section className="admin-section" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="admin-section-h">
        <button type="button" className="admin-section-toggle" aria-expanded={open} aria-controls={`${id}-body`} onClick={toggle}>
          <span style={{ minWidth: 0 }}>
            {title}
            {summary && <span className="admin-section-summary">{summary}</span>}
          </span>
          <span aria-hidden="true" className="admin-section-caret">{open ? "▾" : "▸"}</span>
        </button>
      </h2>
      {open && (
        <div id={`${id}-body`} className="admin-section-body">
          {options && (
            <div className="admin-section-filter">
              <div role="group" aria-label={`Show ${title}`} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {options.map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className="btn btn-outline btn-sm"
                    aria-pressed={filter === value}
                    onClick={() => choose(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {hint && <div style={{ fontSize: "0.875rem", color: "#64748b" }}>{hint}</div>}
            </div>
          )}
          {children(filter)}
        </div>
      )}
    </section>
  );
}

// Applies an All / Active / Inactive filter to a list.
export function byStatus(list, filter, isActive) {
  if (filter === "active") return list.filter(isActive);
  if (filter === "inactive") return list.filter(x => !isActive(x));
  return list;
}
