const HARDWARE_TRILINEAR = /* wgsl */ `
@group(0) @binding(5) var volumeSampler: sampler;

fn sampleTrilinear(q: vec3<f32>) -> f32 {
  return textureSampleLevel(volume, volumeSampler, (q + vec3<f32>(0.5)) / U.dims, 0.0).r;
}
`;

const MANUAL_TRILINEAR = /* wgsl */ `
fn loadVoxel(c: vec3<i32>, maxIndex: vec3<i32>) -> f32 {
  let clamped = clamp(c, vec3<i32>(0), maxIndex);
  return textureLoad(volume, clamped, 0).r;
}

fn sampleTrilinear(q: vec3<f32>) -> f32 {
  let maxIndex = vec3<i32>(U.dims) - vec3<i32>(1);
  let base = vec3<i32>(floor(q));
  let f = q - floor(q);
  let c000 = loadVoxel(base + vec3<i32>(0, 0, 0), maxIndex);
  let c100 = loadVoxel(base + vec3<i32>(1, 0, 0), maxIndex);
  let c010 = loadVoxel(base + vec3<i32>(0, 1, 0), maxIndex);
  let c110 = loadVoxel(base + vec3<i32>(1, 1, 0), maxIndex);
  let c001 = loadVoxel(base + vec3<i32>(0, 0, 1), maxIndex);
  let c101 = loadVoxel(base + vec3<i32>(1, 0, 1), maxIndex);
  let c011 = loadVoxel(base + vec3<i32>(0, 1, 1), maxIndex);
  let c111 = loadVoxel(base + vec3<i32>(1, 1, 1), maxIndex);
  let x00 = mix(c000, c100, f.x);
  let x10 = mix(c010, c110, f.x);
  let x01 = mix(c001, c101, f.x);
  let x11 = mix(c011, c111, f.x);
  let y0 = mix(x00, x10, f.y);
  let y1 = mix(x01, x11, f.y);
  return mix(y0, y1, f.z);
}
`;

const SHARED = /* wgsl */ `
struct Uniforms {
  right: vec3<f32>,
  halfWidth: f32,
  trueUp: vec3<f32>,
  halfHeight: f32,
  normal: vec3<f32>,
  slabThickness: f32,
  focalPoint: vec3<f32>,
  sampleCount: f32,
  dirCol0: vec3<f32>,
  windowCenter: f32,
  dirCol1: vec3<f32>,
  windowWidth: f32,
  dirCol2: vec3<f32>,
  blendMode: f32,
  origin: vec3<f32>,
  segEnabled: f32,
  spacing: vec3<f32>,
  segAntialias: f32,
  dims: vec3<f32>,
  pixelVoxels: f32,
  bricksPerAxis: vec3<f32>,
  brickSize: f32,
  debugEmptyBlocks: f32,
};

@group(0) @binding(0) var<uniform> U: Uniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) index: u32) -> VertexOut {
  var corners = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  var out: VertexOut;
  out.position = vec4<f32>(corners[index], 0.0, 1.0);
  out.uv = corners[index];
  return out;
}

fn worldToIndex(p: vec3<f32>) -> vec3<f32> {
  let rel = p - U.origin;
  return vec3<f32>(
    dot(rel, U.dirCol0) / U.spacing.x,
    dot(rel, U.dirCol1) / U.spacing.y,
    dot(rel, U.dirCol2) / U.spacing.z,
  );
}

fn worldDirToIndex(v: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(v, U.dirCol0) / U.spacing.x,
    dot(v, U.dirCol1) / U.spacing.y,
    dot(v, U.dirCol2) / U.spacing.z,
  );
}
`;

