import type { CanvasPoint } from '../camera';
import type { Viewport } from '../viewport';
import type {
  Binding,
  DragGesture,
  Modifier,
  MouseButton,
  Tool,
  ToolEvent,
  ToolState,
} from './tool';

const WHEEL_PIXELS_PER_STEP = 100;
const WHEEL_LINES_PER_STEP = 3;
const BUTTONS: readonly (MouseButton | undefined)[] = ['primary', 'auxiliary', 'secondary'];
const MODIFIER_ORDER: readonly Modifier[] = ['shift', 'ctrl', 'alt', 'meta'];
const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable]';

interface Registration {
  state: ToolState;
  bindings: readonly Binding[];
}

interface BoundTool {
  readonly tool: Tool;
  readonly binding: Binding;
}

interface ActiveGesture {
  readonly pointerId: number;
  readonly viewport: Viewport;
  readonly drag: DragGesture;
}

interface Hover {
  readonly viewport: Viewport;
  canvasPoint: CanvasPoint;
}

function modifiersOf(event: MouseEvent | KeyboardEvent): Modifier[] {
  const modifiers: Modifier[] = [];
  if (event.shiftKey) modifiers.push('shift');
  if (event.ctrlKey) modifiers.push('ctrl');
  if (event.altKey) modifiers.push('alt');
  if (event.metaKey) modifiers.push('meta');
  return modifiers;
}

function modifierKey(modifiers: readonly Modifier[] = []): string {
  return MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier)).join('+');
}

function triggerKey(binding: Binding): string {
  if ('button' in binding) return `button:${binding.button}`;
  if ('wheel' in binding) return 'wheel';
  return `key:${binding.key}`;
}

function bindingKey(binding: Binding): string {
  return `${triggerKey(binding)}|${modifierKey(binding.modifiers)}`;
}

function wheelSteps(event: WheelEvent): number {
  const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return delta / WHEEL_LINES_PER_STEP;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return delta;
  return delta / WHEEL_PIXELS_PER_STEP;
}

function canvasPointOf(canvas: HTMLCanvasElement, event: MouseEvent): CanvasPoint {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) * canvas.width) / rect.width,
    y: ((event.clientY - rect.top) * canvas.height) / rect.height,
  };
}

function isEditable(target: EventTarget | null): boolean {
  const element = target as Partial<Element> | null;
  return element?.closest?.(EDITABLE_SELECTOR) != null;
}

export class ToolManager {
  private readonly registrations = new Map<Tool, Registration>();
  private readonly boundTools = new Map<string, BoundTool>();
  private readonly detachers = new Map<string, () => void>();
  private gesture: ActiveGesture | null = null;
  private hover: Hover | null = null;

  add<T extends Tool>(tool: T): T {
    if (!this.registrations.has(tool)) {
      this.registrations.set(tool, { state: 'disabled', bindings: [] });
    }
    return tool;
  }

  state(tool: Tool): ToolState {
    return this.registrationOf(tool).state;
  }

  bindings(tool: Tool): readonly Binding[] {
    return this.registrationOf(tool).bindings;
  }

  setActive(tool: Tool, bindings: readonly Binding[]): void {
    const registration = this.registrationOf(tool);
    for (const binding of bindings) this.assertSupported(tool, binding);
    const claimed = new Set(bindings.map(bindingKey));
    for (const [other, otherRegistration] of this.registrations) {
      if (other === tool) continue;
      otherRegistration.bindings = otherRegistration.bindings.filter(
        (binding) => !claimed.has(bindingKey(binding)),
      );
      if (otherRegistration.state === 'active' && otherRegistration.bindings.length === 0) {
        otherRegistration.state = 'passive';
      }
    }
    registration.bindings = [...bindings];
    registration.state = bindings.length > 0 ? 'active' : 'passive';
    this.rebuildBoundTools();
  }

  setPassive(tool: Tool): void {
    this.setInactive(tool, 'passive');
  }

  setDisabled(tool: Tool): void {
    this.setInactive(tool, 'disabled');
  }

  attach(viewport: Viewport): void {
    this.detach(viewport.id);
    const { canvas } = viewport;
    const document = canvas.ownerDocument;
    const listeners: [EventTarget, string, EventListener, AddEventListenerOptions?][] = [
      [canvas, 'pointerdown', (event) => this.onPointerDown(viewport, event as PointerEvent)],
      [canvas, 'pointermove', (event) => this.onPointerMove(viewport, event as PointerEvent)],
      [canvas, 'pointerup', (event) => this.endGesture(event as PointerEvent)],
      [canvas, 'pointercancel', (event) => this.endGesture(event as PointerEvent)],
      [canvas, 'lostpointercapture', (event) => this.endGesture(event as PointerEvent)],
      [canvas, 'pointerleave', () => this.onPointerLeave(viewport)],
      [canvas, 'wheel', (event) => this.onWheel(viewport, event as WheelEvent), { passive: false }],
      [canvas, 'contextmenu', (event) => event.preventDefault()],
      [canvas, 'mousedown', (event) => this.onMouseDown(event as MouseEvent)],
    ];
    if (document) {
      listeners.push([
        document,
        'keydown',
        (event) => this.onKeyDown(viewport, event as KeyboardEvent),
      ]);
    }
    for (const [target, type, listener, options] of listeners) {
      target.addEventListener(type, listener, options);
    }
    this.detachers.set(viewport.id, () => {
      for (const [target, type, listener, options] of listeners) {
        target.removeEventListener(type, listener, options);
      }
    });
  }

