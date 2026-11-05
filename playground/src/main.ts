import {
  applyRescale,
  type Binding,
  BlendMode,
  cameraForOrientation,
  DebugView,
  initRenderingEngine,
  type Orientation,
  PanTool,
  type RenderingEngine,
  RotateTool,
  SlabScrollTool,
  type Tool,
  type Vec3,
  type Viewport,
  type Volume,
  ZoomTool,
} from 'pierreangulaire';
import {
  Bug,
  CopyPlus,
  createElement,
  Flame,
  FolderOpen,
  Grid3x3,
  type IconNode,
  Layers,
  Move,
  Orbit,
  Rotate3d,
  RotateCcw,
  Spline,
  SquarePlus,
  ZoomIn,
} from 'lucide';
import { decodeSeries, openSeries, type Series, type SliceLoad } from './dicom';
import { paintRandomPhantom } from './phantoms';
import './style.css';

const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const folderInput = document.querySelector<HTMLInputElement>('#folder')!;
const kebabButton = document.querySelector<HTMLButtonElement>('#kebab')!;
const globalControlsEl = document.querySelector<HTMLDivElement>('#global-controls')!;
const resetButton = document.querySelector<HTMLButtonElement>('#reset')!;
const segments50Button = document.querySelector<HTMLButtonElement>('#segments-50')!;
const segments1000Button = document.querySelector<HTMLButtonElement>('#segments-1000')!;
const antialiasButton = document.querySelector<HTMLButtonElement>('#antialiasing')!;
const debugViewButton = document.querySelector<HTMLButtonElement>('#debug-view')!;
const primaryToolsEl = document.querySelector<HTMLDivElement>('#primary-tools')!;

const KEBAB_RAD_PER_SEC = (2 * Math.PI) / 24;

const PANELS: { id: string; orientation: Orientation }[] = [
  { id: 'axial', orientation: 'axial' },
  { id: 'coronal', orientation: 'coronal' },
  { id: 'sagittal', orientation: 'sagittal' },
];

const BLEND_NAMES = ['MIP', 'MinIP', 'Average', 'Composite'];
const DEBUG_VIEWS: { view: DebugView; name: string; icon: IconNode }[] = [
  { view: DebugView.None, name: 'off', icon: Bug },
  { view: DebugView.EmptyBlocks, name: 'empty blocks', icon: Grid3x3 },
  { view: DebugView.FetchHeatmap, name: 'fetch heatmap', icon: Flame },
];

interface CameraToolEntry {
  label: string;
  icon: IconNode;
  tool: Tool;
  bindings: Binding[];
}

const CAMERA_TOOLS: CameraToolEntry[] = [
  { label: 'Pan', icon: Move, tool: new PanTool(), bindings: [{ button: 'auxiliary' }] },
  {
    label: 'Zoom',
    icon: ZoomIn,
    tool: new ZoomTool(),
    bindings: [{ button: 'secondary' }, { wheel: true, modifiers: ['ctrl'] }],
  },
  {
    label: 'Scroll',
    icon: Layers,
    tool: new SlabScrollTool(),
    bindings: [{ wheel: true }, { key: 'ArrowUp', steps: -1 }, { key: 'ArrowDown', steps: 1 }],
  },
  { label: 'Rotate', icon: Rotate3d, tool: new RotateTool(), bindings: [] },
];

function setIcon(element: HTMLElement, icon: IconNode): void {
  element.replaceChildren(createElement(icon, { class: 'block size-4' }));
}

function setActive(element: HTMLElement, active: boolean): void {
  element.classList.toggle('text-stone-50', active);
  element.classList.toggle('text-stone-400', !active);
}

let primaryToolIndex = 2;
let toolEngine: RenderingEngine | null = null;
const primaryToolButtons: HTMLButtonElement[] = [];

interface ActiveViewport {
  viewport: Viewport;
  orientation: Orientation;
  baseNormal: Vec3;
  baseUp: Vec3;
}

let activeViewports: ActiveViewport[] = [];
let activeVolume: Volume | null = null;
let activeLoad: SliceLoad | null = null;
let antialiasEnabled = true;
let debugViewIndex = 0;
let blendMode: BlendMode = BlendMode.MIP;

let kebabEnabled = false;
let kebabRaf = 0;
let kebabAngle = 0;
let kebabLast = 0;

function kebabFrame(now: number): void {
  if (!kebabEnabled) return;
  if (kebabLast !== 0) {
    kebabAngle += ((now - kebabLast) / 1000) * KEBAB_RAD_PER_SEC;
  }
  kebabLast = now;
  for (const { viewport, baseNormal, baseUp } of activeViewports) {
    viewport.camera.normal = rotateAroundAxis(baseNormal, baseUp, kebabAngle);
    viewport.markDirty();
  }
  kebabRaf = requestAnimationFrame(kebabFrame);
}

