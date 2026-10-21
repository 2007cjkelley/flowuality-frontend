import { moveToFirstInTier } from './mobileQueue';

const ids = (items) => items.map((item) => item.id);

describe('moveToFirstInTier', () => {
  const queue = [
    { id: 'a1', priority: 1 },
    { id: 'b1', priority: 1 },
    { id: 'c3', priority: 3 },
    { id: 'd3', priority: 3 },
    { id: 'e4', priority: 4 },
  ];

  test('new P1 task appended at the end goes ahead of existing P1 tasks', () => {
    const items = [...queue, { id: 'new', priority: 1 }];
    expect(ids(moveToFirstInTier(items, 'new', 1))).toEqual(['new', 'a1', 'b1', 'c3', 'd3', 'e4']);
  });

  test('new P3 task lands after the P1 tier, before existing P3 tasks', () => {
    const items = [...queue, { id: 'new', priority: 3 }];
    expect(ids(moveToFirstInTier(items, 'new', 3))).toEqual(['a1', 'b1', 'new', 'c3', 'd3', 'e4']);
  });

  test('new P2 task with no P2 tier yet lands between P1 and P3', () => {
    const items = [...queue, { id: 'new', priority: 2 }];
    expect(ids(moveToFirstInTier(items, 'new', 2))).toEqual(['a1', 'b1', 'new', 'c3', 'd3', 'e4']);
  });

  test('edited task lowered from P1 to P3 moves down to the start of P3', () => {
    expect(ids(moveToFirstInTier(queue, 'a1', 3))).toEqual(['b1', 'a1', 'c3', 'd3', 'e4']);
  });

  test('edited task raised from P4 to P1 moves to the top', () => {
    const result = moveToFirstInTier(queue, 'e4', 1);
    expect(ids(result)).toEqual(['e4', 'a1', 'b1', 'c3', 'd3']);
    expect(result[0].priority).toBe(1);
  });

  test('missing priority counts as 3; unknown id returns the input', () => {
    const items = [{ id: 'x' }, { id: 'new', priority: 2 }];
    expect(ids(moveToFirstInTier(items, 'new', 2))).toEqual(['new', 'x']);
    expect(moveToFirstInTier(items, 'nope', 1)).toBe(items);
  });
});
