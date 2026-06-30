import dicomParser, { type DataSet } from 'dicom-parser';
import type { Vec3, VolumeFormat, VolumeGeometry } from 'pierreangulaire';

export interface LoadedSeries {
  geometry: VolumeGeometry;
  format: VolumeFormat;
  slices: Float32Array[];
  windowCenter: number;
  windowWidth: number;
  min: number;
  max: number;
  description: string;
}

interface ParsedSlice {
  position: Vec3;
  values: Float32Array;
}

const COMPRESSED_PREFIXES = ['1.2.840.10008.1.2.4', '1.2.840.10008.1.2.5'];
const BIG_ENDIAN = '1.2.840.10008.1.2.2';

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

function readPixelValues(dataSet: DataSet): Float32Array | null {
  const pixelData = dataSet.elements['x7fe00010'];
  const rows = dataSet.uint16('x00280010');
  const columns = dataSet.uint16('x00280011');
  const bitsAllocated = dataSet.uint16('x00280100') ?? 16;
  const signed = dataSet.uint16('x00280103') === 1;
  if (!pixelData || !rows || !columns) return null;

  const slope = dataSet.floatString('x00281053') ?? 1;
  const intercept = dataSet.floatString('x00281052') ?? 0;
  const count = rows * columns;
  const bytes = dataSet.byteArray.slice(
    pixelData.dataOffset,
    pixelData.dataOffset + count * (bitsAllocated / 8),
  );

  let raw: Int16Array | Uint16Array | Uint8Array;
  if (bitsAllocated === 8) {
    raw = bytes;
  } else if (signed) {
    raw = new Int16Array(bytes.buffer, 0, count);
  } else {
    raw = new Uint16Array(bytes.buffer, 0, count);
  }

  const values = new Float32Array(count);
  for (let i = 0; i < count; i++) values[i] = raw[i]! * slope + intercept;
  return values;
}

function parseSlice(dataSet: DataSet): ParsedSlice | null {
  const transferSyntax = dataSet.string('x00020010') ?? '';
  if (COMPRESSED_PREFIXES.some((prefix) => transferSyntax.startsWith(prefix))) {
    throw new Error('Compressed DICOM is not supported by this minimal viewer.');
  }
  if (transferSyntax === BIG_ENDIAN) {
    throw new Error('Big-endian DICOM is not supported by this minimal viewer.');
  }
  const position = vec3From(numbersFromString(dataSet.string('x00200032')), 0);
  const values = readPixelValues(dataSet);
  if (!position || !values) return null;
  return { position, values };
}

function buildGeometry(reference: DataSet, sorted: ParsedSlice[], normal: Vec3): VolumeGeometry {
  const columns = reference.uint16('x00280011')!;
  const rows = reference.uint16('x00280010')!;
  const orientation = numbersFromString(reference.string('x00200037'));
  const rowDir = normalize(vec3From(orientation, 0) ?? [1, 0, 0]);
  const columnDir = normalize(vec3From(orientation, 3) ?? [0, 1, 0]);
  const pixelSpacing = numbersFromString(reference.string('x00280030'));
  const rowSpacing = pixelSpacing[0] ?? 1;
  const columnSpacing = pixelSpacing[1] ?? 1;

  const first = sorted[0]!.position;
  let sliceSpacing = reference.floatString('x00180050') ?? 1;
  if (sorted.length > 1) {
    const projectionGap = dot(sorted[1]!.position, normal) - dot(first, normal);
    if (Math.abs(projectionGap) > 1e-4) sliceSpacing = Math.abs(projectionGap);
  }

  return {
    dims: [columns, rows, sorted.length],
    spacing: [columnSpacing, rowSpacing, sliceSpacing],
    origin: first,
    direction: [rowDir, columnDir, normal],
  };
}

function dataRange(slices: Float32Array[]): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const slice of slices) {
    for (let i = 0; i < slice.length; i++) {
      const value = slice[i]!;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  return { min, max };
}

export async function loadSeries(files: File[]): Promise<LoadedSeries> {
  const parsed: ParsedSlice[] = [];
  let reference: DataSet | undefined;

  for (const file of files) {
    let dataSet: DataSet;
    try {
      const buffer = await file.arrayBuffer();
      dataSet = dicomParser.parseDicom(new Uint8Array(buffer));
    } catch {
      continue;
    }
    const slice = parseSlice(dataSet);
    if (!slice) continue;
    parsed.push(slice);
    reference ??= dataSet;
  }

  if (!reference || parsed.length === 0) {
    throw new Error('No readable DICOM image slices were found.');
  }

  const orientation = numbersFromString(reference.string('x00200037'));
  const rowDir = normalize(vec3From(orientation, 0) ?? [1, 0, 0]);
  const columnDir = normalize(vec3From(orientation, 3) ?? [0, 1, 0]);
  const normal = normalize(cross(rowDir, columnDir));

  parsed.sort((a, b) => dot(a.position, normal) - dot(b.position, normal));

  const geometry = buildGeometry(reference, parsed, normal);
  const slices = parsed.map((slice) => slice.values);
  const range = dataRange(slices);

  const taggedCenter = reference.floatString('x00281050');
  const taggedWidth = reference.floatString('x00281051');
  const hasTaggedWindow =
    taggedCenter !== undefined && taggedWidth !== undefined && taggedWidth > 0;

  return {
    geometry,
    format: 'float32',
    slices,
    windowCenter: hasTaggedWindow ? taggedCenter : (range.min + range.max) / 2,
    windowWidth: hasTaggedWindow ? taggedWidth : Math.max(1, range.max - range.min),
    min: range.min,
    max: range.max,
    description: reference.string('x0008103e') ?? reference.string('x00081030') ?? 'DICOM volume',
  };
}
