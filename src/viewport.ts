import { BlendMode, type WindowLevel } from './blend';
import { Camera, type CanvasPoint, canvasToWorld, worldToCanvas } from './camera';
import { worldToIndex } from './geometry';
import type { Vec3 } from './math';
import type { Volume } from './volume';

export class Viewport {
  readonly id: string;
  readonly canvas: HTMLCanvasElement;
  readonly volume: Volume;

  camera: Camera;
  windowLevel: WindowLevel;
  blendMode: BlendMode;
  slabThickness: number;
  segmentationVisible = false;
  dirty = true;

  constructor(id: string, canvas: HTMLCanvasElement, volume: Volume, camera: Camera) {
    this.id = id;
    this.canvas = canvas;
    this.volume = volume;
    this.camera = camera;
    this.windowLevel = { center: 40, width: 400 };
    this.blendMode = BlendMode.MIP;
    this.slabThickness = Math.min(...volume.geometry.spacing);
  }

  markDirty(): void {
    this.dirty = true;
  }

  setCamera(camera: Camera): void {
    this.camera = camera;
    this.dirty = true;
  }

  setWindowLevel(windowLevel: WindowLevel): void {
    this.windowLevel = windowLevel;
    this.dirty = true;
  }

  setBlendMode(blendMode: BlendMode): void {
    this.blendMode = blendMode;
    this.dirty = true;
  }

  setSlabThickness(thicknessMm: number): void {
    this.slabThickness = thicknessMm;
    this.dirty = true;
  }

  worldToCanvas(world: Vec3): CanvasPoint {
    return worldToCanvas(this.camera, world, this.canvas.width, this.canvas.height);
  }

  canvasToWorld(point: CanvasPoint): Vec3 {
    return canvasToWorld(this.camera, point, this.canvas.width, this.canvas.height);
  }

  sampleVoxel(world: Vec3): number {
    const index = worldToIndex(this.volume.geometry, world);
    return this.volume.store.sampleVoxel(
      Math.round(index[0]),
      Math.round(index[1]),
      Math.round(index[2]),
    );
  }
}
