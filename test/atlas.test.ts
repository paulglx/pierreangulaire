import { expect, test } from 'vitest';
import {
  atlasSide,
  depthTiling,
  packSlotEntry,
  slotCoord,
  tiledOrigin,
  unpackSlotEntry,
} from '../src/renderer/atlas';

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

test('depth tiling folds slices beyond the texture limit into brick-aligned tiles', () => {
  expect(depthTiling([512, 512, 132], 32, 2048)).toEqual({ tiles: 1, tileDepth: 160 });
  expect(depthTiling([512, 512, 2048], 32, 2048)).toEqual({ tiles: 1, tileDepth: 2048 });
  expect(depthTiling([512, 512, 2500], 32, 2048)).toEqual({ tiles: 2, tileDepth: 1280 });
  expect(depthTiling([512, 512, 8192], 32, 2048)).toEqual({ tiles: 4, tileDepth: 2048 });
});

test('tiled origins place each brick inside its depth tile', () => {
  expect(tiledOrigin([32, 64, 96], 1280, 512)).toEqual({ x: 32, y: 64, z: 96 });
  expect(tiledOrigin([32, 64, 1280], 1280, 512)).toEqual({ x: 544, y: 64, z: 0 });
  expect(tiledOrigin([8, 16, 320], 320, 133)).toEqual({ x: 141, y: 16, z: 0 });
});
