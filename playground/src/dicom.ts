import dicomParser, { type DataSet, type Element } from 'dicom-parser';
import type { Rescale, Vec3, VolumeFormat, VolumeGeometry } from 'pierreangulaire';
import {
  bytesPerSample,
  type DecodedSlice,
  type FrameInfo,
  JPEG_LOSSLESS,
  RLE_LOSSLESS,
  type SliceRequest,
  type SliceResponse,
  type SliceSource,
} from './decode';

export interface Series {
  geometry: VolumeGeometry;
  format: VolumeFormat;
  rescale: Rescale;
  windowCenter: number;
  windowWidth: number;
  hasTaggedWindow: boolean;
  description: string;
  sliceCount: number;
  sources: SliceSource[];
}

export interface SliceLoad {
  done: Promise<boolean>;
  cancel(): void;
}

interface SliceHeader {
  source: SliceSource;
  position: Vec3;
  orientation: number[];
  pixelSpacing: number[];
  sliceThickness: number | undefined;
  windowCenter: number | undefined;
  windowWidth: number | undefined;
  description: string;
}

const PIXEL_DATA_TAG = 'x7fe00010';
const HEADER_PROBE_BYTES = 64 * 1024;
const HEADER_CONCURRENCY = 16;
const MAX_DECODE_WORKERS = 8;
const REQUESTS_PER_WORKER = 2;
const JPEG_FAMILY_PREFIX = '1.2.840.10008.1.2.4';
const BIG_ENDIAN = '1.2.840.10008.1.2.2';

function isUnsupportedTransferSyntax(transferSyntax: string): boolean {
  if (transferSyntax === RLE_LOSSLESS || JPEG_LOSSLESS.has(transferSyntax)) return false;
  return transferSyntax.startsWith(JPEG_FAMILY_PREFIX);
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length === 0 ? [0, 0, 0] : [a[0] / length, a[1] / length, a[2] / length];
}

function numbersFromString(value: string | undefined): number[] {
  if (!value) return [];
  return value.split('\\').map(Number);
}

function vec3From(values: number[], offset: number): Vec3 | null {
  const x = values[offset];
  const y = values[offset + 1];
  const z = values[offset + 2];
  if (x === undefined || y === undefined || z === undefined) return null;
  if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) return null;
  return [x, y, z];
}

function frameInfo(dataSet: DataSet): FrameInfo | null {
  const rows = dataSet.uint16('x00280010');
  const columns = dataSet.uint16('x00280011');
  if (!rows || !columns) return null;
  return {
    rows,
    columns,
    bitsAllocated: dataSet.uint16('x00280100') ?? 16,
    signed: dataSet.uint16('x00280103') === 1,
  };
}

function volumeFormat(info: FrameInfo): VolumeFormat {
  if (info.bitsAllocated <= 8) return info.signed ? 'int16' : 'uint8';
  return info.signed ? 'int16' : 'uint16';
}

function readRescale(dataSet: DataSet): Rescale {
  return {
    slope: dataSet.floatString('x00281053') ?? 1,
    intercept: dataSet.floatString('x00281052') ?? 0,
  };
}

function pixelByteLength(pixelData: Element, info: FrameInfo, fileSize: number): number {
  if (pixelData.hadUndefinedLength) return fileSize - pixelData.dataOffset;
  return info.rows * info.columns * bytesPerSample(info);
}

async function parseUntilPixelData(blob: Blob): Promise<DataSet | null> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    return dicomParser.parseDicom(bytes, { untilTag: PIXEL_DATA_TAG });
  } catch {
    return null;
  }
}

async function parseHeader(file: File): Promise<DataSet | null> {
  const probe = await parseUntilPixelData(file.slice(0, HEADER_PROBE_BYTES));
  if (probe?.elements[PIXEL_DATA_TAG] || file.size <= HEADER_PROBE_BYTES) return probe;
  return parseUntilPixelData(file);
}

function sliceHeader(file: File, dataSet: DataSet): SliceHeader | null {
  const transferSyntax = dataSet.string('x00020010') ?? '';
  if (transferSyntax === BIG_ENDIAN) {
    throw new Error('Big-endian DICOM is not supported by this minimal viewer.');
  }
  if (isUnsupportedTransferSyntax(transferSyntax)) {
    throw new Error(
      'This DICOM transfer syntax is not supported. Supported: uncompressed, RLE Lossless, and JPEG Lossless.',
    );
  }
  const info = frameInfo(dataSet);
  const pixelData = dataSet.elements[PIXEL_DATA_TAG];
  const position = vec3From(numbersFromString(dataSet.string('x00200032')), 0);
  if (!pixelData || !info || !position) return null;
  if ((dataSet.uint16('x00280002') ?? 1) !== 1) {
    throw new Error('Only single-sample grayscale images are supported.');
  }
  return {
    source: {
      file,
      byteOffset: pixelData.dataOffset,
      byteLength: pixelByteLength(pixelData, info, file.size),
      transferSyntax,
      info,
      rescale: readRescale(dataSet),
    },
    position,
    orientation: numbersFromString(dataSet.string('x00200037')),
    pixelSpacing: numbersFromString(dataSet.string('x00280030')),
    sliceThickness: dataSet.floatString('x00180050'),
    windowCenter: dataSet.floatString('x00281050'),
    windowWidth: dataSet.floatString('x00281051'),
    description: dataSet.string('x0008103e') ?? dataSet.string('x00081030') ?? 'DICOM volume',
  };
}

