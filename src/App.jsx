import { useState, useEffect, useRef, useMemo } from "react";
import { supabase } from "./lib/supabase";
import { ServiceFilter, ServicePicker, ServiceSelect, serviceFilterMatches } from "./ServicePicker";
import { AdminSection, byStatus } from "./AdminSection";
import AdminServices from "./AdminServices";
import { CredentialList, CredentialReviewPanel, DocLink, VerifiedCredentialBadges, VerifiedCredentialsSummary, VERIFIED_PRO_MEANING } from "./credentials";
import {
  REQUIREMENTS_FALLBACK, buildCatalog, contractorCredentials, describeRequirement, resolveRequirements,
  searchCatalog,
} from "./services";

// Platform document policy (trade_types.trade_license_label + requires_bond):
// what SubcontractorPros asks providers of each service to upload. It is not
// a statement of legal requirements — those live in requirement_rules.
function makeRequirementsFor(reqMap) {
  return function requirementsFor(trades) {
    const list = Array.isArray(trades) ? trades : [];
    const tradeLicenseNames = new Set();
    let needsBond = false;
    for (const t of list) {
      const req = reqMap?.[t];
      if (!req) continue;
      if (req.tradeLicense) tradeLicenseNames.add(req.tradeLicense);
      if (req.bonded) needsBond = true;
    }
    return {
      needsTradeLicense: tradeLicenseNames.size > 0,
      tradeLicenseNames: Array.from(tradeLicenseNames),
      needsBond,
    };
  };
}

const TAB_PATHS = {
  search:   "/",
  post:     "/post",
  jobs:     "/jobs",
  myjobs:   "/my-jobs",
  messages: "/messages",
  reviews:  "/reviews",
  admin:    "/admin",
};
const PATH_TABS = Object.fromEntries(Object.entries(TAB_PATHS).map(([t, p]) => [p, t]));

function pathToTab(pathname, hash) {
  // Legacy: old links used /#admin, /#messages, etc.
  if (pathname === "/" && hash) {
    const h = hash.replace(/^#/, "");
    if (Object.prototype.hasOwnProperty.call(TAB_PATHS, h)) return h;
  }
  const clean = (pathname || "/").replace(/\/+$/, "") || "/";
  return PATH_TABS[clean] || "search";
}

const AVATAR_COLORS = { IR: "#b45309", BS: "#0369a1", VP: "#7c3aed", AR: "#b91c1c", CC: "#047857", TK: "#374151" };

function Stars({ rating }) {
  return (
    <span aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map(i => (
        <span key={i} aria-hidden="true" style={{ color: i <= Math.round(rating) ? "#b45309" : "#d1d5db", fontSize: "1rem" }}>★</span>
      ))}
    </span>
  );
}

