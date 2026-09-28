# Task #305: Push notifications ui: service worker, Settings switch, #task deep link and app badge

- kind: work  
- source: reflection  
- priority: 30 (normal)  
- created: 2026-09-28 10:55  
- starts after: #304  
- files: public/sw.js, public/app.js, public/index.html, public/app.css, server.mjs, test/push-ui.test.mjs

## Prompt

Client half of push notifications (server half: push.mjs and /api/push/* from the previous task; read them first). (1) Add public/sw.js: a push-only service worker that caches nothing (no fetch handler, so the app shell is never stale); `push` → `self.registration.showNotification(data.title, { body, tag, data: { url }, renotify: true })` and `navigator.setAppBadge(data.badge)` when the API exists; `notificationclick` → close, focus an existing window client and `postMessage({ t: 'open', url })`, else `clients.openWindow(url)`. Serve it with `Service-Worker-Allowed: /` and `Cache-Control: no-cache`, add '/sw.js' to PUBLIC_PATHS in server.mjs (it holds nothing secret and the browser refetches it without the login redirect). (2) public/app.js: on load (signed in) register `/sw.js`; handle `#task-<id>` in the existing hash routing near `location.hash.slice(1)` by calling `showTask(id)` after the first state arrives, and the SW's `open` message the same way; keep `#<cid>` chat links working. (3) Settings sheet (public/index.html near `#stSound`): a row 'Notify this device' with switch `#stPush` and hint `#stPushHint`; when `!('PushManager' in window)` or not standalone on iOS, disable it with the hint 'Add agent-orch to your Home Screen to get notifications'. On: `Notification.requestPermission()`, `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` with the key from `GET /api/push/key` converted base64url → Uint8Array, then `POST /api/push/subscribe`; off: unsubscribe and DELETE. Show state with the existing `toast`. Reuse the sheet's switch markup and the coarse-pointer 44pt rules; add CSS to public/app.css only if a new class is needed. (4) App badge: when state arrives, `navigator.setAppBadge(n)` / `clearAppBadge()` with n = pending approvals across tasks (`s.tasks` with `approvals?.length`), guarded by feature detection. Tests: test/push-ui.test.mjs using playwright-core like test/ui-approvals.test.mjs: load the app against a spawned server (copy that test's setup), assert `#stPush` exists in the Settings sheet, `navigator.serviceWorker.getRegistration()` resolves to a registration whose scriptURL ends with /sw.js (Chromium allows SW on localhost), and that `location.hash = '#task-1'` with a fixture task opens the drawer. Also `node --check public/sw.js` and keep test/ui-static.test.mjs green (no duplicate function names). Run `npm test -- test/push-ui.test.mjs test/ui-static.test.mjs test/security-headers.test.mjs`.

## Done when

`npm test -- test/push-ui.test.mjs test/ui-static.test.mjs test/security-headers.test.mjs` passes and `node --check public/sw.js` succeeds
