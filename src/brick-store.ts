import { type VolumeFormat, type VolumeGeometry, voxelCount } from './geometry';
import type { Vec3 } from './math';

export const BrickState = { Absent: 0, Loading: 1, Resident: 2 } as const;
export type BrickState = (typeof BrickState)[keyof typeof BrickState];

export interface BrickRegion {
  readonly origin: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly data: Float32Array;
}

export interface BrickBounds {
  readonly origin: readonly [number, number, number];
  readonly size: readonly [number, number, number];
}

export function brickGridSize(dims: Vec3, brickSize: number): readonly [number, number, number] {
  return [
    Math.ceil(dims[0] / brickSize),
    Math.ceil(dims[1] / brickSize),
    Math.ceil(dims[2] / brickSize),
  ];
}

export function brickBounds(
  dims: Vec3,
  brickSize: number,
  grid: readonly [number, number, number],
  linearIndex: number,
): BrickBounds {
  const [nbx, nby] = grid;
  const ox = (linearIndex % nbx) * brickSize;
  const oy = (Math.floor(linearIndex / nbx) % nby) * brickSize;
  const oz = Math.floor(linearIndex / (nbx * nby)) * brickSize;
  return {
    origin: [ox, oy, oz],
    size: [
      Math.min(brickSize, dims[0] - ox),
      Math.min(brickSize, dims[1] - oy),
      Math.min(brickSize, dims[2] - oz),
    ],
  };
}

type VoxelArray = Int16Array | Uint16Array | Uint8Array | Float32Array;

function createVoxelArray(format: VolumeFormat, count: number): VoxelArray {
  switch (format) {
    case 'int16':
      return new Int16Array(count);
    case 'uint16':
      return new Uint16Array(count);
    case 'uint8':
      return new Uint8Array(count);
    case 'float32':
      return new Float32Array(count);
  }
}

export class BrickStore {
  readonly geometry: VolumeGeometry;
  readonly format: VolumeFormat;
  readonly brickSize: number;
  readonly bricksPerAxis: readonly [number, number, number];

  private readonly voxels: VoxelArray;
  private readonly states: Uint8Array;
  private readonly sliceWritten: Uint8Array;
  private readonly bandCount: Int32Array;
  private readonly dirty = new Set<number>();

  constructor(geometry: VolumeGeometry, format: VolumeFormat, brickSize: number) {
    this.geometry = geometry;
    this.format = format;
    this.brickSize = brickSize;
    const dz = geometry.dims[2];
    this.bricksPerAxis = brickGridSize(geometry.dims, brickSize);
    this.voxels = createVoxelArray(format, voxelCount(geometry));
    this.states = new Uint8Array(
      this.bricksPerAxis[0] * this.bricksPerAxis[1] * this.bricksPerAxis[2],
    );
    this.sliceWritten = new Uint8Array(dz);
    this.bandCount = new Int32Array(this.bricksPerAxis[2]);
  }

  get brickCount(): number {
    return this.states.length;
  }

  brickStateAt(linearIndex: number): BrickState {
    return this.states[linearIndex] as BrickState;
  }

  isSliceWritten(k: number): boolean {
    return this.sliceWritten[k] === 1;
  }

  writeSlice(k: number, data: ArrayLike<number>): void {
    const [dx, dy] = this.geometry.dims;
    const planeSize = dx * dy;
    this.voxels.set(data as ArrayLike<number> & { length: number }, k * planeSize);
    if (this.sliceWritten[k] === 1) return;
    this.sliceWritten[k] = 1;

    const bz = Math.floor(k / this.brickSize);
    const previous = this.bandCount[bz]!;
    const current = previous + 1;
    this.bandCount[bz] = current;
    if (previous === 0) this.markBand(bz, BrickState.Loading);
    if (current === this.bandHeight(bz)) this.markBand(bz, BrickState.Resident);
  }

  takeDirtyBricks(): number[] {
    const out = [...this.dirty];
    this.dirty.clear();
    return out;
  }

  readBrick(linearIndex: number): BrickRegion {
    const { origin, size } = brickBounds(
      this.geometry.dims,
      this.brickSize,
      this.bricksPerAxis,
      linearIndex,
    );
    const [dx, dy] = this.geometry.dims;
    const [ox, oy, oz] = origin;
    const [w, h, d] = size;
    const data = new Float32Array(w * h * d);
    for (let z = 0; z < d; z++) {
      for (let y = 0; y < h; y++) {
        const srcRow = ox + (oy + y) * dx + (oz + z) * dx * dy;
        const dstRow = y * w + z * w * h;
        for (let x = 0; x < w; x++) {
          data[dstRow + x] = this.voxels[srcRow + x]!;
        }
      }
    }
    return { origin: [ox, oy, oz], size: [w, h, d], data };
  }

  sampleVoxel(i: number, j: number, k: number): number {
    const [dx, dy, dz] = this.geometry.dims;
    if (i < 0 || j < 0 || k < 0 || i >= dx || j >= dy || k >= dz) return Number.NaN;
    return this.voxels[i + j * dx + k * dx * dy]!;
  }

  private bandHeight(bz: number): number {
    const dz = this.geometry.dims[2];
    return Math.min((bz + 1) * this.brickSize, dz) - bz * this.brickSize;
  }

  private markBand(bz: number, state: BrickState): void {
    const [nbx, nby] = this.bricksPerAxis;
    for (let by = 0; by < nby; by++) {
      for (let bx = 0; bx < nbx; bx++) {
        const index = bx + by * nbx + bz * nbx * nby;
        this.states[index] = state;
        if (state === BrickState.Resident) this.dirty.add(index);
      }
    }
  }
}