function setKebab(enabled: boolean): void {
  kebabEnabled = enabled;
  kebabButton.title = `Kebab mode: ${enabled ? 'on' : 'off'}`;
  setActive(kebabButton, enabled);
  if (enabled) {
    kebabLast = 0;
    kebabRaf = requestAnimationFrame(kebabFrame);
  } else {
    cancelAnimationFrame(kebabRaf);
  }
}

function resetCameras(): void {
  setKebab(false);
  kebabAngle = 0;
  for (const { viewport, orientation } of activeViewports) {
    const aspect = viewport.canvas.width / viewport.canvas.height;
    viewport.setCamera(cameraForOrientation(viewport.volume.geometry, orientation, aspect));
  }
}

function applyToolBindings(engine: RenderingEngine): void {
  toolEngine = engine;
  CAMERA_TOOLS.forEach(({ tool, bindings }, index) => {
    engine.tools.add(tool);
    const primary: Binding[] = index === primaryToolIndex ? [{ button: 'primary' }] : [];
    engine.tools.setActive(tool, [...bindings, ...primary]);
  });
}

function selectPrimaryTool(index: number): void {
  primaryToolIndex = index;
  primaryToolButtons.forEach((button, buttonIndex) => setActive(button, buttonIndex === index));
  if (toolEngine) applyToolBindings(toolEngine);
}

function buildPrimaryToolButtons(): void {
  CAMERA_TOOLS.forEach(({ label, icon }, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cursor-pointer rounded p-1 hover:bg-stone-800';
    button.title = label;
    setIcon(button, icon);
    button.addEventListener('click', () => selectPrimaryTool(index));
    primaryToolButtons.push(button);
    primaryToolsEl.append(button);
  });
}

