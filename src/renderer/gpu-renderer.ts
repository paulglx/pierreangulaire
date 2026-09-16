import { bytesPerVoxel, CELL_SIZE } from '../brick-store';
import type { BlendMode } from '../blend';
import type { VolumeFormat } from '../geometry';
import { dot } from '../math';
import type { DebugView, Viewport } from '../viewport';
import { applyRescale, type Volume } from '../volume';
import {
  cellTextureFormat,
  poolSampleType,
  poolTexelType,
  poolTextureFormat,
  slotOrigin,
  type TexelType,
} from './atlas';
import { raycastShader, SEG_SLOTS_PER_AXIS, segmentationResolveShader } from './raycast-shader';
import type { Renderer } from './renderer';

const UNIFORM_FLOATS = 48;
const RANGE_FLOATS = 4;
const TIMESTAMP_BYTES = 16;
const SEG_SLOTS_PER_LAYER = SEG_SLOTS_PER_AXIS * SEG_SLOTS_PER_AXIS;

interface VolumeResource {
  format: VolumeFormat;
  pool: GPUTexture;
  poolView: GPUTextureView;
  cellTexture: GPUTexture;
  cellView: GPUTextureView;
  rangeTexture: GPUTexture;
  rangeView: GPUTextureView;
  rangeData: Float32Array;
  pageTexture: GPUTexture;
  pageView: GPUTextureView;
  pageData: Int32Array;
  segOccupancy: Uint8Array;
  segAtlas: GPUTexture | null;
  segAtlasView: GPUTextureView | null;
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
  timing: FrameTiming | null;
}

interface FrameTiming {
  querySet: GPUQuerySet;
  resolveBuffer: GPUBuffer;
  readBuffer: GPUBuffer;
  pending: boolean;
}

export class GPURenderer implements Renderer {
  private device!: GPUDevice;
  private format!: GPUTextureFormat;
  private resolvePipeline!: GPURenderPipeline;
  private resolveBindGroupLayout!: GPUBindGroupLayout;
  private emptySegTexture!: GPUTexture;
  private emptySegView!: GPUTextureView;

  private timestampsSupported = false;

