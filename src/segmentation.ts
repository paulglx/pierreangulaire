import { brickBounds, brickGridSize } from './brick-store';
import { type VolumeGeometry, worldToIndex } from './geometry';
import type { Vec3 } from './math';

export const OVERLAP_DEPTH = 4;
const SEGMENT_COUNT = 65536;

export interface LabelStyle {
  readonly color: readonly [number, number, number];
  readonly opacity: number;
  readonly visible: boolean;
}

export interface SegmentationBrickRegion {
  readonly origin: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly data: Uint16Array;
}

function hslColor(
  hue: number,
  saturation: number,
  lightness: number,
): readonly [number, number, number] {
  const a = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n: number): number => {
    const k = (n + hue / 30) % 12;
    return lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}

function defaultStyle(segment: number): LabelStyle {
  return {
    color: hslColor((segment * 137.508) % 360, 0.8, 0.6),
    opacity: 0.2,
    visible: true,
  };
}

let sharedDefaultTable: Float32Array | null = null;

function defaultLabelTable(): Float32Array {
  if (sharedDefaultTable) return sharedDefaultTable;
  sharedDefaultTable = new Float32Array(SEGMENT_COUNT * 4);
  for (let segment = 1; segment < SEGMENT_COUNT; segment++) {
    const { color, opacity } = defaultStyle(segment);
    const offset = segment * 4;
    sharedDefaultTable[offset] = color[0];
    sharedDefaultTable[offset + 1] = color[1];
    sharedDefaultTable[offset + 2] = color[2];
    sharedDefaultTable[offset + 3] = opacity;
  }
  return sharedDefaultTable;
}

export class Segmentation {
  readonly geometry: VolumeGeometry;
  readonly brickSize: number;
  readonly bricksPerAxis: readonly [number, number, number];

  private readonly bricks: (Uint16Array | null)[];
  private readonly styles = new Map<number, LabelStyle>();
  private readonly labels: Float32Array;
  private readonly voxelsPerSegment = new Uint32Array(SEGMENT_COUNT);
  private readonly dirty = new Set<number>();
  private version = 0;

  constructor(geometry: VolumeGeometry, brickSize: number) {
    this.geometry = geometry;
    this.brickSize = brickSize;
    this.bricksPerAxis = brickGridSize(geometry.dims, brickSize);
    const [nbx, nby, nbz] = this.bricksPerAxis;
    this.bricks = Array.from({ length: nbx * nby * nbz }, () => null);
    this.labels = defaultLabelTable().slice();
  }

  get labelVersion(): number {
    return this.version;
  }

  get labelTable(): Float32Array {
    return this.labels;
  }

  getLabelStyle(segment: number): LabelStyle {
    return this.styles.get(segment) ?? defaultStyle(segment);
  }

  setLabelStyle(segment: number, style: LabelStyle): void {
    this.styles.set(segment, style);
    const offset = segment * 4;
    if (style.visible) {
      this.labels[offset] = style.color[0];
      this.labels[offset + 1] = style.color[1];
      this.labels[offset + 2] = style.color[2];
      this.labels[offset + 3] = style.opacity;
    } else {
      this.labels.fill(0, offset, offset + 4);
    }
    this.version++;
  }

  segmentsPresent(): number[] {
    const present: number[] = [];
    for (let segment = 1; segment < SEGMENT_COUNT; segment++) {
      if (this.voxelsPerSegment[segment]! > 0) present.push(segment);
    }
    return present;
  }

  paintSphere(centerWorld: Vec3, radiusMm: number, segment: number): void {
    if (!Number.isInteger(segment) || segment < 1 || segment >= SEGMENT_COUNT) {
      throw new Error(`Segment index must be an integer in [1, 65535], got ${segment}.`);
    }
    const [dx, dy, dz] = this.geometry.dims;
    const [sx, sy, sz] = this.geometry.spacing;
    const center = worldToIndex(this.geometry, centerWorld);
    const i0 = Math.max(0, Math.ceil(center[0] - radiusMm / sx));
    const i1 = Math.min(dx - 1, Math.floor(center[0] + radiusMm / sx));
    const j0 = Math.max(0, Math.ceil(center[1] - radiusMm / sy));
    const j1 = Math.min(dy - 1, Math.floor(center[1] + radiusMm / sy));
    const k0 = Math.max(0, Math.ceil(center[2] - radiusMm / sz));
    const k1 = Math.min(dz - 1, Math.floor(center[2] + radiusMm / sz));
    const radiusSq = radiusMm * radiusMm;
    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const wx = (i - center[0]) * sx;
          const wy = (j - center[1]) * sy;
          const wz = (k - center[2]) * sz;
          if (wx * wx + wy * wy + wz * wz > radiusSq) continue;
          this.addToSlots(i, j, k, segment);
        }
      }
    }
  }

  takeDirtyBricks(): number[] {
    const out = [...this.dirty];
    this.dirty.clear();
    return out;
  }

  readBrick(linearIndex: number): SegmentationBrickRegion {
    const { origin, size } = brickBounds(
      this.geometry.dims,
      this.brickSize,
      this.bricksPerAxis,
      linearIndex,
    );
    const [w, h, d] = size;
    const data = this.bricks[linearIndex] ?? new Uint16Array(w * h * d * OVERLAP_DEPTH);
    return { origin, size, data };
  }

  private allocateBrick(index: number): Uint16Array {
    const { size } = brickBounds(this.geometry.dims, this.brickSize, this.bricksPerAxis, index);
    const brick = new Uint16Array(size[0] * size[1] * size[2] * OVERLAP_DEPTH);
    this.bricks[index] = brick;
    return brick;
  }

  private addToSlots(i: number, j: number, k: number, segment: number): void {
    const size = this.brickSize;
    const [dx, dy] = this.geometry.dims;
    const [nbx, nby] = this.bricksPerAxis;
    const bx = Math.floor(i / size);
    const by = Math.floor(j / size);
    const bz = Math.floor(k / size);
    const brickIndex = bx + by * nbx + bz * nbx * nby;
    const w = Math.min(size, dx - bx * size);
    const h = Math.min(size, dy - by * size);
    const slots = this.bricks[brickIndex] ?? this.allocateBrick(brickIndex);
    const offset = (i - bx * size + (j - by * size) * w + (k - bz * size) * w * h) * OVERLAP_DEPTH;

    let emptySlot = -1;
    let lowestSlot = 0;
    let lowest = SEGMENT_COUNT;
    for (let slot = 0; slot < OVERLAP_DEPTH; slot++) {
      const existing = slots[offset + slot]!;
      if (existing === segment) return;
      if (existing === 0) {
        if (emptySlot === -1) emptySlot = slot;
      } else if (existing < lowest) {
        lowest = existing;
        lowestSlot = slot;
      }
    }
    if (emptySlot !== -1) {
      slots[offset + emptySlot] = segment;
    } else if (lowest < segment) {
      this.voxelsPerSegment[lowest] = this.voxelsPerSegment[lowest]! - 1;
      slots[offset + lowestSlot] = segment;
    } else {
      return;
    }
    this.voxelsPerSegment[segment] = this.voxelsPerSegment[segment]! + 1;
    this.dirty.add(brickIndex);
  }
}
