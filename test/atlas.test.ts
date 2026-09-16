import { expect, test } from 'vitest';
import { poolShape, slotOrigin } from '../src/renderer/atlas';

test('pool shape stays cubic and within the texture limit', () => {
  expect(poolShape(1, 32, 2048)).toEqual({ slotsPerAxis: 1, layers: 1 });
  expect(poolShape(8, 32, 2048)).toEqual({ slotsPerAxis: 2, layers: 2 });

  const large = poolShape(16 * 16 * 88, 32, 2048);
  expect(large.slotsPerAxis * large.slotsPerAxis * large.layers).toBeGreaterThanOrEqual(
    16 * 16 * 88,
  );
  expect(large.slotsPerAxis * 32).toBeLessThanOrEqual(2048);
  expect(large.layers * 32).toBeLessThanOrEqual(2048);
});

test('pool shape rejects volumes whose bricks cannot fit the texture limit', () => {
  expect(poolShape(512, 32, 256)).toEqual({ slotsPerAxis: 8, layers: 8 });
  expect(() => poolShape(513, 32, 256)).toThrow(/cannot hold/);
});

test('slot origins tile the pool row-major by axis', () => {
  expect(slotOrigin(0, 3, 32)).toEqual({ x: 0, y: 0, z: 0 });
  expect(slotOrigin(4, 3, 32)).toEqual({ x: 32, y: 32, z: 0 });
  expect(slotOrigin(9, 3, 32)).toEqual({ x: 0, y: 0, z: 32 });
});
