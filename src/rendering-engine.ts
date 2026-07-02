import { cameraForOrientation, type Camera, type Orientation } from './camera';
import type { VolumeFormat, VolumeGeometry } from './geometry';
import { GPURenderer } from './renderer/gpu-renderer';
import type { Renderer } from './renderer/renderer';
import { Viewport } from './viewport';
import { Volume } from './volume';

export interface RenderingEngineOptions {
  brickSize?: number;
}

export interface CreateViewportOptions {
  id: string;
  canvas: HTMLCanvasElement;
  volume: Volume;
  orientation?: Orientation;
  camera?: Camera;
}

const DEFAULT_BRICK_SIZE = 32;

export class RenderingEngine {
  private readonly renderer: Renderer;
  private readonly brickSize: number;
  private readonly volumes = new Map<string, Volume>();
  private readonly viewports = new Map<string, Viewport>();
  private nextId = 0;
  private rafHandle: number | null = null;
  private destroyed = false;

  private constructor(renderer: Renderer, brickSize: number) {
    this.renderer = renderer;
    this.brickSize = brickSize;
  }

  static async create(
    options: RenderingEngineOptions,
    renderer: Renderer = new GPURenderer(),
  ): Promise<RenderingEngine> {
    await renderer.initialize();
    const engine = new RenderingEngine(renderer, options.brickSize ?? DEFAULT_BRICK_SIZE);
    engine.startLoop();
    return engine;
  }

  createVolume(geometry: VolumeGeometry, format: VolumeFormat): Volume {
    const id = `volume-${this.nextId++}`;
    const volume = new Volume(id, geometry, format, this.brickSize);
    this.volumes.set(id, volume);
    this.renderer.onVolumeCreated(volume);
    return volume;
  }

  getVolume(id: string): Volume | undefined {
    return this.volumes.get(id);
  }

  destroyVolume(id: string): void {
    if (!this.volumes.has(id)) return;
    for (const viewport of this.viewports.values()) {
      if (viewport.volume.id === id) {
        throw new Error(
          `Cannot destroy volume ${id}: viewport ${viewport.id} still references it. Destroy the viewport first.`,
        );
      }
    }
    this.volumes.delete(id);
    this.renderer.onVolumeDestroyed(id);
  }

  createViewport(options: CreateViewportOptions): Viewport {
    this.ensureCanvasSize(options.canvas);
    const aspect = options.canvas.width / options.canvas.height;
    const camera =
      options.camera ??
      cameraForOrientation(options.volume.geometry, options.orientation ?? 'axial', aspect);
    const viewport = new Viewport(options.id, options.canvas, options.volume, camera);
    this.viewports.set(options.id, viewport);
    this.renderer.registerViewport(viewport);
    return viewport;
  }

  getViewport(id: string): Viewport | undefined {
    return this.viewports.get(id);
  }

  destroyViewport(id: string): void {
    if (!this.viewports.delete(id)) return;
    this.renderer.destroyViewport(id);
  }

  resizeViewport(id: string): void {
    const viewport = this.viewports.get(id);
    if (!viewport) return;
    this.ensureCanvasSize(viewport.canvas);
    this.renderer.resizeViewport(viewport);
    viewport.markDirty();
  }

  render(ids?: readonly string[]): void {
    const targets =
      ids === undefined
        ? [...this.viewports.values()].filter((viewport) => viewport.dirty)
        : ids.map((id) => this.viewports.get(id)).filter((vp): vp is Viewport => vp !== undefined);
    if (targets.length === 0) return;
    this.renderer.render(targets);
    for (const viewport of targets) viewport.dirty = false;
  }

  private uploadDirtyBricks(): void {
    for (const volume of this.volumes.values()) {
      const dirty = volume.store.takeDirtyBricks();
      if (dirty.length === 0) continue;
      this.renderer.uploadBricks(volume, dirty);
      for (const viewport of this.viewports.values()) {
        if (viewport.volume.id === volume.id) viewport.markDirty();
      }
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.viewports.clear();
    this.volumes.clear();
    this.renderer.destroy();
    if (instance === this) {
      instance = null;
      pending = null;
    }
  }

  private startLoop(): void {
    const frame = (): void => {
      if (this.destroyed) return;
      this.uploadDirtyBricks();
      this.render();
      this.rafHandle = requestAnimationFrame(frame);
    };
    this.rafHandle = requestAnimationFrame(frame);
  }

  private ensureCanvasSize(canvas: HTMLCanvasElement): void {
    const dpr = globalThis.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(canvas.clientWidth * dpr)) || canvas.width || 512;
    const height = Math.max(1, Math.floor(canvas.clientHeight * dpr)) || canvas.height || 512;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  }
}

let instance: RenderingEngine | null = null;
let pending: Promise<RenderingEngine> | null = null;

export async function initRenderingEngine(
  options: RenderingEngineOptions = {},
): Promise<RenderingEngine> {
  if (instance) return instance;
  if (!pending) {
    pending = RenderingEngine.create(options).then((engine) => {
      instance = engine;
      return engine;
    });
  }
  return pending;
}

export function getRenderingEngine(): RenderingEngine {
  if (!instance) {
    throw new Error('RenderingEngine not initialized. Call initRenderingEngine() first.');
  }
  return instance;
}
