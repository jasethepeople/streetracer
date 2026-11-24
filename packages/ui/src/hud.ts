export interface HudElements {
  speed: HTMLElement;
  street: HTMLElement;
  location: HTMLElement;
  status: HTMLElement;
}

export interface HudState {
  speedMetersPerSecond: number;
  streetName: string | null;
  locationLabel: string;
  statusMessage: string;
}

export function renderHud(elements: HudElements, state: HudState): void {
  const speed = Math.round(Math.abs(state.speedMetersPerSecond) * 3.6);
  elements.speed.textContent = `${speed} km/h`;
  elements.street.textContent = state.streetName ?? 'Finding a street…';
  elements.location.textContent = state.locationLabel;
  elements.status.textContent = state.statusMessage;
}
