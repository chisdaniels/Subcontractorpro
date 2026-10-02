// Supabase Edge Function: notify-user-admin-message
//
// Called by the app right after an admin sends a message. Server-side admin
// check, then emails the recipient the team's latest message to them, with a
// link to reply in the app. The message text is read from the database, never
// taken from the request, so this can't be used to send arbitrary email.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
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
    const { data: adminRow } = await admin.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
    if (!adminRow) return json({ error: "not admin" }, 403);

    const { recipientId } = await req.json().catch(() => ({}));
    if (!recipientId) return json({ error: "missing recipientId" }, 400);

    const { data: recent, error: mErr } = await admin
      .from("messages")
      .select("text, created_at")
      .eq("recipient_id", recipientId)
      .eq("from_admin", true)
      .order("created_at", { ascending: false })
      .limit(2);
    if (mErr) return json({ error: mErr.message }, 500);
    const msg = recent?.[0];
    if (!msg) return json({ error: "no admin message to this user" }, 404);
    // One email per burst: a follow-up within 15 minutes of the team's last
    // message (from any admin) rides on the email that one already sent.
    const prev = recent?.[1];
    if (prev && new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime() < 15 * 60 * 1000) {
      return json({ skipped: "recently notified" }, 200);
    }

    const { data: authUser } = await admin.auth.admin.getUserById(recipientId);
    const email = authUser?.user?.email ?? null;
    if (!email) return json({ skipped: "no email on file" }, 200);

    const apiKey = Deno.env.get("RESEND_API_KEY");
    const from   = Deno.env.get("MAIL_FROM");
    const appUrl = (Deno.env.get("APP_URL") || "").replace(/\/+$/, "");
    if (!apiKey || !from) return json({ error: "secrets missing" }, 500);

    const subject = "Subcontractor Pros — you have a new message from our team";
    const replyUrl = appUrl ? `${appUrl}/messages` : "";

    const html = `
<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fa;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:12px;">
      <tr><td style="padding:24px;">
        <h1 style="color:#0f172a;font-size:22px;margin:0 0 8px;">You have a new message</h1>
        <p style="color:#475569;font-size:15px;line-height:1.55;margin:0 0 16px;">
          The Subcontractor Pros team sent you a message:
        </p>
      </td></tr>
      <tr><td style="padding:0 24px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fffbeb;border:2px solid #f59e0b;border-radius:10px;">
          <tr><td style="padding:16px;">
            <div style="color:#0f172a;font-size:14px;line-height:1.6;white-space:pre-wrap;">${escape(msg.text)}</div>
          </td></tr>
        </table>
      </td></tr>
      ${replyUrl ? `<tr><td style="padding:0 24px 24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#f59e0b;border-radius:10px;"><a href="${replyUrl}" style="display:inline-block;padding:12px 24px;color:#0f172a;text-decoration:none;font-weight:700;">Reply in the app</a></td></tr></table></td></tr>` : ""}
      <tr><td style="padding:0 24px 24px;color:#94a3b8;font-size:12px;">
        Sign in and open Messages to reply.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`.trim();

    const text = [
      "You have a new message from the Subcontractor Pros team:",
      "",
      msg.text,
      "",
      replyUrl ? `Reply in the app: ${replyUrl}` : "Sign in and open Messages to reply.",
    ].join("\n");

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [email], subject, html, text }),
    });
    const body = await res.text();
    if (!res.ok) return json({ error: "resend failed", status: res.status, body }, 500);

    return json({ sent: true }, 200);
  } catch (err) {
    console.error("notify-user-admin-message error:", err);
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
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
