export interface FrameInfo {
  rows: number;
  columns: number;
  bitsAllocated: number;
  signed: boolean;
}

export type PixelSamples = Uint8Array | Int8Array | Uint16Array | Int16Array;

function allocSamples(info: FrameInfo, length: number): PixelSamples {
  if (info.bitsAllocated <= 8) {
    return info.signed ? new Int8Array(length) : new Uint8Array(length);
  }
  return info.signed ? new Int16Array(length) : new Uint16Array(length);
}

function unpackBits(src: Uint8Array, start: number, end: number, outLength: number): Uint8Array {
  const out = new Uint8Array(outLength);
  let read = start;
  let written = 0;
  while (written < outLength && read < end) {
    const control = src[read++]!;
    if (control < 128) {
      for (let n = 0; n <= control && written < outLength && read < end; n++) {
        out[written++] = src[read++]!;
      }
    } else if (control > 128) {
      const value = src[read++]!;
      for (let n = 0; n < 257 - control && written < outLength; n++) {
        out[written++] = value;
      }
    }
  }
  return out;
}

export function decodeRle(encoded: Uint8Array, info: FrameInfo): PixelSamples {
  if (encoded.length < 64) throw new Error('RLE data is too short to contain a header.');
  const header = new DataView(encoded.buffer, encoded.byteOffset, 64);
  const segmentCount = header.getUint32(0, true);
  const pixelCount = info.rows * info.columns;
  const bytesPerSample = info.bitsAllocated <= 8 ? 1 : 2;

  const planes: Uint8Array[] = [];
  for (let segment = 0; segment < bytesPerSample; segment++) {
    const start = header.getUint32((segment + 1) * 4, true);
    const end =
      segment + 1 < segmentCount ? header.getUint32((segment + 2) * 4, true) : encoded.length;
    planes.push(unpackBits(encoded, start, end, pixelCount));
  }

  const out = allocSamples(info, pixelCount);
  if (bytesPerSample === 1) {
    out.set(planes[0]!);
  } else {
    const high = planes[0]!;
    const low = planes[1]!;
    for (let i = 0; i < pixelCount; i++) out[i] = (high[i]! << 8) | low[i]!;
  }
  return out;
}

interface HuffmanTable {
  maxCode: Int32Array;
  minCode: Int32Array;
  valuePointer: Int32Array;
  values: number[];
}

function buildHuffmanTable(counts: number[], values: number[]): HuffmanTable {
  const sizes: number[] = [];
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < counts[length]!; i++) sizes.push(length);
  }

  const codes: number[] = [];
  let code = 0;
  let k = 0;
  if (sizes.length > 0) {
    let size = sizes[0]!;
    while (k < sizes.length) {
      while (k < sizes.length && sizes[k] === size) {
        codes.push(code);
        code++;
        k++;
      }
      code <<= 1;
      size++;
    }
  }

  const maxCode = new Int32Array(17).fill(-1);
  const minCode = new Int32Array(17);
  const valuePointer = new Int32Array(17);
  let offset = 0;
  for (let length = 1; length <= 16; length++) {
    if (counts[length]! > 0) {
      valuePointer[length] = offset;
      minCode[length] = codes[offset]!;
      offset += counts[length]!;
      maxCode[length] = codes[offset - 1]!;
    }
  }
  return { maxCode, minCode, valuePointer, values };
}

function parseHuffmanTables(
  data: Uint8Array,
  start: number,
  end: number,
  tables: Map<number, HuffmanTable>,
): void {
  let pos = start;
  while (pos < end) {
    const id = data[pos++]! & 0x0f;
    const counts: number[] = Array.from({ length: 17 }, () => 0);
    let total = 0;
    for (let length = 1; length <= 16; length++) {
      counts[length] = data[pos++]!;
      total += counts[length]!;
    }
    const values: number[] = [];
    for (let i = 0; i < total; i++) values.push(data[pos++]!);
    tables.set(id, buildHuffmanTable(counts, values));
  }
}

class JpegBitReader {
  private readonly data: Uint8Array;
  private pos: number;
  private bitBuffer = 0;
  private bitCount = 0;

  constructor(data: Uint8Array, start: number) {
    this.data = data;
    this.pos = start;
  }

  private fill(): void {
    if (this.pos >= this.data.length) {
      this.bitBuffer = 0;
      this.bitCount = 8;
      return;
    }
    const byte = this.data[this.pos++]!;
    if (byte === 0xff) {
      const next = this.data[this.pos] ?? 0xd9;
      if (next === 0x00) {
        this.pos++;
      } else {
        this.pos--;
        this.bitBuffer = 0;
        this.bitCount = 8;
        return;
      }
    }
    this.bitBuffer = byte;
    this.bitCount = 8;
  }

  bit(): number {
    if (this.bitCount === 0) this.fill();
    this.bitCount--;
    return (this.bitBuffer >> this.bitCount) & 1;
  }

