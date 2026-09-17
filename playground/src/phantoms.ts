import { type Vec3, type Volume, worldExtent } from 'pierreangulaire';

export interface Phantom {
  readonly name: string;
  readonly halfExtent: Vec3;
  readonly scale: number;
  readonly roughness: number;
  readonly grain: number;
  distance(p: Vec3): number;
}

type Mat3 = readonly [Vec3, Vec3, Vec3];

const TAU = 2 * Math.PI;

function sphere(p: Vec3, radius: number): number {
  return Math.hypot(p[0], p[1], p[2]) - radius;
}

function ellipsoid(p: Vec3, radii: Vec3): number {
  const k0 = Math.hypot(p[0] / radii[0], p[1] / radii[1], p[2] / radii[2]);
  const k1 = Math.hypot(
    p[0] / (radii[0] * radii[0]),
    p[1] / (radii[1] * radii[1]),
    p[2] / (radii[2] * radii[2]),
  );
  return k1 === 0 ? -Math.min(...radii) : (k0 * (k0 - 1)) / k1;
}

function cone(p: Vec3, a: Vec3, b: Vec3, radiusA: number, radiusB: number): number {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const lengthSq = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / lengthSq));
  const dx = ap[0] - ab[0] * t;
  const dy = ap[1] - ab[1] * t;
  const dz = ap[2] - ab[2] * t;
  return Math.hypot(dx, dy, dz) - (radiusA + (radiusB - radiusA) * t);
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
  distance(p) {
    const body = ellipsoid(p, [1.4, 0.9, 0.6]);
    const hilum = sphere([p[0], p[1] - 1, p[2]], 0.55);
    return Math.max(body, -hilum);
  },
};

const bone: Phantom = {
  name: 'long bone',
  halfExtent: [2.4, 1.2, 0.9],
  scale: 1.4,
  roughness: 0.05,
  grain: 3,
  distance(p) {
    const bend = 0.12 * p[0] * p[0];
    const shaft = cone([p[0], p[1] - bend, p[2]], [-1.5, 0, 0], [1.5, 0, 0], 0.32, 0.28);
    const proximal = ellipsoid([p[0] + 1.75, p[1] - 0.2, p[2]], [0.45, 0.6, 0.5]);
    const distal = ellipsoid([p[0] - 1.75, p[1] - 0.35, p[2]], [0.4, 0.55, 0.7]);
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
const SPICULES = SPICULE_DIRECTIONS.map(unit);

const lesion: Phantom = {
  name: 'spiculated lesion',
  halfExtent: [1.6, 1.6, 1.6],
  scale: 1.2,
  roughness: 0.18,
  grain: 2.5,
  distance(p) {
    let d = sphere(p, 0.75);
    for (const direction of SPICULES) {
      const tip: Vec3 = [direction[0] * 1.5, direction[1] * 1.5, direction[2] * 1.5];
      d = Math.min(d, cone(p, [0, 0, 0], tip, 0.22, 0.04));
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

const vessel: Phantom = {
  name: 'branching vessel',
  halfExtent: [2.5, 2.1, 0.9],
  scale: 3,
  roughness: 0.03,
  grain: 4,
  distance(p) {
    let d = cone(p, BRANCH_ROOT, BRANCH_TIP, 0.14, 0.07);
    const nearest = Math.floor((p[0] - TRUNK_START) / TRUNK_STEP);
    const first = Math.max(0, nearest - 1);
    const last = Math.min(TRUNK_SEGMENTS - 1, nearest + 1);
    for (let i = first; i <= last; i++) {
      d = Math.min(d, cone(p, TRUNK[i]!, TRUNK[i + 1]!, TRUNK_RADII[i]!, TRUNK_RADII[i + 1]!));
    }
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
  const { halfExtent, roughness, grain } = phantom;
  const reach = Math.hypot(...halfExtent) * radiusMm;

  const origin = perAxis((a) => Math.max(0, Math.floor(center[a] - reach / spacing[a])));
  const end = perAxis((a) => Math.min(dims[a] - 1, Math.ceil(center[a] + reach / spacing[a])));
  const size = perAxis((a) => end[a] - origin[a] + 1);
  const [w, h, d] = size;
  if (w <= 0 || h <= 0 || d <= 0) return { segment, phantom, radiusMm };
  const mask = new Uint8Array(w * h * d);

  for (let k = 0; k < d; k++) {
    const wz = ((origin[2] + k - center[2]) * spacing[2]) / radiusMm;
    for (let j = 0; j < h; j++) {
      const wy = ((origin[1] + j - center[1]) * spacing[1]) / radiusMm;
      const row = (j + k * h) * w;
      for (let i = 0; i < w; i++) {
        const wx = ((origin[0] + i - center[0]) * spacing[0]) / radiusMm;
        const px = rotation[0][0] * wx + rotation[0][1] * wy + rotation[0][2] * wz;
        if (Math.abs(px) > halfExtent[0]) continue;
        const py = rotation[1][0] * wx + rotation[1][1] * wy + rotation[1][2] * wz;
        if (Math.abs(py) > halfExtent[1]) continue;
        const pz = rotation[2][0] * wx + rotation[2][1] * wy + rotation[2][2] * wz;
        if (Math.abs(pz) > halfExtent[2]) continue;
        const base = phantom.distance([px, py, pz]);
        if (base > roughness) continue;
        if (
          base > -roughness &&
          base + roughness * fbm(px * grain + seed[0], py * grain + seed[1], pz * grain + seed[2]) >
            0
        ) {
          continue;
        }
        mask[row + i] = 1;
      }
    }
  }

  segmentation.paintMask(origin, size, mask, segment);
  return { segment, phantom, radiusMm };
}
