// Supabase Edge Function: notify-contractor-denied
//
// Called by the admin dashboard right after a contractor's application
// is denied. Server-side admin check, then emails the contractor the
// denial reason and a link to their profile so they can fix + reapply.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    console.log("notify-contractor-denied invoked");
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

    const { contractorId } = await req.json();
    if (!contractorId) return json({ error: "missing contractorId" }, 400);

    const { data: contractor, error: cErr } = await admin
      .from("contractors").select("*").eq("id", contractorId).maybeSingle();
    if (cErr) return json({ error: cErr.message }, 500);
    if (!contractor) return json({ error: "contractor not found" }, 404);

    let email: string | null = null;
    if (contractor.user_id) {
      const { data: authUser } = await admin.auth.admin.getUserById(contractor.user_id);
      email = authUser?.user?.email ?? null;
    }
    if (!email) return json({ skipped: "no email on file" }, 200);

    const apiKey = Deno.env.get("RESEND_API_KEY");
    const from   = Deno.env.get("MAIL_FROM");
    const appUrl = Deno.env.get("APP_URL") || "";
    if (!apiKey || !from) return json({ error: "secrets missing" }, 500);

    const { data: denial } = await admin
      .from("contractor_denials").select("reason").eq("contractor_id", contractor.id).maybeSingle();
    const subject = `Subcontractor Pros — your application needs attention`;
    const reasonHtml = escape(denial?.reason || "(no reason recorded)");
    const reasonText = denial?.reason || "(no reason recorded)";

    const html = `
<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fa;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:12px;">
      <tr><td style="padding:24px;">
        <h1 style="color:#0f172a;font-size:22px;margin:0 0 8px;">Hi ${escape(contractor.name)},</h1>
        <p style="color:#475569;font-size:15px;line-height:1.55;margin:0 0 16px;">
          Our team reviewed your contractor application and it needs a correction before we can verify you. Once you make the change and save your profile, we'll review again automatically — usually within a business day.
        </p>
      </td></tr>
      <tr><td style="padding:0 24px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fef2f2;border:2px solid #dc2626;border-radius:10px;">
          <tr><td style="padding:16px;">
            <div style="color:#7f1d1d;font-weight:700;font-size:13px;letter-spacing:1px;margin-bottom:10px;">REASON</div>
            <div style="color:#0f172a;font-size:14px;line-height:1.6;white-space:pre-wrap;">${reasonHtml}</div>
          </td></tr>
        </table>
      </td></tr>
      ${appUrl ? `<tr><td style="padding:0 24px 24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#f59e0b;border-radius:10px;"><a href="${appUrl}" style="display:inline-block;padding:12px 24px;color:#0f172a;text-decoration:none;font-weight:700;">Update &amp; reapply</a></td></tr></table></td></tr>` : ""}
      <tr><td style="padding:0 24px 24px;color:#94a3b8;font-size:12px;">
        Reply to this email if you have questions.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`.trim();

    const text = [
      `Hi ${contractor.name},`,
      "",
      "Your contractor application needs a correction before we can verify you.",
      "",
      "REASON:",
      reasonText,
      "",
      "Log in, update your profile, and save — we'll review again automatically.",
      appUrl ? `\nUpdate & reapply: ${appUrl}` : "",
    ].filter(Boolean).join("\n");

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [email], subject, html, text }),
    });
    const body = await res.text();
    console.log("send status:", res.status, body);
    if (!res.ok) return json({ error: "resend failed", status: res.status, body }, 500);

    return json({ sent: true, to: email }, 200);
  } catch (err) {
    console.error("notify-contractor-denied error:", err);
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
