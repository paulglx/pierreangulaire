import type { VolumeFormat } from '../geometry';

export interface PoolShape {
  readonly slotsPerAxis: number;
  readonly layers: number;
}

export type TexelType = 'f32' | 'i32' | 'u32';

export function poolShape(capacity: number, brickSize: number, maxDimension: number): PoolShape {
  const maxSlotsPerAxis = Math.floor(maxDimension / brickSize);
  const slotsPerAxis = Math.max(1, Math.ceil(Math.cbrt(capacity)));
  if (slotsPerAxis > maxSlotsPerAxis) {
    throw new Error(
      `Brick pool cannot hold ${capacity} bricks of ${brickSize}³ within a ${maxDimension}³ texture.`,
    );
  }
  return { slotsPerAxis, layers: Math.ceil(capacity / (slotsPerAxis * slotsPerAxis)) };
}

export function slotOrigin(
  slot: number,
  slotsPerAxis: number,
  brickSize: number,
): { x: number; y: number; z: number } {
  return {
    x: (slot % slotsPerAxis) * brickSize,
    y: (Math.floor(slot / slotsPerAxis) % slotsPerAxis) * brickSize,
    z: Math.floor(slot / (slotsPerAxis * slotsPerAxis)) * brickSize,
  };
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
