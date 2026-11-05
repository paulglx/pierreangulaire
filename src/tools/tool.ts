import type { CanvasPoint } from '../camera';
import type { Vec3 } from '../math';
import type { Viewport } from '../viewport';

export type Modifier = 'shift' | 'ctrl' | 'alt' | 'meta';

export type MouseButton = 'primary' | 'secondary' | 'auxiliary';

export type Binding =
  | { readonly button: MouseButton; readonly modifiers?: readonly Modifier[] }
  | { readonly wheel: true; readonly steps?: number; readonly modifiers?: readonly Modifier[] }
  | { readonly key: string; readonly steps: number; readonly modifiers?: readonly Modifier[] };

export type ToolState = 'active' | 'passive' | 'disabled';

export interface ToolEvent {
  readonly viewport: Viewport;
  readonly canvasPoint: CanvasPoint;
  readonly worldPoint: Vec3;
}

export interface ToolStepEvent extends ToolEvent {
  readonly steps: number;
}

export interface DragGesture {
  move(event: ToolEvent): void;
  end?(): void;
}

export interface Tool {
  readonly name: string;
  beginDrag?(event: ToolEvent): DragGesture;
  step?(event: ToolStepEvent): void;
}
