import type { VolumeFormat, VolumeGeometry } from './geometry';
import type { Vec3 } from './math';

export const BrickState = { Absent: 0, Loading: 1, Resident: 2 } as const;
export type BrickState = (typeof BrickState)[keyof typeof BrickState];

export type VoxelArray = Int16Array | Uint16Array | Uint8Array | Float32Array;

export const CELL_SIZE = 4;

export interface BrickRegion {
  readonly origin: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly data: VoxelArray;
  readonly min: number;
  readonly max: number;
  readonly cellGrid: readonly [number, number, number];
  readonly cellRanges: VoxelArray;
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

export function bytesPerVoxel(format: VolumeFormat): number {
  switch (format) {
    case 'int16':
    case 'uint16':
      return 2;
    case 'uint8':
      return 1;
    case 'float32':
      return 4;
  }
}

export function createVoxelArray(format: VolumeFormat, count: number): VoxelArray {
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

  private readonly bricks: (VoxelArray | null)[];
  private readonly states: Uint8Array;
  private readonly sliceWritten: Uint8Array;
  private readonly bandCount: Int32Array;
  private readonly dirty = new Set<number>();

  constructor(geometry: VolumeGeometry, format: VolumeFormat, brickSize: number) {
    if (brickSize % CELL_SIZE !== 0) {
      throw new Error(`Brick size ${brickSize} must be a multiple of the cell size ${CELL_SIZE}.`);
    }
    this.geometry = geometry;
    this.format = format;
    this.brickSize = brickSize;
    const dz = geometry.dims[2];
    this.bricksPerAxis = brickGridSize(geometry.dims, brickSize);
    const brickCount = this.bricksPerAxis[0] * this.bricksPerAxis[1] * this.bricksPerAxis[2];
    this.bricks = Array.from({ length: brickCount }, () => null);
    this.states = new Uint8Array(brickCount);
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
    const [nbx, nby] = this.bricksPerAxis;
    const size = this.brickSize;
    const bz = Math.floor(k / size);
    const kz = k - bz * size;
    for (let by = 0; by < nby; by++) {
      const oy = by * size;
      const h = Math.min(size, dy - oy);
      for (let bx = 0; bx < nbx; bx++) {
        const ox = bx * size;
        const w = Math.min(size, dx - ox);
        const index = bx + by * nbx + bz * nbx * nby;
        const brick = this.bricks[index] ?? this.allocateBrick(index);
        for (let y = 0; y < h; y++) {
          const src = ox + (oy + y) * dx;
          const dst = (kz * h + y) * w;
          for (let x = 0; x < w; x++) brick[dst + x] = data[src + x]!;
        }
      }
    }
    if (this.sliceWritten[k] === 1) return;
    this.sliceWritten[k] = 1;

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
    const [w, h, d] = size;
    const data = this.bricks[linearIndex] ?? createVoxelArray(this.format, w * h * d);
    const cellGrid: [number, number, number] = [
      Math.ceil(w / CELL_SIZE),
      Math.ceil(h / CELL_SIZE),
      Math.ceil(d / CELL_SIZE),
    ];
    const [cx, cy, cz] = cellGrid;
    const cellRanges = createVoxelArray(this.format, cx * cy * cz * 2);
    let min = Infinity;
    let max = -Infinity;
    for (let c = 0; c < cz; c++) {
      for (let b = 0; b < cy; b++) {
        for (let a = 0; a < cx; a++) {
          let lo = Infinity;
          let hi = -Infinity;
          for (let z = c * CELL_SIZE; z < Math.min(d, (c + 1) * CELL_SIZE); z++) {
            for (let y = b * CELL_SIZE; y < Math.min(h, (b + 1) * CELL_SIZE); y++) {
              const row = (z * h + y) * w;
              for (let x = a * CELL_SIZE; x < Math.min(w, (a + 1) * CELL_SIZE); x++) {
                const value = data[row + x]!;
                if (value < lo) lo = value;
                if (value > hi) hi = value;
              }
            }
          }
          const cell = (a + b * cx + c * cx * cy) * 2;
          cellRanges[cell] = lo;
          cellRanges[cell + 1] = hi;
          if (lo < min) min = lo;
          if (hi > max) max = hi;
        }
      }
    }
    return { origin, size, data, min, max, cellGrid, cellRanges };
  }

  sampleVoxel(i: number, j: number, k: number): number {
    const [dx, dy, dz] = this.geometry.dims;
    if (i < 0 || j < 0 || k < 0 || i >= dx || j >= dy || k >= dz) return Number.NaN;
    const size = this.brickSize;
    const [nbx, nby] = this.bricksPerAxis;
    const bx = Math.floor(i / size);
    const by = Math.floor(j / size);
    const bz = Math.floor(k / size);
    const brick = this.bricks[bx + by * nbx + bz * nbx * nby];
    if (!brick) return Number.NaN;
    const w = Math.min(size, dx - bx * size);
    const h = Math.min(size, dy - by * size);
    return brick[i - bx * size + (j - by * size) * w + (k - bz * size) * w * h]!;
  }

  private allocateBrick(index: number): VoxelArray {
    const { size } = brickBounds(this.geometry.dims, this.brickSize, this.bricksPerAxis, index);
    const brick = createVoxelArray(this.format, size[0] * size[1] * size[2]);
    this.bricks[index] = brick;
    return brick;
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
