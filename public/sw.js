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

async function updateBadge() {
  if (!self.navigator.setAppBadge) return;
  const shown = await self.registration.getNotifications();
  if (shown.length) await self.navigator.setAppBadge(shown.length);
  else await self.navigator.clearAppBadge?.();
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
    await updateBadge();
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/messages", self.location.origin).href;
  event.waitUntil((async () => {
    await updateBadge();
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

self.addEventListener("notificationclose", (event) => {
  event.waitUntil(updateBadge());
});
