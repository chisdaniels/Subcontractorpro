import { useState, useEffect, useRef } from "react";
import { supabase } from "./lib/supabase";

const TRADES = ["All Trades", "General Contractor", "Plumber", "Electrician", "Roofer", "Carpenter", "Mason"];

const AVATAR_COLORS = { IR: "#b45309", BS: "#0369a1", VP: "#7c3aed", AR: "#b91c1c", CC: "#047857", TK: "#374151" };

const TAB_LABELS = {
  search: "🔍 Find",
  post: "📋 Post Job",
  jobs: "💼 Jobs",
  messages: "💬 Messages",
  reviews: "⭐ Reviews",
};

const TAB_ORDER = ["search", "post", "jobs", "messages", "reviews"];

function Stars({ rating }) {
  return (
    <span aria-label={`${rating} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map(i => (
        <span key={i} aria-hidden="true" style={{ color: i <= Math.round(rating) ? "#f59e0b" : "#d1d5db", fontSize: 14 }}>★</span>
      ))}
    </span>
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

function ChatHeader({ contractors, contractorId }) {
  const c = contractors.find(x => x.id === contractorId);
  if (!c) return null;
  return (
    <>
      <Avatar initials={c.avatar} size={36} />
      <div>
        <div style={{ fontWeight: 600 }}>{c.name}</div>
        <div style={{ fontSize: 12, color: "#64748b" }}>{c.trade}</div>
      </div>
    </>
  );
}

export default function App() {
  const [tab, setTab] = useState("search");
  const [trade, setTrade] = useState("All Trades");
  const [search, setSearch] = useState("");
  const [contractors, setContractors] = useState([]);
  const [messages, setMessages] = useState({});
  const [reviews, setReviews] = useState({});
  const [msgInput, setMsgInput] = useState("");
  const [activeChat, setActiveChat] = useState(null);
  const [reviewInput, setReviewInput] = useState({ stars: 5, text: "" });
  const [reviewTarget, setReviewTarget] = useState(null);
  const [modal, setModal] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [jobForm, setJobForm] = useState({ title: "", trade: "Plumber", location: "", budget: "", desc: "", homeowner_name: "", homeowner_email: "", homeowner_phone: "" });
  const [notification, setNotification] = useState(null);
  const [user, setUser] = useState(null);
  const [authModal, setAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState("signin");
  const [authForm, setAuthForm] = useState({ email: "", password: "", role: "customer" });
  const [authError, setAuthError] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [myContractor, setMyContractor] = useState(null);
  const [profileModal, setProfileModal] = useState(false);
  const [profileForm, setProfileForm] = useState({ name: "", trade: "General Contractor", location: "", hourly: "", bio: "", tags: "" });
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState(null);
  const [myJobs, setMyJobs] = useState([]);

  const role = user?.user_metadata?.role ?? null;
  const isCustomer   = role === "customer";
  const isContractor = role === "contractor";

  const messagesEndRef = useRef(null);
  const modalRef = useRef(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setUser(data.session?.user ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (tab === "messages" && !user) setTab("search");
    if (tab === "jobs" && !isContractor) setTab("search");
    if (tab === "post"  && isContractor) setTab("jobs");
  }, [tab, user, isContractor]);

  useEffect(() => {
    if (!isCustomer) { setMyJobs([]); return; }
    (async () => {
      const { data: rows, error } = await supabase
        .from("jobs")
        .select("*")
        .eq("posted_by", user.id)
        .order("created_at", { ascending: false });
      if (error) { console.error("my jobs load failed:", error); return; }
      const accepterIds = (rows || []).map(j => j.accepted_by).filter(Boolean);
      let accepters = [];
      if (accepterIds.length) {
        const { data } = await supabase.from("contractors").select("*").in("user_id", accepterIds);
        accepters = data || [];
      }
      const enriched = (rows || []).map(j => ({
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
      setMyContractor(data ?? null);
    })();
  }, [user]);

  async function loadJobs() {
    const { data, error } = await supabase.from("jobs").select("*").order("created_at", { ascending: false });
    if (error) console.error("jobs load failed:", error);
    setJobs(data || []);
  }

  useEffect(() => {
    async function load() {
      const [cRes, rRes] = await Promise.all([
        supabase.from("contractors").select("*").order("id"),
        supabase.from("reviews").select("*").order("created_at"),
      ]);
      if (cRes.error) console.error("contractors load failed:", cRes.error);
      if (rRes.error) console.error("reviews load failed:", rRes.error);
      const cs = cRes.data || [];
      setContractors(cs);

      const reviewsByContractor = {};
      for (const r of rRes.data || []) {
        (reviewsByContractor[r.contractor_id] ||= []).push(r);
      }
      setReviews(reviewsByContractor);

      loadJobs();
    }
    load();
  }, []);

  useEffect(() => {
    if (!user) { setMessages({}); return; }
    (async () => {
      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at");
      if (error) { console.error("messages load failed:", error); return; }
      const byContractor = {};
      for (const m of data || []) {
        (byContractor[m.contractor_id] ||= []).push({ from: m.sender, text: m.text });
      }
      setMessages(byContractor);
    })();
  }, [user]);

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

  const filtered = contractors.filter(c => {
    const matchTrade = trade === "All Trades" || c.trade === trade;
    const q = search.toLowerCase();
    const matchSearch = c.name.toLowerCase().includes(q) || c.trade.toLowerCase().includes(q) || c.location.toLowerCase().includes(q);
    return matchTrade && matchSearch;
  });

  function notify(msg) {
    setNotification(msg);
    setTimeout(() => setNotification(null), 3000);
  }

  async function sendMessage() {
    if (!msgInput.trim() || !activeChat || !user) return;
    const text = msgInput;
    setMsgInput("");
    setMessages(prev => ({
      ...prev,
      [activeChat]: [...(prev[activeChat] || []), { from: "me", text }],
    }));
    const { error } = await supabase
      .from("messages")
      .insert({ contractor_id: activeChat, sender: "me", text, user_id: user.id });
    if (error) notify("Failed to send. Try again.");
  }

  async function submitReview() {
    if (!reviewInput.text.trim()) return;
    const payload = {
      contractor_id: reviewTarget,
      author: "Your Business",
      stars: reviewInput.stars,
      text: reviewInput.text,
    };
    setReviews(prev => ({
      ...prev,
      [reviewTarget]: [...(prev[reviewTarget] || []), payload],
    }));
    setReviewInput({ stars: 5, text: "" });
    setReviewTarget(null);
    const { error } = await supabase.from("reviews").insert(payload);
    if (error) {
      notify("Failed to submit review.");
      return;
    }
    const { data: cs } = await supabase.from("contractors").select("*").order("id");
    if (cs) {
      setContractors(cs);
      if (user) {
        const mine = cs.find(c => c.user_id === user.id);
        if (mine) setMyContractor(mine);
      }
    }
    notify("Review submitted!");
  }

  async function postJob() {
    if (!jobForm.title || !jobForm.location || !jobForm.homeowner_name || !jobForm.homeowner_email) return;
    const { error } = await supabase.from("jobs").insert({
      title: jobForm.title,
      trade: jobForm.trade,
      location: jobForm.location,
      budget: jobForm.budget ? Number(jobForm.budget) : null,
      description: jobForm.desc,
      homeowner_name: jobForm.homeowner_name.trim(),
      homeowner_email: jobForm.homeowner_email.trim(),
      homeowner_phone: jobForm.homeowner_phone.trim() || null,
      posted_by: user?.id ?? null,
    });
    if (error) {
      notify("Failed to post job: " + error.message);
      return;
    }
    setJobForm({ title: "", trade: "Plumber", location: "", budget: "", desc: "", homeowner_name: "", homeowner_email: "", homeowner_phone: "" });
    await loadJobs();
    notify("Job posted! Contractors will reach out shortly.");
  }

  async function submitAuth(e) {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    const { email, password } = authForm;
    if (authMode === "signup") {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { role: authForm.role } },
      });
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
    await supabase.auth.signOut();
    notify("Signed out.");
  }

  async function assignRole(chosenRole) {
    const { data, error } = await supabase.auth.updateUser({ data: { role: chosenRole } });
    if (error) { notify("Failed to set role: " + error.message); return; }
    setUser(data.user);
    notify(chosenRole === "customer" ? "Welcome — you can now post jobs." : "Welcome — you can now browse jobs.");
  }

  function avatarInitials(name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  async function saveProfile(e) {
    e.preventDefault();
    if (!user) return;
    setProfileBusy(true);
    setProfileError(null);
    const tagsArr = profileForm.tags.split(",").map(t => t.trim()).filter(Boolean);
    const row = {
      user_id: user.id,
      name: profileForm.name.trim(),
      trade: profileForm.trade,
      location: profileForm.location.trim(),
      hourly: profileForm.hourly ? Number(profileForm.hourly) : null,
      bio: profileForm.bio.trim() || null,
      tags: tagsArr,
      avatar: avatarInitials(profileForm.name),
      available: true,
    };
    const { data, error } = myContractor
      ? await supabase.from("contractors").update(row).eq("id", myContractor.id).select().single()
      : await supabase.from("contractors").insert(row).select().single();
    setProfileBusy(false);
    if (error) {
      setProfileError(error.message);
      return;
    }
    setMyContractor(data);
    setProfileModal(false);
    // refresh contractor list so it shows in Find
    const { data: cs } = await supabase.from("contractors").select("*").order("id");
    setContractors(cs || []);
    notify(myContractor ? "Profile updated!" : "Profile created!");
  }

  function openProfileModal() {
    setProfileForm({
      name: myContractor?.name ?? "",
      trade: myContractor?.trade ?? "General Contractor",
      location: myContractor?.location ?? "",
      hourly: myContractor?.hourly?.toString() ?? "",
      bio: myContractor?.bio ?? "",
      tags: (myContractor?.tags ?? []).join(", "),
    });
    setProfileError(null);
    setProfileModal(true);
  }

  async function acceptJob(jobId) {
    if (!user) return;
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
    await loadJobs();
    notify("Job accepted!");
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

  const chatContractorIds = new Set(Object.keys(messages).map(Number));
  if (activeChat) chatContractorIds.add(activeChat);
  const chatContractors = contractors.filter(c => chatContractorIds.has(c.id));

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif", background: "#0f172a", minHeight: "100vh", color: "#f1f5f9" }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #334155; border-radius: 2px; }
        .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
        .tab-btn { background: none; border: none; cursor: pointer; padding: 10px 18px; font-size: 14px; font-weight: 600; color: #94a3b8; border-bottom: 2px solid transparent; transition: all 0.2s; font-family: inherit; white-space: nowrap; }
        .tab-btn.active { color: #f59e0b; border-bottom-color: #f59e0b; }
        .tab-btn:focus-visible { outline: 2px solid #f59e0b; outline-offset: -2px; }
        .card { background: #1e293b; border-radius: 16px; border: 1px solid #334155; transition: transform 0.18s, box-shadow 0.18s; }
        .card-hover:hover { transform: translateY(-2px); box-shadow: 0 8px 32px rgba(0,0,0,0.25); }
        .badge { display: inline-block; background: #334155; color: #94a3b8; border-radius: 99px; padding: 3px 10px; font-size: 11px; font-weight: 600; }
        .avail { background: #064e3b; color: #34d399; }
        .unavail { background: #3b1515; color: #f87171; }
        .btn { border: none; border-radius: 10px; padding: 10px 20px; font-weight: 700; cursor: pointer; font-family: inherit; font-size: 14px; transition: opacity 0.15s, transform 0.15s; }
        .btn:hover { opacity: 0.88; transform: scale(0.98); }
        .btn:focus-visible { outline: 2px solid #f59e0b; outline-offset: 2px; }
        .btn-gold { background: #f59e0b; color: #0f172a; }
        .btn-outline { background: transparent; border: 1.5px solid #334155; color: #94a3b8; }
        .btn-sm { padding: 6px 14px; font-size: 13px; border-radius: 8px; }
        input, textarea, select { background: #0f172a; border: 1.5px solid #334155; border-radius: 10px; color: #f1f5f9; padding: 10px 14px; font-family: inherit; font-size: 14px; width: 100%; outline: none; }
        input:focus, textarea:focus, select:focus { border-color: #f59e0b; box-shadow: 0 0 0 3px rgba(245,158,11,0.15); }
        .msg-me { background: #f59e0b; color: #0f172a; border-radius: 18px 18px 4px 18px; }
        .msg-them { background: #1e293b; border: 1px solid #334155; border-radius: 18px 18px 18px 4px; }
        .notification { position: fixed; top: 20px; right: 20px; background: #f59e0b; color: #0f172a; padding: 12px 22px; border-radius: 12px; font-weight: 700; z-index: 999; animation: slidein 0.3s; }
        @keyframes slidein { from { opacity: 0; transform: translateY(-16px); } to { opacity: 1; transform: translateY(0); } }
        .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 20px; backdrop-filter: blur(2px); }
        .modal { background: #1e293b; border-radius: 20px; border: 1px solid #334155; width: 100%; max-width: 480px; padding: 28px; max-height: 90vh; overflow-y: auto; }
        .contractor-card:focus-visible { outline: 2px solid #f59e0b; outline-offset: 2px; border-radius: 16px; }
        .star-btn { background: none; border: none; cursor: pointer; padding: 2px; font-size: 24px; line-height: 1; transition: transform 0.1s; }
        .star-btn:hover { transform: scale(1.15); }
        .star-btn:focus-visible { outline: 2px solid #f59e0b; outline-offset: 2px; border-radius: 2px; }
        .nav-scroll { display: flex; overflow-x: auto; scrollbar-width: none; }
        .nav-scroll::-webkit-scrollbar { display: none; }
        .messages-layout { display: grid; grid-template-columns: 220px 1fr; gap: 16px; height: 500px; }
        .chat-sidebar-btn { display: flex; align-items: center; gap: 10px; cursor: pointer; padding: 12px; border-radius: 16px; background: #1e293b; border: 1px solid #334155; width: 100%; text-align: left; font-family: inherit; transition: border-color 0.15s; }
        .chat-sidebar-btn:focus-visible { outline: 2px solid #f59e0b; outline-offset: 2px; }
        @media (max-width: 640px) {
          .tab-btn { padding: 10px 10px; font-size: 12px; }
          .messages-layout { grid-template-columns: 1fr; height: auto; }
          .messages-chat { height: 380px; }
          .messages-sidebar-list { flex-direction: row !important; overflow-x: auto; }
          .job-grid { grid-template-columns: 1fr !important; }
          .modal { padding: 20px; }
        }
      `}</style>

      {notification && (
        <div className="notification" role="alert" aria-live="assertive">✓ {notification}</div>
      )}

      <header style={{ background: "#0f172a", borderBottom: "1px solid #1e293b", padding: "0 20px" }}>
        <div style={{ maxWidth: 900, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", height: 60, gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            <span style={{ fontSize: 22, fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#f59e0b" }}>⚒ TRADELINK</span>
            <span style={{ fontSize: 11, color: "#475569", fontWeight: 600, letterSpacing: 1 }}>PRO</span>
          </div>
          <nav aria-label="Main navigation" className="nav-scroll" style={{ flex: 1, justifyContent: "center" }}>
            {TAB_ORDER.filter(t => {
              if (t === "search" || t === "reviews") return true;
              if (t === "messages") return !!user;
              if (t === "post")     return !user || isCustomer;
              if (t === "jobs")     return isContractor;
              return true;
            }).map(t => (
              <button
                key={t}
                className={`tab-btn ${tab === t ? "active" : ""}`}
                onClick={() => setTab(t)}
                aria-current={tab === t ? "page" : undefined}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </nav>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {user ? (
              <>
                {isContractor && myContractor && (
                  <button
                    className="btn btn-sm"
                    onClick={toggleAvailable}
                    aria-label={`Toggle availability, currently ${myContractor.available ? "open" : "busy"}`}
                    style={{
                      background: "transparent",
                      border: `1.5px solid ${myContractor.available ? "#34d399" : "#f87171"}`,
                      color: myContractor.available ? "#34d399" : "#f87171",
                    }}
                  >
                    ● {myContractor.available ? "Open" : "Busy"}
                  </button>
                )}
                {isContractor && (
                  <button className="btn btn-outline btn-sm" onClick={openProfileModal} title={user.email}>
                    {myContractor ? "Edit Profile" : "Create Profile"}
                  </button>
                )}
                <button className="btn btn-outline btn-sm" onClick={signOut}>Sign Out</button>
              </>
            ) : (
              <button
                className="btn btn-gold btn-sm"
                onClick={() => { setAuthMode("signin"); setAuthError(null); setAuthModal(true); }}
              >
                Sign In
              </button>
            )}
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 900, margin: "0 auto", padding: "24px 20px" }}>

        {user && !role && (
          <div className="card" style={{ padding: 20, marginBottom: 20, borderColor: "#f59e0b" }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Which type of account is this?</div>
            <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 14 }}>
              Pick one to unlock posting or accepting jobs. You can ignore this if you only want to browse.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }} className="job-grid">
              <button className="btn btn-gold" onClick={() => assignRole("customer")}>
                I'm a Customer<br/><span style={{ fontWeight: 400, fontSize: 12 }}>I need a contractor</span>
              </button>
              <button className="btn btn-gold" onClick={() => assignRole("contractor")}>
                I'm a Contractor<br/><span style={{ fontWeight: 400, fontSize: 12 }}>I want to find jobs</span>
              </button>
            </div>
          </div>
        )}

        {isContractor && !myContractor && (
          <div className="card" style={{ padding: 16, marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", borderColor: "#f59e0b" }}>
            <div>
              <div style={{ fontWeight: 700, marginBottom: 2 }}>Complete your contractor profile</div>
              <div style={{ fontSize: 13, color: "#94a3b8" }}>Add your name, trade, and rate so homeowners can find you.</div>
            </div>
            <button className="btn btn-gold btn-sm" onClick={openProfileModal}>Create Profile</button>
          </div>
        )}


        {/* SEARCH TAB */}
        {tab === "search" && (
          <section aria-labelledby="search-heading">
            <h1 id="search-heading" style={{ fontSize: 28, fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#f59e0b", marginBottom: 4 }}>FIND A CONTRACTOR</h1>
            <p style={{ color: "#64748b", marginBottom: 20, fontSize: 14 }}>Browse verified construction & home service pros</p>
            <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
              <label htmlFor="contractor-search" className="sr-only">Search contractors</label>
              <input
                id="contractor-search"
                placeholder="Search by name, trade, or city..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{ flex: 1, minWidth: 200 }}
              />
              <label htmlFor="trade-filter" className="sr-only">Filter by trade</label>
              <select
                id="trade-filter"
                value={trade}
                onChange={e => setTrade(e.target.value)}
                style={{ width: "auto", minWidth: 160 }}
              >
                {TRADES.map(t => <option key={t}>{t}</option>)}
              </select>
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
                  aria-label={`View profile for ${c.name}, ${c.trade} in ${c.location}`}
                >
                  <Avatar initials={c.avatar} size={52} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
                      <span style={{ fontWeight: 700, fontSize: 16 }}>{c.name}</span>
                      <span className={`badge ${c.available ? "avail" : "unavail"}`}>
                        {c.available ? "Available" : "Busy"}
                      </span>
                    </div>
                    <div style={{ color: "#94a3b8", fontSize: 13, marginBottom: 6 }}>{c.trade} · {c.location}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                      <Stars rating={c.rating} />
                      <span style={{ fontSize: 13, color: "#94a3b8" }}>{c.rating} ({c.reviews_count} reviews)</span>
                      <span style={{ color: "#f59e0b", fontWeight: 700, fontSize: 13 }}>${c.hourly}/hr</span>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {c.tags.map(tag => <span key={tag} className="badge">{tag}</span>)}
                    </div>
                  </div>
                  <button
                    className="btn btn-gold btn-sm"
                    onClick={e => { e.stopPropagation(); setActiveChat(c.id); setTab("messages"); }}
                    aria-label={`Message ${c.name}`}
                  >
                    Message
                  </button>
                </div>
              ))}
              {filtered.length === 0 && (
                <div style={{ textAlign: "center", color: "#475569", padding: 40 }} role="status">
                  No contractors found. Try adjusting your search.
                </div>
              )}
            </div>
          </section>
        )}

        {/* POST JOB TAB */}
        {tab === "post" && !user && (
          <section aria-labelledby="post-heading" style={{ maxWidth: 560 }}>
            <h1 id="post-heading" style={{ fontSize: 28, fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#f59e0b", marginBottom: 4 }}>POST A JOB</h1>
            <div className="card" style={{ padding: 28, textAlign: "center" }}>
              <div style={{ fontSize: 36, marginBottom: 12 }} aria-hidden="true">🔒</div>
              <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 6 }}>Sign up to post a job</div>
              <div style={{ color: "#94a3b8", fontSize: 14, marginBottom: 18 }}>
                Create a free customer account to post jobs and connect with verified contractors.
              </div>
              <button
                className="btn btn-gold"
                onClick={() => { setAuthMode("signup"); setAuthForm(f => ({ ...f, role: "customer" })); setAuthError(null); setAuthModal(true); }}
              >
                Sign Up as a Customer
              </button>
            </div>
          </section>
        )}

        {tab === "post" && isCustomer && (
          <section aria-labelledby="post-heading" style={{ maxWidth: 720 }}>
            <h1 id="post-heading" style={{ fontSize: 28, fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#f59e0b", marginBottom: 4 }}>POST A JOB</h1>
            <p style={{ color: "#64748b", marginBottom: 24, fontSize: 14 }}>Describe your project and let contractors come to you</p>
            <form
              className="card"
              style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}
              onSubmit={e => { e.preventDefault(); postJob(); }}
              noValidate
            >
              <div>
                <label htmlFor="job-title" style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6, display: "block" }}>
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
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }} className="job-grid">
                <div>
                  <label htmlFor="job-trade" style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6, display: "block" }}>Trade Needed</label>
                  <select id="job-trade" value={jobForm.trade} onChange={e => setJobForm(f => ({ ...f, trade: e.target.value }))}>
                    {TRADES.filter(t => t !== "All Trades").map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="job-budget" style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6, display: "block" }}>Budget ($)</label>
                  <input
                    id="job-budget"
                    placeholder="e.g. 5000"
                    value={jobForm.budget}
                    onChange={e => setJobForm(f => ({ ...f, budget: e.target.value }))}
                    type="number"
                    min="0"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="job-location" style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6, display: "block" }}>
                  Location <span aria-hidden="true">*</span>
                </label>
                <input
                  id="job-location"
                  placeholder="City, State"
                  value={jobForm.location}
                  onChange={e => setJobForm(f => ({ ...f, location: e.target.value }))}
                  required
                  aria-required="true"
                />
              </div>
              <div>
                <label htmlFor="job-desc" style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6, display: "block" }}>Job Description</label>
                <textarea
                  id="job-desc"
                  rows={4}
                  placeholder="Describe the scope of work, materials, timeline..."
                  value={jobForm.desc}
                  onChange={e => setJobForm(f => ({ ...f, desc: e.target.value }))}
                />
              </div>

              <div style={{ borderTop: "1px solid #334155", paddingTop: 14, marginTop: 4 }}>
                <div style={{ fontSize: 12, color: "#f59e0b", fontWeight: 700, letterSpacing: 1, marginBottom: 10 }}>YOUR CONTACT INFO</div>
                <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>Only shared with the contractor who accepts your job.</div>
                <div>
                  <label htmlFor="job-name" style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6, display: "block" }}>
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
                    <label htmlFor="job-email" style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6, display: "block" }}>
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
                    <label htmlFor="job-phone" style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6, display: "block" }}>Phone (optional)</label>
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

            <h2 style={{ fontSize: 20, fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#f59e0b", marginTop: 32, marginBottom: 12 }}>
              YOUR POSTED JOBS
            </h2>
            {myJobs.length === 0 ? (
              <div style={{ color: "#475569", padding: 20 }}>You haven't posted any jobs yet.</div>
            ) : (
              <div style={{ display: "grid", gap: 12 }} role="list" aria-label="Your posted jobs">
                {myJobs.map(j => (
                  <div key={j.id} className="card" style={{ padding: 18 }} role="listitem">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
                      <div style={{ fontWeight: 700, fontSize: 16 }}>{j.title}</div>
                      {j.budget != null && (
                        <span style={{ color: "#f59e0b", fontWeight: 700, fontSize: 14 }}>${Number(j.budget).toLocaleString()}</span>
                      )}
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                      <span className="badge">{j.trade}</span>
                      <span className="badge">{j.location}</span>
                      {j.accepted_by
                        ? <span className="badge avail">Accepted</span>
                        : <span className="badge">Open</span>}
                    </div>
                    {j.accepter && (
                      <div style={{ background: "#0f172a", borderRadius: 10, padding: 12, marginBottom: 8 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: "#f59e0b", marginBottom: 6 }}>ACCEPTED BY</div>
                        <div style={{ fontWeight: 600 }}>{j.accepter.name}</div>
                        <div style={{ fontSize: 13, color: "#94a3b8" }}>{j.accepter.trade} · {j.accepter.location}</div>
                      </div>
                    )}
                    {j.description && (
                      <p style={{ color: "#94a3b8", fontSize: 13, lineHeight: 1.5 }}>{j.description}</p>
                    )}
                    <div style={{ color: "#475569", fontSize: 11, marginTop: 8 }}>
                      Posted {new Date(j.created_at).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === "post" && isContractor && (
          <section style={{ maxWidth: 560 }}>
            <h1 style={{ fontSize: 28, fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#f59e0b", marginBottom: 4 }}>POST A JOB</h1>
            <div className="card" style={{ padding: 24 }}>
              <div style={{ color: "#94a3b8", marginBottom: 8 }}>Posting jobs is for customers only.</div>
              <div style={{ fontSize: 14, color: "#64748b" }}>Browse open jobs from the <button className="btn btn-outline btn-sm" onClick={() => setTab("jobs")} style={{ marginLeft: 4 }}>Jobs</button> tab.</div>
            </div>
          </section>
        )}

        {/* JOBS TAB (contractors only) */}
        {tab === "jobs" && user && (
          <section aria-labelledby="jobs-heading">
            <h1 id="jobs-heading" style={{ fontSize: 28, fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#f59e0b", marginBottom: 4 }}>OPEN JOBS</h1>
            <p style={{ color: "#64748b", marginBottom: 20, fontSize: 14 }}>Browse jobs posted by homeowners. Reach out to claim work.</p>
            <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
              <label htmlFor="job-trade-filter" className="sr-only">Filter by trade</label>
              <select
                id="job-trade-filter"
                value={trade}
                onChange={e => setTrade(e.target.value)}
                style={{ width: "auto", minWidth: 200 }}
              >
                {TRADES.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            {jobs.length === 0 ? (
              <div style={{ color: "#475569", padding: 40, textAlign: "center" }} role="status">
                No jobs posted yet. Check back soon.
              </div>
            ) : (
              <div style={{ display: "grid", gap: 12 }} role="list" aria-label="Open jobs">
                {jobs.filter(j => trade === "All Trades" || j.trade === trade).map(j => {
                  const minePicked  = j.accepted_by === user.id;
                  const taken       = !!j.accepted_by && !minePicked;
                  return (
                    <div key={j.id} className="card" style={{ padding: 20, opacity: taken ? 0.6 : 1 }} role="listitem">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
                        <div style={{ fontWeight: 700, fontSize: 17 }}>{j.title}</div>
                        {j.budget != null && (
                          <span style={{ color: "#f59e0b", fontWeight: 700, fontSize: 15 }}>${Number(j.budget).toLocaleString()}</span>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: j.description ? 10 : 0 }}>
                        <span className="badge">{j.trade}</span>
                        <span className="badge">{j.location}</span>
                        {minePicked && <span className="badge avail">✓ Accepted by you</span>}
                        {taken && <span className="badge unavail">Accepted</span>}
                      </div>
                      {j.description && (
                        <p style={{ color: "#94a3b8", fontSize: 13, lineHeight: 1.55, marginBottom: 10 }}>{j.description}</p>
                      )}
                      {minePicked && (
                        <div style={{ background: "#064e3b", border: "1px solid #047857", borderRadius: 10, padding: 14, marginBottom: 10 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: "#34d399", marginBottom: 8 }}>
                            HOMEOWNER CONTACT
                          </div>
                          {j.homeowner_name && (
                            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{j.homeowner_name}</div>
                          )}
                          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 13 }}>
                            {j.homeowner_email && (
                              <a href={`mailto:${j.homeowner_email}`} style={{ color: "#34d399", textDecoration: "underline" }}>
                                ✉ {j.homeowner_email}
                              </a>
                            )}
                            {j.homeowner_phone && (
                              <a href={`tel:${j.homeowner_phone}`} style={{ color: "#34d399", textDecoration: "underline" }}>
                                ☎ {j.homeowner_phone}
                              </a>
                            )}
                          </div>
                          {!j.homeowner_email && !j.homeowner_phone && (
                            <div style={{ fontSize: 12, color: "#94a3b8" }}>
                              No contact info on this job — homeowner posted before contact fields were added.
                            </div>
                          )}
                        </div>
                      )}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                        <div style={{ color: "#475569", fontSize: 11 }}>
                          Posted {new Date(j.created_at).toLocaleString()}
                        </div>
                        {!j.accepted_by && (
                          <button
                            className="btn btn-gold btn-sm"
                            onClick={() => acceptJob(j.id)}
                            disabled={!myContractor}
                            title={!myContractor ? "Complete your profile first" : undefined}
                            style={{ opacity: !myContractor ? 0.5 : 1 }}
                          >
                            Accept Job
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
                {jobs.filter(j => trade === "All Trades" || j.trade === trade).length === 0 && (
                  <div style={{ color: "#475569", textAlign: "center", padding: 24 }} role="status">
                    No jobs match this trade. Try "All Trades".
                  </div>
                )}
              </div>
            )}
          </section>
        )}

        {/* MESSAGES TAB */}
        {tab === "messages" && (
          <section aria-labelledby="messages-heading">
            <h1 id="messages-heading" style={{ fontSize: 28, fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#f59e0b", marginBottom: 16 }}>MESSAGES</h1>
            {chatContractors.length === 0 ? (
              <div className="card" style={{ padding: 40, textAlign: "center" }}>
                <div style={{ fontSize: 36, marginBottom: 12 }} aria-hidden="true">💬</div>
                <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 6 }}>No conversations yet</div>
                <div style={{ color: "#94a3b8", fontSize: 14, marginBottom: 16 }}>
                  Start a chat by clicking <span style={{ color: "#f59e0b", fontWeight: 600 }}>Message</span> on a contractor in the Find tab.
                </div>
                <button className="btn btn-gold btn-sm" onClick={() => setTab("search")}>Browse Contractors</button>
              </div>
            ) : (
            <div className="messages-layout">
              <div
                className="messages-sidebar-list"
                style={{ display: "flex", flexDirection: "column", gap: 8 }}
                role="list"
                aria-label="Conversations"
              >
                {chatContractors.map(c => (
                  <button
                    key={c.id}
                    className="chat-sidebar-btn"
                    role="listitem"
                    onClick={() => setActiveChat(c.id)}
                    style={{ borderColor: activeChat === c.id ? "#f59e0b" : "#334155" }}
                    aria-pressed={activeChat === c.id}
                    aria-label={`Chat with ${c.name}`}
                  >
                    <Avatar initials={c.avatar} size={36} />
                    <div style={{ overflow: "hidden" }}>
                      <div style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "#f1f5f9" }}>{c.name}</div>
                      <div style={{ fontSize: 11, color: "#64748b" }}>{c.trade}</div>
                    </div>
                  </button>
                ))}
              </div>
              <div className="card messages-chat" style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <div style={{ padding: "14px 18px", borderBottom: "1px solid #334155", display: "flex", alignItems: "center", gap: 12 }}>
                  <ChatHeader contractors={contractors} contractorId={activeChat} />
                </div>
                <div
                  style={{ flex: 1, overflowY: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 10 }}
                  role="log"
                  aria-live="polite"
                  aria-label="Message history"
                >
                  {(messages[activeChat] || []).length === 0 && (
                    <div style={{ color: "#475569", textAlign: "center", marginTop: 60 }}>No messages yet. Say hello!</div>
                  )}
                  {(messages[activeChat] || []).map((m, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: m.from === "me" ? "flex-end" : "flex-start" }}>
                      <div
                        className={m.from === "me" ? "msg-me" : "msg-them"}
                        style={{ padding: "10px 14px", maxWidth: "72%", fontSize: 14 }}
                      >
                        {m.text}
                      </div>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </div>
                <div style={{ padding: "12px 18px", borderTop: "1px solid #334155", display: "flex", gap: 10 }}>
                  <label htmlFor="msg-input" className="sr-only">Message</label>
                  <input
                    id="msg-input"
                    placeholder="Type a message..."
                    value={msgInput}
                    onChange={e => setMsgInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && sendMessage()}
                  />
                  <button className="btn btn-gold" style={{ whiteSpace: "nowrap" }} onClick={sendMessage} aria-label="Send message">
                    Send →
                  </button>
                </div>
              </div>
            </div>
            )}
          </section>
        )}

        {/* REVIEWS TAB */}
        {tab === "reviews" && (
          <section aria-labelledby="reviews-heading">
            <h1 id="reviews-heading" style={{ fontSize: 28, fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#f59e0b", marginBottom: 16 }}>REVIEWS</h1>
            <div style={{ display: "grid", gap: 20 }}>
              {contractors.map(c => (
                <div key={c.id} className="card" style={{ padding: 20 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14, flexWrap: "wrap" }}>
                    <Avatar initials={c.avatar} size={44} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700 }}>{c.name}</div>
                      <div style={{ fontSize: 13, color: "#64748b" }}>{c.trade}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <Stars rating={c.rating} />
                      <span style={{ color: "#f59e0b", fontWeight: 700 }}>{c.rating}</span>
                    </div>
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => { setReviewTarget(reviewTarget === c.id ? null : c.id); setReviewInput({ stars: 5, text: "" }); }}
                      aria-expanded={reviewTarget === c.id}
                      aria-controls={`review-form-${c.id}`}
                    >
                      {reviewTarget === c.id ? "Cancel" : "+ Review"}
                    </button>
                  </div>

                  {reviewTarget === c.id && (
                    <form
                      id={`review-form-${c.id}`}
                      style={{ background: "#0f172a", borderRadius: 12, padding: 16, marginBottom: 14 }}
                      onSubmit={e => { e.preventDefault(); submitReview(); }}
                    >
                      <fieldset style={{ border: "none", padding: 0, margin: "0 0 10px 0" }}>
                        <legend style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6, display: "block" }}>Your Rating</legend>
                        <div style={{ display: "flex", gap: 4 }}>
                          {[1, 2, 3, 4, 5].map(s => (
                            <button
                              key={s}
                              type="button"
                              className="star-btn"
                              onClick={() => setReviewInput(r => ({ ...r, stars: s }))}
                              aria-label={`${s} star${s !== 1 ? "s" : ""}`}
                              aria-pressed={s <= reviewInput.stars}
                              style={{ color: s <= reviewInput.stars ? "#f59e0b" : "#334155" }}
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
                      <div key={i} style={{ background: "#0f172a", borderRadius: 10, padding: 14 }} role="listitem">
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, flexWrap: "wrap", gap: 4 }}>
                          <span style={{ fontWeight: 600, fontSize: 13 }}>{r.author}</span>
                          <span aria-label={`${r.stars} stars`}>
                            {[...Array(r.stars)].map((_, j) => (
                              <span key={j} style={{ color: "#f59e0b" }} aria-hidden="true">★</span>
                            ))}
                          </span>
                        </div>
                        <p style={{ color: "#94a3b8", fontSize: 13 }}>{r.text}</p>
                      </div>
                    ))}
                    {!(reviews[c.id] || []).length && (
                      <div style={{ color: "#475569", fontSize: 13 }}>No reviews yet. Be the first!</div>
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
                <div id="modal-contractor-name" style={{ fontWeight: 700, fontSize: 20 }}>{modal.name}</div>
                <div style={{ color: "#64748b", fontSize: 14 }}>{modal.trade} · {modal.location}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                  <Stars rating={modal.rating} />
                  <span style={{ color: "#94a3b8", fontSize: 13 }}>{modal.rating} ({modal.reviews_count} reviews)</span>
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
            <p style={{ color: "#94a3b8", marginBottom: 16, lineHeight: 1.6 }}>{modal.bio}</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
              {modal.tags.map(t => <span key={t} className="badge">{t}</span>)}
            </div>
            <div style={{ background: "#0f172a", borderRadius: 12, padding: 16, marginBottom: 20, display: "flex", justifyContent: "space-around" }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ color: "#f59e0b", fontWeight: 700, fontSize: 22 }}>${modal.hourly}</div>
                <div style={{ color: "#64748b", fontSize: 12 }}>Per Hour</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <div style={{ color: "#34d399", fontWeight: 700, fontSize: 22 }}>{modal.reviews_count}</div>
                <div style={{ color: "#64748b", fontSize: 12 }}>Reviews</div>
              </div>
              <div style={{ textAlign: "center" }}>
                <span className={`badge ${modal.available ? "avail" : "unavail"}`} style={{ fontSize: 14, padding: "6px 14px" }}>
                  {modal.available ? "Open" : "Busy"}
                </span>
                <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>Status</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                className="btn btn-gold"
                style={{ flex: 1 }}
                onClick={() => { setActiveChat(modal.id); setTab("messages"); setModal(null); }}
              >
                💬 Send Message
              </button>
              <button
                className="btn btn-outline"
                style={{ flex: 1 }}
                onClick={() => { setReviewTarget(modal.id); setTab("reviews"); setModal(null); }}
              >
                ⭐ Leave Review
              </button>
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
              <h2 id="profile-modal-title" style={{ fontSize: 22, fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#f59e0b" }}>
                {myContractor ? "EDIT PROFILE" : "CREATE YOUR PROFILE"}
              </h2>
              <button className="btn btn-outline btn-sm" onClick={() => setProfileModal(false)} aria-label="Close">✕</button>
            </div>
            <form onSubmit={saveProfile} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label htmlFor="pf-name" style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6, display: "block" }}>Business / Your Name *</label>
                <input
                  id="pf-name"
                  required
                  placeholder="e.g. Iron Ridge Builders"
                  value={profileForm.name}
                  onChange={e => setProfileForm(f => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }} className="job-grid">
                <div>
                  <label htmlFor="pf-trade" style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6, display: "block" }}>Trade *</label>
                  <select id="pf-trade" value={profileForm.trade} onChange={e => setProfileForm(f => ({ ...f, trade: e.target.value }))}>
                    {TRADES.filter(t => t !== "All Trades").map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="pf-hourly" style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6, display: "block" }}>Hourly Rate ($)</label>
                  <input
                    id="pf-hourly"
                    type="number"
                    min="0"
                    placeholder="e.g. 80"
                    value={profileForm.hourly}
                    onChange={e => setProfileForm(f => ({ ...f, hourly: e.target.value }))}
                  />
                </div>
              </div>
              <div>
                <label htmlFor="pf-location" style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6, display: "block" }}>Location *</label>
                <input
                  id="pf-location"
                  required
                  placeholder="City, State"
                  value={profileForm.location}
                  onChange={e => setProfileForm(f => ({ ...f, location: e.target.value }))}
                />
              </div>
              <div>
                <label htmlFor="pf-tags" style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6, display: "block" }}>Specialties (comma-separated)</label>
                <input
                  id="pf-tags"
                  placeholder="e.g. Renovations, New Builds, Framing"
                  value={profileForm.tags}
                  onChange={e => setProfileForm(f => ({ ...f, tags: e.target.value }))}
                />
              </div>
              <div>
                <label htmlFor="pf-bio" style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6, display: "block" }}>Bio</label>
                <textarea
                  id="pf-bio"
                  rows={3}
                  placeholder="Brief intro homeowners will see"
                  value={profileForm.bio}
                  onChange={e => setProfileForm(f => ({ ...f, bio: e.target.value }))}
                />
              </div>
              {profileError && (
                <div style={{ color: "#f87171", fontSize: 13, background: "#3b1515", padding: "8px 12px", borderRadius: 8 }} role="alert">
                  {profileError}
                </div>
              )}
              <button type="submit" className="btn btn-gold" disabled={profileBusy} style={{ opacity: profileBusy ? 0.6 : 1 }}>
                {profileBusy ? "Saving..." : myContractor ? "Save Changes" : "Create Profile"}
              </button>
            </form>
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
              <h2 id="auth-modal-title" style={{ fontSize: 22, fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#f59e0b" }}>
                {authMode === "signin" ? "SIGN IN" : "CREATE ACCOUNT"}
              </h2>
              <button className="btn btn-outline btn-sm" onClick={() => setAuthModal(false)} aria-label="Close">✕</button>
            </div>
            <form onSubmit={submitAuth} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {authMode === "signup" && (
                <div>
                  <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>I am a...</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    {[
                      { value: "customer",   label: "Customer",  sub: "I need a contractor" },
                      { value: "contractor", label: "Contractor", sub: "I want to find jobs" },
                    ].map(opt => {
                      const active = authForm.role === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setAuthForm(f => ({ ...f, role: opt.value }))}
                          style={{
                            background: active ? "#f59e0b" : "transparent",
                            color: active ? "#0f172a" : "#94a3b8",
                            border: `1.5px solid ${active ? "#f59e0b" : "#334155"}`,
                            borderRadius: 10,
                            padding: "10px 12px",
                            cursor: "pointer",
                            fontFamily: "inherit",
                            textAlign: "left",
                          }}
                          aria-pressed={active}
                        >
                          <div style={{ fontWeight: 700, fontSize: 13 }}>{opt.label}</div>
                          <div style={{ fontSize: 11, opacity: 0.85 }}>{opt.sub}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <div>
                <label htmlFor="auth-email" style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6, display: "block" }}>Email</label>
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
                <label htmlFor="auth-password" style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6, display: "block" }}>Password</label>
                <input
                  id="auth-password"
                  type="password"
                  required
                  minLength={6}
                  autoComplete={authMode === "signin" ? "current-password" : "new-password"}
                  value={authForm.password}
                  onChange={e => setAuthForm(f => ({ ...f, password: e.target.value }))}
                />
              </div>
              {authError && (
                <div style={{ color: "#f87171", fontSize: 13, background: "#3b1515", padding: "8px 12px", borderRadius: 8 }} role="alert">
                  {authError}
                </div>
              )}
              <button type="submit" className="btn btn-gold" disabled={authBusy} style={{ opacity: authBusy ? 0.6 : 1 }}>
                {authBusy ? "Working..." : authMode === "signin" ? "Sign In" : "Create Account"}
              </button>
              <button
                type="button"
                onClick={() => { setAuthMode(authMode === "signin" ? "signup" : "signin"); setAuthError(null); }}
                style={{ background: "none", border: "none", color: "#94a3b8", fontSize: 13, cursor: "pointer", fontFamily: "inherit", textDecoration: "underline" }}
              >
                {authMode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
