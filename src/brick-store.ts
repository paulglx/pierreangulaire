import type { VolumeFormat, VolumeGeometry } from './geometry';
import type { Vec3 } from './math';

export const BrickState = { Absent: 0, Loading: 1, Resident: 2 } as const;
export type BrickState = (typeof BrickState)[keyof typeof BrickState];

export type VoxelArray = Int16Array | Uint16Array | Uint8Array | Float32Array;

export const CELL_SIZE = 4;

export interface BandRegion {
  readonly z: number;
  readonly slices: readonly VoxelArray[];
  readonly cellGrid: readonly [number, number, number];
  readonly cellRanges: VoxelArray;
  readonly brickRanges: Float64Array;
}

export interface BrickBounds {
  readonly origin: readonly [number, number, number];
  readonly size: readonly [number, number, number];
}

const VOXEL_ARRAYS = {
  int16: Int16Array,
  uint16: Uint16Array,
  uint8: Uint8Array,
  float32: Float32Array,
} as const;

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
  return VOXEL_ARRAYS[format].BYTES_PER_ELEMENT;
}

export function createVoxelArray(format: VolumeFormat, count: number): VoxelArray {
  return new VOXEL_ARRAYS[format](count);
}

export class BrickStore {
  readonly geometry: VolumeGeometry;
  readonly format: VolumeFormat;
  readonly brickSize: number;
  readonly bricksPerAxis: readonly [number, number, number];

  private readonly slices: (VoxelArray | null)[];
  private readonly states: Uint8Array;
  private readonly bandCount: Int32Array;
  private readonly dirtyBands = new Set<number>();

  constructor(geometry: VolumeGeometry, format: VolumeFormat, brickSize: number) {
    if (brickSize % CELL_SIZE !== 0) {
      throw new Error(`Brick size ${brickSize} must be a multiple of the cell size ${CELL_SIZE}.`);
    }
    this.geometry = geometry;
    this.format = format;
    this.brickSize = brickSize;
    this.bricksPerAxis = brickGridSize(geometry.dims, brickSize);
    const brickCount = this.bricksPerAxis[0] * this.bricksPerAxis[1] * this.bricksPerAxis[2];
    this.slices = Array.from({ length: geometry.dims[2] }, () => null);
    this.states = new Uint8Array(brickCount);
    this.bandCount = new Int32Array(this.bricksPerAxis[2]);
  }

  get brickCount(): number {
    return this.states.length;
  }

  brickStateAt(linearIndex: number): BrickState {
    return this.states[linearIndex] as BrickState;
  }

  isSliceWritten(k: number): boolean {
    return this.slices[k] !== null;
  }

  writeSlice(k: number, data: ArrayLike<number>): void {
    const [dx, dy, dz] = this.geometry.dims;
    if (k < 0 || k >= dz) {
      throw new Error(`Slice ${k} is outside the volume depth ${dz}.`);
    }
    if (data.length !== dx * dy) {
      throw new Error(`Slice ${k} has ${data.length} samples, expected ${dx * dy}.`);
    }
    const Type = VOXEL_ARRAYS[this.format];
    const firstWrite = this.slices[k] === null;
    this.slices[k] = data instanceof Type ? data : new Type(data);
    if (!firstWrite) return;

    const bz = Math.floor(k / this.brickSize);
    const previous = this.bandCount[bz]!;
    const current = previous + 1;
    this.bandCount[bz] = current;
    if (previous === 0) this.markBand(bz, BrickState.Loading);
    if (current === this.bandDepth(bz)) {
      this.markBand(bz, BrickState.Resident);
      this.dirtyBands.add(bz);
    }
  }

  takeDirtyBands(): number[] {
    const out = [...this.dirtyBands];
    this.dirtyBands.clear();
    return out;
  }