export function raycastShader(filterableVolume: boolean): string {
  return /* wgsl */ `
${SHARED}
@group(0) @binding(1) var volume: texture_3d<f32>;
@group(0) @binding(2) var segmentation: texture_3d<u32>;
@group(0) @binding(3) var<uniform> labels: array<vec4<f32>, 256>;
@group(0) @binding(4) var brickRange: texture_3d<f32>;
${filterableVolume ? HARDWARE_TRILINEAR : MANUAL_TRILINEAR}
fn slotsAt(q: vec3<f32>) -> vec4<u32> {
  let maxIndex = vec3<i32>(U.dims) - vec3<i32>(1);
  let c = clamp(vec3<i32>(round(q)), vec3<i32>(0), maxIndex);
  return textureLoad(segmentation, c, 0);
}

fn inBounds(q: vec3<f32>) -> bool {
  return all(q >= vec3<f32>(0.0)) && all(q <= (U.dims - vec3<f32>(1.0)));
}

fn brickCoord(q: vec3<f32>) -> vec3<i32> {
  let grid = vec3<i32>(U.bricksPerAxis) - vec3<i32>(1);
  return clamp(vec3<i32>(floor(q / U.brickSize)), vec3<i32>(0), grid);
}

fn applyWindow(value: f32) -> f32 {
  let low = U.windowCenter - U.windowWidth * 0.5;
  return clamp((value - low) / U.windowWidth, 0.0, 1.0);
}

fn clipAxis(startC: f32, dirC: f32, hiC: f32, t: vec2<f32>) -> vec2<f32> {
  if (abs(dirC) < 1e-6) {
    if (startC < 0.0 || startC > hiC) {
      return vec2<f32>(1.0, 0.0);
    }
    return t;
  }
  let a = (0.0 - startC) / dirC;
  let b = (hiC - startC) / dirC;
  return vec2<f32>(max(t.x, min(a, b)), min(t.y, max(a, b)));
}

struct FragOut {
  @location(0) color: vec4<f32>,
  @location(1) segments: vec2<u32>,
};

fn packSegments(seen: array<u32, 8>) -> vec2<u32> {
  return vec2<u32>(
    seen[0] | (seen[1] << 8u) | (seen[2] << 16u) | (seen[3] << 24u),
    seen[4] | (seen[5] << 8u) | (seen[6] << 16u) | (seen[7] << 24u),
  );
}

@fragment
fn fs(in: VertexOut) -> FragOut {
  var out: FragOut;
  out.color = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  out.segments = vec2<u32>(0u);

  let plane = U.focalPoint + U.right * (in.uv.x * U.halfWidth) + U.trueUp * (in.uv.y * U.halfHeight);
  let count = max(u32(U.sampleCount), 1u);
  let qStart = worldToIndex(plane - U.normal * (U.slabThickness * 0.5));
  let qDir = worldDirToIndex(U.normal) * U.slabThickness;

  var iLo = 0u;
  var iHi = count - 1u;
  if (count > 1u) {
    var t = vec2<f32>(0.0, 1.0);
    t = clipAxis(qStart.x, qDir.x, U.dims.x - 1.0, t);
    t = clipAxis(qStart.y, qDir.y, U.dims.y - 1.0, t);
    t = clipAxis(qStart.z, qDir.z, U.dims.z - 1.0, t);
    if (t.x > t.y) {
      return out;
    }
    let scale = f32(count - 1u);
    iLo = u32(max(ceil(t.x * scale) - 1.0, 0.0));
    iHi = u32(min(floor(t.y * scale) + 1.0, scale));
  }

  let mode = u32(U.blendMode);
  var maxValue = -3.0e38;
  var minValue = 3.0e38;
  var sum = 0.0;
  var inBoundsCount = 0.0;
  var compositeColor = 0.0;
  var compositeAlpha = 0.0;
  var seen: array<u32, 8>;
  var seenCount = 0u;
  var lastBrick = vec3<i32>(-2);
  var brickMin = 0.0;
  var brickMax = 0.0;
  var segOccupied = 0.0;
  var debugAlpha = 0.0;

  for (var i = iLo; i <= iHi; i = i + 1u) {
    if (mode == 3u && U.debugEmptyBlocks < 0.5 && compositeAlpha > 0.995
      && (U.segEnabled < 0.5 || seenCount >= 8u)) {
      break;
    }
    var frac = 0.5;
    if (count > 1u) {
      frac = f32(i) / f32(count - 1u);
    }
    let q = qStart + qDir * frac;
    if (!inBounds(q)) {
      continue;
    }
    inBoundsCount = inBoundsCount + 1.0;

    let bc = brickCoord(q);
    if (any(bc != lastBrick)) {
      let r = textureLoad(brickRange, bc, 0);
      brickMin = r.x;
      brickMax = r.y;
      segOccupied = r.z;
      lastBrick = bc;
    }

    var imageSkip = false;
    if (mode == 0u) {
      imageSkip = brickMax <= maxValue;
    } else if (mode == 1u) {
      imageSkip = brickMin >= minValue;
    } else if (mode == 3u) {
      imageSkip = applyWindow(brickMax) <= 0.0 || compositeAlpha > 0.995;
    }
    let segNeeded = U.segEnabled > 0.5 && segOccupied > 0.5 && seenCount < 8u;

    if (count > 1u && imageSkip && !segNeeded && U.debugEmptyBlocks < 0.5) {
      let brickLo = vec3<f32>(bc) * U.brickSize;
      let moving = abs(qDir) > vec3<f32>(1e-6);
      let exitFace = select(brickLo, brickLo + vec3<f32>(U.brickSize), qDir > vec3<f32>(0.0));
      let safeDir = select(vec3<f32>(1.0), qDir, moving);
      let tAxis = select(vec3<f32>(2.0), (exitFace - qStart) / safeDir, moving);
      let tExit = min(min(tAxis.x, tAxis.y), tAxis.z);
      let exitIndex = u32(max(ceil(tExit * f32(count - 1u)) - 1.0, 0.0));
      i = max(exitIndex, i + 1u) - 1u;
      continue;
    }

    if (U.debugEmptyBlocks > 0.5 && applyWindow(brickMax) <= 0.0) {
      let local = q - vec3<f32>(bc) * U.brickSize;
      let toFace = min(local, vec3<f32>(U.brickSize) - local);
      let t = clamp(U.pixelVoxels, 0.5, U.brickSize * 0.25);
      var nearFaces = 0;
      if (toFace.x < t) { nearFaces = nearFaces + 1; }
      if (toFace.y < t) { nearFaces = nearFaces + 1; }
      if (toFace.z < t) { nearFaces = nearFaces + 1; }
      if (nearFaces >= 2) {
        debugAlpha = debugAlpha + (1.0 - debugAlpha);
      }
    }

    if (segNeeded) {
      let slots = slotsAt(q);
      for (var s = 0u; s < 4u; s = s + 1u) {
        let segment = slots[s];
        if (segment == 0u || labels[segment].a == 0.0) {
          continue;
        }
        var known = false;
        for (var p = 0u; p < seenCount; p = p + 1u) {
          if (seen[p] == segment) {
            known = true;
          }
        }
        if (!known && seenCount < 8u) {
          seen[seenCount] = segment;
          seenCount = seenCount + 1u;
        }
      }
    }

    if (imageSkip) {
      continue;
    }

    let value = sampleTrilinear(q);
    maxValue = max(maxValue, value);
    minValue = min(minValue, value);
    sum = sum + value;
    let gray = applyWindow(value);
    compositeColor = compositeColor + (1.0 - compositeAlpha) * gray * gray;
    compositeAlpha = compositeAlpha + (1.0 - compositeAlpha) * gray;
  }

  if (inBoundsCount == 0.0) {
    return out;
  }

  var gray = 0.0;
  if (mode == 0u) {
    gray = applyWindow(maxValue);
  } else if (mode == 1u) {
    gray = applyWindow(minValue);
  } else if (mode == 2u) {
    gray = applyWindow(sum / inBoundsCount);
  } else {
    gray = compositeColor;
  }
  var rgb = vec3<f32>(gray);
  if (debugAlpha > 0.0) {
    rgb = mix(rgb, vec3<f32>(1.0, 0.08, 0.55), debugAlpha);
  }
  out.color = vec4<f32>(rgb, 1.0);
  out.segments = packSegments(seen);
  return out;
}
`;
}

