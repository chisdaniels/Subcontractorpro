export const REQUIREMENTS_FALLBACK = "License requirements vary by location and scope of work.";

export const CREDENTIAL_TYPES = ["license", "insurance", "bond", "registration", "certification"];
export const APPLICABILITY = ["required", "not_required", "conditional", "unknown"];
export const JURISDICTION_LEVELS = ["federal", "state", "county", "city"];

const STATES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
const STATE_BY_NAME = Object.fromEntries(Object.entries(STATES).map(([code, name]) => [name.toLowerCase(), code]));
export const STATE_CODES = Object.keys(STATES);

export function parseLocation(location) {
  const parts = String(location || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!parts.length) return { city: null, stateCode: null };
  const last = parts[parts.length - 1].replace(/\s+\d{5}(-\d{4})?$/, "");
  const upper = last.toUpperCase();
  const stateCode = STATES[upper] ? upper : STATE_BY_NAME[last.toLowerCase()] || null;
  const city = stateCode ? (parts.length > 1 ? parts[0] : null) : parts[0];
  return { city, stateCode };
}

function stem(word) {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}
export function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(stem)
    .join(" ");
}

// services: trade_types rows; groups: service_groups rows; aliases: trade_aliases rows.
export function buildCatalog(services, groups, aliases) {
  const aliasesByName = {};
  for (const a of aliases || []) (aliasesByName[a.trade_name] ||= []).push(a.alias);
  const groupBySlug = Object.fromEntries((groups || []).map(g => [g.slug, g]));
  const list = (services || []).map(s => ({
    ...s,
    aliases: (aliasesByName[s.name] || []).sort((x, y) => x.localeCompare(y)),
    group: groupBySlug[s.group_slug] || null,
  }));
  const byName = Object.fromEntries(list.map(s => [s.name, s]));
  const orderedGroups = [...(groups || [])]
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
    .map(g => ({
      ...g,
      services: list
        .filter(s => s.group_slug === g.slug)
        .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    }));
  const ungrouped = list.filter(s => !s.group).sort((a, b) => a.name.localeCompare(b.name));
  if (ungrouped.length) orderedGroups.push({ slug: "__other", name: "Other", sort_order: 9999, is_active: true, services: ungrouped });
  const activeNames = orderedGroups
    .filter(g => g.is_active)
    .flatMap(g => g.services.filter(s => s.is_active).map(s => s.name));
  const searchKeys = list.map(s => ({
    name: s.name,
    keys: [s.name, ...s.aliases].map(k => ({ raw: k, norm: normalize(k) })),
    groupNorm: normalize(s.group?.name || ""),
  }));
  return { list, byName, groups: orderedGroups, activeNames, searchKeys };
}

// Returns [{ service, matchedAlias }] best-first.
export function searchCatalog(catalog, query, { includeInactive = false } = {}) {
  const nq = normalize(query);
  if (!nq) return [];
  const tokens = nq.split(" ");
  const results = [];
  for (const entry of catalog.searchKeys) {
    const service = catalog.byName[entry.name];
    if (!includeInactive && (!service.is_active || service.group?.is_active === false)) continue;
    let best = null;
    for (const k of entry.keys) {
      let score = 0;
      if (k.norm === nq) score = 100;
      else if (k.norm.startsWith(nq)) score = 80;
      else if (tokens.every(t => k.norm.split(" ").some(w => w.startsWith(t)))) score = 60;
      else if (k.norm.includes(nq)) score = 40;
      if (score && (!best || score > best.score)) best = { score, key: k.raw };
    }
    if (!best && tokens.every(t => entry.groupNorm.includes(t))) best = { score: 10, key: null };
    if (best) {
      const redundant = !best.key || normalize(service.name).includes(normalize(best.key));
      results.push({ service, score: best.score, matchedAlias: redundant ? null : best.key });
    }
  }
  return results.sort((a, b) => b.score - a.score || a.service.name.localeCompare(b.service.name));
}

