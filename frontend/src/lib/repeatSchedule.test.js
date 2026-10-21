import { nextRepeatDay, repeatDueOn } from "./repeatSchedule";

const weekly = (days, end_date = null) => ({ cadence: "weekly", days_of_week: days, end_date });

describe("repeatDueOn", () => {
  test("weekly on picked weekdays (Sunday=0)", () => {
    expect(repeatDueOn(weekly([0]), "2026-10-11")).toBe(true); // Sun
    expect(repeatDueOn(weekly([0]), "2026-10-05")).toBe(false); // Mon
  });

  test("monthly clamps to the month's last day", () => {
    const rent = { cadence: "monthly", anchor_day: 31 };
    expect(repeatDueOn(rent, "2027-02-28")).toBe(true);
    expect(repeatDueOn(rent, "2027-02-27")).toBe(false);
    expect(repeatDueOn(rent, "2027-04-30")).toBe(true);
  });

  test("daily is always due", () => {
    expect(repeatDueOn({ cadence: "daily" }, "2026-10-05")).toBe(true);
  });
});

describe("nextRepeatDay", () => {
  test("Laundry (Sundays) saved Mon Oct 5 -> Sun Oct 11", () => {
    expect(nextRepeatDay(weekly([0]), "2026-10-05")).toBe("2026-10-11");
  });

  test("Trash (Tuesdays) saved Mon Oct 5 -> Tue Oct 6", () => {
    expect(nextRepeatDay(weekly([2]), "2026-10-05")).toBe("2026-10-06");
  });

  test("a Sunday series on a Sunday -> the next Sunday", () => {
    expect(nextRepeatDay(weekly([0]), "2026-10-11")).toBe("2026-10-18");
  });

  test("across a DST change and a month end", () => {
    expect(nextRepeatDay(weekly([0]), "2026-10-31")).toBe("2026-11-01");
    expect(nextRepeatDay({ cadence: "daily" }, "2026-11-01")).toBe("2026-11-02");
  });

  test("the end date is inclusive; none after it", () => {
    expect(nextRepeatDay(weekly([0], "2026-10-11"), "2026-10-05")).toBe("2026-10-11");
    expect(nextRepeatDay(weekly([0], "2026-10-10"), "2026-10-05")).toBe(null);
  });

  test("weekly on several days -> the nearest one after today", () => {
    expect(nextRepeatDay(weekly([2, 4]), "2026-10-05")).toBe("2026-10-06"); // Mon -> Tue
    expect(nextRepeatDay(weekly([2, 4]), "2026-10-06")).toBe("2026-10-08"); // Tue -> Thu
    expect(nextRepeatDay(weekly([2, 4]), "2026-10-08")).toBe("2026-10-13"); // Thu -> next Tue
  });

  test("daily -> tomorrow, and nothing past its end date", () => {
    expect(nextRepeatDay({ cadence: "daily" }, "2026-10-05")).toBe("2026-10-06");
    expect(nextRepeatDay({ cadence: "daily", end_date: "2026-10-06" }, "2026-10-05")).toBe("2026-10-06");
    expect(nextRepeatDay({ cadence: "daily", end_date: "2026-10-05" }, "2026-10-05")).toBe(null);
  });

  test("monthly -> the same date next month, and nothing past its end date", () => {
    const rent = { cadence: "monthly", anchor_day: 5 };
    expect(nextRepeatDay(rent, "2026-10-05")).toBe("2026-11-05");
    expect(nextRepeatDay(rent, "2026-12-05")).toBe("2027-01-05"); // across a year end
    expect(nextRepeatDay({ ...rent, end_date: "2026-11-05" }, "2026-10-05")).toBe("2026-11-05");
    expect(nextRepeatDay({ ...rent, end_date: "2026-11-04" }, "2026-10-05")).toBe(null);
  });

  test("monthly on the 31st from Jan 31 -> Feb 28", () => {
    expect(nextRepeatDay({ cadence: "monthly", anchor_day: 31 }, "2027-01-31")).toBe("2027-02-28");
  });
});