export function segmentationResolveShader(): string {
  return /* wgsl */ `
${SHARED}
@group(0) @binding(1) var projectedSegments: texture_2d<u32>;
@group(0) @binding(2) var<uniform> labels: array<vec4<f32>, 256>;

const BORDER_ALPHA = 0.9;
const SEG_ISO = 0.5;
const SEG_ISO_INNER = 0.82;
const SEG_BORDER_WIDTH = 1.25;
const SEG_KERNEL: i32 = 3;
const SEG_SUPPORT = 3.5;

fn indexDirToWorld(v: vec3<f32>) -> vec3<f32> {
  return U.dirCol0 * (v.x * U.spacing.x)
    + U.dirCol1 * (v.y * U.spacing.y)
    + U.dirCol2 * (v.z * U.spacing.z);
}

fn planeStep(v: vec3<f32>) -> vec3<f32> {
  let d = worldDirToIndex(v);
  let m = max(max(abs(d.x), abs(d.y)), abs(d.z));
  return d / max(m, 1e-6);
}

fn planeProject(v: vec3<f32>) -> vec3<f32> {
  return v - worldDirToIndex(U.normal) * dot(indexDirToWorld(v), U.normal);
}

fn indexOffsetToPixels(v: vec3<f32>) -> vec2<f32> {
  let w = indexDirToWorld(v);
  let dims = vec2<f32>(textureDimensions(projectedSegments));
  return vec2<f32>(
    dot(w, U.right) / U.halfWidth * dims.x * 0.5,
    -(dot(w, U.trueUp) / U.halfHeight) * dims.y * 0.5,
  );
}

fn atLeastOneTexel(v: vec2<f32>) -> vec2<f32> {
  let len = length(v);
  return v * (max(len, 1.0) / max(len, 1e-6));
}

fn segmentsAt(px: vec2<f32>) -> vec2<u32> {
  let dims = vec2<i32>(textureDimensions(projectedSegments));
  let c = clamp(vec2<i32>(floor(px)), vec2<i32>(0), dims - vec2<i32>(1));
  return textureLoad(projectedSegments, c, 0).xy;
}

fn segmentAt(ids: vec2<u32>, k: u32) -> u32 {
  let word = select(ids.x, ids.y, k >= 4u);
  return (word >> ((k % 4u) * 8u)) & 0xffu;
}

fn containsSegment(ids: vec2<u32>, segment: u32) -> bool {
  for (var k = 0u; k < 8u; k = k + 1u) {
    if (segmentAt(ids, k) == segment) {
      return true;
    }
  }
  return false;
}

fn resolveAliased(px: vec2<f32>) -> vec4<f32> {
  let center = segmentsAt(px);
  if (all(center == vec2<u32>(0u))) {
    return vec4<f32>(0.0);
  }
  let borderRight = atLeastOneTexel(indexOffsetToPixels(planeStep(U.right) * SEG_BORDER_WIDTH));
  let borderUp = atLeastOneTexel(indexOffsetToPixels(planeStep(U.trueUp) * SEG_BORDER_WIDTH));
  let nl = segmentsAt(px - borderRight);
  let nr = segmentsAt(px + borderRight);
  let nd = segmentsAt(px - borderUp);
  let nu = segmentsAt(px + borderUp);
  var color = vec3<f32>(0.0);
  var alpha = 0.0;
  for (var k = 0u; k < 8u; k = k + 1u) {
    let segment = segmentAt(center, k);
    if (segment == 0u) {
      continue;
    }
    let style = labels[segment];
    if (style.a == 0.0) {
      continue;
    }
    let interior = containsSegment(nl, segment) && containsSegment(nr, segment)
      && containsSegment(nd, segment) && containsSegment(nu, segment);
    var a = style.a;
    if (!interior) {
      a = max(a, BORDER_ALPHA);
    }
    color = color + style.rgb * a;
    alpha = 1.0 - (1.0 - alpha) * (1.0 - a);
  }
  return vec4<f32>(min(color, vec3<f32>(1.0)), alpha);
}

fn resolveAntialiased(px: vec2<f32>, q: vec3<f32>) -> vec4<f32> {
  let rightStep = planeStep(U.right);
  let upStep = planeStep(U.trueUp);
  let gateRight = indexOffsetToPixels(rightStep * f32(SEG_KERNEL));
  let gateUp = indexOffsetToPixels(upStep * f32(SEG_KERNEL));
  if (all(segmentsAt(px) == vec2<u32>(0u))
    && all(segmentsAt(px - gateRight) == vec2<u32>(0u)) && all(segmentsAt(px + gateRight) == vec2<u32>(0u))
    && all(segmentsAt(px - gateUp) == vec2<u32>(0u)) && all(segmentsAt(px + gateUp) == vec2<u32>(0u))) {
    return vec4<f32>(0.0);
  }

  var seen: array<u32, 16>;
  var cov: array<f32, 16>;
  var seenCount = 0u;
  var weightSum = 0.0;
  let anchor = planeProject(round(q) - q);
  for (var dy = -SEG_KERNEL; dy <= SEG_KERNEL; dy = dy + 1) {
    for (var dx = -SEG_KERNEL; dx <= SEG_KERNEL; dx = dx + 1) {
      let offset = anchor + rightStep * f32(dx) + upStep * f32(dy);
      let t = dot(offset, offset) / (SEG_SUPPORT * SEG_SUPPORT);
      if (t >= 1.0) {
        continue;
      }
      let edge = 1.0 - t;
      let weight = edge * edge;
      weightSum = weightSum + weight;
      let ids = segmentsAt(px + indexOffsetToPixels(offset));
      for (var k = 0u; k < 8u; k = k + 1u) {
        let segment = segmentAt(ids, k);
        if (segment == 0u) {
          continue;
        }
        var idx = seenCount;
        for (var p = 0u; p < seenCount; p = p + 1u) {
          if (seen[p] == segment) {
            idx = p;
          }
        }
        if (idx == seenCount) {
          if (seenCount >= 16u) {
            continue;
          }
          seen[seenCount] = segment;
          cov[seenCount] = 0.0;
          seenCount = seenCount + 1u;
        }
        cov[idx] = cov[idx] + weight;
      }
    }
  }
  if (weightSum <= 0.0) {
    return vec4<f32>(0.0);
  }

  let halfBand = clamp(0.6 * U.pixelVoxels / SEG_SUPPORT, 0.01, 0.15);
  var color = vec3<f32>(0.0);
  var alpha = 0.0;
  for (var i = 0u; i < seenCount; i = i + 1u) {
    let segment = seen[i];
    let style = labels[segment];
    if (style.a == 0.0) {
      continue;
    }
    let c = cov[i] / weightSum;
    let outer = smoothstep(SEG_ISO - halfBand, SEG_ISO + halfBand, c);
    if (outer <= 0.0) {
      continue;
    }
    let inner = smoothstep(SEG_ISO_INNER - halfBand, SEG_ISO_INNER + halfBand, c);
    let a = inner * style.a + max(outer - inner, 0.0) * BORDER_ALPHA;
    color = color + style.rgb * a;
    alpha = 1.0 - (1.0 - alpha) * (1.0 - a);
  }
  return vec4<f32>(min(color, vec3<f32>(1.0)), alpha);
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4<f32> {
  let px = in.position.xy;
  if (U.segAntialias > 0.5) {
    let plane = U.focalPoint + U.right * (in.uv.x * U.halfWidth) + U.trueUp * (in.uv.y * U.halfHeight);
    let q = worldToIndex(plane);
    return resolveAntialiased(px, q);
  }
  return resolveAliased(px);
}
`;
}