function setStatus(message: string): void {
  statusEl.textContent = message;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function oncePerFrame(callback: () => void): { request(): void; cancel(): void } {
  let handle = 0;
  return {
    request() {
      if (handle !== 0) return;
      handle = requestAnimationFrame(() => {
        handle = 0;
        callback();
      });
    },
    cancel() {
      cancelAnimationFrame(handle);
      handle = 0;
    },
  };
}

function dotVec(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function rotateAroundAxis(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const len = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const kx = axis[0] / len;
  const ky = axis[1] / len;
  const kz = axis[2] / len;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const parallel = (kx * v[0] + ky * v[1] + kz * v[2]) * (1 - cos);
  return [
    v[0] * cos + (ky * v[2] - kz * v[1]) * sin + kx * parallel,
    v[1] * cos + (kz * v[0] - kx * v[2]) * sin + ky * parallel,
    v[2] * cos + (kx * v[1] - ky * v[0]) * sin + kz * parallel,
  ];
}

function halfExtentAlong(volume: Volume, normal: Vec3): number {
  const { dims, spacing, direction } = volume.geometry;
  let total = 0;
  for (let axis = 0; axis < 3; axis++) {
    total += Math.abs(dotVec(direction[axis]!, normal)) * dims[axis]! * spacing[axis]!;
  }
  return 0.5 * total;
}

interface SliderSpec {
  name: string;
  min: number;
  max: number;
  step: number | 'any';
  value: number;
  format: (value: number) => string;
  apply: (value: number) => void;
}

function addSlider(controls: HTMLElement, spec: SliderSpec, markDirty: () => void): void {
  const label = document.createElement('label');
  label.className = 'flex items-center gap-2';

  const name = document.createElement('span');
  name.className = 'w-20 text-stone-400 uppercase tracking-wider';
  name.textContent = spec.name;

  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'm-0 h-2.5 w-24 accent-stone-400';
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  input.value = String(spec.value);

  const value = document.createElement('span');
  value.className = 'w-24 text-right tabular-nums';
  value.textContent = spec.format(spec.value);

  input.addEventListener('input', () => {
    const next = Number(input.value);
    spec.apply(next);
    value.textContent = spec.format(next);
    markDirty();
  });

  label.append(name, input, value);
  controls.append(label);
}

interface ControlRange {
  min: number;
  max: number;
  center: number;
  width: number;
}

function buildControls(viewport: Viewport, range: ControlRange): void {
  const panel = viewport.canvas.parentElement!;
  panel.querySelector('[data-controls]')?.remove();
  const controls = document.createElement('div');
  controls.dataset.controls = '';
  controls.className = 'absolute bottom-2.5 left-2.5 flex flex-col gap-1 text-shadow-sm';

  const specs: SliderSpec[] = [
    {
      name: 'Level',
      min: range.min,
      max: range.max,
      step: 1,
      value: range.center,
      format: (v) => String(Math.round(v)),
      apply: (v) => viewport.setWindowLevel({ center: v, width: viewport.windowLevel.width }),
    },
    {
      name: 'Window',
      min: 1,
      max: Math.max(2, range.max - range.min),
      step: 1,
      value: range.width,
      format: (v) => String(Math.round(v)),
      apply: (v) => viewport.setWindowLevel({ center: viewport.windowLevel.center, width: v }),
    },
  ];

  for (const spec of specs) addSlider(controls, spec, () => viewport.markDirty());
  panel.append(controls);
}

function cancelActiveLoad(): void {
  activeLoad?.cancel();
  activeLoad = null;
}

function markAllDirty(): void {
  for (const { viewport } of activeViewports) viewport.markDirty();
}

function buildGlobalControls(volume: Volume): void {
  globalControlsEl.replaceChildren();

  const minSpacing = Math.min(...volume.geometry.spacing);
  const maxHalf = Math.max(
    ...activeViewports.map(({ baseNormal }) => halfExtentAlong(volume, baseNormal)),
  );

  const specs: SliderSpec[] = [
    {
      name: 'Slab',
      min: minSpacing,
      max: Math.max(minSpacing * 2, maxHalf * 2),
      step: 'any',
      value: minSpacing,
      format: (v) => `${Math.round(v)}mm`,
      apply: (v) => {
        for (const { viewport } of activeViewports) viewport.setSlabThickness(v);
      },
    },
    {
      name: 'Blend',
      min: 0,
      max: 3,
      step: 1,
      value: blendMode,
      format: (v) => BLEND_NAMES[v] ?? '',
      apply: (v) => {
        blendMode = v as BlendMode;
        for (const { viewport } of activeViewports) viewport.setBlendMode(blendMode);
      },
    },
  ];

  for (const spec of specs) addSlider(globalControlsEl, spec, markAllDirty);
}

async function streamSlices(
  volume: Volume,
  series: Series,
  onRange: (min: number, max: number) => void,
): Promise<ControlRange | null> {
  let rawMin = Number.POSITIVE_INFINITY;
  let rawMax = Number.NEGATIVE_INFINITY;
  let loaded = 0;
  const scaled = (): [number, number] => {
    const lo = applyRescale(series.rescale, rawMin);
    const hi = applyRescale(series.rescale, rawMax);
    return [Math.min(lo, hi), Math.max(lo, hi)];
  };
  const progress = oncePerFrame(() => {
    setStatus(`Loading slice ${loaded} / ${series.sliceCount}…`);
    onRange(...scaled());
  });
  const load = decodeSeries(series, ({ index, samples, min, max }) => {
    if (min < rawMin) rawMin = min;
    if (max > rawMax) rawMax = max;
    volume.writeSlice(index, samples);
    loaded++;
    progress.request();
  });
  activeLoad = load;
  const completed = await load.done;
  progress.cancel();
  if (!completed) return null;
  const [min, max] = scaled();
  onRange(min, max);
  const center = series.hasTaggedWindow ? series.windowCenter : (min + max) / 2;
  const width = series.hasTaggedWindow ? series.windowWidth : Math.max(1, max - min);
  return { min, max, center, width };
}

async function open(files: File[]): Promise<void> {
  if (files.length === 0) return;
  cancelActiveLoad();

  let parsed = 0;
  const headerProgress = oncePerFrame(() =>
    setStatus(`Reading headers ${parsed} / ${files.length}…`),
  );
  headerProgress.request();
  let series: Series;
  try {
    series = await openSeries(files, (count) => {
      parsed = count;
      headerProgress.request();
    });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Failed to read DICOM files.');
    return;
  } finally {
    headerProgress.cancel();
  }

  let engine;
  try {
    engine = await initRenderingEngine();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Could not start the rendering engine.');
    return;
  }

  applyToolBindings(engine);
  cancelActiveLoad();
  for (const { viewport } of activeViewports) engine.destroyViewport(viewport.id);
  activeViewports = [];
  if (activeVolume) {
    engine.destroyVolume(activeVolume.id);
    activeVolume = null;
  }
  kebabAngle = 0;
  kebabLast = 0;

  const volume = engine.createVolume(series.geometry, series.format, series.rescale);
  activeVolume = volume;
  const [dx, dy, dz] = series.geometry.dims;

  for (const panel of PANELS) {
    const canvas = document.querySelector<HTMLCanvasElement>(`#${panel.id}`)!;
    canvas.parentElement?.querySelector('[data-controls]')?.remove();
    const viewport = engine.createViewport({
      id: panel.id,
      canvas,
      volume,
      orientation: panel.orientation,
    });
    viewport.setWindowLevel({ center: series.windowCenter, width: series.windowWidth });
    viewport.setBlendMode(blendMode);
    viewport.setSegmentationAntialiasing(antialiasEnabled);
    viewport.setDebugView(DEBUG_VIEWS[debugViewIndex]!.view);
    activeViewports.push({
      viewport,
      orientation: panel.orientation,
      baseNormal: viewport.camera.normal,
      baseUp: viewport.camera.up,
    });

    const observer = new ResizeObserver(() => {
      engine.resizeViewport(panel.id);
      viewport.markDirty();
    });
    observer.observe(canvas);
  }
  buildGlobalControls(volume);

  const applyAutoWindow = (min: number, max: number): void => {
    if (series.hasTaggedWindow) return;
    const center = (min + max) / 2;
    const width = Math.max(1, max - min);
    for (const { viewport } of activeViewports) {
      viewport.setWindowLevel({ center, width });
      viewport.markDirty();
    }
  };

  let range: ControlRange | null;
  try {
    range = await streamSlices(volume, series, applyAutoWindow);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Failed to decode DICOM slices.');
    return;
  }
  if (!range) return;
  for (const { viewport } of activeViewports) buildControls(viewport, range);
  setStatus(`${series.description} ${dx}×${dy}×${dz}`);
}

async function addRandomSegments(count: number): Promise<void> {
  if (!activeVolume) {
    setStatus('Open a volume before adding segments.');
    return;
  }
  const frameBudgetMs = 8;
  let added = 0;
  while (added < count) {
    const frameStart = performance.now();
    let last = paintRandomPhantom(activeVolume);
    added++;
    while (added < count && performance.now() - frameStart < frameBudgetMs) {
      last = paintRandomPhantom(activeVolume);
      added++;
    }
    setStatus(
      `Added segment ${last.segment}: ${last.phantom.name}, ${last.radiusMm.toFixed(1)}mm (${added} / ${count})`,
    );
    await nextFrame();
  }
}

function setAntialiasing(enabled: boolean): void {
  antialiasEnabled = enabled;
  antialiasButton.title = `Antialiasing: ${enabled ? 'on' : 'off'}`;
  setActive(antialiasButton, enabled);
  for (const { viewport } of activeViewports) viewport.setSegmentationAntialiasing(enabled);
}

function showDebugView(): void {
  const { view, name, icon } = DEBUG_VIEWS[debugViewIndex]!;
  debugViewButton.title = `Debug: ${name}`;
  setIcon(debugViewButton, icon);
  setActive(debugViewButton, view !== DebugView.None);
}

function cycleDebugView(): void {
  debugViewIndex = (debugViewIndex + 1) % DEBUG_VIEWS.length;
  showDebugView();
  const { view } = DEBUG_VIEWS[debugViewIndex]!;
  for (const { viewport } of activeViewports) viewport.setDebugView(view);
}

function renderTimeFrame(): void {
  for (const { viewport } of activeViewports) {
    const label = document.querySelector<HTMLSpanElement>(`#${viewport.id}-time`);
    if (!label) continue;
    const ms = viewport.renderTimeMs;
    label.textContent = ms === null ? '' : `${ms.toFixed(2)} ms`;
  }
  requestAnimationFrame(renderTimeFrame);
}

function filesFrom(input: HTMLInputElement): File[] {
  return input.files ? [...input.files] : [];
}

folderInput.addEventListener('change', () => void open(filesFrom(folderInput)));
kebabButton.addEventListener('click', () => setKebab(!kebabEnabled));
resetButton.addEventListener('click', resetCameras);
segments50Button.addEventListener('click', () => void addRandomSegments(50));
segments1000Button.addEventListener('click', () => void addRandomSegments(1000));
antialiasButton.addEventListener('click', () => setAntialiasing(!antialiasEnabled));
debugViewButton.addEventListener('click', cycleDebugView);
folderInput.before(createElement(FolderOpen, { class: 'block size-4' }));
setIcon(kebabButton, Orbit);
setIcon(resetButton, RotateCcw);
setIcon(segments50Button, SquarePlus);
setIcon(segments1000Button, CopyPlus);
setIcon(antialiasButton, Spline);
setKebab(false);
setAntialiasing(true);
showDebugView();
buildPrimaryToolButtons();
selectPrimaryTool(primaryToolIndex);
requestAnimationFrame(renderTimeFrame);
