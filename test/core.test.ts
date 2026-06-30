import { expect, test } from 'vitest';
import { BrickState, BrickStore } from '../src/brick-store';
import { cameraForOrientation, canvasToWorld, worldToCanvas } from '../src/camera';
import { type VolumeGeometry, indexToWorld, worldToIndex } from '../src/geometry';

const identity: VolumeGeometry['direction'] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

test('index<->world round-trips through geometry', () => {
  const geometry: VolumeGeometry = {
    dims: [10, 10, 10],
    spacing: [0.5, 0.5, 2],
    origin: [10, 20, 30],
    direction: identity,
  };
  const world = indexToWorld(geometry, [3, 4, 5]);
  expect(world).toEqual([11.5, 22, 40]);
  const back = worldToIndex(geometry, world);
  expect(back[0]).toBeCloseTo(3);
  expect(back[1]).toBeCloseTo(4);
  expect(back[2]).toBeCloseTo(5);
});

test('bricks flip to resident band by band as slices arrive', () => {
  const geometry: VolumeGeometry = {
    dims: [4, 4, 8],
    spacing: [1, 1, 1],
    origin: [0, 0, 0],
    direction: identity,
  };
  const store = new BrickStore(geometry, 'float32', 4);
  expect(store.bricksPerAxis).toEqual([1, 1, 2]);

  const plane = new Float32Array(16).fill(7);
  store.writeSlice(0, plane);
  expect(store.brickStateAt(0)).toBe(BrickState.Loading);
  expect(store.brickStateAt(1)).toBe(BrickState.Absent);
  for (let k = 1; k < 4; k++) store.writeSlice(k, plane);
  expect(store.brickStateAt(0)).toBe(BrickState.Resident);
  expect(store.brickStateAt(1)).toBe(BrickState.Absent);
  expect(store.takeDirtyBricks()).toEqual([0]);

  for (let k = 4; k < 8; k++) store.writeSlice(k, plane);
  expect(store.brickStateAt(1)).toBe(BrickState.Resident);
  expect(store.takeDirtyBricks()).toEqual([1]);

  expect(store.sampleVoxel(2, 2, 6)).toBe(7);
  expect(store.sampleVoxel(99, 0, 0)).toBeNaN();
});

test('axial camera centers the focal point on the canvas', () => {
  const geometry: VolumeGeometry = {
    dims: [10, 10, 10],
    spacing: [1, 1, 1],
    origin: [0, 0, 0],
    direction: identity,
  };
  const camera = cameraForOrientation(geometry, 'axial', 1);
  expect(camera.normal).toEqual([0, 0, 1]);

  const center = worldToCanvas(camera, camera.focalPoint, 256, 256);
  expect(center.x).toBeCloseTo(128);
  expect(center.y).toBeCloseTo(128);

  const world = canvasToWorld(camera, { x: 128, y: 128 }, 256, 256);
  expect(world[0]).toBeCloseTo(camera.focalPoint[0]);
  expect(world[1]).toBeCloseTo(camera.focalPoint[1]);
});
