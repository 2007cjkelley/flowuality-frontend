import { useEffect, useLayoutEffect, useRef, useState } from "react";

// Now line -- the red current-time line across today's column on the week
// and day grids (Google Calendar style). Client-only: it owns its own clock
// state, so a tick re-renders just this component, never the grid, and it
// makes no backend calls.

export const NOW_LINE_TICK_MS = 60_000;

// Date + minute-of-day of `date` in the account's timezone (an IANA name,
// already resolved from "local" by the caller) -- the same Intl-based source
// App.js uses to place events on the grid, never the browser's local clock.
export function getZonedNow(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZone: tz,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  const hour = Number(get("hour")) % 24; // Intl can report midnight as "24"
  return {
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    hour,
    minute: Number(get("minute")),
  };
}

// Calls onTick at the top of every minute (aligned to the wall clock, not
// NOW_LINE_TICK_MS after mount), and immediately whenever the tab becomes
// visible or regains focus. After the machine sleeps, the pending timeout
// fires late on wake and onTick recomputes from the real clock, then
// re-aligns to the next minute boundary.
export function useMinuteTick(onTick) {
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  useEffect(() => {
    let timer = null;
    const schedule = () => {
      clearTimeout(timer);
      const delay = NOW_LINE_TICK_MS - (Date.now() % NOW_LINE_TICK_MS) + 5;
      timer = setTimeout(() => {
        onTickRef.current();
        schedule();
      }, delay);
    };
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      onTickRef.current();
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
}

// Today's "yyyy-MM-dd" in the account's timezone, for the header's today
// circle. Ticks on the same minute schedule but only changes state when the
// date itself changes, so its host component re-renders once a day, not
// once a minute.
export function useZonedToday(tz) {
  const [today, setToday] = useState(() => getZonedNow(new Date(), tz).dateKey);
  useEffect(() => {
    setToday(getZonedNow(new Date(), tz).dateKey);
  }, [tz]);
  useMinuteTick(() => setToday(getZonedNow(new Date(), tz).dateKey));
  return today;
}

// Rendered as the last child of a grid container that is position:relative.
// `dayKeys` are the visible columns' "yyyy-MM-dd" dates; `getCellTestId`
// maps (dateKey, hour) to the data-testid of that hour's cell. Position is
// MEASURED from that cell's live geometry rather than computed from row
// height/gap constants, so it stays correct for any row height, gap or
// column width (panel resizes, a future Calendar Zoom). `wholeDay` (month
// view) treats the cell as the entire day: getCellTestId(dateKey) is today's
// cell and the line sits at minutes-of-day / 1440 of its height.
export default function NowLine({ tz, dayKeys, getCellTestId, wholeDay = false }) {
  const layerRef = useRef(null);
  const [now, setNow] = useState(() => getZonedNow(new Date(), tz));
  const [box, setBox] = useState(null);

  useEffect(() => {
    setNow(getZonedNow(new Date(), tz));
  }, [tz]);
  useMinuteTick(() => setNow(getZonedNow(new Date(), tz)));

  const visible = dayKeys.includes(now.dateKey);
  const dayKeysSig = dayKeys.join(",");

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const container = layer?.parentElement;
    if (!visible || !container) {
      setBox(null);
      return undefined;
    }
    const measure = () => {
      const cell = container.querySelector(`[data-testid="${getCellTestId(now.dateKey, now.hour)}"]`);
      if (!cell) {
        setBox(null);
        return;
      }
      const c = container.getBoundingClientRect();
      const r = cell.getBoundingClientRect();
      const fraction = wholeDay ? (now.hour * 60 + now.minute) / 1440 : now.minute / 60;
      setBox({
        top: r.top - c.top + fraction * r.height,
        left: r.left - c.left,
        width: r.width,
      });
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(container);
    return () => ro?.disconnect();
    // getCellTestId is a fresh closure every parent render; dayKeysSig + now
    // already capture everything that changes where the line belongs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, now.dateKey, now.hour, now.minute, dayKeysSig, wholeDay]);

  return (
    <div ref={layerRef} className="now-line-layer" aria-hidden="true">
      {box && (
        <div
          className="now-line"
          data-testid="now-line"
          data-now-date={now.dateKey}
          data-now-minutes={now.hour * 60 + now.minute}
          style={{ top: `${box.top}px`, left: `${box.left}px`, width: `${box.width}px` }}
        >
          <span className="now-line-dot" />
        </div>
      )}
    </div>
  );
}
