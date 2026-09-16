import { expect, test } from 'vitest';
import { slotOrigin } from '../src/renderer/atlas';

test('slot origins tile the pool row-major by axis', () => {
  expect(slotOrigin(0, 3, 32)).toEqual({ x: 0, y: 0, z: 0 });
  expect(slotOrigin(4, 3, 32)).toEqual({ x: 32, y: 32, z: 0 });
  expect(slotOrigin(9, 3, 32)).toEqual({ x: 0, y: 0, z: 32 });
});
