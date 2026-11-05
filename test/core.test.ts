import { expect, test } from 'vitest';
import { BrickState, BrickStore } from '../src/brick-store';
import { cameraForOrientation, canvasToWorld, worldToCanvas } from '../src/camera';
import { type VolumeGeometry, indexToWorld, worldToIndex } from '../src/geometry';
import { Volume } from '../src/volume';
import type { Vec3 } from '../src/math';

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
  expect(store.takeDirtyBands()).toEqual([0]);

  for (let k = 4; k < 8; k++) store.writeSlice(k, plane);
  expect(store.brickStateAt(1)).toBe(BrickState.Resident);
  expect(store.takeDirtyBands()).toEqual([1]);

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

function expectVec(actual: Vec3, expected: Vec3): void {
  for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i]!);
}

test('presets snap to the volume axes closest to the patient axes', () => {
  const angle = Math.PI / 9;
  const tilted: VolumeGeometry = {
    dims: [10, 10, 10],
    spacing: [1, 1, 1],
    origin: [0, 0, 0],
    direction: [
      [1, 0, 0],
      [0, Math.cos(angle), Math.sin(angle)],
      [0, -Math.sin(angle), Math.cos(angle)],
    ],
  };
  const axial = cameraForOrientation(tilted, 'axial', 1);
  expectVec(axial.normal, tilted.direction[2]);
  expectVec(axial.up, [0, -Math.cos(angle), -Math.sin(angle)]);

  const coronal = cameraForOrientation(tilted, 'coronal', 1);
  expectVec(coronal.normal, tilted.direction[1]);
  expectVec(coronal.up, tilted.direction[2]);

  const sagittal = cameraForOrientation(tilted, 'sagittal', 1);
  expectVec(sagittal.normal, [1, 0, 0]);
  expectVec(sagittal.up, tilted.direction[2]);
});

test('presets flip and permute volume axes to face the patient axes', () => {
  const flippedAndSwapped: VolumeGeometry = {
    dims: [10, 10, 10],
    spacing: [1, 1, 1],
    origin: [0, 0, 0],
    direction: [
      [0, 0, -1],
      [-1, 0, 0],
      [0, 1, 0],
    ],
  };
  const axial = cameraForOrientation(flippedAndSwapped, 'axial', 1);
  expectVec(axial.normal, [0, 0, 1]);
  expectVec(axial.up, [0, -1, 0]);

  const sagittal = cameraForOrientation(flippedAndSwapped, 'sagittal', 1);
  expectVec(sagittal.normal, [1, 0, 0]);
  expectVec(sagittal.up, [0, 0, 1]);
});

test('int16 store keeps the slices it is handed and exposes them band by band', () => {
  const geometry: VolumeGeometry = {
    dims: [6, 4, 3],
    spacing: [1, 1, 1],
    origin: [0, 0, 0],
    direction: identity,
  };
  const store = new BrickStore(geometry, 'int16', 4);
  expect(store.bricksPerAxis).toEqual([2, 1, 1]);
  expect(store.sampleVoxel(0, 0, 0)).toBeNaN();

  const planes: Int16Array[] = [];
  for (let k = 0; k < 3; k++) {
    const plane = new Int16Array(24);
    for (let i = 0; i < plane.length; i++) plane[i] = i - 12 + k * 100;
    planes.push(plane);
    store.writeSlice(k, plane);
  }

  expect(store.sampleVoxel(5, 3, 2)).toBe(211);
  expect(store.sampleVoxel(4, 0, 1)).toBe(92);
  expect(store.takeDirtyBands()).toEqual([0]);
  expect(store.takeDirtyBands()).toEqual([]);

  const band = store.readBand(0);
  expect(band.z).toBe(0);
  expect(band.slices).toHaveLength(3);
  expect(band.slices[0]).toBe(planes[0]);
  expect(band.cellGrid).toEqual([2, 1, 1]);
  expect(band.cellRanges).toBeInstanceOf(Int16Array);
  expect([...band.cellRanges]).toEqual([-12, 209, -8, 211]);
  expect([...band.brickRanges]).toEqual([-12, 209, -8, 211]);
});

