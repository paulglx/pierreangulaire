import { type Vec3, type Volume, worldExtent } from 'pierreangulaire';

export interface Phantom {
  readonly name: string;
  readonly halfExtent: Vec3;
  readonly scale: number;
  readonly roughness: number;
  readonly grain: number;
  distance(x: number, y: number, z: number): number;
}

type Mat3 = readonly [Vec3, Vec3, Vec3];

const TAU = 2 * Math.PI;
const CELL = 4;
const CULL_MARGIN = 1.25;

function sphere(x: number, y: number, z: number, radius: number): number {
  return Math.hypot(x, y, z) - radius;
}

function ellipsoid(x: number, y: number, z: number, rx: number, ry: number, rz: number): number {
  const k0 = Math.hypot(x / rx, y / ry, z / rz);
  const k1 = Math.hypot(x / (rx * rx), y / (ry * ry), z / (rz * rz));
  return k1 === 0 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
}

function cone(
  x: number,
  y: number,
  z: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  radiusA: number,
  radiusB: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const apx = x - ax;
  const apy = y - ay;
  const apz = z - az;
  const lengthSq = abx * abx + aby * aby + abz * abz;
  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / lengthSq));
  return (
    Math.hypot(apx - abx * t, apy - aby * t, apz - abz * t) - (radiusA + (radiusB - radiusA) * t)
  );
}

