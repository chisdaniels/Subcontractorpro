// Supabase Edge Function: notify-message-push
//
// Called by the app right after someone sends a message. Confirms the caller
// sent that message, then sends a web push notification to every device the
// recipient turned notifications on for. A user's reply to the team goes to
// every admin. Devices that have turned notifications off are removed.
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (and APP_URL for the contact).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader) return json({ error: "missing auth" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey     = Deno.env.get("SUPABASE_ANON_KEY")!;
    const vapidPublic  = Deno.env.get("VAPID_PUBLIC_KEY");
    const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
    if (!vapidPublic || !vapidPrivate) return json({ error: "push keys not configured" }, 500);
    const appUrl = (Deno.env.get("APP_URL") || "https://www.subcontractorpros.com").replace(/\/+$/, "");
    webpush.setVapidDetails(appUrl, vapidPublic, vapidPrivate);

    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return json({ error: "unauthorized" }, 401);

    const { messageId } = await req.json().catch(() => ({}));
    if (!messageId) return json({ error: "missing messageId" }, 400);

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: msg } = await admin
      .from("messages")
      .select("id, contractor_id, sender_id, recipient_id, from_admin, text")
      .eq("id", messageId)
      .maybeSingle();
    if (!msg || msg.sender_id !== user.id) return json({ error: "not your message" }, 403);

    // Who to notify: a user's reply to the team reaches every admin.
    let recipients: string[];
    if (msg.contractor_id == null && !msg.from_admin) {
      const { data: admins } = await admin.from("admins").select("user_id");
      recipients = (admins || []).map((a: any) => a.user_id);
    } else {
      recipients = [msg.recipient_id];
    }
    recipients = recipients.filter((id) => id && id !== user.id);
    if (!recipients.length) return json({ sent: 0 }, 200);

    // Sender name as the recipient should see it.
    let title = "New message";
    if (msg.from_admin) {
      title = "Subcontractor Pros Team";
    } else if (msg.contractor_id != null) {
      const { data: c } = await admin.from("contractors").select("name, user_id").eq("id", msg.contractor_id).maybeSingle();
      if (c && c.user_id === msg.sender_id) title = c.name;
      else title = (await customerName(admin, msg.sender_id)) || "A customer";
    } else {
      title = (await customerName(admin, msg.sender_id)) || "A user";
    }
    const body = String(msg.text || "").slice(0, 140);
    const payload = JSON.stringify({
      title,
      body,
      url: "/messages",
      // One notification per conversation; a new message replaces the last.
      tag: `msg-${msg.contractor_id ?? "team"}-${msg.from_admin ? msg.recipient_id : msg.sender_id}`,
    });

    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth")
      .in("user_id", recipients);

    let sent = 0;
    const gone: number[] = [];
    await Promise.all((subs || []).map(async (s: any) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400 });
        sent++;
      } catch (err: any) {
        if (err?.statusCode === 404 || err?.statusCode === 410) gone.push(s.id);
        else console.error("push failed:", err?.statusCode, err?.body || String(err));
      }
    }));
    if (gone.length) await admin.from("push_subscriptions").delete().in("id", gone);

    return json({ sent, removed: gone.length }, 200);
  } catch (err) {
    console.error("notify-message-push error:", err);
    return json({ error: String(err) }, 500);
  }
});

async function customerName(admin: ReturnType<typeof createClient>, userId: string) {
  const { data } = await admin.auth.admin.getUserById(userId);
  const name = data?.user?.user_metadata?.homeowner_name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}
