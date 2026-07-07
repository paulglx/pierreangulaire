import type { Segmentation } from '../segmentation';
import type { Viewport } from '../viewport';
import type { Volume } from '../volume';
import { RAYCAST_SHADER } from './raycast-shader';
import type { Renderer } from './renderer';

const UNIFORM_FLOATS = 40;
const MAX_SAMPLES = 512;
const LABEL_FLOATS = 256 * 4;

interface VolumeResource {
  texture: GPUTexture;
  view: GPUTextureView;
  segTexture: GPUTexture | null;
  segView: GPUTextureView | null;
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
}

export class GPURenderer implements Renderer {
  private device!: GPUDevice;
  private format!: GPUTextureFormat;
  private pipeline!: GPURenderPipeline;
  private bindGroupLayout!: GPUBindGroupLayout;
  private emptySegTexture!: GPUTexture;
  private emptySegView!: GPUTextureView;

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
    this.device = await adapter.requestDevice({
      requiredLimits: {
        maxBufferSize: adapter.limits.maxBufferSize,
        maxTextureDimension3D: adapter.limits.maxTextureDimension3D,
      },
    });
    this.format = navigator.gpu.getPreferredCanvasFormat();

    const module = this.device.createShaderModule({ code: RAYCAST_SHADER });
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float', viewDimension: '3d' },
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
      ],
    });
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
      fragment: { module, entryPoint: 'fs', targets: [{ format: this.format }] },
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
    this.volumes.set(volume.id, {
      texture,
      view: texture.createView(),
      segTexture: null,
      segView: null,
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
    resource.segTexture?.destroy();
    resource.labelBuffer.destroy();
    this.volumes.delete(id);
    for (const viewport of this.viewports.values()) {
      if (viewport.bindGroupVolumeId === id) {
        viewport.bindGroup = null;
        viewport.bindGroupVolumeId = null;
        viewport.bindGroupSegView = null;
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
    }
  }

  uploadSegmentationBricks(volume: Volume, brickIndices: number[]): void {
    const resource = this.volumes.get(volume.id);
    if (!resource) return;
    if (!resource.segTexture) {
      const [width, height, depth] = volume.geometry.dims;
      resource.segTexture = this.device.createTexture({
        size: { width, height, depthOrArrayLayers: depth },
        dimension: '3d',
        format: 'rgba8uint',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      resource.segView = resource.segTexture.createView();
    }
    for (const index of brickIndices) {
      const brick = volume.segmentation.readBrick(index);
      const [w, h, d] = brick.size;
      this.device.queue.writeTexture(
        {
          texture: resource.segTexture,
          origin: { x: brick.origin[0], y: brick.origin[1], z: brick.origin[2] },
        },
        brick.data,
        { bytesPerRow: w * 4, rowsPerImage: h },
        { width: w, height: h, depthOrArrayLayers: d },
      );
    }
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
    });
  }

  resizeViewport(_viewport: Viewport): void {}

  destroyViewport(id: string): void {
    const resource = this.viewports.get(id);
    if (!resource) return;
    resource.context.unconfigure();
    resource.uniformBuffer.destroy();
    this.viewports.delete(id);
  }

  render(viewports: readonly Viewport[]): void {
    const encoder = this.device.createCommandEncoder();
    let submitted = false;
    for (const viewport of viewports) {
      const resource = this.viewports.get(viewport.id);
      const volumeResource = this.volumes.get(viewport.volume.id);
      if (!resource || !volumeResource) continue;

      const segView = volumeResource.segView ?? this.emptySegView;
      if (
        resource.bindGroup === null ||
        resource.bindGroupVolumeId !== viewport.volume.id ||
        resource.bindGroupSegView !== segView
      ) {
        resource.bindGroup = this.device.createBindGroup({
          layout: this.bindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: resource.uniformBuffer } },
            { binding: 1, resource: volumeResource.view },
            { binding: 2, resource: segView },
            { binding: 3, resource: { buffer: volumeResource.labelBuffer } },
          ],
        });
        resource.bindGroupVolumeId = viewport.volume.id;
        resource.bindGroupSegView = segView;
      }

      const segmentation = viewport.volume.segmentation;
      if (volumeResource.labelVersion !== segmentation.labelVersion) {
        this.device.queue.writeBuffer(volumeResource.labelBuffer, 0, labelData(segmentation));
        volumeResource.labelVersion = segmentation.labelVersion;
      }

      const segEnabled = viewport.segmentationVisible && volumeResource.segTexture !== null;
      writeUniforms(resource.uniformData, viewport, segEnabled);
      this.device.queue.writeBuffer(resource.uniformBuffer, 0, resource.uniformData);

      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: resource.context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, resource.bindGroup);
      pass.draw(3);
      pass.end();
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
      resource.segTexture?.destroy();
      resource.labelBuffer.destroy();
    }
    this.volumes.clear();
    this.emptySegTexture.destroy();
    this.device.destroy();
  }
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

function writeUniforms(arr: Float32Array, viewport: Viewport, segEnabled: boolean): void {
  const camera = viewport.camera;
  const { right, trueUp, normal } = camera.basis();
  const geometry = viewport.volume.geometry;
  const aspect = viewport.canvas.width / viewport.canvas.height;
  const halfHeight = camera.zoom;
  const halfWidth = camera.zoom * aspect;
  const minSpacing = Math.min(...geometry.spacing);
  const sampleCount = Math.min(
    MAX_SAMPLES,
    Math.max(1, Math.ceil(viewport.slabThickness / minSpacing)),
  );
  const { focalPoint } = camera;
  const { direction, origin, spacing, dims } = geometry;

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
  arr[36] = dims[0];
  arr[37] = dims[1];
  arr[38] = dims[2];
}