function buildGeometry(reference: SliceHeader, positions: Vec3[], normal: Vec3): VolumeGeometry {
  const { columns, rows } = reference.source.info;
  const rowDir = normalize(vec3From(reference.orientation, 0) ?? [1, 0, 0]);
  const columnDir = normalize(vec3From(reference.orientation, 3) ?? [0, 1, 0]);
  const rowSpacing = reference.pixelSpacing[0] ?? 1;
  const columnSpacing = reference.pixelSpacing[1] ?? 1;

  const first = positions[0]!;
  let sliceSpacing = reference.sliceThickness ?? 1;
  if (positions.length > 1) {
    const projectionGap = dot(positions[1]!, normal) - dot(first, normal);
    if (Math.abs(projectionGap) > 1e-4) sliceSpacing = Math.abs(projectionGap);
  }

  return {
    dims: [columns, rows, positions.length],
    spacing: [columnSpacing, rowSpacing, sliceSpacing],
    origin: first,
    direction: [rowDir, columnDir, normal],
  };
}

async function forEachConcurrent<T>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await task(items[index]!, index);
    }
  });
  await Promise.all(lanes);
}

export async function openSeries(
  files: File[],
  onProgress: (parsed: number) => void,
): Promise<Series> {
  const headers: (SliceHeader | null)[] = files.map(() => null);
  let parsed = 0;
  await forEachConcurrent(files, HEADER_CONCURRENCY, async (file, index) => {
    const dataSet = await parseHeader(file);
    parsed++;
    onProgress(parsed);
    if (dataSet) headers[index] = sliceHeader(file, dataSet);
  });

  const slices = headers.filter((header): header is SliceHeader => header !== null);
  const reference = slices[0];
  if (!reference) throw new Error('No readable DICOM image slices were found.');

  const rowDir = normalize(vec3From(reference.orientation, 0) ?? [1, 0, 0]);
  const columnDir = normalize(vec3From(reference.orientation, 3) ?? [0, 1, 0]);
  const normal = normalize(cross(rowDir, columnDir));
  slices.sort((a, b) => dot(a.position, normal) - dot(b.position, normal));

  const hasTaggedWindow =
    reference.windowCenter !== undefined &&
    reference.windowWidth !== undefined &&
    reference.windowWidth > 0;

  return {
    geometry: buildGeometry(
      reference,
      slices.map((slice) => slice.position),
      normal,
    ),
    format: volumeFormat(reference.source.info),
    rescale: reference.source.rescale,
    windowCenter: hasTaggedWindow ? reference.windowCenter! : 0,
    windowWidth: hasTaggedWindow ? reference.windowWidth! : 1,
    hasTaggedWindow,
    description: reference.description,
    sliceCount: slices.length,
    sources: slices.map((slice) => slice.source),
  };
}

export function decodeSeries(series: Series, onSlice: (slice: DecodedSlice) => void): SliceLoad {
  const workerCount = Math.max(
    1,
    Math.min(navigator.hardwareConcurrency || 4, MAX_DECODE_WORKERS, series.sliceCount),
  );
  const workers = Array.from(
    { length: workerCount },
    () => new Worker(new URL('./decode-worker.ts', import.meta.url), { type: 'module' }),
  );
  let cancel = (): void => {};

  const done = new Promise<boolean>((resolve, reject) => {
    let next = 0;
    let finished = 0;
    let settled = false;

    const settle = (): void => {
      settled = true;
      for (const worker of workers) worker.terminate();
    };
    const fail = (message: string): void => {
      if (settled) return;
      settle();
      reject(new Error(message));
    };
    const dispatch = (worker: Worker): void => {
      if (next >= series.sliceCount) return;
      const index = next++;
      const request: SliceRequest = {
        ...series.sources[index]!,
        index,
        targetRescale: series.rescale,
      };
      worker.postMessage(request);
    };

    for (const worker of workers) {
      worker.addEventListener('message', (event: MessageEvent<SliceResponse>) => {
        if (settled) return;
        const response = event.data;
        if (response.kind === 'error') {
          fail(response.message);
          return;
        }
        onSlice(response);
        finished++;
        if (finished === series.sliceCount) {
          settle();
          resolve(true);
          return;
        }
        dispatch(worker);
      });
      worker.addEventListener('error', (event) => fail(event.message || 'Slice decoding failed.'));
      for (let i = 0; i < REQUESTS_PER_WORKER; i++) dispatch(worker);
    }

    cancel = () => {
      if (settled) return;
      settle();
      resolve(false);
    };
  });

  return { done, cancel: () => cancel() };
}
