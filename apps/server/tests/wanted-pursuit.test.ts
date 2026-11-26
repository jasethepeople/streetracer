import { describe, expect, it } from 'vitest';
import {
  applyNearMiss,
  createEscapeState,
  createPoliceUnit,
  createWantedState,
  damagePoliceUnit,
  NEAR_MISS_MAX_HEAT,
  NEAR_MISS_MIN_HEAT,
  NEAR_MISS_MIN_PLAYER_SPEED_MPS,
  NEAR_MISS_RADIUS_METERS,
  POLICE_SIREN_RADIUS_METERS,
  policeSirenAudible,
  pursuitStatus,
  ROADBLOCK_MIN_LEVEL,
  shouldDeployRoadblock,
  updateEscape,
} from '../src/wanted-system';

describe('near-miss heat', () => {
  it('ignores slow brushes below the closing-speed floor', () => {
    expect(applyNearMiss(createWantedState(1, 0.4), 0).heat).toBeCloseTo(0.4, 5);
    expect(applyNearMiss(createWantedState(1, 0.4), 5.9).heat).toBeCloseTo(0.4, 5);
    expect(applyNearMiss(createWantedState(), Number.NaN)).toEqual(createWantedState());
  });

  it('scales heat from 0.08 to 0.3 between 6 and 30 m/s closing speed', () => {
    expect(applyNearMiss(createWantedState(), 6).heat).toBeCloseTo(NEAR_MISS_MIN_HEAT, 5);
    expect(applyNearMiss(createWantedState(), 18).heat).toBeCloseTo(0.19, 5);
    expect(applyNearMiss(createWantedState(), 30).heat).toBeCloseTo(NEAR_MISS_MAX_HEAT, 5);
    expect(applyNearMiss(createWantedState(), 90).heat).toBeCloseTo(NEAR_MISS_MAX_HEAT, 5);
  });

  it('repeated near-misses escalate the wanted level', () => {
    let state = createWantedState();
    for (let index = 0; index < 5; index += 1) {
      state = applyNearMiss(state, 25);
    }
    expect(state.level).toBeGreaterThanOrEqual(1);
  });

  it('gates detection below opposing-lane separation and slow driving', () => {
    // Ordinary opposing-lane passes sit ~3.5 m apart laterally, so the
    // detection radius must stay below that to avoid false positives, and
    // a slow player crawling through a tight gap is never flagged.
    expect(NEAR_MISS_RADIUS_METERS).toBeLessThan(3.5);
    expect(NEAR_MISS_MIN_PLAYER_SPEED_MPS).toBeGreaterThanOrEqual(8);
  });
});

describe('roadblock gating', () => {
  it('only deploys roadblocks at ROADBLOCK_MIN_LEVEL (4) and above', () => {
    expect(ROADBLOCK_MIN_LEVEL).toBe(4);
    expect(shouldDeployRoadblock(0)).toBe(false);
    expect(shouldDeployRoadblock(3)).toBe(false);
    expect(shouldDeployRoadblock(4)).toBe(true);
    expect(shouldDeployRoadblock(5)).toBe(true);
    expect(shouldDeployRoadblock(Number.NaN)).toBe(false);
  });
});

describe('pursuit status', () => {
  it('reports clear, chase, roadblock, and evading explicitly', () => {
    const chase = createPoliceUnit('police-chase', { longitude: 0, latitude: 0 }, 0, 'chase');
    const block = createPoliceUnit('police-block', { longitude: 0, latitude: 0 }, 0, 'roadblock');
    const down = createPoliceUnit('police-down', { longitude: 0, latitude: 0 }, 0);
    damagePoliceUnit(down, 100);
    expect(pursuitStatus(0, [chase], true)).toBe('clear');
    expect(pursuitStatus(2, [chase], true)).toBe('chase');
    expect(pursuitStatus(4, [block], true)).toBe('roadblock');
    expect(pursuitStatus(4, [chase, block], false)).toBe('roadblock');
    expect(pursuitStatus(2, [chase], false)).toBe('evading');
    expect(pursuitStatus(2, [], true)).toBe('evading');
    expect(pursuitStatus(2, [down], true)).toBe('evading');
  });
});

