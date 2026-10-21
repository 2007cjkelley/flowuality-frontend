import { getZonedNow } from "./NowLine";

test("uses the given timezone, not the machine's", () => {
  const instant = new Date("2026-09-26T14:30:00Z");
  expect(getZonedNow(instant, "America/New_York")).toEqual({ dateKey: "2026-09-26", hour: 10, minute: 30 });
  expect(getZonedNow(instant, "Asia/Tokyo")).toEqual({ dateKey: "2026-09-26", hour: 23, minute: 30 });
});

test("rolls the date over at the zone's own midnight", () => {
  const instant = new Date("2026-09-26T15:05:00Z");
  expect(getZonedNow(instant, "Asia/Tokyo")).toEqual({ dateKey: "2026-09-27", hour: 0, minute: 5 });
});

test("honours DST (EST in December)", () => {
  const instant = new Date("2026-12-31T15:00:00Z");
  expect(getZonedNow(instant, "America/New_York")).toEqual({ dateKey: "2026-12-31", hour: 10, minute: 0 });
});
