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
    // Contractor is considered "sharable" if at minimum they have insurance
    // on file plus SOMETHING for a license (business, per-trade, or legacy).
    const hasAnyLicense = !!(
      contractor.business_license_url ||
      contractor.license_url ||
      (contractor.trade_licenses && Object.keys(contractor.trade_licenses).length > 0)
    );
    if (!hasAnyLicense || !contractor.insurance_url) {
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

    const tradeLicenseEntries = contractor.trade_licenses && Object.keys(contractor.trade_licenses).length > 0
      ? Object.entries(contractor.trade_licenses).map(([trade, tl]: [string, any]) => ({
          trade,
          key:    `trade_license:${trade}`,
          type:   tl?.type   || "Trade License",
          number: tl?.number || "",
          url:    tl?.url    || "",
        }))
      : (contractor.license_url ? [{
          trade:  contractor.trade || "",
          key:    "license",
          type:   contractor.license_type   || "Trade License",
          number: contractor.license_number || "",
          url:    contractor.license_url,
        }] : []);
    const tradeLicensesHtml = tradeLicenseEntries.map((e: any) => `
      <tr><td style="padding:8px 0 2px;color:#0f172a;font-size:14px;border-top:1px solid #d1fae5;">
        <strong>${escape(e.type)}</strong>${e.trade ? ` <span style="color:#065f46;">· ${escape(e.trade)}</span>` : ""}${e.number ? " &middot; #" + escape(e.number) : ""}${statusHtml(contractor, e.key, e.url)}
      </td></tr>
      ${e.url ? `<tr><td style="padding:0 0 6px;"><a href="${e.url}" style="color:#047857;font-size:14px;font-weight:600;">View ${escape(e.type)}</a></td></tr>` : ""}
    `).join("");
    const tradeLicensesText = tradeLicenseEntries.map((e: any) =>
      `${e.type}${e.trade ? ` (${e.trade})` : ""}${e.number ? " #" + e.number : ""}${statusText(contractor, e.key, e.url)}${e.url ? "\n  Doc: " + e.url : ""}`
    ).join("\n");

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
          ${escape(senderName)} shared their license and insurance documents with you through Subcontractor Pros. Each document shows whether our team has reviewed it.
        </p>
        ${message ? `<p style="color:#0f172a;background:#f1f5f9;padding:12px 14px;border-radius:8px;font-size:14px;line-height:1.55;margin:0 0 16px;white-space:pre-wrap;">${escape(message)}</p>` : ""}
      </td></tr>

      <tr><td style="padding:0 24px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ecfdf5;border:2px solid #10b981;border-radius:10px;">
          <tr><td style="padding:16px;">
            <div style="color:#065f46;font-weight:700;font-size:13px;letter-spacing:1px;margin-bottom:10px;">CREDENTIALS ON FILE</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${contractor.business_license_url ? `
              <tr><td style="padding:4px 0;color:#0f172a;font-size:14px;">
                <strong>Business License</strong>${contractor.business_license_number ? " &middot; #" + escape(contractor.business_license_number) : ""}${statusHtml(contractor, "business_license", contractor.business_license_url)}
              </td></tr>
              <tr><td style="padding:0 0 6px;"><a href="${contractor.business_license_url}" style="color:#047857;font-size:14px;font-weight:600;">View business license</a></td></tr>` : ""}
              ${tradeLicensesHtml}
              <tr><td style="padding:8px 0 2px;color:#0f172a;font-size:14px;border-top:1px solid #d1fae5;">
                <strong>Insurance</strong>${contractor.insurance_carrier ? " &middot; " + escape(contractor.insurance_carrier) : ""}${contractor.insurance_expires_at ? " &middot; expires " + escape(contractor.insurance_expires_at) : ""}${statusHtml(contractor, "insurance", contractor.insurance_url, contractor.insurance_expires_at)}
              </td></tr>
              <tr><td style="padding:0 0 6px;"><a href="${contractor.insurance_url}" style="color:#047857;font-size:14px;font-weight:600;">View certificate of insurance</a></td></tr>
              ${contractor.bond_url ? `
              <tr><td style="padding:8px 0 2px;color:#0f172a;font-size:14px;border-top:1px solid #d1fae5;">
                <strong>Surety Bond</strong>${contractor.bond_amount ? " &middot; $" + Number(contractor.bond_amount).toLocaleString() : ""}${statusHtml(contractor, "bond", contractor.bond_url)}
              </td></tr>
              <tr><td style="padding:0;"><a href="${contractor.bond_url}" style="color:#047857;font-size:14px;font-weight:600;">View bond certificate</a></td></tr>` : ""}
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

      ${appUrl ? `<tr><td style="padding:0 24px 20px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#f59e0b;border-radius:10px;"><a href="${appUrl}" style="display:inline-block;padding:12px 24px;color:#0f172a;text-decoration:none;font-weight:700;">Message ${escape(senderName)} on Subcontractor Pros</a></td></tr></table></td></tr>` : ""}

      <tr><td style="padding:0 24px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#0f172a;border-radius:10px;">
          <tr><td style="padding:18px;">
            <div style="color:#f59e0b;font-size:12px;font-weight:700;letter-spacing:1px;margin-bottom:8px;">NEW TO SUBCONTRACTOR PROS?</div>
            <div style="color:#e2e8f0;font-size:14px;line-height:1.6;margin-bottom:12px;">
              Subcontractor Pros is a free platform where homeowners and businesses post jobs and get matched with <strong style="color:#ffffff;">verified, licensed, and insured contractors</strong> like ${escape(senderName)}. Every pro on the board has their license &amp; insurance vetted by our admin team before they can accept a single job.
            </div>
            ${appUrl ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#ffffff;border-radius:8px;"><a href="${appUrl}" style="display:inline-block;padding:10px 18px;color:#0f172a;text-decoration:none;font-weight:700;font-size:14px;">Post a Job Free</a></td></tr></table>` : ""}
          </td></tr>
        </table>
      </td></tr>

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
      "CREDENTIALS ON FILE",
      contractor.business_license_url
        ? `Business License${contractor.business_license_number ? " #" + contractor.business_license_number : ""}${statusText(contractor, "business_license", contractor.business_license_url)}\n  Doc: ${contractor.business_license_url}`
        : "",
      tradeLicensesText,
      `Insurance${contractor.insurance_carrier ? " · " + contractor.insurance_carrier : ""}${contractor.insurance_expires_at ? " (expires " + contractor.insurance_expires_at + ")" : ""}${statusText(contractor, "insurance", contractor.insurance_url, contractor.insurance_expires_at)}\n  COI: ${contractor.insurance_url}`,
      contractor.bond_url
        ? `Surety Bond${contractor.bond_amount ? " · $" + Number(contractor.bond_amount).toLocaleString() : ""}${statusText(contractor, "bond", contractor.bond_url)}\n  Doc: ${contractor.bond_url}`
        : "",
      "",
      `About ${senderName}: ${contractorTrades}${contractor.location ? " · " + contractor.location : ""}`,
      contractor.hourly != null ? `$${contractor.hourly}/hr` : "",
      websiteHref ? websiteHref : "",
      "",
      `Reply directly to reach them at ${senderEmail}.`,
      appUrl ? `\nMessage on Subcontractor Pros: ${appUrl}` : "",
      "",
      "── NEW TO SUBCONTRACTOR PROS? ──",
      `Subcontractor Pros is a free platform where you can post jobs and get matched with verified, licensed, and insured contractors like ${senderName}. Every pro is vetted by our admin team before they can accept work.`,
      appUrl ? `Post a job free: ${appUrl}` : "",
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

// A review only counts for the exact file that was reviewed (doc_url), and
// an expired credential never reads as verified.
function credStatus(c: any, key: string, docUrl?: string | null, fallbackExpiry?: string | null) {
  if (!docUrl) return "";
  const r = (c.credential_reviews || {})[key];
  if (!r || r.doc_url !== docUrl || r.status === "pending") return "pending";
  if (r.status === "rejected") return "rejected";
  const exp = r.expires_on || fallbackExpiry;
  if (r.status === "verified") return exp && exp < new Date().toISOString().slice(0, 10) ? "expired" : "verified";
  return "pending";
}
const STATUS_HTML: Record<string, string> = {
  verified: ' <span style="color:#047857;font-weight:700;">&middot; &#10003; Verified by Subcontractor Pros</span>',
  pending:  ' <span style="color:#b45309;">&middot; Not yet reviewed</span>',
  expired:  ' <span style="color:#b91c1c;font-weight:700;">&middot; Expired</span>',
  rejected: ' <span style="color:#b91c1c;font-weight:700;">&middot; Did not pass review</span>',
};
const STATUS_TEXT: Record<string, string> = {
  verified: " [Verified by Subcontractor Pros]", pending: " [Not yet reviewed]", expired: " [Expired]", rejected: " [Did not pass review]",
};
function statusHtml(c: any, key: string, docUrl?: string | null, fallbackExpiry?: string | null) {
  return STATUS_HTML[credStatus(c, key, docUrl, fallbackExpiry)] || "";
}
function statusText(c: any, key: string, docUrl?: string | null, fallbackExpiry?: string | null) {
  return STATUS_TEXT[credStatus(c, key, docUrl, fallbackExpiry)] || "";
}
