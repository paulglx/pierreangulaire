import type { VolumeFormat } from '../geometry';
import type { Vec3 } from '../math';

export type TexelType = 'f32' | 'i32' | 'u32';

const SLOT_COORD_BITS = 10;
const SLOT_COORD_MASK = (1 << SLOT_COORD_BITS) - 1;
export const MAX_SLOTS_PER_AXIS = 1 << SLOT_COORD_BITS;

export interface SlotCoord {
  x: number;
  y: number;
  z: number;
}

export function atlasSide(slotCount: number): number {
  let side = Math.ceil(Math.cbrt(slotCount));
  while (side > 0 && (side - 1) ** 3 >= slotCount) side--;
  while (side ** 3 < slotCount) side++;
  return side;
}

export function slotCoord(slot: number): SlotCoord {
  const shell = atlasSide(slot + 1) - 1;
  const side = shell + 1;
  let offset = slot - shell ** 3;
  if (offset < side * side) {
    return { x: offset % side, y: Math.floor(offset / side), z: shell };
  }
  offset -= side * side;
  if (offset < side * shell) {
    return { x: offset % side, y: shell, z: Math.floor(offset / side) };
  }
  offset -= side * shell;
  return { x: shell, y: offset % shell, z: Math.floor(offset / shell) };
}

export function packSlotEntry(coord: SlotCoord): number {
  return 1 + (coord.x | (coord.y << SLOT_COORD_BITS) | (coord.z << (2 * SLOT_COORD_BITS)));
}

export function unpackSlotEntry(entry: number): SlotCoord {
  const packed = entry - 1;
  return {
    x: packed & SLOT_COORD_MASK,
    y: (packed >> SLOT_COORD_BITS) & SLOT_COORD_MASK,
    z: packed >> (2 * SLOT_COORD_BITS),
  };
}

export interface DepthTiling {
  readonly tiles: number;
  readonly tileDepth: number;
}

export function depthTiling(dims: Vec3, brickSize: number, maxDimension: number): DepthTiling {
  const bricksDeep = Math.ceil(dims[2] / brickSize);
  const tiles = Math.ceil(bricksDeep / Math.floor(maxDimension / brickSize));
  return { tiles, tileDepth: Math.ceil(bricksDeep / tiles) * brickSize };
}

export function tiledOrigin(
  origin: readonly [number, number, number],
  tileDepth: number,
  tileWidth: number,
): GPUOrigin3DDict {
  const [x, y, z] = origin;
  const tile = Math.floor(z / tileDepth);
  return { x: x + tile * tileWidth, y, z: z - tile * tileDepth };
}

export function poolTextureFormat(format: VolumeFormat): GPUTextureFormat {
  switch (format) {
    case 'int16':
      return 'r16sint';
    case 'uint16':
      return 'r16uint';
    case 'uint8':
      return 'r8uint';
    case 'float32':
      return 'r32float';
  }
}

export function cellTextureFormat(format: VolumeFormat): GPUTextureFormat {
  switch (format) {
    case 'int16':
      return 'rg16sint';
    case 'uint16':
      return 'rg16uint';
    case 'uint8':
      return 'rg8uint';
    case 'float32':
      return 'rg32float';
  }
}

export function poolSampleType(format: VolumeFormat): GPUTextureSampleType {
  switch (format) {
    case 'int16':
      return 'sint';
    case 'uint16':
    case 'uint8':
      return 'uint';
    case 'float32':
      return 'unfilterable-float';
  }
}

export function poolTexelType(format: VolumeFormat): TexelType {
  switch (format) {
    case 'int16':
      return 'i32';
    case 'uint16':
    case 'uint8':
      return 'u32';
    case 'float32':
      return 'f32';
  }
}
