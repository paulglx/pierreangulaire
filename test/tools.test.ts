import { expect, test, vi } from 'vitest';
import { Camera, cameraForOrientation, sliceIndex, sliceRange, sliceSpacing } from '../src/camera';
import type { VolumeGeometry } from '../src/geometry';
import { PanTool, RotateTool, SlabScrollTool, ZoomTool } from '../src/tools/camera-tools';
import { ToolManager } from '../src/tools/tool-manager';
import { Viewport } from '../src/viewport';
import { Volume } from '../src/volume';

const geometry: VolumeGeometry = {
  dims: [10, 10, 20],
  spacing: [1, 1, 2],
  origin: [0, 0, 0],
  direction: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
};

type Listener = (event: unknown) => void;

function fakeCanvas() {
  const listeners = new Map<string, Listener>();
  const canvas = {
    width: 100,
    height: 100,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => true,
    ownerDocument: {
      addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    },
  };
  const fire = (type: string, event: Record<string, unknown>) => {
    let prevented = false;
    listeners.get(type)?.({
      button: 0,
      pointerId: 1,
      clientX: 50,
      clientY: 50,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      preventDefault: () => {
        prevented = true;
      },
      ...event,
    });
    return prevented;
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, fire, listeners };
}

function setup() {
  const { canvas, fire, listeners } = fakeCanvas();
  const volume = new Volume('volume', geometry, 'uint8', 32);
  const viewport = new Viewport('vp', canvas, volume, cameraForOrientation(geometry, 'axial', 1));
  const tools = new ToolManager();
  tools.attach(viewport);
  return { tools, viewport, fire, listeners };
}

test('slice spacing follows the volume axis most aligned with the normal', () => {
  expect(sliceSpacing(geometry, [0, 0, 1])).toBeCloseTo(2);
  expect(sliceSpacing(geometry, [1, 0, 0])).toBeCloseTo(1);
  expect(sliceSpacing(geometry, [Math.SQRT1_2, 0, Math.SQRT1_2])).toBeCloseTo(Math.SQRT2);
  expect(sliceRange(geometry, [0, 0, -1])).toEqual({ spacing: 2, first: -19, last: 0 });
});

test('slab scroll snaps the slab center onto a slice and clamps to the volume', () => {
  const camera = new Camera([0, 0, 1], [0, -1, 0], [4.5, 4.5, 18.7], 10);
  const scroll = new SlabScrollTool();
  const { viewport } = setup();
  viewport.camera = camera;
  scroll.step({ viewport, canvasPoint: { x: 0, y: 0 }, worldPoint: [0, 0, 0], steps: 1 });
  expect(camera.focalPoint[2]).toBeCloseTo(20);
  expect(sliceIndex(camera, geometry)).toBe(10);
  scroll.step({ viewport, canvasPoint: { x: 0, y: 0 }, worldPoint: [0, 0, 0], steps: 100 });
  expect(sliceIndex(camera, geometry)).toBe(19);
  scroll.step({ viewport, canvasPoint: { x: 0, y: 0 }, worldPoint: [0, 0, 0], steps: -0.6 });
  expect(sliceIndex(camera, geometry)).toBe(19);
  scroll.step({ viewport, canvasPoint: { x: 0, y: 0 }, worldPoint: [0, 0, 0], steps: -0.6 });
  expect(sliceIndex(camera, geometry)).toBe(18);
  expect(camera.focalPoint[0]).toBeCloseTo(4.5);
});

test('zooming keeps the anchor point under the cursor', () => {
  const { viewport } = setup();
  const anchor = viewport.canvasToWorld({ x: 20, y: 30 });
  viewport.camera.zoomAt(0.5, anchor);
  const after = viewport.worldToCanvas(anchor);
  expect(after.x).toBeCloseTo(20);
  expect(after.y).toBeCloseTo(30);
});

