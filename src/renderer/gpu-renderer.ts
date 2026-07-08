import { dot } from '../math';
import type { Segmentation } from '../segmentation';
import type { Viewport } from '../viewport';
import type { Volume } from '../volume';
import { raycastShader, SEG_SLOTS_PER_AXIS, segmentationResolveShader } from './raycast-shader';
import type { Renderer } from './renderer';

const UNIFORM_FLOATS = 48;
const LABEL_FLOATS = 256 * 4;
const RANGE_FLOATS = 4;
const SEG_SLOTS_PER_LAYER = SEG_SLOTS_PER_AXIS * SEG_SLOTS_PER_AXIS;

interface VolumeResource {
  texture: GPUTexture;
  view: GPUTextureView;
  rangeTexture: GPUTexture;
  rangeView: GPUTextureView;
  rangeData: Float32Array;
  segOccupancy: Uint8Array;
  segAtlas: GPUTexture | null;
  segAtlasView: GPUTextureView | null;
  segSlots: Int32Array;
  segSlotCount: number;
  labelBuffer: GPUBuffer;
  labelVersion: number;
}

interface ViewportResource {
  context: GPUCanvasContext;
  uniformBuffer: GPUBuffer;
  uniformData: Float32Array;
  bindGroup: GPUBindGroup | null;
  bindGroupVolumeId: string | null;
  bindGroupSegView: GPUTextureView | null;
  segTarget: { texture: GPUTexture; view: GPUTextureView } | null;
  resolveBindGroup: GPUBindGroup | null;
  resolveBindGroupVolumeId: string | null;
}

export class GPURenderer implements Renderer {
  private device!: GPUDevice;
  private format!: GPUTextureFormat;
  private pipeline!: GPURenderPipeline;
  private bindGroupLayout!: GPUBindGroupLayout;
  private resolvePipeline!: GPURenderPipeline;
  private resolveBindGroupLayout!: GPUBindGroupLayout;
  private emptySegTexture!: GPUTexture;
  private emptySegView!: GPUTextureView;
  private volumeSampler: GPUSampler | null = null;

  private readonly volumes = new Map<string, VolumeResource>();
  private readonly viewports = new Map<string, ViewportResource>();

