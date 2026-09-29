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

    const html = `
<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;">
    <h2 style="color:#0f172a;margin:0 0 8px;">Great news${job.homeowner_name ? `, ${escape(job.homeowner_name)}` : ""}!</h2>
    <p style="color:#475569;line-height:1.55;">
      <strong>${escape(contractor.name)}</strong> just accepted your job:
    </p>
    <div style="background:#f1f5f9;border-radius:10px;padding:14px;margin:0 0 16px;">
      <div style="font-weight:700;color:#0f172a;">${escape(job.title)}</div>
      <div style="color:#64748b;font-size:14px;margin-top:4px;">${escape(job.trade)} · ${escape(job.location)}</div>
      ${job.budget != null ? `<div style="color:#f59e0b;font-weight:700;margin-top:4px;">$${Number(job.budget).toLocaleString()}</div>` : ""}
    </div>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px;margin:0 0 16px;">
      <div style="font-size:12px;color:#64748b;font-weight:700;letter-spacing:1px;margin-bottom:6px;">CONTRACTOR</div>
      <div style="font-weight:600;color:#0f172a;">${escape(contractor.name)}</div>
      <div style="color:#475569;font-size:14px;">${escape(contractorTrades)} · ${escape(contractor.location || "")}</div>
      ${contractor.website ? `<div style="margin-top:4px;"><a href="${/^https?:\/\//i.test(contractor.website) ? contractor.website : "https://" + contractor.website}" style="color:#0369a1;">${escape(contractor.website.replace(/^https?:\/\//i, ""))}</a></div>` : ""}
    </div>
    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:14px;margin:0 0 16px;">
      <div style="font-size:12px;color:#166534;font-weight:700;letter-spacing:1px;margin-bottom:6px;">✓ VERIFIED CREDENTIALS</div>
      <div style="color:#0f172a;font-size:14px;line-height:1.7;">
        <div><strong>${escape(contractor.license_type || "License")}</strong>${contractor.license_number ? " · #" + escape(contractor.license_number) : ""}${contractor.license_url ? ` · <a href="${contractor.license_url}" style="color:#166534;">view license</a>` : ""}</div>
        <div><strong>Insurance</strong>${contractor.insurance_carrier ? " · " + escape(contractor.insurance_carrier) : ""}${contractor.insurance_expires_at ? " · expires " + escape(contractor.insurance_expires_at) : ""}${contractor.insurance_url ? ` · <a href="${contractor.insurance_url}" style="color:#166534;">view COI</a>` : ""}</div>
      </div>
    </div>
    <p style="color:#475569;line-height:1.55;">
      They also sent you an intro message in your TradeLinkPro inbox. Log in to reply and coordinate the work.
    </p>
    ${appUrl ? `<p><a href="${appUrl}" style="display:inline-block;background:#f59e0b;color:#0f172a;padding:12px 24px;text-decoration:none;border-radius:10px;font-weight:700;">Open Messages →</a></p>` : ""}
  </div>
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
      appUrl ? `Open TradeLinkPro: ${appUrl}` : "",
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
