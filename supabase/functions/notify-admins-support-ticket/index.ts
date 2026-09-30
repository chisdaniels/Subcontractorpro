// Supabase Edge Function: notify-admins-support-ticket
//
// Creates a support ticket and emails every admin. The ticket is inserted
// here with the service role — not by the browser — so logged-out visitors
// can reach support without any access to the tickets table. A signed-in
// caller's account id and email come from their token, never the payload.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  try {
    const payload = await req.json().catch(() => ({}));

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey     = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Logged-out callers send the anon key, which resolves to no user.
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user } } = await userClient.auth.getUser();

    const email   = String(user?.email || payload.email || "").trim().toLowerCase();
    const subject = String(payload.subject || "").trim().slice(0, 200);
    const message = String(payload.body || "").trim().slice(0, 5000);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Please enter a valid email so we can reply." }, 400);
    if (!subject || !message) return json({ error: "Subject and message are both required." }, 400);

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: ticket, error: tErr } = await admin
      .from("support_tickets")
      .insert({ user_id: user?.id ?? null, email, subject, body: message })
      .select()
      .single();
    if (tErr) return json({ error: tErr.message }, 500);

    // The ticket is saved from here on; an email hiccup shouldn't make the
    // visitor resubmit, so report it without failing the request.
    const emailed = await emailAdmins(admin, ticket);
    return json({ ticketId: ticket.id, emailed }, 200);
  } catch (err) {
    console.error("notify-admins-support-ticket error:", err);
    return json({ error: String(err) }, 500);
  }
});

async function emailAdmins(admin: ReturnType<typeof createClient>, ticket: any) {
  const { data: admins } = await admin.from("admins").select("email");
  const recipients = (admins || []).map((a: any) => a.email).filter(Boolean);
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from   = Deno.env.get("MAIL_FROM");
  const appUrl = Deno.env.get("APP_URL") || "";
  if (!recipients.length || !apiKey || !from) {
    console.error("support email skipped", { recipients: recipients.length, apiKey: !!apiKey, from: !!from });
    return false;
  }

  const subject = `[Support] ${ticket.subject}`;
  const html = `
<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;">
    <h2 style="color:#0f172a;margin:0 0 8px;">New support ticket</h2>
    <div style="background:#f1f5f9;border-radius:10px;padding:14px;margin:0 0 16px;">
      <div style="color:#64748b;font-size:12px;font-weight:700;letter-spacing:1px;">FROM</div>
      <div style="color:#0f172a;font-size:14px;">${escape(ticket.email)}${ticket.user_id ? "" : " (not signed in)"}</div>
    </div>
    <div style="background:#f1f5f9;border-radius:10px;padding:14px;margin:0 0 16px;">
      <div style="color:#64748b;font-size:12px;font-weight:700;letter-spacing:1px;">SUBJECT</div>
      <div style="color:#0f172a;font-size:16px;font-weight:600;">${escape(ticket.subject)}</div>
    </div>
    <div style="background:#f1f5f9;border-radius:10px;padding:14px;margin:0 0 16px;">
      <div style="color:#64748b;font-size:12px;font-weight:700;letter-spacing:1px;margin-bottom:6px;">MESSAGE</div>
      <div style="color:#0f172a;font-size:14px;white-space:pre-wrap;">${escape(ticket.body)}</div>
    </div>
    ${appUrl ? `<p><a href="${appUrl}" style="display:inline-block;background:#f59e0b;color:#0f172a;padding:12px 24px;text-decoration:none;border-radius:10px;font-weight:700;">Open Admin →</a></p>` : ""}
    <p style="color:#94a3b8;font-size:12px;margin-top:24px;">Reply directly to <a href="mailto:${escape(ticket.email)}">${escape(ticket.email)}</a> to answer the user.</p>
  </div>
</body></html>`.trim();

  const text = [
    `New Subcontractor Pros support ticket #${ticket.id}`,
    `From: ${ticket.email}${ticket.user_id ? "" : " (not signed in)"}`,
    `Subject: ${ticket.subject}`,
    "",
    ticket.body,
    "",
    appUrl ? `Admin console: ${appUrl}` : "",
  ].filter(Boolean).join("\n");

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: recipients, subject, html, text, reply_to: ticket.email }),
  });
  if (!res.ok) console.error("support email failed:", res.status, await res.text());
  return res.ok;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

function escape(s: string) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
