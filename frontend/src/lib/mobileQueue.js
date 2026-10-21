// Mobile layout -- there's no drag-to-position step on mobile, so a saved
// task goes to the first slot among tasks of its own priority: one past the
// last more-important task. Same rule as the desktop drag's lowerBoundaryIndex
// (the "earliest legal spot" an illegal drop falls back to), but computed on
// the queue with the task already removed, so it's right whether the task
// started above or below that boundary. Same-priority tasks each shift back
// one position. Returns a new array; the input is untouched.
export function moveToFirstInTier(items, id, priority) {
  const target = items.find((item) => item.id === id);
  if (!target) return items;
  const rest = items.filter((item) => item.id !== id);
  let insertAt = 0;
  rest.forEach((item, idx) => {
    if ((item.priority ?? 3) < priority) insertAt = idx + 1;
  });
  const result = [...rest];
  result.splice(insertAt, 0, { ...target, priority });
  return result;
}
