// Push notifications, frontend side.
//
// - registerServiceWorker(): registers public/sw.js at the root scope.
// - usePushDevice(api): this device's on/off state for the Settings toggle.
//   On = the browser holds a push subscription for this origin. Turning it on
//   asks for permission (must come from a tap), subscribes with the backend's
//   VAPID public key, and sends the subscription to POST /push-subscriptions;
//   off unsubscribes and deletes the backend row.
// - useInAppNotices(): shows a notice when the service worker hands a payload
//   to this window because it is open and focused (sw.js).
import { useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import { toast } from "sonner";

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.error("Service worker registration failed:", error);
    });
  });
}

export const isPushSupported = () =>
  typeof window !== "undefined" &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  "Notification" in window;

// applicationServerKey must be the raw key bytes, not the base64url string.
function urlBase64ToUint8Array(base64) {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = window.atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// Shown in the backend's device list, e.g. "Android · Chrome".
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? "Android"
    : /iPhone|iPad/i.test(ua) ? "iOS"
    : /Windows/i.test(ua) ? "Windows"
    : /Mac/i.test(ua) ? "Mac"
    : /Linux/i.test(ua) ? "Linux"
    : "Device";
  const browser = /Edg\//.test(ua) ? "Edge"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Safari\//.test(ua) ? "Safari"
    : "Browser";
  return `${os} · ${browser}`;
}

// status: "loading" | "unsupported" | "denied" | "unconfigured" | "off" | "on"
export function usePushDevice(api) {
  const [status, setStatus] = useState("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!isPushSupported()) {
      setStatus("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setStatus("denied");
      return;
    }
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = registration ? await registration.pushManager.getSubscription() : null;
    setStatus(subscription ? "on" : "off");
  }, []);

  useEffect(() => {
    refresh().catch(() => setStatus("off"));
  }, [refresh]);

  const enable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await axios.get(`${api}/push/vapid-public-key`);
      if (!data.public_key) {
        setStatus("unconfigured");
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setStatus(permission === "denied" ? "denied" : "off");
        return;
      }
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(data.public_key),
      });
      const { endpoint, keys } = subscription.toJSON();
      await axios.post(`${api}/push-subscriptions`, {
        endpoint,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
        label: deviceLabel(),
      });
      setStatus("on");
    } catch (e) {
      console.error("Failed to turn on notifications:", e);
      setError("Couldn't turn on notifications on this device.");
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }, [api, refresh]);

  const disable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = registration ? await registration.pushManager.getSubscription() : null;
      if (subscription) {
        const { data: rows } = await axios.get(`${api}/push-subscriptions`);
        const row = rows.find((r) => r.endpoint === subscription.endpoint);
        if (row) await axios.delete(`${api}/push-subscriptions/${row.id}`);
        await subscription.unsubscribe();
      }
      setStatus("off");
    } catch (e) {
      console.error("Failed to turn off notifications:", e);
      setError("Couldn't turn off notifications on this device.");
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }, [api, refresh]);

  return { status, busy, error, enable, disable };
}

// "/?task=<id>" -> "<id>" (a notification's body-tap / [Open task] link).
export function taskIdFromUrl(url) {
  if (!url) return null;
  try {
    return new URL(url, window.location.origin).searchParams.get("task");
  } catch (e) {
    return null;
  }
}

// The notice shown instead of an OS notification while the app is open and
// focused. A payload's tag is used as the notice id, so a newer notice with
// the same tag replaces the older one -- same behavior as the OS tray. A
// task's "ends in N minutes" carries the same buttons as the OS notification
// (sw.js): a token button posts to payload.action_url and the reply replaces
// the notice; [Open task] focuses the task (onOpenTask). onQueueChanged runs
// after a button changed the queue, so the app refetches it. The service
// worker also posts "flexflow-open" when a notification is tapped while a
// window is already open.
export function useInAppNotices({ onOpenTask, onQueueChanged } = {}) {
  const handlers = useRef({ onOpenTask, onQueueChanged });
  handlers.current = { onOpenTask, onQueueChanged };

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return undefined;

    const openTask = (url) => {
      const taskId = taskIdFromUrl(url);
      if (taskId && handlers.current.onOpenTask) handlers.current.onOpenTask(taskId);
    };

    const show = (id, payload) => {
      const buttons = (payload.actions || []).map((a) => ({
        label: a.title,
        onClick: () => {
          if (a.token && payload.action_url) {
            run(id, payload, a);
          } else {
            openTask(a.url || payload.url);
          }
        },
      }));
      toast(payload.title || "Flowuality", {
        id,
        description: payload.body || undefined,
        action: buttons[0],
        cancel: buttons[1],
        duration: buttons.length ? Infinity : undefined,
      });
    };

    const run = async (id, payload, chosen) => {
      let reply;
      try {
        reply = (await axios.post(payload.action_url, { token: chosen.token })).data;
        if (handlers.current.onQueueChanged) handlers.current.onQueueChanged();
      } catch (e) {
        reply = { title: "Couldn't reach Flowuality", body: "Nothing was changed. Try again.", actions: [] };
      }
      show(id, { ...payload, ...reply, url: reply.url || payload.url });
    };

    const onMessage = (event) => {
      const message = event.data;
      if (!message) return;
      if (message.type === "flexflow-open") {
        openTask(message.url);
        return;
      }
      if (message.type !== "flexflow-notification") return;
      const payload = message.payload || {};
      show(payload.tag || undefined, payload);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);
}
