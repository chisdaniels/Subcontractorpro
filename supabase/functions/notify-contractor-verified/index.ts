// Supabase Edge Function: notify-contractor-verified
//
// Called by the app right after an admin clicks Verify on a contractor
// (or Un-verify → this reads the current row and picks the right template).
// Only admins can invoke it successfully — the function checks the caller's
// admin status server-side.
//
// Deploy:
//   supabase functions deploy notify-contractor-verified
//
// Uses the same secrets as notify-admin-contractor-pending:
//   RESEND_API_KEY, MAIL_FROM, APP_URL

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
    console.log("notify-contractor-verified invoked");
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

    // Caller must be an admin.
    const { data: adminRow } = await admin
      .from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
    if (!adminRow) return json({ error: "not admin" }, 403);

    const { contractorId } = await req.json();
    if (!contractorId) return json({ error: "missing contractorId" }, 400);

    const { data: contractor, error: cErr } = await admin
      .from("contractors").select("*").eq("id", contractorId).maybeSingle();
    if (cErr) return json({ error: cErr.message }, 500);
    if (!contractor) return json({ error: "contractor not found" }, 404);

    // Look up the contractor's auth email.
    let email: string | null = null;
    if (contractor.user_id) {
      const { data: authUser } = await admin.auth.admin.getUserById(contractor.user_id);
      email = authUser?.user?.email ?? null;
    }
    console.log("target contractor:", contractor.name, "email:", email, "verified:", contractor.verified);
    if (!email) return json({ skipped: "no email on file for contractor" }, 200);

    const apiKey = Deno.env.get("RESEND_API_KEY");
    const from   = Deno.env.get("MAIL_FROM");
    const appUrl = Deno.env.get("APP_URL") || "";
    if (!apiKey || !from) return json({ error: "secrets missing" }, 500);

    const verified = !!contractor.verified;
    const subject = verified
      ? `TradeLinkPro — you're verified, ${contractor.name}!`
      : `TradeLinkPro — verification status updated`;

    const bodyHtml = verified
      ? `
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;">
  <h2 style="color:#0f172a;margin:0 0 8px;">You're verified 🎉</h2>
  <p style="color:#475569;line-height:1.55;">Our team reviewed your license and insurance and you're all set. The ✓ Verified badge is now live on your profile, and homeowners can hire you.</p>
  <p style="color:#475569;line-height:1.55;">Head to Browse Jobs to see open work in your area.</p>
  ${appUrl ? `<p><a href="${appUrl}" style="display:inline-block;background:#f59e0b;color:#0f172a;padding:12px 24px;text-decoration:none;border-radius:10px;font-weight:700;">Open TradeLinkPro →</a></p>` : ""}
</div>`
      : `
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;">
  <h2 style="color:#0f172a;margin:0 0 8px;">Verification paused</h2>
  <p style="color:#475569;line-height:1.55;">Our team un-verified your profile. This usually means a license or COI needs to be updated. Open TradeLinkPro to re-upload — we'll re-review.</p>
  ${appUrl ? `<p><a href="${appUrl}" style="display:inline-block;background:#f59e0b;color:#0f172a;padding:12px 24px;text-decoration:none;border-radius:10px;font-weight:700;">Open TradeLinkPro →</a></p>` : ""}
</div>`;

    const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;padding:24px;">${bodyHtml}</body></html>`;

    const text = verified
      ? `You're verified, ${contractor.name}! The ✓ Verified badge is now live on your profile — homeowners can hire you.\n${appUrl ? `\nOpen TradeLinkPro: ${appUrl}` : ""}`
      : `Your verification was paused. Log in and re-upload your license / COI when they're current.\n${appUrl ? `\nOpen TradeLinkPro: ${appUrl}` : ""}`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [email], subject, html, text }),
    });
    const body = await res.text();
    console.log("send status:", res.status, body);
    if (!res.ok) return json({ error: "resend failed", status: res.status, body }, 500);

    return json({ sent: true, to: email, verified }, 200);
  } catch (err) {
    console.error("notify-contractor-verified error:", err);
    return json({ error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}
