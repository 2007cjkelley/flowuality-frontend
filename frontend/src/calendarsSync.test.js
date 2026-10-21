import { createCalendarsSync } from "./calendarsSync";

const cal = (fields) => ({ id: "c1", color: "#3B82F6", notify: true, ...fields });

test("an older GET answering after a newer one is dropped", () => {
  const sync = createCalendarsSync();
  const older = sync.beginFetch();
  const newer = sync.beginFetch();
  expect(sync.apply(older, [cal()])).toBeNull();
  expect(sync.apply(newer, [cal()])).toEqual([cal()]);
});

test("a write made after the GET was sent wins over its answer", () => {
  const sync = createCalendarsSync();
  const ticket = sync.beginFetch();
  const settle = sync.recordWrite("c1", { notify: false });
  settle();
  expect(sync.apply(ticket, [cal({ notify: true })])).toEqual([cal({ notify: false })]);
});

test("a write whose PUT has not settled wins even over a later GET", () => {
  const sync = createCalendarsSync();
  sync.recordWrite("c1", { color: "#EF4444" });
  const ticket = sync.beginFetch();
  expect(sync.apply(ticket, [cal({ color: "#3B82F6" })])).toEqual([cal({ color: "#EF4444" })]);
});

test("a settled write older than the GET gives way to the server's answer", () => {
  const sync = createCalendarsSync();
  const settle = sync.recordWrite("c1", { notify: false });
  settle();
  const first = sync.beginFetch();
  expect(sync.apply(first, [cal({ notify: true })])).toEqual([cal({ notify: true })]);
  // The record is gone, so a later answer is taken as-is too.
  const second = sync.beginFetch();
  expect(sync.apply(second, [cal({ notify: true })])).toEqual([cal({ notify: true })]);
});
