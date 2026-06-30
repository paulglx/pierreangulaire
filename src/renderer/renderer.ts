import type { Viewport } from '../viewport';
import type { Volume } from '../volume';

export interface Renderer {
  initialize(): Promise<void>;
  registerViewport(viewport: Viewport): void;
  resizeViewport(viewport: Viewport): void;
  destroyViewport(id: string): void;
  onVolumeCreated(volume: Volume): void;
  uploadBricks(volume: Volume, brickIndices: number[]): void;
  render(viewports: readonly Viewport[]): void;
}