function unit(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

const organ: Phantom = {
  name: 'kidney-like organ',
  halfExtent: [1.6, 1.1, 0.8],
  scale: 1.6,
  roughness: 0.12,
  grain: 1.2,
  distance(x, y, z) {
    const body = ellipsoid(x, y, z, 1.4, 0.9, 0.6);
    const hilum = sphere(x, y - 1, z, 0.55);
    return Math.max(body, -hilum);
  },
};

const bone: Phantom = {
  name: 'long bone',
  halfExtent: [2.4, 1.2, 0.9],
  scale: 1.4,
  roughness: 0.05,
  grain: 3,
  distance(x, y, z) {
    const bend = 0.12 * x * x;
    const shaft = cone(x, y - bend, z, -1.5, 0, 0, 1.5, 0, 0, 0.32, 0.28);
    const proximal = ellipsoid(x + 1.75, y - 0.2, z, 0.45, 0.6, 0.5);
    const distal = ellipsoid(x - 1.75, y - 0.35, z, 0.4, 0.55, 0.7);
    return Math.min(shaft, proximal, distal);
  },
};

const SPICULE_DIRECTIONS: readonly Vec3[] = [
  [1, 0.3, 0.2],
  [-0.6, 1, 0.1],
  [0.2, -0.7, 1],
  [-1, -0.5, -0.4],
  [0.5, 0.4, -1],
  [-0.3, 1, -0.8],
  [0.8, -0.9, -0.3],
];
const SPICULE_TIPS = SPICULE_DIRECTIONS.map(unit).map(
  (d): Vec3 => [d[0] * 1.5, d[1] * 1.5, d[2] * 1.5],
);

const lesion: Phantom = {
  name: 'spiculated lesion',
  halfExtent: [1.6, 1.6, 1.6],
  scale: 1.2,
  roughness: 0.18,
  grain: 2.5,
  distance(x, y, z) {
    let d = sphere(x, y, z, 0.75);
    for (const tip of SPICULE_TIPS) {
      d = Math.min(d, cone(x, y, z, 0, 0, 0, tip[0], tip[1], tip[2], 0.22, 0.04));
    }
    return d;
  },
};

const TRUNK_SEGMENTS = 12;
const TRUNK_START = -2.2;
const TRUNK_STEP = 4.4 / TRUNK_SEGMENTS;
const TRUNK: Vec3[] = Array.from({ length: TRUNK_SEGMENTS + 1 }, (_, i) => {
  const x = TRUNK_START + TRUNK_STEP * i;
  return [x, 0.35 * Math.sin(1.4 * x), 0.2 * Math.cos(2 * x)];
});
const TRUNK_RADII = TRUNK.map((_, i) => 0.24 - (0.08 * i) / TRUNK_SEGMENTS);
const BRANCH_ROOT = TRUNK[TRUNK_SEGMENTS / 2]!;
const BRANCH_TIP: Vec3 = [BRANCH_ROOT[0] + 0.9, BRANCH_ROOT[1] + 1.6, BRANCH_ROOT[2] + 0.5];

function trunkSegment(x: number, y: number, z: number, i: number): number {
  const a = TRUNK[i]!;
  const b = TRUNK[i + 1]!;
  return cone(x, y, z, a[0], a[1], a[2], b[0], b[1], b[2], TRUNK_RADII[i]!, TRUNK_RADII[i + 1]!);
}

const vessel: Phantom = {
  name: 'branching vessel',
  halfExtent: [2.5, 2.1, 0.9],
  scale: 3,
  roughness: 0.03,
  grain: 4,
  distance(x, y, z) {
    let d = cone(
      x,
      y,
      z,
      BRANCH_ROOT[0],
      BRANCH_ROOT[1],
      BRANCH_ROOT[2],
      BRANCH_TIP[0],
      BRANCH_TIP[1],
      BRANCH_TIP[2],
      0.14,
      0.07,
    );
    const nearest = Math.floor((x - TRUNK_START) / TRUNK_STEP);
    const first = Math.max(0, nearest - 1);
    const last = Math.min(TRUNK_SEGMENTS - 1, nearest + 1);
    for (let i = first; i <= last; i++) d = Math.min(d, trunkSegment(x, y, z, i));
    return d;
  },
};

export const PHANTOMS: readonly Phantom[] = [organ, bone, lesion, vessel];

function hash(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function perAxis(f: (axis: 0 | 1 | 2) => number): Vec3 {
  return [f(0), f(1), f(2)];
}

function valueNoise(x: number, y: number, z: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const fz = fade(z - z0);
  const c00 = lerp(hash(x0, y0, z0), hash(x0 + 1, y0, z0), fx);
  const c10 = lerp(hash(x0, y0 + 1, z0), hash(x0 + 1, y0 + 1, z0), fx);
  const c01 = lerp(hash(x0, y0, z0 + 1), hash(x0 + 1, y0, z0 + 1), fx);
  const c11 = lerp(hash(x0, y0 + 1, z0 + 1), hash(x0 + 1, y0 + 1, z0 + 1), fx);
  return lerp(lerp(c00, c10, fy), lerp(c01, c11, fy), fz) * 2 - 1;
}

function fbm(x: number, y: number, z: number): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let norm = 0;
  for (let octave = 0; octave < 3; octave++) {
    sum += amplitude * valueNoise(x * frequency, y * frequency, z * frequency);
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2.1;
  }
  return sum / norm;
}

function randomRotation(): Mat3 {
  const u1 = Math.random();
  const u2 = TAU * Math.random();
  const u3 = TAU * Math.random();
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  const x = a * Math.sin(u2);
  const y = a * Math.cos(u2);
  const z = b * Math.sin(u3);
  const w = b * Math.cos(u3);
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

export interface PaintedPhantom {
  readonly segment: number;
  readonly phantom: Phantom;
  readonly radiusMm: number;
}

interface Placement {
  readonly phantom: Phantom;
  readonly center: Vec3;
  readonly radiusMm: number;
  readonly rotation: Mat3;
  readonly seed: Vec3;
  readonly spacing: Vec3;
}

interface MaskBox {
  readonly origin: Vec3;
  readonly size: Vec3;
  readonly mask: Uint8Array;
}

function rasterize(placement: Placement, box: MaskBox): void {
  const { phantom, center, radiusMm, rotation, seed, spacing } = placement;
  const { halfExtent, roughness, grain } = phantom;
  const { origin, size, mask } = box;
  const [w, h, d] = size;
  const cellHalfDiagonal =
    (Math.hypot(CELL * spacing[0], CELL * spacing[1], CELL * spacing[2]) / 2 / radiusMm) *
    CULL_MARGIN;
  const cullDistance = cellHalfDiagonal + roughness;
  const cullExtent = perAxis((a) => halfExtent[a] + cellHalfDiagonal);

  const step = (axis: 0 | 1 | 2): Vec3 =>
    perAxis((row) => (rotation[row][axis] * spacing[axis]) / radiusMm);
  const [stepI, stepJ, stepK] = [step(0), step(1), step(2)];
  const start = perAxis(
    (row) =>
      stepI[row] * (origin[0] - center[0]) +
      stepJ[row] * (origin[1] - center[1]) +
      stepK[row] * (origin[2] - center[2]),
  );

  const localX = (i: number, j: number, k: number): number =>
    start[0] + stepI[0] * i + stepJ[0] * j + stepK[0] * k;
  const localY = (i: number, j: number, k: number): number =>
    start[1] + stepI[1] * i + stepJ[1] * j + stepK[1] * k;
  const localZ = (i: number, j: number, k: number): number =>
    start[2] + stepI[2] * i + stepJ[2] * j + stepK[2] * k;

  const paintVoxel = (i: number, j: number, k: number): void => {
    const px = localX(i, j, k);
    if (Math.abs(px) > halfExtent[0]) return;
    const py = localY(i, j, k);
    if (Math.abs(py) > halfExtent[1]) return;
    const pz = localZ(i, j, k);
    if (Math.abs(pz) > halfExtent[2]) return;
    const base = phantom.distance(px, py, pz);
    if (base > roughness) return;
    if (
      base > -roughness &&
      base + roughness * fbm(px * grain + seed[0], py * grain + seed[1], pz * grain + seed[2]) > 0
    ) {
      return;
    }
    mask[i + (j + k * h) * w] = 1;
  };

  for (let ck = 0; ck < d; ck += CELL) {
    const k1 = Math.min(d, ck + CELL);
    const mk = (ck + k1 - 1) / 2;
    for (let cj = 0; cj < h; cj += CELL) {
      const j1 = Math.min(h, cj + CELL);
      const mj = (cj + j1 - 1) / 2;
      for (let ci = 0; ci < w; ci += CELL) {
        const i1 = Math.min(w, ci + CELL);
        const mi = (ci + i1 - 1) / 2;
        const cx = localX(mi, mj, mk);
        if (Math.abs(cx) > cullExtent[0]) continue;
        const cy = localY(mi, mj, mk);
        if (Math.abs(cy) > cullExtent[1]) continue;
        const cz = localZ(mi, mj, mk);
        if (Math.abs(cz) > cullExtent[2]) continue;
        const centerDistance = phantom.distance(cx, cy, cz);
        if (centerDistance > cullDistance) continue;
        if (centerDistance < -cullDistance) {
          for (let k = ck; k < k1; k++) {
            for (let j = cj; j < j1; j++) mask.fill(1, ci + (j + k * h) * w, i1 + (j + k * h) * w);
          }
          continue;
        }
        for (let k = ck; k < k1; k++) {
          for (let j = cj; j < j1; j++) {
            for (let i = ci; i < i1; i++) paintVoxel(i, j, k);
          }
        }
      }
    }
  }
}

export function paintRandomPhantom(volume: Volume): PaintedPhantom {
  const { geometry, segmentation } = volume;
  const segment = Math.min(65535, (segmentation.segmentsPresent().at(-1) ?? 0) + 1);
  const phantom = PHANTOMS[Math.floor(Math.random() * PHANTOMS.length)]!;
  const radiusMm =
    Math.min(...worldExtent(geometry)) * (0.012 + Math.random() * 0.02) * phantom.scale;
  const { dims, spacing } = geometry;
  const center: Vec3 = [
    dims[0] * (0.1 + Math.random() * 0.8),
    dims[1] * (0.1 + Math.random() * 0.8),
    dims[2] * (0.1 + Math.random() * 0.8),
  ];
  const rotation = randomRotation();
  const seed: Vec3 = [Math.random() * 1e3, Math.random() * 1e3, Math.random() * 1e3];
  const reach = Math.hypot(...phantom.halfExtent) * radiusMm;

  const origin = perAxis((a) => Math.max(0, Math.floor(center[a] - reach / spacing[a])));
  const end = perAxis((a) => Math.min(dims[a] - 1, Math.ceil(center[a] + reach / spacing[a])));
  const size = perAxis((a) => end[a] - origin[a] + 1);
  const [w, h, d] = size;
  if (w <= 0 || h <= 0 || d <= 0) return { segment, phantom, radiusMm };
  const mask = new Uint8Array(w * h * d);

  rasterize({ phantom, center, radiusMm, rotation, seed, spacing }, { origin, size, mask });
  segmentation.paintMask(origin, size, mask, segment);
  return { segment, phantom, radiusMm };
}