describe('police siren audibility', () => {
  it('is audible within the default 250 m radius and silent beyond it', () => {
    expect(POLICE_SIREN_RADIUS_METERS).toBe(250);
    const player = { longitude: 0, latitude: 0 };
    const near = createPoliceUnit('police-near', { longitude: 0, latitude: 0.001 }, 0); // ~111 m
    const far = createPoliceUnit('police-far', { longitude: 0, latitude: 0.004 }, 0); // ~445 m
    expect(policeSirenAudible(player, [near])).toBe(true);
    expect(policeSirenAudible(player, [far])).toBe(false);
    expect(policeSirenAudible(player, [far], 500)).toBe(true);
    expect(policeSirenAudible(player, [])).toBe(false);
  });

  it('ignores disabled units', () => {
    const unit = createPoliceUnit('police-down', { longitude: 0, latitude: 0 }, 0);
    expect(policeSirenAudible({ longitude: 0, latitude: 0 }, [unit])).toBe(true);
    damagePoliceUnit(unit, 100);
    expect(policeSirenAudible({ longitude: 0, latitude: 0 }, [unit])).toBe(false);
  });
});

describe('escape rules', () => {
  it('escapes after 8 seconds with broken line of sight', () => {
    let state = createEscapeState();
    expect(state.escaped).toBe(false);
    state = updateEscape(state, { visible: false, nearestUnitMeters: 120, elapsedSeconds: 7.9 });
    expect(state.escaped).toBe(false);
    state = updateEscape(state, { visible: false, nearestUnitMeters: 120, elapsedSeconds: 0.2 });
    expect(state.escaped).toBe(true);
  });

  it('resets the hidden timer when a unit regains line of sight', () => {
    let state = createEscapeState();
    state = updateEscape(state, { visible: false, nearestUnitMeters: 100, elapsedSeconds: 7 });
    state = updateEscape(state, { visible: true, nearestUnitMeters: 40, elapsedSeconds: 1 });
    expect(state.hiddenSeconds).toBe(0);
    state = updateEscape(state, { visible: false, nearestUnitMeters: 100, elapsedSeconds: 7.5 });
    expect(state.escaped).toBe(false);
  });

  it('escapes after 3 seconds beyond 350 m separation', () => {
    let state = createEscapeState();
    state = updateEscape(state, { visible: false, nearestUnitMeters: 400, elapsedSeconds: 2.9 });
    expect(state.escaped).toBe(false);
    state = updateEscape(state, { visible: false, nearestUnitMeters: 500, elapsedSeconds: 0.2 });
    expect(state.escaped).toBe(true);
  });

  it('treats no active units as infinite distance', () => {
    let state = createEscapeState();
    state = updateEscape(state, {
      visible: false,
      nearestUnitMeters: Number.POSITIVE_INFINITY,
      elapsedSeconds: 2,
    });
    expect(state.escaped).toBe(false);
    state = updateEscape(state, {
      visible: false,
      nearestUnitMeters: Number.NaN,
      elapsedSeconds: 1.5,
    });
    expect(state.escaped).toBe(true);
  });

  it('stays escaped while the player keeps line of sight broken', () => {
    let state = createEscapeState();
    state = updateEscape(state, {
      visible: false,
      nearestUnitMeters: Number.POSITIVE_INFINITY,
      elapsedSeconds: 3,
    });
    expect(state.escaped).toBe(true);
    state = updateEscape(state, { visible: false, nearestUnitMeters: 500, elapsedSeconds: 1 });
    expect(state.escaped).toBe(true);
  });

  it('re-engages the pursuit when a unit regains line of sight after an escape', () => {
    // Regression: escaped used to stick forever, so roadblocks and chase
    // cooldown never resumed once the player had broken away.
    let state = createEscapeState();
    state = updateEscape(state, {
      visible: false,
      nearestUnitMeters: 500,
      elapsedSeconds: 3,
    });
    expect(state.escaped).toBe(true);
    // Staying hidden keeps the escape…
    state = updateEscape(state, { visible: false, nearestUnitMeters: 400, elapsedSeconds: 1 });
    expect(state.escaped).toBe(true);
    // …but a visible unit re-acquiring the player clears it immediately.
    state = updateEscape(state, { visible: true, nearestUnitMeters: 60, elapsedSeconds: 0.5 });
    expect(state.escaped).toBe(false);
    expect(state.hiddenSeconds).toBe(0);
    expect(state.separatedSeconds).toBe(0);
    // The re-engaged pursuit behaves like a fresh one: escape timers run
    // again from zero instead of staying pinned.
    state = updateEscape(state, { visible: false, nearestUnitMeters: 100, elapsedSeconds: 7.9 });
    expect(state.escaped).toBe(false);
    state = updateEscape(state, { visible: false, nearestUnitMeters: 100, elapsedSeconds: 0.2 });
    expect(state.escaped).toBe(true);
  });
});
