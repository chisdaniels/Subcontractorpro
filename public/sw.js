// Service worker. The fetch handler is what unlocks Chrome/Edge's install
// prompt; we deliberately DON'T cache anything so users always get the latest
// Vercel deploy on refresh. It also shows message push notifications and
// keeps the app icon badge in step with them.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // no-op — let the network handle everything.
});

// App icon badge. The count is kept in a one-entry cache (not used for
// fetches) because browsers don't reliably report which notifications are
// still showing. Each push adds one; the app resets it to the real unread
// count whenever it's opened.
const BADGE_CACHE = "app-badge";
const BADGE_KEY = "/__badge-count";

async function readBadgeCount() {
  try {
    const hit = await (await caches.open(BADGE_CACHE)).match(BADGE_KEY);
    return hit ? parseInt(await hit.text(), 10) || 0 : 0;
  } catch { return 0; }
}

async function setBadgeCount(n) {
  try { await (await caches.open(BADGE_CACHE)).put(BADGE_KEY, new Response(String(n))); } catch {}
  try {
    if (n > 0) await self.navigator.setAppBadge?.(n);
    else await self.navigator.clearAppBadge?.();
  } catch {}
}

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() }; }
  event.waitUntil((async () => {
    // Every push must show a notification (Safari revokes push otherwise).
    await self.registration.showNotification(data.title || "Subcontractor Pros", {
      body: data.body || "You have a new message.",
      tag: data.tag || "message",
      renotify: true,
      icon: "/favicon.svg",
      data: { url: data.url || "/messages" },
    });
    await setBadgeCount((await readBadgeCount()) + 1);
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/messages", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        if ("navigate" in client) await client.navigate(url).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
