import { type VolumeGeometry, volumeCenter } from './geometry';
import { add, cross, dot, normalize, scale, sub, type Vec3 } from './math';

export type Orientation = 'axial' | 'coronal' | 'sagittal' | 'acquisition';

export interface CameraBasis {
  readonly right: Vec3;
  readonly trueUp: Vec3;
  readonly normal: Vec3;
}

export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

const PRESET_AXES: Record<Exclude<Orientation, 'acquisition'>, { normal: Vec3; up: Vec3 }> = {
  axial: { normal: [0, 0, 1], up: [0, -1, 0] },
  coronal: { normal: [0, 1, 0], up: [0, 0, 1] },
  sagittal: { normal: [1, 0, 0], up: [0, 0, 1] },
};

export class Camera {
  normal: Vec3;
  up: Vec3;
  focalPoint: Vec3;
  zoom: number;

  constructor(normal: Vec3, up: Vec3, focalPoint: Vec3, zoom: number) {
    this.normal = normalize(normal);
    this.up = normalize(up);
    this.focalPoint = focalPoint;
    this.zoom = zoom;
  }

  basis(): CameraBasis {
    const normal = normalize(this.normal);
    const right = normalize(cross(normal, this.up));
    const trueUp = normalize(cross(right, normal));
    return { right, trueUp, normal };
  }

  scrollSlab(deltaMm: number): void {
    this.focalPoint = add(this.focalPoint, scale(normalize(this.normal), deltaMm));
  }
}

function halfExtentAlong(geometry: VolumeGeometry, dir: Vec3): number {
  const { dims, spacing, direction } = geometry;
  return (
    0.5 * dims[0] * spacing[0] * Math.abs(dot(direction[0], dir)) +
    0.5 * dims[1] * spacing[1] * Math.abs(dot(direction[1], dir)) +
    0.5 * dims[2] * spacing[2] * Math.abs(dot(direction[2], dir))
  );
}

export function cameraForOrientation(
  geometry: VolumeGeometry,
  orientation: Orientation,
  aspect: number,
): Camera {
  const axes =
    orientation === 'acquisition'
      ? { normal: geometry.direction[2], up: scale(geometry.direction[1], -1) }
      : PRESET_AXES[orientation];
  const camera = new Camera(axes.normal, axes.up, volumeCenter(geometry), 1);
  fitCamera(camera, geometry, aspect);
  return camera;
}

export function fitCamera(camera: Camera, geometry: VolumeGeometry, aspect: number): void {
  const { right, trueUp } = camera.basis();
  const halfWidth = halfExtentAlong(geometry, right);
  const halfHeight = halfExtentAlong(geometry, trueUp);
  camera.zoom = Math.max(halfHeight, halfWidth / aspect);
}

export function worldToCanvas(
  camera: Camera,
  world: Vec3,
  canvasWidth: number,
  canvasHeight: number,
): CanvasPoint {
  const { right, trueUp } = camera.basis();
  const rel = sub(world, camera.focalPoint);
  const halfHeight = camera.zoom;
  const halfWidth = camera.zoom * (canvasWidth / canvasHeight);
  const ndcX = dot(rel, right) / halfWidth;
  const ndcY = dot(rel, trueUp) / halfHeight;
  return {
    x: (ndcX * 0.5 + 0.5) * canvasWidth,
    y: (1 - (ndcY * 0.5 + 0.5)) * canvasHeight,
  };
}

export function canvasToWorld(
  camera: Camera,
  point: CanvasPoint,
  canvasWidth: number,
  canvasHeight: number,
): Vec3 {
  const { right, trueUp } = camera.basis();
  const ndcX = (point.x / canvasWidth) * 2 - 1;
  const ndcY = (1 - point.y / canvasHeight) * 2 - 1;
  const halfHeight = camera.zoom;
  const halfWidth = camera.zoom * (canvasWidth / canvasHeight);
  return add(
    add(camera.focalPoint, scale(right, ndcX * halfWidth)),
    scale(trueUp, ndcY * halfHeight),
  );
}
