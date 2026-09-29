// Supabase Edge Function: notify-admin-contractor-pending
//
// Called by the app right after a contractor uploads or updates their
// license + insurance. It looks up that contractor row (server-side, from
// the caller's auth token so it can't be spoofed), checks whether they're
// awaiting verification, and emails every admin using the same SMTP that
// runs auth email.
//
// Deploy:
//   supabase functions deploy notify-admin-contractor-pending
//
// Required secrets (set from the Supabase dashboard OR via
// `supabase secrets set NAME=value`):
//   SMTP_HOST   e.g. smtp.office365.com
//   SMTP_PORT   587
//   SMTP_USER   e.g. support@subcontractorpros.com
//   SMTP_PASS   the SMTP password/app password
//   SMTP_FROM   optional; defaults to SMTP_USER
//   APP_URL     the URL of the deployed site (used in the CTA button)
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader) {
      return json({ error: "missing auth" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey     = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Identify the caller from their JWT.
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) {
      return json({ error: "unauthorized" }, 401);
    }

    // Server-side, look up THIS user's contractor row and the admin list.
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: contractor, error: cErr } = await admin
      .from("contractors")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();
    if (cErr) return json({ error: cErr.message }, 500);
    if (!contractor) return json({ skipped: "no contractor row" }, 200);
    if (contractor.verified) return json({ skipped: "already verified" }, 200);
    if (!contractor.license_url || !contractor.insurance_url) {
      return json({ skipped: "missing docs" }, 200);
    }

    const { data: admins, error: aErr } = await admin.from("admins").select("email");
    if (aErr) return json({ error: aErr.message }, 500);
    const recipients = (admins || []).map((a) => a.email).filter(Boolean);
    if (recipients.length === 0) {
      return json({ skipped: "no admins configured" }, 200);
    }

    const smtpHost = Deno.env.get("SMTP_HOST");
    const smtpUser = Deno.env.get("SMTP_USER");
    const smtpPass = Deno.env.get("SMTP_PASS");
    if (!smtpHost || !smtpUser || !smtpPass) {
      return json({ error: "SMTP env not configured" }, 500);
    }

    const smtp = new SMTPClient({
      connection: {
        hostname: smtpHost,
        port: Number(Deno.env.get("SMTP_PORT") || 587),
        tls: true,
        auth: { username: smtpUser, password: smtpPass },
      },
    });

    const appUrl = Deno.env.get("APP_URL") || "";
    const from   = Deno.env.get("SMTP_FROM") || smtpUser;
    const subject = `[TradeLinkPro] Verify: ${contractor.name}`;

    const html = `
<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;">
    <h2 style="color:#0f172a;margin:0 0 8px;">New contractor awaiting verification</h2>
    <p style="color:#475569;margin:0 0 16px;">
      <strong>${escape(contractor.name)}</strong> just uploaded their credentials and needs an admin to verify.
    </p>
    <table style="border-collapse:collapse;margin:0 0 16px;font-size:14px;color:#0f172a;">
      <tr><td style="padding:4px 12px 4px 0;color:#64748b;">Trade</td><td>${escape(contractor.trade)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#64748b;">Location</td><td>${escape(contractor.location)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#64748b;">License</td><td>${escape(contractor.license_type || "")} ${contractor.license_number ? "#" + escape(contractor.license_number) : ""}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#64748b;">Insurance</td><td>${escape(contractor.insurance_carrier || "")} (expires ${escape(contractor.insurance_expires_at || "")})</td></tr>
    </table>
    <p style="margin:0 0 20px;">
      <a href="${contractor.license_url}" style="color:#0369a1;margin-right:16px;">View license →</a>
      <a href="${contractor.insurance_url}" style="color:#0369a1;">View COI →</a>
    </p>
    ${appUrl ? `<p><a href="${appUrl}" style="display:inline-block;background:#f59e0b;color:#0f172a;padding:12px 24px;text-decoration:none;border-radius:10px;font-weight:700;">Open Admin Dashboard</a></p>` : ""}
    <p style="color:#94a3b8;font-size:12px;margin-top:24px;">You're receiving this because you're an admin on TradeLinkPro.</p>
  </div>
</body></html>`.trim();

    const textLines = [
      `${contractor.name} (${contractor.trade}) uploaded credentials and needs verification.`,
      "",
      `License:   ${contractor.license_type || ""} ${contractor.license_number ? "#" + contractor.license_number : ""}`,
      `License doc: ${contractor.license_url}`,
      `Insurance: ${contractor.insurance_carrier || ""}${contractor.insurance_expires_at ? ` (expires ${contractor.insurance_expires_at})` : ""}`,
      `COI:       ${contractor.insurance_url}`,
      "",
      appUrl ? `Open admin dashboard: ${appUrl}` : "",
    ].filter(Boolean).join("\n");

    await smtp.send({
      from,
      to: recipients,
      subject,
      content: textLines,
      html,
    });
    await smtp.close();

    return json({ sent: true, recipients: recipients.length }, 200);
  } catch (err) {
    console.error("notify-admin-contractor-pending error:", err);
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
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
