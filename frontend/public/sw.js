/* Flowuality service worker -- push notifications only (no offline caching).
 *
 * The backend's notification job sends one payload per notification. On
 * each device:
 *   - an app window is open and focused -> hand the payload to the page,
 *     which shows an in-app notice instead of an OS notification;
 *   - otherwise -> show an OS notification. Its `tag` makes a newer one
 *     replace the older one with the same tag (each task notification has
 *     its own tag, so in practice only a repeat of the same one replaces),
 *     and `renotify` still alerts on the replacement.
 *
 * Action buttons (a task's "ends in N minutes"): payload.actions lists them.
 * A button with a token is sent to payload.action_url -- the token is the
 * credential, since there's no login session here -- and the reply replaces
 * the notification in place (same tag) without opening the app. The
 * [Open task] button and a tap on the body open the app on payload.url
 * ("/?task=<id>"), or tell an already-open window which task to focus.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

function notificationOptions(data, replacing) {
  const actions = data.actions || [];
  return {
    body: data.body || "",
    tag: data.tag || undefined,
    // A confirmation replacing the tapped notification doesn't alert again.
    renotify: Boolean(data.tag) && !replacing,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data,
    actions: actions.map((a) => ({ action: a.action, title: a.title })),
  };
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: event.data ? event.data.text() : "Flowuality" };
  }

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const focused = windows.find((c) => c.focused && c.visibilityState === "visible");
    if (focused) {
      focused.postMessage({ type: "flexflow-notification", payload });
      return;
    }
    await self.registration.showNotification(payload.title || "Flowuality", notificationOptions(payload, false));
  })());
});

async function openApp(url) {
  const target = url || "/";
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    if ("focus" in client) {
      client.postMessage({ type: "flexflow-open", url: target });
      return client.focus();
    }
  }
  return self.clients.openWindow(target);
}

async function runAction(notification, data, chosen) {
  let reply;
  try {
    const response = await fetch(data.action_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: chosen.token }),
    });
    reply = await response.json();
  } catch (e) {
    reply = {
      title: "Couldn't reach Flowuality",
      body: "Nothing was changed. Open the app to try again.",
      actions: [{ action: "open", title: "Open app", url: data.url || "/" }],
    };
  }
  const next = {
    ...data,
    title: reply.title,
    body: reply.body || "",
    actions: reply.actions || [],
    url: reply.url || data.url,
  };
  // Same tag as the tapped one, so it replaces it in place.
  await self.registration.showNotification(reply.title || "Flowuality", {
    ...notificationOptions(next, true),
    tag: notification.tag || data.tag || undefined,
  });
}

self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data || {};
  const chosen = event.action ? (data.actions || []).find((a) => a.action === event.action) : null;
  if (chosen && chosen.token && data.action_url) {
    event.waitUntil(runAction(event.notification, data, chosen));
    return;
  }
  event.notification.close();
  event.waitUntil(openApp((chosen && chosen.url) || data.url));
});
