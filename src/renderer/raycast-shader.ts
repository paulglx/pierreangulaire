export const RAYCAST_SHADER = /* wgsl */ `
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
};

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var volume: texture_3d<f32>;
@group(0) @binding(2) var segmentation: texture_3d<u32>;
@group(0) @binding(3) var<uniform> labels: array<vec4<f32>, 256>;

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

const BORDER_ALPHA = 0.9;
const SEG_ISO = 0.5;
const SEG_ISO_INNER = 0.82;
const SEG_BORDER_WIDTH = 3.0;
const SEG_KERNEL: i32 = 3;
const SEG_SUPPORT = 3.5;

fn worldDirToIndex(v: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(
    dot(v, U.dirCol0) / U.spacing.x,
    dot(v, U.dirCol1) / U.spacing.y,
    dot(v, U.dirCol2) / U.spacing.z,
  );
}

fn planeStep(v: vec3<f32>) -> vec3<f32> {
  let d = worldDirToIndex(v);
  let m = max(max(abs(d.x), abs(d.y)), abs(d.z));
  return d / max(m, 1e-6);
}

fn slotsAt(q: vec3<f32>) -> vec4<u32> {
  let maxIndex = vec3<i32>(U.dims) - vec3<i32>(1);
  let c = clamp(vec3<i32>(round(q)), vec3<i32>(0), maxIndex);
  return textureLoad(segmentation, c, 0);
}

fn loadSlotsAt(c: vec3<i32>) -> vec4<u32> {
  let maxIndex = vec3<i32>(U.dims) - vec3<i32>(1);
  return textureLoad(segmentation, clamp(c, vec3<i32>(0), maxIndex), 0);
}

fn containsSegment(slots: vec4<u32>, segment: u32) -> bool {
  return any(slots == vec4<u32>(segment));
}

fn sampleSegmentation(q: vec3<f32>, rightStep: vec3<f32>, upStep: vec3<f32>) -> vec4<f32> {
  var slots = slotsAt(q);
  if (all(slots == vec4<u32>(0u))) {
    return vec4<f32>(0.0);
  }
  let borderRight = rightStep * SEG_BORDER_WIDTH;
  let borderUp = upStep * SEG_BORDER_WIDTH;
  let nl = slotsAt(q - borderRight);
  let nr = slotsAt(q + borderRight);
  let nd = slotsAt(q - borderUp);
  let nu = slotsAt(q + borderUp);
  var color = vec3<f32>(0.0);
  var alpha = 0.0;
  for (var s = 0u; s < 4u; s = s + 1u) {
    let segment = slots[s];
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

fn sampleSegmentationAntialiased(q: vec3<f32>, rightStep: vec3<f32>, upStep: vec3<f32>) -> vec4<f32> {
  let gateRight = rightStep * f32(SEG_KERNEL);
  let gateUp = upStep * f32(SEG_KERNEL);
  if (all(slotsAt(q) == vec4<u32>(0u))
    && all(slotsAt(q - gateRight) == vec4<u32>(0u)) && all(slotsAt(q + gateRight) == vec4<u32>(0u))
    && all(slotsAt(q - gateUp) == vec4<u32>(0u)) && all(slotsAt(q + gateUp) == vec4<u32>(0u))) {
    return vec4<f32>(0.0);
  }

  var seen: array<u32, 16>;
  var cov: array<f32, 16>;
  var seenCount = 0u;
  var weightSum = 0.0;
  let center = vec3<i32>(round(q));
  for (var dz = -SEG_KERNEL; dz <= SEG_KERNEL; dz = dz + 1) {
    for (var dy = -SEG_KERNEL; dy <= SEG_KERNEL; dy = dy + 1) {
      for (var dx = -SEG_KERNEL; dx <= SEG_KERNEL; dx = dx + 1) {
        let v = center + vec3<i32>(dx, dy, dz);
        let r = q - vec3<f32>(v);
        let t = dot(r, r) / (SEG_SUPPORT * SEG_SUPPORT);
        if (t >= 1.0) {
          continue;
        }
        let edge = 1.0 - t;
        let weight = edge * edge;
        weightSum = weightSum + weight;
        let slots = loadSlotsAt(v);
        for (var s = 0u; s < 4u; s = s + 1u) {
          let segment = slots[s];
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

fn inBounds(q: vec3<f32>) -> bool {
  return all(q >= vec3<f32>(0.0)) && all(q <= (U.dims - vec3<f32>(1.0)));
}

fn applyWindow(value: f32) -> f32 {
  let low = U.windowCenter - U.windowWidth * 0.5;
  return clamp((value - low) / U.windowWidth, 0.0, 1.0);
}

@fragment
fn fs(in: VertexOut) -> @location(0) vec4<f32> {
  let plane = U.focalPoint + U.right * (in.uv.x * U.halfWidth) + U.trueUp * (in.uv.y * U.halfHeight);
  let count = max(u32(U.sampleCount), 1u);
  let start = plane - U.normal * (U.slabThickness * 0.5);
  let rightStep = planeStep(U.right);
  let upStep = planeStep(U.trueUp);

  var maxValue = -3.0e38;
  var minValue = 3.0e38;
  var sum = 0.0;
  var hits = 0.0;
  var compositeColor = 0.0;
  var compositeAlpha = 0.0;
  var segColor = vec3<f32>(0.0);
  var segAlpha = 0.0;

  for (var i = 0u; i < count; i = i + 1u) {
    var frac = 0.5;
    if (count > 1u) {
      frac = f32(i) / f32(count - 1u);
    }
    let pos = start + U.normal * (U.slabThickness * frac);
    let q = worldToIndex(pos);
    if (!inBounds(q)) {
      continue;
    }
    let value = sampleTrilinear(q);
    maxValue = max(maxValue, value);
    minValue = min(minValue, value);
    sum = sum + value;
    hits = hits + 1.0;
    let gray = applyWindow(value);
    compositeColor = compositeColor + (1.0 - compositeAlpha) * gray * gray;
    compositeAlpha = compositeAlpha + (1.0 - compositeAlpha) * gray;
    if (U.segEnabled > 0.5) {
      var seg = vec4<f32>(0.0);
      if (U.segAntialias > 0.5) {
        seg = sampleSegmentationAntialiased(q, rightStep, upStep);
      } else {
        seg = sampleSegmentation(q, rightStep, upStep);
      }
      segColor = segColor + (1.0 - segAlpha) * seg.rgb;
      segAlpha = segAlpha + (1.0 - segAlpha) * seg.a;
    }
  }

  if (hits == 0.0) {
    return vec4<f32>(0.0, 0.0, 0.0, 1.0);
  }

  let mode = u32(U.blendMode);
  var gray = 0.0;
  if (mode == 0u) {
    gray = applyWindow(maxValue);
  } else if (mode == 1u) {
    gray = applyWindow(minValue);
  } else if (mode == 2u) {
    gray = applyWindow(sum / hits);
  } else {
    gray = compositeColor;
  }
  let rgb = vec3<f32>(gray) * (1.0 - segAlpha) + segColor;
  return vec4<f32>(rgb, 1.0);
}
`;
