import { useState, useEffect, useRef } from "react";

const CONTRACTORS = [
  { id: 1, name: "Iron Ridge Builders", trade: "General Contractor", location: "Austin, TX", rating: 4.9, reviews: 47, hourly: 95, available: true, tags: ["Renovations", "New Builds", "Framing"], bio: "15 years of residential and commercial builds. Licensed & insured.", avatar: "IR" },
  { id: 2, name: "BlueSky Plumbing", trade: "Plumber", location: "Denver, CO", rating: 4.7, reviews: 83, hourly: 80, available: true, tags: ["Pipes", "Water Heaters", "Drain Repair"], bio: "Fast, reliable plumbing for residential and light commercial jobs.", avatar: "BS" },
  { id: 3, name: "Volt Pro Electric", trade: "Electrician", location: "Phoenix, AZ", rating: 4.8, reviews: 62, hourly: 90, available: false, tags: ["Panel Upgrades", "Wiring", "EV Chargers"], bio: "Certified master electrician. All permits handled.", avatar: "VP" },
  { id: 4, name: "Apex Roofing Co.", trade: "Roofer", location: "Dallas, TX", rating: 4.6, reviews: 34, hourly: 75, available: true, tags: ["Shingles", "Flat Roof", "Gutters"], bio: "Storm damage? We've got you covered — literally.", avatar: "AR" },
  { id: 5, name: "CleanCut Carpentry", trade: "Carpenter", location: "Nashville, TN", rating: 5.0, reviews: 21, hourly: 70, available: true, tags: ["Cabinets", "Trim", "Decks"], bio: "Precision woodworking for custom homes and renovations.", avatar: "CC" },
  { id: 6, name: "TileKing Masonry", trade: "Mason", location: "Chicago, IL", rating: 4.5, reviews: 58, hourly: 85, available: false, tags: ["Tile", "Concrete", "Brick"], bio: "Commercial and residential masonry with 20+ years experience.", avatar: "TK" },
];

const TRADES = ["All Trades", "General Contractor", "Plumber", "Electrician", "Roofer", "Carpenter", "Mason"];

const MESSAGES_INIT = {
  1: [{ from: "them", text: "Hi! I saw your job posting for the kitchen remodel. I'd love to discuss." }],
  2: [],
};

const REVIEWS_INIT = {
  1: [
    { author: "Sunrise Homes LLC", stars: 5, text: "Iron Ridge did an incredible job on our 12-unit build. On time, on budget." },
    { author: "The Patel Family", stars: 5, text: "Remodeled our entire ground floor. Couldn't be happier!" },
  ],
  2: [{ author: "GreenLeaf Properties", stars: 4, text: "Fast response and clean work. Minor scheduling hiccup but resolved quickly." }],
};

const AVATAR_COLORS = { IR: "#b45309", BS: "#0369a1", VP: "#7c3aed", AR: "#b91c1c", CC: "#047857", TK: "#374151" };

const TAB_LABELS = {
  search: "🔍 Find",
  post: "📋 Post Job",
  messages: "💬 Messages",
  reviews: "⭐ Reviews",
};

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

