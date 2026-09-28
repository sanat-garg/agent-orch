// agent-orch's push-only service worker (push.mjs sends {title, body, tag, url, badge}). It caches nothing and has no
// fetch handler, so the app shell always comes from the server. A tap focuses an open window and asks app.js to open
// the link ({t: 'open', url}), else opens a new one.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data?.json() || {}; } catch { data = { body: e.data?.text() || '' }; }
  const url = data.url || '/';
  const jobs = [self.registration.showNotification(data.title || 'agent-orch', {
    body: data.body || '', tag: data.tag || undefined, data: { url }, renotify: !!data.tag, icon: '/icon-192.png', badge: '/icon-192.png' })];
  if (typeof data.badge === 'number' && self.navigator.setAppBadge) jobs.push(self.navigator.setAppBadge(data.badge).catch(() => {}));
  e.waitUntil(Promise.all(jobs));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus().catch(() => {});
      return win.postMessage({ t: 'open', url });
    }
    return self.clients.openWindow(url);
  })());
});
