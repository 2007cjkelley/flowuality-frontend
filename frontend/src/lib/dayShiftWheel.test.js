import { createDayShiftWheel, TRACKPAD_MAX_DAYS_PER_GESTURE, GESTURE_GAP_MS } from "./dayShiftWheel";

const setup = () => {
  let t = 0;
  const shifts = [];
  const handle = createDayShiftWheel({ onShift: (n) => shifts.push(n), now: () => t });
  const wheel = (props, advance = 16) => {
    t += advance;
    const e = { deltaX: 0, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: false, preventDefault: jest.fn(), ...props };
    const consumed = handle(e);
    return { consumed, e };
  };
  const total = () => shifts.reduce((a, b) => a + b, 0);
  const idle = () => { t += GESTURE_GAP_MS + 1; };
  return { wheel, total, idle, shifts };
};

test("mouse notch with Shift (deltaY) shifts exactly one day", () => {
  const { wheel, total } = setup();
  const { consumed, e } = wheel({ shiftKey: true, deltaY: 100 });
  expect(consumed).toBe(true);
  expect(e.preventDefault).toHaveBeenCalled();
  expect(total()).toBe(1);
});

test("Shift+wheel delivered as deltaX behaves the same", () => {
  const { wheel, total } = setup();
  wheel({ shiftKey: true, deltaX: -100 });
  expect(total()).toBe(-1);
});

test("fast mouse spinning is one day per notch, uncapped", () => {
  const { wheel, total } = setup();
  for (let i = 0; i < 6; i++) wheel({ shiftKey: true, deltaY: 100 }, 10);
  expect(total()).toBe(6);
});

test("deltaMode lines counts as a notch", () => {
  const { wheel, total } = setup();
  wheel({ shiftKey: true, deltaY: 3, deltaMode: 1 });
  expect(total()).toBe(1);
});

test("small trackpad deltas accumulate to one day", () => {
  const { wheel, total } = setup();
  for (let i = 0; i < 10; i++) wheel({ deltaX: 15 });
  expect(total()).toBe(1);
});

test("fast trackpad flick is capped per gesture", () => {
  const { wheel, total, idle } = setup();
  wheel({ deltaX: 20 });
  for (let i = 0; i < 40; i++) wheel({ deltaX: 80 });
  expect(total()).toBe(TRACKPAD_MAX_DAYS_PER_GESTURE);
  idle();
  wheel({ deltaX: 20 });
  for (let i = 0; i < 10; i++) wheel({ deltaX: 20 });
  expect(total()).toBe(TRACKPAD_MAX_DAYS_PER_GESTURE + 1);
});

test("gesture gaps use the event's timeStamp, so events queued behind a slow render stay in one gesture", () => {
  const shifts = [];
  let processedAt = 0;
  const handle = createDayShiftWheel({ onShift: (n) => shifts.push(n), now: () => processedAt });
  for (let i = 0; i < 40; i++) {
    processedAt += 400; // each event handled long after the previous one...
    handle({ deltaX: 80, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: false,
      timeStamp: 1000 + i * 16, preventDefault: () => {} }); // ...but generated 16ms apart
  }
  expect(shifts.reduce((a, b) => a + b, 0)).toBe(TRACKPAD_MAX_DAYS_PER_GESTURE);
});

test("direction reversal resets the accumulator", () => {
  const { wheel, total } = setup();
  wheel({ deltaX: 100 - 1 }); // continuous (below notch), acc 99
  wheel({ deltaX: -30 });     // reversal -> acc -30, no shift
  expect(total()).toBe(0);
  for (let i = 0; i < 3; i++) wheel({ deltaX: -30 });
  expect(total()).toBe(-1);
});

test("vertical wheel without Shift falls through to native scroll", () => {
  const { wheel, total } = setup();
  const { consumed, e } = wheel({ deltaY: 100 });
  expect(consumed).toBe(false);
  expect(e.preventDefault).not.toHaveBeenCalled();
  expect(total()).toBe(0);
});

test("mostly-vertical trackpad scroll with slight sideways drift falls through", () => {
  const { wheel } = setup();
  expect(wheel({ deltaX: 3, deltaY: 40 }).consumed).toBe(false);
});

test("ctrl+wheel is ignored", () => {
  const { wheel, total } = setup();
  const { consumed, e } = wheel({ ctrlKey: true, shiftKey: true, deltaY: 100 });
  expect(consumed).toBe(false);
  expect(e.preventDefault).not.toHaveBeenCalled();
  expect(total()).toBe(0);
});
