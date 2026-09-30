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

    let posterEmail: string | null = null;
    if (job.posted_by) {
      const { data: authUser } = await admin.auth.admin.getUserById(job.posted_by);
      posterEmail = authUser?.user?.email ?? null;
    }
    const emailTo = posterEmail || job.homeowner_email;
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
        <h1 style="color:#0f172a;font-size:22px;margin:0 0 8px;">Great news${job.homeowner_name ? `, ${escape(job.homeowner_name)}` : ""}!</h1>
        <p style="color:#475569;font-size:15px;line-height:1.55;margin:0 0 16px;">
          <strong>${escape(contractor.name)}</strong> just accepted your job.
        </p>
      </td></tr>

      <!-- CREDENTIALS FIRST — most important for trust -->
      <tr><td style="padding:0 24px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ecfdf5;border:2px solid #10b981;border-radius:10px;">
          <tr><td style="padding:16px;">
            <div style="color:#065f46;font-weight:700;font-size:13px;letter-spacing:1px;margin-bottom:10px;">VERIFIED LICENSE &amp; INSURANCE</div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="padding:4px 0;color:#0f172a;font-size:14px;">
                <strong>${escape(contractor.license_type || "License")}</strong>${contractor.license_number ? " &middot; #" + escape(contractor.license_number) : ""}
              </td></tr>
              ${contractor.license_url ? `<tr><td style="padding:0 0 8px;"><a href="${contractor.license_url}" style="color:#047857;font-size:14px;font-weight:600;">View license document</a></td></tr>` : ""}
              <tr><td style="padding:4px 0;color:#0f172a;font-size:14px;">
                <strong>Insurance</strong>${contractor.insurance_carrier ? " &middot; " + escape(contractor.insurance_carrier) : ""}${contractor.insurance_expires_at ? " &middot; expires " + escape(contractor.insurance_expires_at) : ""}
              </td></tr>
              ${contractor.insurance_url ? `<tr><td style="padding:0;"><a href="${contractor.insurance_url}" style="color:#047857;font-size:14px;font-weight:600;">View certificate of insurance</a></td></tr>` : ""}
            </table>
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
      "VERIFIED CREDENTIALS",
      `${contractor.license_type || "License"}${contractor.license_number ? " #" + contractor.license_number : ""}${contractor.license_url ? "\n  License doc: " + contractor.license_url : ""}`,
      `Insurance${contractor.insurance_carrier ? " · " + contractor.insurance_carrier : ""}${contractor.insurance_expires_at ? " (expires " + contractor.insurance_expires_at + ")" : ""}${contractor.insurance_url ? "\n  COI: " + contractor.insurance_url : ""}`,
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