  async initialize(): Promise<void> {
    if (!navigator.gpu) {
      throw new Error('WebGPU is not available in this browser.');
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error('No WebGPU adapter found.');
    }
    const filterable = adapter.features.has('float32-filterable');
    this.device = await adapter.requestDevice({
      requiredFeatures: filterable ? ['float32-filterable'] : [],
      requiredLimits: {
        maxBufferSize: adapter.limits.maxBufferSize,
        maxTextureDimension3D: adapter.limits.maxTextureDimension3D,
      },
    });
    this.format = navigator.gpu.getPreferredCanvasFormat();
    if (filterable) {
      this.volumeSampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    }

    const module = this.device.createShaderModule({ code: raycastShader(filterable) });
    const layoutEntries: GPUBindGroupLayoutEntry[] = [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType: filterable ? 'float' : 'unfilterable-float',
          viewDimension: '3d',
        },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'uint', viewDimension: '3d' },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'unfilterable-float', viewDimension: '3d' },
      },
    ];
    if (filterable) {
      layoutEntries.push({
        binding: 5,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: 'filtering' },
      });
    }
    this.bindGroupLayout = this.device.createBindGroupLayout({ entries: layoutEntries });
    this.emptySegTexture = this.device.createTexture({
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      dimension: '3d',
      format: 'rgba8uint',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.emptySegView = this.emptySegTexture.createView();
    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{ format: this.format }, { format: 'rg32uint' }],
      },
      primitive: { topology: 'triangle-list' },
    });

    const resolveModule = this.device.createShaderModule({ code: segmentationResolveShader() });
    this.resolveBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'uint' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });
    this.resolvePipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.resolveBindGroupLayout],
      }),
      vertex: { module: resolveModule, entryPoint: 'vs' },
      fragment: {
        module: resolveModule,
        entryPoint: 'fs',
        targets: [
          {
            format: this.format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  onVolumeCreated(volume: Volume): void {
    const [width, height, depth] = volume.geometry.dims;
    const limit = this.device.limits.maxTextureDimension3D;
    if (width > limit || height > limit || depth > limit) {
      throw new Error(`Volume ${width}x${height}x${depth} exceeds max 3D texture size ${limit}.`);
    }
    const texture = this.device.createTexture({
      size: { width, height, depthOrArrayLayers: depth },
      dimension: '3d',
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const [nbx, nby, nbz] = volume.store.bricksPerAxis;
    const brickCount = nbx * nby * nbz;
    const rangeTexture = this.device.createTexture({
      size: { width: nbx, height: nby, depthOrArrayLayers: nbz },
      dimension: '3d',
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.volumes.set(volume.id, {
      texture,
      view: texture.createView(),
      rangeTexture,
      rangeView: rangeTexture.createView(),
      rangeData: new Float32Array(brickCount * RANGE_FLOATS),
      segOccupancy: new Uint8Array(brickCount),
      segAtlas: null,
      segAtlasView: null,
      segSlots: new Int32Array(brickCount).fill(-1),
      segSlotCount: 0,
      labelBuffer: this.device.createBuffer({
        size: LABEL_FLOATS * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
      labelVersion: -1,
    });
  }

  onVolumeDestroyed(id: string): void {
    const resource = this.volumes.get(id);
    if (!resource) return;
    resource.texture.destroy();
    resource.rangeTexture.destroy();
    resource.segAtlas?.destroy();
    resource.labelBuffer.destroy();
    this.volumes.delete(id);
    for (const viewport of this.viewports.values()) {
      if (viewport.bindGroupVolumeId === id) {
        viewport.bindGroup = null;
        viewport.bindGroupVolumeId = null;
        viewport.bindGroupSegView = null;
      }
      if (viewport.resolveBindGroupVolumeId === id) {
        viewport.resolveBindGroup = null;
        viewport.resolveBindGroupVolumeId = null;
      }
    }
  }

  uploadBricks(volume: Volume, brickIndices: number[]): void {
    const resource = this.volumes.get(volume.id);
    if (!resource) return;
    for (const index of brickIndices) {
      const brick = volume.store.readBrick(index);
      const [w, h, d] = brick.size;
      this.device.queue.writeTexture(
        {
          texture: resource.texture,
          origin: { x: brick.origin[0], y: brick.origin[1], z: brick.origin[2] },
        },
        brick.data,
        { bytesPerRow: w * 4, rowsPerImage: h },
        { width: w, height: h, depthOrArrayLayers: d },
      );
      resource.rangeData[index * RANGE_FLOATS] = brick.min;
      resource.rangeData[index * RANGE_FLOATS + 1] = brick.max;
      this.writeRangeTexel(resource, volume.store.bricksPerAxis, index);
    }
  }

  uploadSegmentationBricks(volume: Volume, brickIndices: number[]): void {
    const resource = this.volumes.get(volume.id);
    if (!resource) return;
    const brickSize = volume.segmentation.brickSize;
    let slotsNeeded = resource.segSlotCount;
    for (const index of brickIndices) {
      if (resource.segSlots[index] === -1) slotsNeeded++;
    }
    this.ensureSegAtlasCapacity(resource, brickSize, slotsNeeded);
    const grid = volume.segmentation.bricksPerAxis;
    const changed: number[] = [];
    for (const index of brickIndices) {
      const brick = volume.segmentation.readBrick(index);
      const [w, h, d] = brick.size;
      let slot = resource.segSlots[index]!;
      if (slot === -1) {
        slot = resource.segSlotCount++;
        resource.segSlots[index] = slot;
        resource.rangeData[index * RANGE_FLOATS + 3] = slot + 1;
        this.writeRangeTexel(resource, grid, index);
      }
      this.device.queue.writeTexture(
        { texture: resource.segAtlas!, origin: slotOrigin(slot, brickSize) },
        brick.data,
        { bytesPerRow: w * 4, rowsPerImage: h },
        { width: w, height: h, depthOrArrayLayers: d },
      );
      const occupied = hasLabels(brick.data);
      if (resource.segOccupancy[index] !== occupied) {
        resource.segOccupancy[index] = occupied;
        changed.push(index);
      }
    }
    if (changed.length === 0) return;
    const affected = new Set<number>();
    for (const index of changed) {
      for (const neighbor of brickNeighborhood(grid, index)) affected.add(neighbor);
    }
    for (const index of affected) {
      let dilated = 0;
      for (const neighbor of brickNeighborhood(grid, index)) {
        dilated = Math.max(dilated, resource.segOccupancy[neighbor]!);
      }
      if (resource.rangeData[index * RANGE_FLOATS + 2] !== dilated) {
        resource.rangeData[index * RANGE_FLOATS + 2] = dilated;
        this.writeRangeTexel(resource, grid, index);
      }
    }
  }

  private writeRangeTexel(
    resource: VolumeResource,
    grid: readonly [number, number, number],
    index: number,
  ): void {
    const [nbx, nby] = grid;
    this.device.queue.writeTexture(
      {
        texture: resource.rangeTexture,
        origin: {
          x: index % nbx,
          y: Math.floor(index / nbx) % nby,
          z: Math.floor(index / (nbx * nby)),
        },
      },
      resource.rangeData,
      { offset: index * RANGE_FLOATS * 4, bytesPerRow: RANGE_FLOATS * 4, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
  }

  private ensureSegAtlasCapacity(
    resource: VolumeResource,
    brickSize: number,
    slotsNeeded: number,
  ): void {
    const currentLayers = resource.segAtlas ? resource.segAtlas.depthOrArrayLayers / brickSize : 0;
    if (slotsNeeded <= currentLayers * SEG_SLOTS_PER_LAYER) return;
    const maxLayers = Math.floor(this.device.limits.maxTextureDimension3D / brickSize);
    const layers = Math.min(
      maxLayers,
      Math.max(Math.ceil(slotsNeeded / SEG_SLOTS_PER_LAYER), currentLayers * 2),
    );
    if (slotsNeeded > layers * SEG_SLOTS_PER_LAYER) {
      throw new Error(
        `Segmentation atlas cannot hold ${slotsNeeded} bricks (max ${layers * SEG_SLOTS_PER_LAYER}).`,
      );
    }
    const atlas = this.device.createTexture({
      size: {
        width: SEG_SLOTS_PER_AXIS * brickSize,
        height: SEG_SLOTS_PER_AXIS * brickSize,
        depthOrArrayLayers: layers * brickSize,
      },
      dimension: '3d',
      format: 'rgba8uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
    if (resource.segAtlas) {
      const encoder = this.device.createCommandEncoder();
      encoder.copyTextureToTexture(
        { texture: resource.segAtlas },
        { texture: atlas },
        {
          width: resource.segAtlas.width,
          height: resource.segAtlas.height,
          depthOrArrayLayers: resource.segAtlas.depthOrArrayLayers,
        },
      );
      this.device.queue.submit([encoder.finish()]);
      resource.segAtlas.destroy();
    }
    resource.segAtlas = atlas;
    resource.segAtlasView = atlas.createView();
  }

  registerViewport(viewport: Viewport): void {
    const context = viewport.canvas.getContext('webgpu');
    if (!context) {
      throw new Error('Could not acquire a WebGPU canvas context.');
    }
    context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
    this.viewports.set(viewport.id, {
      context,
      uniformBuffer: this.device.createBuffer({
        size: UNIFORM_FLOATS * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
      uniformData: new Float32Array(UNIFORM_FLOATS),
      bindGroup: null,
      bindGroupVolumeId: null,
      bindGroupSegView: null,
      segTarget: null,
      resolveBindGroup: null,
      resolveBindGroupVolumeId: null,
    });
  }

  resizeViewport(_viewport: Viewport): void {}

  destroyViewport(id: string): void {
    const resource = this.viewports.get(id);
    if (!resource) return;
    resource.context.unconfigure();
    resource.uniformBuffer.destroy();
    resource.segTarget?.texture.destroy();
    this.viewports.delete(id);
  }

  render(viewports: readonly Viewport[]): void {
    const encoder = this.device.createCommandEncoder();
    let submitted = false;
    for (const viewport of viewports) {
      const resource = this.viewports.get(viewport.id);
      const volumeResource = this.volumes.get(viewport.volume.id);
      if (!resource || !volumeResource) continue;

      const segView = volumeResource.segAtlasView ?? this.emptySegView;
      if (
        resource.bindGroup === null ||
        resource.bindGroupVolumeId !== viewport.volume.id ||
        resource.bindGroupSegView !== segView
      ) {
        const entries: GPUBindGroupEntry[] = [
          { binding: 0, resource: { buffer: resource.uniformBuffer } },
          { binding: 1, resource: volumeResource.view },
          { binding: 2, resource: segView },
          { binding: 3, resource: { buffer: volumeResource.labelBuffer } },
          { binding: 4, resource: volumeResource.rangeView },
        ];
        if (this.volumeSampler) {
          entries.push({ binding: 5, resource: this.volumeSampler });
        }
        resource.bindGroup = this.device.createBindGroup({
          layout: this.bindGroupLayout,
          entries,
        });
        resource.bindGroupVolumeId = viewport.volume.id;
        resource.bindGroupSegView = segView;
      }

      const segmentation = viewport.volume.segmentation;
      if (volumeResource.labelVersion !== segmentation.labelVersion) {
        this.device.queue.writeBuffer(volumeResource.labelBuffer, 0, labelData(segmentation));
        volumeResource.labelVersion = segmentation.labelVersion;
      }

      const segEnabled = viewport.segmentationVisible && volumeResource.segAtlas !== null;
      writeUniforms(
        resource.uniformData,
        viewport,
        segEnabled,
        viewport.segmentationAntialiasing,
        viewport.debugEmptyBlocks,
      );
      this.device.queue.writeBuffer(resource.uniformBuffer, 0, resource.uniformData);

      const canvasTexture = resource.context.getCurrentTexture();
      let segTarget = resource.segTarget;
      if (
        segTarget === null ||
        segTarget.texture.width !== canvasTexture.width ||
        segTarget.texture.height !== canvasTexture.height
      ) {
        segTarget?.texture.destroy();
        const texture = this.device.createTexture({
          size: { width: canvasTexture.width, height: canvasTexture.height },
          format: 'rg32uint',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        segTarget = { texture, view: texture.createView() };
        resource.segTarget = segTarget;
        resource.resolveBindGroup = null;
        resource.resolveBindGroupVolumeId = null;
      }

      const canvasView = canvasTexture.createView();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: canvasView,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
          {
            view: segTarget.view,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: 'clear',
            storeOp: segEnabled ? 'store' : 'discard',
          },
        ],
      });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, resource.bindGroup);
      pass.draw(3);
      pass.end();

      if (segEnabled) {
        if (
          resource.resolveBindGroup === null ||
          resource.resolveBindGroupVolumeId !== viewport.volume.id
        ) {
          resource.resolveBindGroup = this.device.createBindGroup({
            layout: this.resolveBindGroupLayout,
            entries: [
              { binding: 0, resource: { buffer: resource.uniformBuffer } },
              { binding: 1, resource: segTarget.view },
              { binding: 2, resource: { buffer: volumeResource.labelBuffer } },
            ],
          });
          resource.resolveBindGroupVolumeId = viewport.volume.id;
        }
        const resolvePass = encoder.beginRenderPass({
          colorAttachments: [{ view: canvasView, loadOp: 'load', storeOp: 'store' }],
        });
        resolvePass.setPipeline(this.resolvePipeline);
        resolvePass.setBindGroup(0, resource.resolveBindGroup);
        resolvePass.draw(3);
        resolvePass.end();
      }
      submitted = true;
    }
    if (submitted) {
      this.device.queue.submit([encoder.finish()]);
    }
  }

  destroy(): void {
    for (const id of this.viewports.keys()) this.destroyViewport(id);
    for (const resource of this.volumes.values()) {
      resource.texture.destroy();
      resource.rangeTexture.destroy();
      resource.segAtlas?.destroy();
      resource.labelBuffer.destroy();
    }
    this.volumes.clear();
    this.emptySegTexture.destroy();
    this.device.destroy();
  }
}

function slotOrigin(slot: number, brickSize: number): GPUOrigin3DDict {
  return {
    x: (slot % SEG_SLOTS_PER_AXIS) * brickSize,
    y: (Math.floor(slot / SEG_SLOTS_PER_AXIS) % SEG_SLOTS_PER_AXIS) * brickSize,
    z: Math.floor(slot / SEG_SLOTS_PER_LAYER) * brickSize,
  };
}

function hasLabels(data: Uint8Array): number {
  for (let i = 0; i < data.length; i++) {
    if (data[i] !== 0) return 1;
  }
  return 0;
}

function brickNeighborhood(grid: readonly [number, number, number], index: number): number[] {
  const [nbx, nby, nbz] = grid;
  const bx = index % nbx;
  const by = Math.floor(index / nbx) % nby;
  const bz = Math.floor(index / (nbx * nby));
  const out: number[] = [];
  for (let z = Math.max(0, bz - 1); z <= Math.min(nbz - 1, bz + 1); z++) {
    for (let y = Math.max(0, by - 1); y <= Math.min(nby - 1, by + 1); y++) {
      for (let x = Math.max(0, bx - 1); x <= Math.min(nbx - 1, bx + 1); x++) {
        out.push(x + y * nbx + z * nbx * nby);
      }
    }
  }
  return out;
}

function labelData(segmentation: Segmentation): Float32Array {
  const data = new Float32Array(LABEL_FLOATS);
  for (let segment = 1; segment < 256; segment++) {
    const style = segmentation.getLabelStyle(segment);
    if (!style.visible) continue;
    const offset = segment * 4;
    data[offset] = style.color[0];
    data[offset + 1] = style.color[1];
    data[offset + 2] = style.color[2];
    data[offset + 3] = style.opacity;
  }
  return data;
}

function writeUniforms(
  arr: Float32Array,
  viewport: Viewport,
  segEnabled: boolean,
  segAntialias: boolean,
  debugEmptyBlocks: boolean,
): void {
  const camera = viewport.camera;
  const { right, trueUp, normal } = camera.basis();
  const geometry = viewport.volume.geometry;
  const aspect = viewport.canvas.width / viewport.canvas.height;
  const halfHeight = camera.zoom;
  const halfWidth = camera.zoom * aspect;
  const { focalPoint } = camera;
  const { direction, origin, spacing, dims } = geometry;
  const samplesPerWorld = Math.hypot(
    dot(normal, direction[0]) / spacing[0],
    dot(normal, direction[1]) / spacing[1],
    dot(normal, direction[2]) / spacing[2],
  );
  const sampleCount = Math.max(1, Math.ceil(viewport.slabThickness * samplesPerWorld));

  arr[0] = right[0];
  arr[1] = right[1];
  arr[2] = right[2];
  arr[3] = halfWidth;
  arr[4] = trueUp[0];
  arr[5] = trueUp[1];
  arr[6] = trueUp[2];
  arr[7] = halfHeight;
  arr[8] = normal[0];
  arr[9] = normal[1];
  arr[10] = normal[2];
  arr[11] = viewport.slabThickness;
  arr[12] = focalPoint[0];
  arr[13] = focalPoint[1];
  arr[14] = focalPoint[2];
  arr[15] = sampleCount;
  arr[16] = direction[0][0];
  arr[17] = direction[0][1];
  arr[18] = direction[0][2];
  arr[19] = viewport.windowLevel.center;
  arr[20] = direction[1][0];
  arr[21] = direction[1][1];
  arr[22] = direction[1][2];
  arr[23] = viewport.windowLevel.width;
  arr[24] = direction[2][0];
  arr[25] = direction[2][1];
  arr[26] = direction[2][2];
  arr[27] = viewport.blendMode;
  arr[28] = origin[0];
  arr[29] = origin[1];
  arr[30] = origin[2];
  arr[31] = segEnabled ? 1 : 0;
  arr[32] = spacing[0];
  arr[33] = spacing[1];
  arr[34] = spacing[2];
  arr[35] = segAntialias ? 1 : 0;
  arr[36] = dims[0];
  arr[37] = dims[1];
  arr[38] = dims[2];

  const voxelsPerWorld = Math.hypot(
    dot(right, direction[0]) / spacing[0],
    dot(right, direction[1]) / spacing[1],
    dot(right, direction[2]) / spacing[2],
  );
  const worldPerPixel = (2 * halfHeight) / viewport.canvas.height;
  arr[39] = worldPerPixel * voxelsPerWorld;

  const store = viewport.volume.store;
  arr[40] = store.bricksPerAxis[0];
  arr[41] = store.bricksPerAxis[1];
  arr[42] = store.bricksPerAxis[2];
  arr[43] = store.brickSize;
  arr[44] = debugEmptyBlocks ? 1 : 0;
}