  readBand(bz: number): BandRegion {
    const [dx, dy] = this.geometry.dims;
    const z = bz * this.brickSize;
    const depth = this.bandDepth(bz);
    const slices: VoxelArray[] = [];
    for (let k = z; k < z + depth; k++) {
      const slice = this.slices[k];
      if (!slice) throw new Error(`Band ${bz} is not resident: slice ${k} is missing.`);
      slices.push(slice);
    }
    const cellGrid: [number, number, number] = [
      Math.ceil(dx / CELL_SIZE),
      Math.ceil(dy / CELL_SIZE),
      Math.ceil(depth / CELL_SIZE),
    ];
    const [cx, cy, cz] = cellGrid;
    const lo = new Float64Array(cx * cy * cz).fill(Number.POSITIVE_INFINITY);
    const hi = new Float64Array(cx * cy * cz).fill(Number.NEGATIVE_INFINITY);
    const fullCells = Math.floor(dx / CELL_SIZE);
    for (let s = 0; s < depth; s++) {
      const slice = slices[s]!;
      const plane = Math.floor(s / CELL_SIZE) * cx * cy;
      for (let y = 0; y < dy; y++) {
        const row = y * dx;
        const cellRow = plane + Math.floor(y / CELL_SIZE) * cx;
        for (let c = 0; c < fullCells; c++) {
          const cell = cellRow + c;
          const base = row + c * CELL_SIZE;
          let l = lo[cell]!;
          let h = hi[cell]!;
          const v0 = slice[base]!;
          const v1 = slice[base + 1]!;
          const v2 = slice[base + 2]!;
          const v3 = slice[base + 3]!;
          if (v0 < l) l = v0;
          if (v0 > h) h = v0;
          if (v1 < l) l = v1;
          if (v1 > h) h = v1;
          if (v2 < l) l = v2;
          if (v2 > h) h = v2;
          if (v3 < l) l = v3;
          if (v3 > h) h = v3;
          lo[cell] = l;
          hi[cell] = h;
        }
        for (let x = fullCells * CELL_SIZE; x < dx; x++) {
          const cell = cellRow + fullCells;
          const value = slice[row + x]!;
          if (value < lo[cell]!) lo[cell] = value;
          if (value > hi[cell]!) hi[cell] = value;
        }
      }
    }
    const cellRanges = createVoxelArray(this.format, lo.length * 2);
    for (let cell = 0; cell < lo.length; cell++) {
      cellRanges[cell * 2] = lo[cell]!;
      cellRanges[cell * 2 + 1] = hi[cell]!;
    }
    const [nbx, nby] = this.bricksPerAxis;
    const cellsPerBrick = this.brickSize / CELL_SIZE;
    const brickRanges = new Float64Array(nbx * nby * 2);
    for (let by = 0; by < nby; by++) {
      for (let bx = 0; bx < nbx; bx++) {
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        const aEnd = Math.min(cx, (bx + 1) * cellsPerBrick);
        const bEnd = Math.min(cy, (by + 1) * cellsPerBrick);
        for (let c = 0; c < cz; c++) {
          for (let b = by * cellsPerBrick; b < bEnd; b++) {
            for (let a = bx * cellsPerBrick; a < aEnd; a++) {
              const cell = a + b * cx + c * cx * cy;
              if (lo[cell]! < min) min = lo[cell]!;
              if (hi[cell]! > max) max = hi[cell]!;
            }
          }
        }
        brickRanges[(bx + by * nbx) * 2] = min;
        brickRanges[(bx + by * nbx) * 2 + 1] = max;
      }
    }
    return { z, slices, cellGrid, cellRanges, brickRanges };
  }

  sampleVoxel(i: number, j: number, k: number): number {
    const [dx, dy, dz] = this.geometry.dims;
    if (i < 0 || j < 0 || k < 0 || i >= dx || j >= dy || k >= dz) return Number.NaN;
    const slice = this.slices[k];
    if (!slice) return Number.NaN;
    return slice[i + j * dx]!;
  }

  private bandDepth(bz: number): number {
    const dz = this.geometry.dims[2];
    return Math.min((bz + 1) * this.brickSize, dz) - bz * this.brickSize;
  }

  private markBand(bz: number, state: BrickState): void {
    const [nbx, nby] = this.bricksPerAxis;
    const first = bz * nbx * nby;
    this.states.fill(state, first, first + nbx * nby);
  }
}
