import { expect, test } from 'vitest';
import type { VolumeGeometry } from '../src/geometry';
import { OVERLAP_DEPTH, Segmentation } from '../src/segmentation';
import { Volume } from '../src/volume';

const geometry: VolumeGeometry = {
  dims: [8, 8, 8],
  spacing: [1, 1, 1],
  origin: [0, 0, 0],
  direction: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
};

function slotsAt(segmentation: Segmentation, i: number, j: number, k: number): number[] {
  const brick = segmentation.readBrick(0);
  const [w, h] = brick.size;
  const offset = (i + j * w + k * w * h) * OVERLAP_DEPTH;
  return Array.from(brick.data.subarray(offset, offset + OVERLAP_DEPTH));
}

test('a volume owns a built-in segmentation on the same grid', () => {
  const volume = new Volume('v', geometry, 'int16', 32);
  expect(volume.segmentation.geometry).toBe(geometry);
  expect(volume.segmentation.segmentsPresent()).toEqual([]);
});

test('paintSphere writes the segment inside the radius and marks bricks dirty', () => {
  const segmentation = new Segmentation(geometry, 8);
  segmentation.paintSphere([4, 4, 4], 2, 1);

  expect(slotsAt(segmentation, 4, 4, 4)).toEqual([1, 0, 0, 0]);
  expect(slotsAt(segmentation, 4, 4, 6)).toEqual([1, 0, 0, 0]);
  expect(slotsAt(segmentation, 0, 0, 0)).toEqual([0, 0, 0, 0]);
  expect(segmentation.segmentsPresent()).toEqual([1]);
  expect(segmentation.takeDirtyBricks()).toEqual([0]);
  expect(segmentation.takeDirtyBricks()).toEqual([]);
});

test('overlapping paints store the full slot set', () => {
  const segmentation = new Segmentation(geometry, 8);
  segmentation.paintSphere([4, 4, 4], 1, 1);
  segmentation.paintSphere([4, 4, 4], 1, 2);

  expect(slotsAt(segmentation, 4, 4, 4)).toEqual([1, 2, 0, 0]);
  expect(segmentation.segmentsPresent()).toEqual([1, 2]);
});

test('repainting the same segment does not duplicate slots', () => {
  const segmentation = new Segmentation(geometry, 8);
  segmentation.paintSphere([4, 4, 4], 1, 1);
  segmentation.takeDirtyBricks();
  segmentation.paintSphere([4, 4, 4], 1, 1);

  expect(slotsAt(segmentation, 4, 4, 4)).toEqual([1, 0, 0, 0]);
  expect(segmentation.takeDirtyBricks()).toEqual([]);
});

test('a full slot set evicts the lowest index', () => {
  const segmentation = new Segmentation(geometry, 8);
  for (const segment of [1, 2, 3, 4]) segmentation.paintSphere([4, 4, 4], 0.1, segment);
  segmentation.paintSphere([4, 4, 4], 0.1, 5);

  expect(new Set(slotsAt(segmentation, 4, 4, 4))).toEqual(new Set([2, 3, 4, 5]));
  expect(segmentation.segmentsPresent()).toEqual([2, 3, 4, 5]);
});

test('a full slot set drops an incoming segment lower than all present', () => {
  const segmentation = new Segmentation(geometry, 8);
  for (const segment of [2, 3, 4, 5]) segmentation.paintSphere([4, 4, 4], 0.1, segment);
  segmentation.takeDirtyBricks();
  segmentation.paintSphere([4, 4, 4], 0.1, 1);

  expect(new Set(slotsAt(segmentation, 4, 4, 4))).toEqual(new Set([2, 3, 4, 5]));
  expect(segmentation.segmentsPresent()).toEqual([2, 3, 4, 5]);
  expect(segmentation.takeDirtyBricks()).toEqual([]);
});

test('paintSphere clamps to the volume bounds', () => {
  const segmentation = new Segmentation(geometry, 8);
  segmentation.paintSphere([0, 0, 0], 3, 7);

  expect(slotsAt(segmentation, 0, 0, 0)).toEqual([7, 0, 0, 0]);
  expect(segmentation.segmentsPresent()).toEqual([7]);
});

test('paintSphere rejects invalid segment indices', () => {
  const segmentation = new Segmentation(geometry, 8);
  for (const segment of [0, 65536, 1.5, -1]) {
    expect(() => segmentation.paintSphere([4, 4, 4], 1, segment)).toThrow(/Segment index/);
  }
});

test('paintSphere stores the maximum segment index intact', () => {
  const segmentation = new Segmentation(geometry, 8);
  segmentation.paintSphere([4, 4, 4], 1, 65535);

  expect(slotsAt(segmentation, 4, 4, 4)).toEqual([65535, 0, 0, 0]);
  expect(segmentation.segmentsPresent()).toEqual([65535]);
});

test('label styles default to distinct visible colors and can be edited', () => {
  const segmentation = new Segmentation(geometry, 8);
  const one = segmentation.getLabelStyle(1);
  const two = segmentation.getLabelStyle(2);
  expect(one.visible).toBe(true);
  expect(one.opacity).toBeGreaterThan(0);
  expect(one.color).not.toEqual(two.color);
  expect(segmentation.labelVersion).toBe(0);

  const style = { color: [1, 0, 0] as const, opacity: 0.8, visible: false };
  segmentation.setLabelStyle(1, style);
  expect(segmentation.getLabelStyle(1)).toBe(style);
  expect(segmentation.labelVersion).toBe(1);
});

test('the packed label table tracks style edits', () => {
  const segmentation = new Segmentation(geometry, 8);
  const offset = 5 * 4;
  expect(segmentation.labelTable[offset + 3]).toBeCloseTo(0.2);

  segmentation.setLabelStyle(5, { color: [1, 0, 0], opacity: 0.8, visible: true });
  expect(segmentation.labelTable[offset]).toBe(1);
  expect(segmentation.labelTable[offset + 1]).toBe(0);
  expect(segmentation.labelTable[offset + 3]).toBeCloseTo(0.8);

  segmentation.setLabelStyle(5, { color: [1, 0, 0], opacity: 0.8, visible: false });
  expect(segmentation.labelTable[offset + 3]).toBe(0);
});

test('bricks untouched by any paint read as empty and are never dirty', () => {
  const segmentation = new Segmentation(geometry, 4);
  segmentation.paintSphere([1, 1, 1], 1, 3);

  const untouched = segmentation.readBrick(7);
  expect(untouched.data.every((slot) => slot === 0)).toBe(true);
  expect(segmentation.takeDirtyBricks()).toEqual([0]);
});

test('dirty bricks span every brick touched by the sphere', () => {
  const segmentation = new Segmentation(geometry, 4);
  segmentation.paintSphere([4, 4, 4], 1.8, 1);

  expect(new Set(segmentation.takeDirtyBricks())).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
});