  private readonly layouts = new Map<TexelType, GPUBindGroupLayout>();
  private readonly modules = new Map<string, GPUShaderModule>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();
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
    this.timestampsSupported = adapter.features.has('timestamp-query');
    this.device = await adapter.requestDevice({
      requiredFeatures: this.timestampsSupported ? ['timestamp-query'] : [],
      requiredLimits: {
        maxBufferSize: adapter.limits.maxBufferSize,
        maxTextureDimension3D: adapter.limits.maxTextureDimension3D,
      },
    });
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.emptySegTexture = this.device.createTexture({
      size: { width: 1, height: 1, depthOrArrayLayers: 1 },
      dimension: '3d',
      format: 'rgba16uint',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    this.emptySegView = this.emptySegTexture.createView();

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
          buffer: { type: 'read-only-storage' },
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

  private layoutFor(format: VolumeFormat): GPUBindGroupLayout {
    const texelType = poolTexelType(format);
    const existing = this.layouts.get(texelType);
    if (existing) return existing;
    const layout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: poolSampleType(format), viewDimension: '3d' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'uint', viewDimension: '3d' },
        },
        {
          binding: 3,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'read-only-storage' },
        },
        {
          binding: 4,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float', viewDimension: '3d' },
        },
        {
          binding: 5,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'sint', viewDimension: '3d' },
        },
        {
          binding: 6,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: poolSampleType(format), viewDimension: '3d' },
        },
      ],
    });
    this.layouts.set(texelType, layout);
    return layout;
  }

  private moduleFor(format: VolumeFormat, segEnabled: boolean): GPUShaderModule {
    const texelType = poolTexelType(format);
    const key = `${texelType}:${segEnabled}`;
    const existing = this.modules.get(key);
    if (existing) return existing;
    const module = this.device.createShaderModule({ code: raycastShader(texelType, segEnabled) });
    this.modules.set(key, module);
    return module;
  }

  private pipelineFor(
    format: VolumeFormat,
    blendMode: BlendMode,
    segEnabled: boolean,
    debugView: DebugView,
  ): GPURenderPipeline {
    const key = `${poolTexelType(format)}:${blendMode}:${segEnabled}:${debugView}`;
    const existing = this.pipelines.get(key);
    if (existing) return existing;
    const module = this.moduleFor(format, segEnabled);
    const targets: GPUColorTargetState[] = [{ format: this.format }];
    if (segEnabled) targets.push({ format: 'rgba32uint' });
    const pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.layoutFor(format)] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: {
        module,
        entryPoint: 'fs',
        constants: { BLEND_MODE: blendMode, DEBUG_VIEW: debugView },
        targets,
      },
      primitive: { topology: 'triangle-list' },
    });
    this.pipelines.set(key, pipeline);
    return pipeline;
  }

  onVolumeCreated(volume: Volume): void {
    const [nbx, nby, nbz] = volume.store.bricksPerAxis;
    const brickCount = nbx * nby * nbz;
    const [dx, dy, dz] = volume.geometry.dims;
    const maxDimension = this.device.limits.maxTextureDimension3D;
    if (Math.max(dx, dy, dz) > maxDimension) {
      throw new Error(
        `Volume ${dx}×${dy}×${dz} exceeds the device's 3D texture limit of ${maxDimension}.`,
      );
    }
    const pool = this.device.createTexture({
      size: { width: dx, height: dy, depthOrArrayLayers: dz },
      dimension: '3d',
      format: poolTextureFormat(volume.format),
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const cellTexture = this.device.createTexture({
      size: {
        width: Math.ceil(dx / CELL_SIZE),
        height: Math.ceil(dy / CELL_SIZE),
        depthOrArrayLayers: Math.ceil(dz / CELL_SIZE),
      },
      dimension: '3d',
      format: cellTextureFormat(volume.format),
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const rangeTexture = this.device.createTexture({
      size: { width: nbx, height: nby, depthOrArrayLayers: nbz },
      dimension: '3d',
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const pageTexture = this.device.createTexture({
      size: { width: nbx, height: nby, depthOrArrayLayers: nbz },
      dimension: '3d',
      format: 'r32sint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.volumes.set(volume.id, {
      format: volume.format,
      pool,
      poolView: pool.createView(),
      cellTexture,
      cellView: cellTexture.createView(),
      rangeTexture,
      rangeView: rangeTexture.createView(),
      rangeData: new Float32Array(brickCount * RANGE_FLOATS),
      pageTexture,
      pageView: pageTexture.createView(),
      pageData: new Int32Array(brickCount),
      segOccupancy: new Uint8Array(brickCount),
      segAtlas: null,
      segAtlasView: null,
      segSlotCount: 0,
      labelBuffer: this.device.createBuffer({
        size: volume.segmentation.labelTable.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }),
      labelVersion: -1,
    });
  }

  onVolumeDestroyed(id: string): void {
    const resource = this.volumes.get(id);
    if (!resource) return;
    releaseVolumeResource(resource);
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
    const { bricksPerAxis } = volume.store;
    const rowBytes = bytesPerVoxel(volume.format);
    for (const index of brickIndices) {
      const brick = volume.store.readBrick(index);
      const [w, h, d] = brick.size;
      const [x, y, z] = brick.origin;
      this.device.queue.writeTexture(
        { texture: resource.pool, origin: { x, y, z } },
        brick.data,
        { bytesPerRow: w * rowBytes, rowsPerImage: h },
        { width: w, height: h, depthOrArrayLayers: d },
      );
      const [cx, cy, cz] = brick.cellGrid;
      this.device.queue.writeTexture(
        {
          texture: resource.cellTexture,
          origin: { x: x / CELL_SIZE, y: y / CELL_SIZE, z: z / CELL_SIZE },
        },
        brick.cellRanges,
        { bytesPerRow: cx * rowBytes * 2, rowsPerImage: cy },
        { width: cx, height: cy, depthOrArrayLayers: cz },
      );
      const lo = applyRescale(volume.rescale, brick.min);
      const hi = applyRescale(volume.rescale, brick.max);
      resource.rangeData[index * RANGE_FLOATS] = Math.min(lo, hi);
      resource.rangeData[index * RANGE_FLOATS + 1] = Math.max(lo, hi);
      resource.rangeData[index * RANGE_FLOATS + 3] = 1;
      this.writeRangeTexel(resource, bricksPerAxis, index);
    }
  }

  uploadSegmentationBricks(volume: Volume, brickIndices: number[]): void {
    const resource = this.volumes.get(volume.id);
    if (!resource) return;
    const brickSize = volume.segmentation.brickSize;
    let slotsNeeded = resource.segSlotCount;
    for (const index of brickIndices) {
      if (resource.pageData[index] === 0) slotsNeeded++;
    }
    this.ensureSegAtlasCapacity(resource, brickSize, slotsNeeded);
    const grid = volume.segmentation.bricksPerAxis;
    const changed: number[] = [];
    for (const index of brickIndices) {
      const brick = volume.segmentation.readBrick(index);
      const [w, h, d] = brick.size;
      let slotEntry = resource.pageData[index]!;
      if (slotEntry === 0) {
        slotEntry = ++resource.segSlotCount;
        resource.pageData[index] = slotEntry;
        this.writePageTexel(resource, grid, index);
      }
      this.device.queue.writeTexture(
        {
          texture: resource.segAtlas!,
          origin: slotOrigin(slotEntry - 1, SEG_SLOTS_PER_AXIS, brickSize),
        },
        brick.data,
        { bytesPerRow: w * 8, rowsPerImage: h },
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
    this.device.queue.writeTexture(
      { texture: resource.rangeTexture, origin: brickTexel(grid, index) },
      resource.rangeData,
      { offset: index * RANGE_FLOATS * 4, bytesPerRow: RANGE_FLOATS * 4, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
  }

  private writePageTexel(
    resource: VolumeResource,
    grid: readonly [number, number, number],
    index: number,
  ): void {
    this.device.queue.writeTexture(
      { texture: resource.pageTexture, origin: brickTexel(grid, index) },
      resource.pageData,
      { offset: index * 4, bytesPerRow: 4, rowsPerImage: 1 },
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
      format: 'rgba16uint',
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
      timing: this.timestampsSupported ? this.createFrameTiming() : null,
    });
  }

  private createFrameTiming(): FrameTiming {
    return {
      querySet: this.device.createQuerySet({ type: 'timestamp', count: 2 }),
      resolveBuffer: this.device.createBuffer({
        size: TIMESTAMP_BYTES,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      }),
      readBuffer: this.device.createBuffer({
        size: TIMESTAMP_BYTES,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      }),
      pending: false,
    };
  }

  resizeViewport(_viewport: Viewport): void {}

  destroyViewport(id: string): void {
    const resource = this.viewports.get(id);
    if (!resource) return;
    resource.context.unconfigure();
    resource.uniformBuffer.destroy();
    resource.segTarget?.texture.destroy();
    if (resource.timing) {
      resource.timing.querySet.destroy();
      resource.timing.resolveBuffer.destroy();
      resource.timing.readBuffer.destroy();
    }
    this.viewports.delete(id);
  }

  render(viewports: readonly Viewport[]): void {
    const encoder = this.device.createCommandEncoder();
    let submitted = false;
    const timed: { viewport: Viewport; timing: FrameTiming }[] = [];
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
        resource.bindGroup = this.device.createBindGroup({
          layout: this.layoutFor(volumeResource.format),
          entries: [
            { binding: 0, resource: { buffer: resource.uniformBuffer } },
            { binding: 1, resource: volumeResource.poolView },
            { binding: 2, resource: segView },
            { binding: 3, resource: { buffer: volumeResource.labelBuffer } },
            { binding: 4, resource: volumeResource.rangeView },
            { binding: 5, resource: volumeResource.pageView },
            { binding: 6, resource: volumeResource.cellView },
          ],
        });
        resource.bindGroupVolumeId = viewport.volume.id;
        resource.bindGroupSegView = segView;
      }

      const segmentation = viewport.volume.segmentation;
      if (volumeResource.labelVersion !== segmentation.labelVersion) {
        this.device.queue.writeBuffer(volumeResource.labelBuffer, 0, segmentation.labelTable);
        volumeResource.labelVersion = segmentation.labelVersion;
      }

      const segEnabled = viewport.segmentationVisible && volumeResource.segAtlas !== null;
      writeUniforms(resource.uniformData, viewport, viewport.segmentationAntialiasing);
      this.device.queue.writeBuffer(resource.uniformBuffer, 0, resource.uniformData);

      const canvasTexture = resource.context.getCurrentTexture();
      const canvasView = canvasTexture.createView();
      const colorAttachments: GPURenderPassColorAttachment[] = [
        {
          view: canvasView,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ];
      let segTarget = resource.segTarget;
      if (segEnabled) {
        if (
          segTarget === null ||
          segTarget.texture.width !== canvasTexture.width ||
          segTarget.texture.height !== canvasTexture.height
        ) {
          segTarget?.texture.destroy();
          const texture = this.device.createTexture({
            size: { width: canvasTexture.width, height: canvasTexture.height },
            format: 'rgba32uint',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
          });
          segTarget = { texture, view: texture.createView() };
          resource.segTarget = segTarget;
          resource.resolveBindGroup = null;
          resource.resolveBindGroupVolumeId = null;
        }
        colorAttachments.push({
          view: segTarget.view,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        });
      }

      const timing = resource.timing !== null && !resource.timing.pending ? resource.timing : null;
      const pass = encoder.beginRenderPass({
        colorAttachments,
        timestampWrites: timing
          ? {
              querySet: timing.querySet,
              beginningOfPassWriteIndex: 0,
              endOfPassWriteIndex: segEnabled ? undefined : 1,
            }
          : undefined,
      });
      pass.setPipeline(
        this.pipelineFor(volumeResource.format, viewport.blendMode, segEnabled, viewport.debugView),
      );
      pass.setBindGroup(0, resource.bindGroup);
      pass.draw(3);
      pass.end();

      if (segEnabled && segTarget) {
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
          timestampWrites: timing
            ? { querySet: timing.querySet, endOfPassWriteIndex: 1 }
            : undefined,
        });
        resolvePass.setPipeline(this.resolvePipeline);
        resolvePass.setBindGroup(0, resource.resolveBindGroup);
        resolvePass.draw(3);
        resolvePass.end();
      }
      if (timing) {
        encoder.resolveQuerySet(timing.querySet, 0, 2, timing.resolveBuffer, 0);
        encoder.copyBufferToBuffer(timing.resolveBuffer, 0, timing.readBuffer, 0, TIMESTAMP_BYTES);
        timing.pending = true;
        timed.push({ viewport, timing });
      }
      submitted = true;
    }
    if (submitted) {
      this.device.queue.submit([encoder.finish()]);
    }
    for (const entry of timed) void readFrameTiming(entry.viewport, entry.timing);
  }

  destroy(): void {
    for (const id of this.viewports.keys()) this.destroyViewport(id);
    for (const resource of this.volumes.values()) releaseVolumeResource(resource);
    this.volumes.clear();
    this.emptySegTexture.destroy();
    this.device.destroy();
  }
}

async function readFrameTiming(viewport: Viewport, timing: FrameTiming): Promise<void> {
  try {
    await timing.readBuffer.mapAsync(GPUMapMode.READ);
    const stamps = new BigUint64Array(timing.readBuffer.getMappedRange());
    viewport.renderTimeMs = Number(stamps[1]! - stamps[0]!) / 1e6;
    timing.readBuffer.unmap();
  } catch {
    return;
  } finally {
    timing.pending = false;
  }
}

function releaseVolumeResource(resource: VolumeResource): void {
  resource.pool.destroy();
  resource.cellTexture.destroy();
  resource.rangeTexture.destroy();
  resource.pageTexture.destroy();
  resource.segAtlas?.destroy();
  resource.labelBuffer.destroy();
}

function brickTexel(grid: readonly [number, number, number], index: number): GPUOrigin3DDict {
  const [nbx, nby] = grid;
  return {
    x: index % nbx,
    y: Math.floor(index / nbx) % nby,
    z: Math.floor(index / (nbx * nby)),
  };
}

function hasLabels(data: Uint16Array): number {
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

function writeUniforms(arr: Float32Array, viewport: Viewport, segAntialias: boolean): void {
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
  arr[27] = segAntialias ? 1 : 0;
  arr[28] = origin[0];
  arr[29] = origin[1];
  arr[30] = origin[2];

  const voxelsPerWorld = Math.hypot(
    dot(right, direction[0]) / spacing[0],
    dot(right, direction[1]) / spacing[1],
    dot(right, direction[2]) / spacing[2],
  );
  const worldPerPixel = (2 * halfHeight) / viewport.canvas.height;
  arr[31] = worldPerPixel * voxelsPerWorld;

  const store = viewport.volume.store;
  arr[32] = spacing[0];
  arr[33] = spacing[1];
  arr[34] = spacing[2];
  arr[35] = store.brickSize;
  arr[36] = dims[0];
  arr[37] = dims[1];
  arr[38] = dims[2];
  arr[39] = viewport.volume.rescale.slope;
  arr[40] = store.bricksPerAxis[0];
  arr[41] = store.bricksPerAxis[1];
  arr[42] = store.bricksPerAxis[2];
  arr[43] = viewport.volume.rescale.intercept;
  arr[44] = Math.ceil(dims[0] / CELL_SIZE);
  arr[45] = Math.ceil(dims[1] / CELL_SIZE);
  arr[46] = Math.ceil(dims[2] / CELL_SIZE);
  arr[47] = CELL_SIZE;
}
