import { expect, test } from 'vitest';
import { atlasSide, packSlotEntry, slotCoord, unpackSlotEntry } from '../src/renderer/atlas';

test('atlas side is the smallest cube holding the slot count', () => {
  expect(atlasSide(0)).toBe(0);
  expect(atlasSide(1)).toBe(1);
  expect(atlasSide(8)).toBe(2);
  expect(atlasSide(9)).toBe(3);
  expect(atlasSide(27)).toBe(3);
  expect(atlasSide(4100)).toBe(17);
});

test('the first n³ slots fill the n³ cube without collisions', () => {
  for (const side of [1, 2, 3, 5, 8]) {
    const seen = new Set<string>();
    for (let slot = 0; slot < side ** 3; slot++) {
      const { x, y, z } = slotCoord(slot);
      expect(Math.max(x, y, z)).toBeLessThan(side);
      seen.add(`${x},${y},${z}`);
    }
    expect(seen.size).toBe(side ** 3);
  }
});

test('growing the cube keeps earlier slots in place', () => {
  expect(slotCoord(0)).toEqual({ x: 0, y: 0, z: 0 });
  expect(slotCoord(1)).toEqual({ x: 0, y: 0, z: 1 });
  expect(slotCoord(7)).toEqual({ x: 1, y: 0, z: 0 });
  expect(slotCoord(8)).toEqual({ x: 0, y: 0, z: 2 });
});

test('slot entries pack coordinates and stay non-zero', () => {
  for (const coord of [
    { x: 0, y: 0, z: 0 },
    { x: 1023, y: 0, z: 0 },
    { x: 3, y: 1023, z: 1023 },
  ]) {
    const entry = packSlotEntry(coord);
    expect(entry).toBeGreaterThan(0);
    expect(unpackSlotEntry(entry)).toEqual(coord);
  }
});
