import { BrickStore } from './brick-store';
import type { VolumeFormat, VolumeGeometry } from './geometry';
import { Segmentation } from './segmentation';

export class Volume {
  readonly id: string;
  readonly geometry: VolumeGeometry;
  readonly format: VolumeFormat;
  readonly store: BrickStore;
  readonly segmentation: Segmentation;

  constructor(id: string, geometry: VolumeGeometry, format: VolumeFormat, brickSize: number) {
    this.id = id;
    this.geometry = geometry;
    this.format = format;
    this.store = new BrickStore(geometry, format, brickSize);
    this.segmentation = new Segmentation(geometry, brickSize);
  }

  writeSlice(k: number, data: ArrayLike<number>): void {
    this.store.writeSlice(k, data);
  }

  isSliceLoaded(k: number): boolean {
    return this.store.isSliceWritten(k);
  }
}
