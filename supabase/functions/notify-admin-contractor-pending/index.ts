// Supabase Edge Function: notify-admin-contractor-pending
//
// Called by the app right after a contractor uploads or updates their
// license + insurance. It looks up that contractor row (server-side, from
// the caller's auth token so it can't be spoofed), checks whether they're
// awaiting verification, and emails every admin via Resend.
//
// Deploy: via the Supabase dashboard (Edge Functions → Deploy new) or CLI:
//   supabase functions deploy notify-admin-contractor-pending
//
// Required secrets (set from the Supabase dashboard OR via
// `supabase secrets set NAME=value`):
//   RESEND_API_KEY   from https://resend.com/api-keys
//   MAIL_FROM        e.g. "TradeLinkPro <notifications@subcontractorpros.com>"
//                    (must be from a verified Resend domain, or use
//                    "onboarding@resend.dev" while testing)
//   APP_URL          the deployed site URL (used in the CTA button)
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.

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
    if (!authHeader) return json({ error: "missing auth" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey     = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Identify the caller from their JWT.
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return json({ error: "unauthorized" }, 401);

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

    const apiKey = Deno.env.get("RESEND_API_KEY");
    const from   = Deno.env.get("MAIL_FROM");
    if (!apiKey || !from) {
      return json({ error: "RESEND_API_KEY and MAIL_FROM must be set" }, 500);
    }

    const appUrl  = Deno.env.get("APP_URL") || "";
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

    const text = [
      `${contractor.name} (${contractor.trade}) uploaded credentials and needs verification.`,
      "",
      `License:     ${contractor.license_type || ""} ${contractor.license_number ? "#" + contractor.license_number : ""}`,
      `License doc: ${contractor.license_url}`,
      `Insurance:   ${contractor.insurance_carrier || ""}${contractor.insurance_expires_at ? ` (expires ${contractor.insurance_expires_at})` : ""}`,
      `COI:         ${contractor.insurance_url}`,
      "",
      appUrl ? `Open admin dashboard: ${appUrl}` : "",
    ].filter(Boolean).join("\n");

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: recipients,
        subject,
        html,
        text,
      }),
    });

    const body = await res.text();
    if (!res.ok) {
      console.error("resend send failed:", res.status, body);
      return json({ error: "resend failed", status: res.status, body }, 500);
    }

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
