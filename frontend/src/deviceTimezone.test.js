import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  ACTIVITY_REFRESH_MS,
  timezoneToSaveOnActivity,
  timezoneToSaveOnLoad,
  timezoneToSaveOnTick,
  useDeviceTimezoneSync,
} from "./deviceTimezone";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("timezoneToSaveOnLoad", () => {
  test("records the device timezone when none is recorded yet", () => {
    expect(timezoneToSaveOnLoad({ followsDevice: true, recorded: false, deviceTz: "America/Los_Angeles" })).toBe("America/Los_Angeles");
  });
  test("never saves once one is recorded, even if it differs", () => {
    expect(timezoneToSaveOnLoad({ followsDevice: true, recorded: true, deviceTz: "America/Los_Angeles" })).toBeNull();
  });
  test("never saves for a fixed timezone", () => {
    expect(timezoneToSaveOnLoad({ followsDevice: false, recorded: false, deviceTz: "America/Los_Angeles" })).toBeNull();
  });
});

describe("timezoneToSaveOnTick", () => {
  test("a device whose own timezone hasn't changed never saves, even if the stored one differs", () => {
    expect(timezoneToSaveOnTick({
      followsDevice: true, storedTz: "Europe/London", deviceTz: "America/New_York", lastSeenDeviceTz: "America/New_York",
    })).toBeNull();
  });
  test("a device whose timezone changed saves the new one", () => {
    expect(timezoneToSaveOnTick({
      followsDevice: true, storedTz: "America/New_York", deviceTz: "America/Chicago", lastSeenDeviceTz: "America/New_York",
    })).toBe("America/Chicago");
  });
  test("a changed device on a fixed timezone saves nothing", () => {
    expect(timezoneToSaveOnTick({
      followsDevice: false, storedTz: "Asia/Tokyo", deviceTz: "America/Chicago", lastSeenDeviceTz: "America/New_York",
    })).toBeNull();
  });
});

describe("timezoneToSaveOnActivity", () => {
  test("a device in use saves its timezone when it differs from the stored one", () => {
    expect(timezoneToSaveOnActivity({ followsDevice: true, storedTz: "America/Los_Angeles", deviceTz: "America/New_York" })).toBe("America/New_York");
  });
  test("saves nothing when they match, or on a fixed timezone", () => {
    expect(timezoneToSaveOnActivity({ followsDevice: true, storedTz: "America/New_York", deviceTz: "America/New_York" })).toBeNull();
    expect(timezoneToSaveOnActivity({ followsDevice: false, storedTz: "Asia/Tokyo", deviceTz: "America/New_York" })).toBeNull();
  });
});

describe("useDeviceTimezoneSync", () => {
  let deviceTz;
  let container;
  let root;
  const realDateTimeFormat = Intl.DateTimeFormat;

  beforeEach(() => {
    jest.useFakeTimers();
    deviceTz = "America/New_York";
    jest.spyOn(Intl, "DateTimeFormat").mockImplementation((...args) => {
      const fmt = new realDateTimeFormat(...args);
      return { ...fmt, resolvedOptions: () => ({ ...fmt.resolvedOptions(), timeZone: deviceTz }) };
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function Harness(props) {
    useDeviceTimezoneSync(props);
    return null;
  }

  // Server stand-in: `stored` is what GET /settings would return; save()
  // writes it, like the real PUT.
  function setup(initialStored, followsDevice = true) {
    const server = { stored: initialStored };
    const save = jest.fn((tz) => { server.stored = tz; renderIt(); });
    const fetchStored = jest.fn(async () => ({ timezone: server.stored, followsDevice }));
    let localStored = initialStored;
    const renderIt = () => act(() => {
      root.render(<Harness enabled followsDevice={followsDevice} storedTz={localStored}
        fetchStored={async () => { const f = await fetchStored(); localStored = f.timezone; return f; }}
        save={(tz) => { localStored = tz; save(tz); }} />);
    });
    renderIt();
    return { server, save, fetchStored };
  }

  const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

  test("a tab sitting open with no interaction never saves, even when the stored timezone differs", async () => {
    const { save } = setup("America/Los_Angeles");
    act(() => jest.advanceTimersByTime(5 * 60_000));
    await flush();
    expect(save).not.toHaveBeenCalled();
  });

  test("its own timezone changing saves once on the next tick, then stays quiet", async () => {
    const { save } = setup("America/New_York");
    deviceTz = "America/Chicago";
    act(() => jest.advanceTimersByTime(60_000));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("America/Chicago");
    act(() => jest.advanceTimersByTime(3 * 60_000));
    expect(save).toHaveBeenCalledTimes(1);
  });

  test("focus re-reads the stored settings, so a stale tab catches another device's save and wins it back", async () => {
    const { server, save, fetchStored } = setup("America/New_York");
    server.stored = "America/Los_Angeles"; // another device saved while this tab sat open
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await flush();
    expect(fetchStored).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("America/New_York");
    expect(server.stored).toBe("America/New_York");
  });

  test("clicks re-read at most once per ACTIVITY_REFRESH_MS; focus skips the limit", async () => {
    const { fetchStored } = setup("America/New_York");
    const click = () => act(async () => { document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    await click(); await flush();
    await click(); await flush();
    expect(fetchStored).toHaveBeenCalledTimes(1);

    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await flush();
    expect(fetchStored).toHaveBeenCalledTimes(2);

    act(() => jest.advanceTimersByTime(ACTIVITY_REFRESH_MS));
    await click(); await flush();
    expect(fetchStored).toHaveBeenCalledTimes(3);
  });

  test("activity on a fixed timezone saves nothing", async () => {
    const { save } = setup("Asia/Tokyo", false);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true })); });
    await flush();
    expect(save).not.toHaveBeenCalled();
  });
});
