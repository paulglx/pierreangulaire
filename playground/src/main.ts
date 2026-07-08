import {
  BlendMode,
  indexToWorld,
  initRenderingEngine,
  type Orientation,
  type Vec3,
  type Viewport,
  type Volume,
  volumeCenter,
  worldExtent,
} from 'pierreangulaire';
import { openSeries, type SeriesStream } from './dicom';
import './style.css';

const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const folderInput = document.querySelector<HTMLInputElement>('#folder')!;
const kebabButton = document.querySelector<HTMLButtonElement>('#kebab')!;
const globalControlsEl = document.querySelector<HTMLDivElement>('#global-controls')!;
const resetButton = document.querySelector<HTMLButtonElement>('#reset')!;
const sphereButton = document.querySelector<HTMLButtonElement>('#sphere')!;
const antialiasButton = document.querySelector<HTMLButtonElement>('#antialiasing')!;
const debugBlocksButton = document.querySelector<HTMLButtonElement>('#debug-blocks')!;

const KEBAB_RAD_PER_SEC = (2 * Math.PI) / 24;

const PANELS: { id: string; orientation: Orientation }[] = [
  { id: 'axial', orientation: 'axial' },
  { id: 'coronal', orientation: 'coronal' },
  { id: 'sagittal', orientation: 'sagittal' },
];

const BLEND_NAMES = ['MIP', 'MinIP', 'Average', 'Composite'];

interface ActiveViewport {
  viewport: Viewport;
  orientation: Orientation;
  baseNormal: Vec3;
  baseUp: Vec3;
}

let activeViewports: ActiveViewport[] = [];
let activeVolume: Volume | null = null;
let antialiasEnabled = true;
let debugBlocksEnabled = false;
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
  syncResetButton();
  kebabRaf = requestAnimationFrame(kebabFrame);
}

function setKebab(enabled: boolean): void {
  kebabEnabled = enabled;
  kebabButton.textContent = `Kebab mode: ${enabled ? 'on' : 'off'}`;
  kebabButton.classList.toggle('text-stone-50', enabled);
  kebabButton.classList.toggle('text-stone-400', !enabled);
  if (enabled) {
    kebabLast = 0;
    kebabRaf = requestAnimationFrame(kebabFrame);
  } else {
    cancelAnimationFrame(kebabRaf);
  }
}

