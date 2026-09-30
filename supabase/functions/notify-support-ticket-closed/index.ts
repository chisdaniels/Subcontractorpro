// Supabase Edge Function: notify-support-ticket-closed
//
// Called by the admin dashboard right after a support ticket is flipped
// to status "closed". Server-side verifies the caller is an admin, looks
// up the ticket by id, and emails the original submitter via Resend.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    console.log("notify-support-ticket-closed invoked");
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader) return json({ error: "missing auth" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey     = Deno.env.get("SUPABASE_ANON_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return json({ error: "unauthorized" }, 401);

    const admin = createClient(supabaseUrl, serviceKey);

    const { data: adminRow } = await admin
      .from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
    if (!adminRow) return json({ error: "not admin" }, 403);

    const { ticketId } = await req.json();
    if (!ticketId) return json({ error: "missing ticketId" }, 400);

    const { data: ticket, error: tErr } = await admin
      .from("support_tickets").select("*").eq("id", ticketId).maybeSingle();
    if (tErr) return json({ error: tErr.message }, 500);
    if (!ticket) return json({ error: "ticket not found" }, 404);
    if (!ticket.email) return json({ skipped: "no email on ticket" }, 200);

    const apiKey = Deno.env.get("RESEND_API_KEY");
    const from   = Deno.env.get("MAIL_FROM");
    const appUrl = Deno.env.get("APP_URL") || "";
    if (!apiKey || !from) return json({ error: "secrets missing" }, 500);

    const subject = `Subcontractor Pros — your support ticket is resolved`;

    const html = `
<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fa;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:12px;">
      <tr><td style="padding:24px 24px 12px;">
        <h1 style="color:#0f172a;font-size:22px;margin:0 0 8px;">Your support ticket is closed</h1>
        <p style="color:#475569;font-size:15px;line-height:1.55;margin:0 0 16px;">
          Our team has resolved the request you sent us. If it wasn't fully answered or something new comes up, just reply to this email and we'll reopen the thread.
        </p>
      </td></tr>
      <tr><td style="padding:0 24px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;border-radius:10px;">
          <tr><td style="padding:16px;">
            <div style="color:#64748b;font-size:12px;font-weight:700;letter-spacing:1px;margin-bottom:6px;">YOUR ORIGINAL REQUEST</div>
            <div style="color:#0f172a;font-weight:600;font-size:15px;">${escape(ticket.subject)}</div>
            <div style="color:#475569;font-size:14px;margin-top:8px;white-space:pre-wrap;">${escape(ticket.body)}</div>
          </td></tr>
        </table>
      </td></tr>
      ${appUrl ? `<tr><td style="padding:0 24px 24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#f59e0b;border-radius:10px;"><a href="${appUrl}" style="display:inline-block;padding:12px 24px;color:#0f172a;text-decoration:none;font-weight:700;">Open Subcontractor Pros</a></td></tr></table></td></tr>` : ""}
      <tr><td style="padding:0 24px 24px;color:#94a3b8;font-size:12px;">
        Reply directly to this email to reopen the ticket.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`.trim();

    const text = [
      `Your Subcontractor Pros support ticket has been marked resolved.`,
      "",
      `Subject: ${ticket.subject}`,
      "",
      `Your original message:`,
      ticket.body,
      "",
      `Reply to this email to reopen the ticket.`,
      appUrl ? `\nOpen Subcontractor Pros: ${appUrl}` : "",
    ].filter(Boolean).join("\n");

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [ticket.email], subject, html, text, reply_to: from }),
    });
    const body = await res.text();
    console.log("send status:", res.status, body);
    if (!res.ok) return json({ error: "resend failed", status: res.status, body }, 500);

    return json({ sent: true, to: ticket.email }, 200);
  } catch (err) {
    console.error("notify-support-ticket-closed error:", err);
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
