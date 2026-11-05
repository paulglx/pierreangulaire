import { type CanvasPoint, scrollSlices, sliceRange } from '../camera';
import { sub } from '../math';
import type { DragGesture, Tool, ToolEvent, ToolStepEvent } from './tool';

const ZOOM_PER_STEP = 1.5;
const ZOOM_PER_CANVAS_HEIGHT = Math.exp(4);
const ROTATION_PER_CANVAS_HEIGHT = Math.PI;
const WINDOW_WIDTH_PER_CANVAS_HEIGHT = Math.exp(2);

function verticalTravel(from: CanvasPoint, to: CanvasPoint, event: ToolEvent): number {
  return (to.y - from.y) / event.viewport.canvas.height;
}

function horizontalTravel(from: CanvasPoint, to: CanvasPoint, event: ToolEvent): number {
  return (to.x - from.x) / event.viewport.canvas.height;
}

export class PanTool implements Tool {
  readonly name = 'Pan';

  beginDrag(start: ToolEvent): DragGesture {
    let grabbed = start.worldPoint;
    return {
      move(event) {
        const { viewport } = event;
        viewport.camera.pan(sub(grabbed, viewport.canvasToWorld(event.canvasPoint)));
        grabbed = viewport.canvasToWorld(event.canvasPoint);
        viewport.markDirty();
      },
    };
  }
}

export class ZoomTool implements Tool {
  readonly name = 'Zoom';

  beginDrag(start: ToolEvent): DragGesture {
    let previous = start.canvasPoint;
    return {
      move(event) {
        const travel = verticalTravel(previous, event.canvasPoint, event);
        previous = event.canvasPoint;
        event.viewport.camera.zoomAt(ZOOM_PER_CANVAS_HEIGHT ** -travel, start.worldPoint);
        event.viewport.markDirty();
      },
    };
  }

  step(event: ToolStepEvent): void {
    event.viewport.camera.zoomAt(ZOOM_PER_STEP ** event.steps, event.worldPoint);
    event.viewport.markDirty();
  }
}

export class SlabScrollTool implements Tool {
  readonly name = 'SlabScroll';
  private readonly pendingSteps = new Map<string, number>();

  beginDrag(start: ToolEvent): DragGesture {
    let previous = start.canvasPoint;
    let pending = 0;
    return {
      move(event) {
        const { viewport } = event;
        const { first, last } = sliceRange(
          viewport.volume.geometry,
          viewport.camera.basis().normal,
        );
        pending += verticalTravel(previous, event.canvasPoint, event) * (last - first + 1);
        previous = event.canvasPoint;
        const whole = Math.trunc(pending);
        if (whole === 0) return;
        pending -= whole;
        scrollSlices(viewport.camera, viewport.volume.geometry, whole);
        viewport.markDirty();
      },
    };
  }

  step(event: ToolStepEvent): void {
    const { viewport } = event;
    const pending = (this.pendingSteps.get(viewport.id) ?? 0) + event.steps;
    const whole = Math.trunc(pending);
    this.pendingSteps.set(viewport.id, pending - whole);
    if (whole === 0) return;
    scrollSlices(viewport.camera, viewport.volume.geometry, whole);
    viewport.markDirty();
  }
}

export class RotateTool implements Tool {
  readonly name = 'Rotate';

  beginDrag(start: ToolEvent): DragGesture {
    let previous = start.canvasPoint;
    return {
      move(event) {
        const { camera } = event.viewport;
        const { right, trueUp } = camera.basis();
        const yaw =
          horizontalTravel(previous, event.canvasPoint, event) * ROTATION_PER_CANVAS_HEIGHT;
        const pitch =
          verticalTravel(previous, event.canvasPoint, event) * ROTATION_PER_CANVAS_HEIGHT;
        previous = event.canvasPoint;
        camera.rotateAround(start.worldPoint, trueUp, -yaw);
        camera.rotateAround(start.worldPoint, right, -pitch);
        event.viewport.markDirty();
      },
    };
  }
}

export class WindowLevelTool implements Tool {
  readonly name = 'WindowLevel';

  beginDrag(start: ToolEvent): DragGesture {
    let previous = start.canvasPoint;
    return {
      move(event) {
        const { viewport } = event;
        const { center, width } = viewport.windowLevel;
        const widthTravel = horizontalTravel(previous, event.canvasPoint, event);
        const centerTravel = verticalTravel(previous, event.canvasPoint, event);
        previous = event.canvasPoint;
        viewport.setWindowLevel({
          center: center + centerTravel * width,
          width: width * WINDOW_WIDTH_PER_CANVAS_HEIGHT ** widthTravel,
        });
      },
    };
  }
}
