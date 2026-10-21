import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useClock } from "@/hooks/useClock";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useTouchQueueDrag } from "@/hooks/useTouchQueueDrag";
import { moveToFirstInTier } from "@/lib/mobileQueue";
import { nextRepeatDay, repeatDueOn } from "@/lib/repeatSchedule";
import "@/App.css";
import axios from "axios";
import { format, startOfMonth, endOfMonth, startOfWeek, endOfWeek, startOfDay, addDays, addMonths, subMonths, isSameMonth, isSameDay, getHours, setHours, setMinutes } from "date-fns";
import { createDayShiftWheel } from "@/lib/dayShiftWheel";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Plus, Calendar as CalendarIcon, Repeat, GripVertical, Settings, X, Import as ImportIcon, Download, Clock, AlertTriangle, Bell, BellOff } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { ImportCalendarsList, CalendarRosterPanel } from "./CalendarSharing";
import { IcsImportPanel, IcsFileButton, icsImportMessage } from "./IcsImport";
import { supabase } from "./supabaseClient";
import AuthScreen from "./AuthScreen";
import ProfileMenu from "./ProfileMenu";
import NowLine, { useZonedToday } from "./NowLine";
import { LOCAL_TIMEZONE_OPTION, getDeviceTimezone, timezoneToSaveOnLoad, useDeviceTimezoneSync } from "./deviceTimezone";
import DemoBootstrap from "./DemoBootstrap";
import LandingPage from "./landing/LandingPage";
import { IS_DEMO_PATH, resolveScreen } from "./routes";
import { Toaster, toast } from "sonner";
import NotificationsSetting, {
  NotificationPrefsFields, clampMinutes,
  NOTIFY_LEAD_DEFAULT, NOTIFY_LEAD_RANGE, EXTEND_INCREMENT_DEFAULT, EXTEND_INCREMENT_RANGE,
} from "./NotificationsSetting";
import { taskIdFromUrl, useInAppNotices } from "./pushNotifications";
import { createCalendarsSync } from "./calendarsSync";

// Default to local backend for development; override by setting REACT_APP_BACKEND_URL in an .env file.
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "http://127.0.0.1:8001";
const API = `${BACKEND_URL}/api`;

// Axios request interceptor: attach the current Supabase access token per-request
// so every call carries a fresh token regardless of when axios.defaults was last set.
axios.interceptors.request.use(async (config) => {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) {
    config.headers = config.headers || {};
    config.headers["Authorization"] = `Bearer ${session.access_token}`;
  }
  return config;
});

// Demo Mode: the backend rejects an expired demo user's every request with
// this exact 403, so one interceptor catches it wherever it happens instead of
// each call site having to. The app listens for the event and switches to the
// expired screen.
axios.interceptors.response.use(undefined, (error) => {
  if (error.response?.status === 403 && error.response?.data?.detail === "Demo expired") {
    window.dispatchEvent(new CustomEvent("flexflow-demo-expired"));
  }
  return Promise.reject(error);
});
const PANEL_LAYOUT_KEY = "flexflow-panel-layout";
const LEFT_PANEL_DEFAULT_WIDTH = 300;
const LEFT_PANEL_MIN_WIDTH = 220;
const LEFT_PANEL_MAX_WIDTH = 480;
const QUEUE_PANEL_DEFAULT_WIDTH = 320;
const QUEUE_PANEL_MIN_WIDTH = 240;
const QUEUE_PANEL_MAX_WIDTH = 500;

const EVENT_CATEGORIES = [
  { value: "Work", label: "Work", className: "event-work" },
  { value: "Personal", label: "Personal", className: "event-personal" },
  { value: "Urgent", label: "Urgent", className: "event-urgent" },
  { value: "Meeting", label: "Meeting", className: "event-meeting" },
];

// Single source of truth for "this calendar has no color set yet" -- the
// sidebar calendar-row swatch and the event-card background (below) must
// never drift into two different defaults.
const DEFAULT_CALENDAR_COLOR = "#A3A3A3";

const RECURRENCE_OPTIONS = [
  { value: "none", label: "Does not repeat" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
];

// "Every N ___" unit per frequency.
const RECURRENCE_UNITS = { daily: ["day", "days"], weekly: ["week", "weeks"], monthly: ["month", "months"], yearly: ["year", "years"] };
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ORDINAL_NAMES = ["first", "second", "third", "fourth"];
// The event form's recurrence fields beyond frequency/end date/weekdays.
// Kept as strings while editing (number inputs); converted on save.
// recurrence_ends: "on" (date) | "after" (count) | "never".
// monthly_mode: "day" (on the date) | "week" (Nth weekday) | "last" (last weekday).
const DEFAULT_RECURRENCE_FIELDS = { recurrence_interval: "1", recurrence_ends: "on", recurrence_count: "10", monthly_mode: "day" };
const MAX_RECURRENCE_INTERVAL = 99;
const MAX_RECURRENCE_COUNT = 730;

// Where a "yyyy-MM-dd..." date sits in its month: which occurrence of its
// weekday it is (1-5) and whether it's the last one. Mirrors the server.
function monthlyPositionOf(dateString) {
  const [y, m, d] = (dateString || "").slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return null;
  const daysInMonth = new Date(y, m, 0).getDate();
  return { weekday: new Date(y, m - 1, d).getDay(), day: d, nth: Math.floor((d - 1) / 7) + 1, isLast: d + 7 > daysInMonth };
}

// The monthly options the start date allows, as [mode, label] pairs.
function monthlyModeOptions(dateString) {
  const pos = monthlyPositionOf(dateString);
  if (!pos) return [["day", "On the same day each month"]];
  const options = [["day", `On day ${pos.day}`]];
  if (pos.nth <= 4) options.push(["week", `On the ${ORDINAL_NAMES[pos.nth - 1]} ${WEEKDAY_NAMES[pos.weekday]}`]);
  if (pos.isLast) options.push(["last", `On the last ${WEEKDAY_NAMES[pos.weekday]}`]);
  return options;
}

// Sunday=0 .. Saturday=6.
const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

// Recurring Flex Tasks -- the Repeat section's state for a new task or a
// repeating task. cadence "none" = Repeat off.
const EMPTY_REPEAT_FORM = { cadence: "none", days_of_week: [], end_date: "", if_unfinished: "skip" };
const REPEAT_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ordinalDay = (n) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" })[n % 10] || "th"}`;
};
// One-line summary of a repeating task, e.g. "Repeats weekly, Sun".
const describeRepeat = (def) => {
  if (!def) return "Repeats";
  let text;
  if (def.cadence === "daily") text = "Repeats daily";
  else if (def.cadence === "weekly") text = `Repeats weekly, ${(def.days_of_week || []).map((d) => REPEAT_DAY_NAMES[d]).join(", ")}`;
  else text = `Repeats monthly, on the ${ordinalDay(def.anchor_day)}`;
  if (def.end_date) {
    const [y, m, d] = def.end_date.split("-").map(Number);
    text += `, until ${format(new Date(y, m - 1, d), "MMM d, yyyy")}`;
  }
  return text;
};

// "yyyy-MM-dd" -> "Sun, Oct 11".
const formatRepeatDay = (dateKey) => {
  const [y, m, d] = dateKey.split("-").map(Number);
  return format(new Date(y, m - 1, d), "EEE, MMM d");
};

