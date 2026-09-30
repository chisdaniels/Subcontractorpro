// Supabase Edge Function: notify-customer-job-accepted
//
// Called by the app right after a contractor accepts a job. Server-side,
// verifies the caller is the contractor who actually accepted it (so this
// can't be spoofed), then emails the job's poster via Resend.
//
// Uses the same secrets as the other notify- functions:
//   RESEND_API_KEY, MAIL_FROM, APP_URL

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    console.log("notify-customer-job-accepted invoked");
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
    console.log("caller:", user.id, user.email);

    const { jobId } = await req.json();
    if (!jobId) return json({ error: "missing jobId" }, 400);

    const admin = createClient(supabaseUrl, serviceKey);

    const { data: job, error: jErr } = await admin
      .from("jobs").select("*").eq("id", jobId).maybeSingle();
    if (jErr) return json({ error: jErr.message }, 500);
    if (!job) return json({ error: "job not found" }, 404);
    if (job.accepted_by !== user.id) return json({ error: "caller did not accept this job" }, 403);
    console.log("job:", job.title, "posted_by:", job.posted_by);

    const { data: contractor } = await admin
      .from("contractors").select("*").eq("user_id", user.id).maybeSingle();
    if (!contractor) return json({ error: "no contractor profile for caller" }, 400);
    const { data: creds } = await admin
      .from("contractor_credentials").select("*").eq("contractor_id", contractor.id).maybeSingle();
    const cc = creds || {};
    const { data: contact } = await admin
      .from("job_contacts").select("*").eq("job_id", job.id).maybeSingle();

    let posterEmail: string | null = null;
    if (job.posted_by) {
      const { data: authUser } = await admin.auth.admin.getUserById(job.posted_by);
      posterEmail = authUser?.user?.email ?? null;
    }
    const emailTo = posterEmail || contact?.homeowner_email;
    console.log("target recipient:", emailTo);
    if (!emailTo) return json({ skipped: "no email for job poster" }, 200);

    const apiKey = Deno.env.get("RESEND_API_KEY");
    const from   = Deno.env.get("MAIL_FROM");
    const appUrl = Deno.env.get("APP_URL") || "";
    if (!apiKey || !from) return json({ error: "secrets missing" }, 500);

    const subject = `${contractor.name} accepted your job "${job.title}"`;
    const contractorTrades = Array.isArray(contractor.trades) && contractor.trades.length > 0
      ? contractor.trades.join(", ") : (contractor.trade || "");
    const websiteHref = contractor.website
      ? (/^https?:\/\//i.test(contractor.website) ? contractor.website : "https://" + contractor.website)
      : "";

    // Build the trade-license rows. New contractors have per-trade licenses
    // in the trade_licenses JSONB map; older ones still have a single
    // license_path/type/number. Fall back to the legacy fields only when
    // nothing lives in trade_licenses.
    const tradeLicenseEntries = cc.trade_licenses && Object.keys(cc.trade_licenses).length > 0
      ? Object.entries(cc.trade_licenses).map(([trade, tl]: [string, any]) => ({
          trade,
          key:    `trade_license:${trade}`,
          type:   tl?.type   || "Trade License",
          number: tl?.number || "",
          path:   tl?.path   || "",
        }))
      : (cc.license_path ? [{
          trade:  contractor.trade || "",
          key:    "license",
          type:   cc.license_type   || "Trade License",
          number: cc.license_number || "",
          path:   cc.license_path,
        }] : []);
    const links = await signDocs(admin, [cc.business_license_path, cc.insurance_path, cc.bond_path, ...tradeLicenseEntries.map((e: any) => e.path)]);
    const tradeLicensesHtml = tradeLicenseEntries.map(e => `
      <tr><td style="padding:8px 0 2px;color:#0f172a;font-size:14px;border-top:1px solid #d1fae5;">
        <strong>${escape(e.type)}</strong>${e.trade ? ` <span style="color:#065f46;">· ${escape(e.trade)}</span>` : ""}${e.number ? " &middot; #" + escape(e.number) : ""}${statusHtml(cc, e.key, e.path)}
      </td></tr>
      ${links[e.path] ? `<tr><td style="padding:0 0 6px;"><a href="${links[e.path]}" style="color:#047857;font-size:14px;font-weight:600;">View ${escape(e.type)}</a></td></tr>` : ""}
    `).join("");
    const tradeLicensesText = tradeLicenseEntries.map(e =>
      `${e.type}${e.trade ? ` (${e.trade})` : ""}${e.number ? " #" + e.number : ""}${statusText(cc, e.key, e.path)}${links[e.path] ? "\n  Doc: " + links[e.path] : ""}`
    ).join("\n");

    // Table-based layout for maximum email-client compatibility (Yahoo,
    // Gmail, Outlook). Divs and modern CSS often get stripped or reflowed.
    const html = `
<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f6fa;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6fa;padding:24px 12px;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:12px;">
      <tr><td style="padding:24px 24px 12px;">
        <h1 style="color:#0f172a;font-size:22px;margin:0 0 8px;">Great news${contact?.homeowner_name ? `, ${escape(contact.homeowner_name)}` : ""}!</h1>
        <p style="color:#475569;font-size:15px;line-height:1.55;margin:0 0 16px;">
          <strong>${escape(contractor.name)}</strong> just accepted your job.
        </p>
      </td></tr>

      <!-- CREDENTIALS FIRST — most important for trust -->
      <tr><td style="padding:0 24px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ecfdf5;border:2px solid #10b981;border-radius:10px;">
          <tr><td style="padding:16px;">
            <div style="color:#065f46;font-weight:700;font-size:13px;letter-spacing:1px;margin-bottom:10px;">CREDENTIALS ON FILE</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${cc.business_license_path ? `
              <tr><td style="padding:4px 0;color:#0f172a;font-size:14px;">
                <strong>Business License</strong>${cc.business_license_number ? " &middot; #" + escape(cc.business_license_number) : ""}${statusHtml(cc, "business_license", cc.business_license_path)}
              </td></tr>
              ${links[cc.business_license_path] ? `<tr><td style="padding:0 0 6px;"><a href="${links[cc.business_license_path]}" style="color:#047857;font-size:14px;font-weight:600;">View business license</a></td></tr>` : ""}` : ""}
              ${tradeLicensesHtml}
              <tr><td style="padding:8px 0 2px;color:#0f172a;font-size:14px;border-top:1px solid #d1fae5;">
                <strong>Insurance</strong>${cc.insurance_carrier ? " &middot; " + escape(cc.insurance_carrier) : ""}${cc.insurance_expires_at ? " &middot; expires " + escape(cc.insurance_expires_at) : ""}${statusHtml(cc, "insurance", cc.insurance_path, cc.insurance_expires_at)}
              </td></tr>
              ${links[cc.insurance_path] ? `<tr><td style="padding:0 0 6px;"><a href="${links[cc.insurance_path]}" style="color:#047857;font-size:14px;font-weight:600;">View certificate of insurance</a></td></tr>` : ""}
              ${cc.bond_path ? `
              <tr><td style="padding:8px 0 2px;color:#0f172a;font-size:14px;border-top:1px solid #d1fae5;">
                <strong>Surety Bond</strong>${cc.bond_amount ? " &middot; $" + Number(cc.bond_amount).toLocaleString() : ""}${statusHtml(cc, "bond", cc.bond_path)}
              </td></tr>
              ${links[cc.bond_path] ? `<tr><td style="padding:0;"><a href="${links[cc.bond_path]}" style="color:#047857;font-size:14px;font-weight:600;">View bond certificate</a></td></tr>` : ""}` : ""}
            </table>
            <div style="color:#065f46;font-size:12px;margin-top:10px;">Document links expire in 7 days. You can open them anytime in Subcontractor Pros under Post a Job &rarr; Your Posted Jobs.</div>
          </td></tr>
        </table>
      </td></tr>

      <!-- JOB INFO -->
      <tr><td style="padding:0 24px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;border-radius:10px;">
          <tr><td style="padding:16px;">
            <div style="color:#64748b;font-size:12px;font-weight:700;letter-spacing:1px;margin-bottom:6px;">JOB</div>
            <div style="color:#0f172a;font-weight:700;font-size:16px;">${escape(job.title)}</div>
            <div style="color:#64748b;font-size:14px;margin-top:4px;">${escape(job.trade)} &middot; ${escape(job.location)}</div>
            ${job.budget != null ? `<div style="color:#b45309;font-weight:700;margin-top:4px;">Budget: $${Number(job.budget).toLocaleString()}</div>` : ""}
          </td></tr>
        </table>
      </td></tr>

      <!-- CONTRACTOR INFO -->
      <tr><td style="padding:0 24px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9;border-radius:10px;">
          <tr><td style="padding:16px;">
            <div style="color:#64748b;font-size:12px;font-weight:700;letter-spacing:1px;margin-bottom:6px;">CONTRACTOR</div>
            <div style="color:#0f172a;font-weight:600;font-size:15px;">${escape(contractor.name)}</div>
            <div style="color:#475569;font-size:14px;">${escape(contractorTrades)}${contractor.location ? " &middot; " + escape(contractor.location) : ""}</div>
            ${websiteHref ? `<div style="margin-top:6px;"><a href="${websiteHref}" style="color:#0369a1;font-size:14px;">${escape(contractor.website.replace(/^https?:\/\//i, ""))}</a></div>` : ""}
          </td></tr>
        </table>
      </td></tr>

      <tr><td style="padding:0 24px 24px;">
        <p style="color:#475569;font-size:14px;line-height:1.55;margin:0 0 16px;">
          They also sent you an intro message in your Subcontractor Pros inbox. Log in to reply and coordinate the work.
        </p>
        ${appUrl ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#f59e0b;border-radius:10px;"><a href="${appUrl}" style="display:inline-block;padding:12px 24px;color:#0f172a;text-decoration:none;font-weight:700;">Open Messages</a></td></tr></table>` : ""}
      </td></tr>

      <tr><td style="padding:0 24px 24px;color:#94a3b8;font-size:12px;">
        You're receiving this because a contractor accepted a job you posted on Subcontractor Pros.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`.trim();

    const text = [
      `${contractor.name} accepted your job: ${job.title}`,
      `Trade: ${job.trade}`,
      `Location: ${job.location}`,
      job.budget != null ? `Budget: $${Number(job.budget).toLocaleString()}` : "",
      "",
      `Contractor: ${contractor.name}`,
      `${contractorTrades} · ${contractor.location || ""}`,
      contractor.website ? `Website: ${contractor.website}` : "",
      "",
      "CREDENTIALS ON FILE",
      cc.business_license_path
        ? `Business License${cc.business_license_number ? " #" + cc.business_license_number : ""}${statusText(cc, "business_license", cc.business_license_path)}${links[cc.business_license_path] ? "\n  Doc: " + links[cc.business_license_path] : ""}`
        : "",
      tradeLicensesText,
      `Insurance${cc.insurance_carrier ? " · " + cc.insurance_carrier : ""}${cc.insurance_expires_at ? " (expires " + cc.insurance_expires_at + ")" : ""}${statusText(cc, "insurance", cc.insurance_path, cc.insurance_expires_at)}${links[cc.insurance_path] ? "\n  COI: " + links[cc.insurance_path] : ""}`,
      cc.bond_path
        ? `Surety Bond${cc.bond_amount ? " · $" + Number(cc.bond_amount).toLocaleString() : ""}${statusText(cc, "bond", cc.bond_path)}${links[cc.bond_path] ? "\n  Doc: " + links[cc.bond_path] : ""}`
        : "",
      "Document links expire in 7 days. You can open them anytime in Subcontractor Pros.",
      "",
      "They also sent you an intro message in the app. Log in to reply.",
      appUrl ? `Open Subcontractor Pros: ${appUrl}` : "",
    ].filter(Boolean).join("\n");

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [emailTo], subject, html, text }),
    });
    const body = await res.text();
    console.log("send status:", res.status, body);
    if (!res.ok) return json({ error: "resend failed", status: res.status, body }, 500);

    return json({ sent: true, to: emailTo }, 200);
  } catch (err) {
    console.error("notify-customer-job-accepted error:", err);
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

// A review only counts for the exact file that was reviewed (doc_path), and
// an expired credential never reads as verified.
function credStatus(c: any, key: string, docPath?: string | null, fallbackExpiry?: string | null) {
  if (!docPath) return "";
  const r = (c.credential_reviews || {})[key];
  if (!r || r.doc_path !== docPath || r.status === "pending") return "pending";
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
function statusHtml(c: any, key: string, docPath?: string | null, fallbackExpiry?: string | null) {
  return STATUS_HTML[credStatus(c, key, docPath, fallbackExpiry)] || "";
}
function statusText(c: any, key: string, docPath?: string | null, fallbackExpiry?: string | null) {
  return STATUS_TEXT[credStatus(c, key, docPath, fallbackExpiry)] || "";
}

const LINK_TTL_SECONDS = 60 * 60 * 24 * 7;

// Documents live in a private bucket; emails carry 7-day signed links.
async function signDocs(admin: any, paths: (string | null | undefined)[]) {
  const list = [...new Set(paths.filter(Boolean))] as string[];
  if (!list.length) return {} as Record<string, string>;
  const { data, error } = await admin.storage.from("credentials").createSignedUrls(list, LINK_TTL_SECONDS);
  if (error) console.error("signing document links failed:", error.message);
  return Object.fromEntries((data || []).filter((d: any) => d.signedUrl).map((d: any) => [d.path, d.signedUrl])) as Record<string, string>;
}
