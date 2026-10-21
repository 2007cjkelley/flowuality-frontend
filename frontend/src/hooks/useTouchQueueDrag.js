import { useCallback, useEffect, useRef, useState } from 'react';

// Mobile layout -- press-and-hold touch drag for the flex queue. Gesture
// handling only: every rule (priority/deadline boundaries,
// the illegal-drop fallback, the deadline-conflict check, the order save)
// stays in App.js's desktop drag functions, which this calls through
// `handlersRef` -- { start(index), enter(index), end(), dragIndex(), overIndex() }.
// App.js reassigns that ref every render, so a call always reaches the
// current boundaries (they're recomputed once start() marks the drag).
//
// Hold HOLD_MS without moving more than MOVE_TOLERANCE_PX to start a drag;
// moving sooner is a swipe (the list scrolls) and releasing sooner is a tap
// (the row's own onClick opens it). Rows must carry data-flex-index.
export const HOLD_MS = 400;
export const MOVE_TOLERANCE_PX = 8;
const ROW_GAP_PX = 4; // .flex-queue-list's gap

export function useTouchQueueDrag({ enabled, listRef, handlersRef }) {
  // null, or { fromIndex, overIndex, dy, slot } while a drag is live.
  const [drag, setDrag] = useState(null);
  const gestureRef = useRef(null);

  const cleanup = useCallback(() => {
    const g = gestureRef.current;
    if (!g) return;
    clearTimeout(g.timer);
    document.removeEventListener('touchmove', g.onMove);
    document.removeEventListener('touchend', g.onEnd);
    document.removeEventListener('touchcancel', g.onEnd);
    gestureRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);
  useEffect(() => { if (!enabled) { cleanup(); setDrag(null); } }, [enabled, cleanup]);

  // Desktop's browser fires dragenter on the picked-up row right after
  // dragstart, once the drag state has re-rendered; mirror that here.
  const fromIndex = drag ? drag.fromIndex : null;
  useEffect(() => {
    if (fromIndex === null) return;
    handlersRef.current.enter(fromIndex);
    setDrag((d) => (d ? { ...d, overIndex: handlersRef.current.overIndex() ?? d.overIndex } : d));
  }, [fromIndex, handlersRef]);

  const onRowTouchStart = useCallback((e, index) => {
    if (!enabled || e.touches.length !== 1) return;
    cleanup();
    const touch = e.touches[0];
    const g = {
      index, startX: touch.clientX, startY: touch.clientY,
      active: false, rows: null, timer: null, onMove: null, onEnd: null,
    };

    const hoveredIndex = (y) => {
      // Original (pre-drag) row positions, so rows sliding out of the way
      // never change which row the finger counts as over -- the same
      // original-index semantics desktop's dragenter has.
      const { rows } = g;
      if (y < rows[0].top) return rows[0].index;
      for (const r of rows) if (y >= r.top && y < r.bottom) return r.index;
      if (y >= rows[rows.length - 1].bottom) return rows[rows.length - 1].index;
      return null; // in a gap -- keep the last target
    };

    g.onMove = (ev) => {
      const t = ev.touches[0];
      if (!t) return;
      if (!g.active) {
        if (Math.hypot(t.clientX - g.startX, t.clientY - g.startY) > MOVE_TOLERANCE_PX) cleanup();
        return; // a swipe: let the list scroll
      }
      ev.preventDefault();
      const target = hoveredIndex(t.clientY);
      if (target !== null) handlersRef.current.enter(target);
      const over = handlersRef.current.overIndex();
      setDrag((d) => (d ? { ...d, dy: t.clientY - g.startY, overIndex: over ?? d.overIndex } : d));
    };

    g.onEnd = (ev) => {
      const wasActive = g.active;
      cleanup();
      if (!wasActive) return; // a tap: the row's onClick handles it
      if (ev.cancelable) ev.preventDefault(); // no click after a drag
      setDrag(null);
      handlersRef.current.end();
    };

    g.timer = setTimeout(() => {
      const list = listRef.current;
      if (!list) { cleanup(); return; }
      handlersRef.current.start(index);
      if (handlersRef.current.dragIndex() !== index) { cleanup(); return; } // locked row
      g.active = true;
      g.rows = Array.from(list.querySelectorAll('[data-flex-index]')).map((el) => {
        const rect = el.getBoundingClientRect();
        return { index: Number(el.dataset.flexIndex), top: rect.top, bottom: rect.bottom };
      }).sort((a, b) => a.index - b.index);
      const own = g.rows.find((r) => r.index === index);
      setDrag({ fromIndex: index, overIndex: index, dy: 0, slot: own ? own.bottom - own.top + ROW_GAP_PX : 0 });
    }, HOLD_MS);

    document.addEventListener('touchmove', g.onMove, { passive: false });
    document.addEventListener('touchend', g.onEnd, { passive: false });
    document.addEventListener('touchcancel', g.onEnd, { passive: false });
    gestureRef.current = g;
  }, [enabled, cleanup, listRef, handlersRef]);

  // Inline transform for row `index` while a drag is live: the dragged row
  // follows the finger, rows between its old and new slot slide one slot.
  const rowStyle = useCallback((index) => {
    if (!drag) return undefined;
    const { fromIndex: from, overIndex: over, dy, slot } = drag;
    if (index === from) return { transform: `translateY(${dy}px)` };
    if (over > from && index > from && index <= over) return { transform: `translateY(${-slot}px)` };
    if (over < from && index >= over && index < from) return { transform: `translateY(${slot}px)` };
    return undefined;
  }, [drag]);

  return { touchDrag: drag, onRowTouchStart, rowStyle };
}
