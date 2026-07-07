import { brickBounds, brickGridSize } from './brick-store';
import { type VolumeGeometry, voxelCount, worldToIndex } from './geometry';
import type { Vec3 } from './math';

export const OVERLAP_DEPTH = 4;
const SEGMENT_COUNT = 256;

export interface LabelStyle {
  readonly color: readonly [number, number, number];
  readonly opacity: number;
  readonly visible: boolean;
}

export interface SegmentationBrickRegion {
  readonly origin: readonly [number, number, number];
  readonly size: readonly [number, number, number];
  readonly data: Uint8Array;
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

function defaultStyles(): LabelStyle[] {
  const styles: LabelStyle[] = [];
  for (let segment = 0; segment < SEGMENT_COUNT; segment++) {
    styles.push({
      color: hslColor((segment * 137.508) % 360, 0.8, 0.6),
      opacity: 0.2,
      visible: true,
    });
  }
  return styles;
}

export class Segmentation {
  readonly geometry: VolumeGeometry;
  readonly brickSize: number;
  readonly bricksPerAxis: readonly [number, number, number];

  private readonly voxels: Uint8Array;
  private readonly styles: LabelStyle[];
  private readonly voxelsPerSegment = new Uint32Array(SEGMENT_COUNT);
  private readonly dirty = new Set<number>();
  private version = 0;

  constructor(geometry: VolumeGeometry, brickSize: number) {
    this.geometry = geometry;
    this.brickSize = brickSize;
    this.bricksPerAxis = brickGridSize(geometry.dims, brickSize);
    this.voxels = new Uint8Array(voxelCount(geometry) * OVERLAP_DEPTH);
    this.styles = defaultStyles();
  }

  get labelVersion(): number {
    return this.version;
  }

  getLabelStyle(segment: number): LabelStyle {
    return this.styles[segment]!;
  }

  setLabelStyle(segment: number, style: LabelStyle): void {
    this.styles[segment] = style;
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
      throw new Error(`Segment index must be an integer in [1, 255], got ${segment}.`);
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
          if (this.addToSlots(i + j * dx + k * dx * dy, segment)) {
            this.markVoxelDirty(i, j, k);
          }
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
    const [dx, dy] = this.geometry.dims;
    const [ox, oy, oz] = origin;
    const [w, h, d] = size;
    const data = new Uint8Array(w * h * d * OVERLAP_DEPTH);
    for (let z = 0; z < d; z++) {
      for (let y = 0; y < h; y++) {
        const src = (ox + (oy + y) * dx + (oz + z) * dx * dy) * OVERLAP_DEPTH;
        data.set(
          this.voxels.subarray(src, src + w * OVERLAP_DEPTH),
          (y * w + z * w * h) * OVERLAP_DEPTH,
        );
      }
    }
    return { origin, size, data };
  }

  private addToSlots(voxel: number, segment: number): boolean {
    const offset = voxel * OVERLAP_DEPTH;
    let emptySlot = -1;
    let lowestSlot = 0;
    let lowest = SEGMENT_COUNT;
    for (let slot = 0; slot < OVERLAP_DEPTH; slot++) {
      const existing = this.voxels[offset + slot]!;
      if (existing === segment) return false;
      if (existing === 0) {
        if (emptySlot === -1) emptySlot = slot;
      } else if (existing < lowest) {
        lowest = existing;
        lowestSlot = slot;
      }
    }
    if (emptySlot !== -1) {
      this.voxels[offset + emptySlot] = segment;
    } else if (lowest < segment) {
      this.voxelsPerSegment[lowest] = this.voxelsPerSegment[lowest]! - 1;
      this.voxels[offset + lowestSlot] = segment;
    } else {
      return false;
    }
    this.voxelsPerSegment[segment] = this.voxelsPerSegment[segment]! + 1;
    return true;
  }

  private markVoxelDirty(i: number, j: number, k: number): void {
    const [nbx, nby] = this.bricksPerAxis;
    const bx = Math.floor(i / this.brickSize);
    const by = Math.floor(j / this.brickSize);
    const bz = Math.floor(k / this.brickSize);
    this.dirty.add(bx + by * nbx + bz * nbx * nby);
  }
}