function vec3Near(a: Vec3, b: Vec3): boolean {
  return (
    Math.abs(a[0] - b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4 && Math.abs(a[2] - b[2]) < 1e-4
  );
}

function orientationAligned({ viewport, baseNormal, baseUp }: ActiveViewport): boolean {
  const { normal, up } = viewport.camera;
  return vec3Near(normal, baseNormal) && vec3Near(up, baseUp);
}

function syncResetButton(): void {
  const misaligned = activeViewports.some((entry) => !orientationAligned(entry));
  resetButton.classList.toggle('hidden', !misaligned);
}

function resetOrientation(): void {
  setKebab(false);
  const misaligned = activeViewports.filter((entry) => !orientationAligned(entry));
  for (const entry of misaligned) {
    entry.viewport.camera.normal = entry.baseNormal;
    entry.viewport.camera.up = entry.baseUp;
    entry.viewport.markDirty();
  }
  if (misaligned.length > 0) {
    setStatus(`Reset orientation — ${misaligned.map((entry) => entry.orientation).join(', ')}.`);
  }
  syncResetButton();
}

function setStatus(message: string): void {
  statusEl.textContent = message;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
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

function projectionScale(volume: Volume, direction: Vec3, factor: number): number {
  const { dims, spacing, direction: axes } = volume.geometry;
  let total = 0;
  for (let axis = 0; axis < 3; axis++) {
    const column = axes[axis] as Vec3;
    total +=
      Math.abs(dotVec(column, direction)) *
      (dims[axis] as number) ** factor *
      (spacing[axis] as number);
  }
  return total;
}

function spacingAlongNormal(volume: Volume, normal: Vec3): number {
  return projectionScale(volume, normal, 0);
}

function halfExtentAlong(volume: Volume, normal: Vec3): number {
  return 0.5 * projectionScale(volume, normal, 1);
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

function buildControls(viewport: Viewport, volume: Volume, range: ControlRange): void {
  const panel = viewport.canvas.parentElement!;
  panel.querySelector('[data-controls]')?.remove();
  const controls = document.createElement('div');
  controls.dataset.controls = '';
  controls.className = 'absolute bottom-2.5 left-2.5 flex flex-col gap-1 text-shadow-sm';

  const center = volumeCenter(volume.geometry);
  const normal = viewport.camera.normal;
  const step = spacingAlongNormal(volume, normal) || 1;
  const half = halfExtentAlong(volume, normal);
  const fitZoom = viewport.camera.zoom;
  const sliceBase = (dotVec(center, normal) - dotVec(volume.geometry.origin, normal)) / step;

  const specs: SliderSpec[] = [
    {
      name: 'Slice',
      min: -half,
      max: half,
      step,
      value: 0,
      format: (v) => String(Math.round(sliceBase + v / step)),
      apply: (v) => {
        viewport.camera.focalPoint = [
          center[0] + normal[0] * v,
          center[1] + normal[1] * v,
          center[2] + normal[2] * v,
        ];
      },
    },
    {
      name: 'Zoom',
      min: fitZoom * 0.1,
      max: fitZoom * 1.3,
      step: 'any',
      value: fitZoom,
      format: (v) => `${Math.round((fitZoom / v) * 100)}%`,
      apply: (v) => {
        viewport.camera.zoom = v;
      },
    },
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
  series: SeriesStream,
  onRange: (min: number, max: number) => void,
): Promise<ControlRange> {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < series.sliceCount; k++) {
    const slice = series.decodeSlice(k);
    if (!slice) continue;
    for (let i = 0; i < slice.length; i++) {
      const value = slice[i]!;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    volume.writeSlice(k, slice);
    if (k % 8 === 0) {
      setStatus(`Loading slice ${k + 1} / ${series.sliceCount}…`);
      onRange(min, max);
      await nextFrame();
    }
  }
  onRange(min, max);
  const center = series.hasTaggedWindow ? series.windowCenter : (min + max) / 2;
  const width = series.hasTaggedWindow ? series.windowWidth : Math.max(1, max - min);
  return { min, max, center, width };
}

async function open(files: File[]): Promise<void> {
  if (files.length === 0) return;
  setStatus(`Reading ${files.length} files…`);

  let series: SeriesStream;
  try {
    series = await openSeries(files);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Failed to read DICOM files.');
    return;
  }

  let engine;
  try {
    engine = await initRenderingEngine();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Could not start the rendering engine.');
    return;
  }

  for (const { viewport } of activeViewports) engine.destroyViewport(viewport.id);
  activeViewports = [];
  if (activeVolume) {
    engine.destroyVolume(activeVolume.id);
    activeVolume = null;
  }
  kebabAngle = 0;
  kebabLast = 0;

  const volume = engine.createVolume(series.geometry, series.format);
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
    viewport.setDebugEmptyBlocks(debugBlocksEnabled);
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
  syncResetButton();
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

  const range = await streamSlices(volume, series, applyAutoWindow);
  for (const { viewport } of activeViewports) buildControls(viewport, volume, range);
  setStatus(`${series.description} — ${dx}×${dy}×${dz}`);
}

function paintRandomSphere(volume: Volume): { segment: number; radius: number } {
  const segmentation = volume.segmentation;
  const segment = Math.min(255, (segmentation.segmentsPresent().at(-1) ?? 0) + 1);
  const { dims } = volume.geometry;
  const center = indexToWorld(volume.geometry, [
    dims[0] * (0.2 + Math.random() * 0.6),
    dims[1] * (0.2 + Math.random() * 0.6),
    dims[2] * (0.2 + Math.random() * 0.6),
  ]);
  const radius = Math.min(...worldExtent(volume.geometry)) * (0.05 + Math.random() * 0.1);
  segmentation.paintSphere(center, radius, segment);
  return { segment, radius };
}

async function addSphereSegments(): Promise<void> {
  if (!activeVolume) {
    setStatus('Open a volume before adding segments.');
    return;
  }
  const count = 50;
  for (let i = 0; i < count; i++) {
    const { segment, radius } = paintRandomSphere(activeVolume);
    setStatus(`Added segment ${segment} — sphere r=${radius.toFixed(1)}mm (${i + 1} / ${count})`);
    await nextFrame();
  }
}

function setAntialiasing(enabled: boolean): void {
  antialiasEnabled = enabled;
  antialiasButton.textContent = `Antialiasing: ${enabled ? 'on' : 'off'}`;
  antialiasButton.classList.toggle('text-stone-50', enabled);
  antialiasButton.classList.toggle('text-stone-400', !enabled);
  for (const { viewport } of activeViewports) viewport.setSegmentationAntialiasing(enabled);
}

function setDebugBlocks(enabled: boolean): void {
  debugBlocksEnabled = enabled;
  debugBlocksButton.textContent = `Empty blocks: ${enabled ? 'on' : 'off'}`;
  debugBlocksButton.classList.toggle('text-stone-50', enabled);
  debugBlocksButton.classList.toggle('text-stone-400', !enabled);
  for (const { viewport } of activeViewports) viewport.setDebugEmptyBlocks(enabled);
}

function filesFrom(input: HTMLInputElement): File[] {
  return input.files ? [...input.files] : [];
}

folderInput.addEventListener('change', () => void open(filesFrom(folderInput)));
kebabButton.addEventListener('click', () => setKebab(!kebabEnabled));
resetButton.addEventListener('click', resetOrientation);
sphereButton.addEventListener('click', () => void addSphereSegments());
antialiasButton.addEventListener('click', () => setAntialiasing(!antialiasEnabled));
debugBlocksButton.addEventListener('click', () => setDebugBlocks(!debugBlocksEnabled));
