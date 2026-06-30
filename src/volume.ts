import { BrickStore } from './brick-store';
import type { VolumeFormat, VolumeGeometry } from './geometry';

export class Volume {
  readonly id: string;
  readonly geometry: VolumeGeometry;
  readonly format: VolumeFormat;
  readonly store: BrickStore;

  constructor(id: string, geometry: VolumeGeometry, format: VolumeFormat, brickSize: number) {
    this.id = id;
    this.geometry = geometry;
    this.format = format;
    this.store = new BrickStore(geometry, format, brickSize);
  }

  writeSlice(k: number, data: ArrayLike<number>): void {
    this.store.writeSlice(k, data);
  }

  isSliceLoaded(k: number): boolean {
    return this.store.isSliceWritten(k);
  }
}
