import { useEffect, useRef } from "react";
import { useMinuteTick } from "./NowLine";

// "Local (follows this device)" -- the Settings dropdown's value for an
// account whose timezone_follows_device is true. Never sent to the backend:
// the stored timezone is always a real IANA name (the device's, while Local
// is selected), because the server needs one for its calculations.
//
// The rule is "the device being used wins": a page load or a tab sitting
// open never overwrites the stored timezone (except to record the first
// one); using a device, or that device's own timezone changing, does.
export const LOCAL_TIMEZONE_OPTION = "local";

// How often a click or keypress may re-read the stored settings. Focus and
// visibility changes skip this -- they're rare, and they're exactly the
// "just sat back down at this device" moment.
export const ACTIVITY_REFRESH_MS = 30_000;

export const getDeviceTimezone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// Page load: saves only when no device timezone has been recorded yet.
// Returns the timezone to save, or null.
export function timezoneToSaveOnLoad({ followsDevice, recorded, deviceTz }) {
  return followsDevice && !recorded ? deviceTz : null;
}

// Minute tick: saves only when THIS device's own timezone has changed since
// its last check -- not merely because it differs from the stored value.
export function timezoneToSaveOnTick({ followsDevice, storedTz, deviceTz, lastSeenDeviceTz }) {
  if (deviceTz === lastSeenDeviceTz) return null;
  return followsDevice && deviceTz !== storedTz ? deviceTz : null;
}

// Using the device (focus, visibility, click, keypress): saves whenever the
// device's timezone differs from the stored one.
export function timezoneToSaveOnActivity({ followsDevice, storedTz, deviceTz }) {
  return followsDevice && deviceTz !== storedTz ? deviceTz : null;
}

// Runs the tick and activity rules. `enabled` stays false until settings
// have been read from the server. `fetchStored` re-reads the stored settings
// (resolving to { timezone, followsDevice }) so a tab left open elsewhere
// compares against what another device may have saved since, not its own
// stale copy. `save` is called with the device's timezone when it should be
// stored.
export function useDeviceTimezoneSync({ enabled, followsDevice, storedTz, fetchStored, save }) {
  const lastSeenRef = useRef(null);
  if (lastSeenRef.current === null) lastSeenRef.current = getDeviceTimezone();

  const latest = useRef({});
  latest.current = { enabled, followsDevice, storedTz, fetchStored, save };

  useMinuteTick(() => {
    const deviceTz = getDeviceTimezone();
    const { enabled: on, followsDevice: follows, storedTz: stored } = latest.current;
    const toSave = on
      ? timezoneToSaveOnTick({ followsDevice: follows, storedTz: stored, deviceTz, lastSeenDeviceTz: lastSeenRef.current })
      : null;
    lastSeenRef.current = deviceTz;
    if (toSave) latest.current.save(toSave);
  });

  useEffect(() => {
    let lastRefreshAt = 0;
    let inFlight = false;

    const onActivity = async (bypassThrottle) => {
      const current = latest.current;
      if (!current.enabled || inFlight) return;
      const deviceTz = getDeviceTimezone();
      if (!bypassThrottle && Date.now() - lastRefreshAt < ACTIVITY_REFRESH_MS) {
        const toSave = timezoneToSaveOnActivity({ followsDevice: current.followsDevice, storedTz: current.storedTz, deviceTz });
        if (toSave) current.save(toSave);
        return;
      }
      lastRefreshAt = Date.now();
      inFlight = true;
      try {
        const fresh = await current.fetchStored();
        if (!fresh) return;
        const toSave = timezoneToSaveOnActivity({ followsDevice: fresh.followsDevice, storedTz: fresh.timezone, deviceTz });
        if (toSave) latest.current.save(toSave);
      } finally {
        inFlight = false;
      }
    };

    const onFocus = () => onActivity(true);
    const onVisibility = () => { if (document.visibilityState === "visible") onActivity(true); };
    const onInput = () => onActivity(false);

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("pointerdown", onInput, true);
    document.addEventListener("keydown", onInput, true);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("pointerdown", onInput, true);
      document.removeEventListener("keydown", onInput, true);
    };
  }, []);
}
