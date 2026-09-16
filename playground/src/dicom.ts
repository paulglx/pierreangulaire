import dicomParser, { type DataSet, type Element } from 'dicom-parser';
import type { Rescale, Vec3, VolumeFormat, VolumeGeometry } from 'pierreangulaire';
import { decodeJpegLossless, decodeRle, type FrameInfo, type PixelSamples } from './decode';

export interface SeriesStream {
  geometry: VolumeGeometry;
  format: VolumeFormat;
  rescale: Rescale;
  windowCenter: number;
  windowWidth: number;
  hasTaggedWindow: boolean;
  description: string;
  sliceCount: number;
  decodeSlice(index: number): PixelSamples | null;
}

interface SliceSource {
  dataSet: DataSet | undefined;
  transferSyntax: string;
}

const RLE_LOSSLESS = '1.2.840.10008.1.2.5';
const JPEG_LOSSLESS = new Set(['1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.70']);
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

function encodedFrameBytes(dataSet: DataSet, pixelData: Element): Uint8Array {
  const fragmentCount = pixelData.fragments?.length ?? 0;
  const bytes = dicomParser.readEncapsulatedPixelDataFromFragments(
    dataSet,
    pixelData,
    0,
    fragmentCount,
  );
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

function readNativeSamples(dataSet: DataSet, pixelData: Element, info: FrameInfo): PixelSamples {
  const count = info.rows * info.columns;
  const bytesPerSample = info.bitsAllocated <= 8 ? 1 : 2;
  const bytes = dataSet.byteArray.slice(
    pixelData.dataOffset,
    pixelData.dataOffset + count * bytesPerSample,
  );
  if (info.bitsAllocated <= 8) {
    return info.signed
      ? new Int8Array(bytes.buffer, bytes.byteOffset, count)
      : new Uint8Array(bytes.buffer, bytes.byteOffset, count);
  }
  return info.signed
    ? new Int16Array(bytes.buffer, bytes.byteOffset, count)
    : new Uint16Array(bytes.buffer, bytes.byteOffset, count);
}

function decodeSamples(
  dataSet: DataSet,
  pixelData: Element,
  transferSyntax: string,
  info: FrameInfo,
): PixelSamples {
  if (transferSyntax === RLE_LOSSLESS) {
    return decodeRle(encodedFrameBytes(dataSet, pixelData), info);
  }
  if (JPEG_LOSSLESS.has(transferSyntax)) {
    return decodeJpegLossless(encodedFrameBytes(dataSet, pixelData), info);
  }
  return readNativeSamples(dataSet, pixelData, info);
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

function alignRescale(raw: PixelSamples, from: Rescale, to: Rescale): PixelSamples {
  if (from.slope === to.slope && from.intercept === to.intercept) return raw;
  const aligned = raw.slice();
  for (let i = 0; i < raw.length; i++) {
    aligned[i] = Math.round((raw[i]! * from.slope + from.intercept - to.intercept) / to.slope);
  }
  return aligned;
}

function readPixelSamples(
  dataSet: DataSet,
  transferSyntax: string,
  rescale: Rescale,
): PixelSamples | null {
  const pixelData = dataSet.elements['x7fe00010'];
  const info = frameInfo(dataSet);
  if (!pixelData || !info) return null;
  if ((dataSet.uint16('x00280002') ?? 1) !== 1) {
    throw new Error('Only single-sample grayscale images are supported.');
  }
  const raw = decodeSamples(dataSet, pixelData, transferSyntax, info);
  return alignRescale(raw, readRescale(dataSet), rescale);
}

function sliceMetadata(dataSet: DataSet): { position: Vec3; transferSyntax: string } | null {
  const transferSyntax = dataSet.string('x00020010') ?? '';
  if (transferSyntax === BIG_ENDIAN) {
    throw new Error('Big-endian DICOM is not supported by this minimal viewer.');
  }
  if (isUnsupportedTransferSyntax(transferSyntax)) {
    throw new Error(
      'This DICOM transfer syntax is not supported. Supported: uncompressed, RLE Lossless, and JPEG Lossless.',
    );
  }
  const rows = dataSet.uint16('x00280010');
  const columns = dataSet.uint16('x00280011');
  const pixelData = dataSet.elements['x7fe00010'];
  const position = vec3From(numbersFromString(dataSet.string('x00200032')), 0);
  if (!pixelData || !rows || !columns || !position) return null;
  if ((dataSet.uint16('x00280002') ?? 1) !== 1) {
    throw new Error('Only single-sample grayscale images are supported.');
  }
  return { position, transferSyntax };
}

function buildGeometry(reference: DataSet, positions: Vec3[], normal: Vec3): VolumeGeometry {
  const columns = reference.uint16('x00280011')!;
  const rows = reference.uint16('x00280010')!;
  const orientation = numbersFromString(reference.string('x00200037'));
  const rowDir = normalize(vec3From(orientation, 0) ?? [1, 0, 0]);
  const columnDir = normalize(vec3From(orientation, 3) ?? [0, 1, 0]);
  const pixelSpacing = numbersFromString(reference.string('x00280030'));
  const rowSpacing = pixelSpacing[0] ?? 1;
  const columnSpacing = pixelSpacing[1] ?? 1;

  const first = positions[0]!;
  let sliceSpacing = reference.floatString('x00180050') ?? 1;
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

export async function openSeries(files: File[]): Promise<SeriesStream> {
  const entries: { source: SliceSource; position: Vec3 }[] = [];
  let reference: DataSet | undefined;

  for (const file of files) {
    let dataSet: DataSet;
    try {
      const buffer = await file.arrayBuffer();
      dataSet = dicomParser.parseDicom(new Uint8Array(buffer));
    } catch {
      continue;
    }
    const meta = sliceMetadata(dataSet);
    if (!meta) continue;
    entries.push({
      source: { dataSet, transferSyntax: meta.transferSyntax },
      position: meta.position,
    });
    reference ??= dataSet;
  }

  if (!reference || entries.length === 0) {
    throw new Error('No readable DICOM image slices were found.');
  }

  const orientation = numbersFromString(reference.string('x00200037'));
  const rowDir = normalize(vec3From(orientation, 0) ?? [1, 0, 0]);
  const columnDir = normalize(vec3From(orientation, 3) ?? [0, 1, 0]);
  const normal = normalize(cross(rowDir, columnDir));

  entries.sort((a, b) => dot(a.position, normal) - dot(b.position, normal));

  const geometry = buildGeometry(
    reference,
    entries.map((entry) => entry.position),
    normal,
  );
  const sources = entries.map((entry) => entry.source);

  const taggedCenter = reference.floatString('x00281050');
  const taggedWidth = reference.floatString('x00281051');
  const hasTaggedWindow =
    taggedCenter !== undefined && taggedWidth !== undefined && taggedWidth > 0;
  const rescale = readRescale(reference);

  return {
    geometry,
    format: volumeFormat(frameInfo(reference)!),
    rescale,
    windowCenter: hasTaggedWindow ? taggedCenter : 0,
    windowWidth: hasTaggedWindow ? taggedWidth : 1,
    hasTaggedWindow,
    description: reference.string('x0008103e') ?? reference.string('x00081030') ?? 'DICOM volume',
    sliceCount: sources.length,
    decodeSlice(index) {
      const source = sources[index];
      if (!source?.dataSet) return null;
      const samples = readPixelSamples(source.dataSet, source.transferSyntax, rescale);
      source.dataSet = undefined;
      return samples;
    },
  };
}
