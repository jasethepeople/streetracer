import { describe, expect, it } from 'vitest';
import {
  renderHud,
  renderWantedElement,
  wantedChaseLabel,
  wantedStarString,
  type HudElements,
} from './hud';

function fakeElement(): HTMLElement {
  return {
    textContent: '',
    hidden: false,
    dataset: {} as Record<string, string>,
  } as unknown as HTMLElement;
}

function fakeElements(withWanted: boolean): HudElements & { wanted?: HTMLElement } {
  const elements: HudElements & { wanted?: HTMLElement } = {
    speed: fakeElement(),
    street: fakeElement(),
    location: fakeElement(),
    status: fakeElement(),
  };
  if (withWanted) elements.wanted = fakeElement();
  return elements;
}

const baseState = {
  speedMetersPerSecond: 10,
  streetName: 'Main Street',
  locationLabel: 'Denver',
  statusMessage: 'ok',
};

describe('wantedStarString', () => {
  it('renders exact star displays', () => {
    expect(wantedStarString(0)).toBe('☆☆☆☆☆');
    expect(wantedStarString(3)).toBe('★★★☆☆');
    expect(wantedStarString(5)).toBe('★★★★★');
    expect(wantedStarString(9, 5)).toBe('★★★★★');
    expect(wantedStarString(2.7)).toBe('★★☆☆☆');
  });
});

describe('wantedChaseLabel', () => {
  it('labels chase states for screen readers and CSS hooks', () => {
    expect(wantedChaseLabel('chase')).toBe('In pursuit');
    expect(wantedChaseLabel('evading')).toBe('Evading');
    expect(wantedChaseLabel('clear')).toBe('');
  });
});

describe('renderWantedElement', () => {
  it('shows stars with chase, flash, and siren data attributes', () => {
    const element = fakeElement();
    renderWantedElement(element, { level: 3, chaseState: 'chase', flash: true, siren: true });
    expect(element.hidden).toBe(false);
    expect(element.textContent).toBe('★★★☆☆');
    expect(element.dataset.chase).toBe('chase');
    expect(element.dataset.chaseLabel).toBe('In pursuit');
    expect(element.dataset.flash).toBe('true');
    expect(element.dataset.siren).toBe('true');
  });

  it('renders evading state without siren', () => {
    const element = fakeElement();
    renderWantedElement(element, { level: 2, chaseState: 'evading', siren: false });
    expect(element.hidden).toBe(false);
    expect(element.dataset.chase).toBe('evading');
    expect(element.dataset.chaseLabel).toBe('Evading');
    expect(element.dataset.flash).toBe('false');
    expect(element.dataset.siren).toBe('false');
  });

  it('always exposes a non-empty chase label while the wanted element is visible', () => {
    // The stylesheets render the label via `.wanted-stars::after` with
    // `content: attr(data-chase-label)`, so a visible element must always
    // carry label text.
    const element = fakeElement();
    for (const chaseState of ['chase', 'evading'] as const) {
      renderWantedElement(element, { level: 1, chaseState });
      expect(element.hidden).toBe(false);
      expect(element.dataset.chaseLabel).not.toBe('');
    }
    renderWantedElement(element, { level: 0, chaseState: 'clear' });
    expect(element.dataset.chaseLabel).toBe('');
  });

  it('hides when the wanted state is clear', () => {
    const element = fakeElement();
    renderWantedElement(element, { level: 0, chaseState: 'clear' });
    expect(element.hidden).toBe(true);
    expect(element.dataset.chase).toBe('clear');
    renderWantedElement(element, null);
    expect(element.hidden).toBe(true);
    renderWantedElement(element, undefined);
    expect(element.hidden).toBe(true);
  });
});

describe('renderHud wanted integration', () => {
  it('keeps the old 4-element HUD working without a wanted element', () => {
    const elements = fakeElements(false);
    expect(() => renderHud(elements, { ...baseState })).not.toThrow();
    expect(elements.speed.textContent).toBe('36 km/h');
    expect(elements.street.textContent).toBe('Main Street');
  });

  it('keeps the old 4-element HUD working when wanted state is omitted', () => {
    const elements = fakeElements(true);
    renderHud(elements, { ...baseState });
    expect(elements.wanted!.hidden).toBe(true);
    expect(elements.wanted!.dataset.chase).toBe('clear');
  });

  it('renders the wanted element through renderHud', () => {
    const elements = fakeElements(true);
    renderHud(elements, {
      ...baseState,
      wanted: { level: 4, chaseState: 'chase', flash: true, siren: true },
    });
    expect(elements.wanted!.textContent).toBe('★★★★☆');
    expect(elements.wanted!.dataset.chase).toBe('chase');
    expect(elements.wanted!.dataset.siren).toBe('true');
  });
});
