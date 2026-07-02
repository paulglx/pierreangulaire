import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { VolumeGeometry } from '../src/geometry';
import { RenderingEngine } from '../src/rendering-engine';
import type { Renderer } from '../src/renderer/renderer';
import type { Viewport } from '../src/viewport';
import type { Volume } from '../src/volume';

const geometry: VolumeGeometry = {
  dims: [8, 8, 8],
  spacing: [1, 1, 1],
  origin: [0, 0, 0],
  direction: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
};

function fakeRenderer() {
  return {
    initialize: vi.fn(async () => {}),
    registerViewport: vi.fn((_viewport: Viewport) => {}),
    resizeViewport: vi.fn((_viewport: Viewport) => {}),
    destroyViewport: vi.fn((_id: string) => {}),
    onVolumeCreated: vi.fn((_volume: Volume) => {}),
    onVolumeDestroyed: vi.fn((_id: string) => {}),
    uploadBricks: vi.fn((_volume: Volume, _brickIndices: number[]) => {}),
    render: vi.fn((_viewports: readonly Viewport[]) => {}),
    destroy: vi.fn(() => {}),
  } satisfies Renderer;
}

function fakeCanvas(): HTMLCanvasElement {
  return { clientWidth: 256, clientHeight: 256, width: 0, height: 0 } as HTMLCanvasElement;
}

let cancelled: number[];

beforeEach(() => {
  cancelled = [];
  let handle = 0;
  vi.stubGlobal('requestAnimationFrame', () => ++handle);
  vi.stubGlobal('cancelAnimationFrame', (id: number) => cancelled.push(id));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('destroyVolume releases the volume and notifies the renderer', async () => {
  const renderer = fakeRenderer();
  const engine = await RenderingEngine.create({}, renderer);
  const volume = engine.createVolume(geometry, 'int16');

  engine.destroyVolume(volume.id);

  expect(renderer.onVolumeDestroyed).toHaveBeenCalledWith(volume.id);
  expect(engine.getVolume(volume.id)).toBeUndefined();
});

test('destroyVolume is a no-op for an unknown id', async () => {
  const renderer = fakeRenderer();
  const engine = await RenderingEngine.create({}, renderer);

  engine.destroyVolume('nope');

  expect(renderer.onVolumeDestroyed).not.toHaveBeenCalled();
});

test('destroyVolume refuses while a viewport still references the volume', async () => {
  const renderer = fakeRenderer();
  const engine = await RenderingEngine.create({}, renderer);
  const volume = engine.createVolume(geometry, 'int16');
  engine.createViewport({ id: 'vp', canvas: fakeCanvas(), volume });

  expect(() => engine.destroyVolume(volume.id)).toThrow(/still references it/);
  expect(engine.getVolume(volume.id)).toBe(volume);
  expect(renderer.onVolumeDestroyed).not.toHaveBeenCalled();

  engine.destroyViewport('vp');
  engine.destroyVolume(volume.id);
  expect(renderer.onVolumeDestroyed).toHaveBeenCalledWith(volume.id);
});

test('destroy stops the loop, tears down the renderer, and clears state', async () => {
  const renderer = fakeRenderer();
  const engine = await RenderingEngine.create({}, renderer);
  const volume = engine.createVolume(geometry, 'int16');
  engine.createViewport({ id: 'vp', canvas: fakeCanvas(), volume });

  engine.destroy();

  expect(cancelled).toHaveLength(1);
  expect(renderer.destroy).toHaveBeenCalledOnce();
  expect(engine.getVolume(volume.id)).toBeUndefined();
  expect(engine.getViewport('vp')).toBeUndefined();

  engine.destroy();
  expect(renderer.destroy).toHaveBeenCalledOnce();
});