  receive(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) value = (value << 1) | this.bit();
    return value;
  }

  restart(): void {
    this.bitCount = 0;
    this.bitBuffer = 0;
    while (
      this.pos + 1 < this.data.length &&
      !(
        this.data[this.pos] === 0xff &&
        this.data[this.pos + 1]! >= 0xd0 &&
        this.data[this.pos + 1]! <= 0xd7
      )
    ) {
      this.pos++;
    }
    this.pos += 2;
  }
}

function decodeHuffman(reader: JpegBitReader, table: HuffmanTable): number {
  let code = reader.bit();
  let length = 1;
  while (length < 16 && code > table.maxCode[length]!) {
    code = (code << 1) | reader.bit();
    length++;
  }
  return table.values[table.valuePointer[length]! + code - table.minCode[length]!] ?? 0;
}

function receiveAndExtend(reader: JpegBitReader, magnitude: number): number {
  if (magnitude === 0) return 0;
  if (magnitude === 16) return 32768;
  const value = reader.receive(magnitude);
  return value < 1 << (magnitude - 1) ? value - (1 << magnitude) + 1 : value;
}

function predict(selection: number, left: number, above: number, aboveLeft: number): number {
  switch (selection) {
    case 1:
      return left;
    case 2:
      return above;
    case 3:
      return aboveLeft;
    case 4:
      return left + above - aboveLeft;
    case 5:
      return left + ((above - aboveLeft) >> 1);
    case 6:
      return above + ((left - aboveLeft) >> 1);
    case 7:
      return (left + above) >> 1;
    default:
      return left;
  }
}

export function decodeJpegLossless(encoded: Uint8Array, info: FrameInfo): PixelSamples {
  let pos = 0;
  const read16 = (): number => {
    const value = (encoded[pos]! << 8) | encoded[pos + 1]!;
    pos += 2;
    return value;
  };

  if (read16() !== 0xffd8) throw new Error('Not a JPEG stream (missing SOI marker).');

  let precision = 0;
  let width = 0;
  let height = 0;
  let componentCount = 0;
  let restartInterval = 0;
  let predictor = 1;
  let pointTransform = 0;
  let tableId = 0;
  let scanStart = -1;
  const tables = new Map<number, HuffmanTable>();

  while (pos + 1 < encoded.length && scanStart < 0) {
    if (encoded[pos] !== 0xff) {
      pos++;
      continue;
    }
    const marker = encoded[pos + 1]!;
    pos += 2;
    if (marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

    const segmentEnd = pos + read16();
    if (marker === 0xc3) {
      precision = encoded[pos]!;
      height = (encoded[pos + 1]! << 8) | encoded[pos + 2]!;
      width = (encoded[pos + 3]! << 8) | encoded[pos + 4]!;
      componentCount = encoded[pos + 5]!;
    } else if (marker === 0xc4) {
      parseHuffmanTables(encoded, pos, segmentEnd, tables);
    } else if (marker === 0xdd) {
      restartInterval = (encoded[pos]! << 8) | encoded[pos + 1]!;
    } else if (marker === 0xda) {
      const scanComponents = encoded[pos]!;
      tableId = encoded[pos + 2]! >> 4;
      const afterComponents = pos + 1 + scanComponents * 2;
      predictor = encoded[afterComponents]!;
      pointTransform = encoded[afterComponents + 2]! & 0x0f;
      scanStart = segmentEnd;
      break;
    }
    pos = segmentEnd;
  }

  if (componentCount !== 1) {
    throw new Error('Only single-component (grayscale) JPEG Lossless is supported.');
  }
  const table = tables.get(tableId);
  if (!table) throw new Error('JPEG Lossless stream is missing its Huffman table.');
  if (scanStart < 0 || width === 0 || height === 0) {
    throw new Error('JPEG Lossless stream is missing scan data.');
  }

  const reader = new JpegBitReader(encoded, scanStart);
  const reconstructed = new Int32Array(width * height);
  const defaultPrediction = 1 << (precision - pointTransform - 1);
  let useDefault = true;
  let mcu = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (restartInterval > 0 && mcu > 0 && mcu % restartInterval === 0) {
        reader.restart();
        useDefault = true;
      }
      const index = y * width + x;
      let prediction: number;
      if (useDefault) {
        prediction = defaultPrediction;
      } else if (x === 0) {
        prediction = reconstructed[index - width]!;
      } else if (y === 0) {
        prediction = reconstructed[index - 1]!;
      } else {
        prediction = predict(
          predictor,
          reconstructed[index - 1]!,
          reconstructed[index - width]!,
          reconstructed[index - width - 1]!,
        );
      }
      useDefault = false;

      const magnitude = decodeHuffman(reader, table);
      const difference = receiveAndExtend(reader, magnitude);
      reconstructed[index] = (prediction + difference) & 0xffff;
      mcu++;
    }
  }

  const out = allocSamples(info, width * height);
  for (let i = 0; i < out.length; i++) out[i] = reconstructed[i]! << pointTransform;
  return out;
}