// Helper to get unique name handling duplicates
const getUniqueName = (name, existingNames) => {
  if (!existingNames.includes(name)) {
    return name;
  }
  const suffixMatch = name.match(/^(.+)_(\d+)$/);
  const baseName = suffixMatch ? suffixMatch[1] : name;
  let highestSuffix = 0;
  existingNames.forEach(existingName => {
    if (existingName === baseName) {
      highestSuffix = Math.max(highestSuffix, 0);
    }
    const match = existingName.match(new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_(\\d+)$`));
    if (match) {
      highestSuffix = Math.max(highestSuffix, parseInt(match[1]));
    }
  });
  return `${baseName}_${highestSuffix + 1}`;
};

const TIMEZONE_OPTIONS = [
  { value: LOCAL_TIMEZONE_OPTION, label: "Local (follows this device)" },
  { value: "America/New_York", label: "Eastern (ET)" },
  { value: "America/Chicago", label: "Central (CT)" },
  { value: "America/Denver", label: "Mountain (MT)" },
  { value: "America/Los_Angeles", label: "Pacific (PT)" },
  { value: "America/Anchorage", label: "Alaska (AKT)" },
  { value: "Pacific/Honolulu", label: "Hawaii (HT)" },
  { value: "UTC", label: "UTC" },
  { value: "Europe/London", label: "London (GMT/BST)" },
  { value: "Europe/Paris", label: "Central Europe (CET)" },
  { value: "Asia/Tokyo", label: "Tokyo (JST)" },
  { value: "Asia/Kolkata", label: "India (IST)" },
  { value: "Australia/Sydney", label: "Sydney (AEST)" },
];

// Resolves "local" to the browser's IANA timezone, passes all other values through unchanged.
// Use this wherever globalSettings.timezone is consumed, so "local" is always expanded before use.
const getEffectiveTimezone = (tz) => {
  if (tz === "local") return Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz;
};

// Extracts the hour and minute of an ISO timestamp in the global timezone (not browser local time).
// Used for placing events on the correct hour row of the calendar grid.
// For naive events, converts using home_timezone instead of current timezone.
const getLocalizedHoursMinutes = (isoString, tz, timezoneMode = "absolute", homeTimezone = null) => {
  const effectiveTz = (timezoneMode === "naive" && homeTimezone) ? homeTimezone : tz;
  const effective = getEffectiveTimezone(effectiveTz);
  const date = new Date(isoString);
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    timeZone: effective,
  }).formatToParts(date);
  const h = parseInt(parts.find(p => p.type === "hour").value);
  const m = parseInt(parts.find(p => p.type === "minute").value);
  return { hours: h, minutes: m };
};

// Compute UTC offset in minutes from an IANA timezone name
const getTimezoneOffsetMinutes = (tz) => {
  const now = new Date();
  const utc = new Date(now.toLocaleString("en-US", { timeZone: "UTC" }));
  const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  return Math.round((local - utc) / 60000);
};

// Converts a UTC ISO string to a naive "yyyy-MM-ddTHH:mm" string expressed
// in the given IANA timezone — for populating datetime-local inputs correctly.
const utcIsoToTzLocal = (isoString, tz) => {
  const effective = getEffectiveTimezone(tz);
  const date = new Date(isoString);
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZone: effective,
  }).formatToParts(date);
  const get = (type) => parts.find(p => p.type === type).value;
  // Intl hour12:false can return "24" for midnight — clamp to "00"
  const hh = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hh}:${get("minute")}`;
};

// Interprets a naive "yyyy-MM-ddTHH:mm" string as being in the given IANA
// timezone and returns a UTC ISO string — for sending correct UTC to the backend.
const tzLocalToUtcIso = (naiveDatetime, tz) => {
  const effective = getEffectiveTimezone(tz);
  const offsetMin = getTimezoneOffsetMinutes(effective);
  // Parsing with "Z" treats the string as UTC; subtracting the offset converts to true UTC.
  const utcMs = new Date(naiveDatetime + "Z").getTime() - offsetMin * 60000;
  return new Date(utcMs).toISOString();
};

// All-day events (2026-10-17) store their first day and the day after their
// last one (exclusive, like .ics) as UTC midnights: date markers, never
// converted to any timezone. Day keys are "yyyy-MM-dd" strings, so plain
// string comparison orders them.
const ALL_DAY_STRIP_ROWS = 3; // week/day strip and month cells: then "+N more"
const ALL_DAY_MONTH_ROW = 20; // px per month-view bar lane
const ALL_DAY_MONTH_TOP = 38; // px from a month cell's top to its first lane

const shiftDayKey = (key, days) => {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const dayKeyDiff = (a, b) =>
  Math.round((new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 86400000);

// Lays all-day events out as bars over consecutive day columns (dayKeys):
// columns are clipped to the window, and each bar takes the first lane free
// from its start column -- earlier start first, then longer first.
const layoutAllDayBars = (allDayEvents, dayKeys) => {
  if (dayKeys.length === 0) return { bars: [], laneCount: 0 };
  const first = dayKeys[0];
  const afterLast = shiftDayKey(dayKeys[dayKeys.length - 1], 1);
  const items = allDayEvents
    .map((event) => ({ event, startKey: event.start_time.slice(0, 10), endKey: event.end_time.slice(0, 10) }))
    .filter(({ startKey, endKey }) => startKey < afterLast && endKey > first)
    .map((item) => ({
      ...item,
      startCol: Math.max(0, dayKeyDiff(item.startKey, first)),
      endCol: Math.min(dayKeys.length, dayKeyDiff(item.endKey, first)),
      continuesBefore: item.startKey < first,
      continuesAfter: item.endKey > afterLast,
    }))
    .sort((a, b) =>
      a.startCol - b.startCol
      || (b.endCol - b.startCol) - (a.endCol - a.startCol)
      || (a.event.title || "").localeCompare(b.event.title || "")
    );
  const laneEnds = [];
  const bars = items.map((item) => {
    let lane = laneEnds.findIndex((end) => end <= item.startCol);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = item.endCol;
    return { ...item, lane };
  });
  return { bars, laneCount: laneEnds.length };
};

// How many bars at or past `shownLanes` cover each column -- the "+N more".
const hiddenAllDayCounts = (bars, columnCount, shownLanes) =>
  Array.from({ length: columnCount }, (_, col) =>
    bars.filter((b) => b.lane >= shownLanes && b.startCol <= col && col < b.endCol).length
  );

const getCalendarDateForTimezone = (isoString, tz) => {
  const dateStr = utcIsoToTzLocal(isoString, tz).slice(0, 10);
  return new Date(`${dateStr}T12:00:00`);
};

const getTimezoneDayBounds = (date, tz) => {
  const effective = getEffectiveTimezone(tz);
  const offsetMs = getTimezoneOffsetMinutes(effective) * 60000;
  const dateStr = format(date, "yyyy-MM-dd");
  const dayStart = new Date(new Date(`${dateStr}T00:00:00Z`).getTime() - offsetMs);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  return { dayStart, dayEnd };
};

// Custom tooltip for flex queue items — shows each fragment's start–end time.
function FlexTooltip({ fragments, divRef, timezone }) {
  if (!fragments || fragments.length === 0) return null;
  const sorted = [...fragments].sort(
    (a, b) => new Date(a.start_time) - new Date(b.start_time)
  );
  const tooltipTimezone = getEffectiveTimezone(timezone);
  return (
    <div ref={divRef} style={{
      position: "fixed",
      top: 0,
      left: 0,
      background: "#1e293b",
      color: "#f1f5f9",
      borderRadius: "6px",
      padding: "6px 10px",
      fontSize: "12px",
      lineHeight: "1.7",
      whiteSpace: "nowrap",
      boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
      zIndex: 1000,
      pointerEvents: "none",
      opacity: 0,
    }}>
      {sorted.map((f, i) => (
        <div key={i}>
          {new Date(f.start_time).toLocaleTimeString("en-US", { timeZone: tooltipTimezone, hour: "numeric", minute: "2-digit" })} – {new Date(f.end_time).toLocaleTimeString("en-US", { timeZone: tooltipTimezone, hour: "numeric", minute: "2-digit" })}
        </div>
      ))}
    </div>
  );
}

// Shared left-chevron header for collapsible config-panel sections
// (Description, Category, Repeat, Timezone Mode).
function CollapsibleSectionHeader({ label, expanded, onToggle, disabled, testId }) {
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: "6px", cursor: disabled ? "default" : "pointer", userSelect: "none" }}
      onClick={disabled ? undefined : onToggle}
      data-testid={testId}
    >
      <ChevronRight
        size={14}
        style={{
          color: "var(--muted-foreground)",
          flexShrink: 0,
          transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
          transition: "transform 0.15s ease",
        }}
      />
      <label className="form-label" style={{ cursor: disabled ? "default" : "pointer", marginBottom: 0 }}>{label}</label>
    </div>
  );
}

function App() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [clockDisplay, setClockDisplay] = useState('');
  const [session, setSession] = useState(undefined); // undefined = loading, null = logged out, object = logged in
  // Demo Mode. "bootstrapping" covers the whole of DemoBootstrap's work
  // (anonymous sign-in + seeding) -- the app itself must not render until
  // that finishes, or it would fetch an empty account mid-seed. Only ever
  // leaves "off" on the /demo path.
  const [demoStatus, setDemoStatus] = useState(IS_DEMO_PATH ? "bootstrapping" : "off");
  const [isDemoGuideDismissed, setIsDemoGuideDismissed] = useState(false);
  const isDemoSession = demoStatus === "ready";

  // What the initial data fetches below key off, instead of `session`
  // directly. On /demo the anonymous session exists as soon as
  // signInAnonymously() resolves -- which is BEFORE POST /demo/finalize has
  // finished writing the seed -- so fetching on `session` alone lands on an
  // empty account and nothing ever refetches: the visitor sees "No flex
  // events" until they reload (hit in production 2026-09-24; staging seeded
  // fast enough to hide it). Flipping to "ready" changes this value, which
  // re-runs those effects against the seeded account. On every other route
  // this is just `session`, so real users' behavior is unchanged.
  const dataSession = (IS_DEMO_PATH && demoStatus !== "ready") ? null : session;

  useClock((now) => {
    setClockDisplay(new Date(now).toLocaleTimeString("en-US", { timeZone: getEffectiveTimezone(globalSettings.timezone) }));
    // Redraw the countdown whenever this page's own second changes.
    setCountdownSecond(Math.floor(Date.now() / 1000));
    // The server keeps each task's elapsed time; this tick only redraws the
    // countdown (displayElapsedSeconds re-reads the time on every render).
    // When the active task's count reaches zero, sync with the server so the
    // next task takes over.
    const sync = agingSyncRef.current;
    if (!sync || !sync.activeId || !sync.aging) return;
    const active = flexEvents.find((e) => e.id === sync.activeId);
    if (!active) return;
    // This page's own clock, like every other countdown read (the worker
    // only paces the ticks).
    const nowMs = Date.now();
    if (displayElapsedSeconds(active, nowMs) >= active.duration * 60 && nowMs - sync.syncedAtMs > 3000) {
      syncFlexEvents(true);
    }
  });
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [selectedCell, setSelectedCell] = useState(null);
  const [selectedRange, setSelectedRange] = useState({ startCell: null, endCell: null });
  const [selectedEventId, setSelectedEventId] = useState(null);
  const [view, setView] = useState("month");
  // Mobile layout (useIsMobile, max-width 767px): one panel at a time behind
  // three tabs. Held in memory only -- a reload opens on the calendar. On
  // mobile, view "week" renders a rolling three-day window (weekDayCount).
  const isMobile = useIsMobile();
  const [mobileTab, setMobileTab] = useState("calendar"); // "calendar" | "queue" | "config"
  const weekDayCount = isMobile ? 3 : 7;
  const [events, setEvents] = useState([]);
  
  // Panel mode: "idle" | "rigid-config" | "flex-config" | "settings"
  // | "calendar-create" | "calendar-config" | "calendar-import"
  const [panelMode, setPanelMode] = useState("idle");
  const [isQueueCollapsed, setIsQueueCollapsed] = useState(false);
  const [leftPanelWidth, setLeftPanelWidth] = useState(LEFT_PANEL_DEFAULT_WIDTH);
  const [isLeftPanelCollapsed, setIsLeftPanelCollapsed] = useState(false);
  const [queueWidth, setQueueWidth] = useState(QUEUE_PANEL_DEFAULT_WIDTH);
  const [isDraggingLeftPanel, setIsDraggingLeftPanel] = useState(false);
  const [isDraggingQueuePanel, setIsDraggingQueuePanel] = useState(false);
  const [panelLayoutLoaded, setPanelLayoutLoaded] = useState(false);
  const lastPanelTapRef = useRef({ left: 0, queue: 0 });
  const [isTimezoneModeExpanded, setIsTimezoneModeExpanded] = useState(false);
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);
  const [isCategoryExpanded, setIsCategoryExpanded] = useState(false);
  const [isRepeatExpanded, setIsRepeatExpanded] = useState(false);
  // Recurring Flex Tasks. repeatForm is the flex panel's Repeat section
  // (a new task, or a repeating task being edited); editingRepeatDef is the
  // repeating task open in the flex panel, if any (the panel then edits the
  // definition, not a queue task). queueRepeatMode swaps the queue for the
  // list of repeating tasks.
  const [repeatForm, setRepeatForm] = useState(EMPTY_REPEAT_FORM);
  const [isFlexRepeatExpanded, setIsFlexRepeatExpanded] = useState(false);
  const [repeatError, setRepeatError] = useState(null);
  const [editingRepeatDef, setEditingRepeatDef] = useState(null);
  const [repeatingTasks, setRepeatingTasks] = useState([]);
  const [queueRepeatMode, setQueueRepeatMode] = useState(false);
  // Event type toggle for idle mode: "rigid" | "flex"
  const [eventTypeToggle, setEventTypeToggle] = useState("rigid");
  
  // Global settings state (persisted to backend)
  const [globalSettings, setGlobalSettings] = useState({
    minDuration: 15,
    timezone: "local",
    // false until settings load, so the minute check can't save over an
    // account it hasn't read yet.
    timezoneFollowsDevice: false,
    deviceTimezoneRecorded: false,
    notifyLeadMinutes: NOTIFY_LEAD_DEFAULT,
    extendIncrementMinutes: EXTEND_INCREMENT_DEFAULT,
    flexNotifications: true,
  });
  // Today's date in the account's timezone -- shared by the week header's
  // today circle and the now line, so the two can never disagree. Changes
  // state once a day (at the account timezone's midnight), not per minute.
  const zonedToday = useZonedToday(getEffectiveTimezone(globalSettings.timezone));
  // Recurring Flex Tasks: "today" for due days, from the stored timezone
  // setting exactly as the server reads it (the setting, else UTC) -- never the browser's zone, so the app's first-copy
  // and next-spawn dates (lib/repeatSchedule.js) match the server's spawner.
  // Only the not-yet-loaded placeholder is "local".
  const repeatToday = useZonedToday(
    globalSettings.timezone && globalSettings.timezone !== LOCAL_TIMEZONE_OPTION ? globalSettings.timezone : "UTC",
  );
  // A task to open once the queue is loaded: from a notification's link
  // ("/?task=<id>", opening the app) or its tap while the app is already
  // open (the service worker's "flexflow-open" message).
  const [focusTaskId, setFocusTaskId] = useState(() => taskIdFromUrl(window.location.href));
  const queueChangedRef = useRef(null);
  // True once the queue has been loaded from the server at least once, so a
  // task missing from it really is gone (see the focus effect).
  const flexEventsSyncedRef = useRef(false);
  // New-task saves waiting for that first load (see waitForFirstFlexSync).
  const flexSyncWaitersRef = useRef([]);
  const focusRetriedRef = useRef(null);
  // Push notifications arriving while the app is open and focused show as an
  // in-app notice (pushNotifications.js, public/sw.js).
  useInAppNotices({
    onOpenTask: setFocusTaskId,
    onQueueChanged: () => queueChangedRef.current && queueChangedRef.current(),
  });
  // "Local (follows this device)" -- the device being used wins. The
  // page-load rule lives in fetchSettings; this hook runs the minute-tick
  // and activity (focus, click, keypress) rules.
  const [serverSettingsLoaded, setServerSettingsLoaded] = useState(false);
  const saveDeviceTimezone = useCallback((deviceTz) => {
    setGlobalSettings(prev => ({ ...prev, timezone: deviceTz, deviceTimezoneRecorded: true }));
    axios.put(`${API}/settings`, { timezone: deviceTz, device_timezone_recorded: true })
      .catch((error) => console.error("Failed to save device timezone:", error));
  }, []);
  const refetchStoredTimezone = useCallback(async () => {
    try {
      const s = (await axios.get(`${API}/settings`)).data;
      const followsDevice = s.timezone_follows_device !== false;
      setGlobalSettings(prev => (
        prev.timezone === s.timezone && prev.timezoneFollowsDevice === followsDevice
          ? prev
          : { ...prev, timezone: s.timezone, timezoneFollowsDevice: followsDevice }
      ));
      return { timezone: s.timezone, followsDevice };
    } catch (error) {
      console.error("Failed to re-read settings:", error);
      return null;
    }
  }, []);
  useDeviceTimezoneSync({
    enabled: serverSettingsLoaded,
    followsDevice: globalSettings.timezoneFollowsDevice,
    storedTz: globalSettings.timezone,
    fetchStored: refetchStoredTimezone,
    save: saveDeviceTimezone,
  });
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsForm, setSettingsForm] = useState({
    minDuration: "15",
    timezone: "local",
  });

  // Placed flex items state (all items with their fragments)
  const [placedFlexItems, setPlacedFlexItems] = useState([]);
  
  const [editingEvent, setEditingEvent] = useState(null);
  const [rigidEditScope, setRigidEditScope] = useState("series"); // "instance" | "series" | "now-and-future"
  const [rigidSaveError, setRigidSaveError] = useState(null);
  // All-day strip (week/day views): past ALL_DAY_STRIP_ROWS lanes it shows
  // "+N more" until expanded.
  const [allDayStripExpanded, setAllDayStripExpanded] = useState(false);
  const [eventForm, setEventForm] = useState({
    title: "",
    description: "",
    start_time: "",
    end_time: "",
    all_day: false,
    category: "Work",
    recurrence: "none",
    recurrence_end_date: "",
    days_of_week: [],
    ...DEFAULT_RECURRENCE_FIELDS,
    timezone_mode: "absolute",
    home_timezone: null,
  });

  // Flex events state
  const [flexEvents, setFlexEvents] = useState([]);
  const [selectedFlexId, setSelectedFlexId] = useState(null);
  const [checkedFlexIds, setCheckedFlexIds] = useState([]);
  const [hoveredFlexId, setHoveredFlexId] = useState(null);
  const tooltipElRef = useRef(null);
  const [editingFlexEvent, setEditingFlexEvent] = useState(null);
  const [isNewFlexItem, setIsNewFlexItem] = useState(false);

  // Calendars state
  const [calendars, setCalendars] = useState([]);
  const [calendarsLoaded, setCalendarsLoaded] = useState(false);
  // The row bell (view-prefs `notify`): event reminders for that calendar.
  // Independent of the task-notifications setting.
  const [calendarNotifyStates, setCalendarNotifyStates] = useState({}); // calendarId -> bool
  // Tasks are scheduled around the events on every calendar the user can see.
  const allCalendarIds = useMemo(() => calendars.map((cal) => cal.id), [calendars]);
  // Per-event calendar membership -- populated only while the rigid event
  // form is open: the calendars the event being created/edited belongs to.
  const [formCalendarIds, setFormCalendarIds] = useState([]);
  // Remembers the most recent explicit calendar-membership choice made via
  // the checkbox above, so opening a new event defaults to what the user
  // last picked instead of snapping back to the oldest calendar every time.
  const [lastFormCalendarIds, setLastFormCalendarIds] = useState(null);
  const [isCalendarListExpanded, setIsCalendarListExpanded] = useState(false);
  const [newCalendarName, setNewCalendarName] = useState("");
  const [newCalendarColor, setNewCalendarColor] = useState("#3B82F6");
  const [deletingCalendar, setDeletingCalendar] = useState(null);
  const [deleteCalendarError, setDeleteCalendarError] = useState(null);
  // Calendar Sharing feature Phase 2 -- wired to the real access join table.
  // See CalendarSharing.js.
  // Which calendar the calendar-config panel (the row's gear) is showing.
  // Rename, recolor, sharing and .ics import/export all live behind it.
  const [configCalendarId, setConfigCalendarId] = useState(null);
  // Staged Calendar Editing -- calendar-config's draft. Edits below touch
  // only this object; nothing hits the backend until Save. Mirrors the
  // flexForm/originalFlexForm pattern used for task edit (init-on-open,
  // draft-only mutation, explicit Cancel/Save). See the lifecycle effect
  // near renderCalendarConfigPanel for how it's built and discarded.
  const [calendarConfigDraft, setCalendarConfigDraft] = useState(null);
  const originalCalendarConfigDraftRef = useRef(null);
  // Bumped after every calendar-config Save settles (success or partial
  // failure) so CalendarRosterPanel remounts and refetches the real
  // roster -- a failed staged share-add must not linger as an optimistic
  // row once we know it was never actually persisted.
  const [rosterRefreshNonce, setRosterRefreshNonce] = useState(0);
  // Save-in-flight + per-field error messages for calendar-config -- UI
  // feedback only, not part of the draft snapshot itself (so it doesn't
  // get diffed against on the next Save). Reset whenever a fresh draft
  // opens, alongside calendarConfigDraft.
  const [calendarConfigSaveState, setCalendarConfigSaveState] = useState({ saving: false, fieldErrors: {} });
  const [isAddCalendarChoiceOpen, setIsAddCalendarChoiceOpen] = useState(false); // Import/Create split
  const [calendarsFetchError, setCalendarsFetchError] = useState(null);
  const [addCalendarError, setAddCalendarError] = useState(null);
  const [addButtonBlockedMessage, setAddButtonBlockedMessage] = useState(false);
  const [flexForm, setFlexForm] = useState({
    name: "",
    duration: "",
  });
  const [originalFlexForm, setOriginalFlexForm] = useState({
    name: "",
    duration: "",
  });
  
  // Drag state for flex queue
  const dragItem = useRef(null);
  const dragOverItem = useRef(null);
  // Which flex item is currently being click-and-held (dragged) in the queue
  // list, if any -- state (not a ref) so the grey-lock visual re-renders the
  // instant a drag starts, per Priority Phase 3 Part B.
  const [draggingFlexId, setDraggingFlexId] = useState(null);

  // Task Deadlines Part 3 -- cascade warning dialog. Set to
  // { names, onConfirm, onCancel } when a create/edit/drag's candidate
  // check finds newly-affected deadline tasks; null otherwise. onConfirm
  // runs the actual persist (the candidate call itself never persists).
  const [cascadeWarning, setCascadeWarning] = useState(null);
  // Names surfaced by the dialog above also drive a live highlight on the
  // affected queue rows -- separate from lockedFlexIds/deadlineLockedIds,
  // which gate drag legality rather than flag a pending cascade.
  const [cascadeAffectedIds, setCascadeAffectedIds] = useState(new Set());

  // Priority Phase 3 Part B -- grey-lock "focus" derivation. A drag in
  // progress always takes precedence over the open form (holding item B
  // while editing item A must reflect B's priority without touching
  // panelMode). If the dragged item IS the one being edited, its live
  // flexForm.priority is used instead of its stale flexEvents-array value
  // (priority-dropdown changes only update flexForm, never flexEvents --
  // see handleFlexPriorityChange), so the grey-lock never lags what's shown
  // in the open form, and never locks the edited item against itself.
  const focusItemId = draggingFlexId ?? (panelMode === "flex-config" ? selectedFlexId : null);
  let focusPriority = null;
  if (draggingFlexId) {
    const isDraggedItemBeingEdited = panelMode === "flex-config" && draggingFlexId === selectedFlexId;
    focusPriority = isDraggedItemBeingEdited
      ? (flexForm.priority || 3)
      : (flexEvents.find(i => i.id === draggingFlexId)?.priority ?? 3);
  } else if (panelMode === "flex-config") {
    focusPriority = flexForm.priority || 3;
  }
  // Bidirectional: any item in a different tier than the focus item locks --
  // both more important (lower priority number) and less important (higher
  // number). Only same-tier items stay fully interactive.
  const lockedFlexIds = focusPriority == null ? new Set() : new Set(
    flexEvents.filter(item => item.id !== focusItemId && (item.priority ?? 3) !== focusPriority).map(i => i.id)
  );
  // Drag-boundary range (bidirectional), computed directly from priority
  // comparisons rather than lockedFlexIds membership -- that set no longer
  // carries "which side" information now that it locks both directions.
  // lowerBoundaryIndex = one past the last item with priority < focusPriority
  // (dropping before this would place a more-important item below the drag).
  // upperBoundaryIndex = the index of the first item with priority >
  // focusPriority (dropping past this would place a less-important item
  // above the drag). Correct even for an interleaved (non-tier-grouped)
  // array, since either boundary only needs the nearest offending item on
  // its own side. If the starting array is interleaved badly enough to make
  // the two bounds contradict (a more-important item sitting after a
  // less-important one, spanning 3+ tiers), clamp the upper bound up to the
  // lower one -- a single drag can't repair an already-broken multi-tier
  // arrangement in one move, so this defaults toward protecting
  // more-important items.
  let lowerBoundaryIndex = 0;
  let upperBoundaryIndex = flexEvents.length;
  if (focusPriority != null) {
    flexEvents.forEach((item, idx) => {
      if (item.id === focusItemId) return;
      const itemPriority = item.priority ?? 3;
      if (itemPriority < focusPriority) {
        lowerBoundaryIndex = idx + 1;
      } else if (itemPriority > focusPriority && idx < upperBoundaryIndex) {
        upperBoundaryIndex = idx;
      }
    });
    if (upperBoundaryIndex < lowerBoundaryIndex) {
      upperBoundaryIndex = lowerBoundaryIndex;
    }
  }

  // Task Deadlines Part 1 -- deadline grey-lock. Deliberately a separate
  // mechanism from the priority grey-lock above, not merged into it: this
  // one checks each task's *computed* placement (placedFlexItems), not a
  // stored field on the task, and it's one-directional -- only an upper
  // (later) bound, no lower bound, since a deadline only constrains how
  // late the focus task can land, never how early.
  let focusDeadline = null;
  if (draggingFlexId) {
    const isDraggedItemBeingEdited = panelMode === "flex-config" && draggingFlexId === selectedFlexId;
    focusDeadline = isDraggedItemBeingEdited
      ? (flexForm.deadline ? tzLocalToUtcIso(flexForm.deadline, globalSettings.timezone) : null)
      : (flexEvents.find(i => i.id === draggingFlexId)?.deadline ?? null);
  } else if (panelMode === "flex-config") {
    focusDeadline = flexForm.deadline ? tzLocalToUtcIso(flexForm.deadline, globalSettings.timezone) : null;
  }
  const deadlineLockedIds = new Set();
  let deadlineUpperBoundaryIndex = flexEvents.length;
  if (focusDeadline != null) {
    const focusDeadlineTime = new Date(focusDeadline).getTime();
    flexEvents.forEach((item, idx) => {
      if (item.id === focusItemId) return;
      const placedItem = placedFlexItems.find(p => p.flex_event_id === item.id);
      const itemStart = placedItem?.fragments?.[0]?.start_time;
      if (!itemStart) return;
      if (new Date(itemStart).getTime() >= focusDeadlineTime) {
        deadlineLockedIds.add(item.id);
        if (idx < deadlineUpperBoundaryIndex) {
          deadlineUpperBoundaryIndex = idx;
        }
      }
    });
  }

  const isRangeSelectingRef = useRef(false);
  const rangeSelectionMetaRef = useRef(null);
  
  const calendarRef = useRef(null);
  const rigidPanelRef = useRef(null);
  const flexPanelRef = useRef(null);

  // The active task's countdown state from the last POST /aging/sync: { activeId, aging, syncedAtMs (this device's
  // clock when the response landed), nextChangeInMs (how long after that the
  // server says the task pauses, resumes or finishes; null = no change
  // ahead), correction (seconds, see syncFlexEvents) }. A ref, not state:
  // the per-second clock re-render already redraws the countdown, and
  // nothing else needs to re-render when it changes.
  const agingSyncRef = useRef(null);
  const agingSyncTimerRef = useRef(null);
  // Only here to re-render once per second of this page's clock, so the
  // countdown redraws (see the useClock tick).
  const [, setCountdownSecond] = useState(0);
  // The latest flexEvents for syncFlexEvents, which also runs from timers
  // holding an older render's closure.
  const flexEventsRef = useRef([]);
  flexEventsRef.current = flexEvents;
  // In-flight guard for handleSaveFlexEvent -- blocks a second Save click
  // while one is already running, and drives the button's disabled/label
  // state for immediate feedback. State (not a ref) since the button needs
  // to re-render on it. Without this, rapid repeat clicks (no visible
  // feedback while a slow request is pending looked like nothing happened)
  // each fired a fully independent, concurrent create.
  const [isSavingFlexEvent, setIsSavingFlexEvent] = useState(false);

  // Sequence guard for fetchFlexPlacement: a fired-then-superseded request
  // can resolve after a newer one (out-of-order network responses), and
  // without this the stale response's setState wins. Each call stamps the
  // ref with its own id before awaiting; only the call whose id still
  // matches the ref when the response lands is allowed to setState.
  const flexPlacementRequestIdRef = useRef(0);
  // Same guard for fetchFlexEvents -- previously missing entirely, which let overlapping fire-and-forget GETs triggered
  // by concurrent creates resolve out of order and silently freeze local
  // queue state below DB truth.
  const flexEventsRequestIdRef = useRef(0);
  // GET /calendars staleness guard plus local view-pref write tracking --
  // see calendarsSync.js.
  const calendarsSyncRef = useRef(null);
  if (calendarsSyncRef.current === null) calendarsSyncRef.current = createCalendarsSync();
  // Same guard for fetchEvents -- a burst of day shifts (wheel/trackpad)
  // fires one GET per shift, and an out-of-order response would otherwise
  // paint a previous window's events into the current one.
  const eventsRequestIdRef = useRef(0);
  // Set by shiftWindowByDays so the scroll-to-8AM effect keeps the user's
  // hour position when the window moves by days instead of resetting it.
  const skipAutoScrollRef = useRef(false);
  // Staged Calendar Editing -- monotonic counter for pendingShareActions'
  // temp ids (stageShareAdd), a ref rather than a `let` so it survives
  // re-renders and can't collide across two adds in the same millisecond.
  const tempShareActionSeqRef = useRef(0);

  // Height of each hour row in the day/week views (must stay in sync with CSS)
  const HOUR_SLOT_HEIGHT = 60;
  const MAX_CASCADE_COLUMNS = 6;

  const getEventPositionStyle = (event, cascadeIndex = 0) => {
    const { hours: startH, minutes: startM } = getLocalizedHoursMinutes(event.start_time, globalSettings.timezone, event.timezone_mode, event.home_timezone);
    const { hours: endH, minutes: endM } = getLocalizedHoursMinutes(event.end_time, globalSettings.timezone, event.timezone_mode, event.home_timezone);
    const startMinutes = startH * 60 + startM;
    const rawEndMinutes = endH * 60 + endM;
    const endMinutes = rawEndMinutes <= startMinutes ? rawEndMinutes + 1440 : rawEndMinutes;
    const durationMinutes = Math.max(15, endMinutes - startMinutes);
    const minuteOffset = startMinutes % 60;
    const top = (minuteOffset / 60) * HOUR_SLOT_HEIGHT;
    const height = (durationMinutes / 60) * HOUR_SLOT_HEIGHT;
    const adjustedIndex = Math.min(cascadeIndex, MAX_CASCADE_COLUMNS - 1);
    const cascadeOffset = adjustedIndex * 3;

    return {
      position: "absolute",
      top: `${top + cascadeOffset}px`,
      height: `${height}px`,
      left: "16px",
      width: "calc(100% - 16px)",
      transform: `translateX(${cascadeOffset}px)`,
      overflow: "hidden",
      zIndex: 10 + adjustedIndex,
    };
  };

  const computeCascadeIndexes = (eventsForDay) => {
    const sortedEvents = [...eventsForDay].sort(
      (a, b) => new Date(a.start_time) - new Date(b.start_time)
    );
    const activeEvents = [];
    const indexes = new Map();

    sortedEvents.forEach((event) => {
      const start = new Date(event.start_time);
      const end = new Date(event.end_time);
      for (let i = activeEvents.length - 1; i >= 0; i--) {
        if (new Date(activeEvents[i].end_time) <= start) {
          activeEvents.splice(i, 1);
        }
      }
      const index = activeEvents.length;
      indexes.set(event.id, index);
      activeEvents.push(event);
    });

    return indexes;
  };

  const fetchEvents = useCallback(async () => {
    const requestId = ++eventsRequestIdRef.current;
    try {
      let startDate, endDate;
      const timezoneForRange = globalSettings.timezone;
      
      if (view === "month") {
        const monthStart = startOfMonth(currentDate);
        const monthEnd = endOfMonth(currentDate);
        const visibleStart = startOfWeek(monthStart);
        const visibleEnd = endOfWeek(monthEnd);
        startDate = getTimezoneDayBounds(visibleStart, timezoneForRange).dayStart;
        endDate = getTimezoneDayBounds(visibleEnd, timezoneForRange).dayEnd;
      } else if (view === "week") {
        // Rolling 7-day window (3-day on mobile): currentDate IS the window's
        // first day in week view (see shiftWindowByDays), not any day inside
        // a Sun-Sat week.
        const visibleStart = startOfDay(currentDate);
        const visibleEnd = addDays(visibleStart, weekDayCount - 1);
        startDate = getTimezoneDayBounds(visibleStart, timezoneForRange).dayStart;
        endDate = getTimezoneDayBounds(visibleEnd, timezoneForRange).dayEnd;
      } else {
        const bounds = getTimezoneDayBounds(currentDate, timezoneForRange);
        startDate = bounds.dayStart;
        endDate = bounds.dayEnd;
      }

      const response = await axios.get(`${API}/events`, {
        params: {
          start_date: startDate.toISOString(),
          end_date: endDate.toISOString(),
        },
      });
      if (requestId !== eventsRequestIdRef.current) return;
      setEvents(response.data);
    } catch (error) {
      console.error("Failed to fetch events:", error);
    }
  }, [currentDate, view, weekDayCount, globalSettings.timezone]);

  const fetchFlexEvents = useCallback(async () => {
    // Staleness guard (see flexEventsRequestIdRef declaration above) --
    // multiple overlapping calls can be in flight (every handleSaveFlexEvent
    // success fires one, not awaited), and only the response matching the
    // most recently *fired* call is allowed to apply, so an out-of-order
    // response from an earlier, now-superseded call can never overwrite
    // state with a smaller, stale picture of the queue.
    await syncFlexEvents(false);
    // syncFlexEvents only touches refs and state setters, so a stale closure is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The on-screen elapsed time for one task: the server's value as of the
  // last sync, plus the seconds this device has counted since then while the
  // server said the task is aging -- never past the moment the server said
  // that changes. Display only; nothing here is ever sent back.
  const displayElapsedSeconds = (item, nowMs = Date.now()) => {
    const base = item.FF_time_elapsed ?? 0;
    const sync = agingSyncRef.current;
    if (!sync || item.id !== sync.activeId) return base;
    let counted = 0;
    if (sync.aging) {
      const since = nowMs - sync.syncedAtMs;
      const capped = sync.nextChangeInMs === null ? since : Math.min(since, sync.nextChangeInMs);
      counted = Math.max(0, Math.floor(capped / 1000));
    }
    return Math.min(item.duration * 60, Math.max(0, base + counted + sync.correction));
  };

  // POST /aging/sync: the server brings elapsed times up to now and returns
  // the queue plus the active task's countdown state. Called on load, once a
  // minute, at the server's next_change_at, when the count reaches zero, and
  // wherever the queue used to be refetched. keepTemp keeps an unsaved new
  // task (isTemp, no server row yet) in the list -- the timed syncs can land
  // while one is being typed; the post-save refetches replace it as before.
  const settleFlexSyncWaiters = (items) => {
    const waiters = flexSyncWaitersRef.current;
    flexSyncWaitersRef.current = [];
    waiters.forEach((settle) => settle(items));
  };

  // A new task's queue position is worked out from this device's copy of the
  // queue, which is empty until the first sync applies. Saving from that
  // empty list sent an order holding only the new task, so it kept the top
  // spot above higher-priority tasks. Resolves
  // with the synced queue, or null if the sync failed or took over 15 s.
  const waitForFirstFlexSync = () => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 15_000);
    flexSyncWaitersRef.current.push((items) => { clearTimeout(timer); resolve(items); });
    syncFlexEvents(true);
  });

  const syncFlexEvents = async (keepTemp) => {
    // Staleness guard (see flexEventsRequestIdRef above): only the most
    // recently fired sync may apply.
    const requestId = ++flexEventsRequestIdRef.current;
    let data;
    try {
      ({ data } = await axios.post(`${API}/aging/sync`));
    } catch (error) {
      console.error("Failed to sync flex events:", error);
      // No newer sync is on its way, so a waiting save gives up.
      if (requestId === flexEventsRequestIdRef.current) settleFlexSyncWaiters(null);
      return;
    }
    if (requestId !== flexEventsRequestIdRef.current) return;
    const syncedAtMs = Date.now();
    const asOfMs = Date.parse(data.as_of);
    const next = data.next_change_at ? Date.parse(data.next_change_at) - asOfMs : null;
    // No visible jump: if the new server value is within 2 s of what's on
    // screen for the same task, keep showing the on-screen value (the two
    // follow the same rules, so any gap is just rounding and latency).
    const prev = agingSyncRef.current;
    let correction = 0;
    if (prev && prev.activeId && prev.activeId === data.active_id) {
      const shown = flexEventsRef.current.find((e) => e.id === data.active_id);
      const fresh = data.items.find((e) => e.id === data.active_id);
      if (shown && fresh) {
        const diff = displayElapsedSeconds(shown, syncedAtMs) - (fresh.FF_time_elapsed ?? 0);
        if (Math.abs(diff) <= 2) correction = diff;
      }
    }
    agingSyncRef.current = {
      activeId: data.active_id, aging: data.aging, syncedAtMs,
      nextChangeInMs: next === null ? null : Math.max(0, next), correction,
    };
    flexEventsSyncedRef.current = true;
    setFlexEvents((prevEvents) => {
      const localOnly = keepTemp ? prevEvents.filter((e) => e.isTemp) : [];
      return localOnly.length > 0 ? [...data.items, ...localOnly] : data.items;
    });
    settleFlexSyncWaiters(data.items);
    // Sync again the moment the server said the countdown changes state.
    clearTimeout(agingSyncTimerRef.current);
    if (next !== null) {
      agingSyncTimerRef.current = setTimeout(() => syncFlexEvents(true), Math.max(1000, next + 500));
    }
  };

  const fetchFlexPlacement = useCallback(async () => {
    console.log("fetchFlexPlacement called");
    const requestId = ++flexPlacementRequestIdRef.current;
    try {
      const timezoneOffset = getTimezoneOffsetMinutes(getEffectiveTimezone(globalSettings.timezone));
      const response = await axios.post(`${API}/flex-placement`, {
        flow_around_calendar_ids: allCalendarIds,
        timezone_offset: timezoneOffset,
        min_duration: globalSettings.minDuration,
      });
      console.log("Flex placement response:", response.data);
      if (requestId !== flexPlacementRequestIdRef.current) return;
      setPlacedFlexItems(response.data.placed_items || []);
    } catch (error) {
      console.error("Failed to fetch flex placement:", error);
      if (requestId !== flexPlacementRequestIdRef.current) return;
      setPlacedFlexItems([]);
    }
  }, [globalSettings, allCalendarIds]);

  // Task Deadlines Part 3: preview a hypothetical queue (create/edit/drag,
  // at its proposed position/duration/priority/deadline) against the
  // candidate endpoint and diff it against the currently-held
  // placedFlexItems baseline for every deadline-bearing task in the
  // hypothetical list. Returns the names of tasks newly affected (were
  // meeting their deadline or didn't exist yet, now missing it) -- a
  // pre-existing violation never counts as newly affected. Never persists
  // anything; a network failure here fails open (no dialog) rather than
  // blocking the edit, matching this codebase's existing
  // console.error-and-continue convention for preview/derived data.
  const checkDeadlineCascade = useCallback(async (candidateItems) => {
    try {
      const timezoneOffset = getTimezoneOffsetMinutes(getEffectiveTimezone(globalSettings.timezone));
      const response = await axios.post(`${API}/flex-placement/candidate`, {
        flow_around_calendar_ids: allCalendarIds,
        timezone_offset: timezoneOffset,
        min_duration: globalSettings.minDuration,
        candidate_items: candidateItems,
      });
      const baselineById = new Map(placedFlexItems.map(p => [p.flex_event_id, p]));
      const candidateById = new Map((response.data.placed_items || []).map(p => [p.flex_event_id, p]));
      const affected = [];
      for (const item of candidateItems) {
        if (!item.deadline) continue;
        const baseline = baselineById.get(item.id);
        const candidate = candidateById.get(item.id);
        const wasOk = !baseline || baseline.insufficient_time !== true;
        const nowBad = !!candidate && candidate.insufficient_time === true;
        if (wasOk && nowBad) {
          affected.push({ id: item.id, name: item.name });
        }
      }
      return affected;
    } catch (error) {
      console.error("Failed to check deadline cascade:", error);
      return [];
    }
  }, [globalSettings, allCalendarIds, placedFlexItems]);

  // Fetch persisted global settings on mount
  const fetchSettings = useCallback(async () => {
    try {
      const response = await axios.get(`${API}/settings`);
      const s = response.data;
      const followsDevice = s.timezone_follows_device !== false;
      setGlobalSettings({
        minDuration: s.min_duration,
        timezone: s.timezone,
        timezoneFollowsDevice: followsDevice,
        deviceTimezoneRecorded: !!s.device_timezone_recorded,
        notifyLeadMinutes: s.notify_lead_minutes ?? NOTIFY_LEAD_DEFAULT,
        extendIncrementMinutes: s.extend_increment_minutes ?? EXTEND_INCREMENT_DEFAULT,
        flexNotifications: s.flex_notifications !== false,
      });
      setSettingsLoaded(true);
      setServerSettingsLoaded(true);
      const loadTz = timezoneToSaveOnLoad({ followsDevice, recorded: !!s.device_timezone_recorded, deviceTz: getDeviceTimezone() });
      if (loadTz) saveDeviceTimezone(loadTz);
    } catch (error) {
      console.error("Failed to fetch settings:", error);
      setSettingsLoaded(true);
    }
  }, [saveDeviceTimezone]);

  // Fetch the user's calendars (owned and shared with them).
  const fetchCalendars = useCallback(async () => {
    const sync = calendarsSyncRef.current;
    const ticket = sync.beginFetch();
    try {
      const response = await axios.get(`${API}/calendars`);
      const fetchedCalendars = sync.apply(ticket, response.data || []);
      if (fetchedCalendars === null) return; // a newer fetch will apply
      setCalendars(fetchedCalendars);
      setCalendarsLoaded(true);
      setCalendarsFetchError(null);
    } catch (error) {
      if (!sync.isLatest(ticket)) return;
      console.error("Failed to fetch calendars:", error);
      setCalendarsLoaded(true);
      setCalendarsFetchError(error.response?.data?.detail || "Failed to load calendars");
    }
  }, []);

  const createCalendar = useCallback(async (name, color) => {
    try {
      // The create panel transitions straight into calendar-config for the
      // new calendar, so the caller needs its id back, not just a bare ok.
      const response = await axios.post(`${API}/calendars`, { name, color });
      await fetchCalendars();
      return { ok: true, calendar: response.data };
    } catch (error) {
      console.error("Failed to create calendar:", error);
      return { ok: false, message: error.response?.data?.detail || "Failed to create calendar" };
    }
  }, [fetchCalendars]);

  // ICS import/export (2026-10-17). Import goes through one endpoint twice:
  // dry_run (the preview) and then for real. Export is fetched with the
  // auth header and saved from a Blob, since a plain link can't send it.
  const runIcsImport = useCallback(async (body, dryRun) => {
    try {
      const response = await axios.post(`${API}/import/ics`, { ...body, dry_run: dryRun });
      return { ok: true, data: response.data };
    } catch (error) {
      console.error("ICS import failed:", error);
      return { ok: false, message: error.response?.data?.detail || "Couldn't import that file" };
    }
  }, []);

  const downloadIcs = useCallback(async (path, fallbackName) => {
    try {
      const response = await axios.get(`${API}${path}`, { responseType: "blob" });
      const disposition = response.headers?.["content-disposition"] || "";
      const name = (disposition.match(/filename="([^"]+)"/) || [])[1] || fallbackName;
      const url = URL.createObjectURL(response.data);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      console.error("ICS export failed:", error);
      toast.error("Couldn't export that calendar. Try again.");
    }
  }, []);

  const updateCalendar = useCallback(async (calendarId, updates) => {
    try {
      await axios.patch(`${API}/calendars/${calendarId}`, updates);
      await fetchCalendars();
      return { ok: true };
    } catch (error) {
      console.error("Failed to update calendar:", error);
      return { ok: false, message: error.response?.data?.detail || "Failed to update calendar" };
    }
  }, [fetchCalendars]);

  const deleteCalendar = useCallback(async (calendarId) => {
    try {
      await axios.delete(`${API}/calendars/${calendarId}`);
      await fetchCalendars();
      // Orphaned events are deleted server-side and shared ones lose a
      // calendar_ids entry -- refetch so the grid reflects both without a
      // stale reload.
      await fetchEvents();
      return { ok: true };
    } catch (error) {
      console.error("Failed to delete calendar:", error);
      return { ok: false, message: error.response?.data?.detail || "Failed to delete calendar" };
    }
  }, [fetchCalendars, fetchEvents]);

  // Calendar Sharing feature Phase 2 -- API wiring passed into
  // CalendarSharing.js's components, which stay free of axios/API-constant
  // coupling themselves.
  const shareCalendarWithUser = useCallback(async (calendarId, { email, permission, detail }) => {
    try {
      const response = await axios.post(`${API}/calendars/${calendarId}/share`, {
        email,
        permission_level: permission,
        detail_level: detail,
      });
      return { ok: true, access: response.data };
    } catch (error) {
      console.error("Failed to share calendar:", error);
      return { ok: false, message: error.response?.data?.detail || "Failed to share calendar" };
    }
  }, []);

  // Calendar Sharing feature Phase 3b -- resends the invite email on a
  // share's existing token (no rotation). Distinguishes a cooldown 429
  // (server-side throttle) from a
  // genuine failure so the roster row can show a countdown instead of a
  // generic error for the former.
  const resendShareInvite = useCallback(async (calendarId, accessId) => {
    try {
      const response = await axios.post(`${API}/calendars/${calendarId}/access/${accessId}/resend-invite`);
      return { ok: true, emailSent: response.data.email_sent };
    } catch (error) {
      if (error.response?.status === 429) {
        return { ok: false, cooldown: true, retryAfterSeconds: error.response.data?.detail?.retry_after_seconds || 0 };
      }
      console.error("Failed to resend invite:", error);
      return { ok: false, message: error.response?.data?.detail || "Failed to resend invite" };
    }
  }, []);

  const fetchCalendarRoster = useCallback(async (calendarId) => {
    try {
      const response = await axios.get(`${API}/calendars/${calendarId}/access`);
      return { ok: true, roster: response.data || [] };
    } catch (error) {
      console.error("Failed to fetch calendar roster:", error);
      return { ok: false, message: error.response?.data?.detail || "Failed to load who has access" };
    }
  }, []);

  // Owner revoking someone else's access from the roster panel -- the
  // owner's own calendar list is unaffected, so no refetch needed here.
  const removeCalendarAccess = useCallback(async (calendarId, accessId) => {
    try {
      await axios.delete(`${API}/calendars/${calendarId}/access/${accessId}`);
      return { ok: true };
    } catch (error) {
      console.error("Failed to remove calendar access:", error);
      return { ok: false, message: error.response?.data?.detail || "Failed to remove access" };
    }
  }, []);

  // Recipient leaving a calendar shared with them -- same DELETE endpoint as
  // removeCalendarAccess above (deleting your own access row), but the
  // calendar disappears from the leaving user's own list, so this refetches
  // like deleteCalendar does.
  const leaveSharedCalendar = useCallback(async (calendarId, accessId) => {
    try {
      await axios.delete(`${API}/calendars/${calendarId}/access/${accessId}`);
      await fetchCalendars();
      await fetchEvents();
      return { ok: true };
    } catch (error) {
      console.error("Failed to leave shared calendar:", error);
      return { ok: false, message: error.response?.data?.detail || "Failed to remove this calendar" };
    }
  }, [fetchCalendars, fetchEvents]);

  // Staged Calendar Editing -- these four replace shareCalendarWithUser/
  // removeCalendarAccess as the onShare/onRemove props passed into
  // CalendarRosterPanel while calendar-config is open. Nothing here hits
  // the network; the real POST/DELETE calls happen from
  // handleSaveCalendarConfig. CalendarRosterPanel already updates its own
  // local roster state optimistically from whatever these return
  // (CalendarSharing.js's handleAddRecipient/handleRemove), so a synthetic
  // { ok: true, ... } result is enough to reuse it unmodified for the
  // pending case.
  const stageShareAdd = (calendarId, { email, permission, detail }) => {
    const tempId = `pending-share-${Date.now()}-${++tempShareActionSeqRef.current}`;
    setCalendarConfigDraft((prev) => {
      if (!prev || calendarId !== configCalendarId) return prev;
      const action = {
        id: tempId, type: "add",
        payload: { email, permission, detail },
        status: "pending", error: null,
      };
      return { ...prev, pendingShareActions: [...(prev.pendingShareActions || []), action] };
    });
    return Promise.resolve({
      ok: true,
      access: {
        id: tempId, email, permission_level: permission, detail_level: detail,
        has_account: false, feed_url: "", created_at: new Date().toISOString(),
        email_sent: null, __pending: true,
      },
    });
  };

  const stageShareRemove = (calendarId, accessId) => {
    setCalendarConfigDraft((prev) => {
      if (!prev || calendarId !== configCalendarId) return prev;
      const isTempAdd = (prev.pendingShareActions || []).some((a) => a.id === accessId && a.type === "add");
      if (isTempAdd) {
        // Never became a real request -- just drop the queued add.
        return { ...prev, pendingShareActions: prev.pendingShareActions.filter((a) => a.id !== accessId) };
      }
      const action = {
        id: `pending-remove-${accessId}`, type: "remove",
        payload: { accessId }, status: "pending", error: null,
      };
      return { ...prev, pendingShareActions: [...(prev.pendingShareActions || []), action] };
    });
    return Promise.resolve({ ok: true });
  };

  // A failed add is not left for a blind resend -- an invalid-email (or
  // other validation) failure fails the exact same way on an unmodified
  // retry. editShareAction writes into the *same* queue entry (not a new
  // one) and clears status/error so the next Save retries with the
  // corrected value; discardShareAction drops it entirely, separate from
  // editing, since the user may decide not to invite that person at all.
  const editShareAction = (actionId, email) => {
    setCalendarConfigDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        pendingShareActions: (prev.pendingShareActions || []).map((a) =>
          a.id === actionId ? { ...a, payload: { ...a.payload, email }, status: "pending", error: null } : a
        ),
      };
    });
  };

  const discardShareAction = (actionId) => {
    setCalendarConfigDraft((prev) => {
      if (!prev) return prev;
      return { ...prev, pendingShareActions: (prev.pendingShareActions || []).filter((a) => a.id !== actionId) };
    });
  };

  // hasNewShares badge -- no server-side "unread" column (decision 2 keeps
  // the access join table free of status columns), so "new" is derived
  // client-side by comparing shared calendars' access_created_at against a
  // last-viewed timestamp. That timestamp is namespaced per user id in
  // localStorage rather than a bare key -- a bare key previously leaked
  // panelMode across accounts on a shared browser; namespacing avoids
  // repeating that.
  const sharedCalendars = useMemo(() => calendars.filter((cal) => !cal.is_owner), [calendars]);
  // Only owned calendars count toward the "last remaining calendar" guard
  // -- matches the backend's delete_calendar check, which counts
  // CalendarModel rows by owner and never includes shared-in calendars.
  // Used by both the delete confirmation flow and the calendar-config
  // panel's Delete section.
  const ownedCalendarCount = useMemo(() => calendars.filter((c) => c.is_owner).length, [calendars]);
  const sharesLastViewedKey = session?.user?.id ? `flexflow_shares_last_viewed_${session.user.id}` : null;
  // Mirrors localStorage as real state (rather than reading it imperatively
  // inside a memo) so hasNewShares recomputes on a normal React dependency
  // instead of needing a synthetic "force recompute" version counter.
  const [sharesLastViewedAt, setSharesLastViewedAt] = useState(null);
  useEffect(() => {
    setSharesLastViewedAt(sharesLastViewedKey ? localStorage.getItem(sharesLastViewedKey) : null);
  }, [sharesLastViewedKey]);

  // Mobile layout: remember the last calendar view (month / day / three-day)
  // per user across reloads. Mobile only -- desktop's view never touches
  // this key. The ref holds which key has been read, so the save effect
  // can't overwrite the stored view with the initial "month" before the
  // read has applied.
  const mobileViewKey = session?.user?.id ? `flexflow_mobile_view_${session.user.id}` : null;
  const mobileViewLoadedKeyRef = useRef(null);
  useEffect(() => {
    if (!isMobile || !mobileViewKey || mobileViewLoadedKeyRef.current === mobileViewKey) return;
    mobileViewLoadedKeyRef.current = mobileViewKey;
    try {
      const saved = localStorage.getItem(mobileViewKey);
      if (saved === "month" || saved === "week" || saved === "day") {
        if (saved === "week") setCurrentDate(startOfDay(new Date()));
        setView(saved);
      }
    } catch {
      // Storage unavailable (private mode etc.) -- just start on month.
    }
  }, [isMobile, mobileViewKey]);
  useEffect(() => {
    if (!isMobile || !mobileViewKey || mobileViewLoadedKeyRef.current !== mobileViewKey) return;
    try {
      localStorage.setItem(mobileViewKey, view);
    } catch {
      // Not remembered this time; nothing else depends on it.
    }
  }, [isMobile, mobileViewKey, view]);

  // Mobile layout: anything that opens the left panel's editor (tapping a
  // task, an event or a calendar cell, "+ new", settings...) switches to
  // the Config tab, otherwise the tap would look like it did nothing.
  useEffect(() => {
    if (isMobile && panelMode !== "idle") setMobileTab("config");
  }, [isMobile, panelMode]);

  // Mobile: no long-press menu anywhere except text fields (App.css turns
  // off text selection to match). Page-wide rather than per-row because a
  // held queue row stops receiving touches once its drag starts.
  useEffect(() => {
    if (!isMobile) return undefined;
    const onContextMenu = (e) => {
      if (e.target.closest?.('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, [isMobile]);

  const hasNewShares = useMemo(() => {
    const latestShareAt = sharedCalendars.reduce(
      (max, cal) => (cal.access_created_at && cal.access_created_at > max ? cal.access_created_at : max),
      ""
    );
    if (!latestShareAt) return false;
    return !sharesLastViewedAt || latestShareAt > sharesLastViewedAt;
  }, [sharedCalendars, sharesLastViewedAt]);

  // Acks whenever the shared-calendars list is opened, regardless of entry
  // point (profile menu's Messages -> Shared calendars, or "+ Add Calendar"
  // -> Import) -- both open the same "calendar-import" panel mode.
  useEffect(() => {
    if (panelMode === "calendar-import" && sharesLastViewedKey) {
      const now = new Date().toISOString();
      localStorage.setItem(sharesLastViewedKey, now);
      setSharesLastViewedAt(now);
    }
  }, [panelMode, sharesLastViewedKey]);

  // Calendar Sharing feature Phase 2: real per-calendar write-permission
  // check, replacing the old always-true stub. `is_owner`/`permission_level`
  // come straight from GET /calendars.
  const canWriteCalendar = (cal) => cal.is_owner || cal.permission_level === "write";

  // How much of a calendar's events this viewer sees, from their sharing
  // permission: 2 (titled and clickable) if they own it, have write access,
  // or were given a full-detail share; else 1 (busy blocks only).
  const calendarDetailLevel = (cal) =>
    (cal.is_owner || cal.permission_level === "write" || cal.detail_level === "full") ? 2 : 1;

  // The bell's value per calendar mirrors GET /calendars. A toggle writes
  // its value into `calendars` too (persistCalendarViewPref). Only a
  // calendar whose object changed takes its value from `calendars`; the
  // others keep what's on screen, so updating one calendar can't reset the
  // rest.
  const prevCalendarsRef = useRef([]);
  useEffect(() => {
    const prevById = new Map(prevCalendarsRef.current.map((cal) => [cal.id, cal]));
    prevCalendarsRef.current = calendars;
    const unchanged = (cal) => prevById.get(cal.id) === cal;
    const keepOrTake = (prev, cal, value) => (unchanged(cal) && cal.id in prev ? prev[cal.id] : value);
    setCalendarNotifyStates((prev) =>
      Object.fromEntries(calendars.map((cal) => [cal.id, keepOrTake(prev, cal, cal.notify !== false)])));
  }, [calendars]);

  // Guards against a dangling configCalendarId -- e.g. the calendar shown
  // in calendar-config was just deleted from inside that same panel.
  // renderCalendarConfigPanel already no-ops on a missing calendar, but
  // without this the panel would just go blank instead of returning to idle.
  useEffect(() => {
    if (panelMode === "calendar-config" && configCalendarId && !calendars.some((c) => c.id === configCalendarId)) {
      setPanelMode("idle");
      setConfigCalendarId(null);
    }
  }, [panelMode, configCalendarId, calendars]);

  // Staged Calendar Editing -- builds calendarConfigDraft from currently
  // persisted state.
  const buildCalendarConfigDraft = (calendarId) => {
    const cal = calendars.find((c) => c.id === calendarId);
    if (!cal) return null;
    return {
      name: cal.name,
      color: cal.color || DEFAULT_CALENDAR_COLOR,
      pendingShareActions: [],
    };
  };

  // Single lifecycle effect for the whole draft: builds a fresh one whenever
  // calendar-config becomes active for some calendarId, discards it (sets
  // null) on every other transition -- idle, any other panelMode, sign-out,
  // the dangling-calendar guard above, or switching straight to a different
  // calendar's gear. That covers every existing away-transition with no
  // per-site handling: closing the panel always means "discard," and
  // nothing here was ever sent to the backend, so there's nothing to undo.
  useEffect(() => {
    if (panelMode === "calendar-config" && configCalendarId) {
      const draft = buildCalendarConfigDraft(configCalendarId);
      setCalendarConfigDraft(draft);
      originalCalendarConfigDraftRef.current = draft;
    } else {
      setCalendarConfigDraft(null);
      originalCalendarConfigDraftRef.current = null;
    }
    setCalendarConfigSaveState({ saving: false, fieldErrors: {} });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelMode, configCalendarId]);

  useEffect(() => {
    const inRecovery = { current: false };
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        inRecovery.current = true;
        setSession("PASSWORD_RECOVERY");
      } else if ((event === "SIGNED_IN" || event === "INITIAL_SESSION") && inRecovery.current) {
        // suppress SIGNED_IN and INITIAL_SESSION that Supabase fires immediately after PASSWORD_RECOVERY
      } else {
        inRecovery.current = false;
        if (event === "SIGNED_OUT") {
          // App never unmounts across sign-out -- it just conditionally
          // renders AuthScreen -- so panel mode and any in-progress form
          // drafts would otherwise sit in memory and reappear on the next
          // sign-in. Discard them here rather than special-casing sign-in.
          setPanelMode("idle");
          resetEventForm();
          resetFlexForm();
          setConfigCalendarId(null);
        }
        setSession(session);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!dataSession) return;
    fetchSettings();
  }, [fetchSettings, dataSession]);

  // Stable identity on purpose: DemoBootstrap's own bootstrap effect closes
  // over this, and a new function every render is what made that effect
  // re-run and retry a failing sign-in in a loop.
  const handleDemoReady = useCallback(() => setDemoStatus("ready"), []);


  // Demo Mode -- the 403 the backend returns once a demo's two hours are up,
  // surfaced by the response interceptor from anywhere in the app.
  useEffect(() => {
    const onExpired = () => setDemoStatus("expired");
    window.addEventListener("flexflow-demo-expired", onExpired);
    return () => window.removeEventListener("flexflow-demo-expired", onExpired);
  }, []);

  useEffect(() => {
    try {
      const rawLayout = window.localStorage.getItem(PANEL_LAYOUT_KEY);
      if (rawLayout) {
        const savedLayout = JSON.parse(rawLayout);
        if (typeof savedLayout.leftPanelWidth === "number" && savedLayout.leftPanelWidth >= LEFT_PANEL_MIN_WIDTH && savedLayout.leftPanelWidth <= LEFT_PANEL_MAX_WIDTH) {
          setLeftPanelWidth(savedLayout.leftPanelWidth);
        }
        if (typeof savedLayout.isLeftPanelCollapsed === "boolean") {
          setIsLeftPanelCollapsed(savedLayout.isLeftPanelCollapsed);
        }
        if (typeof savedLayout.queueWidth === "number" && savedLayout.queueWidth >= QUEUE_PANEL_MIN_WIDTH && savedLayout.queueWidth <= QUEUE_PANEL_MAX_WIDTH) {
          setQueueWidth(savedLayout.queueWidth);
        }
        if (typeof savedLayout.isQueueCollapsed === "boolean") {
          setIsQueueCollapsed(savedLayout.isQueueCollapsed);
        }
      }
    } catch (error) {
      console.error("Failed to load panel layout preferences:", error);
    } finally {
      setPanelLayoutLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!dataSession) return;
    fetchEvents();
  }, [fetchEvents, dataSession]);

  useEffect(() => {
    if (!dataSession) return;
    fetchFlexEvents();
  }, [fetchFlexEvents, dataSession]);

  const fetchRepeatingTasks = useCallback(async () => {
    try {
      const response = await axios.get(`${API}/repeating-tasks`);
      setRepeatingTasks(response.data);
    } catch (error) {
      console.error("Failed to fetch repeating tasks:", error);
    }
  }, []);

  useEffect(() => {
    if (!dataSession) return;
    fetchRepeatingTasks();
  }, [fetchRepeatingTasks, dataSession]);

  useEffect(() => {
    if (!dataSession) return;
    fetchCalendars();
  }, [fetchCalendars, dataSession]);

  // Sync the queue with the server on load, when calendars or events
  // change, and once a minute.
  useEffect(() => {
    if (!settingsLoaded || !calendarsLoaded) return;
    syncFlexEvents(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded, calendarsLoaded, calendars, events]);

  useEffect(() => {
    if (!settingsLoaded || !calendarsLoaded) return undefined;
    const id = setInterval(() => syncFlexEvents(true), 60_000);
    return () => { clearInterval(id); clearTimeout(agingSyncTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded, calendarsLoaded]);

  useEffect(() => {
    if (!panelLayoutLoaded) return;

    try {
      window.localStorage.setItem(
        PANEL_LAYOUT_KEY,
        JSON.stringify({
          leftPanelWidth,
          isLeftPanelCollapsed,
          queueWidth,
          isQueueCollapsed,
        })
      );
    } catch (error) {
      console.error("Failed to save panel layout preferences:", error);
    }
  }, [leftPanelWidth, isLeftPanelCollapsed, queueWidth, isQueueCollapsed, panelLayoutLoaded]);

  useEffect(() => {
    // selectedEventId/selectedFlexId are included (not just panelMode) so
    // switching from one item's panel straight to a different item's --
    // without ever passing through "idle" -- re-focuses the panel too.
    // panelMode alone doesn't change on that kind of switch, so the effect
    // wouldn't otherwise re-run: focus stayed wherever the queue-item/
    // calendar-event click left it (nowhere useful, since those aren't
    // focusable), and the panel's onKeyDown-gated keyboard Delete shortcut
    // silently stopped working after a switch (bug found 2026-09-05; a
    // direct click on the Delete button was unaffected, since clicks don't
    // depend on focus).
    if (panelMode === "rigid-config") {
      rigidPanelRef.current?.focus();
    } else if (panelMode === "flex-config") {
      flexPanelRef.current?.focus();
    }
  }, [panelMode, selectedEventId, selectedFlexId]);

  useEffect(() => {
    setCheckedFlexIds((prev) => prev.filter((id) => flexEvents.some((item) => item.id === id)));
  }, [flexEvents]);

  // Fetch flex placement when flex events, rigid events, or settings change.
  // Only real flex events count (not an unsaved new task).
  useEffect(() => {
    if (!settingsLoaded) return;
    // Not refreshed while a task is open for editing; closing the panel
    // (panelMode is a dep) refreshes it.
    if (panelMode === "flex-config") return;
    const realFlexEvents = flexEvents.filter(e => !e.isTemp);
    console.log("Recalculating flex placement. Flex events:", realFlexEvents.length, "Rigid events:", events.length);
    if (realFlexEvents.length > 0) {
      fetchFlexPlacement();
    } else {
      setPlacedFlexItems([]);
    }
  }, [flexEvents, events, fetchFlexPlacement, settingsLoaded, panelMode]);

  // Day-by-Day Week Navigation -- the ONE action every day-shifting input
  // goes through (wheel/trackpad, single + double arrows, and any future
  // input such as a mobile touch swipe). In week view currentDate is the
  // rolling window's first day; in day view it's the shown day. Functional
  // update so a burst of wheel events can't read a stale currentDate.
  const shiftWindowByDays = useCallback((n) => {
    if (!n) return;
    skipAutoScrollRef.current = true;
    clearRangeSelection();
    setCurrentDate((prev) => addDays(startOfDay(prev), n));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePrevious = () => {
    if (view === "month") {
      setCurrentDate(subMonths(currentDate, 1));
    } else if (view === "week") {
      shiftWindowByDays(-weekDayCount);
    } else {
      setCurrentDate(addDays(currentDate, -1));
    }
  };

  const handleNext = () => {
    if (view === "month") {
      setCurrentDate(addMonths(currentDate, 1));
    } else if (view === "week") {
      shiftWindowByDays(weekDayCount);
    } else {
      setCurrentDate(addDays(currentDate, 1));
    }
  };

  const handleToday = () => {
    if (view === "week" && isMobile) {
      // Three-day window: just start it on today.
      setCurrentDate(startOfDay(new Date()));
      setSelectedDate(new Date());
      return;
    }
    if (view === "week") {
      // Keep the window's starting weekday: if today is already on screen,
      // do nothing; otherwise jump to the window that contains today and
      // starts on the same weekday as the current one.
      const windowStart = startOfDay(currentDate);
      const today = startOfDay(new Date());
      const offset = (today.getDay() - windowStart.getDay() + 7) % 7;
      const target = addDays(today, -offset);
      if (!isSameDay(target, windowStart)) {
        setCurrentDate(target);
      }
      setSelectedDate(new Date());
      return;
    }
    setCurrentDate(new Date());
    setSelectedDate(new Date());
  };

  const PANEL_TAP_MOVE_THRESHOLD = 4; // px -- above this, a touch is a drag, not a tap
  const PANEL_DOUBLE_TAP_WINDOW = 300; // ms between touchends to count as a double-tap

  // Shared drag-to-resize + double-tap-to-collapse for the left-panel and
  // flex-queue grip handles. Mouse double-click is handled separately via
  // each button's native onDoubleClick -- touch devices don't reliably
  // synthesize dblclick from two taps, so double-tap is tracked here by
  // hand (two touchends on the same handle within PANEL_DOUBLE_TAP_WINDOW,
  // neither of which moved past the tap threshold).
  const startPanelInteraction = (e, panel) => {
    const isTouch = e.type === "touchstart";
    if (!isTouch && e.button !== 0) return;

    const isLeft = panel === "left";
    const collapsed = isLeft ? isLeftPanelCollapsed : isQueueCollapsed;
    const point = isTouch ? e.touches[0] : e;
    const startX = point.clientX;
    const startWidth = isLeft ? leftPanelWidth : queueWidth;
    const minWidth = isLeft ? LEFT_PANEL_MIN_WIDTH : QUEUE_PANEL_MIN_WIDTH;
    const maxWidth = isLeft ? LEFT_PANEL_MAX_WIDTH : QUEUE_PANEL_MAX_WIDTH;
    const setWidth = isLeft ? setLeftPanelWidth : setQueueWidth;
    const setDragging = isLeft ? setIsDraggingLeftPanel : setIsDraggingQueuePanel;
    const setCollapsed = isLeft ? setIsLeftPanelCollapsed : setIsQueueCollapsed;

    let moved = false;

    if (!collapsed) {
      if (!isTouch) e.preventDefault();
      setDragging(true);
    }

    const handleMove = (moveEvent) => {
      const movePoint = isTouch ? moveEvent.touches[0] : moveEvent;
      const delta = movePoint.clientX - startX;
      if (Math.abs(delta) > PANEL_TAP_MOVE_THRESHOLD) moved = true;
      if (collapsed) return; // no live width to drag from while collapsed
      const viewportCap = window.innerWidth / 2;
      const next = Math.min(maxWidth, viewportCap, Math.max(minWidth, startWidth + delta));
      setWidth(next);
    };

    const handleEnd = (endEvent) => {
      setDragging(false);

      if (isTouch) {
        document.removeEventListener("touchmove", handleMove);
        document.removeEventListener("touchend", handleEnd);
        document.removeEventListener("touchcancel", handleEnd);

        if (endEvent.cancelable) endEvent.preventDefault();

        if (!moved) {
          const now = Date.now();
          const lastTap = lastPanelTapRef.current[panel] || 0;
          if (now - lastTap < PANEL_DOUBLE_TAP_WINDOW) {
            setCollapsed(prev => !prev);
            lastPanelTapRef.current[panel] = 0;
          } else {
            lastPanelTapRef.current[panel] = now;
          }
        }
      } else {
        document.removeEventListener("mousemove", handleMove);
        document.removeEventListener("mouseup", handleEnd);
      }
    };

    if (isTouch) {
      document.addEventListener("touchmove", handleMove, { passive: true });
      document.addEventListener("touchend", handleEnd);
      document.addEventListener("touchcancel", handleEnd);
    } else {
      document.addEventListener("mousemove", handleMove);
      document.addEventListener("mouseup", handleEnd);
    }
  };

  const resetEventForm = () => {
    setEventForm({
      title: "",
      description: "",
      start_time: "",
      end_time: "",
      all_day: false,
      category: "Work",
      recurrence: "none",
      recurrence_end_date: "",
      days_of_week: [],
      ...DEFAULT_RECURRENCE_FIELDS,
      timezone_mode: "absolute",
      home_timezone: null,
    });
    setRigidEditScope("instance");
    setEditingEvent(null);
    setFormCalendarIds([]);
    setRigidSaveError(null);
  };

  const resetFlexForm = () => {
    setFlexForm({
      name: "",
      duration: "",
      priority: 3,
      deadline: "",
    });
    setOriginalFlexForm({
      name: "",
      duration: "",
      priority: 3,
      deadline: "",
    });
    setEditingFlexEvent(null);
    setSelectedFlexId(null);
    setIsNewFlexItem(false);
    setRepeatForm(EMPTY_REPEAT_FORM);
    setIsFlexRepeatExpanded(false);
    setRepeatError(null);
    setEditingRepeatDef(null);
  };

  // Today's weekday (Sunday=0) in the account's timezone -- the weekly
  // Repeat default, matching the day the server counts as "today".
  const todayWeekdayInTz = () => {
    const [y, m, d] = utcIsoToTzLocal(new Date().toISOString(), globalSettings.timezone).slice(0, 10).split("-").map(Number);
    return new Date(y, m - 1, d).getDay();
  };

  const makeCellId = useCallback((date, hour) => {
    const dateStr = format(date, "yyyy-MM-dd");
    return hour !== undefined && hour !== null ? `${dateStr}-${hour}` : dateStr;
  }, []);

  const makeRangeCell = useCallback((date, hour) => ({
    cellId: makeCellId(date, hour),
    dayKey: format(date, "yyyy-MM-dd"),
    hour,
  }), [makeCellId]);

  const clearRangeSelection = useCallback(() => {
    setSelectedRange({ startCell: null, endCell: null });
    isRangeSelectingRef.current = false;
    rangeSelectionMetaRef.current = null;
  }, []);

  const parseSelectedCell = () => {
    if (!selectedCell) {
      return null;
    }

    const match = selectedCell.match(/^(\d{4}-\d{2}-\d{2})(?:-(\d{1,2}))?$/);
    if (!match) {
      return null;
    }

    const [, dateStr, hourStr] = match;
    const parsedDate = new Date(`${dateStr}T00:00:00`);

    if (Number.isNaN(parsedDate.getTime())) {
      return null;
    }

    return {
      date: parsedDate,
      hour: hourStr !== undefined ? Number(hourStr) : null,
    };
  };

  const updateRangeSelection = useCallback((date, hour) => {
    const meta = rangeSelectionMetaRef.current;
    if (!meta) {
      return null;
    }

    const nextCell = makeRangeCell(date, hour);
    if (meta.view === "week" && nextCell.dayKey !== meta.startCell.dayKey) {
      return meta.startCell;
    }

    setSelectedRange((prev) => {
      if (
        prev.startCell?.cellId === meta.startCell.cellId &&
        prev.endCell?.cellId === nextCell.cellId
      ) {
        return prev;
      }

      return {
        startCell: meta.startCell,
        endCell: nextCell,
      };
    });

    return nextCell;
  }, [makeRangeCell]);

  const isHourCellInSelectedRange = useCallback((date, hour) => {
    const { startCell, endCell } = selectedRange;
    if (!startCell || !endCell || startCell.hour === null || endCell.hour === null) {
      return false;
    }

    const dayKey = format(date, "yyyy-MM-dd");
    if (dayKey !== startCell.dayKey || dayKey !== endCell.dayKey) {
      return false;
    }

    const rangeStart = Math.min(startCell.hour, endCell.hour);
    const rangeEnd = Math.max(startCell.hour, endCell.hour);
    return hour >= rangeStart && hour <= rangeEnd;
  }, [selectedRange]);

  const scrollToEightAM = () => {
    if (!calendarRef.current) return;
    const header =
      calendarRef.current.querySelector(".week-day-headers") ||
      calendarRef.current.querySelector(".day-view-header");
    // The all-day strip sits inside the week header row but is excluded,
    // so the scroll lands where it did before the strip existed.
    const strip = header?.querySelector(".all-day-strip");
    const headerHeight = header ? header.offsetHeight - (strip ? strip.offsetHeight : 0) : 0;
    calendarRef.current.scrollTop = headerHeight + 8 * HOUR_SLOT_HEIGHT;
  };

  useEffect(() => {
    if (skipAutoScrollRef.current) {
      skipAutoScrollRef.current = false;
      return;
    }
    if (view === "week" || view === "day") {
      scrollToEightAM();
    } else if (calendarRef.current) {
      calendarRef.current.scrollTop = 0;
    }
  }, [view, currentDate]);

  // Shift+wheel / horizontal wheel / horizontal trackpad swipe shifts the
  // week window (or the day, in day view) by days; plain vertical wheel
  // keeps scrolling hours. Native listener, not React's onWheel, because
  // React registers wheel as passive and preventDefault is what stops the
  // browser's back/forward swipe navigation and horizontal page scroll.
  // Covers the day-header row and the grid alike (both inside calendarRef).
  useEffect(() => {
    if (view !== "week" && view !== "day") return undefined;
    const el = calendarRef.current;
    if (!el) return undefined;
    const handleWheel = createDayShiftWheel({ onShift: shiftWindowByDays });
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [view, shiftWindowByDays]);

  useEffect(() => {
    const handleDocumentMouseDown = (event) => {
      if (
        !event.target.closest("[data-range-cell='true']") &&
        !event.target.closest("[data-preserve-range-selection='true']")
      ) {
        clearRangeSelection();
      }
    };

    const handleDocumentMouseUp = () => {
      isRangeSelectingRef.current = false;
      rangeSelectionMetaRef.current = null;
    };

    document.addEventListener("mousedown", handleDocumentMouseDown);
    document.addEventListener("mouseup", handleDocumentMouseUp);

    return () => {
      document.removeEventListener("mousedown", handleDocumentMouseDown);
      document.removeEventListener("mouseup", handleDocumentMouseUp);
    };
  }, [clearRangeSelection]);



  // ============== RIGID EVENT HANDLERS ==============
  
  const openNewRigidEventPanel = (date, hour = null, endHour = null) => {
    resetEventForm();
    resetFlexForm();
    setSelectedEventId(null);

    const eventDate = date || currentDate;
    const startTime = hour !== null 
      ? setMinutes(setHours(eventDate, hour), 0)
      : setMinutes(setHours(eventDate, 9), 0);
    const endTime = endHour !== null
      ? setMinutes(setHours(eventDate, endHour + 1), 0)
      : hour !== null
      ? setMinutes(setHours(eventDate, hour + 1), 0)
      : setMinutes(setHours(eventDate, 10), 0);

    setEventForm({
      title: "",
      description: "",
      start_time: format(startTime, "yyyy-MM-dd'T'HH:mm"),
      end_time: format(endTime, "yyyy-MM-dd'T'HH:mm"),
      all_day: false,
      category: "Work",
      recurrence: "none",
      recurrence_end_date: "",
      days_of_week: [startTime.getDay()],
      ...DEFAULT_RECURRENCE_FIELDS,
      timezone_mode: "absolute",
      home_timezone: null,
    });
    setIsDescriptionExpanded(false);
    setIsCategoryExpanded(false);
    setIsRepeatExpanded(false);
    setRigidSaveError(null);
    setSelectedDate(eventDate);
    if (!selectedCell) {
      setSelectedCell(makeCellId(eventDate, hour));
    }
    // Default to whatever calendar(s) the user last explicitly picked via
    // the membership checkbox (filtered to ones still visible/accessible);
    // only fall back to the oldest calendar if nothing's been picked yet.
    // Having three calendars shown shouldn't triple-assign every new event;
    // additional calendars are opt-in via the membership checkbox in the
    // sidebar list.
    const rememberedCalendarIds = (lastFormCalendarIds || []).filter((id) =>
      calendars.some((cal) => cal.id === id)
    );
    setFormCalendarIds(
      rememberedCalendarIds.length > 0
        ? rememberedCalendarIds
        : calendars[0] ? [calendars[0].id] : []
    );
    setPanelMode("rigid-config");
  };

  const openEditRigidEventPanel = (event) => {
    resetFlexForm();
    setSelectedEventId(event.id);
    const editTimezone = event.timezone_mode === "naive"
      ? (event.home_timezone || globalSettings.timezone)
      : globalSettings.timezone;

    // All-day: the form keeps the first and last day (inclusive) with
    // 9:00-10:00 times, so switching it back to timed has times to show.
    // Its naive/UTC mode is the backend's to set; the form says absolute.
    const isAllDay = !!event.all_day;
    const editStartTime = isAllDay
      ? `${event.start_time.slice(0, 10)}T09:00`
      : utcIsoToTzLocal(event.start_time, editTimezone);
    const editEndTime = isAllDay
      ? `${shiftDayKey(event.end_time.slice(0, 10), -1)}T10:00`
      : utcIsoToTzLocal(event.end_time, editTimezone);
    setEventForm({
      title: event.title,
      description: event.description || "",
      start_time: editStartTime,
      end_time: editEndTime,
      all_day: isAllDay,
      category: event.category || "Work",
      recurrence: event.recurrence || "none",
      recurrence_end_date: event.recurrence_end_date
        ? format(new Date(event.recurrence_end_date), "yyyy-MM-dd")
        : "",
      days_of_week: event.days_of_week && event.days_of_week.length > 0
        ? event.days_of_week
        : [new Date(editStartTime).getDay()],
      recurrence_interval: String(event.recurrence_interval || 1),
      recurrence_ends: event.recurrence_count
        ? "after"
        : event.recurrence_end_date || event.recurrence === "none" ? "on" : "never",
      recurrence_count: String(event.recurrence_count || DEFAULT_RECURRENCE_FIELDS.recurrence_count),
      monthly_mode: event.monthly_week === -1 ? "last" : event.monthly_week ? "week" : "day",
      timezone_mode: isAllDay ? "absolute" : event.timezone_mode || "absolute",
      home_timezone: isAllDay ? null : event.home_timezone || null,
    });
    setIsDescriptionExpanded(!!(event.description && event.description.trim()));
    setIsCategoryExpanded(false);
    setIsRepeatExpanded(false);
    setRigidSaveError(null);
    setEditingEvent(event);
    setRigidEditScope("instance");
    setFormCalendarIds(event.calendar_ids || []);
    setSelectedCell(null);
    setSelectedDate(isAllDay
      ? new Date(`${event.start_time.slice(0, 10)}T12:00:00`)
      : getCalendarDateForTimezone(event.start_time, editTimezone));
    setPanelMode("rigid-config");
  };


  const handleSaveRigidEvent = async (scope = "series") => {
    const trimmedTitle = eventForm.title.trim();
    setRigidSaveError(null);

    const isRecurring = eventForm.recurrence !== "none";
    const recurrenceInterval = Number(eventForm.recurrence_interval);
    const recurrenceCount = Number(eventForm.recurrence_count);
    if (isRecurring && !(Number.isInteger(recurrenceInterval) && recurrenceInterval >= 1 && recurrenceInterval <= MAX_RECURRENCE_INTERVAL)) {
      setRigidSaveError(`"Every" must be a whole number from 1 to ${MAX_RECURRENCE_INTERVAL}.`);
      return;
    }
    if (isRecurring && eventForm.recurrence_ends === "on" && !eventForm.recurrence_end_date) {
      setRigidSaveError("Pick the date this event stops repeating, or choose Never.");
      return;
    }
    if (isRecurring && eventForm.recurrence_ends === "after"
        && !(Number.isInteger(recurrenceCount) && recurrenceCount >= 1 && recurrenceCount <= MAX_RECURRENCE_COUNT)) {
      setRigidSaveError(`"After" must be a whole number of times from 1 to ${MAX_RECURRENCE_COUNT}.`);
      return;
    }
    // A mode the current start date no longer allows falls back to "on the
    // date", matching what the monthly select shows.
    const monthlyPosition = monthlyPositionOf(eventForm.start_time);
    let monthlyWeek = null;
    if (eventForm.recurrence === "monthly" && monthlyPosition) {
      if (eventForm.monthly_mode === "week" && monthlyPosition.nth <= 4) monthlyWeek = monthlyPosition.nth;
      if (eventForm.monthly_mode === "last" && monthlyPosition.isLast) monthlyWeek = -1;
    }

    const allDayStartKey = eventForm.start_time.slice(0, 10);
    const allDayLastKey = eventForm.end_time.slice(0, 10);
    if (eventForm.all_day && (!allDayStartKey || !allDayLastKey)) {
      setRigidSaveError("Pick a start and end date.");
      return;
    }
    if (eventForm.all_day && allDayLastKey < allDayStartKey) {
      setRigidSaveError("The end date can't be before the start date.");
      return;
    }

    try {
      const preservedHomeTimezone = eventForm.home_timezone && eventForm.home_timezone !== "local"
        ? eventForm.home_timezone
        : getEffectiveTimezone(globalSettings.timezone);
      // All-day: UTC-midnight markers, the end being the day after the last.
      const startIso = eventForm.all_day
        ? `${allDayStartKey}T00:00:00.000Z`
        : eventForm.timezone_mode === "naive"
        ? tzLocalToUtcIso(eventForm.start_time, preservedHomeTimezone)
        : tzLocalToUtcIso(eventForm.start_time, globalSettings.timezone);
      const endIso = eventForm.all_day
        ? `${shiftDayKey(allDayLastKey, 1)}T00:00:00.000Z`
        : eventForm.timezone_mode === "naive"
        ? tzLocalToUtcIso(eventForm.end_time, preservedHomeTimezone)
        : tzLocalToUtcIso(eventForm.end_time, globalSettings.timezone);
      const baseTitle = trimmedTitle || "Item Name";
      const existingTitles = events
        .filter((e) => e.id !== editingEvent?.id && e.series_id !== editingEvent?.series_id)
        .map((e) => e.title);
      const titleToSave = getUniqueName(baseTitle, existingTitles);

      const eventData = {
        title: titleToSave,
        description: eventForm.description,
        start_time: startIso,
        end_time: endIso,
        all_day: !!eventForm.all_day,
        category: eventForm.category,
        recurrence: eventForm.recurrence,
        recurrence_end_date: isRecurring && eventForm.recurrence_ends === "on" && eventForm.recurrence_end_date
          ? new Date(eventForm.recurrence_end_date).toISOString()
          : null,
        days_of_week: eventForm.recurrence === "weekly" ? eventForm.days_of_week : null,
        recurrence_interval: isRecurring ? recurrenceInterval : null,
        recurrence_count: isRecurring && eventForm.recurrence_ends === "after" ? recurrenceCount : null,
        monthly_week: monthlyWeek,
        timezone_mode: eventForm.timezone_mode,
        home_timezone: eventForm.timezone_mode === "naive" ? preservedHomeTimezone : null,
      };

      if (editingEvent) {
        // calendar_ids now comes from the membership checkboxes (only
        // rendered while this form is open) -- the update endpoint
        // replaces junction rows wholesale when it's provided.
        await axios.put(`${API}/events/${editingEvent.id}`, { ...eventData, calendar_ids: formCalendarIds }, {
          params: { scope },
        });
      } else {
        const writableCalendarIds = formCalendarIds.filter((id) =>
          calendars.some((cal) => canWriteCalendar(cal) && cal.id === id)
        );
        await axios.post(`${API}/events`, { ...eventData, calendar_ids: writableCalendarIds });
      }

      setPanelMode("idle");
      setSelectedCell(null);
      resetEventForm();
      fetchEvents();
      // Mobile layout: back to the calendar, in whichever view was last open.
      if (isMobile) setMobileTab("calendar");
    } catch (error) {
      console.error("Failed to save event:", error.response?.data || error.message, error);
      setRigidSaveError(error.response?.data?.detail || "Failed to save event.");
    }
  };

  const handleDeleteRigidEvent = async (scope = "series") => {
    if (!editingEvent) return;

    try {
      await axios.delete(`${API}/events/${editingEvent.id}`, {
        params: { scope },
      });

      setPanelMode("idle");
      setSelectedEventId(null);
      resetEventForm();
      fetchEvents();
      if (isMobile) setMobileTab("calendar");
    } catch (error) {
      console.error("Failed to delete event:", error);
    }
  };

  // ============== FLEX EVENT HANDLERS ==============
  
  const openNewFlexEventPanel = () => {
    resetEventForm();
    resetFlexForm();
    setIsNewFlexItem(true);
    // The new task's row lives in the normal queue.
    setQueueRepeatMode(false);
    
    // Create a temporary local item (not saved to DB yet)
    const tempId = `temp-${Date.now()}`;
    const tempEvent = {
      id: tempId,
      name: "",
      duration: 60,
      // Priority Phase 3: no auto-repositioning -- append to the end
      // instead of always forcing the top, which used to place a new task
      // above higher-priority items regardless of what priority it'd get.
      // Positioning from here is manual (drag), boundary-constrained by
      // the grey-lock once a priority is chosen.
      position: flexEvents.length,
      priority: 3,
      deadline: null,
      completed: false,
      FF_time_elapsed: 0,
      isTemp: true, // Mark as temporary/unsaved
    };

    setFlexEvents(prev => [...prev, tempEvent]);
    setSelectedFlexId(tempId);
    setEditingFlexEvent(tempEvent);
    setFlexForm({
      name: "",
      duration: "",
      priority: 3,
      deadline: "",
    });
    setOriginalFlexForm({
      name: "",
      duration: "",
      priority: 3,
      deadline: "",
    });
    setPanelMode("flex-config");
  };

  const openEditFlexEventPanel = (flexEvent) => {
    resetEventForm();
    setSelectedEventId(null);
    setSelectedCell(null);
    setSelectedFlexId(flexEvent.id);
    setEditingFlexEvent(flexEvent);
    setIsNewFlexItem(false);

    const formData = {
      name: flexEvent.name,
      duration: String(flexEvent.duration),
      priority: flexEvent.priority ?? 3,
      deadline: flexEvent.deadline ? utcIsoToTzLocal(flexEvent.deadline, globalSettings.timezone) : "",
    };
    setFlexForm(formData);
    setOriginalFlexForm(formData);
    setPanelMode("flex-config");
  };

  // Recurring Flex Tasks: open a repeating task in the flex panel. The panel
  // then edits the definition (Save = PUT /repeating-tasks/{id}); no queue
  // row is selected.
  const openRepeatDefinitionPanel = (def) => {
    resetEventForm();
    resetFlexForm();
    setSelectedEventId(null);
    setSelectedCell(null);
    setEditingRepeatDef(def);
    const formData = { name: def.name, duration: String(def.duration), priority: def.priority ?? 3, deadline: "" };
    setFlexForm(formData);
    setOriginalFlexForm(formData);
    setRepeatForm({
      cadence: def.cadence,
      days_of_week: def.days_of_week && def.days_of_week.length > 0 ? def.days_of_week : [todayWeekdayInTz()],
      end_date: def.end_date || "",
      if_unfinished: def.if_unfinished || "skip",
    });
    setIsFlexRepeatExpanded(true);
    setPanelMode("flex-config");
  };

  // From a copy's read-only Repeat summary: show its repeating task.
  const viewRepeatDefinition = (definitionId) => {
    const def = repeatingTasks.find((d) => d.id === definitionId);
    if (!def) return;
    if (panelMode === "flex-config" && isNewFlexItem) {
      setFlexEvents(prev => prev.filter(i => i.id !== selectedFlexId));
    }
    setQueueRepeatMode(true);
    openRepeatDefinitionPanel(def);
  };

  // Queue header repeat button: swap between the queue and the list of
  // repeating tasks. Whatever the flex panel had open is discarded, as when
  // clicking another task.
  const toggleQueueRepeatMode = () => {
    if (panelMode === "flex-config") {
      handleCancelFlexEvent();
    }
    setQueueRepeatMode((on) => !on);
    if (!queueRepeatMode) fetchRepeatingTasks();
  };

  // Notification links: refetch the queue after a notice button changed it,
  // and open the task a notification pointed at once it's in the loaded
  // queue. A task not found is refetched once (it may have just been added,
  // e.g. a continue-later copy), then dropped quietly (finished, deleted).
  queueChangedRef.current = fetchFlexEvents;
  useEffect(() => {
    if (!focusTaskId || !flexEventsSyncedRef.current) return;
    const task = flexEvents.find((e) => e.id === focusTaskId);
    if (task) {
      openEditFlexEventPanel(task);
    } else if (focusRetriedRef.current !== focusTaskId) {
      focusRetriedRef.current = focusTaskId;
      fetchFlexEvents();
      return;
    }
    setFocusTaskId(null);
    if (taskIdFromUrl(window.location.href)) window.history.replaceState(null, "", window.location.pathname);
    // openEditFlexEventPanel is redefined every render; only these inputs matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTaskId, flexEvents]);

  const handleFlexNameChange = (e) => {
    const newName = e.target.value;
    setFlexForm(prev => ({ ...prev, name: newName }));
    // Live update in list
    setFlexEvents(prev => prev.map(i => i.id === selectedFlexId ? { ...i, name: newName } : i));
  };

  const handleFlexDurationChange = (e) => {
    const value = e.target.value.replace(/[^0-9]/g, '');
    setFlexForm(prev => ({ ...prev, duration: value }));
  };

  const handleFlexPriorityChange = (e) => {
    setFlexForm(prev => ({ ...prev, priority: parseInt(e.target.value, 10) }));
  };

  const handleFlexDeadlineChange = (e) => {
    setFlexForm(prev => ({ ...prev, deadline: e.target.value }));
  };

  const getEffectiveDuration = () => {
    return flexForm.duration === "" ? 60 : parseInt(flexForm.duration) || 0;
  };

  const handleStepUp = () => {
    const current = getEffectiveDuration();
    const step = globalSettings.minDuration;
    setFlexForm(prev => ({ ...prev, duration: String(current + step) }));
  };

  const handleStepDown = () => {
    const current = getEffectiveDuration();
    const step = globalSettings.minDuration;
    const newVal = Math.max(0, current - step);
    setFlexForm(prev => ({ ...prev, duration: String(newVal) }));
  };

  // Recurring Flex Tasks: the repeat payload for a POST or PUT, or null
  // when Repeat is off. Sets repeatError and returns false when invalid.
  const buildRepeatPayload = () => {
    if (repeatForm.cadence === "none") return null;
    if (repeatForm.cadence === "weekly" && repeatForm.days_of_week.length === 0) {
      setRepeatError("Pick at least one day.");
      setIsFlexRepeatExpanded(true);
      return false;
    }
    return {
      cadence: repeatForm.cadence,
      days_of_week: repeatForm.cadence === "weekly" ? repeatForm.days_of_week : null,
      end_date: repeatForm.end_date || null,
      if_unfinished: repeatForm.if_unfinished,
    };
  };

  const saveRepeatDefinition = async () => {
    const repeat = buildRepeatPayload();
    if (repeat === false) return;
    setIsSavingFlexEvent(true);
    try {
      await axios.put(`${API}/repeating-tasks/${editingRepeatDef.id}`, {
        name: flexForm.name || editingRepeatDef.name,
        duration: flexForm.duration === "" ? 60 : parseInt(flexForm.duration) || 60,
        priority: flexForm.priority || 3,
        ...repeat,
      });
      setPanelMode("idle");
      resetFlexForm();
      fetchRepeatingTasks();
      // Mobile layout: back to the list of repeating tasks.
      if (isMobile) setMobileTab("queue");
    } catch (error) {
      setRepeatError(error.response?.data?.detail || "Couldn't save the repeating task.");
      console.error("Failed to save repeating task:", error);
    } finally {
      setIsSavingFlexEvent(false);
    }
  };

  const handleSaveFlexEvent = async () => {
    // In-flight guard -- see the isSavingFlexEvent declaration above.
    if (isSavingFlexEvent) return;
    if (editingRepeatDef) {
      await saveRepeatDefinition();
      return;
    }
    // Repeat is only offered on a new task (a copy shows a summary instead).
    const repeatPayload = isNewFlexItem ? buildRepeatPayload() : null;
    if (repeatPayload === false) return;
    // Copy #1 is made on save only if today is a due day; otherwise only the
    // repeating task is saved and its first copy comes on its first due day.
    // The server decides; this mirrors it for the deadline preview and the
    // confirmation. Monthly repeats on today's date, so it is always due.
    const repeatRule = repeatPayload ? { ...repeatPayload, anchor_day: Number(repeatToday.slice(8, 10)) } : null;
    const seriesOnly = !!repeatRule && !repeatDueOn(repeatRule, repeatToday);
    setIsSavingFlexEvent(true);

    // The queue this save orders against. Before the first sync it would be
    // just the new task, so a new-task save waits for that sync (the button
    // shows "Saving…") and keeps the new task last, where the panel put it.
    let queue = flexEvents;
    if (isNewFlexItem && !flexEventsSyncedRef.current) {
      const synced = await waitForFirstFlexSync();
      if (!synced) {
        toast.error("Couldn't load your queue, so the task wasn't saved. Try again.");
        setIsSavingFlexEvent(false);
        return;
      }
      const temp = flexEvents.find(i => i.id === selectedFlexId);
      queue = temp && !synced.some(i => i.id === temp.id) ? [...synced, temp] : synced;
    }

    const finalDuration = flexForm.duration === "" ? 60 : parseInt(flexForm.duration) || 60;
    const finalPriority = flexForm.priority || 3;
    // Anything repeating has no deadline: a new task with Repeat on, or a
    // copy of a repeating task (saving a copy also clears any deadline it
    // was given before this rule).
    const isRepeatCopy = !isNewFlexItem && !!editingFlexEvent?.repeat_definition_id;
    const finalDeadline = flexForm.deadline && !repeatPayload && !isRepeatCopy ? tzLocalToUtcIso(flexForm.deadline, globalSettings.timezone) : null;

    let nameToSave = flexForm.name || "Item Name";
    const existingNames = queue
      .filter(i => i.id !== selectedFlexId)
      .map(i => i.name);
    nameToSave = getUniqueName(nameToSave, existingNames);

    // Re-sort the queue only when an existing task's priority is being
    // changed via edit -- a brand-new task keeps landing wherever it was
    // manually placed, with no auto-insert/auto-resort (see openNewFlexEventPanel).
    const priorityChanged = !isNewFlexItem && !!editingFlexEvent && finalPriority !== (originalFlexForm.priority || 3);
    const durationChanged = !isNewFlexItem && !!editingFlexEvent && finalDuration !== editingFlexEvent.duration;

    // Task Deadlines Part 3: preview the same resulting order the save
    // below will actually produce, before persisting anything.
    let hypotheticalOrder = queue;
    if (seriesOnly) {
      // No task joins the queue now.
      hypotheticalOrder = queue.filter(item => item.id !== selectedFlexId);
    } else if (isMobile && (isNewFlexItem || priorityChanged)) {
      // Mobile layout: no drag step, so a new task -- or an edited one whose
      // priority changed -- goes first among tasks of its priority (see
      // moveToFirstInTier). An unchanged priority keeps its queue position.
      hypotheticalOrder = moveToFirstInTier(queue, selectedFlexId, finalPriority);
    } else if (priorityChanged) {
      hypotheticalOrder = [...queue]
        .map(item => item.id === editingFlexEvent.id ? { ...item, priority: finalPriority } : item)
        .sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3));
    }
    // The edited item's values come from the open panel, not its saved row.
    const candidateItems = hypotheticalOrder.map(item => item.id === selectedFlexId ? {
      id: item.id, name: nameToSave, duration: finalDuration, priority: finalPriority,
      deadline: finalDeadline,
    } : {
      id: item.id, name: item.name, duration: item.duration, priority: item.priority ?? 3,
      deadline: item.deadline ?? null,
    });
    const affected = await checkDeadlineCascade(candidateItems);

    const performSave = async () => {
      try {
        if (isNewFlexItem) {
          // POST to create new event in database
          const createResponse = await axios.post(`${API}/flex-events`, {
            name: nameToSave,
            duration: finalDuration,
            priority: finalPriority,
            deadline: finalDeadline,
            // Recurring Flex Tasks: also creates the repeating task, with
            // this task as its copy #1 if today is a due day.
            ...(repeatPayload ? { repeat: repeatPayload } : {}),
            // No `position` field -- the server always assigns it atomically
            // now; a client-supplied value was a
            // real concurrency bug, and the reorder/batch call right below
            // already re-establishes the real intended order anyway.
          });
          if (createResponse.data.copy_created === false) {
            // Only the repeating task was saved: no queue row to place.
            const first = nextRepeatDay(repeatRule, repeatToday);
            if (first) toast(`First copy appears ${formatRepeatDay(first)}`);
          } else {
            // Persist the visual order — replace tempId with the real ID from the response,
            // then batch-reorder so positions match what the user sees
            const realId = createResponse.data.id;
            // Mobile layout: the order with the new task moved first in its tier.
            const orderedIds = (isMobile ? hypotheticalOrder : queue).map(i => i.id === selectedFlexId ? realId : i.id).filter(id => !id.startsWith("temp-"));
            await axios.put(`${API}/flex-events/reorder/batch`, { ordered_ids: orderedIds });
          }
          if (repeatPayload) fetchRepeatingTasks();
        } else if (editingFlexEvent) {
          if (priorityChanged) {
            const orderedIds = hypotheticalOrder.map(i => i.id).filter(id => !String(id).startsWith("temp-"));
            await axios.put(`${API}/flex-events/reorder/batch`, { ordered_ids: orderedIds });
          }
          // PUT to update existing event — only reset clock if duration actually changed
          await axios.put(`${API}/flex-events/${editingFlexEvent.id}`, {
            name: nameToSave,
            duration: finalDuration,
            priority: finalPriority,
            deadline: finalDeadline,
            // A duration change resets elapsed time on the server.
          });
        }

        setPanelMode("idle");
        resetFlexForm();
        fetchFlexEvents();
        // Mobile layout: show the queue so the user sees where it landed.
        if (isMobile) setMobileTab("queue");
      } catch (error) {
        if (repeatPayload) {
          // The panel stays open with the reason under Repeat, e.g. a
          // Repeat Until before the first day it would repeat on.
          setRepeatError(error.response?.data?.detail || "Couldn't save the repeating task.");
          setIsFlexRepeatExpanded(true);
        }
        console.error("Failed to save flex event:", error);
      } finally {
        // Always unblock the clock, even if the PUT threw
      }
    };

    if (affected.length > 0) {
      setCascadeAffectedIds(new Set(affected.map(a => a.id)));
      setCascadeWarning({
        names: affected.map(a => a.name),
        onConfirm: async () => {
          setCascadeWarning(null);
          setCascadeAffectedIds(new Set());
          await performSave();
          setIsSavingFlexEvent(false);
        },
        onCancel: () => {
          setCascadeWarning(null);
          setCascadeAffectedIds(new Set());
          setIsSavingFlexEvent(false);
        },
      });
      return;
    }

    await performSave();
    setIsSavingFlexEvent(false);
  };

  const handleCancelFlexEvent = () => {
    if (isNewFlexItem) {
      // Just remove the temporary local item (not in DB)
      setFlexEvents(prev => prev.filter(i => i.id !== selectedFlexId));
    } else if (editingFlexEvent) {
      // Revert to original values in list
      setFlexEvents(prev => prev.map(i => i.id === selectedFlexId ? { 
        ...i, 
        name: originalFlexForm.name,
      } : i));
    }
    setPanelMode("idle");
    resetFlexForm();
  };

  const handleDeleteFlexEvent = async () => {
    if (editingRepeatDef) {
      // Stops future copies; any copy in the queue stays as a plain task.
      try {
        await axios.delete(`${API}/repeating-tasks/${editingRepeatDef.id}`);
        setPanelMode("idle");
        resetFlexForm();
        fetchRepeatingTasks();
        fetchFlexEvents();
        if (isMobile) setMobileTab("queue");
      } catch (error) {
        console.error("Failed to delete repeating task:", error);
      }
      return;
    }
    if (!editingFlexEvent) return;
    
    try {
      await axios.delete(`${API}/flex-events/${editingFlexEvent.id}`);
      setPanelMode("idle");
      resetFlexForm();
      fetchFlexEvents();
      if (isMobile) setMobileTab("queue");
    } catch (error) {
      console.error("Failed to delete flex event:", error);
    }
  };

  const handleToggleFlexEventChecked = (id, e) => {
    e.stopPropagation();
    setCheckedFlexIds((prev) =>
      prev.includes(id) ? prev.filter((existingId) => existingId !== id) : [...prev, id]
    );
  };

  const handleDeleteCheckedFlexEvents = async () => {
    if (checkedFlexIds.length === 0) return;

    const checkedSet = new Set(checkedFlexIds);
    const checkedItems = flexEvents.filter((item) => checkedSet.has(item.id));
    const tempItems = checkedItems.filter((item) => item.isTemp);
    const persistedItems = checkedItems.filter((item) => !item.isTemp);

    if (tempItems.length > 0) {
      const tempIds = new Set(tempItems.map((item) => item.id));
      setFlexEvents((prev) => prev.filter((item) => !tempIds.has(item.id)));
    }

    try {
      if (persistedItems.length > 0) {
        await Promise.all(persistedItems.map((item) => axios.delete(`${API}/flex-events/${item.id}`)));
      }

      if (selectedFlexId && checkedSet.has(selectedFlexId)) {
        setPanelMode("idle");
        resetFlexForm();
      }

      setCheckedFlexIds([]);
      fetchFlexEvents();
    } catch (error) {
      console.error("Failed to delete selected flex events:", error);
    }
  };

  const handleCompleteCheckedFlexEvents = async () => {
    if (checkedFlexIds.length === 0) return;

    const checkedSet = new Set(checkedFlexIds);
    const checkedItems = flexEvents.filter((item) => checkedSet.has(item.id));
    const tempItems = checkedItems.filter((item) => item.isTemp);
    const persistedItems = checkedItems.filter((item) => !item.isTemp);

    if (tempItems.length > 0) {
      const tempIds = new Set(tempItems.map((item) => item.id));
      setFlexEvents((prev) => prev.filter((item) => !tempIds.has(item.id)));
    }

    if (tempItems.length > 0) {
      const tempIds = new Set(tempItems.map((item) => item.id));
      setFlexEvents((prev) => prev.filter((item) => !tempIds.has(item.id)));
    }
    // The server credits the time up to now, then freezes the remaining time.
    try {
      if (persistedItems.length > 0) {
        await Promise.all(
          persistedItems.map((item) => axios.put(`${API}/flex-events/${item.id}`, { completed: true }))
        );
      }

      if (selectedFlexId && checkedSet.has(selectedFlexId)) {
        setPanelMode("idle");
        resetFlexForm();
      }

      if (selectedFlexId && checkedSet.has(selectedFlexId)) {
        setPanelMode("idle");
        resetFlexForm();
      }

      setCheckedFlexIds([]);
      fetchFlexEvents();
    } catch (error) {
      console.error("Failed to complete selected flex events:", error);
    }
  };

  // Drag handlers for flex queue
  const handleDragStart = (index) => {
    const item = flexEvents[index];
    // Defensive -- draggable={!isLocked} on the row already prevents this,
    // matching this codebase's existing dual-layer disable pattern. Checks
    // both grey-lock mechanisms: priority tier and (Task Deadlines Part 1)
    // deadline.
    if (item && (lockedFlexIds.has(item.id) || deadlineLockedIds.has(item.id))) return;
    hideFlexTooltip();
    dragItem.current = index;
    setDraggingFlexId(item?.id ?? null);
  };
  const handleDragEnter = (index) => {
    // Bidirectional drag boundary: never let a hover land outside the
    // dragged item's own tier range. Index-based, not "is this row locked"
    // -- dropping at an index can precede/follow a locked item even when the
    // hovered row itself isn't locked (e.g. an interleaved, non-tier-grouped
    // queue).
    //
    // Downward hovers (index past the dragged item's own slot) need the
    // upper bound tightened by one: handleDragEnd's splice removes the
    // dragged item first, which shifts every later index down by one, so
    // landing "at" upperBoundaryIndex during a downward drag actually lands
    // AFTER the item there, not before it -- one step too far. The lower
    // bound doesn't need this: it's already defined one past its own
    // boundary item, which already absorbs that same shift.
    const isDownwardHover = dragItem.current !== null && index > dragItem.current;
    if (focusPriority !== null) {
      const effectiveUpperBound = isDownwardHover ? upperBoundaryIndex - 1 : upperBoundaryIndex;
      if (index < lowerBoundaryIndex || index > effectiveUpperBound) return;
    }
    // Task Deadlines Part 1: deadline grey-lock's boundary is upper-only
    // (no lower bound) -- combined with the priority boundary above by
    // taking the tighter (smaller) ceiling, same splice-shift adjustment
    // for a downward hover.
    if (focusDeadline !== null) {
      const effectiveDeadlineUpperBound = isDownwardHover ? deadlineUpperBoundaryIndex - 1 : deadlineUpperBoundaryIndex;
      if (index > effectiveDeadlineUpperBound) return;
    }
    dragOverItem.current = index;
  };
  // `options.showNow` (mobile touch drag only): show the new order on
  // release, in the same render that clears the drag's row transforms,
  // instead of after the conflict check's round trip -- otherwise the rows
  // snap back to their old slots until it answers. Cancel or a failed save
  // puts the previous order back. Desktop's onDragEnd passes the DragEvent,
  // which has no showNow, so it keeps waiting as before.
  const handleDragEnd = async (options) => {
    setDraggingFlexId(null); // grey-lock always clears on release, success or not
    if (dragItem.current === null) return;
    const showNow = options?.showNow === true;

    // An illegal drop (nothing legal was ever entered) redirects to the
    // earliest legal spot rather than leaving the item where it was.
    const dropIndex = dragOverItem.current !== null ? dragOverItem.current : lowerBoundaryIndex;

    const previousItems = flexEvents;
    const newItems = [...flexEvents];
    const dragged = newItems.splice(dragItem.current, 1)[0];
    newItems.splice(dropIndex, 0, dragged);
    dragItem.current = null;
    dragOverItem.current = null;
    if (showNow) setFlexEvents(newItems);

    const commitReorder = async () => {
      setFlexEvents(newItems);
      try {
        await axios.put(`${API}/flex-events/reorder/batch`, {
          ordered_ids: newItems.map(item => item.id),
        });
        // Ask the server which task is active now, so the countdown switches
        // straight away instead of at the next timed sync (up to a minute).
        // Skipped while an unsaved
        // new task is in the list: a sync re-adds that row at the end, which
        // would undo where it was just dragged; the timed sync still applies.
        if (!newItems.some(item => item.isTemp)) syncFlexEvents(true);
      } catch (error) {
        console.error("Failed to save flex event order:", error);
        if (showNow) setFlexEvents(previousItems);
        fetchFlexEvents(); // Revert on error
      }
    };

    // Task Deadlines Part 3: preview this reorder before committing --
    // nothing is applied to flexEvents/persisted until this resolves.
    const candidateItems = newItems.map(item => ({
      id: item.id, name: item.name, duration: item.duration, priority: item.priority ?? 3,
      deadline: item.deadline ?? null,
    }));
    const affected = await checkDeadlineCascade(candidateItems);

    if (affected.length > 0) {
      setCascadeAffectedIds(new Set(affected.map(a => a.id)));
      setCascadeWarning({
        names: affected.map(a => a.name),
        onConfirm: async () => {
          setCascadeWarning(null);
          setCascadeAffectedIds(new Set());
          await commitReorder();
        },
        onCancel: () => {
          setCascadeWarning(null);
          setCascadeAffectedIds(new Set());
          if (showNow) setFlexEvents(previousItems);
        },
      });
      return;
    }

    await commitReorder();
  };

  // Mobile layout -- touch drag for the flex queue (useTouchQueueDrag):
  // gesture only, routed through the three desktop drag functions above so
  // every boundary, the illegal-drop fallback, the deadline-conflict check
  // and the order save are the desktop ones. Reassigned every render so the
  // hook always reaches the current boundaries.
  const flexQueueListRef = useRef(null);
  const touchDragHandlersRef = useRef(null);
  touchDragHandlersRef.current = {
    start: handleDragStart,
    enter: handleDragEnter,
    end: () => handleDragEnd({ showNow: true }),
    dragIndex: () => dragItem.current,
    overIndex: () => dragOverItem.current,
  };
  const { touchDrag, onRowTouchStart, rowStyle: touchDragRowStyle } = useTouchQueueDrag({
    enabled: isMobile,
    listRef: flexQueueListRef,
    handlersRef: touchDragHandlersRef,
  });


  const handlePlacedFlexClick = (flexEventId, fragment, e) => {
    e.stopPropagation();
    clearRangeSelection();
    
    // Clear any selected cell
    setSelectedCell(null);
    
    // Set selectedDate from the fragment's scheduled start time
    if (fragment?.start_time) {
      setSelectedDate(getCalendarDateForTimezone(fragment.start_time, globalSettings.timezone));
    }
    
    // Find the flex event in the queue
    const flexEvent = flexEvents.find(f => f.id === flexEventId);
    if (flexEvent) {
      openEditFlexEventPanel(flexEvent);
    }
  };

  // ============== UNIFIED HANDLERS ==============
  
  const handleNewEvent = () => {
    if (eventTypeToggle === "rigid") {
      const { startCell, endCell } = selectedRange;
      const hasMultiCellRange =
        !!startCell &&
        !!endCell &&
        startCell.hour !== null &&
        endCell.hour !== null &&
        startCell.cellId !== endCell.cellId;

      if (hasMultiCellRange) {
        const rangeDate = new Date(`${startCell.dayKey}T00:00:00`);
        const rangeStartHour = Math.min(startCell.hour, endCell.hour);
        const rangeEndHour = Math.max(startCell.hour, endCell.hour);
        openNewRigidEventPanel(rangeDate, rangeStartHour, rangeEndHour);
        return;
      }

      const selectedCellInfo = parseSelectedCell();
      openNewRigidEventPanel(
        selectedCellInfo?.date || selectedDate,
        selectedCellInfo?.hour ?? null
      );
    } else {
      openNewFlexEventPanel();
    }
  };

  const handleCellClick = (date, hour = null) => {
    clearRangeSelection();
    // Clicking empty cell → idle mode, discard edits
    // If in flex-config mode with unsaved temp event, just remove from local state
    if (panelMode === "flex-config" && isNewFlexItem) {
      setFlexEvents(prev => prev.filter(i => i.id !== selectedFlexId));
    } else if (panelMode === "flex-config" && editingFlexEvent) {
      // Revert to original values in list
      setFlexEvents(prev => prev.map(i => i.id === selectedFlexId ? { 
        ...i, 
        name: originalFlexForm.name,
      } : i));
    }
    
    setSelectedDate(date);
    setSelectedCell(makeCellId(date, hour));
    setSelectedEventId(null);
    setPanelMode("idle");
    resetEventForm();
    resetFlexForm();
  };

  const handleCalendarEventClick = (event, e) => {
    e.stopPropagation();
    clearRangeSelection();
    // Clicking a calendar event → opens rigid config (discards any current edits)
    // NOTE: `event` here may be a display-clipped copy (see getEventsForDate),
    // which fakes start_time/end_time to fit a single day's column for
    // multi-day events. Always resolve back to the real source-of-truth
    // event by id before opening it for editing.
    const sourceEvent = events.find((e2) => e2.id === event.id) || event;
    setSelectedEventId(sourceEvent.id);
    openEditRigidEventPanel(sourceEvent);
  };

  const handleFlexEventClick = (flexEvent) => {
    clearRangeSelection();
    // Clicking a flex queue item → opens flex config (discards any current edits)
    openEditFlexEventPanel(flexEvent);
  };

  const hideFlexTooltip = () => {
    setHoveredFlexId(null);
    if (tooltipElRef.current) {
      tooltipElRef.current.style.opacity = "0";
    }
  };

  const handleRangeSelectionStart = (date, hour) => {
    const startCell = makeRangeCell(date, hour);
    isRangeSelectingRef.current = true;
    rangeSelectionMetaRef.current = { startCell, view };
    setSelectedRange({ startCell, endCell: startCell });
    setSelectedCell(null);
    setSelectedEventId(null);
  };

  const handleRangeSelectionMove = (date, hour) => {
    if (!isRangeSelectingRef.current) {
      return;
    }

    updateRangeSelection(date, hour);
  };

  const handleRangeSelectionEnd = (date, hour) => {
    if (!isRangeSelectingRef.current) {
      return;
    }

    const startCell = rangeSelectionMetaRef.current?.startCell;
    const endCell = updateRangeSelection(date, hour) || startCell;
    setFlexEvents(prev => prev.filter(i => !i.isTemp));
    setPanelMode("idle");
    isRangeSelectingRef.current = false;
    rangeSelectionMetaRef.current = null;

    if (startCell && endCell && startCell.cellId === endCell.cellId) {
      handleCellClick(date, hour);
    }
  };

  const handleCancelConfig = () => {
    if (panelMode === "flex-config") {
      handleCancelFlexEvent();
    } else {
      setPanelMode("idle");
      setSelectedCell(null);
      setSelectedEventId(null);
      resetEventForm();
      resetFlexForm();
    }
  };

  // ============== RENDER HELPERS ==============

  // Staged Calendar Editing -- while a draft covers a calendar, its color
  // previews from the draft; on Cancel/click-away calendarConfigDraft goes
  // back to null and this collapses back to real state.
  const getEffectiveCalendarColor = (cal) =>
    calendarConfigDraft && cal.id === configCalendarId
      ? (calendarConfigDraft.color || DEFAULT_CALENDAR_COLOR)
      : (cal.color || DEFAULT_CALENDAR_COLOR);

  // An event's detail level across every calendar it belongs to: the most
  // permissive one wins. 2 renders titled and clickable; 1 renders a
  // title-less busy block (a share that only shows busy time).
  const getEventDetailLevel = (event) =>
    (event.calendar_ids || []).reduce((max, id) => {
      const cal = calendars.find((c) => c.id === id);
      return cal ? Math.max(max, calendarDetailLevel(cal)) : max;
    }, 1);

  // Timed events only -- all-day ones render in the all-day strip / month
  // bars (getAllDayEvents), never as 24-hour blocks in the grid.
  const getEventsForDate = (date) => {
    const tz = getEffectiveTimezone(globalSettings.timezone);
    const offsetMs = getTimezoneOffsetMinutes(tz) * 60000;
    const dateStr = format(date, "yyyy-MM-dd");
    const dayStart = new Date(new Date(`${dateStr}T00:00:00Z`).getTime() - offsetMs);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    return events
      .filter((event) => !event.all_day)
      .filter((event) => {
        const start = new Date(event.start_time);
        const end = new Date(event.end_time);
        return start < dayEnd && end > dayStart;
      })
      .map((event) => {
        const start = new Date(event.start_time);
        const end = new Date(event.end_time);
        const clippedStart = start < dayStart ? dayStart : start;
        const clippedEnd = end > dayEnd ? dayEnd : end;
        if (clippedStart.getTime() === start.getTime() && clippedEnd.getTime() === end.getTime()) {
          return event;
        }
        return { ...event, start_time: clippedStart.toISOString(), end_time: clippedEnd.toISOString() };
      });
  };

  // Get all placed flex fragments for a given date, clipped to that day's
  // bounds. Same shape as getEventsForDate just above: a fragment can span
  // midnight, so it renders on every day it touches.
  const getPlacedFlexFragmentsForDate = (date) => {
    const tz = getEffectiveTimezone(globalSettings.timezone);
    const offsetMs = getTimezoneOffsetMinutes(tz) * 60000;
    const dateStr = format(date, "yyyy-MM-dd");
    const dayStart = new Date(new Date(`${dateStr}T00:00:00Z`).getTime() - offsetMs);
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    return placedFlexItems
      .flatMap((item) => item.fragments)
      .filter((fragment) => {
        const start = new Date(fragment.start_time);
        const end = new Date(fragment.end_time);
        return start < dayEnd && end > dayStart;
      })
      .map((fragment) => {
        const start = new Date(fragment.start_time);
        const end = new Date(fragment.end_time);
        const clippedStart = start < dayStart ? dayStart : start;
        const clippedEnd = end > dayEnd ? dayEnd : end;
        if (clippedStart.getTime() === start.getTime() && clippedEnd.getTime() === end.getTime()) {
          return fragment;
        }
        return { ...fragment, start_time: clippedStart.toISOString(), end_time: clippedEnd.toISOString() };
      });
  };

  // Month view only: show one card per flex task per day even if it has multiple fragments.
  const getPlacedFlexTasksForDate = (date) => {
    const taskMap = new Map();

    for (const item of placedFlexItems) {
      for (const fragment of item.fragments) {
        const fragmentDate = new Date(fragment.start_time);
        if (!isSameDay(fragmentDate, date)) {
          continue;
        }

        const existing = taskMap.get(fragment.flex_event_id);
        if (!existing || new Date(fragment.start_time) < new Date(existing.start_time)) {
          taskMap.set(fragment.flex_event_id, fragment);
        }
      }
    }

    return Array.from(taskMap.values());
  };

  const getPlacedFlexPositionStyle = (fragment, cascadeIndex = 0) => {
    const { hours: startH, minutes: startM } = getLocalizedHoursMinutes(fragment.start_time, globalSettings.timezone);
    const startMinutes = startH * 60 + startM;
    // Height from the real timestamps. Callers pass fragments already clipped
    // to the day (getPlacedFlexFragmentsForDate), so one that crosses midnight
    // arrives ending exactly at midnight -- no wrap guess needed. The old guess
    // ("end minute <= start minute means it crossed midnight") rendered a piece
    // shorter than a minute (start and end in the same minute) as a 24-hour
    // block.
    const durationMinutes = Math.max(
      15,
      (new Date(fragment.end_time).getTime() - new Date(fragment.start_time).getTime()) / 60000
    );
    const minuteOffset = startMinutes % 60;
    const top = (minuteOffset / 60) * HOUR_SLOT_HEIGHT;
    const height = (durationMinutes / 60) * HOUR_SLOT_HEIGHT;
    const adjustedIndex = Math.min(cascadeIndex, MAX_CASCADE_COLUMNS - 1);
    const cascadeOffset = adjustedIndex * 3;

    return {
      position: "absolute",
      top: `${top + cascadeOffset}px`,
      height: `${height}px`,
      left: "16px",
      width: "calc(100% - 16px)",
      transform: `translateX(${cascadeOffset}px)`,
      overflow: "hidden",
      zIndex: 10 + adjustedIndex,
    };
  };

  const getEventCategoryClass = (category) => {
    const cat = EVENT_CATEGORIES.find((c) => c.value === category);
    return cat ? cat.className : "event-work";
  };

  // Small colored dots on an event card, one per owning calendar (same
  // swatch convention as the sidebar's .calendar-row-swatch) -- shown
  // regardless of which calendars are currently checked, since membership
  // itself doesn't change with the view's filter state. Capped at 3 with a
  // "+N" overflow, matching this file's existing month-view "+N more"
  // convention. `calendars` is oldest-first (GET /calendars ordering), so
  // dot order is deterministic without needing a tiebreak rule.
  const MAX_EVENT_CALENDAR_DOTS = 3;
  const getEventCalendarDots = (event) => {
    const owners = calendars.filter((cal) => event.calendar_ids?.includes(cal.id));
    return {
      shown: owners.slice(0, MAX_EVENT_CALENDAR_DOTS),
      overflow: Math.max(0, owners.length - MAX_EVENT_CALENDAR_DOTS),
    };
  };

  const renderEventCalendarDots = (event) => {
    const { shown, overflow } = getEventCalendarDots(event);
    if (shown.length === 0) return null;
    return (
      <span className="event-card-calendar-dots">
        {shown.map((cal) => (
          <span
            key={cal.id}
            className="event-card-calendar-dot"
            style={{ backgroundColor: getEffectiveCalendarColor(cal) }}
            aria-hidden="true"
          />
        ))}
        {overflow > 0 && <span className="event-card-calendar-dot-overflow">+{overflow}</span>}
      </span>
    );
  };

  // Which event IDs should render as "selected" on the calendar. For a
  // non-recurring event (or when nothing is being edited) this is just the
  // single clicked event, matching the old selectedEventId === event.id
  // check exactly. For a recurring instance, it expands based on scope:
  // instance -> just the clicked one, series -> the whole series_id group,
  // now-and-future -> that group filtered to start_time >= the clicked
  // event's start_time. All start_time values are backend-normalized UTC
  // ISO strings with a consistent offset, so string comparison is safe.
  const highlightedEventIds = useMemo(() => {
    if (!editingEvent) return new Set();
    if (editingEvent.recurrence === "none" || !editingEvent.series_id) {
      return new Set([editingEvent.id]);
    }
    if (rigidEditScope === "series") {
      return new Set(
        events.filter((e) => e.series_id === editingEvent.series_id).map((e) => e.id)
      );
    }
    if (rigidEditScope === "now-and-future") {
      return new Set(
        events
          .filter((e) => e.series_id === editingEvent.series_id && e.start_time >= editingEvent.start_time)
          .map((e) => e.id)
      );
    }
    return new Set([editingEvent.id]); // "instance"
  }, [editingEvent, rigidEditScope, events]);

  const getAllDayEvents = () => events.filter((event) => event.all_day);

  const renderAllDayBar = (bar, style, testId) => {
    const { event } = bar;
    const detail = getEventDetailLevel(event);
    return (
      <div
        key={testId}
        className={[
          "event-card",
          "all-day-bar",
          getEventCategoryClass(event.category),
          highlightedEventIds.has(event.id) ? "selected-event" : "",
          detail === 1 ? "event-card-blocks-only" : "",
          bar.continuesBefore ? "all-day-continues-before" : "",
          bar.continuesAfter ? "all-day-continues-after" : "",
        ].filter(Boolean).join(" ")}
        style={style}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={detail >= 2 ? (e) => handleCalendarEventClick(event, e) : (e) => e.stopPropagation()}
        title={detail >= 2 ? event.title : undefined}
        data-testid={testId}
      >
        {renderEventCalendarDots(event)}
        {detail >= 2 && event.recurrence !== "none" && <Repeat size={10} className="inline mr-1" />}
        {detail >= 2 && event.title}
      </div>
    );
  };

  // The all-day strip above the timed grid (week and day views): one grid
  // column per day after a label column as wide as the time gutter, bars in
  // lanes, then "+N more" past ALL_DAY_STRIP_ROWS lanes until expanded.
  // Shown only when a visible day has an all-day event, and its empty space
  // does nothing: all-day events are created through the form's toggle
  // (2026-10-17).
  const renderAllDayStrip = (days, labelWidth, extraStyle = {}) => {
    const dayKeys = days.map((day) => format(day, "yyyy-MM-dd"));
    const { bars, laneCount } = layoutAllDayBars(getAllDayEvents(), dayKeys);
    if (laneCount === 0) return null;
    const overflow = laneCount > ALL_DAY_STRIP_ROWS;
    const shownLanes = overflow && !allDayStripExpanded ? ALL_DAY_STRIP_ROWS : laneCount;
    const hiddenCounts = hiddenAllDayCounts(bars, dayKeys.length, shownLanes);
    const showMoreRow = overflow && !allDayStripExpanded;
    const rowCount = shownLanes + (showMoreRow ? 1 : 0);
    return (
      <div
        className="all-day-strip"
        style={{
          gridTemplateColumns: `${labelWidth} repeat(${dayKeys.length}, 1fr)`,
          gridTemplateRows: `repeat(${rowCount}, var(--all-day-row))`,
          ...extraStyle,
        }}
        data-testid="all-day-strip"
      >
        <div className="all-day-strip-label" style={{ gridColumn: 1, gridRow: `1 / ${rowCount + 1}` }}>
          All day
          {overflow && allDayStripExpanded && (
            <button
              type="button"
              className="all-day-less"
              onClick={() => setAllDayStripExpanded(false)}
              data-testid="all-day-show-less"
            >
              Less
            </button>
          )}
        </div>
        {dayKeys.map((key, col) => (
          <div
            key={`cell-${key}`}
            className="all-day-strip-cell"
            style={{ gridColumn: col + 2, gridRow: `1 / ${rowCount + 1}` }}
            data-testid={`all-day-cell-${key}`}
          />
        ))}
        {bars
          .filter((bar) => bar.lane < shownLanes)
          .map((bar) => renderAllDayBar(
            bar,
            { gridColumn: `${bar.startCol + 2} / ${bar.endCol + 2}`, gridRow: bar.lane + 1 },
            `all-day-bar-${bar.event.id}`,
          ))}
        {showMoreRow && hiddenCounts.map((count, col) => count > 0 && (
          <button
            key={`more-${dayKeys[col]}`}
            type="button"
            className="all-day-more"
            style={{ gridColumn: col + 2, gridRow: rowCount }}
            onClick={(e) => {
              e.stopPropagation();
              setAllDayStripExpanded(true);
            }}
            data-testid={`all-day-more-${dayKeys[col]}`}
          >
            +{count} more
          </button>
        ))}
      </div>
    );
  };

  const renderMonthView = () => {
    const monthStart = startOfMonth(currentDate);
    const monthEnd = endOfMonth(currentDate);
    const startDate = startOfWeek(monthStart);
    const endDate = endOfWeek(monthEnd);

    const days = [];
    let day = startDate;

    while (day <= endDate) {
      days.push(day);
      day = addDays(day, 1);
    }

    // All-day bars, laid out per week row and placed in the same grid as the
    // cells (cells get explicit rows/columns so bars can span them). Each
    // cell reserves its week's lanes, up to ALL_DAY_STRIP_ROWS; the rest
    // count toward that day's "+N more". Mobile month stays a bare grid.
    const allDayEvents = isMobile ? [] : getAllDayEvents();
    const monthWeeks = [];
    for (let w = 0; w * 7 < days.length; w++) {
      const weekKeys = days.slice(w * 7, w * 7 + 7).map((d) => format(d, "yyyy-MM-dd"));
      const { bars, laneCount } = layoutAllDayBars(allDayEvents, weekKeys);
      const shownLanes = Math.min(laneCount, ALL_DAY_STRIP_ROWS);
      monthWeeks.push({ bars, shownLanes, hidden: hiddenAllDayCounts(bars, weekKeys.length, shownLanes) });
    }

    return (
      <div ref={calendarRef} className="calendar-view">
        <div className="day-headers">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((dayName) => (
            <div key={dayName} className="day-header">
              {dayName}
            </div>
          ))}
        </div>
        <div className="calendar-grid">
          {days.map((day, index) => {
            // Mobile layout: month view is the bare grid -- no tasks or events.
            const dayEvents = isMobile ? [] : getEventsForDate(day);
            const dayFlexTasks = isMobile ? [] : getPlacedFlexTasksForDate(day);
            const isToday = format(day, "yyyy-MM-dd") === zonedToday;
            const isCurrentMonth = isSameMonth(day, currentDate);
            const dayCellId = makeCellId(day);
            const week = monthWeeks[Math.floor(index / 7)];
            const hiddenAllDay = week.hidden[index % 7];

            return (
              <div
                key={index}
                className={`calendar-cell ${!isCurrentMonth ? "outside-month" : ""} ${isToday ? "today" : ""} ${selectedCell === dayCellId ? "selected" : ""}`}
                style={{ gridRow: Math.floor(index / 7) + 1, gridColumn: (index % 7) + 1 }}
                onClick={() => {
                  setCurrentDate(day);
                  handleCellClick(day);
                }}
                data-testid={`calendar-cell-${format(day, "yyyy-MM-dd")}`}
              >
                <div className="day-number">{format(day, "d")}</div>
                <div className="events-container">
                  {week.shownLanes > 0 && (
                    <div style={{ height: `${week.shownLanes * ALL_DAY_MONTH_ROW + 2}px` }} aria-hidden="true" />
                  )}
                  {/* Placed flex tasks (deduped by task for month view) */}
                  {dayFlexTasks.map((fragment, fragIndex) => (
                    <div
                      key={`flex-${fragment.flex_event_id}-${fragment.fragment_index}`}
                      className={`event-card event-flex ${selectedFlexId === fragment.flex_event_id ? "selected-event" : ""}`}
                      onClick={(e) => handlePlacedFlexClick(fragment.flex_event_id, fragment, e)}
                      data-testid={`placed-flex-item-${fragIndex}`}
                    >
                      {fragment.flex_event_name}{fragment.is_continuation ? " (cont)" : ""}
                    </div>
                  ))}
                  {dayEvents.slice(0, Math.max(0, 3 - dayFlexTasks.length)).map((event, eventIndex) => {
                    const detail = getEventDetailLevel(event);
                    return (
                      <div
                        key={eventIndex}
                        className={`event-card ${getEventCategoryClass(event.category)} ${highlightedEventIds.has(event.id) ? "selected-event" : ""} ${detail === 1 ? "event-card-blocks-only" : ""}`}
                        onClick={detail >= 2 ? (e) => handleCalendarEventClick(event, e) : undefined}
                        data-testid={`event-${event.id}`}
                      >
                        {renderEventCalendarDots(event)}
                        {detail >= 2 && event.recurrence !== "none" && <Repeat size={10} className="inline mr-1" />}
                        {detail >= 2 && event.title}
                      </div>
                    );
                  })}
                  {(dayEvents.length + dayFlexTasks.length > 3 || hiddenAllDay > 0) && (
                    <div className="text-xs text-gray-500 pl-1" data-testid={`month-more-${format(day, "yyyy-MM-dd")}`}>
                      +{Math.max(0, dayEvents.length + dayFlexTasks.length - 3) + hiddenAllDay} more
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {monthWeeks.flatMap((week, w) => week.bars
            .filter((bar) => bar.lane < week.shownLanes)
            .map((bar) => renderAllDayBar(
              bar,
              {
                gridRow: w + 1,
                gridColumn: `${bar.startCol + 1} / ${bar.endCol + 1}`,
                alignSelf: "start",
                marginTop: `${ALL_DAY_MONTH_TOP + bar.lane * ALL_DAY_MONTH_ROW}px`,
              },
              `month-all-day-bar-${bar.event.id}-${w}`,
            )))}
          {/* Month cells have no hour axis: the line marks how far through
              the day it is, as a proportion of today's whole cell. */}
          <NowLine
            tz={getEffectiveTimezone(globalSettings.timezone)}
            dayKeys={days.map((d) => format(d, "yyyy-MM-dd"))}
            getCellTestId={(dateKey) => `calendar-cell-${dateKey}`}
            wholeDay
          />
        </div>
      </div>
    );
  };

  const renderWeekView = () => {
    // Rolling window -- starts on currentDate, whatever weekday that is.
    const windowStart = startOfDay(currentDate);
    const days = Array.from({ length: weekDayCount }, (_, i) => addDays(windowStart, i));
    const hours = Array.from({ length: 24 }, (_, i) => i);

    const dayCascadeIndexes = new Map();
    days.forEach((day) => {
      const dayKey = format(day, "yyyy-MM-dd");
      dayCascadeIndexes.set(dayKey, computeCascadeIndexes(getEventsForDate(day)));
    });

    return (
      <div ref={calendarRef} className="calendar-view">
        <div className={`week-day-headers${isMobile ? " week-three-day" : ""}`}>
          <div className="week-day-header"></div>
          {days.map((day, index) => {
            const isToday = format(day, "yyyy-MM-dd") === zonedToday;
            return (
              <div key={index} className="week-day-header">
                <div className="week-day-name">{format(day, "EEE")}</div>
                <div className={`week-day-number ${isToday ? "today" : ""}`}>
                  {format(day, "d")}
                </div>
              </div>
            );
          })}
          {/* Inside the sticky header row, so it stays put while scrolling. */}
          {renderAllDayStrip(days, isMobile ? "48px" : "60px", { gridColumn: "1 / -1" })}
        </div>
        <div className={`week-grid${isMobile ? " week-three-day" : ""}`}>
          {hours.map((hour) => (
            <>
              <div key={`time-${hour}`} className="week-time-slot" style={{ borderRight: "1px solid #F5F5F5" }}>
                <span className="text-xs text-gray-500">
                  {format(setHours(new Date(), hour), "ha")}
                </span>
              </div>
              {days.map((day, dayIndex) => {
                const dayEvents = getEventsForDate(day).filter((event) => {
                  const eventHour = getLocalizedHoursMinutes(event.start_time, globalSettings.timezone, event.timezone_mode, event.home_timezone).hours;
                  return eventHour === hour;
                });
                const cellId = makeCellId(day, hour);
                const cascadeIndexes = dayCascadeIndexes.get(format(day, "yyyy-MM-dd"));
                
                // Get flex fragments that start at this hour
                const flexFragmentsAtHour = getPlacedFlexFragmentsForDate(day).filter(
                  f => getLocalizedHoursMinutes(f.start_time, globalSettings.timezone).hours === hour
                );

                return (
                  <div
                    key={`${hour}-${dayIndex}`}
                    className={`week-time-slot ${selectedCell === cellId || isHourCellInSelectedRange(day, hour) ? "selected" : ""}`}
                    style={{ borderLeft: "1px solid #F5F5F5", cursor: "pointer" }}
                    data-range-cell="true"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleRangeSelectionStart(day, hour);
                    }}
                    onMouseMove={() => handleRangeSelectionMove(day, hour)}
                    onMouseUp={() => handleRangeSelectionEnd(day, hour)}
                    data-testid={`week-cell-${format(day, "yyyy-MM-dd")}-${hour}`}
                  >
                    {/* Placed flex fragments */}
                    {flexFragmentsAtHour.map((fragment, fragIndex) => (
                      <div
                        key={`flex-${fragment.flex_event_id}-${fragment.fragment_index}`}
                        className={`event-card event-flex ${selectedFlexId === fragment.flex_event_id ? "selected-event" : ""}`}
                        style={getPlacedFlexPositionStyle(fragment, fragIndex)}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => handlePlacedFlexClick(fragment.flex_event_id, fragment, e)}
                        data-testid={`placed-flex-item-week-${fragIndex}`}
                      >
                        {fragment.flex_event_name}{fragment.is_continuation ? " (cont)" : ""}
                      </div>
                    ))}
                    {dayEvents.map((event) => {
                      const cascadeIndex = cascadeIndexes.get(event.id) || 0;
                      const detail = getEventDetailLevel(event);
                      return (
                        <div
                          key={event.id}
                          className={`event-card ${getEventCategoryClass(event.category)} ${highlightedEventIds.has(event.id) ? "selected-event" : ""} ${detail === 1 ? "event-card-blocks-only" : ""}`}
                          style={getEventPositionStyle(event, flexFragmentsAtHour.length + cascadeIndex)}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={detail >= 2 ? (e) => handleCalendarEventClick(event, e) : undefined}
                        >
                          {renderEventCalendarDots(event)}
                          {detail >= 2 && event.recurrence !== "none" && <Repeat size={10} className="inline mr-1" />}
                          {detail >= 2 && event.title}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </>
          ))}
          <NowLine
            tz={getEffectiveTimezone(globalSettings.timezone)}
            dayKeys={days.map((day) => format(day, "yyyy-MM-dd"))}
            getCellTestId={(dateKey, hour) => `week-cell-${dateKey}-${hour}`}
          />
        </div>
      </div>
    );
  };

  const renderDayView = () => {
    const hours = Array.from({ length: 24 }, (_, i) => i);
    const dayEvents = getEventsForDate(currentDate);
    const cascadeIndexes = computeCascadeIndexes(dayEvents);
    const flexFragments = getPlacedFlexFragmentsForDate(currentDate);

    return (
      <div ref={calendarRef} className="calendar-view">
        {renderAllDayStrip([currentDate], "80px", { position: "sticky", top: 0, zIndex: 20 })}
        <div className="day-grid">
          {hours.map((hour) => {
            const hourEvents = dayEvents.filter((event) => {
              const eventHour = getLocalizedHoursMinutes(event.start_time, globalSettings.timezone, event.timezone_mode, event.home_timezone).hours;
              return eventHour === hour;
            });

            const cellId = makeCellId(currentDate, hour);
            const flexFragmentsAtHour = flexFragments.filter(
              f => getLocalizedHoursMinutes(f.start_time, globalSettings.timezone).hours === hour
            );

            return (
              <div key={hour} className={`day-time-slot ${selectedCell === cellId || isHourCellInSelectedRange(currentDate, hour) ? "selected" : ""}`}>
                <div
                  className="day-time-label"
                  data-range-cell="true"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleRangeSelectionStart(currentDate, hour);
                  }}
                  onMouseMove={() => handleRangeSelectionMove(currentDate, hour)}
                  onMouseUp={() => handleRangeSelectionEnd(currentDate, hour)}
                >
                  {format(setHours(new Date(), hour), "h a")}
                </div>
                <div
                  className="day-time-content"
                  data-range-cell="true"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleRangeSelectionStart(currentDate, hour);
                  }}
                  onMouseMove={() => handleRangeSelectionMove(currentDate, hour)}
                  onMouseUp={() => handleRangeSelectionEnd(currentDate, hour)}
                  data-testid={`day-slot-${hour}`}
                >
                  {/* Placed flex fragments */}
                  {flexFragmentsAtHour.map((fragment, fragIndex) => (
                    <div
                      key={`flex-${fragment.flex_event_id}-${fragment.fragment_index}`}
                      className={`event-card event-flex ${selectedFlexId === fragment.flex_event_id ? "selected-event" : ""}`}
                      style={getPlacedFlexPositionStyle(fragment, fragIndex)}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => handlePlacedFlexClick(fragment.flex_event_id, fragment, e)}
                      data-testid={`placed-flex-item-day-${fragIndex}`}
                    >
                      {fragment.flex_event_name}{fragment.is_continuation ? " (cont)" : ""}
                    </div>
                  ))}
                  {hourEvents.map((event) => {
                    const cascadeIndex = cascadeIndexes.get(event.id) || 0;
                    const detail = getEventDetailLevel(event);
                    return (
                      <div
                        key={event.id}
                        className={`event-card ${getEventCategoryClass(event.category)} ${highlightedEventIds.has(event.id) ? "selected-event" : ""} ${detail === 1 ? "event-card-blocks-only" : ""}`}
                        style={getEventPositionStyle(event, flexFragmentsAtHour.length + cascadeIndex)}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={detail >= 2 ? (e) => handleCalendarEventClick(event, e) : undefined}
                      >
                        {renderEventCalendarDots(event)}
                        {detail >= 2 && event.recurrence !== "none" && <Repeat size={10} className="inline mr-1" />}
                        {detail >= 2 && event.title}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <NowLine
            tz={getEffectiveTimezone(globalSettings.timezone)}
            dayKeys={[format(currentDate, "yyyy-MM-dd")]}
            getCellTestId={(dateKey, hour) => `day-slot-${hour}`}
          />
        </div>
      </div>
    );
  };

  const getHeaderTitle = () => {
    if (view === "month") {
      return format(currentDate, "MMMM yyyy");
    } else if (view === "week") {
      const windowStart = startOfDay(currentDate);
      const windowEnd = addDays(windowStart, weekDayCount - 1);
      // Year on both ends when the window straddles New Year's.
      if (windowStart.getFullYear() !== windowEnd.getFullYear()) {
        return `${format(windowStart, "MMM d, yyyy")} - ${format(windowEnd, "MMM d, yyyy")}`;
      }
      return `${format(windowStart, "MMM d")} - ${format(windowEnd, "MMM d, yyyy")}`;
    } else {
      return format(currentDate, "EEEE, MMMM d");
    }
  };

  // ============== RENDER FLEX QUEUE ==============
  
  const renderFlexQueueItem = (item, index) => {
    const isSelected = item.id === selectedFlexId;
    const isDeadlineLocked = deadlineLockedIds.has(item.id);
    const isLocked = lockedFlexIds.has(item.id) || isDeadlineLocked;
    const isCascadeAffected = cascadeAffectedIds.has(item.id);
    const isChecked = checkedFlexIds.includes(item.id);
    const hasName = item.name && item.name.trim() !== "";
    const placedItem = placedFlexItems.find((p) => p.flex_event_id === item.id);
    const hasFragments = placedItem?.fragments?.length > 0;
    const hasInsufficientTime = !!item.deadline && placedItem?.insufficient_time === true;
    const trSeconds = Math.max(0, (item.duration * 60) - displayElapsedSeconds(item));
    const durationLabel = trSeconds >= 3600
      ? `${Math.floor(trSeconds / 3600)}h ${Math.floor((trSeconds % 3600) / 60)}m ${trSeconds % 60}s`
      : trSeconds >= 60
      ? `${Math.floor(trSeconds / 60)}m ${trSeconds % 60}s`
      : `${trSeconds}s`;
    return (
      <div
        key={item.id}
        data-testid={`flex-item-${index}`}
        data-flex-index={index}
        className={`flex-queue-item ${isSelected ? "selected" : ""} ${isLocked ? "locked" : ""} ${isCascadeAffected ? "cascade-affected" : ""}${touchDrag?.fromIndex === index ? " touch-dragging" : ""}`}
        // Mobile: the browser's own drag is off (Android starts it on a long
        // press); press-and-hold goes through useTouchQueueDrag instead.
        draggable={!isMobile && !isLocked}
        style={isMobile ? touchDragRowStyle(index) : undefined}
        onTouchStart={isMobile ? (e) => onRowTouchStart(e, index) : undefined}
        onContextMenu={isMobile ? (e) => e.preventDefault() : undefined}
        onMouseDown={hideFlexTooltip}
        onDragStart={() => handleDragStart(index)}
        onDragEnter={() => handleDragEnter(index)}
        onDragEnd={handleDragEnd}
        onDragOver={e => e.preventDefault()}
        onMouseEnter={() => hasFragments && setHoveredFlexId(item.id)}
        onMouseMove={(e) => {
          if (tooltipElRef.current) {
            tooltipElRef.current.style.top = `${e.clientY + 16}px`;
            tooltipElRef.current.style.left = `${e.clientX + 12}px`;
            tooltipElRef.current.style.opacity = '1';
          }
        }}
        onMouseLeave={() => setHoveredFlexId(null)}
        onClick={() => handleFlexEventClick(item)}
      >
        <div className="flex-queue-item-row">
          <div className="flex-queue-item-drag">
            <GripVertical size={14} />
          </div>
          <span className={`flex-queue-item-name ${!hasName ? "placeholder" : ""}`}>
            {hasName ? item.name : "Item Name"}
          </span>
          {item.repeat_definition_id && (
            <Repeat size={11} className="flex-queue-item-repeat-icon" aria-label="Repeating task copy" data-testid={`flex-repeat-icon-${index}`} />
          )}
          <span className="text-xs text-gray-500 whitespace-nowrap" data-testid={`flex-remaining-${item.id}`}>
            {durationLabel}
          </span>
          {item.deadline && (
            <span className="flex-deadline-badge" data-testid={`flex-deadline-badge-${index}`}>
              <Clock size={11} />
              {formatDeadlineBadge(item.deadline)}
            </span>
          )}
          <input
            type="checkbox"
            data-testid={`check-btn-${index}`}
            className="flex-queue-item-check"
            checked={isChecked}
            onChange={(e) => handleToggleFlexEventChecked(item.id, e)}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
        {hasInsufficientTime && (
          <div className="flex-deadline-banner" data-testid={`flex-insufficient-time-${index}`}>
            <AlertTriangle size={12} />
            You don't have capacity to finish this before its deadline. Move it to a later date, or make room elsewhere in your queue.
          </div>
        )}
      </div>
    );
  };

  const renderFlexQueue = () => {
    const allChecked = flexEvents.length > 0 && checkedFlexIds.length === flexEvents.length;
    const hasCheckedItems = checkedFlexIds.length > 0;

    return (
      <div className="flex-queue" data-testid="flex-queue">
        <div className="flex-queue-header">
          <div className="flex-queue-header-row">
            <span className="flex-queue-title">{queueRepeatMode ? "Repeating Tasks" : "Flex Queue"}</span>
            <button
              type="button"
              className={`flex-queue-repeat-btn${queueRepeatMode ? " active" : ""}`}
              onClick={toggleQueueRepeatMode}
              aria-pressed={queueRepeatMode}
              aria-label={queueRepeatMode ? "Back to the queue" : "Show repeating tasks"}
              title={queueRepeatMode ? "Back to the queue" : "Repeating tasks"}
              data-testid="queue-repeat-toggle"
            >
              <Repeat size={14} />
            </button>
            {!queueRepeatMode && (
            <label className="flex-queue-select-all" data-testid="select-all-label">
              <input
                type="checkbox"
                checked={allChecked}
                onChange={() => {
                  if (allChecked) {
                    setCheckedFlexIds([]);
                    return;
                  }
                  setCheckedFlexIds(flexEvents.map((item) => item.id));
                }}
                data-testid="select-all-flex"
              />
              <span>Select All</span>
            </label>
            )}
          </div>
          {!queueRepeatMode && (
          <div className="flex-queue-actions-row">
            <button
              className="flex-queue-action-btn delete"
              onClick={handleDeleteCheckedFlexEvents}
              disabled={!hasCheckedItems}
              data-testid="bulk-delete-flex-btn"
            >
              Delete
            </button>
            <button
              className="flex-queue-action-btn complete"
              onClick={handleCompleteCheckedFlexEvents}
              disabled={!hasCheckedItems}
              data-testid="bulk-complete-flex-btn"
            >
              Complete
            </button>
          </div>
          )}
        </div>
        {queueRepeatMode ? renderRepeatingTasksList() : (
        <div className="flex-queue-content">
          <div
            ref={flexQueueListRef}
            className={`flex-queue-list${touchDrag ? " touch-drag-active" : ""}`}
          >
            {flexEvents.length === 0 && (
              <div className="flex-queue-empty" data-testid="empty-state">
                No flex events
              </div>
            )}
            {flexEvents.map((item, i) => renderFlexQueueItem(item, i))}
          </div>
          {hoveredFlexId && (() => {
            const hp = placedFlexItems.find(p => p.flex_event_id === hoveredFlexId);
            return hp ? <FlexTooltip fragments={hp.fragments} divRef={tooltipElRef} timezone={globalSettings.timezone} /> : null;
          })()}
        </div>
        )}
      </div>
    );
  };

  // Recurring Flex Tasks: the queue panel's repeating-tasks mode -- only the
  // definitions, no drag, checkboxes or bulk actions. A definition opens in
  // the flex panel for editing or deleting.
  const renderRepeatingTasksList = () => (
    <div className="flex-queue-content">
      <div className="flex-queue-list" data-testid="repeating-tasks-list">
        {repeatingTasks.length === 0 && (
          <div className="flex-queue-empty" data-testid="repeating-tasks-empty">
            No repeating tasks
          </div>
        )}
        {repeatingTasks.map((def, index) => (
          <div
            key={def.id}
            className={`flex-queue-item${editingRepeatDef?.id === def.id ? " selected" : ""}`}
            onClick={() => openRepeatDefinitionPanel(def)}
            data-testid={`repeat-def-${index}`}
          >
            <div className="flex-queue-item-row">
              <Repeat size={12} className="flex-queue-item-repeat-icon" />
              <span className="flex-queue-item-name">{def.name}</span>
              <span className="text-xs text-gray-500 whitespace-nowrap">{def.duration}m</span>
            </div>
            <div className="flex-repeat-def-summary" data-testid={`repeat-def-summary-${index}`}>{describeRepeat(def)}</div>
            <div className="flex-repeat-def-summary" data-testid={`repeat-def-next-${index}`}>
              {(() => {
                // Today's copy (if today is a due day) already exists, so the
                // next one is the first due day after today.
                const next = nextRepeatDay(def, repeatToday);
                return next ? `Next spawn: ${formatRepeatDay(next)}` : "No more copies";
              })()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  // ============== RENDER SIDEBAR PANELS ==============
  
  const renderIdlePanel = () => (
    <div className="flex flex-col flex-1">
      <div className="flex flex-col gap-4 flex-1">
        {/* Event Type Toggle */}
        <div className="event-type-toggle" data-testid="event-type-toggle">
          <button
            className={`event-type-btn ${eventTypeToggle === "rigid" ? "active" : ""}`}
            onClick={() => setEventTypeToggle("rigid")}
            data-testid="toggle-rigid"
          >
            Events
          </button>
          <button
            className={`event-type-btn ${eventTypeToggle === "flex" ? "active" : ""}`}
            onClick={() => setEventTypeToggle("flex")}
            data-testid="toggle-flex"
          >
            Tasks
          </button>
        </div>
        
        {(() => {
          const hasWritableCalendar = calendars.some((cal) => canWriteCalendar(cal));
          return (
            <>
              <button
                className={`add-event-btn${hasWritableCalendar ? "" : " add-event-btn-disabled"}`}
                aria-disabled={!hasWritableCalendar}
                onClick={() => {
                  // A natively `disabled` button fires no click event at all,
                  // which would silently swallow this case -- aria-disabled
                  // plus a live handler is what lets the message show.
                  if (!hasWritableCalendar) {
                    setAddButtonBlockedMessage(true);
                    return;
                  }
                  setAddButtonBlockedMessage(false);
                  handleNewEvent();
                }}
                data-preserve-range-selection="true"
                data-testid="add-event-btn"
              >
                <Plus size={18} />
                Add
              </button>
              {addButtonBlockedMessage && !hasWritableCalendar && (
                <p className="add-event-blocked-message" data-testid="add-event-blocked-message">
                  None of your calendars have edit rights.
                </p>
              )}
            </>
          );
        })()}
      </div>
      
      {/* Settings Button at bottom */}
      <div className="mt-auto pt-4">
        <button
          className="settings-btn"
          onClick={() => {
            // Initialize settings form from current global settings
            setSettingsForm({
              minDuration: String(globalSettings.minDuration),
              timezone: globalSettings.timezoneFollowsDevice ? LOCAL_TIMEZONE_OPTION : globalSettings.timezone,
              notifyLeadMinutes: String(globalSettings.notifyLeadMinutes),
              extendIncrementMinutes: String(globalSettings.extendIncrementMinutes),
              flexNotifications: globalSettings.flexNotifications,
            });
            setPanelMode("settings");
          }}
          data-testid="settings-btn"
        >
          <Settings size={18} />
          Settings
        </button>
      </div>
    </div>
  );

  const renderRigidConfigPanel = () => {
    const isRecurringInstanceEdit =
      !!editingEvent && editingEvent.recurrence !== "none" && !!editingEvent.series_id;
    const recurrenceDisabled = isRecurringInstanceEdit && rigidEditScope === "instance";

    const handleRigidKeyDown = (e) => {
      if (e.key === "Delete") {
        const target = e.target;
        const isEditableField =
          target?.tagName === "INPUT" ||
          target?.tagName === "TEXTAREA" ||
          target?.tagName === "SELECT" ||
          target?.isContentEditable ||
          !!target?.closest?.('[contenteditable="true"]');

        if (!editingEvent || isEditableField) return;
        e.preventDefault();
        handleDeleteRigidEvent(isRecurringInstanceEdit ? rigidEditScope : "series");
        return;
      }

      if (e.key !== "Enter") return;
      if (e.target.tagName === "TEXTAREA" && e.shiftKey) return;
      if (e.target.tagName === "BUTTON" || e.target.tagName === "A") return;
      e.preventDefault();
      handleSaveRigidEvent(isRecurringInstanceEdit ? rigidEditScope : "series");
    };

    return (
      <div ref={rigidPanelRef} className="flex flex-col flex-1" onKeyDown={handleRigidKeyDown} tabIndex={0} style={{ outline: "none" }} data-preserve-range-selection="true">
        <div className="flex-1 overflow-y-auto pr-2">
          <div className="form-group">
            <input
              type="text"
              className="form-input"
              placeholder="Item Name"
              value={eventForm.title}
              onChange={(e) => setEventForm({ ...eventForm, title: e.target.value })}
              data-testid="event-title-input"
            />
          </div>

          <div className="form-group">
            <CollapsibleSectionHeader
              label="Description"
              expanded={isDescriptionExpanded}
              onToggle={() => setIsDescriptionExpanded(v => !v)}
              testId="description-toggle"
            />
            {isDescriptionExpanded && (
              <textarea
                className="form-input mt-2"
                placeholder="Add description (optional)"
                rows={2}
                value={eventForm.description}
                onChange={(e) => setEventForm({ ...eventForm, description: e.target.value })}
                data-testid="event-description-input"
              />
            )}
          </div>

          <div className="form-group">
            <label className="all-day-toggle" data-testid="event-all-day-label">
              <input
                type="checkbox"
                checked={!!eventForm.all_day}
                onChange={(e) => {
                  const allDay = e.target.checked;
                  setEventForm((f) => {
                    if (allDay) {
                      // Keep the times for switching back; the last day
                      // can't be before the first.
                      const startKey = f.start_time.slice(0, 10);
                      const end_time = f.end_time.slice(0, 10) < startKey
                        ? `${startKey}${f.end_time.slice(10) || "T10:00"}`
                        : f.end_time;
                      return { ...f, all_day: true, end_time };
                    }
                    if (!f.end_time || f.end_time <= f.start_time) {
                      const endDate = new Date(f.start_time);
                      endDate.setHours(endDate.getHours() + 1);
                      return { ...f, all_day: false, end_time: format(endDate, "yyyy-MM-dd'T'HH:mm") };
                    }
                    return { ...f, all_day: false };
                  });
                }}
                data-testid="event-all-day-toggle"
              />
              All day
            </label>
          </div>

          {eventForm.all_day ? (
            <>
              <div className="form-group">
                <label className="form-label">Start</label>
                <input
                  type="date"
                  className="form-input"
                  value={eventForm.start_time.slice(0, 10)}
                  onChange={(e) => {
                    const key = e.target.value;
                    if (!key) return;
                    setEventForm((f) => ({
                      ...f,
                      start_time: `${key}${f.start_time.slice(10) || "T09:00"}`,
                      end_time: f.end_time.slice(0, 10) < key ? `${key}${f.end_time.slice(10) || "T10:00"}` : f.end_time,
                    }));
                  }}
                  data-testid="event-start-date-input"
                />
              </div>
              <div className="form-group">
                <label className="form-label">End</label>
                <input
                  type="date"
                  className="form-input"
                  value={eventForm.end_time.slice(0, 10)}
                  min={eventForm.start_time.slice(0, 10)}
                  onChange={(e) => {
                    const key = e.target.value;
                    if (!key) return;
                    setEventForm((f) => ({ ...f, end_time: `${key}${f.end_time.slice(10) || "T10:00"}` }));
                  }}
                  data-testid="event-end-date-input"
                />
              </div>
            </>
          ) : (
            <>
            <div className="form-group">
              <label className="form-label">Start</label>
              <input
                type="datetime-local"
                className="form-input"
                value={eventForm.start_time}
                onChange={(e) => setEventForm({ ...eventForm, start_time: e.target.value })}
                onBlur={(e) => {
                  const start = e.target.value;
                  if (!start) return;
                  setEventForm(f => {
                    let next = f;
                    if (!f.end_time || start >= f.end_time) {
                      const endDate = new Date(start);
                      endDate.setHours(endDate.getHours() + 1);
                      next = { ...next, end_time: format(endDate, "yyyy-MM-dd'T'HH:mm") };
                    }
                    if (!f.recurrence_end_date) {
                      const repeatUntil = new Date(start);
                      repeatUntil.setFullYear(repeatUntil.getFullYear() + 1);
                      next = { ...next, recurrence_end_date: format(repeatUntil, "yyyy-MM-dd") };
                    }
                    return next;
                  });
                }}
                data-testid="event-start-input"
              />
            </div>

            <div className="form-group">
              <label className="form-label">End</label>
              <input
                type="datetime-local"
                className="form-input"
                value={eventForm.end_time}
                onChange={(e) => setEventForm({ ...eventForm, end_time: e.target.value })}
                onBlur={(e) => {
                  const end = e.target.value;
                  if (end && eventForm.start_time && end <= eventForm.start_time) {
                    const startDate = new Date(end);
                    startDate.setHours(startDate.getHours() - 1);
                    setEventForm(f => ({ ...f, start_time: format(startDate, "yyyy-MM-dd'T'HH:mm") }));
                  }
                }}
                data-testid="event-end-input"
              />
            </div>
            </>
          )}

          <div className="form-group">
            <CollapsibleSectionHeader
              label="Category"
              expanded={isCategoryExpanded}
              onToggle={() => setIsCategoryExpanded(v => !v)}
              testId="category-toggle"
            />
            {isCategoryExpanded && (
              <div className="mt-2">
                <Select
                  value={eventForm.category}
                  onValueChange={(value) => setEventForm({ ...eventForm, category: value })}
                >
                  <SelectTrigger className="rounded-none" data-testid="category-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EVENT_CATEGORIES.map((cat) => (
                      <SelectItem key={cat.value} value={cat.value}>
                        {cat.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="form-group">
            <CollapsibleSectionHeader
              label="Repeat"
              expanded={isRepeatExpanded}
              onToggle={() => setIsRepeatExpanded(v => !v)}
              testId="repeat-toggle"
            />
            {/* An imported series defined in another zone repeats on that
                zone's clock (recurrence_timezone, 2026-10-17), so its time
                here can shift by an hour in weeks when the two zones' DST
                changes disagree. Say so, rather than let it look like a bug. */}
            {editingEvent?.recurrence_timezone && editingEvent.recurrence !== "none" && !eventForm.all_day
              && editingEvent.recurrence_timezone !== globalSettings.timezone && (
              <div className="ics-hint" data-testid="recurrence-timezone-note">
                Repeats on {editingEvent.recurrence_timezone} time
              </div>
            )}
            {isRepeatExpanded && (
              <div
                className="mt-2"
                style={recurrenceDisabled ? { opacity: 0.45, pointerEvents: "none" } : undefined}
              >
                <Select
                  value={eventForm.recurrence}
                  onValueChange={(value) => {
                    if (recurrenceDisabled) return;
                    setEventForm({ ...eventForm, recurrence: value });
                  }}
                >
                  <SelectTrigger className="rounded-none" data-testid="recurrence-select">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RECURRENCE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {eventForm.recurrence !== "none" && (
                  <div className="mt-3">
                    <label className="form-label">Every</label>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <input
                        type="number"
                        min={1}
                        max={MAX_RECURRENCE_INTERVAL}
                        className="form-input"
                        style={{ width: "72px" }}
                        value={eventForm.recurrence_interval}
                        onChange={(e) => setEventForm({ ...eventForm, recurrence_interval: e.target.value })}
                        disabled={recurrenceDisabled}
                        data-testid="recurrence-interval-input"
                      />
                      <span style={{ fontSize: "13px", color: "var(--foreground)" }} data-testid="recurrence-interval-unit">
                        {(RECURRENCE_UNITS[eventForm.recurrence] || ["", ""])[Number(eventForm.recurrence_interval) === 1 ? 0 : 1]}
                      </span>
                    </div>
                  </div>
                )}

                {eventForm.recurrence === "monthly" && (() => {
                  const options = monthlyModeOptions(eventForm.start_time);
                  const value = options.some(([mode]) => mode === eventForm.monthly_mode) ? eventForm.monthly_mode : "day";
                  return (
                    <div className="mt-3">
                      <label className="form-label">Repeat On</label>
                      <select
                        className="form-input"
                        value={value}
                        onChange={(e) => setEventForm({ ...eventForm, monthly_mode: e.target.value })}
                        disabled={recurrenceDisabled}
                        data-testid="monthly-mode-select"
                      >
                        {options.map(([mode, label]) => (
                          <option key={mode} value={mode}>{label}</option>
                        ))}
                      </select>
                    </div>
                  );
                })()}

                {eventForm.recurrence === "weekly" && (
                  <div className="mt-3">
                    <label className="form-label">Repeat On</label>
                    <div style={{ display: "flex", gap: "4px" }} data-testid="recurrence-days-row">
                      {WEEKDAY_LABELS.map((label, i) => {
                        const isSelected = eventForm.days_of_week.includes(i);
                        return (
                          <button
                            key={i}
                            type="button"
                            onClick={() => {
                              if (recurrenceDisabled) return;
                              setEventForm((f) => ({
                                ...f,
                                days_of_week: isSelected
                                  ? f.days_of_week.filter((d) => d !== i)
                                  : [...f.days_of_week, i],
                              }));
                            }}
                            disabled={recurrenceDisabled}
                            data-testid={`recurrence-day-${i}`}
                            style={{
                              flex: 1,
                              padding: "6px 0",
                              fontSize: "12px",
                              fontWeight: 600,
                              border: "1px solid #E5E5E5",
                              background: isSelected ? "#0ea5e9" : "#FAFAFA",
                              color: isSelected ? "#ffffff" : "#737373",
                              cursor: recurrenceDisabled ? "not-allowed" : "pointer",
                            }}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {eventForm.recurrence !== "none" && (
                  <div className="mt-3" data-testid="recurrence-ends">
                    <label className="form-label">Ends</label>
                    {[
                      ["never", "Never"],
                      ["on", "On"],
                      ["after", "After"],
                    ].map(([mode, label]) => (
                      <label
                        key={mode}
                        style={{ display: "flex", alignItems: "center", gap: "8px", marginTop: "6px", fontSize: "13px", color: "var(--foreground)", cursor: recurrenceDisabled ? "not-allowed" : "pointer" }}
                      >
                        <input
                          type="radio"
                          name="recurrence_ends"
                          value={mode}
                          checked={eventForm.recurrence_ends === mode}
                          onChange={() => setEventForm({ ...eventForm, recurrence_ends: mode })}
                          disabled={recurrenceDisabled}
                          data-testid={`recurrence-ends-${mode}`}
                        />
                        <span style={{ width: "44px" }}>{label}</span>
                        {mode === "on" && (
                          <input
                            type="date"
                            className="form-input"
                            value={eventForm.recurrence_end_date}
                            onChange={(e) => setEventForm({ ...eventForm, recurrence_end_date: e.target.value, recurrence_ends: "on" })}
                            disabled={recurrenceDisabled}
                            data-testid="recurrence-end-input"
                          />
                        )}
                        {mode === "after" && (
                          <>
                            <input
                              type="number"
                              min={1}
                              max={MAX_RECURRENCE_COUNT}
                              className="form-input"
                              style={{ width: "72px" }}
                              value={eventForm.recurrence_count}
                              onChange={(e) => setEventForm({ ...eventForm, recurrence_count: e.target.value, recurrence_ends: "after" })}
                              disabled={recurrenceDisabled}
                              data-testid="recurrence-count-input"
                            />
                            <span>{Number(eventForm.recurrence_count) === 1 ? "time" : "times"}</span>
                          </>
                        )}
                      </label>
                    ))}
                  </div>
                )}

                {recurrenceDisabled && eventForm.recurrence !== "none" && (
                  <div className="text-xs text-gray-400 mt-1">Instance mode: recurrence rule is locked.</div>
                )}
              </div>
            )}
          </div>

          {/* All-day events are dates, not times: no timezone to choose. */}
          {!eventForm.all_day && (
          <div className="form-group">
            <CollapsibleSectionHeader
              label="Timezone Mode"
              expanded={isTimezoneModeExpanded}
              onToggle={() => setIsTimezoneModeExpanded(v => !v)}
              testId="timezone-mode-toggle"
            />
            {isTimezoneModeExpanded && (
              <div style={{ display: "flex", flexDirection: "row", gap: "16px", marginTop: "8px", alignItems: "center" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "13px", color: "var(--foreground)" }}>
                  <input
                    type="radio"
                    name="timezone_mode"
                    value="absolute"
                    checked={eventForm.timezone_mode === "absolute"}
                    onChange={() => setEventForm({ ...eventForm, timezone_mode: "absolute" })}
                    style={{ cursor: "pointer" }}
                  />
                  Absolute
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "13px", color: "var(--foreground)" }}>
                  <input
                    type="radio"
                    name="timezone_mode"
                    value="naive"
                    checked={eventForm.timezone_mode === "naive"}
                    onChange={() => setEventForm({ ...eventForm, timezone_mode: "naive" })}
                    style={{ cursor: "pointer" }}
                  />
                  Local
                </label>
              </div>
            )}
          </div>
          )}
          
        </div>

        <div className="flex flex-col gap-2 mt-4">
          {isRecurringInstanceEdit && (
            <div className="flex items-center justify-between rounded-md border border-slate-600 bg-slate-900/70 p-1">
              <button
                className="flex-1 text-sm px-3 py-1 rounded"
                style={rigidEditScope === "instance" ? { background: "#0ea5e9", color: "#ffffff" } : { color: "#94a3b8" }}
                onClick={() => setRigidEditScope("instance")}
                data-testid="scope-instance-btn"
              >
                Instance
              </button>
              <button
                className="flex-1 text-sm px-3 py-1 rounded"
                style={rigidEditScope === "series" ? { background: "#0ea5e9", color: "#ffffff" } : { color: "#94a3b8" }}
                onClick={() => setRigidEditScope("series")}
                data-testid="scope-series-btn"
              >
                Series
              </button>
              <button
                className="flex-1 text-sm px-3 py-1 rounded"
                style={rigidEditScope === "now-and-future" ? { background: "#0ea5e9", color: "#ffffff" } : { color: "#94a3b8" }}
                onClick={() => setRigidEditScope("now-and-future")}
                data-testid="scope-future-btn"
              >
                Now & Future
              </button>
            </div>
          )}

          {rigidSaveError && (
            <div className="auth-error" data-testid="rigid-save-error">{rigidSaveError}</div>
          )}

          <div className="flex gap-2">
            {editingEvent && (
              <button
                className="delete-btn flex-1"
                onClick={() => handleDeleteRigidEvent(isRecurringInstanceEdit ? rigidEditScope : "series")}
                data-testid="delete-event-btn"
              >
                Delete
              </button>
            )}

            <button
              className="add-event-btn flex-1"
              onClick={() => handleSaveRigidEvent(isRecurringInstanceEdit ? rigidEditScope : "series")}
              data-testid="save-event-btn"
            >
              {"Save"}
            </button>

            <button
              className="delete-btn flex-1"
              onClick={handleCancelConfig}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  };

  // Recurring Flex Tasks: the flex panel's Repeat section. Editable on a
  // new task and on a repeating task; on a copy, a read-only summary with a
  // link to its repeating task; not shown on a plain existing task.
  const renderFlexRepeatSection = () => {
    if (!editingRepeatDef && !isNewFlexItem) {
      const definitionId = editingFlexEvent?.repeat_definition_id;
      if (!definitionId) return null;
      const def = repeatingTasks.find((d) => d.id === definitionId);
      return (
        <div className="form-group" data-testid="flex-repeat-summary">
          <label className="form-label">Repeat</label>
          <div className="flex-repeat-summary">
            <Repeat size={12} />
            <span data-testid="flex-repeat-summary-text">{describeRepeat(def)}</span>
          </div>
          {def && (
            <button
              type="button"
              className="flex-repeat-link"
              onClick={() => viewRepeatDefinition(definitionId)}
              data-testid="flex-repeat-view-def"
            >
              View repeating task
            </button>
          )}
        </div>
      );
    }
    const options = editingRepeatDef ? RECURRENCE_OPTIONS.filter((o) => o.value !== "none") : RECURRENCE_OPTIONS;
    const setField = (patch) => {
      setRepeatError(null);
      setRepeatForm((f) => ({ ...f, ...patch }));
    };
    return (
      <div className="form-group">
        <CollapsibleSectionHeader
          label="Repeat"
          expanded={isFlexRepeatExpanded}
          onToggle={() => setIsFlexRepeatExpanded(v => !v)}
          testId="flex-repeat-toggle"
        />
        {isFlexRepeatExpanded && (
          <div className="mt-2">
            <Select
              value={repeatForm.cadence}
              onValueChange={(value) => setField({
                cadence: value,
                days_of_week: repeatForm.days_of_week.length > 0 ? repeatForm.days_of_week : [todayWeekdayInTz()],
              })}
            >
              <SelectTrigger className="rounded-none" data-testid="flex-recurrence-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {repeatForm.cadence === "weekly" && (
              <div className="mt-3">
                <label className="form-label">Repeat On</label>
                <div style={{ display: "flex", gap: "4px" }} data-testid="flex-recurrence-days-row">
                  {WEEKDAY_LABELS.map((label, i) => {
                    const isSelected = repeatForm.days_of_week.includes(i);
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setField({
                          days_of_week: isSelected
                            ? repeatForm.days_of_week.filter((d) => d !== i)
                            : [...repeatForm.days_of_week, i],
                        })}
                        aria-pressed={isSelected}
                        data-testid={`flex-recurrence-day-${i}`}
                        style={{
                          flex: 1,
                          padding: "6px 0",
                          fontSize: "12px",
                          fontWeight: 600,
                          border: "1px solid #E5E5E5",
                          background: isSelected ? "#0ea5e9" : "#FAFAFA",
                          color: isSelected ? "#ffffff" : "#737373",
                          cursor: "pointer",
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {repeatForm.cadence === "monthly" && (
              <div className="text-xs text-gray-400 mt-2" data-testid="flex-recurrence-monthly-note">
                {editingRepeatDef
                  ? `On the ${ordinalDay(editingRepeatDef.anchor_day)} of each month (last day in shorter months).`
                  : "On today's date each month (last day in shorter months)."}
              </div>
            )}

            {repeatForm.cadence !== "none" && (
              <>
                <div className="mt-3">
                  <label className="form-label">Repeat Until (optional)</label>
                  <input
                    type="date"
                    className="form-input"
                    value={repeatForm.end_date}
                    onChange={(e) => setField({ end_date: e.target.value })}
                    data-testid="flex-recurrence-end-input"
                  />
                </div>
                <div className="mt-3">
                  <label className="form-label">If the last copy isn't done</label>
                  <select
                    className="form-input"
                    value={repeatForm.if_unfinished}
                    onChange={(e) => setField({ if_unfinished: e.target.value })}
                    data-testid="flex-recurrence-unfinished-select"
                  >
                    <option value="skip">Skip this cycle</option>
                    <option value="add">Add another</option>
                  </select>
                </div>
              </>
            )}
            {repeatError && (
              <div className="text-xs mt-2" style={{ color: "#DC2626" }} data-testid="flex-repeat-error">{repeatError}</div>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderFlexConfigPanel = () => {
    const handleFlexKeyDown = (e) => {
      if (e.key === "Delete") {
        const target = e.target;
        const isEditableField =
          target?.tagName === "INPUT" ||
          target?.tagName === "TEXTAREA" ||
          target?.tagName === "SELECT" ||
          target?.isContentEditable ||
          !!target?.closest?.('[contenteditable="true"]');

        if (isNewFlexItem || !(editingFlexEvent || editingRepeatDef) || isEditableField) return;
        e.preventDefault();
        handleDeleteFlexEvent();
        return;
      }

      if (e.key !== "Enter") return;
      if (e.target.tagName === "TEXTAREA" && e.shiftKey) return;
      if (e.target.tagName === "BUTTON" || e.target.tagName === "A") return;
      e.preventDefault();
      handleSaveFlexEvent();
    };
    return (
    <div ref={flexPanelRef} className="flex flex-col flex-1" onKeyDown={handleFlexKeyDown} tabIndex={0} style={{ outline: "none" }}>
      <div className="flex-1 overflow-y-auto pr-2">
        <div className="form-group">
          <input
            type="text"
            className="form-input"
            placeholder="Item Name"
            value={flexForm.name}
            onChange={handleFlexNameChange}
            data-testid="flex-name-input"
          />
        </div>

        <div className="form-group">
          <label className="form-label">Duration (minutes)</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              className="form-input flex-1"
              placeholder="60"
              value={flexForm.duration}
              onChange={handleFlexDurationChange}
              data-testid="flex-duration-input"
            />
            <div className="flex flex-col gap-1">
              <button
                className="step-btn"
                onClick={handleStepUp}
                data-testid="step-up-btn"
              >
                ▲
              </button>
              <button
                className="step-btn"
                onClick={handleStepDown}
                data-testid="step-down-btn"
              >
                ▼
              </button>
            </div>
          </div>
        </div>

        <div className="form-group flex-priority-row">
          <label className="form-label">Priority</label>
          <select
            className="form-input"
            value={flexForm.priority}
            onChange={handleFlexPriorityChange}
            data-testid="flex-priority-select"
          >
            <option value={1}>1 - Critical</option>
            <option value={2}>2 - High</option>
            <option value={3}>3 - Medium</option>
            <option value={4}>4 - Low</option>
          </select>
        </div>

        {!editingRepeatDef && repeatForm.cadence === "none" && !(!isNewFlexItem && editingFlexEvent?.repeat_definition_id) && (
        <div className="form-group">
          <label className="form-label">Deadline</label>
          <input
            type="datetime-local"
            className="form-input"
            value={flexForm.deadline}
            // Dates before today, and times today earlier than
            // now + min_duration, are disabled by the min attribute below --
            // the earliest pickable deadline always leaves enough room for
            // the task to theoretically start and run (Task Deadlines Part 1).
            min={utcIsoToTzLocal(
              new Date(Date.now() + globalSettings.minDuration * 60000).toISOString(),
              globalSettings.timezone
            )}
            onChange={handleFlexDeadlineChange}
            data-testid="flex-deadline-input"
          />
        </div>
        )}

        {renderFlexRepeatSection()}
      </div>

      <div className="flex gap-2 mt-4">
        {!isNewFlexItem && (editingFlexEvent || editingRepeatDef) && (
          <button
            className="delete-btn flex-1"
            onClick={handleDeleteFlexEvent}
            data-testid="delete-flex-btn"
          >
            Delete
          </button>
        )}

        <button
          className="add-event-btn flex-1"
          onClick={handleSaveFlexEvent}
          disabled={isSavingFlexEvent}
          aria-busy={isSavingFlexEvent}
          data-testid="save-flex-btn"
        >
          {isSavingFlexEvent ? "Saving…" : "Save"}
        </button>

        <button
          className="delete-btn flex-1"
          onClick={handleCancelConfig}
        >
          Cancel
        </button>
      </div>
    </div>
    );
  };

  const handleSaveSettings = useCallback(async () => {
    const minDurationValue = settingsForm.minDuration === "" ? 15 : parseInt(settingsForm.minDuration) || 15;
    const followsDevice = settingsForm.timezone === LOCAL_TIMEZONE_OPTION;
    const newSettings = {
      minDuration: minDurationValue,
      timezone: followsDevice ? getDeviceTimezone() : settingsForm.timezone,
      timezoneFollowsDevice: followsDevice,
      deviceTimezoneRecorded: followsDevice || globalSettings.deviceTimezoneRecorded,
      notifyLeadMinutes: clampMinutes(settingsForm.notifyLeadMinutes, NOTIFY_LEAD_RANGE, NOTIFY_LEAD_DEFAULT),
      extendIncrementMinutes: clampMinutes(settingsForm.extendIncrementMinutes, EXTEND_INCREMENT_RANGE, EXTEND_INCREMENT_DEFAULT),
      flexNotifications: settingsForm.flexNotifications !== false,
    };
    setGlobalSettings(newSettings);
    try {
      await axios.put(`${API}/settings`, {
        min_duration: newSettings.minDuration,
        timezone: newSettings.timezone,
        timezone_follows_device: newSettings.timezoneFollowsDevice,
        notify_lead_minutes: newSettings.notifyLeadMinutes,
        extend_increment_minutes: newSettings.extendIncrementMinutes,
        flex_notifications: newSettings.flexNotifications,
        ...(followsDevice ? { device_timezone_recorded: true } : {}),
      });
    } catch (error) {
      console.error("Failed to persist settings:", error);
    }
    setPanelMode("idle");
  }, [settingsForm, globalSettings.deviceTimezoneRecorded]);

  // Keyboard shortcut: Enter to save in settings panel
  useEffect(() => {
  if (panelMode !== "settings") return;
  const handleKeyDown = (e) => {
    if (e.key === "Enter") handleSaveSettings();
  };
  window.addEventListener("keydown", handleKeyDown);
  return () => window.removeEventListener("keydown", handleKeyDown);
}, [panelMode, handleSaveSettings]);

  // Task Deadlines Part 1 -- deadline badge display. User-facing and must
  // respect the app's configured timezone, matching FlexTooltip's convention.
  const formatDeadlineBadge = (isoString) => {
    const tz = getEffectiveTimezone(globalSettings.timezone);
    return new Date(isoString).toLocaleString("en-US", {
      timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  };

  const renderSettingsPanel = () => (
    <div className="settings-panel">
      <div className="settings-panel-header">
        <button
          className="settings-close-btn"
          onClick={() => setPanelMode("idle")}
          data-testid="settings-close-btn"
        >
          <X size={18} />
        </button>
      </div>

      <div className="settings-panel-scroll">
        {/* Timezone */}
        <div className="form-group">
          <label className="form-label">Timezone</label>
          <select
            className="form-input"
            value={settingsForm.timezone}
            onChange={(e) => setSettingsForm(prev => ({ ...prev, timezone: e.target.value }))}
            data-testid="timezone-select"
          >
            {TIMEZONE_OPTIONS.map(tz => (
              <option key={tz.value} value={tz.value}>{tz.label}</option>
            ))}
            {!TIMEZONE_OPTIONS.some(tz => tz.value === settingsForm.timezone) && (
              <option value={settingsForm.timezone}>{settingsForm.timezone}</option>
            )}
          </select>
        </div>

        {/* Min Duration Section */}
        <div className="form-group">
          <label className="form-label">Min Duration</label>
          <input
            type="text"
            className="form-input"
            placeholder="15"
            value={settingsForm.minDuration}
            onChange={(e) => {
              const value = e.target.value.replace(/[^0-9]/g, '');
              setSettingsForm(prev => ({ ...prev, minDuration: value }));
            }}
            data-testid="global-min-duration"
          />
          <div className="settings-note">
            Applies to all flex items
          </div>
        </div>

        {/* Notifications: the device toggle acts immediately; the fields
            below it save with Save. */}
        <div data-testid="notifications-settings-group">
          <div className="form-label">Notifications</div>
          <NotificationsSetting api={API} />
          <NotificationPrefsFields form={settingsForm} setForm={setSettingsForm} />
        </div>
      </div>

      <div className="settings-actions">
        <button
          className="delete-btn settings-action-btn"
          onClick={() => setPanelMode("idle")}
        >
          Cancel
        </button>
        <button
          className="add-event-btn settings-action-btn"
          onClick={handleSaveSettings}
          data-testid="save-settings-btn"
        >
          Save
        </button>
      </div>
    </div>
  );

  const renderSidebarContent = () => {
    switch (panelMode) {
      case "idle":
        return renderIdlePanel();
      case "rigid-config":
        return renderRigidConfigPanel();
      case "flex-config":
        return renderFlexConfigPanel();
      case "settings":
        return renderSettingsPanel();
      case "calendar-create":
        return renderCalendarCreatePanel();
      case "calendar-config":
        return renderCalendarConfigPanel();
      case "calendar-import":
        return renderCalendarImportPanel();
      default:
        return renderIdlePanel();
    }
  };

  const getPanelModeTitle = (mode) => {
    switch (mode) {
      case "rigid-config": return editingEvent ? "Edit Event" : "New Event";
      case "flex-config":
        if (editingRepeatDef) return "Repeating Task";
        return editingFlexEvent && !isNewFlexItem ? "Edit Task" : "New Task";
      case "settings": return "Settings";
      case "calendar-create": return "New Calendar";
      case "calendar-import": return "Import a calendar";
      case "calendar-config": {
        const cal = calendars.find((c) => c.id === configCalendarId);
        return cal ? cal.name : "Calendar";
      }
      default: return null; // idle: no title — toggle + calendar list already give context
    }
  };

  // Persistent calendar list — a sibling of renderSidebarContent(), not a
  // branch inside it, so it survives panelMode changes (opening/closing a
  // form does not unmount it, and its checked/expanded state lives at the
  // App level alongside `calendars` itself, not as local state here).
  const handleDeleteCalendarClick = (cal) => {
    setDeleteCalendarError(null);
    setDeletingCalendar(cal);
  };

  // Toggles a calendar's membership on the event being created/edited.
  // Remembers the choice (lastFormCalendarIds) so the next new event
  // defaults to it.
  const toggleFormCalendarMembership = (calId) => {
    setFormCalendarIds((prev) => {
      const next = prev.includes(calId) ? prev.filter((id) => id !== calId) : [...prev, calId];
      setLastFormCalendarIds(next);
      return next;
    });
  };

  // Per-viewer calendar preferences (the bell) persist through
  // PUT /calendars/{id}/view-prefs on top of the optimistic local flip.
  // Fire-and-forget: a failed PUT logs but doesn't roll back the click.
  // Also records the write (calendarsSync.js) and puts the value into
  // `calendars`, so a GET /calendars answered later can't undo it.
  const persistCalendarViewPref = (calendarId, field, value) => {
    const settle = calendarsSyncRef.current.recordWrite(calendarId, { [field]: value });
    setCalendars((prev) => prev.map((cal) => (cal.id === calendarId ? { ...cal, [field]: value } : cal)));
    axios.put(`${API}/calendars/${calendarId}/view-prefs`, { [field]: value })
      .catch((error) => console.error(`Failed to persist ${field} for calendar ${calendarId}:`, error))
      .finally(settle);
  };

  // The bell, on every calendar row: whether this viewer gets event
  // reminders for the calendar. Persists at once.
  const renderBellControl = (cal) => {
    const on = calendarNotifyStates[cal.id] ?? true;
    return (
      <button
        type="button"
        className="calendar-row-icon-btn calendar-row-bell-btn"
        onClick={() => {
          setCalendarNotifyStates((prev) => ({ ...prev, [cal.id]: !on }));
          persistCalendarViewPref(cal.id, "notify", !on);
        }}
        aria-pressed={on}
        aria-label={on ? `Stop event reminders for ${cal.name}` : `Send event reminders for ${cal.name}`}
        title={on ? "Event reminders on" : "Event reminders off"}
        data-testid={`calendar-bell-${cal.id}`}
      >
        {on ? <Bell size={14} /> : <BellOff size={14} />}
      </button>
    );
  };

  // Import a calendar (2026-10-18: a panel mode, replacing the old modal):
  // New calendar -> Import, or Profile -> Shared calendars. An .ics file
  // always becomes a new calendar (importing into an existing one happens
  // in its gear panel, handleSaveCalendarConfig); after an import the
  // events and calendar list reload and the panel closes with one toast.
  // Calendars shared with the user are listed below the file button --
  // sharing grants access straight away, so there's nothing to accept;
  // the list is what the modal showed.
  const renderCalendarImportPanel = () => (
    <IcsImportPanel
      onImport={(body) => runIcsImport(body, false)}
      onCancel={() => setPanelMode("idle")}
      onDone={async (result) => {
        await fetchCalendars();
        fetchEvents();
        setPanelMode("idle");
        toast(icsImportMessage(result));
      }}
    >
      {sharedCalendars.length > 0 && (
        <div className="form-group" data-testid="shared-calendars-section">
          <label className="form-label">Shared with you</label>
          <ImportCalendarsList
            entries={sharedCalendars.map((cal) => ({
              id: cal.access_id,
              calendarName: cal.name,
              ownerLabel: cal.owner_email || "Unknown",
              source: "native",
            }))}
          />
        </div>
      )}
    </IcsImportPanel>
  );

  // The first step of calendar creation: name + color only. On success it
  // hands straight off to calendar-config for the new calendar. Cancel has
  // nothing to clean up: nothing was created yet.
  const renderCalendarCreatePanel = () => (
    <div className="settings-panel">
      <div className="settings-panel-header">
        <button
          className="settings-close-btn"
          onClick={() => { setPanelMode("idle"); setNewCalendarName(""); setAddCalendarError(null); }}
          data-testid="calendar-create-close-btn"
        >
          <X size={18} />
        </button>
      </div>
      <div className="settings-panel-scroll" data-testid="calendar-create-panel">
        {addCalendarError && (
          <div className="auth-error" data-testid="add-calendar-error">{addCalendarError}</div>
        )}
        <div className="form-group">
          <label className="form-label">Name</label>
          <input
            type="text"
            className="form-input"
            placeholder="Calendar name"
            value={newCalendarName}
            autoFocus
            onChange={(e) => setNewCalendarName(e.target.value)}
            data-testid="new-calendar-name-input"
          />
        </div>
        <div className="form-group">
          <label className="form-label">Color</label>
          <input
            type="color"
            value={newCalendarColor}
            onChange={(e) => setNewCalendarColor(e.target.value)}
            data-testid="new-calendar-color-input"
          />
        </div>
      </div>
      <div className="settings-actions">
        <button
          className="delete-btn settings-action-btn"
          onClick={() => { setPanelMode("idle"); setNewCalendarName(""); setAddCalendarError(null); }}
          data-testid="cancel-new-calendar-btn"
        >
          Cancel
        </button>
        <button
          className="add-event-btn settings-action-btn"
          onClick={async () => {
            if (!newCalendarName.trim()) return;
            const result = await createCalendar(newCalendarName.trim(), newCalendarColor);
            if (result.ok) {
              setNewCalendarName("");
              setAddCalendarError(null);
              setConfigCalendarId(result.calendar.id);
              setPanelMode("calendar-config");
            } else {
              setAddCalendarError(result.message);
            }
          }}
          data-testid="save-new-calendar-btn"
        >
          Create
        </button>
      </div>
    </div>
  );

  const handleCancelCalendarConfig = () => {
    // The draft-lifecycle effect (near buildCalendarConfigDraft) discards
    // calendarConfigDraft the instant panelMode leaves "calendar-config" --
    // nothing here was ever sent to the backend, so there's nothing to
    // undo. Used by both the Cancel button and every click-away case
    // (another gear, "+ New calendar", another task/event, the grid
    // background) that already sets panelMode/configCalendarId elsewhere.
    setPanelMode("idle");
    setConfigCalendarId(null);
  };

  // Staged Calendar Editing -- diffs calendarConfigDraft against the
  // snapshot taken when the panel opened, fires one call per group that
  // actually changed (all in parallel, no cross-field atomicity -- matches
  // this panel's behavior before this feature, just now visible in one
  // batched moment), and only closes the panel if every one of them
  // succeeded.
  const handleSaveCalendarConfig = async () => {
    const draft = calendarConfigDraft;
    const original = originalCalendarConfigDraftRef.current;
    const cal = calendars.find((c) => c.id === configCalendarId);
    if (!draft || !original || !cal) return;
    const isOwner = cal.is_owner;

    const tasks = [];

    const patchFields = {};
    if (isOwner && draft.name !== original.name) patchFields.name = draft.name;
    if (isOwner && draft.color !== original.color) patchFields.color = draft.color;
    if (Object.keys(patchFields).length > 0) {
      tasks.push({ key: "calendar", promise: updateCalendar(cal.id, patchFields) });
    }

    // A non-owner's color is their own view preference, not the calendar's.
    const viewPrefFields = {};
    if (!isOwner && draft.color !== original.color) viewPrefFields.color = draft.color;
    if (Object.keys(viewPrefFields).length > 0) {
      const settleViewPrefs = calendarsSyncRef.current.recordWrite(cal.id, viewPrefFields);
      tasks.push({
        key: "view-prefs",
        promise: axios.put(`${API}/calendars/${cal.id}/view-prefs`, viewPrefFields)
          .then(() => ({ ok: true }))
          .catch((error) => ({ ok: false, message: error.response?.data?.detail || "Failed to save color" }))
          .finally(settleViewPrefs),
      });
    }

    (draft.pendingShareActions || [])
      .filter((a) => a.status !== "success")
      .forEach((action) => {
        tasks.push(
          action.type === "add"
            ? { key: `share-${action.id}`, actionId: action.id, promise: shareCalendarWithUser(cal.id, action.payload) }
            : { key: `share-${action.id}`, actionId: action.id, promise: removeCalendarAccess(cal.id, action.payload.accessId) }
        );
      });

    // ICS import (2026-10-17): a picked file is imported by this Save.
    if (draft.icsFile && canWriteCalendar(cal)) {
      tasks.push({ key: "ics", promise: runIcsImport({ ics: draft.icsFile.text, calendar_id: cal.id }, false) });
    }

    if (tasks.length === 0) {
      handleCancelCalendarConfig();
      return;
    }

    setCalendarConfigSaveState({ saving: true, fieldErrors: {} });
    const settled = await Promise.allSettled(tasks.map((t) => t.promise));

    let anyFailure = false;
    let icsResult = null;
    const shareResultsByActionId = {};
    const fieldErrors = {};
    settled.forEach((result, i) => {
      const task = tasks[i];
      // shareCalendarWithUser/removeCalendarAccess/updateCalendar all
      // catch internally and resolve { ok, message } rather than
      // rejecting -- Promise.allSettled still calls that "fulfilled", so
      // the real outcome is .value.ok, not the settle status.
      const value = result.status === "fulfilled" ? result.value : { ok: false, message: result.reason?.message };
      if (task.actionId) shareResultsByActionId[task.actionId] = value;
      if (task.key === "ics" && value.ok) icsResult = value.data;
      if (!value.ok) {
        anyFailure = true;
        // Share-action failures surface inline on their own pending row
        // (below) instead of here -- fieldErrors is only for the non-share
        // groups.
        if (!task.actionId) fieldErrors[task.key] = value.message || "Failed to save";
      }
    });
    setCalendarConfigSaveState({ saving: false, fieldErrors });

    // Mark each share action's outcome. A succeeded one gets "success" so
    // a later Save never re-POSTs it; a failed "add" gets its error
    // attached and stays editable (see stageShareAdd/editShareAction) --
    // an invalid-email failure fails the exact same way on an unmodified
    // retry, so it's not just requeued silently. A failed "remove" simply
    // stays "pending" for automatic retry -- there's no payload to correct.
    if (Object.keys(shareResultsByActionId).length > 0) {
      setCalendarConfigDraft((prev) => {
        if (!prev) return prev;
        const pendingShareActions = (prev.pendingShareActions || []).map((a) => {
          const outcome = shareResultsByActionId[a.id];
          if (!outcome) return a;
          return outcome.ok ? { ...a, status: "success", error: null } : { ...a, status: "error", error: outcome.message || "Failed" };
        });
        return { ...prev, pendingShareActions };
      });
    }
    // A failed add must not linger as an optimistic roster row --
    // remounting CalendarRosterPanel makes it refetch the real roster,
    // which correctly omits anything that was never actually persisted.
    setRosterRefreshNonce((n) => n + 1);

    if (icsResult) {
      // Done: a later Save that retries some other failed group must not
      // import the same file again.
      setCalendarConfigDraft((prev) => (prev ? { ...prev, icsFile: null, icsError: null } : prev));
      fetchEvents();
      fetchCalendars();
      toast(icsImportMessage(icsResult));
    }

    if (anyFailure) {
      // Leave the panel open. Fields/actions that did succeed already
      // reflect their new state (calendars refetched by updateCalendar,
      // pendingShareActions updated above) -- no reason to revert them,
      // matching this panel's pre-existing zero cross-field atomicity.
      return;
    }

    // Full success -- a non-owner's saved color goes into `calendars` too,
    // so a later GET /calendars can't reset it, then close.
    if (Object.keys(viewPrefFields).length > 0) {
      setCalendars((prev) => prev.map((c) => (c.id === cal.id ? { ...c, ...viewPrefFields } : c)));
    }

    setPanelMode("idle");
    setConfigCalendarId(null);
  };

  // The per-calendar panel the gear opens. Every viewer can open it; what's
  // shown is gated per section: Sharing and Rename are owner-only, Color is
  // everyone (a different write path depending on role), and Delete
  // becomes "stop viewing" for a shared calendar.
  //
  // Staged Calendar Editing -- everything below reads/writes
  // calendarConfigDraft, not live state; nothing here persists until Save.
  const renderCalendarConfigPanel = () => {
    const cal = calendars.find((c) => c.id === configCalendarId);
    if (!cal) return null;
    const draft = calendarConfigDraft;
    if (!draft) return null; // one-frame gap between panelMode flipping and the draft-init effect committing
    const isOwner = cal.is_owner;
    const isWritableCal = canWriteCalendar(cal);
    const { fieldErrors, saving } = calendarConfigSaveState;
    const draftSetter = (patch) => setCalendarConfigDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    const failedShareAdds = (draft.pendingShareActions || []).filter((a) => a.type === "add" && a.status === "error");
    return (
      <div className="settings-panel">
        <div className="settings-panel-scroll" data-testid="calendar-config-panel">
          {isOwner && (
            <div className="form-group">
              <label className="form-label">Sharing</label>
              <CalendarRosterPanel
                key={`${cal.id}-${rosterRefreshNonce}`}
                calendarId={cal.id}
                fetchRoster={fetchCalendarRoster}
                onShare={(calId, payload) => stageShareAdd(calId, payload)}
                onRemove={(calId, accessId) => stageShareRemove(calId, accessId)}
                onResend={resendShareInvite}
              />
              {failedShareAdds.map((action) => (
                <div key={action.id} className="calendar-config-pending-share-failure" data-testid={`calendar-config-share-failure-${action.id}`}>
                  <input
                    type="email"
                    className="form-input"
                    value={action.payload.email}
                    onChange={(e) => editShareAction(action.id, e.target.value)}
                    data-testid={`calendar-config-share-failure-email-${action.id}`}
                  />
                  <span className="calendar-config-field-error" data-testid={`calendar-config-share-failure-message-${action.id}`}>
                    <AlertTriangle size={12} /> {action.error}
                  </span>
                  <button
                    type="button"
                    className="calendar-config-pending-share-discard-btn"
                    onClick={() => discardShareAction(action.id)}
                    aria-label="Discard this invite"
                    data-testid={`calendar-config-share-failure-discard-${action.id}`}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {isOwner && (
            <div className="form-group">
              <label className="form-label">Name</label>
              <input
                type="text"
                className="form-input"
                value={draft.name}
                onChange={(e) => draftSetter({ name: e.target.value })}
                data-testid={`calendar-rename-input-${cal.id}`}
              />
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Color</label>
            <input
              type="color"
              className="calendar-row-color-input"
              value={draft.color || DEFAULT_CALENDAR_COLOR}
              onChange={(e) => draftSetter({ color: e.target.value })}
              data-testid={`calendar-color-input-${cal.id}`}
              title="Calendar color"
            />
            {(fieldErrors["calendar"] || fieldErrors["view-prefs"]) && (
              <div className="calendar-config-field-error" data-testid={`calendar-config-calendar-error-${cal.id}`}>
                <AlertTriangle size={12} /> {fieldErrors["calendar"] || fieldErrors["view-prefs"]}
              </div>
            )}
          </div>

          {/* ICS import/export (2026-10-17). Export downloads now and is
              fixed events only -- tasks never leave the app. Import is
              staged like everything else here: the picked file waits in
              the draft and the panel's Save imports it into this calendar;
              Cancel drops it. Only for calendars the viewer can write to. */}
          <div className="form-group">
            <label className="form-label">.ics file</label>
            <div className="ics-export-actions">
              <button
                type="button"
                className="calendar-add-choice-btn"
                onClick={() => downloadIcs(`/calendars/${cal.id}/export.ics`, `${cal.name}.ics`)}
                data-testid={`calendar-export-ics-${cal.id}`}
              >
                <Download size={14} /> Export
              </button>
              {isWritableCal && (
                <IcsFileButton
                  testId={`calendar-import-ics-${cal.id}`}
                  onPicked={(picked) => draftSetter({ icsFile: picked.error ? null : picked, icsError: picked.error || null })}
                />
              )}
            </div>
            {draft.icsFile && (
              <div className="ics-file-name" data-testid={`calendar-import-ics-file-${cal.id}`}>
                {draft.icsFile.fileName}
                <span className="ics-hint"> (imported when you Save)</span>
              </div>
            )}
            {(draft.icsError || fieldErrors["ics"]) && (
              <div className="calendar-config-field-error" data-testid={`calendar-import-ics-error-${cal.id}`}>
                <AlertTriangle size={12} /> {draft.icsError || fieldErrors["ics"]}
              </div>
            )}
            <div className="ics-hint">Exports fixed events only; tasks stay in Flowuality.</div>
          </div>
        </div>

        <div className="settings-actions">
          <button
            type="button"
            className="calendar-row-delete-btn"
            onClick={() => handleDeleteCalendarClick(cal)}
            disabled={isOwner && ownedCalendarCount <= 1}
            data-testid={`calendar-delete-${cal.id}`}
            aria-label={isOwner ? "Delete calendar" : "Remove shared calendar"}
          >
            <X size={12} /> {isOwner ? "Delete calendar" : "Stop viewing this shared calendar"}
          </button>
          <button
            className="delete-btn settings-action-btn"
            onClick={handleCancelCalendarConfig}
            disabled={saving}
            data-testid="calendar-config-cancel-btn"
          >
            Cancel
          </button>
          <button
            className="add-event-btn settings-action-btn"
            onClick={handleSaveCalendarConfig}
            disabled={saving}
            data-testid="calendar-config-save-btn"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    );
  };

  const renderCalendarList = () => {
    return (
    <div className="calendar-list" data-testid="calendar-list">
      <div className="calendar-list-header">
        <CollapsibleSectionHeader
          label="Calendars"
          expanded={isCalendarListExpanded}
          onToggle={() => setIsCalendarListExpanded((prev) => !prev)}
          testId="calendar-list-toggle"
        />
        <button
          type="button"
          className="calendar-row-settings-btn"
          onClick={() => downloadIcs("/export.ics", "Flowuality.ics")}
          aria-label="Export all calendars"
          title="Export all calendars"
          data-testid="calendar-export-all-ics"
        >
          <Download size={14} />
        </button>
      </div>
      {isCalendarListExpanded && (
        <div className="calendar-list-body">
          {calendarsFetchError && (
            <div className="auth-error" data-testid="calendar-list-error">{calendarsFetchError}</div>
          )}
          {calendars.map((cal) => {
            const isMember = formCalendarIds.includes(cal.id);
            const isWritable = canWriteCalendar(cal);
            return (
              <div
                key={cal.id}
                className={`calendar-row${panelMode === "calendar-config" && configCalendarId === cal.id ? " calendar-row-active" : ""}`}
                data-testid={`calendar-row-${cal.id}`}
              >
                <div className="calendar-row-main">
                  {renderBellControl(cal)}
                  {panelMode === "rigid-config" && (
                    <input
                      type="checkbox"
                      className="calendar-row-membership-check"
                      checked={isMember}
                      disabled={!isWritable || (isMember && formCalendarIds.length <= 1)}
                      onChange={() => toggleFormCalendarMembership(cal.id)}
                      aria-label={`Assign this event to ${cal.name}`}
                      data-testid={`calendar-membership-${cal.id}`}
                    />
                  )}
                  <div className="calendar-row-badge">
                    <span
                      className="calendar-row-swatch"
                      style={{ backgroundColor: getEffectiveCalendarColor(cal) }}
                      aria-hidden="true"
                    />
                    {/* future: {cal.calendar_type === "shared" && <Users size={11} className="calendar-row-type-icon" />} */}
                  </div>
                  {/* Read-only; rename, recolor, sharing and delete live
                      behind the gear (renderCalendarConfigPanel). */}
                  <span className="calendar-row-name" data-testid={`calendar-row-name-${cal.id}`}>
                    {cal.name}
                  </span>
                  <button
                    type="button"
                    className="calendar-row-settings-btn"
                    onClick={() => { setConfigCalendarId(cal.id); setPanelMode("calendar-config"); }}
                    aria-label={`${cal.name} settings`}
                    title="Calendar settings"
                    data-testid={`calendar-settings-${cal.id}`}
                  >
                    <Settings size={14} />
                  </button>
                </div>
              </div>
            );
          })}
          {isAddCalendarChoiceOpen ? (
            <div className="calendar-add-choice" data-testid="calendar-add-choice">
              <button
                type="button"
                className="calendar-add-choice-btn"
                onClick={() => { setIsAddCalendarChoiceOpen(false); setPanelMode("calendar-create"); setAddCalendarError(null); }}
                data-testid="add-calendar-create-btn"
              >
                <Plus size={14} /> Create
              </button>
              <button
                type="button"
                className="calendar-add-choice-btn"
                onClick={() => { setIsAddCalendarChoiceOpen(false); setPanelMode("calendar-import"); }}
                data-testid="add-calendar-import-btn"
              >
                <ImportIcon size={14} /> Import
              </button>
              <button
                type="button"
                className="calendar-add-choice-cancel-btn"
                onClick={() => setIsAddCalendarChoiceOpen(false)}
                aria-label="Cancel"
                data-testid="cancel-add-calendar-choice-btn"
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="calendar-add-btn"
              onClick={() => setIsAddCalendarChoiceOpen(true)}
              data-testid="add-calendar-btn"
            >
              <Plus size={14} /> New calendar
            </button>
          )}
        </div>
      )}
    </div>
    );
  };

  // App-wide dialogs (the deadline-conflict warning, delete/leave-calendar).
  // Rendered once at the app root rather than inside the Config panel: on
  // mobile that panel only mounts while its tab is open, and these can be
  // opened from the Flex Queue (a touch drag's conflict check). They're
  // portals, so on desktop nothing about where they show changes. Import a
  // calendar used to be one of these; it's the "calendar-import" panel mode
  // now (2026-10-18), and opening a panel mode on mobile switches to the
  // Config tab.
  const renderAppDialogs = () => (
    <>
      <AlertDialog
        open={!!deletingCalendar}
        onOpenChange={(open) => { if (!open) { setDeletingCalendar(null); setDeleteCalendarError(null); } }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deletingCalendar?.is_owner
                ? `Delete "${deletingCalendar?.name}"?`
                : `Stop viewing "${deletingCalendar?.name}"?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteCalendarError ? deleteCalendarError : deletingCalendar?.is_owner ? (() => {
                // Tasks are never calendar-scoped, so there's no task
                // clause here at all -- deleting a calendar can never
                // touch them.
                const eventCount = deletingCalendar?.event_count ?? 0;
                const sharedCount = deletingCalendar?.shared_event_count ?? 0;
                const sentences = [];
                if (eventCount > 0) {
                  sentences.push(`This will permanently delete ${eventCount} event${eventCount === 1 ? "" : "s"}.`);
                }
                if (sharedCount > 0) {
                  sentences.push(`${sharedCount} event${sharedCount === 1 ? "" : "s"} also on other calendars will be removed from this calendar but kept.`);
                }
                return sentences.length > 0 ? sentences.join(" ") : "This calendar has no events.";
              })() : (
                "You'll lose access to this calendar. Getting it back requires asking the owner to share it with you again -- there's no automatic re-invite."
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {!deleteCalendarError && (
              <AlertDialogAction
                onClick={async (e) => {
                  e.preventDefault();
                  if (!deletingCalendar) return;
                  const result = deletingCalendar.is_owner
                    ? await deleteCalendar(deletingCalendar.id)
                    : await leaveSharedCalendar(deletingCalendar.id, deletingCalendar.access_id);
                  if (result.ok) {
                    setDeletingCalendar(null);
                  } else {
                    setDeleteCalendarError(result.message);
                  }
                }}
              >
                {deletingCalendar?.is_owner ? "Delete" : "Remove"}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Task Deadlines Part 1/3 -- cascade warning. Soft-warn, not
          hard-block: OK commits the pending create/edit/reorder via
          cascadeWarning.onConfirm (the candidate call that got us here
          never persisted anything), Cancel aborts via onCancel with
          nothing applied or persisted. */}
      <AlertDialog
        open={!!cascadeWarning}
        onOpenChange={(open) => { if (!open) cascadeWarning?.onCancel(); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>This will push other tasks past their deadlines</AlertDialogTitle>
            <AlertDialogDescription>
              The following items will be bumped and miss their deadlines: {cascadeWarning?.names?.join(", ")}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => cascadeWarning?.onConfirm()}>
              OK
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </>
  );

  // All path-to-screen logic lives in routes.js; this switch only renders.
  const { screen, authMode } = resolveScreen({ session, demoStatus });
  switch (screen) {
    case "loading":
      return <div className="auth-screen"><div className="auth-card" style={{ textAlign: "center", color: "#94a3b8" }}>Loading…</div></div>;
    case "demo-expired":
      return (
        <div className="auth-screen">
          <div className="auth-card" style={{ textAlign: "center" }} data-testid="demo-expired">
            <h1 className="auth-title">Demo over</h1>
            <p className="demo-bootstrap-message">
              This demo has ended and its data is gone. Nothing was saved.
            </p>
            <a className="auth-link-button" href="/demo">Start a new demo</a>
            <a className="auth-link-button" href="/?mode=signup">Create an account</a>
          </div>
        </div>
      );
    case "demo-bootstrap":
      return <DemoBootstrap onReady={handleDemoReady} />;
    case "reset":
      return <AuthScreen mode="reset" onSession={(s) => setSession(s)} />;
    case "auth":
      return <AuthScreen mode={authMode} showBackToHome onSession={(s) => setSession(s)} />;
    case "landing":
      return <LandingPage />;
    default:
      break;
  }

  return (
    <div className={`app-container${isDemoSession ? " app-container-demo" : ""}${isMobile ? " app-container-mobile" : ""}`} data-testid="flexflow-app">
      <Toaster position="top-center" closeButton />
      {isDemoSession && (
        <div className="demo-banner" data-testid="demo-banner">
          <span>Demo: nothing is saved</span>
          <button
            type="button"
            className="demo-banner-link"
            data-testid="demo-create-account"
            onClick={async () => {
              // Counted before the session ends, while the anonymous token
              // still exists to authenticate the call.
              await axios.post(`${API}/demo/convert`).catch(() => {});
              await supabase.auth.signOut().catch(() => {});
              window.location.href = "/?mode=signup";
            }}
          >
            Create account
          </button>
        </div>
      )}
      {isDemoSession && !isDemoGuideDismissed && (
        <div className="demo-guide-card" data-testid="demo-guide-card">
          <span>
            Try dragging items in the flex queue and watch the calendar reflow around them.
          </span>
          <button
            type="button"
            className="demo-guide-dismiss"
            data-testid="demo-guide-dismiss"
            aria-label="Dismiss"
            onClick={() => setIsDemoGuideDismissed(true)}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {/* Mobile layout: one panel at a time, picked by the bottom tab bar.
          Desktop renders all three panels and both grips exactly as before. */}
      {isMobile && (
        <nav className="mobile-tab-bar" data-testid="mobile-tab-bar">
          {[["calendar", "Calendar"], ["queue", "Flex Queue"], ["config", "Config"]].map(([tab, label]) => (
            <button
              key={tab}
              type="button"
              className={`mobile-tab-btn${mobileTab === tab ? " active" : ""}`}
              onClick={() => setMobileTab(tab)}
              data-testid={`mobile-tab-${tab}`}
              aria-current={mobileTab === tab ? "page" : undefined}
            >
              {label}
            </button>
          ))}
        </nav>
      )}
      {/* Left Panel - Config */}
      {(!isMobile || mobileTab === "config") && (
      <aside
        className={isMobile ? "sidebar mobile-panel" : `sidebar${isLeftPanelCollapsed ? " sidebar-collapsed" : ""}${isDraggingLeftPanel ? " panel-dragging" : ""}`}
        style={isMobile || isLeftPanelCollapsed ? undefined : { width: leftPanelWidth, minWidth: leftPanelWidth, maxWidth: leftPanelWidth }}
      >
        {getPanelModeTitle(panelMode) && (
          <div className="panel-mode-title" data-testid="panel-mode-title">
            {getPanelModeTitle(panelMode)}
          </div>
        )}
        <div className="sidebar-scroll-body">
          {renderSidebarContent()}
          {renderCalendarList()}
        </div>
      </aside>
      )}

      {/* Left Panel Resize/Collapse Grip */}
      {!isMobile && (
      <button
        className={`panel-grip-handle left-panel-grip-handle${isDraggingLeftPanel ? " panel-grip-handle-dragging" : ""}`}
        onMouseDown={(e) => startPanelInteraction(e, "left")}
        onTouchStart={(e) => startPanelInteraction(e, "left")}
        onDoubleClick={() => setIsLeftPanelCollapsed(prev => !prev)}
        data-testid="left-panel-toggle-grip"
        aria-label={isLeftPanelCollapsed ? "Expand left panel" : "Collapse left panel"}
      >
        <span className="grip-line" />
        <span className="grip-line" />
        <span className="grip-line" />
        <span className="grip-line" />
      </button>
      )}

      <>
          {/* Center Panel - Flex Queue */}
          {(!isMobile || mobileTab === "queue") && (
          <div
            className={isMobile ? "center-panel mobile-panel" : `center-panel ${isQueueCollapsed ? "center-panel-collapsed" : ""}${isDraggingQueuePanel ? " panel-dragging" : ""}`}
            style={isMobile || isQueueCollapsed ? undefined : { width: queueWidth, minWidth: queueWidth, maxWidth: queueWidth }}
          >
            {renderFlexQueue()}
          </div>
          )}

          {/* Queue Toggle Grip -- anchored to the flex queue panel's right edge */}
          {!isMobile && (
          <button
            className={`panel-grip-handle queue-grip-handle${isDraggingQueuePanel ? " panel-grip-handle-dragging" : ""}`}
            onMouseDown={(e) => startPanelInteraction(e, "queue")}
            onTouchStart={(e) => startPanelInteraction(e, "queue")}
            onDoubleClick={() => setIsQueueCollapsed(prev => !prev)}
            data-testid="queue-toggle-grip"
            aria-label={isQueueCollapsed ? "Expand flex queue" : "Collapse flex queue"}
          >
            <span className="grip-line" />
            <span className="grip-line" />
            <span className="grip-line" />
            <span className="grip-line" />
          </button>
          )}

          {/* Right Panel - Calendar */}
          {(!isMobile || mobileTab === "calendar") && (
          <div className={isMobile ? "mobile-panel" : undefined} style={{ flex: 1, display: "flex", flexDirection: "column", height: isMobile ? undefined : "100vh", overflow: "hidden", minHeight: 0 }} onClick={(e) => { if (e.target === e.currentTarget) { setFlexEvents(prev => prev.filter(i => !i.isTemp)); setPanelMode("idle"); } }}>
            <div className="calendar-topbar">
              <CalendarIcon size={24} />
              <span className="sidebar-title">Flowuality</span>
              <div style={{ fontSize: "11px", color: "#94a3b8", marginLeft: "auto" }}>{clockDisplay}</div>
            </div>
            <main className="main-content">
            <header className="calendar-header" onClick={() => { setFlexEvents(prev => prev.filter(i => !i.isTemp)); setPanelMode("idle"); }}>
              <h1 className="calendar-title" data-testid="calendar-title">
                {getHeaderTitle()}
              </h1>

              <div className="header-controls">
                <button className="today-btn" onClick={handleToday} data-testid="today-btn">
                  Today
                </button>

                {view === "week" ? (
                  // Double arrows = ±7 days (keep the prev-btn/next-btn ids
                  // the older tests use), single arrows = ±1 day.
                  <div className="nav-buttons">
                    <button className="nav-btn" onClick={handlePrevious} data-testid="prev-btn" title="Back one week">
                      <ChevronsLeft size={20} />
                    </button>
                    <button className="nav-btn" onClick={() => shiftWindowByDays(-1)} data-testid="prev-day-btn" title="Back one day">
                      <ChevronLeft size={20} />
                    </button>
                    <button className="nav-btn" onClick={() => shiftWindowByDays(1)} data-testid="next-day-btn" title="Forward one day">
                      <ChevronRight size={20} />
                    </button>
                    <button className="nav-btn" onClick={handleNext} data-testid="next-btn" title="Forward one week">
                      <ChevronsRight size={20} />
                    </button>
                  </div>
                ) : (
                  <div className="nav-buttons">
                    <button className="nav-btn" onClick={handlePrevious} data-testid="prev-btn">
                      <ChevronLeft size={20} />
                    </button>
                    <button className="nav-btn" onClick={handleNext} data-testid="next-btn">
                      <ChevronRight size={20} />
                    </button>
                  </div>
                )}

                <div className="view-toggle" data-testid="view-toggle">
                  <button
                    className={`view-toggle-btn ${view === "month" ? "active" : ""}`}
                    onClick={() => setView("month")}
                    data-testid="view-month-btn"
                  >
                    Month
                  </button>
                  <button
                    className={`view-toggle-btn ${view === "week" ? "active" : ""}`}
                    onClick={() => {
                      // Week view opens on the normal Sunday-start week
                      // containing the target date; from there the window
                      // can slide by days (shiftWindowByDays). Already in
                      // week view -> leave a slid window where it is.
                      if (view !== "week") {
                        const target = (selectedCell || selectedEventId || selectedFlexId) ? selectedDate : currentDate;
                        // Mobile three-day window starts on the target day itself.
                        setCurrentDate(isMobile ? startOfDay(target) : startOfWeek(target));
                      }
                      setView("week");
                    }}
                    data-testid="view-week-btn"
                  >
                    {isMobile ? "3 Day" : "Week"}
                  </button>
                  <button
                    className={`view-toggle-btn ${view === "day" ? "active" : ""}`}
                    onClick={() => {
                      if (selectedCell || selectedEventId || selectedFlexId) {
                        setCurrentDate(selectedDate);
                      }
                      setView("day");
                    }}
                    data-testid="view-day-btn"
                  >
                    Day
                  </button>
                </div>
                {/* The header's own click closes the left panel; the menu's
                    clicks must not reach it, or "Shared calendars" would
                    open the Import panel and close it in the same click. */}
                <div onClick={(e) => e.stopPropagation()}>
                  <ProfileMenu
                    api={API}
                    email={session?.user?.email}
                    hasNewShares={hasNewShares}
                    onOpenSharedCalendars={() => setPanelMode("calendar-import")}
                  />
                </div>
              </div>
            </header>

            {view === "month" && renderMonthView()}
            {view === "week" && renderWeekView()}
            {view === "day" && renderDayView()}
          </main>
          </div>
          )}
        </>
      {renderAppDialogs()}
    </div>
  );
}

export default App;
