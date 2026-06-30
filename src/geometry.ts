import { add, dot, scale, sub, type Vec3 } from './math';

export type VolumeFormat = 'int16' | 'uint16' | 'uint8' | 'float32';

export interface VolumeGeometry {
  readonly dims: Vec3;
  readonly spacing: Vec3;
  readonly origin: Vec3;
  readonly direction: readonly [Vec3, Vec3, Vec3];
}

export function voxelCount(geometry: VolumeGeometry): number {
  return geometry.dims[0] * geometry.dims[1] * geometry.dims[2];
}

export function indexToWorld(geometry: VolumeGeometry, index: Vec3): Vec3 {
  const { origin, direction, spacing } = geometry;
  let world = add(origin, scale(direction[0], index[0] * spacing[0]));
  world = add(world, scale(direction[1], index[1] * spacing[1]));
  world = add(world, scale(direction[2], index[2] * spacing[2]));
  return world;
}

export function worldToIndex(geometry: VolumeGeometry, world: Vec3): Vec3 {
  const { origin, direction, spacing } = geometry;
  const rel = sub(world, origin);
  return [
    dot(rel, direction[0]) / spacing[0],
    dot(rel, direction[1]) / spacing[1],
    dot(rel, direction[2]) / spacing[2],
  ];
}

export function volumeCenter(geometry: VolumeGeometry): Vec3 {
  return indexToWorld(geometry, [
    (geometry.dims[0] - 1) / 2,
    (geometry.dims[1] - 1) / 2,
    (geometry.dims[2] - 1) / 2,
  ]);
}

export function worldExtent(geometry: VolumeGeometry): Vec3 {
  return [
    geometry.dims[0] * geometry.spacing[0],
    geometry.dims[1] * geometry.spacing[1],
    geometry.dims[2] * geometry.spacing[2],
  ];
}
