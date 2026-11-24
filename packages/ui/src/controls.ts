import type { PlayerInput } from '@openstreet-racer/shared';

const FORWARD_KEYS = new Set(['w', 'arrowup']);
const BRAKE_KEYS = new Set(['s', 'arrowdown']);
const LEFT_KEYS = new Set(['a', 'arrowleft']);
const RIGHT_KEYS = new Set(['d', 'arrowright']);
const HANDBRAKE_KEYS = new Set(['space']);
const CONTROL_KEYS = new Set([
  ...FORWARD_KEYS,
  ...BRAKE_KEYS,
  ...LEFT_KEYS,
  ...RIGHT_KEYS,
  ...HANDBRAKE_KEYS,
]);

export class InputController {
  private readonly pressed = new Set<string>();
  private touchVertical = 0;
  private touchSteering = 0;
  private readonly joystick: HTMLElement;
  private readonly knob: HTMLElement;
  private pointerId: number | null = null;
  private mode: 'keyboard' | 'touch' | 'both' = 'both';
  private readonly keyDownHandler: (event: KeyboardEvent) => void;
  private readonly keyUpHandler: (event: KeyboardEvent) => void;
  private readonly blurHandler: () => void;
  private readonly pointerDownHandler: (event: PointerEvent) => void;
  private readonly pointerMoveHandler: (event: PointerEvent) => void;
  private readonly pointerUpHandler: (event: PointerEvent) => void;

  constructor(joystick: HTMLElement, knob: HTMLElement) {
    this.joystick = joystick;
    this.knob = knob;
    this.keyDownHandler = (event) => this.onKeyDown(event);
    this.keyUpHandler = (event) => this.onKeyUp(event);
    this.blurHandler = () => this.clearInput();
    this.pointerDownHandler = (event) => this.onPointerDown(event);
    this.pointerMoveHandler = (event) => this.onPointerMove(event);
    this.pointerUpHandler = (event) => this.onPointerUp(event);
    window.addEventListener('keydown', this.keyDownHandler);
    window.addEventListener('keyup', this.keyUpHandler);
    window.addEventListener('blur', this.blurHandler);
    this.joystick.addEventListener('pointerdown', this.pointerDownHandler);
    this.joystick.addEventListener('pointermove', this.pointerMoveHandler);
    this.joystick.addEventListener('pointerup', this.pointerUpHandler);
    this.joystick.addEventListener('pointercancel', this.pointerUpHandler);
  }

  read(): PlayerInput {
    const keyboardEnabled = this.mode !== 'touch';
    const touchEnabled = this.mode !== 'keyboard';
    const keyboardSteering = keyboardEnabled
      ? Number(this.hasAny(RIGHT_KEYS)) - Number(this.hasAny(LEFT_KEYS))
      : 0;
    const touchThrottle = touchEnabled ? Math.max(this.touchVertical, 0) : 0;
    const touchBrake = touchEnabled ? Math.max(-this.touchVertical, 0) : 0;
    return {
      steer: strongest(touchEnabled ? this.touchSteering : 0, keyboardSteering),
      throttle: Math.max(keyboardEnabled ? Number(this.hasAny(FORWARD_KEYS)) : 0, touchThrottle),
      brake: Math.max(keyboardEnabled ? Number(this.hasAny(BRAKE_KEYS)) : 0, touchBrake),
      handbrake: keyboardEnabled ? Number(this.hasAny(HANDBRAKE_KEYS)) : 0,
    };
  }

  setMode(mode: 'keyboard' | 'touch' | 'both'): void {
    this.mode = mode;
    this.clearInput();
    document.body.dataset.controlMode = mode;
  }

  destroy(): void {
    window.removeEventListener('keydown', this.keyDownHandler);
    window.removeEventListener('keyup', this.keyUpHandler);
    window.removeEventListener('blur', this.blurHandler);
    this.joystick.removeEventListener('pointerdown', this.pointerDownHandler);
    this.joystick.removeEventListener('pointermove', this.pointerMoveHandler);
    this.joystick.removeEventListener('pointerup', this.pointerUpHandler);
    this.joystick.removeEventListener('pointercancel', this.pointerUpHandler);
    this.clearInput();
  }

  private hasAny(keys: Set<string>): boolean {
    return [...keys].some((key) => this.pressed.has(key));
  }

  private onKeyDown(event: KeyboardEvent): void {
    const key = keyName(event);
    if (!CONTROL_KEYS.has(key) || isInteractiveTarget(event.target)) return;
    event.preventDefault();
    this.pressed.add(key);
  }

  private onKeyUp(event: KeyboardEvent): void {
    this.pressed.delete(keyName(event));
  }

  private onPointerDown(event: PointerEvent): void {
    this.pointerId = event.pointerId;
    this.joystick.setPointerCapture(event.pointerId);
    this.onPointerMove(event);
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.pointerId !== event.pointerId) return;
    const bounds = this.joystick.getBoundingClientRect();
    const radius = bounds.width * 0.36;
    const deltaX = event.clientX - (bounds.left + bounds.width / 2);
    const deltaY = event.clientY - (bounds.top + bounds.height / 2);
    const magnitude = Math.max(Math.hypot(deltaX, deltaY), 1);
    const scale = Math.min(1, radius / magnitude);
    const x = deltaX * scale;
    const y = deltaY * scale;
    this.touchSteering = clamp(x / radius, -1, 1);
    this.touchVertical = clamp(-y / radius, -1, 1);
    this.knob.style.transform = `translate(${x}px, ${y}px)`;
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.pointerId !== event.pointerId) return;
    this.pointerId = null;
    this.touchVertical = 0;
    this.touchSteering = 0;
    this.knob.style.transform = 'translate(0, 0)';
  }

  private clearInput(): void {
    this.pressed.clear();
    this.pointerId = null;
    this.touchVertical = 0;
    this.touchSteering = 0;
    this.knob.style.transform = 'translate(0, 0)';
  }
}

function keyName(event: KeyboardEvent): string {
  return event.code === 'Space' ? 'space' : event.key.toLowerCase();
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest('input, textarea, select, button, a, [contenteditable="true"]'))
  );
}

function strongest(touch: number, keyboard: number): number {
  return Math.abs(touch) > Math.abs(keyboard) ? touch : keyboard;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
