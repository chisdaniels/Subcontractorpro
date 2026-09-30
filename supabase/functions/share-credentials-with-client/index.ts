// Supabase Edge Function: share-credentials-with-client
//
// A verified contractor can send their license + insurance information
// to a prospective client's email address with one click. Server-side
// pulls the contractor's row from their JWT (so credentials can't be
// spoofed) and emails a formatted summary + document links via Resend.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    console.log("share-credentials-with-client invoked");
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
    const { data: contractor, error: cErr } = await admin
      .from("contractors").select("*").eq("user_id", user.id).maybeSingle();
    if (cErr) return json({ error: cErr.message }, 500);
    if (!contractor) return json({ error: "no contractor profile" }, 404);
    if (contractor.deactivated_at) return json({ error: "profile inactive" }, 403);
    if (!contractor.verified) return json({ error: "not verified — get verified before sharing credentials" }, 403);
    if (!contractor.license_url || !contractor.insurance_url) {
      return json({ error: "credentials incomplete" }, 400);
    }

    const { clientEmail: rawEmail, clientName, message } = await req.json();
    const clientEmail = (rawEmail || "").trim().toLowerCase();
    if (!clientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
      return json({ error: "invalid clientEmail" }, 400);
    }

    const apiKey = Deno.env.get("RESEND_API_KEY");
    const from   = Deno.env.get("MAIL_FROM");
    const appUrl = Deno.env.get("APP_URL") || "";
    if (!apiKey || !from) return json({ error: "secrets missing" }, 500);

    const contractorTrades = Array.isArray(contractor.trades) && contractor.trades.length > 0
      ? contractor.trades.join(", ") : (contractor.trade || "");
    const websiteHref = contractor.website
      ? (/^https?:\/\//i.test(contractor.website) ? contractor.website : "https://" + contractor.website)
      : "";
    const senderEmail = user.email || "";
    const senderName  = contractor.name;

    const subject = `${senderName} — License &amp; insurance for your review`;

    const html = `
<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fa;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:12px;">
      <tr><td style="padding:24px 24px 12px;">
        <h1 style="color:#0f172a;font-size:22px;margin:0 0 8px;">${escape(senderName)}'s credentials${clientName ? `, for ${escape(clientName)}` : ""}</h1>
        <p style="color:#475569;font-size:15px;line-height:1.55;margin:0 0 16px;">
          ${escape(senderName)} shared their verified license and certificate of insurance with you through TradeLinkPro.
        </p>
        ${message ? `<p style="color:#0f172a;background:#f1f5f9;padding:12px 14px;border-radius:8px;font-size:14px;line-height:1.55;margin:0 0 16px;white-space:pre-wrap;">${escape(message)}</p>` : ""}
      </td></tr>

      <tr><td style="padding:0 24px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ecfdf5;border:2px solid #10b981;border-radius:10px;">
          <tr><td style="padding:16px;">
            <div style="color:#065f46;font-weight:700;font-size:13px;letter-spacing:1px;margin-bottom:10px;">VERIFIED LICENSE &amp; INSURANCE</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="padding:4px 0;color:#0f172a;font-size:14px;">
                <strong>${escape(contractor.license_type || "License")}</strong>${contractor.license_number ? " &middot; #" + escape(contractor.license_number) : ""}
              </td></tr>
              <tr><td style="padding:0 0 8px;"><a href="${contractor.license_url}" style="color:#047857;font-size:14px;font-weight:600;">View license document</a></td></tr>
              <tr><td style="padding:4px 0;color:#0f172a;font-size:14px;">
                <strong>Insurance</strong>${contractor.insurance_carrier ? " &middot; " + escape(contractor.insurance_carrier) : ""}${contractor.insurance_expires_at ? " &middot; expires " + escape(contractor.insurance_expires_at) : ""}
              </td></tr>
              <tr><td style="padding:0;"><a href="${contractor.insurance_url}" style="color:#047857;font-size:14px;font-weight:600;">View certificate of insurance</a></td></tr>
            </table>
          </td></tr>
        </table>
      </td></tr>

      <tr><td style="padding:0 24px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;border-radius:10px;">
          <tr><td style="padding:16px;">
            <div style="color:#64748b;font-size:12px;font-weight:700;letter-spacing:1px;margin-bottom:6px;">ABOUT ${escape(senderName.toUpperCase())}</div>
            <div style="color:#475569;font-size:14px;">${escape(contractorTrades)}${contractor.location ? " &middot; " + escape(contractor.location) : ""}</div>
            ${contractor.hourly != null ? `<div style="color:#b45309;font-weight:700;font-size:14px;margin-top:4px;">$${contractor.hourly}/hr</div>` : ""}
            ${websiteHref ? `<div style="margin-top:6px;"><a href="${websiteHref}" style="color:#0369a1;font-size:14px;">${escape(contractor.website.replace(/^https?:\/\//i, ""))}</a></div>` : ""}
          </td></tr>
        </table>
      </td></tr>

      ${appUrl ? `<tr><td style="padding:0 24px 24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#f59e0b;border-radius:10px;"><a href="${appUrl}" style="display:inline-block;padding:12px 24px;color:#0f172a;text-decoration:none;font-weight:700;">Message ${escape(senderName)} on TradeLinkPro</a></td></tr></table></td></tr>` : ""}

      <tr><td style="padding:0 24px 24px;color:#94a3b8;font-size:12px;">
        You're receiving this because ${escape(senderName)} chose to share their credentials with you. Reply directly to reach them at ${escape(senderEmail)}.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`.trim();

    const text = [
      `${senderName} shared their license and insurance with you.`,
      "",
      message ? `Their note: ${message}` : "",
      message ? "" : "",
      "VERIFIED LICENSE & INSURANCE",
      `${contractor.license_type || "License"}${contractor.license_number ? " #" + contractor.license_number : ""}`,
      `License doc: ${contractor.license_url}`,
      `Insurance${contractor.insurance_carrier ? " · " + contractor.insurance_carrier : ""}${contractor.insurance_expires_at ? " (expires " + contractor.insurance_expires_at + ")" : ""}`,
      `COI: ${contractor.insurance_url}`,
      "",
      `About ${senderName}: ${contractorTrades}${contractor.location ? " · " + contractor.location : ""}`,
      contractor.hourly != null ? `$${contractor.hourly}/hr` : "",
      websiteHref ? websiteHref : "",
      "",
      `Reply directly to reach them at ${senderEmail}.`,
      appUrl ? `\nMessage on TradeLinkPro: ${appUrl}` : "",
    ].filter(Boolean).join("\n");

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [clientEmail],
        subject: subject.replace(/&amp;/g, "&"),
        html,
        text,
        reply_to: senderEmail || from,
      }),
    });
    const body = await res.text();
    console.log("send status:", res.status, body);
    if (!res.ok) return json({ error: "resend failed", status: res.status, body }, 500);

    return json({ sent: true, to: clientEmail }, 200);
  } catch (err) {
    console.error("share-credentials-with-client error:", err);
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