// Legal requirement lookup for a service at a job location.
// Returns { items: [{ credentialType, applicability, label, rules, conflict }], stateCode } —
// empty items means no reviewed rule applies and callers show REQUIREMENTS_FALLBACK.
export function resolveRequirements(rules, serviceName, location) {
  const { city, stateCode } = parseLocation(location);
  const cityNorm = normalize(city);
  const matched = (rules || []).filter(r => {
    if (r.trade_name !== serviceName) return false;
    if (r.jurisdiction_level === "federal") return true;
    if (!stateCode || r.state_code !== stateCode) return false;
    if (r.jurisdiction_level === "state" || r.jurisdiction_level === "county") return true;
    return r.jurisdiction_level === "city" && cityNorm && normalize(r.city) === cityNorm;
  });
  const byType = {};
  for (const r of matched) (byType[r.credential_type] ||= []).push(r);
  const items = Object.entries(byType).map(([credentialType, rs]) => {
    // County can't be derived from "City, State", so county rules only ever make a requirement conditional.
    const decisive = rs.filter(r => r.jurisdiction_level !== "county" && r.applicability !== "unknown");
    const kinds = new Set(decisive.map(r => r.applicability));
    let applicability;
    let conflict = false;
    if (kinds.size > 1) { applicability = "unknown"; conflict = true; }
    else if (kinds.size === 1) applicability = [...kinds][0];
    else applicability = rs.some(r => r.jurisdiction_level === "county" && r.applicability !== "unknown") ? "conditional" : "unknown";
    if (applicability === "not_required" && rs.some(r => r.jurisdiction_level === "county" && r.applicability !== "not_required" && r.applicability !== "unknown")) {
      applicability = "conditional";
    }
    const label = rs.find(r => r.credential_label)?.credential_label || null;
    return { credentialType, applicability, label, rules: rs, conflict };
  });
  return { items, stateCode };
}

export function describeRequirement(item) {
  const what = item.label || `${item.credentialType[0].toUpperCase()}${item.credentialType.slice(1)}`;
  if (item.conflict) return `${what}: requirements not yet determined (rules under review)`;
  switch (item.applicability) {
    case "required": return `${what}: required`;
    case "not_required": return `${what}: not required for the reviewed jurisdiction and scope`;
    case "conditional": return `${what}: may be required depending on scope or county`;
    default: return `${what}: requirements not yet determined`;
  }
}

// ---- Credentials ----

export const CREDENTIAL_STATUS_LABEL = {
  not_provided: "Not provided",
  pending: "Submitted · pending review",
  verified: "Verified",
  expired: "Expired",
  rejected: "Rejected",
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

// Every credential document a contractor has (or is expected to have), with
// its computed review status. A review only counts for the exact file that
// was reviewed — uploading a new file sends it back to "pending".
export function contractorCredentials(c, reqMap = {}) {
  if (!c) return [];
  const reviews = c.credential_reviews || {};
  const items = [];
  const push = (key, kind, label, docUrl, extra = {}) => {
    const review = reviews[key] || null;
    const expiresOn = review?.expires_on || extra.expiresOn || null;
    let status;
    if (!docUrl) status = "not_provided";
    else if (!review || review.doc_url !== docUrl || review.status === "pending") status = "pending";
    else if (review.status === "rejected") status = "rejected";
    else if (review.status === "verified") status = expiresOn && expiresOn < today() ? "expired" : "verified";
    else status = "pending";
    items.push({ ...extra, key, kind, label, docUrl, review, status, expiresOn, jurisdiction: review?.jurisdiction || null, scope: review?.scope || null });
  };

  push("business_license", "business_license", "Business License", c.business_license_url || null, { number: c.business_license_number || null });

  const tl = c.trade_licenses || {};
  const tlEntries = Object.entries(tl);
  if (tlEntries.length) {
    for (const [trade, entry] of tlEntries) {
      push(`trade_license:${trade}`, "trade_license", entry?.type || reqMap[trade]?.tradeLicense || "Trade License", entry?.url || null, { number: entry?.number || null, trade });
    }
  } else if (c.license_url) {
    push("license", "trade_license", c.license_type || "Trade License", c.license_url, { number: c.license_number || null, trade: c.trade || null });
  }

  push("insurance", "insurance", "General Liability Insurance", c.insurance_url || null, {
    carrier: c.insurance_carrier || null,
    expiresOn: c.insurance_expires_at || null,
  });

  if (c.bond_url) push("bond", "bond", "Surety Bond", c.bond_url, { amount: c.bond_amount || null });
  return items;
}

export function verifiedCredentialKinds(c) {
  return new Set(contractorCredentials(c).filter(i => i.status === "verified").map(i => i.kind));
}