function ChatHeader({ contractorId }) {
  const c = CONTRACTORS.find(x => x.id === contractorId);
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
  const [messages, setMessages] = useState(MESSAGES_INIT);
  const [reviews, setReviews] = useState(REVIEWS_INIT);
  const [msgInput, setMsgInput] = useState("");
  const [activeChat, setActiveChat] = useState(1);
  const [reviewInput, setReviewInput] = useState({ stars: 5, text: "" });
  const [reviewTarget, setReviewTarget] = useState(null);
  const [modal, setModal] = useState(null);
  const [jobPosted, setJobPosted] = useState(false);
  const [jobForm, setJobForm] = useState({ title: "", trade: "Plumber", location: "", budget: "", desc: "" });
  const [notification, setNotification] = useState(null);

  const messagesEndRef = useRef(null);
  const modalRef = useRef(null);

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

  const filtered = CONTRACTORS.filter(c => {
    const matchTrade = trade === "All Trades" || c.trade === trade;
    const q = search.toLowerCase();
    const matchSearch = c.name.toLowerCase().includes(q) || c.trade.toLowerCase().includes(q) || c.location.toLowerCase().includes(q);
    return matchTrade && matchSearch;
  });

  function notify(msg) {
    setNotification(msg);
    setTimeout(() => setNotification(null), 3000);
  }

  function sendMessage() {
    if (!msgInput.trim()) return;
    setMessages(prev => ({
      ...prev,
      [activeChat]: [...(prev[activeChat] || []), { from: "me", text: msgInput }],
    }));
    setMsgInput("");
    setTimeout(() => {
      setMessages(prev => ({
        ...prev,
        [activeChat]: [...(prev[activeChat] || []), { from: "them", text: "Thanks for reaching out! I'll get back to you shortly." }],
      }));
    }, 1200);
  }

  function submitReview() {
    if (!reviewInput.text.trim()) return;
    setReviews(prev => ({
      ...prev,
      [reviewTarget]: [...(prev[reviewTarget] || []), { author: "Your Business", stars: reviewInput.stars, text: reviewInput.text }],
    }));
    setReviewInput({ stars: 5, text: "" });
    setReviewTarget(null);
    notify("Review submitted!");
  }

  function postJob() {
    if (!jobForm.title || !jobForm.location) return;
    setJobPosted(true);
    notify("Job posted! Contractors will reach out shortly.");
  }

  const chatContractors = CONTRACTORS.filter(c => [1, 2].includes(c.id));

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
          <nav aria-label="Main navigation" className="nav-scroll">
            {Object.keys(TAB_LABELS).map(t => (
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
        </div>
      </header>

      <main style={{ maxWidth: 900, margin: "0 auto", padding: "24px 20px" }}>

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
                      <span style={{ fontSize: 13, color: "#94a3b8" }}>{c.rating} ({c.reviews} reviews)</span>
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
        {tab === "post" && (
          <section aria-labelledby="post-heading" style={{ maxWidth: 560 }}>
            <h1 id="post-heading" style={{ fontSize: 28, fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#f59e0b", marginBottom: 4 }}>POST A JOB</h1>
            <p style={{ color: "#64748b", marginBottom: 24, fontSize: 14 }}>Describe your project and let contractors come to you</p>
            {jobPosted ? (
              <div className="card" style={{ padding: 32, textAlign: "center" }} role="status" aria-live="polite">
                <div style={{ fontSize: 48, marginBottom: 12 }} aria-hidden="true">🎉</div>
                <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 8 }}>Job Posted!</div>
                <div style={{ color: "#64748b", marginBottom: 20 }}>Contractors in your area will reach out to you shortly.</div>
                <button
                  className="btn btn-outline"
                  onClick={() => { setJobPosted(false); setJobForm({ title: "", trade: "Plumber", location: "", budget: "", desc: "" }); }}
                >
                  Post Another Job
                </button>
              </div>
            ) : (
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
                <button type="submit" className="btn btn-gold" style={{ alignSelf: "flex-start", padding: "12px 28px" }}>
                  Post Job →
                </button>
              </form>
            )}
          </section>
        )}

        {/* MESSAGES TAB */}
        {tab === "messages" && (
          <section aria-labelledby="messages-heading">
            <h1 id="messages-heading" style={{ fontSize: 28, fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#f59e0b", marginBottom: 16 }}>MESSAGES</h1>
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
                  <ChatHeader contractorId={activeChat} />
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
          </section>
        )}

        {/* REVIEWS TAB */}
        {tab === "reviews" && (
          <section aria-labelledby="reviews-heading">
            <h1 id="reviews-heading" style={{ fontSize: 28, fontFamily: "'Bebas Neue', cursive", letterSpacing: 2, color: "#f59e0b", marginBottom: 16 }}>REVIEWS</h1>
            <div style={{ display: "grid", gap: 20 }}>
              {CONTRACTORS.map(c => (
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
                  <span style={{ color: "#94a3b8", fontSize: 13 }}>{modal.rating} ({modal.reviews} reviews)</span>
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
                <div style={{ color: "#34d399", fontWeight: 700, fontSize: 22 }}>{modal.reviews}</div>
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
    </div>
  );
}
