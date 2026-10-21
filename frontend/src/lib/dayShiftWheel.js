// Day-by-Day Week Navigation -- turns wheel events into whole-day shifts.
// Pure (no React) so the thresholds can be unit-tested in isolation; App.js
// wires handleWheel to a native, non-passive listener and routes every
// resulting shift through its single shiftWindowByDays(n) action.
//
// Shift+wheel and horizontal wheel/trackpad swipes are one input: browsers
// deliver Shift+wheel as deltaX on some platforms and as deltaY+shiftKey on
// others, so both are normalised to one horizontal delta. Plain vertical
// wheel is left alone (native hour scroll).

export const GESTURE_GAP_MS = 200;     // idle gap that ends a gesture
export const NOTCH_MIN_PX = 100;       // |dx| at/above this on a gesture's first event = mouse notch
export const TRACKPAD_PX_PER_DAY = 120; // continuous input: accumulated px per day
export const TRACKPAD_MAX_DAYS_PER_GESTURE = 3; // stops a momentum flick jumping weeks
const LINE_PX = 33;

const toPixels = (delta, deltaMode, pageSize) => {
  if (deltaMode === 1) return delta * LINE_PX;
  if (deltaMode === 2) return delta * pageSize;
  return delta;
};

export function createDayShiftWheel({ onShift, now = () => Date.now(), pageSize = 800 }) {
  let gesture = null; // { kind: "discrete" | "continuous", lastAt, acc, shifted }

  // Returns true when the event was consumed as a day shift (and
  // preventDefault'd), false when it should fall through to native scroll.
  return function handleWheel(e) {
    if (e.ctrlKey) return false; // page zoom / pinch -- reserved for Calendar Zoom

    const dxRaw = e.deltaX !== 0 ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
    const dx = toPixels(dxRaw, e.deltaMode, pageSize);
    const dy = e.shiftKey ? 0 : toPixels(e.deltaY, e.deltaMode, pageSize);

    if (!e.shiftKey && Math.abs(dx) <= Math.abs(dy)) return false;
    if (e.cancelable !== false) e.preventDefault();
    if (dx === 0) return true;

    // Gesture gaps are measured on the event's own timeStamp (when the input
    // happened), not on when it's processed: each shift re-renders the whole
    // grid, and wheel events queued behind a slow render would otherwise
    // look like a fresh gesture and escape the per-gesture cap.
    const t = e.timeStamp > 0 ? e.timeStamp : now();
    if (!gesture || t - gesture.lastAt > GESTURE_GAP_MS) {
      const discrete = e.deltaMode !== 0 || Math.abs(dx) >= NOTCH_MIN_PX;
      gesture = { kind: discrete ? "discrete" : "continuous", lastAt: t, acc: 0, shifted: 0 };
    }
    gesture.lastAt = t;

    const dir = dx > 0 ? 1 : -1;
    if (gesture.kind === "discrete") {
      onShift(dir);
      return true;
    }

    // Continuous (trackpad): reset the accumulator on direction change so a
    // small wobble back doesn't have to "pay off" the forward distance first.
    if (gesture.acc !== 0 && Math.sign(gesture.acc) !== dir) gesture.acc = 0;
    gesture.acc += dx;
    while (Math.abs(gesture.acc) >= TRACKPAD_PX_PER_DAY) {
      gesture.acc -= dir * TRACKPAD_PX_PER_DAY;
      if (Math.abs(gesture.shifted + dir) > TRACKPAD_MAX_DAYS_PER_GESTURE) {
        gesture.acc = 0;
        break;
      }
      gesture.shifted += dir;
      onShift(dir);
    }
    return true;
  };
}
