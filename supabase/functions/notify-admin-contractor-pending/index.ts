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
//   MAIL_FROM        e.g. "Subcontractor Pros <notifications@subcontractorpros.com>"
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
    console.log("notify-admin-contractor-pending invoked");
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader) {
      console.log("skip: missing auth header");
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
      console.log("skip: unauthorized", userErr?.message);
      return json({ error: "unauthorized" }, 401);
    }
    console.log("caller user id:", user.id, "email:", user.email);

    // Server-side, look up THIS user's contractor row and the admin list.
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: contractor, error: cErr } = await admin
      .from("contractors")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();
    if (cErr) { console.error("contractor lookup failed:", cErr.message); return json({ error: cErr.message }, 500); }
    if (!contractor) { console.log("skip: no contractor row for user"); return json({ skipped: "no contractor row" }, 200); }
    if (contractor.verified) { console.log("skip: already verified"); return json({ skipped: "already verified" }, 200); }
    const { data: creds } = await admin
      .from("contractor_credentials").select("*").eq("contractor_id", contractor.id).maybeSingle();
    const cc = creds || {};
    // Business license + insurance are required for every provider; a trade
    // license only exists for services whose document policy asks for one.
    const licensePath = cc.business_license_path || cc.license_path;
    if (!licensePath || !cc.insurance_path) {
      console.log("skip: missing docs", { license: !!licensePath, insurance: !!cc.insurance_path });
      return json({ skipped: "missing docs" }, 200);
    }
    const services = Array.isArray(contractor.trades) && contractor.trades.length ? contractor.trades.join(", ") : (contractor.trade || "");
    const tradeLicenses = Object.entries(cc.trade_licenses || {}) as [string, { type?: string; number?: string; path?: string }][];
    const links = await signDocs(admin, [cc.business_license_path, cc.license_path, cc.insurance_path, cc.bond_path, ...tradeLicenses.map(([, tl]) => tl.path)]);
    const link = (path?: string | null) => (path && links[path] ? ` <a href="${links[path]}" style="color:#0369a1;">view</a>` : "");
    console.log("contractor:", contractor.name, "trades:", contractor.trades);

    const { data: admins, error: aErr } = await admin.from("admins").select("email");
    if (aErr) { console.error("admins lookup failed:", aErr.message); return json({ error: aErr.message }, 500); }
    const recipients = (admins || []).map((a) => a.email).filter(Boolean);
    console.log("admin recipients:", recipients);
    if (recipients.length === 0) {
      return json({ skipped: "no admins configured" }, 200);
    }

    const apiKey = Deno.env.get("RESEND_API_KEY");
    const from   = Deno.env.get("MAIL_FROM");
    console.log("secrets present — key:", !!apiKey, "from:", from);
    if (!apiKey || !from) {
      console.error("missing secrets");
      return json({ error: "RESEND_API_KEY and MAIL_FROM must be set" }, 500);
    }

    const appUrl  = Deno.env.get("APP_URL") || "";
    const subject = `[Subcontractor Pros] Verify: ${contractor.name}`;

    const html = `
<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;">
    <h2 style="color:#0f172a;margin:0 0 8px;">New contractor awaiting verification</h2>
    <p style="color:#475569;margin:0 0 16px;">
      <strong>${escape(contractor.name)}</strong> just uploaded their credentials and needs an admin to verify.
    </p>
    <table style="border-collapse:collapse;margin:0 0 16px;font-size:14px;color:#0f172a;">
      <tr><td style="padding:4px 12px 4px 0;color:#64748b;">Services</td><td>${escape(services)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#64748b;">Location</td><td>${escape(contractor.location)}</td></tr>
      ${cc.business_license_path ? `<tr><td style="padding:4px 12px 4px 0;color:#64748b;">Business license</td><td>${cc.business_license_number ? "#" + escape(cc.business_license_number) : ""}${link(cc.business_license_path)}</td></tr>` : ""}
      ${!tradeLicenses.length && cc.license_path ? `<tr><td style="padding:4px 12px 4px 0;color:#64748b;">${escape(cc.license_type || "Trade license")}</td><td>${cc.license_number ? "#" + escape(cc.license_number) : ""}${link(cc.license_path)}</td></tr>` : ""}
      ${tradeLicenses.map(([t, tl]) => `<tr><td style="padding:4px 12px 4px 0;color:#64748b;">${escape(tl.type || "Trade license")}</td><td>${escape(t)}${tl.number ? " #" + escape(tl.number) : ""}${link(tl.path)}</td></tr>`).join("")}
      <tr><td style="padding:4px 12px 4px 0;color:#64748b;">Insurance</td><td>${escape(cc.insurance_carrier || "")} (expires ${escape(cc.insurance_expires_at || "")})${link(cc.insurance_path)}</td></tr>
      ${cc.bond_path ? `<tr><td style="padding:4px 12px 4px 0;color:#64748b;">Bond</td><td>${link(cc.bond_path)}</td></tr>` : ""}
    </table>
    <p style="color:#64748b;font-size:12px;margin:0 0 16px;">Document links expire in 7 days. You can always open them from the admin dashboard.</p>
    ${appUrl ? `<p><a href="${appUrl}" style="display:inline-block;background:#f59e0b;color:#0f172a;padding:12px 24px;text-decoration:none;border-radius:10px;font-weight:700;">Open Admin Dashboard</a></p>` : ""}
    <p style="color:#94a3b8;font-size:12px;margin-top:24px;">You're receiving this because you're an admin on Subcontractor Pros.</p>
  </div>
</body></html>`.trim();

    const text = [
      `${contractor.name} (${services}) uploaded credentials and needs verification.`,
      "",
      cc.business_license_path ? `Business license: ${cc.business_license_number ? "#" + cc.business_license_number + " " : ""}${links[cc.business_license_path] || ""}` : "",
      ...tradeLicenses.map(([t, tl]) => `${tl.type || "Trade license"} (${t}): ${tl.number ? "#" + tl.number + " " : ""}${(tl.path && links[tl.path]) || ""}`),
      `Insurance:   ${cc.insurance_carrier || ""}${cc.insurance_expires_at ? ` (expires ${cc.insurance_expires_at})` : ""}`,
      `COI:         ${links[cc.insurance_path] || ""}`,
      "Document links expire in 7 days.",
      "",
      appUrl ? `Open admin dashboard: ${appUrl}` : "",
    ].filter(Boolean).join("\n");

    const adminRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: recipients, subject, html, text }),
    });
    const adminBody = await adminRes.text();
    console.log("admin email send status:", adminRes.status, adminBody);
    if (!adminRes.ok) {
      console.error("admin resend failed:", adminRes.status, adminBody);
      return json({ error: "resend admin failed", status: adminRes.status, body: adminBody }, 500);
    }

    // Also confirm to the contractor that we've got their docs.
    const contractorSubject = "Subcontractor Pros — your documents are being reviewed";
    const contractorHtml = `
<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;">
    <h2 style="color:#0f172a;margin:0 0 8px;">Thanks, ${escape(contractor.name)} — we've got your docs</h2>
    <p style="color:#475569;line-height:1.55;">
      Your license and certificate of insurance were uploaded successfully. Our team is reviewing them now — we usually verify within a business day.
    </p>
    <p style="color:#475569;line-height:1.55;">
      Once you're verified, the ✓ Verified badge appears on your profile and you'll be able to accept jobs from homeowners.
    </p>
    ${appUrl ? `<p><a href="${appUrl}" style="display:inline-block;background:#f59e0b;color:#0f172a;padding:12px 24px;text-decoration:none;border-radius:10px;font-weight:700;">Open Subcontractor Pros</a></p>` : ""}
    <p style="color:#94a3b8;font-size:12px;margin-top:24px;">You're receiving this because you set up a contractor profile on Subcontractor Pros.</p>
  </div>
</body></html>`.trim();
    const contractorText = [
      `Hi ${contractor.name},`,
      "",
      "Thanks for submitting your license and certificate of insurance.",
      "Our team is reviewing them now — usually within one business day.",
      "",
      "You'll get a follow-up email as soon as your profile is verified.",
      appUrl ? `\nOpen Subcontractor Pros: ${appUrl}` : "",
    ].filter(Boolean).join("\n");

    if (user.email) {
      const contractorRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [user.email], subject: contractorSubject, html: contractorHtml, text: contractorText }),
      });
      const contractorBody = await contractorRes.text();
      console.log("contractor confirmation status:", contractorRes.status, contractorBody);
    }

    return json({ sent: true, recipients: recipients.length, notifiedContractor: !!user.email }, 200);
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

const LINK_TTL_SECONDS = 60 * 60 * 24 * 7;

// Documents live in a private bucket; emails carry 7-day signed links.
async function signDocs(admin: any, paths: (string | null | undefined)[]) {
  const list = [...new Set(paths.filter(Boolean))] as string[];
  if (!list.length) return {} as Record<string, string>;
  const { data, error } = await admin.storage.from("credentials").createSignedUrls(list, LINK_TTL_SECONDS);
  if (error) console.error("signing document links failed:", error.message);
  return Object.fromEntries((data || []).filter((d: any) => d.signedUrl).map((d: any) => [d.path, d.signedUrl])) as Record<string, string>;
}
