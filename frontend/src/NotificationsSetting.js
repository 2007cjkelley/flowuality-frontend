import { Switch } from "@/components/ui/switch";
import { usePushDevice } from "./pushNotifications";

// Account-level notification settings (saved with the panel's Save; the
// server's notification job reads them). Ranges match the server's, which
// rejects anything outside them -- the UI clamps instead.
export const NOTIFY_LEAD_DEFAULT = 5;
export const NOTIFY_LEAD_RANGE = [1, 60];
export const EXTEND_INCREMENT_DEFAULT = 15;
export const EXTEND_INCREMENT_RANGE = [1, 120];

// A digits-only text value -> a whole number within [lo, hi]; empty or
// unparseable falls back to the default.
export const clampMinutes = (value, [lo, hi], fallback) => {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

// Settings > "Notifications on this device". Acts immediately (it is a device
// permission, not an account setting), so it is not part of the panel's Save.
const NOTES = {
  loading: "Checking this device…",
  unsupported: "This browser can't receive push notifications. On a phone, install the app from the browser menu first.",
  denied: "Notifications are blocked for this site. Allow them in the browser's site settings, then try again.",
  unconfigured: "Push notifications aren't set up on this server yet.",
  off: "Get task and event notifications on this device. On Android, install the app from Chrome's menu (Install app) first.",
  on: "This device gets notifications. When the app is open and in front, they show here instead.",
};

export default function NotificationsSetting({ api }) {
  const { status, busy, error, enable, disable } = usePushDevice(api);
  const toggleable = status === "on" || status === "off";

  return (
    <div className="form-group" data-testid="notifications-setting">
      <div className="flex items-center justify-between">
        <label className="form-label" htmlFor="notifications-device-toggle">Notifications on this device</label>
        <Switch
          id="notifications-device-toggle"
          checked={status === "on"}
          disabled={!toggleable || busy}
          onCheckedChange={(checked) => (checked ? enable() : disable())}
          data-testid="notifications-device-toggle"
          data-status={status}
        />
      </div>
      <div className="settings-note" data-testid="notifications-setting-note">
        {error || NOTES[status]}
      </div>
    </div>
  );
}

// The account-level part of the Notifications group: task notifications
// on/off, warning lead, extend increment. Edits the Settings panel's draft
// (`form`); nothing is sent until Save.
export function NotificationPrefsFields({ form, setForm }) {
  const digits = (field) => (e) => {
    const value = e.target.value.replace(/[^0-9]/g, "");
    setForm((prev) => ({ ...prev, [field]: value }));
  };
  const minDuration = parseInt(form.minDuration, 10) || 15;
  const lead = clampMinutes(form.notifyLeadMinutes, NOTIFY_LEAD_RANGE, NOTIFY_LEAD_DEFAULT);

  return (
    <>
      <div className="form-group">
        <div className="flex items-center justify-between">
          <label className="form-label" htmlFor="flex-notifications-toggle">Task notifications</label>
          <Switch
            id="flex-notifications-toggle"
            checked={form.flexNotifications}
            onCheckedChange={(checked) => setForm((prev) => ({ ...prev, flexNotifications: checked }))}
            data-testid="flex-notifications-toggle"
          />
        </div>
        <div className="settings-note">
          Starts, ends and heads-ups for tasks. Event reminders follow each calendar's bell.
        </div>
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="notify-lead-input">Warning lead (minutes)</label>
        <input
          id="notify-lead-input"
          type="text"
          inputMode="numeric"
          className="form-input"
          placeholder={String(NOTIFY_LEAD_DEFAULT)}
          value={form.notifyLeadMinutes}
          onChange={digits("notifyLeadMinutes")}
          data-testid="notify-lead-input"
        />
        {minDuration < lead && (
          <div className="settings-note" data-testid="notify-lead-hint">
            Tasks shorter than this get no heads-up
          </div>
        )}
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="extend-increment-input">Extend increment (minutes)</label>
        <input
          id="extend-increment-input"
          type="text"
          inputMode="numeric"
          className="form-input"
          placeholder={String(EXTEND_INCREMENT_DEFAULT)}
          value={form.extendIncrementMinutes}
          onChange={digits("extendIncrementMinutes")}
          data-testid="extend-increment-input"
        />
      </div>
    </>
  );
}
