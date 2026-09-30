// Supabase Edge Function: notify-admins-support-ticket
//
// Emails every admin when a new support ticket lands. Called by the app
// right after the ticket row is inserted. Server-side, looks up the just-
// inserted ticket by id so the payload can't be spoofed.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  try {
    console.log("notify-admins-support-ticket invoked");
    const { ticketId } = await req.json();
    if (!ticketId) return json({ error: "missing ticketId" }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: ticket, error: tErr } = await admin
      .from("support_tickets").select("*").eq("id", ticketId).maybeSingle();
    if (tErr) return json({ error: tErr.message }, 500);
    if (!ticket) return json({ error: "ticket not found" }, 404);

    const { data: admins } = await admin.from("admins").select("email");
    const recipients = (admins || []).map(a => a.email).filter(Boolean);
    if (recipients.length === 0) return json({ skipped: "no admins" }, 200);

    const apiKey = Deno.env.get("RESEND_API_KEY");
    const from   = Deno.env.get("MAIL_FROM");
    const appUrl = Deno.env.get("APP_URL") || "";
    if (!apiKey || !from) return json({ error: "secrets missing" }, 500);

    const subject = `[Support] ${ticket.subject}`;
    const html = `
<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;">
    <h2 style="color:#0f172a;margin:0 0 8px;">New support ticket</h2>
    <div style="background:#f1f5f9;border-radius:10px;padding:14px;margin:0 0 16px;">
      <div style="color:#64748b;font-size:12px;font-weight:700;letter-spacing:1px;">FROM</div>
      <div style="color:#0f172a;font-size:14px;">${escape(ticket.email)}</div>
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
      `From: ${ticket.email}`,
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
    const body = await res.text();
    console.log("send status:", res.status, body);
    if (!res.ok) return json({ error: "resend failed", status: res.status, body }, 500);

    return json({ sent: true, recipients: recipients.length }, 200);
  } catch (err) {
    console.error("notify-admins-support-ticket error:", err);
    return json({ error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

function escape(s: string) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
