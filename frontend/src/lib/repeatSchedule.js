// Recurring Flex Tasks: which days a repeating task makes a copy on, worked
// out in the app from the same fields the server uses, and mirroring the
// server's rule; change both together. Dates are "yyyy-MM-dd" strings in the
// user's timezone setting as the server reads it (App.js repeatToday), never
// the browser's; arithmetic runs in
// UTC so no DST shift can skip or repeat a day.

const parseKey = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

const toKey = (date) => date.toISOString().slice(0, 10);

// Is `dateKey` a due day? Ignores the end date. `rule` is a repeating task
// (cadence, days_of_week Sunday=0, anchor_day). Monthly clamps the anchor
// day to the month's last day, as the server does.
export function repeatDueOn(rule, dateKey) {
  const day = parseKey(dateKey);
  if (rule.cadence === "daily") return true;
  if (rule.cadence === "weekly") return (rule.days_of_week || []).includes(day.getUTCDay());
  if (rule.cadence === "monthly") {
    const lastDay = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0)).getUTCDate();
    return day.getUTCDate() === Math.min(rule.anchor_day, lastDay);
  }
  return false;
}

// The first due day after `dateKey`, or null if there's none on or before
// the end date. 62 days always reaches a due day (monthly ones are at most
// 31 apart).
export function nextRepeatDay(rule, dateKey) {
  const day = parseKey(dateKey);
  for (let i = 1; i <= 62; i += 1) {
    day.setUTCDate(day.getUTCDate() + 1);
    const key = toKey(day);
    if (rule.end_date && key > rule.end_date) return null;
    if (repeatDueOn(rule, key)) return key;
  }
  return null;
}
