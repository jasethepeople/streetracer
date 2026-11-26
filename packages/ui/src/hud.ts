export interface HudElements {
  speed: HTMLElement;
  street: HTMLElement;
  location: HTMLElement;
  status: HTMLElement;
  /** Optional wanted-level element; old 4-element HUDs keep working. */
  wanted?: HTMLElement;
}

export type HudChaseState = 'clear' | 'chase' | 'evading';

export interface HudWantedState {
  /** Wanted level in stars, 0–maxLevel. */
  readonly level: number;
  readonly maxLevel?: number;
  readonly chaseState?: HudChaseState;
  /** True when the stars should flash (high heat / high level). */
  readonly flash?: boolean;
  /** True while a police siren is audible. */
  readonly siren?: boolean;
}

export interface HudState {
  speedMetersPerSecond: number;
  streetName: string | null;
  locationLabel: string;
  statusMessage: string;
  /** Optional wanted state; omitted/level 0 hides the wanted element. */
  wanted?: HudWantedState;
}

export const HUD_WANTED_MAX_LEVEL = 5;
export const WANTED_STAR_FILLED = '★';
export const WANTED_STAR_EMPTY = '☆';

/** Exact star display, e.g. level 3 of 5 renders as `★★★☆☆`. */
export function wantedStarString(level: number, maxLevel = HUD_WANTED_MAX_LEVEL): string {
  const max =
    Number.isFinite(maxLevel) && maxLevel > 0 ? Math.floor(maxLevel) : HUD_WANTED_MAX_LEVEL;
  const filled = Math.max(0, Math.min(max, Math.floor(Number.isFinite(level) ? level : 0)));
  return WANTED_STAR_FILLED.repeat(filled) + WANTED_STAR_EMPTY.repeat(max - filled);
}

export function wantedChaseLabel(chaseState: HudChaseState): string {
  if (chaseState === 'chase') return 'In pursuit';
  if (chaseState === 'evading') return 'Evading';
  return '';
}

/**
 * Renders the wanted element: star display plus `data-chase`,
 * `data-chase-label`, `data-flash`, and `data-siren` attributes. The element
 * is hidden whenever the wanted state is clear (no state or level 0).
 */
export function renderWantedElement(
  element: HTMLElement,
  state: HudWantedState | null | undefined,
): void {
  const level = state ? Math.max(0, Math.floor(state.level)) : 0;
  const chaseState: HudChaseState = level <= 0 ? 'clear' : (state?.chaseState ?? 'chase');
  if (!state || level <= 0 || chaseState === 'clear') {
    element.hidden = true;
    element.dataset.chase = 'clear';
    element.dataset.chaseLabel = '';
    element.dataset.flash = 'false';
    element.dataset.siren = 'false';
    return;
  }
  element.hidden = false;
  element.textContent = wantedStarString(level, state.maxLevel);
  element.dataset.chase = chaseState;
  element.dataset.chaseLabel = wantedChaseLabel(chaseState);
  element.dataset.flash = String(state.flash === true);
  element.dataset.siren = String(state.siren === true);
}

export function renderHud(elements: HudElements, state: HudState): void {
  const speed = Math.round(Math.abs(state.speedMetersPerSecond) * 3.6);
  elements.speed.textContent = `${speed} km/h`;
  elements.street.textContent = state.streetName ?? 'Finding a street…';
  elements.location.textContent = state.locationLabel;
  elements.status.textContent = state.statusMessage;
  if (elements.wanted) {
    renderWantedElement(elements.wanted, state.wanted ?? null);
  }
}