test('slices of another type or the wrong length are converted or rejected', () => {
  const geometry: VolumeGeometry = {
    dims: [2, 2, 2],
    spacing: [1, 1, 1],
    origin: [0, 0, 0],
    direction: identity,
  };
  const store = new BrickStore(geometry, 'int16', 4);
  store.writeSlice(0, new Int8Array([-3, 1, 2, 4]));
  store.writeSlice(1, [5, 6, 7, 8]);
  expect(store.sampleVoxel(0, 0, 0)).toBe(-3);
  expect(store.sampleVoxel(1, 1, 1)).toBe(8);
  expect(store.readBand(0).slices[0]).toBeInstanceOf(Int16Array);
  expect(() => store.writeSlice(2, new Int16Array(4))).toThrow(/outside the volume depth/);
  expect(() => store.writeSlice(0, new Int16Array(3))).toThrow(/expected 4/);
});

test('a band that is not resident cannot be read', () => {
  const geometry: VolumeGeometry = {
    dims: [2, 2, 3],
    spacing: [1, 1, 1],
    origin: [0, 0, 0],
    direction: identity,
  };
  const store = new BrickStore(geometry, 'uint8', 4);
  store.writeSlice(1, new Uint8Array(4));
  expect(store.brickStateAt(0)).toBe(BrickState.Loading);
  expect(store.sampleVoxel(0, 0, 0)).toBeNaN();
  expect(store.sampleVoxel(0, 0, 1)).toBe(0);
  expect(() => store.readBand(0)).toThrow(/not resident/);
});

test('brick size must be a multiple of the cell size', () => {
  const geometry: VolumeGeometry = {
    dims: [8, 4, 5],
    spacing: [1, 1, 1],
    origin: [0, 0, 0],
    direction: identity,
  };
  expect(() => new BrickStore(geometry, 'uint8', 6)).toThrow(/multiple of the cell size/);
});

test('band cell ranges cover each 4³ cell, partial cells at the volume edge, and reduce per brick', () => {
  const geometry: VolumeGeometry = {
    dims: [9, 4, 5],
    spacing: [1, 1, 1],
    origin: [0, 0, 0],
    direction: identity,
  };
  const store = new BrickStore(geometry, 'uint8', 8);
  for (let k = 0; k < 5; k++) {
    const plane = new Uint8Array(36).fill(k);
    plane[7] = 100 + k;
    plane[8] = 50 + k;
    store.writeSlice(k, plane);
  }
  const band = store.readBand(0);
  expect(band.cellGrid).toEqual([3, 1, 2]);
  expect(band.cellRanges).toBeInstanceOf(Uint8Array);
  expect([...band.cellRanges]).toEqual([0, 3, 0, 103, 0, 53, 4, 4, 4, 104, 4, 54]);
  expect([...band.brickRanges]).toEqual([0, 104, 0, 54]);
});

test('volume sampling applies the rescale to raw stored voxels', () => {
  const geometry: VolumeGeometry = {
    dims: [2, 2, 1],
    spacing: [1, 1, 1],
    origin: [0, 0, 0],
    direction: identity,
  };
  const volume = new Volume('v', geometry, 'uint16', 4, { slope: 0.5, intercept: -1024 });
  volume.writeSlice(0, new Uint16Array([0, 2048, 4, 6]));
  expect(volume.store.sampleVoxel(1, 0, 0)).toBe(2048);
  expect(volume.sampleVoxel(1, 0, 0)).toBe(0);
  expect(volume.sampleVoxel(0, 0, 0)).toBe(-1024);
  expect(volume.sampleVoxel(0, 5, 0)).toBeNaN();
});