test('rotating around a pivot keeps it fixed on the canvas and in the slab', () => {
  const { viewport } = setup();
  const pivot = viewport.canvasToWorld({ x: 70, y: 20 });
  const depthBefore = viewport.camera.basis().normal;
  viewport.camera.rotateAround(pivot, [1, 1, 0], 0.4);
  const after = viewport.worldToCanvas(pivot);
  expect(after.x).toBeCloseTo(70);
  expect(after.y).toBeCloseTo(20);
  expect(viewport.camera.basis().normal).not.toEqual(depthBefore);
  const { normal, up } = viewport.camera;
  expect(normal[0] * up[0] + normal[1] * up[1] + normal[2] * up[2]).toBeCloseTo(0);
});

test('a drag pans the camera so the grabbed point follows the cursor', () => {
  const { tools, viewport, fire } = setup();
  const pan = tools.add(new PanTool());
  tools.setActive(pan, [{ button: 'primary' }]);
  const grabbed = viewport.canvasToWorld({ x: 50, y: 50 });
  expect(fire('pointerdown', {})).toBe(true);
  fire('pointermove', { clientX: 80, clientY: 10 });
  fire('pointerup', {});
  const after = viewport.worldToCanvas(grabbed);
  expect(after.x).toBeCloseTo(80);
  expect(after.y).toBeCloseTo(10);
});

test('modifiers must match a binding exactly', () => {
  const { tools, viewport, fire } = setup();
  const pan = tools.add(new PanTool());
  tools.setActive(pan, [{ button: 'primary', modifiers: ['shift'] }]);
  const before = viewport.camera.focalPoint;
  expect(fire('pointerdown', {})).toBe(false);
  fire('pointermove', { clientX: 80 });
  expect(viewport.camera.focalPoint).toEqual(before);
  expect(fire('pointerdown', { shiftKey: true, ctrlKey: true })).toBe(false);
  expect(fire('pointerdown', { shiftKey: true })).toBe(true);
});

test('activating a tool on a binding takes it from the tool that held it', () => {
  const tools = new ToolManager();
  const pan = tools.add(new PanTool());
  const zoom = tools.add(new ZoomTool());
  expect(tools.state(pan)).toBe('disabled');
  tools.setActive(pan, [{ button: 'primary' }, { button: 'auxiliary' }]);
  tools.setActive(zoom, [{ button: 'primary' }]);
  expect(tools.bindings(pan)).toEqual([{ button: 'auxiliary' }]);
  expect(tools.state(pan)).toBe('active');
  tools.setActive(zoom, [{ button: 'auxiliary', modifiers: [] }]);
  expect(tools.state(pan)).toBe('passive');
  expect(tools.bindings(pan)).toEqual([]);
});

test('tools reject triggers they do not support', () => {
  const tools = new ToolManager();
  const rotate = tools.add(new RotateTool());
  expect(() => tools.setActive(rotate, [{ wheel: true }])).toThrow();
  expect(() => tools.setActive(new PanTool(), [{ button: 'primary' }])).toThrow();
});

test('keys step the tool of the hovered viewport', () => {
  const { tools, viewport, fire } = setup();
  const scroll = tools.add(new SlabScrollTool());
  tools.setActive(scroll, [
    { key: 'ArrowUp', steps: -1 },
    { key: 'ArrowDown', steps: 1 },
  ]);
  const start = sliceIndex(viewport.camera, geometry);
  expect(fire('keydown', { key: 'ArrowDown', target: null })).toBe(false);
  fire('pointermove', {});
  expect(fire('keydown', { key: 'ArrowDown', target: null })).toBe(true);
  fire('keydown', { key: 'ArrowDown', target: null });
  fire('keydown', { key: 'ArrowUp', target: null });
  expect(sliceIndex(viewport.camera, geometry)).toBe(start + 1);
});

test('a wheel binding scales and signs the wheel steps', () => {
  vi.stubGlobal('WheelEvent', { DOM_DELTA_PIXEL: 0, DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 });
  const { tools, viewport, fire } = setup();
  const scroll = tools.add(new SlabScrollTool());
  tools.setActive(scroll, [{ wheel: true, steps: -1 }]);
  const start = sliceIndex(viewport.camera, geometry);
  expect(fire('wheel', { deltaX: 0, deltaY: 200, deltaMode: 0 })).toBe(true);
  expect(sliceIndex(viewport.camera, geometry)).toBe(start - 2);
  vi.unstubAllGlobals();
});
