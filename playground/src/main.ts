import {
  type BlendMode,
  initRenderingEngine,
  type Orientation,
  type Vec3,
  type Viewport,
  type Volume,
  volumeCenter,
} from 'pierreangulaire';
import { type LoadedSeries, loadSeries } from './dicom';

const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const folderInput = document.querySelector<HTMLInputElement>('#folder')!;
const filesInput = document.querySelector<HTMLInputElement>('#files')!;

const PANELS: { id: string; orientation: Orientation }[] = [
  { id: 'axial', orientation: 'axial' },
  { id: 'coronal', orientation: 'coronal' },
  { id: 'sagittal', orientation: 'sagittal' },
];

const BLEND_NAMES = ['MIP', 'MinIP', 'Average', 'Composite'];

let activeViewportIds: string[] = [];

function setStatus(message: string): void {
  statusEl.textContent = message;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function dotVec(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
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

function addSlider(controls: HTMLElement, viewport: Viewport, spec: SliderSpec): void {
  const label = document.createElement('label');

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = spec.name;

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  input.value = String(spec.value);

  const value = document.createElement('span');
  value.className = 'val';
  value.textContent = spec.format(spec.value);

  input.addEventListener('input', () => {
    const next = Number(input.value);
    spec.apply(next);
    value.textContent = spec.format(next);
    viewport.markDirty();
  });

  label.append(name, input, value);
  controls.append(label);
}

function buildControls(viewport: Viewport, volume: Volume, series: LoadedSeries): void {
  const panel = viewport.canvas.parentElement!;
  panel.querySelector('.controls')?.remove();
  const controls = document.createElement('div');
  controls.className = 'controls';

  const center = volumeCenter(volume.geometry);
  const normal = viewport.camera.normal;
  const step = spacingAlongNormal(volume, normal) || 1;
  const half = halfExtentAlong(volume, normal);
  const fitZoom = viewport.camera.zoom;
  const minSpacing = Math.min(...volume.geometry.spacing);
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
      min: series.min,
      max: series.max,
      step: 1,
      value: series.windowCenter,
      format: (v) => String(Math.round(v)),
      apply: (v) => viewport.setWindowLevel({ center: v, width: viewport.windowLevel.width }),
    },
    {
      name: 'Window',
      min: 1,
      max: Math.max(2, series.max - series.min),
      step: 1,
      value: series.windowWidth,
      format: (v) => String(Math.round(v)),
      apply: (v) => viewport.setWindowLevel({ center: viewport.windowLevel.center, width: v }),
    },
    {
      name: 'Slab',
      min: minSpacing,
      max: Math.max(minSpacing * 2, half * 2),
      step: 'any',
      value: viewport.slabThickness,
      format: (v) => `${Math.round(v)}mm`,
      apply: (v) => viewport.setSlabThickness(v),
    },
    {
      name: 'Blend',
      min: 0,
      max: 3,
      step: 1,
      value: viewport.blendMode,
      format: (v) => BLEND_NAMES[v] ?? '',
      apply: (v) => viewport.setBlendMode(v as BlendMode),
    },
  ];

  for (const spec of specs) addSlider(controls, viewport, spec);
  panel.append(controls);
}

async function streamSlices(volume: Volume, slices: Float32Array[]): Promise<void> {
  for (let k = 0; k < slices.length; k++) {
    volume.writeSlice(k, slices[k]!);
    if (k % 8 === 0) {
      setStatus(`Loading slice ${k + 1} / ${slices.length}…`);
      await nextFrame();
    }
  }
}

async function open(files: File[]): Promise<void> {
  if (files.length === 0) return;
  setStatus(`Reading ${files.length} files…`);

  let series: LoadedSeries;
  try {
    series = await loadSeries(files);
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

  for (const id of activeViewportIds) engine.destroyViewport(id);
  activeViewportIds = [];

  const volume = engine.createVolume(series.geometry, series.format);
  const [dx, dy, dz] = series.geometry.dims;

  for (const panel of PANELS) {
    const canvas = document.querySelector<HTMLCanvasElement>(`#${panel.id}`)!;
    const viewport = engine.createViewport({
      id: panel.id,
      canvas,
      volume,
      orientation: panel.orientation,
    });
    viewport.setWindowLevel({ center: series.windowCenter, width: series.windowWidth });
    buildControls(viewport, volume, series);
    activeViewportIds.push(panel.id);

    const observer = new ResizeObserver(() => {
      engine.resizeViewport(panel.id);
      viewport.markDirty();
    });
    observer.observe(canvas);
  }

  await streamSlices(volume, series.slices);
  setStatus(`${series.description} — ${dx}×${dy}×${dz}`);
}

function filesFrom(input: HTMLInputElement): File[] {
  return input.files ? [...input.files] : [];
}

folderInput.addEventListener('change', () => void open(filesFrom(folderInput)));
filesInput.addEventListener('change', () => void open(filesFrom(filesInput)));
