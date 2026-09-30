// Minimal service worker — the presence of a fetch handler alone is what
// unlocks Chrome/Edge's install prompt. We deliberately DON'T cache
// anything so users always get the latest Vercel deploy on refresh.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // no-op — let the network handle everything.
});
