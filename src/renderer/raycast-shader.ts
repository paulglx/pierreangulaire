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
  pad0: f32,
  spacing: vec3<f32>,
  pad1: f32,
  dims: vec3<f32>,
  pad2: f32,
};

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var volume: texture_3d<f32>;

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

  var maxValue = -3.0e38;
  var minValue = 3.0e38;
  var sum = 0.0;
  var hits = 0.0;
  var compositeColor = 0.0;
  var compositeAlpha = 0.0;

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
  return vec4<f32>(gray, gray, gray, 1.0);
}
`;
