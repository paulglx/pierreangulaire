import { BrickStore } from './brick-store';
import type { VolumeFormat, VolumeGeometry } from './geometry';

export type SliceListener = (k: number) => void;

export class Volume {
  readonly id: string;
  readonly geometry: VolumeGeometry;
  readonly format: VolumeFormat;
  readonly store: BrickStore;

  private readonly listeners = new Set<SliceListener>();

  constructor(id: string, geometry: VolumeGeometry, format: VolumeFormat, brickSize: number) {
    this.id = id;
    this.geometry = geometry;
    this.format = format;
    this.store = new BrickStore(geometry, format, brickSize);
  }

  writeSlice(k: number, data: ArrayLike<number>): void {
    this.store.writeSlice(k, data);
    for (const listener of this.listeners) listener(k);
  }

  isSliceLoaded(k: number): boolean {
    return this.store.isSliceWritten(k);
  }

  onSliceWritten(listener: SliceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