function CityStateInput({ id, value, onChange, placeholder = "City, State", required = false }) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!value || value.trim().length < 2) { setSuggestions([]); return; }
    timerRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(value)}&format=json&countrycodes=us&limit=6&addressdetails=1`
        );
        const data = await res.json();
        const seen = new Set();
        const items = [];
        for (const r of data) {
          const a = r.address || {};
          const city = a.city || a.town || a.village || a.hamlet || a.county;
          const state = a.state;
          if (!city || !state) continue;
          const label = `${city}, ${state}`;
          if (seen.has(label)) continue;
          seen.add(label);
          items.push(label);
          if (items.length >= 6) break;
        }
        setSuggestions(items);
      } catch (err) {
        console.warn("city search failed:", err);
      }
    }, 350);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [value]);

  return (
    <div style={{ position: "relative" }}>
      <input
        id={id}
        required={required}
        placeholder={placeholder}
        value={value}
        autoComplete="off"
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && suggestions.length > 0 && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 10, zIndex: 60, maxHeight: 240, overflowY: "auto", boxShadow: "0 8px 24px rgba(15,23,42,0.14)" }}>
          {suggestions.map(s => (
            <button
              key={s}
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => { onChange(s); setSuggestions([]); setOpen(false); }}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 12px", background: "transparent", border: "none", color: "#0f172a", cursor: "pointer", fontSize: "1.0625rem", fontFamily: "inherit" }}
            >
              📍 {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Avatar({ initials, size = 48 }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: size, height: size, borderRadius: "50%",
        background: AVATAR_COLORS[initials] || "#374151",
        color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
        fontWeight: 700, fontSize: size * 0.33, flexShrink: 0,
        fontFamily: "'Bebas Neue', cursive", letterSpacing: 1,
      }}
    >
      {initials}
    </div>
  );
}

// Big yellow titles get a thin dark outline so they read on gray and white.
const TITLE_OUTLINE = "-1px -1px 0 #1f2937, 1px -1px 0 #1f2937, -1px 1px 0 #1f2937, 1px 1px 0 #1f2937, 0 2px 0 #1f2937";

// Web push (notifications while the app is closed). The public half of the
// VAPID key pair; the private half is a Supabase Edge Function secret.
const VAPID_PUBLIC_KEY = "BMP8qaRnzIeHqgIXv6Xwv7MhDdGbiA6orGro0HnhpiATuFHpeP8cUT-Sj5mdXU4ELleaBNsMKOqqvBYDHKtfuBE";
function pushSupported() {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
function vapidKeyBytes(base64url) {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

// Two-note chime for incoming messages, synthesized so there's no sound file.
// Browsers only allow audio after the visitor has tapped or clicked the page,
// so the audio context is unlocked on the first interaction.
let chimeCtx = null;
function unlockChime() {
  try {
    chimeCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (chimeCtx.state === "suspended") chimeCtx.resume();
  } catch {}
}
function playChime() {
  if (!chimeCtx || chimeCtx.state !== "running") return;
  const now = chimeCtx.currentTime;
  [[880, 0], [1318.5, 0.12]].forEach(([freq, at]) => {
    const osc = chimeCtx.createOscillator();
    const gain = chimeCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + at);
    gain.gain.exponentialRampToValueAtTime(0.25, now + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.45);
    osc.connect(gain).connect(chimeCtx.destination);
    osc.start(now + at);
    osc.stop(now + at + 0.5);
  });
  try { navigator.vibrate?.(80); } catch {}
}

export default function App() {
  const [tab, setTab] = useState(() => {
    if (typeof window === "undefined") return "search";
    return pathToTab(window.location.pathname, window.location.hash);
  });
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [serviceFilter, setServiceFilter] = useState(""); // "" | "group:<slug>" | service name
  const [onlyMyServices, setOnlyMyServices] = useState(false);
  const [search, setSearch] = useState("");
  const [contractors, setContractors] = useState([]);
  const [messages, setMessages] = useState({});
  const [reviews, setReviews] = useState({});
  const [msgInput, setMsgInput] = useState("");
  const [activeChat, setActiveChat] = useState(null);
  const [msgSound, setMsgSound] = useState(() => {
    try { return localStorage.getItem("tlp_msg_sound") !== "off"; } catch { return true; }
  });
  const msgSoundRef = useRef(msgSound);
  // "unsupported" | "default" | "denied" | "on"
  const [pushState, setPushState] = useState(() =>
    !pushSupported() ? "unsupported" : Notification.permission === "denied" ? "denied" : "default");
  msgSoundRef.current = msgSound;
  const [lastSeenThreads, setLastSeenThreads] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("tlp_thread_seen") || "{}");
    } catch { return {}; }
  });
  const [reviewInput, setReviewInput] = useState({ stars: 5, text: "" });
  const [reviewTarget, setReviewTarget] = useState(null); // { contractorId, jobId } | null
  const [myReviewedJobIds, setMyReviewedJobIds] = useState(new Set());
  const [modal, setModal] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [jobForm, setJobForm] = useState({ title: "", trades: [], location: "", budget: "", desc: "", homeowner_name: "", homeowner_email: "", homeowner_phone: "" });
  const [notification, setNotification] = useState(null);
  const [user, setUser] = useState(null);
  const [authModal, setAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState("signin");
  const [authForm, setAuthForm] = useState({ email: "", password: "" });
  const [authIntent, setAuthIntent] = useState(null); // "customer" | "pro" | null — tailors the sign-up note
  const [authError, setAuthError] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [authState, setAuthState] = useState("loading"); // "loading" | "signed-out" | "signed-in"
  const [adminChecked, setAdminChecked] = useState(false);
  const [adminList, setAdminList] = useState([]);
  const [adminInvites, setAdminInvites] = useState([]);
  const [adminInviteInput, setAdminInviteInput] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);
  const [catalogRaw, setCatalogRaw] = useState({ groups: [], services: [], aliases: [], rules: [] });
  const [customerProfileModal, setCustomerProfileModal] = useState(false);
  const [customerProfile, setCustomerProfile] = useState({ homeowner_name: "", homeowner_phone: "" });
  const [jobEditModal, setJobEditModal] = useState(null);
  const [jobEditBusy, setJobEditBusy] = useState(false);
  const [completeModal, setCompleteModal] = useState(null); // job being marked complete
  const [completeInput, setCompleteInput] = useState({ rating: 5, comment: "", reviewText: "" });
  const [completeBusy, setCompleteBusy] = useState(false);
  const [releaseModal, setReleaseModal] = useState(null); // job to release
  const [releaseInput, setReleaseInput] = useState({ reason: "Contractor never contacted me", notes: "" });
  const [releaseBusy, setReleaseBusy] = useState(false);
  const [supportModal, setSupportModal] = useState(false);
  const [supportInput, setSupportInput] = useState({ subject: "", body: "" });
  const [supportBusy, setSupportBusy] = useState(false);
  const [shareModal, setShareModal] = useState(false);
  const [shareInput, setShareInput] = useState({ clientEmail: "", clientName: "", message: "" });
  const [shareBusy, setShareBusy] = useState(false);
  const [denyModal, setDenyModal] = useState(null); // contractor being denied
  const [denyReason, setDenyReason] = useState("");
  const [denyBusy, setDenyBusy] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [iosInstallModal, setIosInstallModal] = useState(false);
  const [jobReleases, setJobReleases] = useState([]);
  const [supportTickets, setSupportTickets] = useState([]);
  const [adminUsers, setAdminUsers] = useState([]);
  const [adminUserSearch, setAdminUserSearch] = useState("");
  const [adminUserRole, setAdminUserRole] = useState("");
  const [myContractor, setMyContractor] = useState(null);
  const [profileModal, setProfileModal] = useState(false);
  const [profileForm, setProfileForm] = useState({
    name: "", trades: [], location: "", hourly: "", bio: "", tags: "", website: "",
    business_license_number: "", business_license_path: "", business_license_file: null,
    // trade_licenses is keyed by trade name (e.g. "Electrician") and holds
    // { number: string, url: string, file: File | null } for each licensed trade the contractor picked.
    trade_licenses: {},
    insurance_carrier: "", insurance_expires_at: "", insurance_path: "", insurance_file: null,
    bond_amount: "", bond_path: "", bond_file: null,
  });
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState(null);
  const [myJobs, setMyJobs] = useState([]);

  // Roles are now derived from state, not from a metadata flag. Anyone
  // signed in can post jobs (customer surface); anyone with a `contractors`
  // row can also accept jobs (contractor surface). A single user can be both.
  const isSignedIn   = !!user;
  const isContractor = !!myContractor;
  const isCustomer   = isSignedIn;

  const messagesEndRef = useRef(null);
  const modalRef = useRef(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user ?? null;
      setUser(u);
      setAuthState(u ? "signed-in" : "signed-out");
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user ?? null;
      setUser(u);
      setAuthState(u ? "signed-in" : "signed-out");
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    // Only redirect once auth state (and admin state, for #admin) is known.
    // Otherwise a fresh page load with #admin or #messages in the URL would
    // bounce back to search before the async auth check completes.
    if (tab === "messages" && authState === "signed-out") setTab("search");
    if (tab === "admin" && adminChecked && !isAdmin) setTab("search");
  }, [tab, authState, isAdmin, adminChecked]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const targetPath = TAB_PATHS[tab] || "/";
    if (window.location.pathname !== targetPath || window.location.hash) {
      window.history.replaceState(null, "", targetPath);
    }
  }, [tab]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPop = () => {
      setTab(pathToTab(window.location.pathname, window.location.hash));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Chrome / Edge / Android — the browser fires this when the app is
    // installable. We capture and defer the prompt so we can show our own
    // "Install app" menu item and call prompt() later.
    const onBip = (e) => { e.preventDefault(); setInstallPrompt(e); };
    const onInstalled = () => { setInstallPrompt(null); setIsInstalled(true); };
    window.addEventListener("beforeinstallprompt", onBip);
    window.addEventListener("appinstalled", onInstalled);
    // Detect "already installed" state (running in standalone).
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches
      || window.navigator.standalone === true;
    if (standalone) setIsInstalled(true);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBip);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  function isIOS() {
    if (typeof navigator === "undefined") return false;
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  }

  async function triggerInstall() {
    if (installPrompt) {
      installPrompt.prompt();
      const { outcome } = await installPrompt.userChoice;
      if (outcome === "accepted") setIsInstalled(true);
      setInstallPrompt(null);
      return;
    }
    if (isIOS()) {
      setIosInstallModal(true);
      return;
    }
    notify("Use your browser's menu to add this app to your device.");
  }

  // Saves this device's push subscription for the signed-in user.
  async function savePushSubscription() {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKeyBytes(VAPID_PUBLIC_KEY) });
    const { endpoint, keys } = sub.toJSON();
    const { error } = await supabase.rpc("save_push_subscription", { p_endpoint: endpoint, p_p256dh: keys.p256dh, p_auth: keys.auth });
    if (error) throw error;
  }

  async function enablePush() {
    if (!pushSupported()) {
      // iPhone Safari only offers push to the installed home-screen app.
      if (isIOS()) setIosInstallModal(true);
      else notify("This browser doesn't support notifications.");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setPushState(permission === "denied" ? "denied" : "default");
      if (permission === "denied") notify("Notifications are blocked. Allow them in your browser or phone settings.");
      return;
    }
    try {
      await savePushSubscription();
      setPushState("on");
      notify("Notifications are on for this device.");
      // A local test notification shows right away whether this device's
      // settings let notifications through.
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification("Notifications are working", {
        body: "You'll get alerts like this for new messages, even when the app is closed.",
        tag: "test",
        icon: "/favicon.svg",
        data: { url: "/messages" },
      });
    } catch (err) {
      console.error("push subscribe failed:", err);
      notify("Couldn't turn on notifications: " + (err.message || err));
    }
  }

  // Tell the server to notify the other side of a just-sent message.
  function pushMessage(messageId) {
    if (!messageId) return;
    supabase.functions.invoke("notify-message-push", { body: { messageId } })
      .then(({ error }) => { if (error) console.error("message push failed:", error); });
  }

  async function loadCatalog() {
    const [g, s, a, r] = await Promise.all([
      supabase.from("service_groups").select("*"),
      supabase.from("trade_types").select("*"),
      supabase.from("trade_aliases").select("alias, trade_name"),
      supabase.from("requirement_rules").select("*").order("id"),
    ]);
    for (const res of [g, s, a, r]) if (res.error) console.error("catalog load failed:", res.error);
    setCatalogRaw({ groups: g.data || [], services: s.data || [], aliases: a.data || [], rules: r.data || [] });
  }

  useEffect(() => { loadCatalog(); }, []);

  const catalog = useMemo(
    () => buildCatalog(catalogRaw.services, catalogRaw.groups, catalogRaw.aliases),
    [catalogRaw]
  );
  const tradeReqMap = useMemo(() => Object.fromEntries(catalogRaw.services.map(r => [
    r.name, { tradeLicense: r.trade_license_label || null, bonded: !!r.requires_bond },
  ])), [catalogRaw.services]);
  const requirementsFor = makeRequirementsFor(tradeReqMap);

  function licensingSummary(serviceName, location) {
    const { items, stateCode } = resolveRequirements(catalogRaw.rules, serviceName, location);
    if (!items.length) return REQUIREMENTS_FALLBACK;
    return `${stateCode ? `${stateCode}: ` : ""}${items.map(describeRequirement).join(" · ")}`;
  }

  useEffect(() => {
    if (!user) { setIsAdmin(false); setAdminChecked(authState !== "loading"); return; }
    (async () => {
      const { data, error } = await supabase
        .from("admins")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) console.error("admin check failed:", error);
      setIsAdmin(!!data);
      setAdminChecked(true);
    })();
  }, [user, authState]);

  useEffect(() => {
    if (!isAdmin) { setAdminList([]); setAdminInvites([]); setJobReleases([]); setSupportTickets([]); setAdminUsers([]); return; }
    (async () => {
      const [aRes, iRes, rRes, tRes, uRes] = await Promise.all([
        supabase.from("admins").select("*").order("created_at"),
        supabase.from("admin_invites").select("*").order("created_at"),
        supabase.from("job_releases").select("*").order("created_at", { ascending: false }),
        supabase.from("support_tickets").select("*").order("created_at", { ascending: false }),
        supabase.rpc("admin_list_users"),
      ]);
      if (aRes.error) console.error("admins list failed:", aRes.error);
      if (iRes.error) console.error("admin invites list failed:", iRes.error);
      if (rRes.error) console.error("job releases load failed:", rRes.error);
      if (tRes.error) console.error("support tickets load failed:", tRes.error);
      if (uRes.error) console.error("users list failed:", uRes.error);
      setAdminList(aRes.data || []);
      setAdminInvites(iRes.data || []);
      setJobReleases(rRes.data || []);
      setSupportTickets(tRes.data || []);
      setAdminUsers(uRes.data || []);
    })();
  }, [isAdmin]);

  useEffect(() => {
    const meta = user?.user_metadata ?? {};
    setCustomerProfile({
      homeowner_name:  meta.homeowner_name  ?? "",
      homeowner_phone: meta.homeowner_phone ?? "",
    });
    if (user && (meta.homeowner_name || meta.homeowner_phone || user.email)) {
      setJobForm(f => ({
        ...f,
        homeowner_name:  f.homeowner_name  || meta.homeowner_name  || "",
        homeowner_email: f.homeowner_email || user.email           || "",
        homeowner_phone: f.homeowner_phone || meta.homeowner_phone || "",
      }));
    }
  }, [user]);

  useEffect(() => {
    if (!user) { setMyReviewedJobIds(new Set()); return; }
    (async () => {
      const { data, error } = await supabase
        .from("reviews")
        .select("job_id")
        .eq("user_id", user.id)
        .not("job_id", "is", null);
      if (error) { console.error("my reviews load failed:", error); return; }
      setMyReviewedJobIds(new Set((data || []).map(r => r.job_id)));
    })();
  }, [user, reviews]);

  useEffect(() => {
    if (!isCustomer) { setMyJobs([]); return; }
    (async () => {
      // Show all of the customer's posted jobs except the ones they
      // themselves deleted — admin-removed jobs still show up with a
      // "Removed by admin" badge and no actions.
      const { data: rows, error } = await supabase
        .from("jobs")
        .select("*")
        .eq("posted_by", user.id)
        .order("created_at", { ascending: false });
      if (error) { console.error("my jobs load failed:", error); return; }
      const visible = await withJobContacts((rows || []).filter(j => !j.deleted_at || j.deleted_by !== user.id));
      const accepterIds = visible.map(j => j.accepted_by).filter(Boolean);
      let accepters = [];
      if (accepterIds.length) {
        const { data } = await supabase.from("contractors").select("*").in("user_id", accepterIds);
        accepters = await withContractorDetails(data || []);
      }
      const enriched = visible.map(j => ({
        ...j,
        accepter: accepters.find(c => c.user_id === j.accepted_by) ?? null,
      }));
      setMyJobs(enriched);
    })();
  }, [isCustomer, user, jobs]);

  useEffect(() => {
    if (!user) { setMyContractor(null); return; }
    (async () => {
      const { data, error } = await supabase
        .from("contractors")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) console.error("my contractor load failed:", error);
      setMyContractor(data ? (await withContractorDetails([data]))[0] : null);
    })();
  }, [user]);

  // Private rows (credentials, homeowner contacts) only come back where the
  // database allows: the pro, admins, and the customer who hired them.
  async function withContractorDetails(rows) {
    if (!rows?.length) return [];
    const none = Promise.resolve({ data: [] });
    const [bRes, cRes, dRes] = await Promise.all([
      supabase.from("contractor_badges").select("*"),
      user ? supabase.from("contractor_credentials").select("*") : none,
      user ? supabase.from("contractor_denials").select("*") : none,
    ]);
    if (bRes.error) console.error("badges load failed:", bRes.error);
    if (cRes.error) console.error("credentials load failed:", cRes.error);
    if (dRes.error) console.error("denials load failed:", dRes.error);
    const badges = Object.fromEntries((bRes.data || []).map(b => [b.contractor_id, b.verified]));
    const creds = Object.fromEntries((cRes.data || []).map(({ contractor_id, ...rest }) => [contractor_id, rest]));
    const denials = Object.fromEntries((dRes.data || []).map(d => [d.contractor_id, { denied_at: d.denied_at, denied_by: d.denied_by, denial_reason: d.reason }]));
    return rows.map(c => ({ ...c, ...(creds[c.id] || {}), ...(denials[c.id] || {}), verified_credentials: badges[c.id] || [] }));
  }

  async function withJobContacts(rows) {
    if (!user || !rows?.length) return rows || [];
    const { data, error } = await supabase.from("job_contacts").select("*");
    if (error) console.error("job contacts load failed:", error);
    const contacts = Object.fromEntries((data || []).map(({ job_id, ...rest }) => [job_id, rest]));
    return rows.map(j => ({ ...j, ...(contacts[j.id] || {}) }));
  }

  async function loadContractors() {
    const { data, error } = await supabase.from("contractors").select("*").order("id");
    if (error) console.error("contractors load failed:", error);
    setContractors(await withContractorDetails(data || []));
  }

  async function loadJobs() {
    // Load all jobs (including deleted) — display filters as appropriate:
    // public views hide anything with deleted_at set, admins see everything,
    // and the customer's own view hides self-deletions but keeps admin ones.
    const { data, error } = await supabase
      .from("jobs").select("*")
      .order("created_at", { ascending: false });
    if (error) console.error("jobs load failed:", error);
    setJobs(await withJobContacts(data || []));
  }

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from("reviews").select("*").order("created_at");
      if (error) console.error("reviews load failed:", error);
      const reviewsByContractor = {};
      for (const r of data || []) {
        (reviewsByContractor[r.contractor_id] ||= []).push(r);
      }
      setReviews(reviewsByContractor);
    })();
  }, []);

  useEffect(() => {
    if (authState === "loading") return;
    loadContractors();
    loadJobs();
  }, [authState, user?.id]);

  // Files one message into its conversation (copy-on-write). Shared by the
  // initial load and live updates, so both group threads the same way.
  function withMessage(threads, m) {
    let counterpartyId, key;
    if (m.contractor_id == null && isAdmin) {
      // Team side: one thread per user, whichever admin wrote.
      counterpartyId = m.from_admin ? m.recipient_id : m.sender_id;
      key = `admin:${counterpartyId}`;
    } else if (m.contractor_id == null) {
      // User side: one "team" thread; replies go to the admin who wrote last.
      counterpartyId = m.from_admin ? m.sender_id : m.recipient_id;
      key = "admin:team";
    } else {
      counterpartyId = m.sender_id === user.id ? m.recipient_id : m.sender_id;
      key = `${m.contractor_id}:${counterpartyId}`;
    }
    const t = threads[key]
      ? { ...threads[key], messages: [...threads[key].messages] }
      : { key, contractor_id: m.contractor_id, counterparty_id: counterpartyId, counterparty_email: null, messages: [] };
    if (m.id != null && t.messages.some(x => x.id === m.id)) return threads;
    // My own message arriving live replaces its optimistic copy.
    const pending = m.sender_id === user.id ? t.messages.findIndex(x => x.id == null && x.text === m.text) : -1;
    if (pending >= 0) t.messages[pending] = m; else t.messages.push(m);
    if (m.sender_id === counterpartyId && m.sender_email) t.counterparty_email = m.sender_email;
    if (key === "admin:team" && m.from_admin) t.counterparty_id = m.sender_id;
    return { ...threads, [key]: t };
  }

  async function loadMessages() {
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      // Admin conversations (no contractor_id) are a shared team inbox;
      // RLS only returns other people's to admins.
      .or(`sender_id.eq.${user.id},recipient_id.eq.${user.id},contractor_id.is.null`)
      .order("created_at");
    if (error) { console.error("messages load failed:", error); return; }
    // Keep conversations started on this page that have no messages yet.
    setMessages(prev => {
      let threads = Object.fromEntries(Object.entries(prev).filter(([, t]) => t.messages.length === 0));
      for (const m of data || []) threads = withMessage(threads, m);
      return threads;
    });
  }

  useEffect(() => {
    if (!user) { setMessages({}); return; }
    setMessages({});
    loadMessages();
    // New messages arrive live; RLS limits them to what this user may read.
    const channel = supabase
      .channel(`messages-${user.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" },
        payload => {
          const m = payload.new;
          setMessages(prev => withMessage(prev, m));
          // Chime for messages from someone else (for admins, another admin's
          // team message isn't "incoming").
          const incoming = m.sender_id !== user.id && !(isAdmin && m.contractor_id == null && m.from_admin);
          if (incoming && msgSoundRef.current) playChime();
        })
      .subscribe();
    // Catch up after the phone sleeps or the tab sits in the background.
    const onVisible = () => { if (document.visibilityState === "visible") loadMessages(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      supabase.removeChannel(channel);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [user, isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeChat]);

  useEffect(() => {
    if (!modal) return;
    modalRef.current?.focus();
    const handleKey = (e) => { if (e.key === "Escape") setModal(null); };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [modal]);

  useEffect(() => {
    document.body.style.overflow = modal ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [modal]);

  useEffect(() => {
    if (!userMenuOpen) return;
    const handleKey = (e) => { if (e.key === "Escape") setUserMenuOpen(false); };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [userMenuOpen]);

  function contractorTrades(c) {
    return Array.isArray(c?.trades) && c.trades.length ? c.trades : c?.trade ? [c.trade] : [];
  }

  const searchServiceHits = useMemo(
    () => new Set(searchCatalog(catalog, search, { includeInactive: true }).map(r => r.service.name)),
    [catalog, search]
  );
  const filtered = contractors.filter(c => {
    if (c.deactivated_at) return false; // hidden from the public board
    const trades = contractorTrades(c);
    if (!serviceFilterMatches(catalog, trades, serviceFilter)) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return c.name.toLowerCase().includes(q) ||
      (c.location || "").toLowerCase().includes(q) ||
      (c.tags || []).some(t => t.toLowerCase().includes(q)) ||
      trades.some(t => t.toLowerCase().includes(q) || searchServiceHits.has(t));
  });

  const myServiceNames = contractorTrades(myContractor);
  const openJobsShown = jobs.filter(j =>
    !j.deleted_at && !j.accepted_by &&
    serviceFilterMatches(catalog, [j.trade], serviceFilter) &&
    (!onlyMyServices || myServiceNames.includes(j.trade))
  );

  function notify(msg) {
    setNotification(msg);
    setTimeout(() => setNotification(null), 3000);
  }

  async function sendMessage() {
    if (!msgInput.trim() || !activeChat || !user) return;
    const thread = messages[activeChat];
    if (!thread) return;
    const text = msgInput.trim();
    setMsgInput("");
    const fromAdmin = thread.contractor_id == null && isAdmin;
    const optimistic = {
      contractor_id: thread.contractor_id,
      sender_id: user.id,
      recipient_id: thread.counterparty_id,
      sender_email: fromAdmin ? null : user.email,
      from_admin: fromAdmin,
      text,
      created_at: new Date().toISOString(),
    };
    setMessages(prev => ({
      ...prev,
      [activeChat]: { ...prev[activeChat], messages: [...prev[activeChat].messages, optimistic] },
    }));
    const { data: saved, error } = await supabase.from("messages").insert({
      contractor_id: thread.contractor_id,
      sender_id: user.id,
      recipient_id: thread.counterparty_id,
      sender_email: fromAdmin ? null : user.email,
      from_admin: fromAdmin,
      text,
    }).select("id").single();
    if (error) { notify("Failed to send: " + error.message); return; }
    pushMessage(saved?.id);
    if (fromAdmin) {
      // Email the user so they see it without opening the app. The message is
      // already saved, so a mail hiccup only gets logged.
      const { error: mailErr } = await supabase.functions
        .invoke("notify-user-admin-message", { body: { recipientId: thread.counterparty_id } });
      if (mailErr) console.error("admin message email failed:", mailErr);
    }
  }

  // Admin → any user: opens (or starts) the admin conversation with them.
  // `draft` pre-fills the message box, e.g. with the job it's about.
  function openAdminChat(userId, draft = "") {
    if (!isAdmin || !userId) return;
    if (adminList.some(a => a.user_id === userId)) { notify("That's an admin — admin messages are for users."); return; }
    const key = `admin:${userId}`;
    setMessages(prev => prev[key] ? prev : {
      ...prev,
      [key]: { key, contractor_id: null, counterparty_id: userId, counterparty_email: null, messages: [] },
    });
    setActiveChat(key);
    setMsgInput(draft);
    setTab("messages");
  }

  function openChatWithContractor(contractor) {
    if (!user) {
      setAuthMode("signup");
      setAuthIntent("customer");
      setAuthError(null);
      setAuthModal(true);
      return;
    }
    if (!contractor?.user_id) {
      notify("This contractor doesn't have messaging set up yet.");
      return;
    }
    if (contractor.user_id === user.id) {
      notify("You can't message yourself.");
      return;
    }
    const key = `${contractor.id}:${contractor.user_id}`;
    setMessages(prev => prev[key] ? prev : {
      ...prev,
      [key]: {
        key,
        contractor_id: contractor.id,
        counterparty_id: contractor.user_id,
        counterparty_email: null,
        messages: [],
      },
    });
    setActiveChat(key);
    setTab("messages");
  }

  function reviewableJobFor(contractorId) {
    // The most recent job the current user posted that this contractor accepted
    // and that the user has not yet reviewed.
    if (!user || !isCustomer) return null;
    const contractor = contractors.find(c => c.id === contractorId);
    if (!contractor?.user_id) return null;
    return (
      myJobs.find(j => j.accepted_by === contractor.user_id && !myReviewedJobIds.has(j.id))
      ?? null
    );
  }

  async function submitReview() {
    if (!reviewTarget || !user) return;
    if (!reviewInput.text.trim()) return;
    const { contractorId, jobId } = reviewTarget;
    const job = myJobs.find(j => j.id === jobId);
    const author = job?.homeowner_name?.trim() || user.email;
    const payload = {
      contractor_id: contractorId,
      job_id: jobId,
      user_id: user.id,
      author,
      stars: reviewInput.stars,
      text: reviewInput.text.trim(),
    };
    const { error } = await supabase.from("reviews").insert(payload);
    if (error) {
      notify("Failed to submit review: " + error.message);
      return;
    }
    setReviews(prev => ({
      ...prev,
      [contractorId]: [...(prev[contractorId] || []), payload],
    }));
    setMyReviewedJobIds(prev => new Set(prev).add(jobId));
    setReviewInput({ stars: 5, text: "" });
    setReviewTarget(null);
    await loadContractors();
    notify("Review submitted!");
  }

  async function postJob() {
    if (!jobForm.title || !jobForm.location || !jobForm.homeowner_name || !jobForm.homeowner_email) return;
    if (!jobForm.trades.length) { notify("Pick at least one service you need."); return; }
    const groupId = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    const rows = jobForm.trades.map(t => ({
      title: jobForm.title,
      trade: t,
      location: jobForm.location,
      budget: jobForm.budget ? Number(jobForm.budget) : null,
      description: jobForm.desc,
      posted_by: user.id,
      group_id: groupId,
    }));
    const { data: created, error } = await supabase.from("jobs").insert(rows).select("id");
    if (error) {
      notify("Failed to post job: " + error.message);
      return;
    }
    const { error: contactErr } = await supabase.from("job_contacts").insert(created.map(j => ({
      job_id: j.id,
      homeowner_name: jobForm.homeowner_name.trim(),
      homeowner_email: jobForm.homeowner_email.trim(),
      homeowner_phone: jobForm.homeowner_phone.trim() || null,
    })));
    if (contactErr) {
      notify("Job posted, but saving your contact info failed: " + contactErr.message);
      await loadJobs();
      return;
    }
    if (user) {
      await supabase.auth.updateUser({ data: {
        homeowner_name:  jobForm.homeowner_name.trim(),
        homeowner_phone: jobForm.homeowner_phone.trim() || null,
      }});
    }
    setJobForm({ title: "", trades: [], location: "", budget: "", desc: "", homeowner_name: "", homeowner_email: "", homeowner_phone: "" });
    await loadJobs();
    notify(jobForm.trades.length > 1
      ? `Job posted with ${jobForm.trades.length} services. Each stays open until a matching pro accepts.`
      : "Job posted! Contractors will reach out shortly.");
  }

  function openJobEdit(job) {
    setJobEditModal({ ...job });
  }

  async function saveJobEdit(e) {
    e.preventDefault();
    if (!jobEditModal) return;
    setJobEditBusy(true);
    const { id, title, trade, location, budget, description } = jobEditModal;
    const { error } = await supabase
      .from("jobs")
      .update({
        title,
        trade,
        location,
        budget: budget === "" || budget == null ? null : Number(budget),
        description,
      })
      .eq("id", id);
    setJobEditBusy(false);
    if (error) { notify("Failed to save job: " + error.message); return; }
    setJobEditModal(null);
    await loadJobs();
    notify("Job updated.");
  }

  function openCompleteModal(job) {
    setCompleteInput({ rating: 5, comment: "", reviewText: "" });
    setCompleteModal(job);
  }

  async function submitComplete(e) {
    e.preventDefault();
    if (!completeModal || !user) return;
    if (!completeInput.reviewText.trim()) {
      notify("Please share a quick review before submitting.");
      return;
    }
    setCompleteBusy(true);
    try {
      const { error: jobErr } = await supabase
        .from("jobs")
        .update({
          completed_at:        new Date().toISOString(),
          completion_rating:   completeInput.rating,
          completion_comment:  completeInput.comment.trim() || null,
        })
        .eq("id", completeModal.id);
      if (jobErr) throw new Error("Couldn't mark complete: " + jobErr.message);

      const author = completeModal.homeowner_name?.trim() || user.email;
      const { error: revErr } = await supabase.from("reviews").insert({
        contractor_id: completeModal.accepter.id,
        job_id:        completeModal.id,
        user_id:       user.id,
        author,
        stars:         completeInput.rating,
        text:          completeInput.reviewText.trim(),
      });
      if (revErr) throw new Error("Couldn't post review: " + revErr.message);

      setMyReviewedJobIds(prev => new Set(prev).add(completeModal.id));
      setCompleteModal(null);
      await loadJobs();
      await loadContractors();
      notify("Job marked complete and review posted. Thanks!");
    } catch (err) {
      notify(err.message);
    } finally {
      setCompleteBusy(false);
    }
  }

  async function deleteJob(job) {
    if (!user) return;
    if (!confirm(`Delete "${job.title}"? This removes it from your list and takes it off the public board. It can't be undone from inside the app.`)) return;
    const { error } = await supabase.from("jobs")
      .update({ deleted_at: new Date().toISOString(), deleted_by: user.id })
      .eq("id", job.id);
    if (error) { notify("Delete failed: " + error.message); return; }
    await loadJobs();
    notify("Job deleted.");
  }

  async function adminRemoveJob(job) {
    if (!confirm(`Remove "${job.title}" from the board? The customer will see a "Removed by admin" note and won't be able to restore it themselves.`)) return;
    const { error } = await supabase.from("jobs")
      .update({ deleted_at: new Date().toISOString(), deleted_by: user.id })
      .eq("id", job.id);
    if (error) { notify("Remove failed: " + error.message); return; }
    await loadJobs();
    notify(`Removed "${job.title}".`);
  }

  async function adminRestoreJob(job) {
    const { error } = await supabase.from("jobs")
      .update({ deleted_at: null, deleted_by: null })
      .eq("id", job.id);
    if (error) { notify("Restore failed: " + error.message); return; }
    await loadJobs();
    notify(`Restored "${job.title}".`);
  }

  async function reopenJob(job) {
    if (!user) return;
    if (!confirm("Reopen this job? Your review will be removed and the contractor stays assigned. You can Mark Complete again later.")) return;
    // Wipe the review we auto-posted at completion (if any) so the unique
    // (job_id, contractor_id) index doesn't block a future Mark Complete.
    if (job.accepter?.id) {
      const { error: rErr } = await supabase.from("reviews")
        .delete()
        .eq("job_id", job.id)
        .eq("user_id", user.id);
      if (rErr) console.error("delete review failed:", rErr);
    }
    const { error } = await supabase.from("jobs").update({
      completed_at: null,
      completion_rating: null,
      completion_comment: null,
    }).eq("id", job.id);
    if (error) { notify("Reopen failed: " + error.message); return; }
    setMyReviewedJobIds(prev => {
      const next = new Set(prev);
      next.delete(job.id);
      return next;
    });
    await loadJobs();
    await loadContractors();
    notify("Job reopened. Review was removed.");
  }

  function openReleaseModal(job) {
    setReleaseInput({ reason: "Contractor never contacted me", notes: "" });
    setReleaseModal(job);
  }

  async function submitRelease(e) {
    e.preventDefault();
    if (!releaseModal || !user) return;
    setReleaseBusy(true);
    try {
      const { error: relErr } = await supabase.from("job_releases").insert({
        job_id: releaseModal.id,
        contractor_row_id: releaseModal.accepter?.id ?? null,
        contractor_user_id: releaseModal.accepted_by ?? null,
        released_by: user.id,
        reason: releaseInput.reason,
        notes: releaseInput.notes.trim() || null,
      });
      if (relErr) throw new Error("Log release failed: " + relErr.message);

      const { error: jobErr } = await supabase
        .from("jobs")
        .update({ accepted_by: null, accepted_at: null })
        .eq("id", releaseModal.id);
      if (jobErr) throw new Error("Reopen job failed: " + jobErr.message);

      setReleaseModal(null);
      await loadJobs();
      notify("Job released. It's back on the open list.");
    } catch (err) {
      notify(err.message);
    } finally {
      setReleaseBusy(false);
    }
  }

  async function submitSupport(e) {
    e.preventDefault();
    setSupportBusy(true);
    try {
      const email = user?.email || supportInput.email;
      if (!email) throw new Error("Please enter an email so we can reply.");
      if (!supportInput.subject.trim() || !supportInput.body.trim()) {
        throw new Error("Subject and message are both required.");
      }
      const { error } = await supabase.functions.invoke("notify-admins-support-ticket", {
        body: { email, subject: supportInput.subject.trim(), body: supportInput.body.trim() },
      });
      if (error) {
        const detail = await error.context?.json?.().catch(() => null);
        throw new Error(detail?.error || "Couldn't send your request. Please try again.");
      }
      setSupportModal(false);
      setSupportInput({ subject: "", body: "" });
      notify("Support request sent. We'll reply by email.");
    } catch (err) {
      notify(err.message);
    } finally {
      setSupportBusy(false);
    }
  }

  async function submitShareCredentials(e) {
    e.preventDefault();
    setShareBusy(true);
    try {
      if (!canAcceptJobs(myContractor)) {
        throw new Error("Your profile needs to be verified before you can share credentials.");
      }
      const r = await supabase.functions.invoke("share-credentials-with-client", {
        body: {
          clientEmail: shareInput.clientEmail.trim(),
          clientName:  shareInput.clientName.trim() || undefined,
          message:     shareInput.message.trim() || undefined,
        },
      });
      if (r.error) throw new Error(r.error.message || String(r.error));
      if (r.data?.error) throw new Error(r.data.error);
      setShareModal(false);
      setShareInput({ clientEmail: "", clientName: "", message: "" });
      notify(`License & insurance sent to ${r.data?.to || shareInput.clientEmail}.`);
    } catch (err) {
      notify("Send failed: " + err.message);
    } finally {
      setShareBusy(false);
    }
  }

  async function adminUpdateTicket(ticket, patch) {
    const { error } = await supabase.from("support_tickets").update(patch).eq("id", ticket.id);
    if (error) { notify("Update failed: " + error.message); return; }
    setSupportTickets(prev => prev.map(t => t.id === ticket.id ? { ...t, ...patch } : t));
    // If we just closed a ticket, email the submitter that it's resolved.
    if (patch.status === "closed" && ticket.status !== "closed") {
      supabase.functions
        .invoke("notify-support-ticket-closed", { body: { ticketId: ticket.id } })
        .catch(err => console.error("notify closed failed:", err));
    }
  }

  async function saveCustomerProfile(e) {
    e.preventDefault();
    if (!user) return;
    const { error } = await supabase.auth.updateUser({ data: {
      homeowner_name:  customerProfile.homeowner_name.trim(),
      homeowner_phone: customerProfile.homeowner_phone.trim() || null,
    }});
    if (error) { notify("Save failed: " + error.message); return; }
    setCustomerProfileModal(false);
    notify("Profile saved.");
  }

  async function setContractorDeactivated(contractor, deactivate) {
    if (!user) return;
    const payload = deactivate
      ? { deactivated_at: new Date().toISOString(), deactivated_by: user.id, available: false }
      : { deactivated_at: null, deactivated_by: null };
    const { data, error } = await supabase.from("contractors")
      .update(payload).eq("id", contractor.id).select().single();
    if (error) { notify("Update failed: " + error.message); return; }
    setContractors(prev => prev.map(c => c.id === data.id ? data : c));
    if (myContractor?.id === data.id) setMyContractor(data);
    notify(deactivate ? `${contractor.name} taken off the board.` : `${contractor.name} back on the board.`);
  }

  function openDenyModal(contractor) {
    setDenyReason("");
    setDenyModal(contractor);
  }

  async function submitDeny(e) {
    e.preventDefault();
    if (!denyModal) return;
    const reason = denyReason.trim();
    if (!reason) { notify("Give the contractor a reason so they know what to fix."); return; }
    setDenyBusy(true);
    try {
      const { error: denyErr } = await supabase.from("contractor_denials").upsert({
        contractor_id: denyModal.id,
        denied_at: new Date().toISOString(),
        denied_by: user.id,
        reason,
      }, { onConflict: "contractor_id" });
      if (denyErr) throw new Error(denyErr.message);
      if (denyModal.verified) {
        const { error } = await supabase.from("contractors")
          .update({ verified: false, verified_at: null, verified_by: null })
          .eq("id", denyModal.id);
        if (error) throw new Error(error.message);
      }
      await loadContractors();
      supabase.functions
        .invoke("notify-contractor-denied", { body: { contractorId: denyModal.id } })
        .catch(err => console.error("notify denied failed:", err));
      setDenyModal(null);
      notify(`Denied ${denyModal.name}. They've been emailed the reason.`);
    } catch (err) {
      notify("Deny failed: " + err.message);
    } finally {
      setDenyBusy(false);
    }
  }

  async function adminSetVerified(contractor, verified) {
    setAdminBusy(true);
    const payload = verified
      ? { verified: true,  verified_at: new Date().toISOString(), verified_by: user.id }
      : { verified: false, verified_at: null, verified_by: null };
    const { error } = await supabase.from("contractors").update(payload).eq("id", contractor.id);
    if (!error && verified && contractor.denied_at) {
      const { error: clearErr } = await supabase.from("contractor_denials").delete().eq("contractor_id", contractor.id);
      if (clearErr) console.error("clearing denial failed:", clearErr);
    }
    setAdminBusy(false);
    if (error) { notify("Verify failed: " + error.message); return; }
    await loadContractors();
    // Email the contractor about the status change.
    try {
      const r = await supabase.functions.invoke("notify-contractor-verified", { body: { contractorId: contractor.id } });
      if (r.error) notify("Verified in DB, but email failed: " + (r.error.message || r.error));
    } catch (err) {
      console.error("verify-notify threw:", err);
    }
    notify(verified ? `Verified ${contractor.name}.` : `Un-verified ${contractor.name}.`);
  }

  async function adminInvite(e) {
    e.preventDefault();
    const email = adminInviteInput.trim().toLowerCase();
    if (!email) return;
    setAdminBusy(true);
    // A database trigger promotes the invitee right away if they already have
    // an account; otherwise the invite waits until they sign up.
    const { error } = await supabase.from("admin_invites").insert({
      email,
      invited_by: user.id,
    });
    setAdminBusy(false);
    if (error) { notify("Invite failed: " + error.message); return; }
    setAdminInviteInput("");
    const [aRes, iRes] = await Promise.all([
      supabase.from("admins").select("*").order("created_at"),
      supabase.from("admin_invites").select("*").order("created_at"),
    ]);
    setAdminList(aRes.data || []);
    setAdminInvites(iRes.data || []);
    notify((aRes.data || []).some(a => a.email?.toLowerCase() === email)
      ? `${email} is now an admin.`
      : `Invite saved. ${email} becomes an admin when they sign up with that email.`);
  }

  async function adminRevokeInvite(email) {
    const { error } = await supabase.from("admin_invites").delete().eq("email", email);
    if (error) { notify("Revoke failed: " + error.message); return; }
    setAdminInvites(prev => prev.filter(i => i.email !== email));
  }

  async function adminSaveCredentialReview(contractor, key, review) {
    const next = {
      ...(contractor.credential_reviews || {}),
      [key]: { ...review, reviewed_at: new Date().toISOString(), reviewed_by: user.id },
    };
    const { error } = await supabase
      .from("contractor_credentials")
      .update({ credential_reviews: next })
      .eq("contractor_id", contractor.id);
    if (error) { notify("Review save failed: " + error.message); return false; }
    await loadContractors();
    notify(`Saved review for ${contractor.name}.`);
    return true;
  }

  async function adminRemoveAdmin(row) {
    if (row.user_id === user.id) { notify("You can't remove yourself."); return; }
    const { error } = await supabase.from("admins").delete().eq("user_id", row.user_id);
    if (error) { notify("Remove failed: " + error.message); return; }
    setAdminList(prev => prev.filter(a => a.user_id !== row.user_id));
    notify(`Removed ${row.email}.`);
  }

  async function submitAuth(e) {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    const { email, password } = authForm;
    if (authMode === "signup") {
      const { data, error } = await supabase.auth.signUp({ email, password });
      setAuthBusy(false);
      if (error) {
        console.error("signUp error:", error);
        return setAuthError(error.message || error.error_description || `Signup failed (status ${error.status ?? "?"})`);
      }
      if (!data.session) {
        const alreadyExists = data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0;
        if (alreadyExists) {
          setAuthError("An account with this email already exists. Sign in instead.");
        } else {
          setAuthError("Check your email to confirm your account, then sign in.");
        }
        setAuthMode("signin");
        return;
      }
      setAuthModal(false);
      setAuthForm({ email: "", password: "" });
      notify("Account created!");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      setAuthBusy(false);
      if (error) {
        console.error("signIn error:", error);
        return setAuthError(error.message || error.error_description || `Sign in failed (status ${error.status ?? "?"})`);
      }
      setAuthModal(false);
      setAuthForm({ email: "", password: "" });
      notify("Welcome back!");
    }
  }

  async function signOut() {
    // Stop this device's notifications for the account that's leaving.
    if (pushState === "on") {
      try {
        const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
        if (sub) {
          await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
          await sub.unsubscribe();
        }
      } catch (err) { console.error("push unsubscribe failed:", err); }
      setPushState("default");
    }
    await supabase.auth.signOut();
    notify("Signed out.");
  }

function avatarInitials(name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  async function uploadCredential(file, kind) {
    // kind: "license" | "insurance"
    const ext = (file.name.split(".").pop() || "bin").toLowerCase();
    const path = `${user.id}/${kind}-${Date.now()}.${ext}`;
    const { error } = await supabase.storage
      .from("credentials")
      .upload(path, file, { upsert: true, contentType: file.type || undefined });
    if (error) throw new Error(`${kind} upload failed: ${error.message}`);
    return path;
  }

  async function saveProfile(e) {
    e.preventDefault();
    if (!user) return;
    setProfileBusy(true);
    setProfileError(null);
    try {
      const tagsArr = profileForm.tags.split(",").map(t => t.trim()).filter(Boolean);

      if (!Array.isArray(profileForm.trades) || profileForm.trades.length === 0) {
        throw new Error("Pick at least one service.");
      }
      const req = requirementsFor(profileForm.trades);

      // Universal requirements: business license + general liability insurance.
      const hasBusinessLicense = !!(profileForm.business_license_path || profileForm.business_license_file);
      const hasInsurance       = !!(profileForm.insurance_path        || profileForm.insurance_file);
      if (!hasBusinessLicense) throw new Error("Business license document is required.");
      if (!profileForm.business_license_number.trim()) throw new Error("Business license number is required.");
      if (!hasInsurance) throw new Error("Certificate of insurance is required.");
      if (!profileForm.insurance_carrier.trim()) throw new Error("Insurance carrier is required.");
      if (!profileForm.insurance_expires_at)     throw new Error("Insurance expiration date is required.");

      // Trade-specific: one license per licensed trade.
      const licensedTrades = profileForm.trades.filter(t => tradeReqMap[t]?.tradeLicense);
      for (const t of licensedTrades) {
        const entry = profileForm.trade_licenses[t] || {};
        if (!entry.path && !entry.file) {
          throw new Error(`Upload your ${tradeReqMap[t].tradeLicense} for ${t}.`);
        }
        if (!entry.number || !String(entry.number).trim()) {
          throw new Error(`Enter the license number for your ${tradeReqMap[t].tradeLicense}.`);
        }
      }

      // Trade-specific: surety bond.
      if (req.needsBond) {
        const hasBond = !!(profileForm.bond_path || profileForm.bond_file);
        if (!hasBond) throw new Error("Surety bond certificate is required for the trades you selected.");
      }

      let business_license_path = profileForm.business_license_path;
      let insurance_path        = profileForm.insurance_path;
      let bond_path             = profileForm.bond_path;
      if (profileForm.business_license_file) business_license_path = await uploadCredential(profileForm.business_license_file, "business-license");
      if (profileForm.insurance_file)        insurance_path        = await uploadCredential(profileForm.insurance_file,        "insurance");
      if (profileForm.bond_file)             bond_path             = await uploadCredential(profileForm.bond_file,             "bond");

      // Upload any new per-trade licenses and build the final JSONB shape
      // for the row (only include trades whose license was actually
      // required — deselecting a trade should drop its entry).
      const trade_licenses = {};
      for (const t of licensedTrades) {
        const entry = profileForm.trade_licenses[t] || {};
        let path = entry.path;
        if (entry.file) {
          path = await uploadCredential(entry.file, `trade-license-${t.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
        }
        trade_licenses[t] = {
          number: String(entry.number || "").trim(),
          path,
          type: tradeReqMap[t].tradeLicense,
        };
      }

      const row = {
        user_id: user.id,
        name: profileForm.name.trim(),
        trades: profileForm.trades,
        trade: profileForm.trades[0],
        location: profileForm.location.trim(),
        hourly: profileForm.hourly ? Number(profileForm.hourly) : null,
        bio: profileForm.bio.trim() || null,
        tags: tagsArr,
        website: profileForm.website.trim() || null,
        avatar: avatarInitials(profileForm.name),
        available: true,
      };
      const { data, error } = myContractor
        ? await supabase.from("contractors").update(row).eq("id", myContractor.id).select().single()
        : await supabase.from("contractors").insert(row).select().single();
      if (error) throw new Error(error.message);

      // Credentials live in a private table only the pro, admins, and a
      // hiring customer can read.
      const { error: credErr } = await supabase.from("contractor_credentials").upsert({
        contractor_id:           data.id,
        business_license_number: profileForm.business_license_number.trim(),
        business_license_path,
        trade_licenses,
        insurance_carrier:       profileForm.insurance_carrier.trim(),
        insurance_expires_at:    profileForm.insurance_expires_at,
        insurance_path,
        bond_amount:             req.needsBond && profileForm.bond_amount ? Number(profileForm.bond_amount) : null,
        bond_path:               req.needsBond ? bond_path : null,
      }, { onConflict: "contractor_id" });
      if (credErr) throw new Error("Saving your documents failed: " + credErr.message);

      // Resubmitting clears a denial so admins see them in "Pending Verification" again.
      if (myContractor?.denied_at) {
        const { error: clearErr } = await supabase.from("contractor_denials").delete().eq("contractor_id", data.id);
        if (clearErr) throw new Error("Couldn't resubmit for review: " + clearErr.message);
      }

      setMyContractor((await withContractorDetails([data]))[0]);
      setProfileModal(false);
      await loadContractors();
      // Notify admins and the contractor. Awaited so a failure surfaces
      // to the user instead of silently disappearing.
      if (!data.verified) {
        try {
          const result = await supabase.functions.invoke("notify-admin-contractor-pending");
          if (result.error) notify("Docs saved, but notification failed: " + (result.error.message || result.error));
          else if (result.data?.skipped) notify("Docs saved. Notification skipped: " + result.data.skipped);
        } catch (err) {
          console.error("notify admin threw:", err);
          notify("Docs saved, but notification threw: " + (err.message || err));
        }
      }
      notify(myContractor ? "Profile updated!" : "Profile created!");
    } catch (err) {
      setProfileError(err.message);
    } finally {
      setProfileBusy(false);
    }
  }

  function openProfileModal() {
    const existingTrades = Array.isArray(myContractor?.trades) && myContractor.trades.length > 0
      ? myContractor.trades
      : myContractor?.trade
        ? [myContractor.trade]
        : [];
    setProfileForm({
      name: myContractor?.name ?? "",
      trades: existingTrades,
      location: myContractor?.location ?? "",
      hourly: myContractor?.hourly?.toString() ?? "",
      bio: myContractor?.bio ?? "",
      tags: (myContractor?.tags ?? []).join(", "),
      website: myContractor?.website ?? "",
      business_license_number: myContractor?.business_license_number ?? "",
      business_license_path:   myContractor?.business_license_path ?? "",
      business_license_file:   null,
      // Seed trade_licenses from the row's JSONB, augmenting each entry with a null file slot.
      trade_licenses: Object.fromEntries(
        Object.entries(myContractor?.trade_licenses || {}).map(([trade, tl]) => [
          trade,
          { number: tl?.number || "", path: tl?.path || "", type: tl?.type || (tradeReqMap[trade]?.tradeLicense || ""), file: null },
        ])
      ),
      insurance_carrier:       myContractor?.insurance_carrier ?? "",
      insurance_expires_at:    myContractor?.insurance_expires_at ?? "",
      insurance_path:          myContractor?.insurance_path ?? "",
      insurance_file:          null,
      bond_amount:             myContractor?.bond_amount?.toString() ?? "",
      bond_path:               myContractor?.bond_path ?? "",
      bond_file:               null,
    });
    setProfileError(null);
    setProfileModal(true);
  }

  // Needs the private credentials row, so only meaningful for the pro
  // themselves, admins, and a hiring customer.
  // Admin dashboard "active" definitions.
  function isActiveUser(u) {
    // Only pro profiles can be deactivated; customers are always active.
    const pro = u.contractor_id ? contractors.find(c => c.id === u.contractor_id) : null;
    return !pro?.deactivated_at;
  }
  function isActiveJob(j) {
    return !j.deleted_at && j.status !== "completed";
  }
  function hasCredentialsOnFile(c) {
    return !!(c && (c.business_license_path || c.license_path) && c.insurance_path);
  }
  function isContractorVerified(c) {
    return c?.verified === true;
  }
  function canAcceptJobs(c) {
    return isContractorVerified(c) && hasCredentialsOnFile(c) && !c.deactivated_at;
  }

  async function acceptJob(jobId) {
    if (!user) return;
    if (!canAcceptJobs(myContractor)) {
      notify("Your profile must be verified before you can accept jobs.");
      openProfileModal();
      return;
    }
    const jobToAccept = jobs.find(j => j.id === jobId);
    if (jobToAccept && !contractorTrades(myContractor).includes(jobToAccept.trade)) {
      notify(`This job needs ${jobToAccept.trade}. Add that service to your profile to accept it.`);
      return;
    }
    const { data, error } = await supabase
      .from("jobs")
      .update({ accepted_by: user.id, accepted_at: new Date().toISOString() })
      .eq("id", jobId)
      .is("accepted_by", null)
      .select();
    if (error) {
      console.error("acceptJob error:", error);
      notify("Failed to accept job: " + error.message);
      return;
    }
    if (!data || data.length === 0) {
      notify("Couldn't accept — job may already be taken.");
      await loadJobs();
      return;
    }
    const acceptedJob = data[0];
    await loadJobs();
    notify("Job accepted!");

    // Drop an intro message into the customer's inbox so they can reply.
    if (acceptedJob.posted_by && acceptedJob.posted_by !== user.id && myContractor?.id) {
      const { data: contact } = await supabase.from("job_contacts").select("homeowner_name").eq("job_id", acceptedJob.id).maybeSingle();
      const introText = `Hi${contact?.homeowner_name ? " " + contact.homeowner_name : ""}, I just accepted your job "${acceptedJob.title}". Let me know when you'd like to get started — happy to answer any questions here.`;
      const { data: intro, error: msgErr } = await supabase.from("messages").insert({
        contractor_id: myContractor.id,
        sender_id:     user.id,
        recipient_id:  acceptedJob.posted_by,
        sender_email:  user.email,
        text:          introText,
      }).select("id").single();
      if (msgErr) console.error("intro message insert failed:", msgErr);
      else pushMessage(intro?.id);
    }

    // Email the customer with the news + a link back to messages.
    try {
      const r = await supabase.functions.invoke("notify-customer-job-accepted", { body: { jobId } });
      if (r.error) notify("Job accepted, but email failed: " + (r.error.message || r.error));
    } catch (err) {
      console.error("job-accepted email threw:", err);
    }
  }

  async function toggleAvailable() {
    if (!myContractor) return;
    const next = !myContractor.available;
    const { data, error } = await supabase
      .from("contractors")
      .update({ available: next })
      .eq("id", myContractor.id)
      .select()
      .single();
    if (error) {
      notify("Failed to update status: " + error.message);
      return;
    }
    setMyContractor(data);
    setContractors(prev => prev.map(c => c.id === data.id ? data : c));
    notify(next ? "You're now open for work." : "Marked as busy.");
  }

  const threadList = Object.values(messages).sort((a, b) => {
    const aLast = a.messages[a.messages.length - 1]?.created_at || "";
    const bLast = b.messages[b.messages.length - 1]?.created_at || "";
    return bLast.localeCompare(aLast);
  });

  function threadLabel(t) {
    if (t.contractor_id == null) {
      const other = adminUsers.find(u => u.id === t.counterparty_id);
      if (isAdmin) {
        // Admin viewing: counterparty is the user they're helping
        const name = other?.name || other?.email || t.counterparty_email || "User";
        return {
          name,
          sub: other ? `${other.contractor_id ? "Pro" : "Customer"} · admin conversation` : "Admin conversation",
          avatar: name.slice(0, 2).toUpperCase(),
        };
      }
      return { name: "Subcontractor Pros Team", sub: "Admin · replies go to our team", avatar: "SP" };
    }
    const contractor = contractors.find(c => c.id === t.contractor_id);
    if (isContractor && myContractor && t.contractor_id === myContractor.id) {
      // Contractor viewing: counterparty is the customer
      return {
        name: t.counterparty_email || "Customer",
        sub: "Customer",
        avatar: (t.counterparty_email || "?").slice(0, 2).toUpperCase(),
      };
    }
    return {
      name: contractor?.name || "Contractor",
      sub: contractor?.trade || "",
      avatar: contractor?.avatar || "?",
    };
  }

  const activeThread = activeChat ? messages[activeChat] : null;

  // In a team thread every admin's messages are "ours"; elsewhere only my own.
  function isOwnMessage(t, m) {
    return t.contractor_id == null && isAdmin ? !!m.from_admin : m.sender_id === user?.id;
  }
  function adminName(id) {
    if (id === user?.id) return "You";
    return adminList.find(a => a.user_id === id)?.email || "Another admin";
  }

  function unreadCount(t) {
    if (!user) return 0;
    const seenAt = lastSeenThreads[t.key] || 0;
    return t.messages.filter(m => !isOwnMessage(t, m) && new Date(m.created_at).getTime() > seenAt).length;
  }
  const totalUnread = threadList.reduce((sum, t) => sum + unreadCount(t), 0);

  useEffect(() => {
    window.addEventListener("pointerdown", unlockChime);
    window.addEventListener("keydown", unlockChime);
    return () => {
      window.removeEventListener("pointerdown", unlockChime);
      window.removeEventListener("keydown", unlockChime);
    };
  }, []);

  // App icon badge follows unread messages; opening the app clears the
  // notifications already sitting in the tray.
  useEffect(() => {
    if (!user) return;
    try {
      if (totalUnread > 0) navigator.setAppBadge?.(totalUnread);
      else navigator.clearAppBadge?.();
    } catch {}
    // The service worker adds to this count for pushes while the app is closed.
    caches?.open("app-badge")
      .then(c => c.put("/__badge-count", new Response(String(totalUnread))))
      .catch(() => {});
  }, [totalUnread, user]);

  useEffect(() => {
    if (!user || !pushSupported()) return;
    const clearTray = () => {
      if (document.visibilityState !== "visible") return;
      navigator.serviceWorker.ready
        .then(reg => reg.getNotifications())
        .then(list => list.forEach(n => n.close()))
        .catch(() => {});
    };
    clearTray();
    document.addEventListener("visibilitychange", clearTray);
    // Permission granted earlier: make sure this device is saved for this account.
    if (Notification.permission === "granted") {
      savePushSubscription().then(() => setPushState("on")).catch(err => console.error("push resync failed:", err));
    }
    return () => document.removeEventListener("visibilitychange", clearTray);
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, "");
    document.title = totalUnread > 0 ? `(${totalUnread}) ${base}` : base;
  }, [totalUnread]);

  function toggleMsgSound() {
    const next = !msgSound;
    setMsgSound(next);
    try { localStorage.setItem("tlp_msg_sound", next ? "on" : "off"); } catch {}
    if (next) { unlockChime(); playChime(); }
  }

  function markThreadSeen(threadKey) {
    setLastSeenThreads(prev => {
      const next = { ...prev, [threadKey]: Date.now() };
      try { localStorage.setItem("tlp_thread_seen", JSON.stringify(next)); } catch {}
      return next;
    });
  }

  useEffect(() => {
    if (activeChat) markThreadSeen(activeChat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChat, messages]);

  return (
    <div style={{
      fontFamily: "'DM Sans', sans-serif",
      fontWeight: 500,
      minHeight: "100vh",
      color: "#0f172a",
      paddingTop: "env(safe-area-inset-top)",
      paddingLeft: "env(safe-area-inset-left)",
      paddingRight: "env(safe-area-inset-right)",
      paddingBottom: "env(safe-area-inset-bottom)",
    }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          background-color: #c9d2dc;
          /* Slanted pinstripes in the brand gold and a soft sky blue. */
          background-image: repeating-linear-gradient(-45deg,
            rgba(245,158,11,0.30) 0 2px, transparent 2px 26px,
            rgba(56,189,248,0.26) 26px 28px, transparent 28px 52px);
          background-attachment: fixed;
        }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 2px; }
        .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
        .user-menu { position: absolute; top: calc(100% + 8px); right: 0; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 6px; min-width: 240px; display: flex; flex-direction: column; gap: 2px; z-index: 50; box-shadow: 0 12px 32px rgba(15,23,42,0.14); }
        .user-menu-who { padding: 10px 14px 12px; margin-bottom: 4px; border-bottom: 1px solid #e2e8f0; max-width: 280px; }
        .user-menu-item { background: none; border: none; cursor: pointer; padding: 12px 14px; font-size: 1rem; font-weight: 600; color: #b45309; border-radius: 8px; text-align: left; font-family: inherit; transition: background 0.15s, color 0.15s; white-space: nowrap; }
        .user-menu-item:hover { background: #f8fafc; }
        .user-menu-item:active { background: #f59e0b; color: #0f172a; }
        .user-menu-item:focus-visible { outline: 2px solid #f59e0b; outline-offset: -2px; }
        .toolbar-btn { flex: 1; background: #ffffff; border: 1px solid #e2e8f0; color: #b45309; border-radius: 12px; padding: 14px 16px; font-size: 1.0625rem; font-weight: 700; cursor: pointer; font-family: inherit; transition: background 0.15s, border-color 0.15s, color 0.15s, transform 0.1s; }
        .toolbar-btn:hover { border-color: #f59e0b; }
        .toolbar-btn:active { transform: scale(0.98); background: #f59e0b; border-color: #f59e0b; color: #0f172a; }
        .toolbar-btn.active { background: #f59e0b; border-color: #f59e0b; color: #0f172a; }
        .toolbar-btn:focus-visible { outline: 2px solid #f59e0b; outline-offset: 2px; }
        .card { background: #ffffff; border-radius: 16px; border: 1px solid #cbd5e1; box-shadow: 0 1px 2px rgba(15,23,42,0.06), 0 4px 14px rgba(15,23,42,0.07); transition: transform 0.18s, box-shadow 0.18s; }
        .card-hover:hover { transform: translateY(-2px); box-shadow: 0 8px 28px rgba(15,23,42,0.12); }
        .badge { display: inline-block; background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; border-radius: 99px; padding: 3px 10px; font-size: 0.8125rem; font-weight: 600; }
        .avail { background: #ecfdf5; color: #047857; }
        .unavail { background: #fef2f2; color: #dc2626; }
        .btn { border: none; border-radius: 10px; padding: 10px 20px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; text-align: center; font-weight: 700; cursor: pointer; font-family: inherit; font-size: 1rem; transition: opacity 0.15s, transform 0.15s; }
        .btn:hover { opacity: 0.88; transform: scale(0.98); }
        .btn:focus-visible { outline: 2px solid #f59e0b; outline-offset: 2px; }
        .btn-gold { background: #f59e0b; color: #0f172a; }
        .btn-outline { background: #ffffff; border: 2px solid #cbd5e1; color: #b45309; transition: opacity 0.15s, transform 0.15s, background 0.15s, border-color 0.15s, color 0.15s; }
        .btn-outline:hover { border-color: #f59e0b; }
        .btn-outline:not(:disabled):active, .btn-outline[aria-expanded="true"] { background: #f59e0b; border-color: #f59e0b !important; color: #0f172a !important; opacity: 1; }
        .btn-sm { padding: 7px 14px; min-height: 40px; font-size: 0.9375rem; border-radius: 8px; }
        input, textarea, select { background: #ffffff; border: 1.5px solid #cbd5e1; border-radius: 10px; color: #0f172a; padding: 10px 14px; font-family: inherit; font-weight: 500; font-size: max(16px, 1.0625rem); width: 100%; outline: none; }
        input::placeholder, textarea::placeholder { color: #475569; opacity: 1; }
        input:focus, textarea:focus, select:focus { border-color: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,0.15); }
        .msg-me { background: #f59e0b; color: #0f172a; border-radius: 18px 18px 4px 18px; }
        .msg-them { background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 18px 18px 18px 4px; }
        .notification { position: fixed; top: calc(env(safe-area-inset-top) + 20px); right: calc(env(safe-area-inset-right) + 20px); background: #f59e0b; color: #0f172a; padding: 12px 22px; border-radius: 12px; font-weight: 700; z-index: 999; animation: slidein 0.3s; }
        @keyframes slidein { from { opacity: 0; transform: translateY(-16px); } to { opacity: 1; transform: translateY(0); } }
        .modal-bg { position: fixed; inset: 0; background: rgba(15,23,42,0.45); z-index: 100; display: flex; align-items: center; justify-content: center; padding: max(20px, env(safe-area-inset-top)) max(20px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left)); backdrop-filter: blur(2px); overflow-y: auto; }
        .modal { background: #ffffff; border-radius: 20px; border: 1px solid #e2e8f0; box-shadow: 0 24px 60px rgba(15,23,42,0.25); width: 100%; max-width: 480px; padding: 28px; max-height: 90vh; overflow-y: auto; overflow-x: hidden; }
        .modal input, .modal textarea, .modal select { max-width: 100%; min-width: 0; }
        .modal input[type="date"] { min-width: 0; }
        .job-grid > * { min-width: 0; }
        .field-label { font-size: 0.875rem; color: #334155; margin-bottom: 4px; display: block; }
        .svc-picker { display: flex; flex-direction: column; gap: 8px; }
        .svc-chips { list-style: none; display: flex; flex-wrap: wrap; gap: 6px; }
        .svc-chip { display: inline-flex; align-items: center; gap: 4px; background: rgba(245,158,11,0.12); border: 1px solid #f59e0b; color: #0f172a; border-radius: 99px; padding: 3px 4px 3px 12px; font-size: 0.9375rem; max-width: 100%; flex-wrap: wrap; }
        .svc-chip.primary { background: #f59e0b; color: #0f172a; font-weight: 600; }
        .svc-chip-tag { font-size: 0.8125rem; font-weight: 800; margin-right: 2px; }
        .svc-chip-btn { background: transparent; border: none; color: inherit; cursor: pointer; font: inherit; font-size: 0.875rem; padding: 4px 8px; border-radius: 99px; opacity: 0.8; }
        .svc-chip-btn:hover { opacity: 1; background: rgba(15,23,42,0.1); }
        .svc-chip-btn:focus-visible { outline: 2px solid #f59e0b; outline-offset: 1px; }
        .svc-list { max-height: 340px; overflow-y: auto; border: 1px solid #cbd5e1; border-radius: 10px; background: #f8fafc; }
        .svc-results { display: grid; gap: 6px; padding: 8px; }
        .svc-group + .svc-group { border-top: 1px solid #e2e8f0; }
        .svc-group-btn { display: flex; width: 100%; justify-content: space-between; align-items: center; gap: 8px; background: transparent; border: none; color: #0f172a; font: inherit; font-size: 1rem; font-weight: 600; padding: 12px; cursor: pointer; text-align: left; }
        .svc-group-btn:focus-visible { outline: 2px solid #f59e0b; outline-offset: -2px; border-radius: 8px; }
        .svc-group-body { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; padding: 0 10px 12px; }
        .svc-option { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-radius: 8px; border: 1px solid #e2e8f0; background: #ffffff; cursor: pointer; font-size: 0.9375rem; }
        .svc-option.checked { border-color: #f59e0b; background: rgba(245,158,11,0.12); }
        .svc-option input { width: auto; accent-color: #f59e0b; margin-top: 2px; flex-shrink: 0; }
        .svc-option:focus-within { outline: 2px solid #f59e0b; outline-offset: 1px; }
        .admin-svc-row { display: flex; padding: 10px 12px; background: #f8fafc; border-radius: 8px; font-size: 0.9375rem; gap: 10px; }
        .join-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; margin-bottom: 20px; }
        .join-card { padding: 18px; display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; border-color: #f59e0b; }
        .admin-section { border: 1px solid #cbd5e1; border-radius: 14px; background: #ffffff; box-shadow: 0 1px 2px rgba(15,23,42,0.06), 0 4px 14px rgba(15,23,42,0.07); margin-bottom: 12px; }
        .admin-section-h { margin: 0; font-size: 1.25rem; font-weight: 700; }
        .admin-section-toggle { display: flex; width: 100%; justify-content: space-between; align-items: center; gap: 10px; background: transparent; border: none; color: #0f172a; font: inherit; padding: 16px; cursor: pointer; text-align: left; border-radius: 14px; }
        .admin-section-toggle:hover .admin-section-caret { color: #b45309; }
        .admin-section-toggle:focus-visible { outline: 2px solid #f59e0b; outline-offset: -2px; }
        .admin-section-summary { display: block; font-size: 0.875rem; font-weight: 500; color: #64748b; margin-top: 2px; }
        .admin-section-caret { color: #475569; font-size: 1.0625rem; }
        .admin-section-body { padding: 0 16px 16px; }
        .admin-section-filter { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
        .btn-outline[aria-pressed="true"] { background: #f59e0b; border-color: #f59e0b !important; color: #0f172a !important; }
        .filter-bar { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
        .filter-bar select { width: auto; min-width: 180px; max-width: 100%; }
        .svc-filter { position: relative; min-width: 220px; max-width: 100%; }
        .svc-filter-btn { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; background: #ffffff; border: 1.5px solid #cbd5e1; border-radius: 10px; color: #0f172a; padding: 10px 14px; font-family: inherit; font-weight: 500; font-size: max(16px, 1.0625rem); cursor: pointer; text-align: left; }
        .svc-filter-btn:focus-visible, .svc-filter-btn[aria-expanded="true"] { outline: none; border-color: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,0.15); }
        .svc-filter-value { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .svc-filter-menu { position: absolute; top: calc(100% + 6px); left: 0; z-index: 60; min-width: 100%; width: max-content; max-width: min(380px, calc(100vw - 32px)); max-height: min(60vh, 440px); overflow-y: auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 6px; box-shadow: 0 12px 32px rgba(15,23,42,0.16); outline: none; }
        .svc-filter-heading { color: #b45309; font-size: 1.125rem; font-weight: 800; letter-spacing: 0.3px; padding: 14px 10px 6px; margin-top: 4px; border-top: 1px solid #e2e8f0; }
        .svc-filter-opt { display: flex; justify-content: space-between; gap: 12px; padding: 8px 10px 8px 24px; border-radius: 6px; font-size: 1rem; color: #0070f3; cursor: pointer; }
        .svc-filter-opt.top { padding-left: 10px; font-weight: 600; color: #0f172a; }
        .svc-filter-opt.group { font-weight: 600; }
        .svc-filter-opt.active { background: #fef3c7; }
        .svc-filter-opt[aria-selected="true"] { color: #b45309; }
        .contractor-card:focus-visible { outline: 2px solid #f59e0b; outline-offset: 2px; border-radius: 16px; }
        .star-btn { background: none; border: none; cursor: pointer; padding: 2px; font-size: 1.625rem; line-height: 1; transition: transform 0.1s; }
        .star-btn:hover { transform: scale(1.15); }
        .star-btn:focus-visible { outline: 2px solid #f59e0b; outline-offset: 2px; border-radius: 2px; }
        .messages-layout { display: grid; grid-template-columns: 220px 1fr; gap: 16px; height: 500px; }
        .chat-sidebar-btn { display: flex; align-items: center; gap: 10px; cursor: pointer; padding: 12px; border-radius: 16px; background: #ffffff; border: 1px solid #e2e8f0; width: 100%; text-align: left; font-family: inherit; transition: border-color 0.15s; }
        .chat-sidebar-btn:focus-visible { outline: 2px solid #f59e0b; outline-offset: 2px; }
        @media (max-width: 640px) {
          .btn-sm { padding: 6px 10px; }
          .messages-layout { grid-template-columns: 1fr; height: auto; }
          .messages-chat { height: 480px; }
          .messages-layout.has-active .messages-sidebar-list { display: none !important; }
          .messages-layout:not(.has-active) .messages-chat { display: none !important; }
          .job-grid { grid-template-columns: 1fr !important; }
          .svc-group-body { grid-template-columns: 1fr; }
          .filter-bar select { flex: 1 1 100%; }
          .filter-bar .svc-filter { flex: 1 1 100%; }
          .svc-filter-menu { width: 100%; max-width: 100%; }
          .modal { padding: 20px !important; border-radius: 16px !important; }
          .modal-bg { padding: 12px !important; }
          .modal input[type="date"] { max-width: 100% !important; width: 100% !important; box-sizing: border-box !important; -webkit-appearance: none !important; appearance: none !important; }
        }
      `}</style>

      {notification && (
        <div className="notification" role="alert" aria-live="assertive">✓ {notification}</div>
      )}

      <header style={{ background: "rgba(255,255,255,0.94)", borderBottom: "1px solid #e2e8f0", padding: "0 20px", boxShadow: "0 1px 3px rgba(15,23,42,0.05)" }}>
        <div style={{ maxWidth: 900, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: 60, gap: 12, flexWrap: "wrap", padding: "8px 0", position: "relative" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0, minWidth: 0 }}>
            <span style={{ fontSize: "1.375rem", fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#fbbf24", textShadow: TITLE_OUTLINE, whiteSpace: "nowrap" }}>⚒ SUBCONTRACTOR</span>
            <span style={{ fontSize: "0.8125rem", fontFamily: "'Bebas Neue', cursive", color: "#1f2937", fontWeight: 600, letterSpacing: 1 }}>PROS</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", justifyContent: "flex-end", position: "relative" }}>
            {user ? (
              <>
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => setUserMenuOpen(o => !o)}
                  aria-expanded={userMenuOpen}
                  aria-haspopup="menu"
                  aria-label="Account menu"
                  style={{ display: "flex", alignItems: "center", gap: 8 }}
                >
                  ☰ My Account
                </button>
                {userMenuOpen && (
                  <>
                    <div onClick={() => setUserMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} aria-hidden="true" />
                    <div role="menu" className="user-menu">
                      <div role="presentation" className="user-menu-who">
                        <div style={{ fontSize: "0.8125rem", color: "#64748b", fontWeight: 600, letterSpacing: 0.5 }}>SIGNED IN AS</div>
                        <div style={{ fontSize: "0.9375rem", color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.email}</div>
                      </div>
                      {isContractor && myContractor && (
                        <button
                          className="user-menu-item"
                          role="menuitem"
                          onClick={() => { toggleAvailable(); setUserMenuOpen(false); }}
                        >
                          <span style={{ color: myContractor.available ? "#047857" : "#dc2626" }}>●</span>
                          &nbsp;{myContractor.available ? "Marked Open — tap to go Busy" : "Marked Busy — tap to go Open"}
                        </button>
                      )}
                      <button
                        className="user-menu-item"
                        role="menuitem"
                        onClick={() => { setCustomerProfileModal(true); setUserMenuOpen(false); }}
                      >
                        My Profile
                      </button>
                      <button
                        className="user-menu-item"
                        role="menuitem"
                        onClick={() => { openProfileModal(); setUserMenuOpen(false); }}
                      >
                        {myContractor ? "Edit Contractor Profile" : "Become a Contractor"}
                      </button>
                      {canAcceptJobs(myContractor) && (
                        <button
                          className="user-menu-item"
                          role="menuitem"
                          onClick={() => { setShareModal(true); setUserMenuOpen(false); }}
                        >
                          Share License &amp; Insurance
                        </button>
                      )}
                      {!isInstalled && (
                        <button
                          className="user-menu-item"
                          role="menuitem"
                          onClick={() => { triggerInstall(); setUserMenuOpen(false); }}
                        >
                          Install App
                        </button>
                      )}
                      <button
                        className="user-menu-item"
                        role="menuitem"
                        onClick={() => { setSupportModal(true); setUserMenuOpen(false); }}
                      >
                        Support
                      </button>
                      <button
                        className="user-menu-item"
                        role="menuitemcheckbox"
                        aria-checked={msgSound}
                        onClick={toggleMsgSound}
                      >
                        {msgSound ? "🔔 Message sounds: On" : "🔕 Message sounds: Off"}
                      </button>
                      <button
                        className="user-menu-item"
                        role="menuitem"
                        onClick={() => { enablePush(); setUserMenuOpen(false); }}
                      >
                        {pushState === "on"
                          ? "📲 Notifications: On"
                          : pushState === "denied" ? "🔕 Notifications blocked in settings" : "📲 Turn on notifications"}
                      </button>
                      <button
                        className="user-menu-item"
                        role="menuitem"
                        onClick={() => { setUserMenuOpen(false); window.location.reload(); }}
                      >
                        Refresh
                      </button>
                      <button
                        className="user-menu-item"
                        role="menuitem"
                        onClick={() => { signOut(); setUserMenuOpen(false); }}
                      >
                        Sign Out
                      </button>
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                {!isInstalled && (
                  <button className="btn btn-outline btn-sm" onClick={triggerInstall}>
                    Install
                  </button>
                )}
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => setSupportModal(true)}
                >
                  Support
                </button>
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => { setAuthIntent(null); setAuthMode("signin"); setAuthError(null); setAuthModal(true); }}
                >
                  Sign In
                </button>
                <button
                  className="btn btn-gold btn-sm"
                  onClick={() => { setAuthIntent(null); setAuthMode("signup"); setAuthError(null); setAuthModal(true); }}
                >
                  Join Free
                </button>
              </>
            )}
          </div>
        </div>

        <nav aria-label="Main navigation" style={{ maxWidth: 900, margin: "0 auto", display: "flex", gap: 8, padding: "10px 0 14px", flexWrap: "wrap" }}>
          <button
            className={`toolbar-btn ${tab === "search" ? "active" : ""}`}
            onClick={() => setTab("search")}
            aria-current={tab === "search" ? "page" : undefined}
          >
            Find a Pro
          </button>
          <button
            className={`toolbar-btn ${tab === "post" ? "active" : ""}`}
            onClick={() => setTab("post")}
            aria-current={tab === "post" ? "page" : undefined}
          >
            Post a Job
          </button>
          {user && (
            <button
              className={`toolbar-btn ${tab === "myjobs" ? "active" : ""}`}
              onClick={() => setTab("myjobs")}
              aria-current={tab === "myjobs" ? "page" : undefined}
            >
              My Jobs
            </button>
          )}
          {user && (
            <button
              className={`toolbar-btn ${tab === "messages" ? "active" : ""}`}
              onClick={() => setTab("messages")}
              aria-current={tab === "messages" ? "page" : undefined}
              style={{ position: "relative" }}
            >
              Messages
              {totalUnread > 0 && (
                <span style={{
                  position: "absolute", top: 6, right: 6,
                  background: "#dc2626", color: "#fff",
                  fontSize: "0.8125rem", fontWeight: 700, padding: "2px 7px", borderRadius: 999,
                  minWidth: 20, textAlign: "center", lineHeight: 1.3,
                }}>{totalUnread}</span>
              )}
            </button>
          )}
          {isContractor && (
            <button
              className={`toolbar-btn ${tab === "jobs" ? "active" : ""}`}
              onClick={() => setTab("jobs")}
              aria-current={tab === "jobs" ? "page" : undefined}
            >
              Browse Jobs
            </button>
          )}
          {isAdmin && (
            <button
              className={`toolbar-btn ${tab === "admin" ? "active" : ""}`}
              onClick={() => setTab("admin")}
              aria-current={tab === "admin" ? "page" : undefined}
            >
              Admin
            </button>
          )}
        </nav>
      </header>

      <main style={{ maxWidth: 900, margin: "0 auto", padding: "24px 20px" }}>

        {isContractor && myContractor?.deactivated_at && (() => {
          const selfDeactivated = myContractor.deactivated_by === myContractor.user_id;
          return (
            <div className="card" style={{ padding: 16, marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", borderColor: selfDeactivated ? "#64748b" : "#f87171" }}>
              <div>
                <div style={{ fontWeight: 700, marginBottom: 2 }}>Your profile is off the board</div>
                <div style={{ fontSize: "0.9375rem", color: "#475569" }}>
                  {selfDeactivated
                    ? "Homeowners can't find you in search right now. Your account and history are preserved."
                    : "An admin has taken your profile off the board. Contact support if you'd like it reviewed for reactivation."}
                </div>
              </div>
              {selfDeactivated ? (
                <button className="btn btn-gold btn-sm" onClick={() => setContractorDeactivated(myContractor, false)}>
                  Put me back on
                </button>
              ) : (
                <button className="btn btn-outline btn-sm" onClick={() => setSupportModal(true)}>
                  Contact Support
                </button>
              )}
            </div>
          );
        })()}

        {isContractor && myContractor?.denied_at && (
          <div className="card" style={{ padding: 16, marginBottom: 20, borderColor: "#f87171" }}>
            <div style={{ fontWeight: 700, marginBottom: 4, color: "#b91c1c" }}>Application was denied</div>
            <div style={{ fontSize: "0.9375rem", color: "#b91c1c", background: "#fef2f2", borderRadius: 8, padding: 10, marginBottom: 10 }}>
              <div style={{ fontSize: "0.8125rem", letterSpacing: 1, fontWeight: 700, marginBottom: 4 }}>REASON</div>
              {myContractor.denial_reason || "(no reason provided)"}
            </div>
            <div style={{ fontSize: "0.9375rem", color: "#475569", marginBottom: 10 }}>
              Correct the issue and reapply — click below to update your profile. Once you save, our admin team will review again.
            </div>
            <button className="btn btn-gold btn-sm" onClick={openProfileModal}>
              Update &amp; Reapply
            </button>
          </div>
        )}

        {isContractor && !myContractor?.deactivated_at && !hasCredentialsOnFile(myContractor) && (
          <div className="card" style={{ padding: 16, marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", borderColor: "#f87171" }}>
            <div>
              <div style={{ fontWeight: 700, marginBottom: 2 }}>Upload your business license &amp; insurance</div>
              <div style={{ fontSize: "0.9375rem", color: "#475569" }}>Required before our team can review your profile and you can accept jobs.</div>
            </div>
            <button className="btn btn-gold btn-sm" onClick={openProfileModal}>Add Documents</button>
          </div>
        )}

        {isContractor && !myContractor?.deactivated_at && hasCredentialsOnFile(myContractor) && !myContractor.verified && (
          <div className="card" style={{ padding: 16, marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", borderColor: "#fbbf24" }}>
            <div>
              <div style={{ fontWeight: 700, marginBottom: 2 }}>⏳ Documents under review</div>
              <div style={{ fontSize: "0.9375rem", color: "#475569" }}>Our team is reviewing your documents. You'll be able to accept jobs once your profile is approved.</div>
            </div>
            <button className="btn btn-outline btn-sm" onClick={openProfileModal}>Update Documents</button>
          </div>
        )}


        {/* SEARCH TAB */}
        {tab === "search" && (
          <section aria-labelledby="search-heading">
            <h1 id="search-heading" style={{ fontSize: "1.875rem", fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#fbbf24", textShadow: TITLE_OUTLINE, marginBottom: 4 }}>FIND A CONTRACTOR</h1>
            <p style={{ color: "#334155", marginBottom: 20, fontSize: "1rem" }}>Construction, cleaning, maintenance, and specialty service pros</p>

            {!user && (
              <div className="join-cards">
                <div className="card join-card">
                  <div>
                    <div style={{ fontWeight: 700, fontSize: "1.0625rem", marginBottom: 4 }}>🏠 Need work done?</div>
                    <div style={{ color: "#475569", fontSize: "0.9375rem", lineHeight: 1.5 }}>
                      Post your job for free and get matched with verified local pros. Homeowners and businesses welcome.
                    </div>
                  </div>
                  <button
                    className="btn btn-gold"
                    onClick={() => { setTab("post"); setAuthIntent("customer"); setAuthMode("signup"); setAuthError(null); setAuthModal(true); }}
                    style={{ whiteSpace: "nowrap" }}
                  >
                    Post a Job →
                  </button>
                </div>
                <div className="card join-card">
                  <div>
                    <div style={{ fontWeight: 700, fontSize: "1.0625rem", marginBottom: 4 }}>⚒ Are you a subcontractor?</div>
                    <div style={{ color: "#475569", fontSize: "0.9375rem", lineHeight: 1.5 }}>
                      Set up your business profile, upload your license &amp; insurance, and start accepting local jobs. Free to join.
                    </div>
                  </div>
                  <button
                    className="btn btn-gold"
                    onClick={() => { setAuthIntent("pro"); setAuthMode("signup"); setAuthError(null); setAuthModal(true); }}
                    style={{ whiteSpace: "nowrap" }}
                  >
                    Get Hired →
                  </button>
                </div>
              </div>
            )}
            <div className="filter-bar">
              <label htmlFor="contractor-search" className="sr-only">Search pros</label>
              <input
                id="contractor-search"
                type="search"
                placeholder="Search by name, service, or city — e.g. drywall, janitorial"
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{ flex: 1, minWidth: 200 }}
              />
              <label htmlFor="trade-filter" className="sr-only">Filter by service</label>
              <ServiceFilter id="trade-filter" catalog={catalog} value={serviceFilter} onChange={setServiceFilter} />
            </div>
            <div style={{ display: "grid", gap: 16 }} role="list" aria-label="Contractor listings">
              {filtered.map(c => (
                <div
                  key={c.id}
                  className="card card-hover contractor-card"
                  style={{ padding: 20, display: "flex", gap: 16, alignItems: "flex-start", cursor: "pointer" }}
                  role="listitem"
                  onClick={() => setModal(c)}
                  onKeyDown={e => (e.key === "Enter" || e.key === " ") && setModal(c)}
                  tabIndex={0}
                  aria-label={`View profile for ${c.name}, ${contractorTrades(c).join(" and ")} in ${c.location}`}
                >
                  <Avatar initials={c.avatar} size={52} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
                      <span style={{ fontWeight: 700, fontSize: "1.0625rem" }}>{c.name}</span>
                      <span className={`badge ${c.available ? "avail" : "unavail"}`}>
                        {c.available ? "Available" : "Busy"}
                      </span>
                      {isContractorVerified(c) && (
                        <span className="badge avail" title={VERIFIED_PRO_MEANING}>✓ Verified pro</span>
                      )}
                    </div>
                    <div style={{ color: "#475569", fontSize: "0.9375rem", marginBottom: 6 }}>{contractorTrades(c).join(" · ")} · {c.location}</div>
                    <VerifiedCredentialBadges contractor={c} />
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                      <Stars rating={c.rating} />
                      <span style={{ fontSize: "0.9375rem", color: "#475569" }}>{c.rating} ({c.reviews_count} reviews)</span>
                      <span style={{ color: "#b45309", fontWeight: 700, fontSize: "0.9375rem" }}>${c.hourly}/hr</span>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {c.tags.map(tag => <span key={tag} className="badge">{tag}</span>)}
                    </div>
                  </div>
                  <button
                    className="btn btn-gold btn-sm"
                    onClick={e => { e.stopPropagation(); openChatWithContractor(c); }}
                    aria-label={`Message ${c.name}`}
                  >
                    Message
                  </button>
                </div>
              ))}
              {filtered.length === 0 && (
                <div style={{ textAlign: "center", color: "#64748b", padding: 40 }} role="status">
                  No contractors found. Try adjusting your search.
                </div>
              )}
            </div>
          </section>
        )}

        {/* POST JOB TAB */}
        {tab === "post" && !user && (
          <section aria-labelledby="post-heading" style={{ maxWidth: 560 }}>
            <h1 id="post-heading" style={{ fontSize: "1.875rem", fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#fbbf24", textShadow: TITLE_OUTLINE, marginBottom: 4 }}>POST A JOB</h1>
            <div className="card" style={{ padding: 28, textAlign: "center" }}>
              <div style={{ fontSize: "2.25rem", marginBottom: 12 }} aria-hidden="true">🔒</div>
              <div style={{ fontWeight: 700, fontSize: "1.25rem", marginBottom: 6 }}>Sign up to post a job</div>
              <div style={{ color: "#475569", fontSize: "1rem", marginBottom: 18 }}>
                Create a free customer account to post jobs and connect with verified contractors.
              </div>
              <button
                className="btn btn-gold"
                onClick={() => { setAuthIntent("customer"); setAuthMode("signup"); setAuthError(null); setAuthModal(true); }}
              >
                Create Account
              </button>
            </div>
          </section>
        )}

        {tab === "post" && isCustomer && (
          <section aria-labelledby="post-heading" style={{ maxWidth: 720 }}>
            <h1 id="post-heading" style={{ fontSize: "1.875rem", fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#fbbf24", textShadow: TITLE_OUTLINE, marginBottom: 4 }}>POST A JOB</h1>
            <p style={{ color: "#334155", marginBottom: 24, fontSize: "1rem" }}>Describe your project and let contractors come to you</p>
            <form
              className="card"
              style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}
              onSubmit={e => { e.preventDefault(); postJob(); }}
              noValidate
            >
              <div>
                <label htmlFor="job-title" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>
                  Job Title <span aria-hidden="true">*</span>
                </label>
                <input
                  id="job-title"
                  placeholder="e.g. Kitchen Remodel – 1,200 sq ft"
                  value={jobForm.title}
                  onChange={e => setJobForm(f => ({ ...f, title: e.target.value }))}
                  required
                  aria-required="true"
                />
              </div>
              <ServicePicker
                catalog={catalog}
                idPrefix="job-svc"
                value={jobForm.trades}
                onChange={trades => setJobForm(f => ({ ...f, trades }))}
                label={<>Services Needed * <span style={{ color: "#64748b" }}>(pick one or more — each becomes a separate sub-job that a matching pro can accept)</span></>}
              />
              <div>
                <label htmlFor="job-budget" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Budget ($) <span style={{ color: "#64748b" }}>(total across all trades)</span></label>
                <input
                  id="job-budget"
                  placeholder="e.g. 5000"
                  value={jobForm.budget}
                  onChange={e => setJobForm(f => ({ ...f, budget: e.target.value }))}
                  type="number"
                  min="0"
                />
              </div>
              <div>
                <label htmlFor="job-location" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>
                  Location <span aria-hidden="true">*</span>
                </label>
                <CityStateInput
                  id="job-location"
                  required
                  value={jobForm.location}
                  onChange={v => setJobForm(f => ({ ...f, location: v }))}
                />
              </div>
              {jobForm.trades.length > 0 && (
                <div style={{ background: "#f8fafc", borderRadius: 10, padding: 12, fontSize: "0.875rem", color: "#475569", lineHeight: 1.6 }} role="note">
                  <div style={{ fontWeight: 700, color: "#334155", marginBottom: 4 }}>Licensing</div>
                  {jobForm.trades.map(t => (
                    <div key={t}><strong style={{ color: "#0f172a", fontWeight: 600 }}>{t}:</strong> {licensingSummary(t, jobForm.location)}</div>
                  ))}
                  <div style={{ marginTop: 4, color: "#64748b" }}>Confirm any license your project needs with the pro you hire and your local permitting office.</div>
                </div>
              )}
              <div>
                <label htmlFor="job-desc" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Job Description</label>
                <textarea
                  id="job-desc"
                  rows={4}
                  placeholder="Describe the scope of work, materials, timeline..."
                  value={jobForm.desc}
                  onChange={e => setJobForm(f => ({ ...f, desc: e.target.value }))}
                />
              </div>

              <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 14, marginTop: 4 }}>
                <div style={{ fontSize: "0.875rem", color: "#b45309", fontWeight: 700, letterSpacing: 1, marginBottom: 10 }}>YOUR CONTACT INFO</div>
                <div style={{ fontSize: "0.875rem", color: "#64748b", marginBottom: 12 }}>Only shared with the contractor who accepts your job.</div>
                <div>
                  <label htmlFor="job-name" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>
                    Your Name <span aria-hidden="true">*</span>
                  </label>
                  <input
                    id="job-name"
                    required
                    aria-required="true"
                    placeholder="First & last name"
                    value={jobForm.homeowner_name}
                    onChange={e => setJobForm(f => ({ ...f, homeowner_name: e.target.value }))}
                  />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }} className="job-grid">
                  <div>
                    <label htmlFor="job-email" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>
                      Email <span aria-hidden="true">*</span>
                    </label>
                    <input
                      id="job-email"
                      type="email"
                      required
                      aria-required="true"
                      placeholder="you@example.com"
                      value={jobForm.homeowner_email}
                      onChange={e => setJobForm(f => ({ ...f, homeowner_email: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label htmlFor="job-phone" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Phone (optional)</label>
                    <input
                      id="job-phone"
                      type="tel"
                      placeholder="(555) 555-5555"
                      value={jobForm.homeowner_phone}
                      onChange={e => setJobForm(f => ({ ...f, homeowner_phone: e.target.value }))}
                    />
                  </div>
                </div>
              </div>

              <button type="submit" className="btn btn-gold" style={{ alignSelf: "flex-start", padding: "12px 28px" }}>
                Post Job →
              </button>
            </form>

            <h2 style={{ fontSize: "1.375rem", fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#fbbf24", textShadow: TITLE_OUTLINE, marginTop: 32, marginBottom: 12 }}>
              YOUR POSTED JOBS
            </h2>
            {myJobs.length === 0 ? (
              <div style={{ color: "#64748b", padding: 20 }}>You haven't posted any jobs yet.</div>
            ) : (
              <div style={{ display: "grid", gap: 12 }} role="list" aria-label="Your posted jobs">
                {myJobs.map(j => {
                  const removedByAdmin = !!j.deleted_at && j.deleted_by !== user.id;
                  return (
                  <div key={j.id} className="card" style={{ padding: 18, opacity: removedByAdmin ? 0.7 : 1, borderColor: removedByAdmin ? "#f87171" : undefined }} role="listitem">
                    {removedByAdmin && (
                      <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: 10, marginBottom: 12, fontSize: "0.9375rem", color: "#b91c1c" }}>
                        This job was removed by an admin. Contact support if you'd like it reviewed.
                      </div>
                    )}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 700, fontSize: "1.0625rem" }}>{j.title}</div>
                      {j.budget != null && (
                        <span style={{ color: "#b45309", fontWeight: 700, fontSize: "1rem" }}>${Number(j.budget).toLocaleString()}</span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                      <span className="badge">{j.trade}</span>
                      <span className="badge">{j.location}</span>
                      {removedByAdmin
                        ? <span className="badge unavail">Removed by admin</span>
                        : j.status === "completed"
                          ? <span className="badge avail">✓ Completed</span>
                          : j.accepted_by
                            ? <span className="badge avail">Accepted</span>
                            : <span className="badge">Open</span>}
                    </div>
                    {j.accepter && !removedByAdmin && (
                      <div style={{ background: "#f8fafc", borderRadius: 10, padding: 12, marginBottom: 8 }}>
                        <div style={{ fontSize: "0.8125rem", fontWeight: 700, letterSpacing: 1, color: "#b45309", marginBottom: 6 }}>ACCEPTED BY</div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                          <div>
                            <div style={{ fontWeight: 600 }}>{j.accepter.name}</div>
                            <div style={{ fontSize: "0.9375rem", color: "#475569" }}>{contractorTrades(j.accepter).join(" · ")} · {j.accepter.location}</div>
                            {j.accepter.website && (
                              <div style={{ fontSize: "0.9375rem", marginTop: 4 }}>
                                <a
                                  href={/^https?:\/\//i.test(j.accepter.website) ? j.accepter.website : `https://${j.accepter.website}`}
                                  target="_blank" rel="noreferrer"
                                  style={{ color: "#b45309", textDecoration: "underline" }}
                                >
                                  {j.accepter.website.replace(/^https?:\/\//i, "")}
                                </a>
                              </div>
                            )}
                          </div>
                          {j.status === "completed" || myReviewedJobIds.has(j.id) ? (
                            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                              <span className="badge avail">✓ Completed</span>
                              <button className="btn btn-outline btn-sm" onClick={() => reopenJob(j)}>
                                Mark Uncompleted
                              </button>
                            </div>
                          ) : (
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <button className="btn btn-gold btn-sm" onClick={() => openCompleteModal(j)}>
                                Mark Complete
                              </button>
                              <button className="btn btn-outline btn-sm" onClick={() => openReleaseModal(j)}>
                                Release Contractor
                              </button>
                            </div>
                          )}
                        </div>
                        <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 8, padding: 12, fontSize: "0.9375rem" }}>
                          <div style={{ fontSize: "0.8125rem", fontWeight: 700, letterSpacing: 1, color: "#047857", marginBottom: 8 }}>
                            CREDENTIALS
                          </div>
                          <CredentialList contractor={j.accepter} reqMap={tradeReqMap} showDocs />
                          <button
                            className="btn btn-outline btn-sm"
                            style={{ marginTop: 10, borderColor: "#a7f3d0", color: "#047857" }}
                            onClick={() => setModal(j.accepter)}
                          >
                            View full contractor profile
                          </button>
                        </div>
                      </div>
                    )}
                    {!j.accepter && !removedByAdmin && (
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                        <button className="btn btn-outline btn-sm" onClick={() => openJobEdit(j)}>
                          Edit Job
                        </button>
                        <button
                          className="btn btn-outline btn-sm"
                          onClick={() => deleteJob(j)}
                          style={{ borderColor: "#f87171", color: "#b91c1c" }}
                        >
                          Delete Job
                        </button>
                      </div>
                    )}
                    {j.description && (
                      <p style={{ color: "#475569", fontSize: "0.9375rem", lineHeight: 1.5 }}>{j.description}</p>
                    )}
                    <div style={{ color: "#64748b", fontSize: "0.8125rem", marginTop: 8 }}>
                      Posted {new Date(j.created_at).toLocaleString()}
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* JOBS TAB (contractors only) */}
        {tab === "jobs" && user && (
          <section aria-labelledby="jobs-heading">
            <h1 id="jobs-heading" style={{ fontSize: "1.875rem", fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#fbbf24", textShadow: TITLE_OUTLINE, marginBottom: 4 }}>OPEN JOBS</h1>
            <p style={{ color: "#334155", marginBottom: 20, fontSize: "1rem" }}>Browse jobs posted by homeowners and businesses. Accept work that matches your services.</p>
            <div className="filter-bar" style={{ alignItems: "center" }}>
              <label htmlFor="job-trade-filter" className="sr-only">Filter by service</label>
              <ServiceFilter id="job-trade-filter" catalog={catalog} value={serviceFilter} onChange={setServiceFilter} />
              {myContractor && (
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.9375rem", color: "#334155", cursor: "pointer" }}>
                  <input type="checkbox" checked={onlyMyServices} onChange={e => setOnlyMyServices(e.target.checked)} style={{ width: "auto", accentColor: "#f59e0b" }} />
                  Only my services
                </label>
              )}
            </div>
            {jobs.length === 0 ? (
              <div style={{ color: "#64748b", padding: 40, textAlign: "center" }} role="status">
                No jobs posted yet. Check back soon.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 12 }} role="list" aria-label="Open jobs">
                {openJobsShown.map(j => {
                  return (
                    <div key={j.id} className="card" style={{ padding: 20 }} role="listitem">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
                        <div style={{ fontWeight: 700, fontSize: "1.125rem" }}>{j.title}</div>
                        {j.budget != null && (
                          <span style={{ color: "#b45309", fontWeight: 700, fontSize: "1.0625rem" }}>${Number(j.budget).toLocaleString()}</span>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                        <span className="badge">{j.trade}</span>
                        <span className="badge">{j.location}</span>
                      </div>
                      <div style={{ fontSize: "0.875rem", color: "#64748b", marginBottom: j.description ? 10 : 0 }}>
                        Licensing — {licensingSummary(j.trade, j.location)}
                      </div>
                      {j.description && (
                        <p style={{ color: "#475569", fontSize: "0.9375rem", lineHeight: 1.55, marginBottom: 10 }}>{j.description}</p>
                      )}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                        <div style={{ color: "#64748b", fontSize: "0.8125rem" }}>
                          Posted {new Date(j.created_at).toLocaleString()}
                        </div>
                        {!j.accepted_by && (() => {
                          const verified = canAcceptJobs(myContractor);
                          const tradeMatch = myContractor && contractorTrades(myContractor).includes(j.trade);
                          const blocked  = !myContractor || !verified || !tradeMatch;
                          const title = !myContractor
                            ? "Create your profile first"
                            : !verified
                              ? "Your profile must be verified to accept jobs"
                              : !tradeMatch
                                ? `Needs ${j.trade} — add that service to your profile to accept`
                                : undefined;
                          return (
                            <button
                              className="btn btn-gold btn-sm"
                              onClick={() => acceptJob(j.id)}
                              disabled={blocked}
                              title={title}
                              style={{ opacity: blocked ? 0.5 : 1 }}
                            >
                              Accept Job
                            </button>
                          );
                        })()}
                      </div>
                    </div>
                  );
                })}
                {openJobsShown.length === 0 && (
                  <div style={{ color: "#64748b", textAlign: "center", padding: 24 }} role="status">
                    No open jobs match these filters. Try "All services", or check <button className="btn btn-outline btn-sm" onClick={() => setTab("myjobs")} style={{ marginLeft: 4 }}>My Jobs</button> for work you've already accepted.
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* MY JOBS TAB */}
        {tab === "myjobs" && user && (() => {
          const workingOn = jobs.filter(j => j.accepted_by === user.id && !j.deleted_at);
          const posted    = myJobs;
          return (
            <section aria-labelledby="myjobs-heading">
              <h1 id="myjobs-heading" style={{ fontSize: "1.875rem", fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#fbbf24", textShadow: TITLE_OUTLINE, marginBottom: 4 }}>MY JOBS</h1>
              <p style={{ color: "#334155", marginBottom: 20, fontSize: "1rem" }}>Everything you're working on and everything you've posted.</p>

              {workingOn.length === 0 && posted.length === 0 && (
                <div className="card" style={{ padding: 24, textAlign: "center", color: "#475569" }}>
                  Nothing here yet. <button className="btn btn-outline btn-sm" onClick={() => setTab("search")}>Find a Pro</button> or <button className="btn btn-outline btn-sm" onClick={() => setTab("post")}>Post a Job</button>.
                </div>
              )}

              {workingOn.length > 0 && (
                <>
                  <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: 10 }}>Jobs I'm Working On ({workingOn.length})</h2>
                  <div style={{ display: "grid", gap: 12, marginBottom: 24 }}>
                    {workingOn.map(j => (
                      <div key={j.id} className="card" style={{ padding: 18 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
                          <div style={{ fontWeight: 700, fontSize: "1.0625rem" }}>{j.title}</div>
                          {j.budget != null && <span style={{ color: "#b45309", fontWeight: 700 }}>${Number(j.budget).toLocaleString()}</span>}
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                          <span className="badge">{j.trade}</span>
                          <span className="badge">{j.location}</span>
                          {j.status === "completed"
                            ? <span className="badge avail">✓ Completed</span>
                            : <span className="badge avail">Accepted</span>}
                        </div>
                        {j.description && <p style={{ color: "#475569", fontSize: "0.9375rem", lineHeight: 1.55, marginBottom: 10 }}>{j.description}</p>}
                        <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 10, padding: 12 }}>
                          <div style={{ fontSize: "0.8125rem", fontWeight: 700, letterSpacing: 1, color: "#047857", marginBottom: 6 }}>HOMEOWNER CONTACT</div>
                          {j.homeowner_name && <div style={{ fontWeight: 600 }}>{j.homeowner_name}</div>}
                          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: "0.9375rem", marginTop: 4 }}>
                            {j.homeowner_email && <a href={`mailto:${j.homeowner_email}`} style={{ color: "#047857", textDecoration: "underline" }}>{j.homeowner_email}</a>}
                            {j.homeowner_phone && <a href={`tel:${j.homeowner_phone}`} style={{ color: "#047857", textDecoration: "underline" }}>{j.homeowner_phone}</a>}
                          </div>
                        </div>
                        {j.accepted_at && <div style={{ color: "#64748b", fontSize: "0.8125rem", marginTop: 8 }}>Accepted {new Date(j.accepted_at).toLocaleString()}</div>}
                      </div>
                    ))}
                  </div>
                </>
              )}

              {posted.length > 0 && (
                <>
                  <h2 style={{ fontSize: "1.25rem", fontWeight: 700, marginBottom: 10 }}>Jobs I've Posted ({posted.length})</h2>
                  <div style={{ display: "grid", gap: 12 }}>
                    {posted.map(j => (
                      <div key={j.id} className="card" style={{ padding: 18 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
                          <div style={{ fontWeight: 700, fontSize: "1.0625rem" }}>{j.title}</div>
                          {j.budget != null && <span style={{ color: "#b45309", fontWeight: 700 }}>${Number(j.budget).toLocaleString()}</span>}
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                          <span className="badge">{j.trade}</span>
                          <span className="badge">{j.location}</span>
                          {j.status === "completed"
                            ? <span className="badge avail">✓ Completed</span>
                            : j.accepted_by
                              ? <span className="badge avail">Accepted</span>
                              : <span className="badge">Open</span>}
                        </div>
                        {j.accepter && (
                          <div style={{ fontSize: "0.9375rem", color: "#475569", marginBottom: 8 }}>
                            Accepted by <strong style={{ color: "#0f172a" }}>{j.accepter.name}</strong> — see full details on the Post tab.
                          </div>
                        )}
                        <button className="btn btn-outline btn-sm" onClick={() => setTab("post")}>Manage in Post tab →</button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
          );
        })()}

        {/* MESSAGES TAB */}
        {tab === "messages" && (
          <section aria-labelledby="messages-heading">
            <h1 id="messages-heading" style={{ fontSize: "1.875rem", fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#fbbf24", textShadow: TITLE_OUTLINE, marginBottom: 16 }}>MESSAGES</h1>
            {(pushState === "default" || (pushState === "unsupported" && isIOS() && !isInstalled)) && (
              <div className="card" style={{ padding: 14, marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", borderColor: "#f59e0b" }}>
                <div style={{ fontSize: "1rem", color: "#334155", flex: 1, minWidth: 220 }}>
                  📲 <strong>Get notified about new messages</strong>, even when the app is closed.
                  {pushState === "unsupported" && " On iPhone, add the app to your Home Screen first."}
                </div>
                <button className="btn btn-gold btn-sm" onClick={enablePush}>
                  {pushState === "unsupported" ? "How to add it" : "Turn on notifications"}
                </button>
              </div>
            )}
            {threadList.length === 0 ? (
              <div className="card" style={{ padding: 40, textAlign: "center" }}>
                <div style={{ fontSize: "2.25rem", marginBottom: 12 }} aria-hidden="true">💬</div>
                <div style={{ fontWeight: 700, fontSize: "1.25rem", marginBottom: 6 }}>No conversations yet</div>
                <div style={{ color: "#475569", fontSize: "1rem", marginBottom: 16 }}>
                  {isContractor
                    ? "Customers who message you will show up here."
                    : <>Start a chat by clicking <span style={{ color: "#b45309", fontWeight: 600 }}>Message</span> on a contractor in the Find tab.</>}
                </div>
                {!isContractor && (
                  <button className="btn btn-gold btn-sm" onClick={() => setTab("search")}>Browse Contractors</button>
                )}
              </div>
            ) : (
            <div className={`messages-layout ${activeChat ? "has-active" : ""}`}>
              <div
                className="messages-sidebar-list"
                style={{ display: "flex", flexDirection: "column", gap: 8 }}
                role="list"
                aria-label="Conversations"
              >
                {threadList.map(t => {
                  const label = threadLabel(t);
                  const unread = unreadCount(t);
                  return (
                    <button
                      key={t.key}
                      className="chat-sidebar-btn"
                      role="listitem"
                      onClick={() => setActiveChat(t.key)}
                      style={{ borderColor: activeChat === t.key ? "#f59e0b" : unread > 0 ? "#f59e0b" : "#e2e8f0" }}
                      aria-pressed={activeChat === t.key}
                      aria-label={`Chat with ${label.name}${unread ? `, ${unread} unread` : ""}`}
                    >
                      <Avatar initials={label.avatar} size={36} />
                      <div style={{ overflow: "hidden", flex: 1 }}>
                        <div style={{ fontWeight: unread > 0 ? 700 : 600, fontSize: "0.9375rem", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "#0f172a" }}>{label.name}</div>
                        <div style={{ fontSize: "0.8125rem", color: "#64748b" }}>{label.sub}</div>
                      </div>
                      {unread > 0 && (
                        <span style={{
                          background: "#dc2626", color: "#fff",
                          fontSize: "0.8125rem", fontWeight: 700, padding: "2px 8px", borderRadius: 999, flexShrink: 0,
                        }}>{unread}</span>
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="card messages-chat" style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <div style={{ padding: "14px 18px", borderBottom: "1px solid #e2e8f0", display: "flex", alignItems: "center", gap: 12 }}>
                  {activeThread && (() => {
                    const label = threadLabel(activeThread);
                    return (
                      <>
                        <button
                          onClick={() => setActiveChat(null)}
                          aria-label="Back to conversations"
                          style={{ background: "transparent", border: "none", color: "#0f172a", cursor: "pointer", fontSize: "1.375rem", padding: 4, lineHeight: 1 }}
                        >
                          ←
                        </button>
                        <Avatar initials={label.avatar} size={36} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600 }}>{label.name}</div>
                          <div style={{ fontSize: "0.875rem", color: "#64748b" }}>{label.sub}</div>
                        </div>
                      </>
                    );
                  })()}
                  {!activeThread && (
                    <div style={{ color: "#64748b", fontSize: "0.9375rem" }}>Pick a conversation from the list</div>
                  )}
                </div>
                <div
                  style={{ flex: 1, overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 10 }}
                  role="log"
                  aria-live="polite"
                  aria-label="Message history"
                >
                  {(!activeThread || activeThread.messages.length === 0) && (
                    <div style={{ color: "#64748b", textAlign: "center", marginTop: 60 }}>No messages yet. Say hello!</div>
                  )}
                  {(activeThread?.messages || []).map((m, i) => {
                    const mine = isOwnMessage(activeThread, m);
                    const showSender = isAdmin && activeThread.contractor_id == null && m.from_admin;
                    return (
                      <div key={m.id || i} style={{ display: "flex", flexDirection: "column", alignItems: mine ? "flex-end" : "flex-start" }}>
                        <div
                          className={mine ? "msg-me" : "msg-them"}
                          style={{ padding: "10px 14px", maxWidth: "72%", fontSize: "1rem" }}
                        >
                          {m.text}
                        </div>
                        {showSender && (
                          <div style={{ fontSize: "0.8125rem", color: "#64748b", marginTop: 3 }}>Sent by {adminName(m.sender_id)}</div>
                        )}
                      </div>
                    );
                  })}
                  <div ref={messagesEndRef} />
                </div>
                <div style={{ padding: "12px 18px", borderTop: "1px solid #e2e8f0", display: "flex", gap: 10 }}>
                  <label htmlFor="msg-input" className="sr-only">Message</label>
                  <input
                    id="msg-input"
                    placeholder={activeThread ? "Type a message..." : "Pick a conversation to start"}
                    value={msgInput}
                    onChange={e => setMsgInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && sendMessage()}
                    disabled={!activeThread}
                  />
                  <button
                    className="btn btn-gold"
                    style={{ whiteSpace: "nowrap", opacity: activeThread ? 1 : 0.5 }}
                    onClick={sendMessage}
                    disabled={!activeThread}
                    aria-label="Send message"
                  >
                    Send →
                  </button>
                </div>
              </div>
            </div>
            )}
          </section>
        )}

        {/* ADMIN TAB */}
        {tab === "admin" && isAdmin && (
          <section aria-labelledby="admin-heading">
            <h1 id="admin-heading" style={{ fontSize: "1.875rem", fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#fbbf24", textShadow: TITLE_OUTLINE, marginBottom: 4 }}>ADMIN</h1>
            <p style={{ color: "#334155", marginBottom: 20, fontSize: "1rem" }}>Verify contractor documents and manage the admin team.</p>

            <AdminSection id="pending" title="Pending Verification" summary={`${contractors.filter(c => hasCredentialsOnFile(c) && !c.verified && !c.denied_at).length} waiting`} defaultOpen>
            {() => contractors.filter(c => hasCredentialsOnFile(c) && !c.verified && !c.denied_at).length === 0 ? (
              <div style={{ color: "#64748b", padding: 12 }}>Nothing waiting for review. 🎉</div>
            ) : (
              <div style={{ display: "grid", gap: 12, marginBottom: 32 }}>
                {contractors.filter(c => hasCredentialsOnFile(c) && !c.verified && !c.denied_at).map(c => (
                  <div key={c.id} className="card" style={{ padding: 18 }}>
                    <div style={{ display: "flex", gap: 14, alignItems: "flex-start", marginBottom: 10 }}>
                      <Avatar initials={c.avatar} size={44} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 700 }}>{c.name}</div>
                        <div style={{ fontSize: "0.9375rem", color: "#475569" }}>{contractorTrades(c).join(" · ")} · {c.location}</div>
                      </div>
                    </div>
                    <div style={{ marginBottom: 12 }}>
                      <CredentialReviewPanel contractor={c} reqMap={tradeReqMap} onSave={adminSaveCredentialReview} />
                    </div>
                    {(() => {
                      const unreviewed = contractorCredentials(c, tradeReqMap).filter(i => i.status === "pending").length;
                      return unreviewed > 0 ? (
                        <div style={{ fontSize: "0.875rem", color: "#b45309", marginBottom: 10 }}>
                          {unreviewed} document{unreviewed === 1 ? "" : "s"} not yet reviewed. Approving the profile doesn't mark documents verified.
                        </div>
                      ) : null;
                    })()}
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      <button className="btn btn-gold btn-sm" onClick={() => adminSetVerified(c, true)} disabled={adminBusy}>
                        Verify
                      </button>
                      {c.user_id && !adminList.some(a => a.user_id === c.user_id) && (
                        <button className="btn btn-outline btn-sm" onClick={() => openAdminChat(c.user_id)}>Message pro</button>
                      )}
                      <button className="btn btn-outline btn-sm" onClick={() => openDenyModal(c)} style={{ borderColor: "#f87171", color: "#b91c1c" }}>
                        Deny
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            </AdminSection>

            {/* Denied contractors — data stays visible for admin review */}
            {contractors.filter(c => c.denied_at).length > 0 && (
              <AdminSection id="denied" title="Denied" summary={`${contractors.filter(c => c.denied_at).length} denied`}>
                {() => (
                <div style={{ display: "grid", gap: 12 }}>
                  {contractors.filter(c => c.denied_at).map(c => (
                    <details key={c.id} className="card" style={{ padding: 0, borderColor: "#fecaca" }}>
                      <summary style={{ padding: 14, cursor: "pointer", listStyle: "none", display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <Avatar initials={c.avatar} size={36} />
                          <div>
                            <div style={{ fontWeight: 600 }}>{c.name} <span className="badge unavail" style={{ marginLeft: 6 }}>Denied</span></div>
                            <div style={{ fontSize: "0.875rem", color: "#475569" }}>{contractorTrades(c).join(" · ")} · {c.location}</div>
                          </div>
                        </div>
                        <span style={{ fontSize: "0.875rem", color: "#64748b" }}>▾</span>
                      </summary>
                      <div style={{ padding: "0 14px 14px" }}>
                        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: 12, marginBottom: 10, fontSize: "0.9375rem", color: "#b91c1c" }}>
                          <div style={{ fontSize: "0.8125rem", letterSpacing: 1, fontWeight: 700, marginBottom: 4 }}>REASON</div>
                          {c.denial_reason || "(no reason recorded)"}
                          <div style={{ color: "#475569", fontSize: "0.875rem", marginTop: 6 }}>Denied {new Date(c.denied_at).toLocaleString()}</div>
                        </div>
                        <div style={{ marginBottom: 10 }}>
                          <CredentialReviewPanel contractor={c} reqMap={tradeReqMap} onSave={adminSaveCredentialReview} />
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button className="btn btn-gold btn-sm" onClick={() => adminSetVerified(c, true)}>Approve anyway</button>
                          <button className="btn btn-outline btn-sm" onClick={() => openDenyModal(c)}>Edit denial reason</button>
                          {c.user_id && !adminList.some(a => a.user_id === c.user_id) && (
                            <button className="btn btn-outline btn-sm" onClick={() => openAdminChat(c.user_id)}>Message pro</button>
                          )}
                        </div>
                      </div>
                    </details>
                  ))}
                </div>
                )}
              </AdminSection>
            )}

            <AdminSection
              id="verified"
              title="Verified Contractors"
              summary={`${contractors.filter(c => c.verified && !c.deactivated_at).length} on the board · ${contractors.filter(c => c.verified && c.deactivated_at).length} off`}
              counts={{ active: contractors.filter(c => c.verified && !c.deactivated_at).length, inactive: contractors.filter(c => c.verified && c.deactivated_at).length }}
              hint="Active = on the board. Inactive = taken off the board."
            >
            {filter => {
              const shownPros = byStatus(contractors.filter(c => c.verified), filter, c => !c.deactivated_at);
              return shownPros.length === 0 ? (
              <div style={{ color: "#64748b", padding: 12 }}>None here.</div>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                {shownPros.map(c => (
                  <details key={c.id} className="card" style={{ padding: 0 }}>
                    <summary style={{ padding: 14, cursor: "pointer", listStyle: "none", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}>
                        <Avatar initials={c.avatar} size={36} />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600 }}>
                            {c.name}
                            <span className="badge avail" style={{ marginLeft: 6 }}>✓ Verified pro</span>
                            {c.deactivated_at && <span className="badge unavail" style={{ marginLeft: 4 }}>Off board</span>}
                          </div>
                          <div style={{ fontSize: "0.875rem", color: "#475569" }}>{contractorTrades(c).join(" · ")} · {c.location}</div>
                        </div>
                      </div>
                      <div style={{ fontSize: "0.875rem", color: "#64748b" }}>tap to expand ▾</div>
                    </summary>
                    <div style={{ padding: "0 16px 16px" }}>
                      <div style={{ background: "#f8fafc", borderRadius: 10, padding: 12, fontSize: "0.9375rem", lineHeight: 1.75, marginBottom: 12 }}>
                        <div><strong>Trades:</strong> {contractorTrades(c).join(", ")}</div>
                        <div><strong>Location:</strong> {c.location}</div>
                        {c.hourly != null && <div><strong>Hourly:</strong> ${c.hourly}/hr</div>}
                        {c.website && <div><strong>Website:</strong> <a href={/^https?:\/\//i.test(c.website) ? c.website : `https://${c.website}`} target="_blank" rel="noreferrer" style={{ color: "#047857", textDecoration: "underline" }}>{c.website.replace(/^https?:\/\//i, "")}</a></div>}
                        {c.bio && <div style={{ marginTop: 6 }}><strong>Bio:</strong> {c.bio}</div>}
                      </div>
                      <div style={{ marginBottom: 12 }}>
                        <CredentialReviewPanel contractor={c} reqMap={tradeReqMap} onSave={adminSaveCredentialReview} />
                        {c.verified_at && (
                          <div style={{ marginTop: 6, color: "#64748b", fontSize: "0.875rem" }}>
                            Profile approved {new Date(c.verified_at).toLocaleString()}
                          </div>
                        )}
                      </div>
                      {(() => {
                        const acceptedJobs = jobs.filter(j => c.user_id && j.accepted_by === c.user_id && !j.deleted_at);
                        if (acceptedJobs.length === 0) return null;
                        return (
                          <div style={{ background: "#f8fafc", borderRadius: 10, padding: 12, marginBottom: 12 }}>
                            <div style={{ fontSize: "0.8125rem", fontWeight: 700, letterSpacing: 1, color: "#b45309", marginBottom: 8 }}>
                              JOBS ACCEPTED ({acceptedJobs.length})
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: "0.875rem", color: "#0f172a" }}>
                              {acceptedJobs.map(j => (
                                <div key={j.id} style={{ borderLeft: "2px solid #e2e8f0", paddingLeft: 10 }}>
                                  <div>
                                    <strong>{j.title}</strong>
                                    {" · "}
                                    <span style={{ color: j.status === "completed" ? "#047857" : "#b45309" }}>{j.status}</span>
                                  </div>
                                  <div style={{ color: "#475569" }}>{j.trade} · {j.location}{j.budget != null ? ` · $${Number(j.budget).toLocaleString()}` : ""}</div>
                                  {(j.homeowner_name || j.homeowner_email) && (
                                    <div style={{ color: "#475569" }}>
                                      Posted by <strong style={{ color: "#0f172a" }}>{j.homeowner_name || j.homeowner_email}</strong>
                                      {j.homeowner_email && j.homeowner_name && ` · ${j.homeowner_email}`}
                                    </div>
                                  )}
                                  {j.accepted_at && <div style={{ color: "#64748b" }}>Accepted {new Date(j.accepted_at).toLocaleString()}</div>}
                                  {j.completed_at && <div style={{ color: "#64748b" }}>Completed {new Date(j.completed_at).toLocaleString()}</div>}
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })()}
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button className="btn btn-outline btn-sm" onClick={() => adminSetVerified(c, false)} disabled={adminBusy}>
                          Un-verify
                        </button>
                        {c.user_id && !adminList.some(a => a.user_id === c.user_id) && (
                          <button className="btn btn-outline btn-sm" onClick={() => openAdminChat(c.user_id)}>Message pro</button>
                        )}
                        {c.deactivated_at ? (
                          <button className="btn btn-gold btn-sm" onClick={() => setContractorDeactivated(c, false)}>
                            Put back on board
                          </button>
                        ) : (
                          <button className="btn btn-outline btn-sm" onClick={() => setContractorDeactivated(c, true)} style={{ borderColor: "#f87171", color: "#b91c1c" }}>
                            Take off board
                          </button>
                        )}
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            );
            }}
            </AdminSection>

            <AdminSection
              id="users"
              title="Users"
              summary={`${adminUsers.length} total · ${adminUsers.filter(u => u.contractor_id).length} pros · ${adminUsers.filter(u => !u.contractor_id).length} customers`}
              counts={{ active: adminUsers.filter(isActiveUser).length, inactive: adminUsers.filter(u => !isActiveUser(u)).length }}
              hint="Inactive = pros whose profile is deactivated (taken off the board)."
            >
            {filter => {
              const q = adminUserSearch.trim().toLowerCase();
              const shown = byStatus(adminUsers, filter, isActiveUser).filter(u =>
                (!q || (u.name || "").toLowerCase().includes(q) || (u.email || "").toLowerCase().includes(q)) &&
                (adminUserRole === "" ||
                  (adminUserRole === "pro" && u.contractor_id) ||
                  (adminUserRole === "customer" && !u.contractor_id) ||
                  (adminUserRole === "admin" && u.is_admin)));
              return (
                <div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                    <label htmlFor="admin-user-search" className="sr-only">Search users</label>
                    <input
                      id="admin-user-search"
                      type="search"
                      placeholder="Search by name or email"
                      value={adminUserSearch}
                      onChange={e => setAdminUserSearch(e.target.value)}
                      style={{ flex: 1, minWidth: 200 }}
                    />
                    <label htmlFor="admin-user-role" className="sr-only">Filter by account type</label>
                    <select id="admin-user-role" value={adminUserRole} onChange={e => setAdminUserRole(e.target.value)}>
                      <option value="">All users</option>
                      <option value="pro">Pros</option>
                      <option value="customer">Customers</option>
                      <option value="admin">Admins</option>
                    </select>
                  </div>
                  {shown.length === 0 ? (
                    <div style={{ color: "#64748b", padding: 12 }}>{adminUsers.length === 0 ? "No users yet." : "No users match."}</div>
                  ) : (
                    <div style={{ display: "grid", gap: 6 }}>
                      {shown.map(u => {
                        const pro = u.contractor_id ? contractors.find(c => c.id === u.contractor_id) : null;
                        return (
                          <div key={u.id} style={{ padding: "10px 12px", background: "#f8fafc", borderRadius: 8, fontSize: "0.9375rem" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                              <div style={{ fontWeight: 600, minWidth: 0 }}>
                                {u.name || u.email}
                                {u.contractor_id
                                  ? <span className="badge" style={{ marginLeft: 6 }}>Pro</span>
                                  : <span className="badge" style={{ marginLeft: 6 }}>Customer</span>}
                                {pro?.deactivated_at
                                  ? <span className="badge unavail" style={{ marginLeft: 4 }}>Deactivated</span>
                                  : pro?.verified && <span className="badge avail" style={{ marginLeft: 4 }}>Verified</span>}
                                {u.is_admin && <span className="badge" style={{ marginLeft: 4 }}>🛡 Admin</span>}
                                {!u.confirmed && <span className="badge unavail" style={{ marginLeft: 4 }}>Email not confirmed</span>}
                              </div>
                              <div style={{ color: "#64748b", fontSize: "0.875rem" }}>Joined {new Date(u.created_at).toLocaleDateString()}</div>
                            </div>
                            <div style={{ color: "#475569", fontSize: "0.875rem", marginTop: 2, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              <span>
                              {u.name && <>{u.email} · </>}
                              {u.jobs_posted} job{u.jobs_posted === 1 ? "" : "s"} posted
                              {" · "}last sign-in {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleDateString() : "never"}
                              </span>
                              {!u.is_admin && (
                                <button className="btn btn-outline btn-sm" onClick={() => openAdminChat(u.id)}>Message</button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            }}
            </AdminSection>

            <AdminSection
              id="jobs"
              title="All Jobs"
              summary={`${jobs.filter(j => !j.deleted_at).length} live · ${jobs.filter(j => j.deleted_at).length} removed`}
              counts={{ active: jobs.filter(isActiveJob).length, inactive: jobs.filter(j => !isActiveJob(j)).length }}
              hint="Active = open or in progress. Inactive = completed or removed."
            >
            {filter => {
              const shownJobs = byStatus(jobs, filter, isActiveJob);
              return shownJobs.length === 0 ? (
              <div style={{ color: "#64748b", padding: 12 }}>{jobs.length === 0 ? "No jobs yet." : "None here."}</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {shownJobs.map(j => (
                  <div key={j.id} className="card" style={{ padding: 12, fontSize: "0.9375rem", opacity: j.deleted_at ? 0.7 : 1, borderColor: j.deleted_at ? "#fecaca" : undefined }}>
                    <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
                      <div style={{ fontWeight: 600 }}>
                        {j.title}
                        <span className="badge" style={{ marginLeft: 6 }}>{j.trade}</span>
                        {j.deleted_at
                          ? <span className="badge unavail" style={{ marginLeft: 4 }}>Removed</span>
                          : j.status === "completed"
                            ? <span className="badge avail" style={{ marginLeft: 4 }}>Completed</span>
                            : j.accepted_by
                              ? <span className="badge avail" style={{ marginLeft: 4 }}>Accepted</span>
                              : <span className="badge" style={{ marginLeft: 4 }}>Open</span>}
                      </div>
                      <div style={{ color: "#64748b", fontSize: "0.875rem" }}>{new Date(j.created_at).toLocaleString()}</div>
                    </div>
                    <div style={{ color: "#475569", marginBottom: 6 }}>
                      {j.location}
                      {j.budget != null && ` · $${Number(j.budget).toLocaleString()}`}
                    </div>
                    {(j.homeowner_name || j.homeowner_email) && (
                      <div style={{ color: "#475569", marginBottom: 6, fontSize: "0.875rem" }}>
                        Posted by <strong style={{ color: "#0f172a" }}>{j.homeowner_name || j.homeowner_email}</strong>
                        {j.homeowner_email && j.homeowner_name && ` · ${j.homeowner_email}`}
                        {j.homeowner_phone && ` · ${j.homeowner_phone}`}
                      </div>
                    )}
                    {j.accepted_by && (() => {
                      const acc = contractors.find(c => c.user_id === j.accepted_by);
                      return acc ? (
                        <div style={{ color: "#475569", marginBottom: 6, fontSize: "0.875rem" }}>
                          Accepted by <strong style={{ color: "#0f172a" }}>{acc.name}</strong>
                        </div>
                      ) : null;
                    })()}
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                      {!j.deleted_at && !j.accepted_by && (
                        <button className="btn btn-outline btn-sm" onClick={() => openJobEdit(j)}>Edit job</button>
                      )}
                      {j.posted_by && !adminList.some(a => a.user_id === j.posted_by) && (
                        <button className="btn btn-outline btn-sm" onClick={() => openAdminChat(j.posted_by, `About your job "${j.title}" (${j.trade}): `)}>Message poster</button>
                      )}
                      {j.deleted_at ? (
                        <button className="btn btn-gold btn-sm" onClick={() => adminRestoreJob(j)}>Restore</button>
                      ) : (
                        <button className="btn btn-outline btn-sm" onClick={() => adminRemoveJob(j)} style={{ borderColor: "#f87171", color: "#b91c1c" }}>Remove from board</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            );
            }}
            </AdminSection>

            <AdminSection
              id="tickets"
              title="Support Tickets"
              summary={`${supportTickets.filter(t => t.status === "open").length} open · ${supportTickets.length} total`}
              counts={{ active: supportTickets.filter(t => t.status === "open").length, inactive: supportTickets.filter(t => t.status !== "open").length }}
              hint="Active = open. Inactive = closed."
              defaultOpen
            >
            {filter => {
              const shownTickets = byStatus(supportTickets, filter, t => t.status === "open");
              return shownTickets.length === 0 ? (
              <div style={{ color: "#64748b", padding: 12 }}>{supportTickets.length === 0 ? "No tickets yet." : "None here."}</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {shownTickets.map(t => (
                  <details key={t.id} className="card" style={{ padding: 0 }}>
                    <summary style={{ padding: 12, cursor: "pointer", listStyle: "none", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {t.subject}
                          {t.status === "open" ? <span className="badge" style={{ marginLeft: 8, background: "#ffedd5", color: "#9a3412" }}>OPEN</span> : <span className="badge avail" style={{ marginLeft: 8 }}>closed</span>}
                        </div>
                        <div style={{ fontSize: "0.875rem", color: "#475569" }}>{t.email} · {new Date(t.created_at).toLocaleString()}</div>
                      </div>
                      <span style={{ fontSize: "0.875rem", color: "#64748b" }}>▾</span>
                    </summary>
                    <div style={{ padding: "0 14px 14px" }}>
                      <div style={{ background: "#f8fafc", borderRadius: 8, padding: 12, fontSize: "0.9375rem", whiteSpace: "pre-wrap", marginBottom: 10, color: "#0f172a" }}>
                        {t.body}
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <a href={`mailto:${t.email}?subject=Re: ${encodeURIComponent(t.subject)}`} className="btn btn-gold btn-sm" style={{ textDecoration: "none" }}>Reply by email</a>
                        {t.status === "open" ? (
                          <button className="btn btn-outline btn-sm" onClick={() => adminUpdateTicket(t, { status: "closed", resolved_at: new Date().toISOString(), resolved_by: user.id })}>Mark closed</button>
                        ) : (
                          <button className="btn btn-outline btn-sm" onClick={() => adminUpdateTicket(t, { status: "open", resolved_at: null, resolved_by: null })}>Reopen</button>
                        )}
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            );
            }}
            </AdminSection>

            <AdminSection id="releases" title="Job Releases" summary={`${jobReleases.length} total`}>
            {() => jobReleases.length === 0 ? (
              <div style={{ color: "#64748b", padding: 12 }}>No releases yet.</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {jobReleases.map(r => {
                  const contractor = contractors.find(c => c.id === r.contractor_row_id);
                  const job = jobs.find(j => j.id === r.job_id);
                  return (
                    <div key={r.id} className="card" style={{ padding: 14, fontSize: "0.9375rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                        <div style={{ fontWeight: 600 }}>
                          {contractor?.name || "Contractor"} <span style={{ color: "#475569", fontWeight: 400 }}>released</span>
                        </div>
                        <div style={{ color: "#64748b", fontSize: "0.875rem" }}>{new Date(r.created_at).toLocaleString()}</div>
                      </div>
                      <div style={{ background: "#f8fafc", borderRadius: 8, padding: 10, marginBottom: 8, fontSize: "0.875rem", lineHeight: 1.6 }}>
                        <div style={{ color: "#475569", fontWeight: 700, letterSpacing: 1, fontSize: "0.8125rem", marginBottom: 4 }}>JOB</div>
                        <div style={{ color: "#0f172a", fontWeight: 600 }}>{job?.title || "(job removed)"}</div>
                        {job && <div style={{ color: "#475569" }}>{job.trade} · {job.location}{job.budget != null ? ` · $${Number(job.budget).toLocaleString()}` : ""}</div>}
                        {job && (job.homeowner_name || job.homeowner_email) && (
                          <div style={{ color: "#475569", marginTop: 4 }}>
                            Posted by: <strong style={{ color: "#0f172a" }}>{job.homeowner_name || job.homeowner_email}</strong>
                            {job.homeowner_email && job.homeowner_name && <> · {job.homeowner_email}</>}
                            {job.homeowner_phone && <> · {job.homeowner_phone}</>}
                          </div>
                        )}
                      </div>
                      <div style={{ color: "#dc2626", marginBottom: r.notes ? 6 : 0 }}><strong>Reason:</strong> {r.reason}</div>
                      {r.notes && <div style={{ color: "#475569" }}>Notes: {r.notes}</div>}
                    </div>
                  );
                })}
              </div>
            )}
            </AdminSection>

            <AdminSection
              id="services"
              title="Services & Categories"
              summary={`${catalog.list.filter(s => s.is_active).length} active · ${catalog.list.filter(s => !s.is_active).length} inactive`}
              counts={{ active: catalog.list.filter(s => s.is_active).length, inactive: catalog.list.filter(s => !s.is_active).length }}
              hint="Inactive services are hidden from new profiles and jobs."
            >
            {filter => (
            <AdminServices
              statusFilter={filter}
              catalog={catalog}
              rules={catalogRaw.rules}
              contractors={contractors}
              jobs={jobs}
              adminList={adminList}
              user={user}
              notify={notify}
              reload={loadCatalog}
            />
            )}
            </AdminSection>

            <AdminSection id="team" title="Admin Team" summary={`${adminList.length} admin${adminList.length === 1 ? "" : "s"}${adminInvites.length ? ` · ${adminInvites.length} invited` : ""}`}>
            {() => (<>
            <form onSubmit={adminInvite} className="card" style={{ padding: 14, marginBottom: 14, display: "flex", gap: 10, flexWrap: "wrap" }}>
              <input
                type="email"
                required
                placeholder="Invite someone by email"
                value={adminInviteInput}
                onChange={e => setAdminInviteInput(e.target.value)}
                style={{ flex: 1, minWidth: 220 }}
              />
              <button type="submit" className="btn btn-gold" disabled={adminBusy}>Send Invite</button>
            </form>
            <div style={{ display: "grid", gap: 6, marginBottom: 8 }}>
              {adminList.map(a => (
                <div key={a.user_id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", background: "#f8fafc", borderRadius: 8, fontSize: "0.9375rem" }}>
                  <span>🛡 {a.email}</span>
                  {a.user_id !== user.id && (
                    <button className="btn btn-outline btn-sm" onClick={() => adminRemoveAdmin(a)}>Remove</button>
                  )}
                </div>
              ))}
              {adminInvites.map(i => (
                <div key={i.email} style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", background: "#f8fafc", borderRadius: 8, fontSize: "0.9375rem", color: "#475569" }}>
                  <span>⏳ {i.email} (pending — becomes admin on next sign-in)</span>
                  <button className="btn btn-outline btn-sm" onClick={() => adminRevokeInvite(i.email)}>Revoke</button>
                </div>
              ))}
            </div>
            </>)}
            </AdminSection>
          </section>
        )}

        {/* REVIEWS TAB */}
        {tab === "reviews" && (
          <section aria-labelledby="reviews-heading">
            <h1 id="reviews-heading" style={{ fontSize: "1.875rem", fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#fbbf24", textShadow: TITLE_OUTLINE, marginBottom: 16 }}>REVIEWS</h1>
            <div style={{ display: "grid", gap: 20 }}>
              {contractors.map(c => (
                <div key={c.id} className="card" style={{ padding: 20 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
                    <Avatar initials={c.avatar} size={44} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700 }}>{c.name}</div>
                      <div style={{ fontSize: "0.9375rem", color: "#64748b" }}>{contractorTrades(c).join(" · ")}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <Stars rating={c.rating} />
                      <span style={{ color: "#b45309", fontWeight: 700 }}>{c.rating}</span>
                    </div>
                    {(() => {
                      const job = reviewableJobFor(c.id);
                      const open = reviewTarget?.contractorId === c.id;
                      if (!job && !open) return null;
                      return (
                        <button
                          className="btn btn-outline btn-sm"
                          onClick={() => {
                            if (open) { setReviewTarget(null); return; }
                            setReviewTarget({ contractorId: c.id, jobId: job.id });
                            setReviewInput({ stars: 5, text: "" });
                          }}
                          aria-expanded={open}
                          aria-controls={`review-form-${c.id}`}
                        >
                          {open ? "Cancel" : "+ Review"}
                        </button>
                      );
                    })()}
                  </div>

                  {reviewTarget?.contractorId === c.id && (
                    <form
                      id={`review-form-${c.id}`}
                      style={{ background: "#f8fafc", borderRadius: 12, padding: 16, marginBottom: 14 }}
                      onSubmit={e => { e.preventDefault(); submitReview(); }}
                    >
                      <fieldset style={{ border: "none", padding: 0, margin: "0 0 10px 0" }}>
                        <legend style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Your Rating</legend>
                        <div style={{ display: "flex", gap: 4 }}>
                          {[1, 2, 3, 4, 5].map(s => (
                            <button
                              key={s}
                              type="button"
                              className="star-btn"
                              onClick={() => setReviewInput(r => ({ ...r, stars: s }))}
                              aria-label={`${s} star${s !== 1 ? "s" : ""}`}
                              aria-pressed={s <= reviewInput.stars}
                              style={{ color: s <= reviewInput.stars ? "#b45309" : "#334155" }}
                            >
                              ★
                            </button>
                          ))}
                        </div>
                      </fieldset>
                      <label htmlFor={`review-text-${c.id}`} className="sr-only">Write your review</label>
                      <textarea
                        id={`review-text-${c.id}`}
                        rows={3}
                        placeholder="Share your experience..."
                        value={reviewInput.text}
                        onChange={e => setReviewInput(r => ({ ...r, text: e.target.value }))}
                        style={{ marginBottom: 10 }}
                      />
                      <button type="submit" className="btn btn-gold btn-sm">Submit Review</button>
                    </form>
                  )}

                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }} role="list" aria-label={`Reviews for ${c.name}`}>
                    {(reviews[c.id] || []).map((r, i) => (
                      <div key={i} style={{ background: "#f8fafc", borderRadius: 10, padding: 14 }} role="listitem">
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, flexWrap: "wrap", gap: 4 }}>
                          <span style={{ fontWeight: 600, fontSize: "0.9375rem" }}>{r.author}</span>
                          <span aria-label={`${r.stars} stars`}>
                            {[...Array(r.stars)].map((_, j) => (
                              <span key={j} style={{ color: "#b45309" }} aria-hidden="true">★</span>
                            ))}
                          </span>
                        </div>
                        <p style={{ color: "#475569", fontSize: "0.9375rem" }}>{r.text}</p>
                      </div>
                    ))}
                    {!(reviews[c.id] || []).length && (
                      <div style={{ color: "#64748b", fontSize: "0.9375rem" }}>No reviews yet. Be the first!</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      {/* CONTRACTOR DETAIL MODAL */}
      {modal && (
        <div className="modal-bg" onClick={() => setModal(null)} role="presentation">
          <div
            className="modal"
            ref={modalRef}
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-contractor-name"
            tabIndex={-1}
          >
            <div style={{ display: "flex", gap: 16, alignItems: "flex-start", marginBottom: 20 }}>
              <Avatar initials={modal.avatar} size={60} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div id="modal-contractor-name" style={{ fontWeight: 700, fontSize: "1.375rem" }}>{modal.name}</div>
                <div style={{ color: "#64748b", fontSize: "1rem" }}>{contractorTrades(modal).join(" · ")} · {modal.location}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                  <Stars rating={modal.rating} />
                  <span style={{ color: "#475569", fontSize: "0.9375rem" }}>{modal.rating} ({modal.reviews_count} reviews)</span>
                </div>
              </div>
              <button
                className="btn btn-outline btn-sm"
                onClick={() => setModal(null)}
                aria-label="Close profile"
                style={{ flexShrink: 0 }}
              >
                ✕
              </button>
            </div>
            <p style={{ color: "#475569", marginBottom: 16, lineHeight: 1.6 }}>{modal.bio}</p>
            {modal.website && (
              <div style={{ marginBottom: 16 }}>
                <a
                  href={/^https?:\/\//i.test(modal.website) ? modal.website : `https://${modal.website}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "#b45309", textDecoration: "underline", fontSize: "1rem", fontWeight: 600 }}
                >
                  {modal.website.replace(/^https?:\/\//i, "")}
                </a>
              </div>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
              {modal.tags.map(t => <span key={t} className="badge">{t}</span>)}
            </div>
            <div style={{ background: "#f8fafc", borderRadius: 12, padding: 16, marginBottom: 20, display: "flex", justifyContent: "space-around" }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ color: "#b45309", fontWeight: 700, fontSize: "1.5rem" }}>${modal.hourly}</div>
                <div style={{ color: "#64748b", fontSize: "0.875rem" }}>Per Hour</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ color: "#047857", fontWeight: 700, fontSize: "1.5rem" }}>{modal.reviews_count}</div>
                <div style={{ color: "#64748b", fontSize: "0.875rem" }}>Reviews</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <span className={`badge ${modal.available ? "avail" : "unavail"}`} style={{ fontSize: "1rem", padding: "6px 14px" }}>
                  {modal.available ? "Open" : "Busy"}
                </span>
                <div style={{ color: "#64748b", fontSize: "0.875rem", marginTop: 4 }}>Status</div>
              </div>
            </div>

            {isContractorVerified(modal) ? (
              <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 12, padding: 14, marginBottom: 12 }}>
                <div style={{ fontSize: "0.875rem", fontWeight: 700, letterSpacing: 1, color: "#047857", marginBottom: 6 }}>
                  ✓ VERIFIED PRO
                </div>
                <div style={{ fontSize: "0.9375rem", color: "#065f46", lineHeight: 1.5 }}>{VERIFIED_PRO_MEANING}</div>
              </div>
            ) : (
              <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 12, padding: 14, marginBottom: 12, fontSize: "0.9375rem", color: "#b91c1c" }}>
                This profile has not been approved yet.
              </div>
            )}
            <div style={{ background: "#f8fafc", borderRadius: 12, padding: 14, marginBottom: 20 }}>
              <div style={{ fontSize: "0.875rem", fontWeight: 700, letterSpacing: 1, color: "#b45309", marginBottom: 10 }}>VERIFIED BY SUBCONTRACTOR PROS</div>
              <VerifiedCredentialsSummary contractor={modal} />
            </div>

            {(reviews[modal.id] || []).length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: "0.875rem", fontWeight: 700, letterSpacing: 1, color: "#b45309", marginBottom: 10 }}>
                  REVIEWS ({(reviews[modal.id] || []).length})
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10, maxHeight: 260, overflowY: "auto" }}>
                  {(reviews[modal.id] || []).slice().reverse().map((r, i) => (
                    <div key={i} style={{ background: "#f8fafc", borderRadius: 10, padding: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, flexWrap: "wrap", gap: 4 }}>
                        <span style={{ fontWeight: 600, fontSize: "0.9375rem" }}>{r.author}</span>
                        <span aria-label={`${r.stars} stars`}>
                          {[...Array(r.stars)].map((_, j) => (
                            <span key={j} style={{ color: "#b45309" }} aria-hidden="true">★</span>
                          ))}
                        </span>
                      </div>
                      <p style={{ color: "#475569", fontSize: "0.9375rem", lineHeight: 1.5 }}>{r.text}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              <button
                className="btn btn-gold"
                style={{ flex: 1 }}
                onClick={() => { openChatWithContractor(modal); setModal(null); }}
              >
                Send Message
              </button>
              {(() => {
                const job = reviewableJobFor(modal.id);
                if (!job) return null;
                return (
                  <button
                    className="btn btn-outline"
                    style={{ flex: 1 }}
                    onClick={() => {
                      setReviewTarget({ contractorId: modal.id, jobId: job.id });
                      setReviewInput({ stars: 5, text: "" });
                      setTab("reviews");
                      setModal(null);
                    }}
                  >
                    Leave Review
                  </button>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* PROFILE MODAL */}
      {profileModal && (
        <div className="modal-bg" onClick={() => setProfileModal(false)} role="presentation">
          <div
            className="modal"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-modal-title"
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h2 id="profile-modal-title" style={{ fontSize: "1.5rem", fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#fbbf24", textShadow: TITLE_OUTLINE }}>
                {myContractor ? "EDIT PROFILE" : "CREATE YOUR PROFILE"}
              </h2>
              <button className="btn btn-outline btn-sm" onClick={() => setProfileModal(false)} aria-label="Close">✕</button>
            </div>
            <form onSubmit={saveProfile} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label htmlFor="pf-name" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Business / Your Name *</label>
                <input
                  id="pf-name"
                  required
                  placeholder="e.g. Iron Ridge Builders"
                  value={profileForm.name}
                  onChange={e => setProfileForm(f => ({ ...f, name: e.target.value }))}
                />
              </div>
              <ServicePicker
                catalog={catalog}
                idPrefix="pf-svc"
                withPrimary
                value={profileForm.trades}
                onChange={trades => setProfileForm(f => ({ ...f, trades }))}
                label={<>Services * <span style={{ color: "#64748b" }}>(your first pick is your primary service)</span></>}
              />
              <div>
                <label htmlFor="pf-hourly" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Hourly Rate ($)</label>
                <input
                  id="pf-hourly"
                  type="number"
                  min="0"
                  placeholder="e.g. 80"
                  value={profileForm.hourly}
                  onChange={e => setProfileForm(f => ({ ...f, hourly: e.target.value }))}
                />
              </div>
              <div>
                <label htmlFor="pf-location" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Location *</label>
                <CityStateInput
                  id="pf-location"
                  required
                  value={profileForm.location}
                  onChange={v => setProfileForm(f => ({ ...f, location: v }))}
                />
              </div>
              <div>
                <label htmlFor="pf-tags" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Specialties (comma-separated)</label>
                <input
                  id="pf-tags"
                  placeholder="e.g. Move-out cleans, Commercial kitchens, New builds"
                  value={profileForm.tags}
                  onChange={e => setProfileForm(f => ({ ...f, tags: e.target.value }))}
                />
              </div>
              <div>
                <label htmlFor="pf-bio" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Bio</label>
                <textarea
                  id="pf-bio"
                  rows={3}
                  placeholder="Brief intro homeowners will see"
                  value={profileForm.bio}
                  onChange={e => setProfileForm(f => ({ ...f, bio: e.target.value }))}
                />
              </div>
              <div>
                <label htmlFor="pf-website" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Business Website (optional)</label>
                <input
                  id="pf-website"
                  type="text"
                  inputMode="url"
                  placeholder="your-business.com"
                  value={profileForm.website}
                  onChange={e => setProfileForm(f => ({ ...f, website: e.target.value }))}
                />
              </div>

              {(() => {
                const req = requirementsFor(profileForm.trades);
                return (
                  <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: 16, marginTop: 4 }}>
                    <div style={{ fontSize: "0.875rem", color: "#b45309", fontWeight: 700, letterSpacing: 1, marginBottom: 6 }}>
                      REQUIRED DOCUMENTS <span style={{ color: "#dc2626" }}>*</span>
                    </div>
                    <div style={{ fontSize: "0.875rem", color: "#64748b", marginBottom: 14 }}>
                      What SubcontractorPros asks for, based on the services you picked. Files are only shared with a customer once you accept their job.
                    </div>
                    {myContractor && (
                      <div style={{ background: "#f8fafc", borderRadius: 10, padding: 12, marginBottom: 14 }}>
                        <div style={{ fontSize: "0.875rem", fontWeight: 700, color: "#334155", marginBottom: 8 }}>Review status of your documents</div>
                        <CredentialList contractor={myContractor} reqMap={tradeReqMap} showNotes />
                      </div>
                    )}
                    {(() => {
                      const noUpload = profileForm.trades.filter(t => !tradeReqMap[t]?.tradeLicense);
                      return noUpload.length > 0 ? (
                        <div style={{ fontSize: "0.875rem", color: "#475569", background: "#f8fafc", borderRadius: 10, padding: 12, marginBottom: 14, lineHeight: 1.5 }}>
                          We don't ask for a trade license upload for {noUpload.join(", ")}. {REQUIREMENTS_FALLBACK} You're responsible for holding any license your work requires.
                        </div>
                      ) : null;
                    })()}

                    {/* Business License — always required */}
                    <div style={{ background: "#f8fafc", borderRadius: 10, padding: 12, marginBottom: 14 }}>
                      <div style={{ fontSize: "0.9375rem", fontWeight: 700, color: "#0f172a", marginBottom: 8 }}>1. Business License</div>
                      <div>
                        <label htmlFor="pf-bl-num" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Business License Number *</label>
                        <input
                          id="pf-bl-num"
                          required
                          placeholder="e.g. BL-123456"
                          value={profileForm.business_license_number}
                          onChange={e => setProfileForm(f => ({ ...f, business_license_number: e.target.value }))}
                        />
                      </div>
                      <div style={{ marginTop: 10 }}>
                        <label htmlFor="pf-bl-file" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>
                          Business License Document {profileForm.business_license_path ? "" : "*"}
                        </label>
                        <input
                          id="pf-bl-file"
                          type="file"
                          accept="application/pdf,image/*"
                          onChange={e => setProfileForm(f => ({ ...f, business_license_file: e.target.files?.[0] || null }))}
                        />
                        {profileForm.business_license_path && !profileForm.business_license_file && (
                          <div style={{ fontSize: "0.875rem", color: "#047857", marginTop: 6 }}>
                            ✓ On file — <DocLink path={profileForm.business_license_path}>view current</DocLink>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* General Liability Insurance — always required */}
                    <div style={{ background: "#f8fafc", borderRadius: 10, padding: 12, marginBottom: 14 }}>
                      <div style={{ fontSize: "0.9375rem", fontWeight: 700, color: "#0f172a", marginBottom: 8 }}>2. General Liability Insurance</div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }} className="job-grid">
                        <div>
                          <label htmlFor="pf-ins-carrier" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Carrier *</label>
                          <input id="pf-ins-carrier" required placeholder="e.g. State Farm" value={profileForm.insurance_carrier} onChange={e => setProfileForm(f => ({ ...f, insurance_carrier: e.target.value }))} />
                        </div>
                        <div>
                          <label htmlFor="pf-ins-exp" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Expires *</label>
                          <input id="pf-ins-exp" type="date" required value={profileForm.insurance_expires_at} onChange={e => setProfileForm(f => ({ ...f, insurance_expires_at: e.target.value }))} />
                        </div>
                      </div>
                      <div style={{ marginTop: 10 }}>
                        <label htmlFor="pf-ins-file" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>
                          Certificate of Insurance {profileForm.insurance_path ? "" : "*"}
                        </label>
                        <input id="pf-ins-file" type="file" accept="application/pdf,image/*" onChange={e => setProfileForm(f => ({ ...f, insurance_file: e.target.files?.[0] || null }))} />
                        {profileForm.insurance_path && !profileForm.insurance_file && (
                          <div style={{ fontSize: "0.875rem", color: "#047857", marginTop: 6 }}>
                            ✓ On file — <DocLink path={profileForm.insurance_path}>view current</DocLink>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Trade Licenses — one card per licensed trade the contractor selected */}
                    {profileForm.trades.filter(t => tradeReqMap[t]?.tradeLicense).map((t, i) => {
                      const licType = tradeReqMap[t].tradeLicense;
                      const entry = profileForm.trade_licenses[t] || { number: "", path: "", type: licType, file: null };
                      const updateEntry = (patch) => setProfileForm(f => ({
                        ...f,
                        trade_licenses: { ...f.trade_licenses, [t]: { ...entry, type: licType, ...patch } },
                      }));
                      return (
                        <div key={t} style={{ background: "#f8fafc", borderRadius: 10, padding: 12, marginBottom: 14, border: "1px solid #f59e0b" }}>
                          <div style={{ fontSize: "0.9375rem", fontWeight: 700, color: "#0f172a", marginBottom: 4 }}>
                            {i + 3}. {licType} <span style={{ color: "#475569", fontWeight: 400, fontSize: "0.875rem" }}>(for {t})</span>
                          </div>
                          <div style={{ fontSize: "0.875rem", color: "#b45309", marginBottom: 10 }}>
                            SubcontractorPros asks {t} providers for this document.
                          </div>
                          <div>
                            <label htmlFor={`pf-tl-num-${t}`} style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>License Number *</label>
                            <input
                              id={`pf-tl-num-${t}`}
                              required
                              placeholder="e.g. TX-123456"
                              value={entry.number}
                              onChange={e => updateEntry({ number: e.target.value })}
                            />
                          </div>
                          <div style={{ marginTop: 10 }}>
                            <label htmlFor={`pf-tl-file-${t}`} style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>
                              License Document {entry.path ? "" : "*"}
                            </label>
                            <input
                              id={`pf-tl-file-${t}`}
                              type="file"
                              accept="application/pdf,image/*"
                              onChange={e => updateEntry({ file: e.target.files?.[0] || null })}
                            />
                            {entry.path && !entry.file && (
                              <div style={{ fontSize: "0.875rem", color: "#047857", marginTop: 6 }}>
                                ✓ On file — <DocLink path={entry.path}>view current</DocLink>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}

                    {/* Surety Bond — required only for trades that need bonding */}
                    {req.needsBond && (() => {
                      const licenseCount = profileForm.trades.filter(t => tradeReqMap[t]?.tradeLicense).length;
                      const bondNumber = 3 + licenseCount;
                      return (
                      <div style={{ background: "#f8fafc", borderRadius: 10, padding: 12, marginBottom: 4, border: "1px solid #f59e0b" }}>
                        <div style={{ fontSize: "0.9375rem", fontWeight: 700, color: "#0f172a", marginBottom: 4 }}>{bondNumber}. Surety Bond</div>
                        <div style={{ fontSize: "0.875rem", color: "#b45309", marginBottom: 10 }}>
                          SubcontractorPros asks for a bond for: {profileForm.trades.filter(t => tradeReqMap[t]?.bonded).join(", ")}.
                        </div>
                        <div>
                          <label htmlFor="pf-bond-amt" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Bond Amount ($)</label>
                          <input id="pf-bond-amt" type="number" min="0" placeholder="e.g. 10000" value={profileForm.bond_amount} onChange={e => setProfileForm(f => ({ ...f, bond_amount: e.target.value }))} />
                        </div>
                        <div style={{ marginTop: 10 }}>
                          <label htmlFor="pf-bond-file" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>
                            Bond Certificate {profileForm.bond_path ? "" : "*"}
                          </label>
                          <input id="pf-bond-file" type="file" accept="application/pdf,image/*" onChange={e => setProfileForm(f => ({ ...f, bond_file: e.target.files?.[0] || null }))} />
                          {profileForm.bond_path && !profileForm.bond_file && (
                            <div style={{ fontSize: "0.875rem", color: "#047857", marginTop: 6 }}>
                              ✓ On file — <DocLink path={profileForm.bond_path}>view current</DocLink>
                            </div>
                          )}
                        </div>
                      </div>
                      );
                    })()}
                  </div>
                );
              })()}

              {profileError && (
                <div style={{ color: "#dc2626", fontSize: "0.9375rem", background: "#fef2f2", padding: "8px 12px", borderRadius: 8 }} role="alert">
                  {profileError}
                </div>
              )}
              <button type="submit" className="btn btn-gold" disabled={profileBusy} style={{ opacity: profileBusy ? 0.6 : 1 }}>
                {profileBusy ? "Saving..." : myContractor ? "Save Changes" : "Create Profile"}
              </button>
            </form>
            {myContractor && (() => {
              const isDeactivated = !!myContractor.deactivated_at;
              const selfDeactivated = isDeactivated && myContractor.deactivated_by === myContractor.user_id;
              return (
                <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #e2e8f0" }}>
                  {isDeactivated && !selfDeactivated ? (
                    <>
                      <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: 12, fontSize: "0.9375rem", color: "#b91c1c", textAlign: "center", marginBottom: 10 }}>
                        Your profile was taken off the board by an admin. Only an admin can put it back on.
                      </div>
                      <button
                        type="button"
                        className="btn btn-outline btn-sm"
                        onClick={() => { setProfileModal(false); setSupportModal(true); }}
                        style={{ width: "100%" }}
                      >
                        Contact Support
                      </button>
                    </>
                  ) : isDeactivated ? (
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => { setContractorDeactivated(myContractor, false); setProfileModal(false); }}
                      style={{ width: "100%" }}
                    >
                      Put my profile back on the board
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-outline btn-sm"
                      onClick={() => {
                        if (confirm("Take yourself off the board? Your profile will be hidden from search. You keep your account and history and can turn it back on anytime.")) {
                          setContractorDeactivated(myContractor, true);
                          setProfileModal(false);
                        }
                      }}
                      style={{ width: "100%", borderColor: "#f87171", color: "#b91c1c" }}
                    >
                      Take my profile off the board
                    </button>
                  )}
                  <div style={{ fontSize: "0.8125rem", color: "#64748b", marginTop: 8, textAlign: "center" }}>
                    Accounts can't be deleted so nothing is ever lost. This just hides you from search.
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* AUTH MODAL */}
      {authModal && (
        <div className="modal-bg" onClick={() => setAuthModal(false)} role="presentation">
          <div
            className="modal"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="auth-modal-title"
            style={{ maxWidth: 400 }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h2 id="auth-modal-title" style={{ fontSize: "1.5rem", fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#fbbf24", textShadow: TITLE_OUTLINE }}>
                {authMode === "signin" ? "SIGN IN" : "CREATE ACCOUNT"}
              </h2>
              <button className="btn btn-outline btn-sm" onClick={() => setAuthModal(false)} aria-label="Close">✕</button>
            </div>
            <form onSubmit={submitAuth} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {authMode === "signup" && (
                <div style={{ fontSize: "0.9375rem", color: "#475569", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, padding: "10px 12px", lineHeight: 1.5 }}>
                  {authIntent === "customer"
                    ? "Create your free account to post jobs and hire verified pros. If you're also a pro, you can add a contractor profile anytime from your profile menu."
                    : authIntent === "pro"
                      ? "Create your free account, then set up your contractor profile from your profile menu to start accepting jobs."
                      : "One account, both sides. Post jobs as a customer, and if you're a pro, add a contractor profile to accept work — anytime, from your profile menu."}
                </div>
              )}
              <div>
                <label htmlFor="auth-email" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Email</label>
                <input
                  id="auth-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={authForm.email}
                  onChange={e => setAuthForm(f => ({ ...f, email: e.target.value }))}
                />
              </div>
              <div>
                <label htmlFor="auth-password" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Password</label>
                <div style={{ position: "relative" }}>
                  <input
                    id="auth-password"
                    type={showPassword ? "text" : "password"}
                    required
                    minLength={6}
                    autoComplete={authMode === "signin" ? "current-password" : "new-password"}
                    value={authForm.password}
                    onChange={e => setAuthForm(f => ({ ...f, password: e.target.value }))}
                    style={{ paddingRight: 42 }}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(s => !s)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    style={{
                      position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                      background: "transparent", border: "none", cursor: "pointer",
                      color: "#475569", fontSize: "1.25rem", padding: 6, lineHeight: 1,
                    }}
                  >
                    {showPassword ? "🙈" : "👁"}
                  </button>
                </div>
              </div>
              {authError && (
                <div style={{ color: "#dc2626", fontSize: "0.9375rem", background: "#fef2f2", padding: "8px 12px", borderRadius: 8 }} role="alert">
                  {authError}
                </div>
              )}
              <button type="submit" className="btn btn-gold" disabled={authBusy} style={{ opacity: authBusy ? 0.6 : 1 }}>
                {authBusy ? "Working..." : authMode === "signin" ? "Sign In" : "Create Account"}
              </button>
              <button
                type="button"
                onClick={() => { setAuthMode(authMode === "signin" ? "signup" : "signin"); setAuthError(null); }}
                style={{ background: "none", border: "none", color: "#475569", fontSize: "0.9375rem", cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}
              >
                {authMode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* CUSTOMER PROFILE MODAL */}
      {customerProfileModal && (
        <div className="modal-bg" onClick={() => setCustomerProfileModal(false)} role="presentation">
          <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" style={{ maxWidth: 440 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h2 style={{ fontSize: "1.5rem", fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#fbbf24", textShadow: TITLE_OUTLINE }}>MY PROFILE</h2>
              <button className="btn btn-outline btn-sm" onClick={() => setCustomerProfileModal(false)} aria-label="Close">✕</button>
            </div>
            <form onSubmit={saveCustomerProfile} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label htmlFor="cp-email" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Email</label>
                <input id="cp-email" value={user?.email || ""} disabled style={{ opacity: 0.7 }} />
                <div style={{ fontSize: "0.8125rem", color: "#64748b", marginTop: 4 }}>Email is managed from your account and used on every job you post.</div>
              </div>
              <div>
                <label htmlFor="cp-name" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Your Name</label>
                <input
                  id="cp-name"
                  placeholder="First & last name"
                  value={customerProfile.homeowner_name}
                  onChange={e => setCustomerProfile(p => ({ ...p, homeowner_name: e.target.value }))}
                />
              </div>
              <div>
                <label htmlFor="cp-phone" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Phone</label>
                <input
                  id="cp-phone"
                  type="tel"
                  placeholder="(555) 555-5555"
                  value={customerProfile.homeowner_phone}
                  onChange={e => setCustomerProfile(p => ({ ...p, homeowner_phone: e.target.value }))}
                />
              </div>
              <div style={{ fontSize: "0.875rem", color: "#64748b" }}>
                These prefill on every job you post so you don't have to retype them.
              </div>
              <button type="submit" className="btn btn-gold">Save Profile</button>
            </form>
          </div>
        </div>
      )}

      {/* JOB EDIT MODAL */}
      {jobEditModal && (
        <div className="modal-bg" onClick={() => setJobEditModal(null)} role="presentation">
          <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <h2 style={{ fontSize: "1.5rem", fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#fbbf24", textShadow: TITLE_OUTLINE }}>EDIT JOB</h2>
              <button className="btn btn-outline btn-sm" onClick={() => setJobEditModal(null)} aria-label="Close">✕</button>
            </div>
            <form onSubmit={saveJobEdit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label htmlFor="je-title" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Job Title *</label>
                <input id="je-title" required value={jobEditModal.title} onChange={e => setJobEditModal(j => ({ ...j, title: e.target.value }))} />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }} className="job-grid">
                <div>
                  <label htmlFor="je-trade" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Service</label>
                  <ServiceSelect id="je-trade" catalog={catalog} value={jobEditModal.trade || ""} onChange={v => setJobEditModal(j => ({ ...j, trade: v }))} />
                </div>
                <div>
                  <label htmlFor="je-budget" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Budget ($)</label>
                  <input id="je-budget" type="number" min="0" value={jobEditModal.budget ?? ""} onChange={e => setJobEditModal(j => ({ ...j, budget: e.target.value }))} />
                </div>
              </div>
              <div>
                <label htmlFor="je-location" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Location *</label>
                <CityStateInput id="je-location" required value={jobEditModal.location} onChange={v => setJobEditModal(j => ({ ...j, location: v }))} />
              </div>
              <div>
                <label htmlFor="je-desc" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Description</label>
                <textarea id="je-desc" rows={4} value={jobEditModal.description ?? ""} onChange={e => setJobEditModal(j => ({ ...j, description: e.target.value }))} />
              </div>
              <button type="submit" className="btn btn-gold" disabled={jobEditBusy}>
                {jobEditBusy ? "Saving..." : "Save Changes"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* RELEASE CONTRACTOR MODAL */}
      {releaseModal && (
        <div className="modal-bg" onClick={() => setReleaseModal(null)} role="presentation">
          <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ fontSize: "1.5rem", fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#fbbf24", textShadow: TITLE_OUTLINE }}>RELEASE CONTRACTOR</h2>
              <button className="btn btn-outline btn-sm" onClick={() => setReleaseModal(null)} aria-label="Close">✕</button>
            </div>
            <div style={{ background: "#f8fafc", borderRadius: 10, padding: 12, marginBottom: 16, fontSize: "0.9375rem" }}>
              <div style={{ color: "#475569" }}>Releasing:</div>
              <div style={{ fontWeight: 600 }}>{releaseModal.accepter?.name || "Contractor"}</div>
              <div style={{ color: "#475569" }}>on "{releaseModal.title}"</div>
            </div>
            <p style={{ fontSize: "0.9375rem", color: "#475569", marginBottom: 14 }}>
              The job will go back to Open so other contractors can accept it. The reason you pick is shared with our admin team so we can track contractor behavior.
            </p>
            <form onSubmit={submitRelease} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label htmlFor="rm-reason" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Reason *</label>
                <select
                  id="rm-reason"
                  value={releaseInput.reason}
                  onChange={e => setReleaseInput(r => ({ ...r, reason: e.target.value }))}
                >
                  <option>Contractor never contacted me</option>
                  <option>Contractor was too slow to respond</option>
                  <option>Contractor's rating wasn't what I hoped</option>
                  <option>Contractor cancelled or backed out</option>
                  <option>I changed my mind about the job</option>
                  <option>Other</option>
                </select>
              </div>
              <div>
                <label htmlFor="rm-notes" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Additional details (optional)</label>
                <textarea
                  id="rm-notes"
                  rows={3}
                  placeholder="Anything else our team should know?"
                  value={releaseInput.notes}
                  onChange={e => setReleaseInput(r => ({ ...r, notes: e.target.value }))}
                />
              </div>
              <button type="submit" className="btn btn-gold" disabled={releaseBusy}>
                {releaseBusy ? "Releasing..." : "Release & Relist Job"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* DENY CONTRACTOR MODAL */}
      {denyModal && (
        <div className="modal-bg" onClick={() => setDenyModal(null)} role="presentation">
          <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ fontSize: "1.5rem", fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#fbbf24", textShadow: TITLE_OUTLINE }}>DENY APPLICATION</h2>
              <button className="btn btn-outline btn-sm" onClick={() => setDenyModal(null)} aria-label="Close">✕</button>
            </div>
            <div style={{ background: "#f8fafc", borderRadius: 10, padding: 12, marginBottom: 16, fontSize: "0.9375rem" }}>
              <div style={{ color: "#475569" }}>Denying:</div>
              <div style={{ fontWeight: 600 }}>{denyModal.name}</div>
              <div style={{ color: "#475569" }}>{contractorTrades(denyModal).join(" · ")}</div>
            </div>
            <p style={{ fontSize: "0.9375rem", color: "#475569", marginBottom: 14 }}>
              The contractor will see this reason in a banner on their profile and be able to correct it and reapply. Be specific about what needs to change.
            </p>
            <form onSubmit={submitDeny} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label htmlFor="deny-reason" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Reason for denial *</label>
                <textarea
                  id="deny-reason"
                  rows={5}
                  required
                  placeholder="e.g. Business license is expired — please upload a current one. / Insurance carrier field is blank / License number doesn't match the state records..."
                  value={denyReason}
                  onChange={e => setDenyReason(e.target.value)}
                />
              </div>
              <button type="submit" className="btn btn-gold" disabled={denyBusy}>
                {denyBusy ? "Sending..." : "Deny & Email Contractor"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* iOS INSTALL INSTRUCTIONS */}
      {iosInstallModal && (
        <div className="modal-bg" onClick={() => setIosInstallModal(false)} role="presentation">
          <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ fontSize: "1.5rem", fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#fbbf24", textShadow: TITLE_OUTLINE }}>INSTALL ON IPHONE</h2>
              <button className="btn btn-outline btn-sm" onClick={() => setIosInstallModal(false)} aria-label="Close">✕</button>
            </div>
            <ol style={{ color: "#1e293b", lineHeight: 1.8, fontSize: "1.0625rem", paddingLeft: 20, marginBottom: 16 }}>
              <li>Make sure you're in <strong>Safari</strong> (this doesn't work in Chrome or Firefox on iOS).</li>
              <li>Tap the <strong>Share</strong> icon at the bottom center — a square with an arrow pointing up.</li>
              <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
              <li>Make sure <strong>Open as Web App</strong> is switched on, then tap <strong>Add</strong>.</li>
              <li>Open Subcontractor Pros from the new home screen icon and sign in.</li>
            </ol>
            <div style={{ color: "#475569", fontSize: "0.9375rem", marginBottom: 14, background: "#f8fafc", borderRadius: 8, padding: 12 }}>
              The icon opens Subcontractor Pros full-screen, with no browser bar. Notifications only work in the home screen app, so turn them on from there: My Account → Turn on notifications.
            </div>
            <button type="button" className="btn btn-gold" style={{ width: "100%" }} onClick={() => setIosInstallModal(false)}>
              Got it
            </button>
          </div>
        </div>
      )}

      {/* SHARE CREDENTIALS MODAL */}
      {shareModal && (
        <div className="modal-bg" onClick={() => setShareModal(false)} role="presentation">
          <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ fontSize: "1.5rem", fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#fbbf24", textShadow: TITLE_OUTLINE }}>SHARE LICENSE &amp; INSURANCE</h2>
              <button className="btn btn-outline btn-sm" onClick={() => setShareModal(false)} aria-label="Close">✕</button>
            </div>
            <p style={{ fontSize: "0.9375rem", color: "#475569", marginBottom: 14 }}>
              We'll email your verified license, insurance details, and links to the actual documents to whoever you enter below. Great for prospective clients who ask for proof before hiring.
            </p>
            <form onSubmit={submitShareCredentials} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label htmlFor="sh-email" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Client's Email *</label>
                <input
                  id="sh-email"
                  type="email"
                  required
                  placeholder="client@example.com"
                  value={shareInput.clientEmail}
                  onChange={e => setShareInput(s => ({ ...s, clientEmail: e.target.value }))}
                />
              </div>
              <div>
                <label htmlFor="sh-name" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Client's Name (optional)</label>
                <input
                  id="sh-name"
                  placeholder="e.g. John"
                  value={shareInput.clientName}
                  onChange={e => setShareInput(s => ({ ...s, clientName: e.target.value }))}
                />
              </div>
              <div>
                <label htmlFor="sh-message" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Note (optional)</label>
                <textarea
                  id="sh-message"
                  rows={4}
                  placeholder="Here are my credentials for the kitchen remodel we discussed..."
                  value={shareInput.message}
                  onChange={e => setShareInput(s => ({ ...s, message: e.target.value }))}
                />
              </div>
              <div style={{ fontSize: "0.8125rem", color: "#64748b" }}>
                Replies to this email will come straight to your address ({user?.email}).
              </div>
              <button type="submit" className="btn btn-gold" disabled={shareBusy}>
                {shareBusy ? "Sending..." : "Send Credentials"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* SUPPORT TICKET MODAL */}
      {supportModal && (
        <div className="modal-bg" onClick={() => setSupportModal(false)} role="presentation">
          <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ fontSize: "1.5rem", fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#fbbf24", textShadow: TITLE_OUTLINE }}>CONTACT SUPPORT</h2>
              <button className="btn btn-outline btn-sm" onClick={() => setSupportModal(false)} aria-label="Close">✕</button>
            </div>
            <p style={{ fontSize: "0.9375rem", color: "#475569", marginBottom: 14 }}>
              Send us a note and we'll reply by email — usually within a business day.
            </p>
            <form onSubmit={submitSupport} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {!user && (
                <div>
                  <label htmlFor="sup-email" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Your Email *</label>
                  <input
                    id="sup-email"
                    type="email"
                    required
                    value={supportInput.email || ""}
                    onChange={e => setSupportInput(s => ({ ...s, email: e.target.value }))}
                  />
                </div>
              )}
              {user && (
                <div style={{ fontSize: "0.875rem", color: "#64748b" }}>
                  Replying to <strong style={{ color: "#475569" }}>{user.email}</strong>
                </div>
              )}
              <div>
                <label htmlFor="sup-subject" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Subject *</label>
                <input
                  id="sup-subject"
                  required
                  value={supportInput.subject}
                  onChange={e => setSupportInput(s => ({ ...s, subject: e.target.value }))}
                />
              </div>
              <div>
                <label htmlFor="sup-body" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Message *</label>
                <textarea
                  id="sup-body"
                  rows={5}
                  required
                  placeholder="Tell us what's going on..."
                  value={supportInput.body}
                  onChange={e => setSupportInput(s => ({ ...s, body: e.target.value }))}
                />
              </div>
              <button type="submit" className="btn btn-gold" disabled={supportBusy}>
                {supportBusy ? "Sending..." : "Send"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* MARK COMPLETE MODAL */}
      {completeModal && (
        <div className="modal-bg" onClick={() => setCompleteModal(null)} role="presentation">
          <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" style={{ maxWidth: 520 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ fontSize: "1.5rem", fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#fbbf24", textShadow: TITLE_OUTLINE }}>HOW DID IT GO?</h2>
              <button className="btn btn-outline btn-sm" onClick={() => setCompleteModal(null)} aria-label="Close">✕</button>
            </div>
            <div style={{ background: "#f8fafc", borderRadius: 10, padding: 12, marginBottom: 16, fontSize: "0.9375rem" }}>
              <div style={{ color: "#475569" }}>Reviewing:</div>
              <div style={{ fontWeight: 600 }}>{completeModal.accepter?.name}</div>
              <div style={{ color: "#475569" }}>{completeModal.title}</div>
            </div>
            <form onSubmit={submitComplete} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
                <legend style={{ fontSize: "0.9375rem", color: "#475569", marginBottom: 6 }}>Rate the work</legend>
                <div style={{ display: "flex", gap: 4 }}>
                  {[1, 2, 3, 4, 5].map(s => (
                    <button
                      key={s}
                      type="button"
                      className="star-btn"
                      onClick={() => setCompleteInput(c => ({ ...c, rating: s }))}
                      aria-label={`${s} star${s !== 1 ? "s" : ""}`}
                      aria-pressed={s <= completeInput.rating}
                      style={{ color: s <= completeInput.rating ? "#b45309" : "#334155" }}
                    >
                      ★
                    </button>
                  ))}
                </div>
              </fieldset>
              <div>
                <label htmlFor="cm-review" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Public review *</label>
                <textarea
                  id="cm-review"
                  rows={3}
                  required
                  placeholder="How was working with them? What would other homeowners want to know?"
                  value={completeInput.reviewText}
                  onChange={e => setCompleteInput(c => ({ ...c, reviewText: e.target.value }))}
                />
                <div style={{ fontSize: "0.8125rem", color: "#64748b", marginTop: 4 }}>Shown on the contractor's profile.</div>
              </div>
              <div>
                <label htmlFor="cm-comment" style={{ fontSize: "0.9375rem", color: "#334155", marginBottom: 6, display: "block" }}>Private note to Subcontractor Pros (optional)</label>
                <textarea
                  id="cm-comment"
                  rows={2}
                  placeholder="Anything we should know? Not shown publicly."
                  value={completeInput.comment}
                  onChange={e => setCompleteInput(c => ({ ...c, comment: e.target.value }))}
                />
              </div>
              <button type="submit" className="btn btn-gold" disabled={completeBusy}>
                {completeBusy ? "Submitting..." : "Complete & Post Review"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
