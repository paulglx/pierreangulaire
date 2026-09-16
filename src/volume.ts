import { BrickStore } from './brick-store';
import type { VolumeFormat, VolumeGeometry } from './geometry';
import { Segmentation } from './segmentation';

export interface Rescale {
  readonly slope: number;
  readonly intercept: number;
}

export const IDENTITY_RESCALE: Rescale = { slope: 1, intercept: 0 };

export function applyRescale(rescale: Rescale, raw: number): number {
  return raw * rescale.slope + rescale.intercept;
}

export class Volume {
  readonly id: string;
  readonly geometry: VolumeGeometry;
  readonly format: VolumeFormat;
  readonly rescale: Rescale;
  readonly store: BrickStore;
  readonly segmentation: Segmentation;

  constructor(
    id: string,
    geometry: VolumeGeometry,
    format: VolumeFormat,
    brickSize: number,
    rescale: Rescale = IDENTITY_RESCALE,
  ) {
    this.id = id;
    this.geometry = geometry;
    this.format = format;
    this.rescale = rescale;
    this.store = new BrickStore(geometry, format, brickSize);
    this.segmentation = new Segmentation(geometry, brickSize);
  }

  writeSlice(k: number, data: ArrayLike<number>): void {
    this.store.writeSlice(k, data);
  }

  isSliceLoaded(k: number): boolean {
    return this.store.isSliceWritten(k);
  }

  sampleVoxel(i: number, j: number, k: number): number {
    return applyRescale(this.rescale, this.store.sampleVoxel(i, j, k));
  }
}