  detach(viewportId: string): void {
    this.detachers.get(viewportId)?.();
    this.detachers.delete(viewportId);
    if (this.gesture?.viewport.id === viewportId) this.gesture = null;
    if (this.hover?.viewport.id === viewportId) this.hover = null;
  }

  destroy(): void {
    for (const viewportId of this.detachers.keys()) this.detach(viewportId);
    this.registrations.clear();
    this.boundTools.clear();
  }

  private registrationOf(tool: Tool): Registration {
    const registration = this.registrations.get(tool);
    if (!registration) throw new Error(`Tool ${tool.name} is not registered. Call add() first.`);
    return registration;
  }

  private assertSupported(tool: Tool, binding: Binding): void {
    const supported = 'button' in binding ? tool.beginDrag !== undefined : tool.step !== undefined;
    if (!supported) {
      throw new Error(`Tool ${tool.name} does not support the ${triggerKey(binding)} trigger.`);
    }
  }

  private setInactive(tool: Tool, state: 'passive' | 'disabled'): void {
    const registration = this.registrationOf(tool);
    registration.state = state;
    registration.bindings = [];
    this.rebuildBoundTools();
  }

  private rebuildBoundTools(): void {
    this.boundTools.clear();
    for (const [tool, registration] of this.registrations) {
      if (registration.state !== 'active') continue;
      for (const binding of registration.bindings) {
        this.boundTools.set(bindingKey(binding), { tool, binding });
      }
    }
  }

  private find(trigger: string, event: MouseEvent | KeyboardEvent): BoundTool | undefined {
    return this.boundTools.get(`${trigger}|${modifierKey(modifiersOf(event))}`);
  }

  private toolEvent(viewport: Viewport, canvasPoint: CanvasPoint): ToolEvent {
    return { viewport, canvasPoint, worldPoint: viewport.canvasToWorld(canvasPoint) };
  }

  private onPointerDown(viewport: Viewport, event: PointerEvent): void {
    if (this.gesture) return;
    const button = BUTTONS[event.button];
    if (!button) return;
    const bound = this.find(`button:${button}`, event);
    if (!bound?.tool.beginDrag) return;
    event.preventDefault();
    viewport.canvas.setPointerCapture(event.pointerId);
    const canvasPoint = canvasPointOf(viewport.canvas, event);
    this.hover = { viewport, canvasPoint };
    this.gesture = {
      pointerId: event.pointerId,
      viewport,
      drag: bound.tool.beginDrag(this.toolEvent(viewport, canvasPoint)),
    };
  }

  private onPointerMove(viewport: Viewport, event: PointerEvent): void {
    const canvasPoint = canvasPointOf(viewport.canvas, event);
    this.hover = { viewport, canvasPoint };
    if (this.gesture?.pointerId !== event.pointerId || this.gesture.viewport !== viewport) return;
    this.gesture.drag.move(this.toolEvent(viewport, canvasPoint));
  }

  private endGesture(event: PointerEvent): void {
    const gesture = this.gesture;
    if (gesture?.pointerId !== event.pointerId) return;
    this.gesture = null;
    if (gesture.viewport.canvas.hasPointerCapture(event.pointerId)) {
      gesture.viewport.canvas.releasePointerCapture(event.pointerId);
    }
    gesture.drag.end?.();
  }

  private onPointerLeave(viewport: Viewport): void {
    if (this.hover?.viewport === viewport && this.gesture?.viewport !== viewport) this.hover = null;
  }

  private onMouseDown(event: MouseEvent): void {
    if (event.button === 1) event.preventDefault();
  }

  private onWheel(viewport: Viewport, event: WheelEvent): void {
    const bound = this.find('wheel', event);
    if (!bound?.tool.step) return;
    event.preventDefault();
    const canvasPoint = canvasPointOf(viewport.canvas, event);
    this.hover = { viewport, canvasPoint };
    bound.tool.step({ ...this.toolEvent(viewport, canvasPoint), steps: wheelSteps(event) });
  }

  private onKeyDown(viewport: Viewport, event: KeyboardEvent): void {
    if (this.hover?.viewport !== viewport || isEditable(event.target)) return;
    const bound = this.find(`key:${event.key}`, event);
    if (!bound?.tool.step || !('key' in bound.binding)) return;
    event.preventDefault();
    bound.tool.step({
      ...this.toolEvent(viewport, this.hover.canvasPoint),
      steps: bound.binding.steps,
    });
  }
}
