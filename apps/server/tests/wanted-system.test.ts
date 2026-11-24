import { describe, expect, it } from 'vitest';
import type { LonLat, PoliceUnitState } from '@openstreet-racer/shared';
import {
  applyCooldown,
  applyImpact,
  applyRedLight,
  applySpeeding,
  bustedContactUpdate,
  bustedFineCents,
  createPoliceUnit,
  createWantedState,
  damagePoliceUnit,
  isActiveHeatMissionKind,
  policeCountForLevel,
  policeCruiseSpeed,
  policeUnitsNear,
  roadblockAnchor,
  speedingThreshold,
  wreckRepairBillCents,
} from '../src/wanted-system';

describe('wanted heat rules', () => {
  it('adds heat for sustained speeding above the adjusted limit', () => {
    const limit = 13.9;
    const threshold = speedingThreshold(limit);
    expect(threshold).toBeGreaterThan(limit);
    expect(applySpeeding(createWantedState(), 14, limit, 1).level).toBe(0);
    expect(applySpeeding(createWantedState(), threshold + 1, limit, 1).heat).toBeGreaterThan(0);
    let state = createWantedState();
    for (let index = 0; index < 12; index += 1) {
      state = applySpeeding(state, threshold + 1, limit, 1);
    }
    expect(state.level).toBeGreaterThanOrEqual(1);
  });

  it('caps the elapsed time per evaluation and clamps at five stars', () => {
    let state = applySpeeding(createWantedState(), 40, 13.9, 500);
    expect(state.heat).toBeLessThanOrEqual(1);
    for (let index = 0; index < 40; index += 1) {
      state = applySpeeding(state, 40, 13.9, 5);
    }
    expect(state.level).toBe(5);
  });

  it('raises heat for hard impacts, pedestrians most', () => {
    const vehicle = applyImpact(createWantedState(), 'vehicle', 80);
    const pedestrian = applyImpact(createWantedState(), 'pedestrian', 80);
    const police = applyImpact(createWantedState(), 'police', 80);
    const prop = applyImpact(createWantedState(), 'prop', 80);
    const total = (state: { level: number; heat: number }): number => state.level + state.heat;
    expect(total(pedestrian)).toBeGreaterThan(total(police));
    expect(total(police)).toBeGreaterThan(total(vehicle));
    expect(total(vehicle)).toBeGreaterThan(total(prop));
    expect(applyImpact(createWantedState(), 'vehicle', 10).heat).toBe(0);
  });

  it('raises heat for red lights', () => {
    const state = applyRedLight(createWantedState());
    expect(state.heat).toBeGreaterThan(0);
    expect(state.level).toBe(0);
  });

  it('decays heat during cooldown and clears stars over time', () => {
    const wanted = createWantedState(2, 0.4);
    const partial = applyCooldown(wanted, 10, 1);
    expect(partial.level).toBe(2);
    expect(partial.heat).toBeLessThan(0.4);
    let state = wanted;
    for (let index = 0; index < 200; index += 1) {
      state = applyCooldown(state, 5, 1);
    }
    expect(state.level).toBe(0);
    expect(state.heat).toBe(0);
  });

  it('decays faster with a mission multiplier (lay low) and not at all when blocked', () => {
    const wanted = createWantedState(1, 0.5);
    const accelerated = applyCooldown(wanted, 10, 4);
    const normal = applyCooldown(wanted, 10, 1);
    expect(accelerated.level + accelerated.heat).toBeLessThan(normal.level + normal.heat);
    expect(applyCooldown(wanted, 10, 0)).toEqual(wanted);
  });
});

describe('police pursuit', () => {
  it('scales the fleet and cruise speed with the wanted level', () => {
    expect(policeCountForLevel(0)).toBe(0);
    expect(policeCountForLevel(1)).toBe(1);
    expect(policeCountForLevel(2)).toBe(2);
    expect(policeCountForLevel(3)).toBe(4);
    expect(policeCountForLevel(4)).toBe(5);
    expect(policeCountForLevel(5)).toBe(6);
    expect(policeCruiseSpeed(5)).toBeGreaterThan(policeCruiseSpeed(1));
  });

  it('disables police units after enough ram damage and keeps them countable', () => {
    const unit = createPoliceUnit('police-test', { longitude: 0, latitude: 0 }, 1_000);
    damagePoliceUnit(unit, 40);
    expect(unit.mode).toBe('chase');
    damagePoliceUnit(unit, 40);
    expect(unit.mode).toBe('chase');
    damagePoliceUnit(unit, 40);
    expect(unit.mode).toBe('disabled');
    expect(policeUnitsNear([unit], unit.position, 50)).toHaveLength(0);
  });

  it('places roadblock cars ahead along a route at increasing distance', () => {
    const route: LonLat[] = [
      { longitude: 0, latitude: 0 },
      { longitude: 0.004, latitude: 0 },
    ];
    const anchors = roadblockAnchor(route);
    expect(anchors).toHaveLength(3);
    const player: LonLat = { longitude: 0, latitude: 0 };
    const distances = anchors.map((anchor) =>
      Math.abs((anchor.longitude - player.longitude) * 111_320 * Math.cos(0)),
    );
    expect(distances[0]! < distances[1]!).toBe(true);
    expect(distances[1]! < distances[2]!).toBe(true);
  });
});

describe('busted flow', () => {
  it('requires sustained low-speed contact before busting', () => {
    let contact = 0;
    contact = bustedContactUpdate(contact, true, 1).contactSeconds;
    expect(bustedContactUpdate(contact, true, 1).busted).toBe(false);
    contact = bustedContactUpdate(contact, true, 1).contactSeconds;
    expect(bustedContactUpdate(contact, true, 1).busted).toBe(true);
    expect(bustedContactUpdate(2.9, false, 1).busted).toBe(false);
    expect(bustedContactUpdate(2.9, false, 1).contactSeconds).toBe(0);
  });

  it('charges a fine that is a share of the balance and never exceeds it', () => {
    expect(bustedFineCents(0)).toBe(0);
    expect(bustedFineCents(1_000)).toBe(500);
    expect(bustedFineCents(20_000)).toBe(3_000);
    expect(bustedFineCents(200_000)).toBeLessThanOrEqual(50_000);
    expect(bustedFineCents(200_000)).toBeLessThanOrEqual(200_000);
  });

  it('bills the standard repair cost when the car is wrecked', () => {
    expect(wreckRepairBillCents(0)).toBe(0);
    expect(wreckRepairBillCents(100)).toBe(2_500);
  });
});

describe('pursuit snapshots', () => {
  it('serializes units for the client without leaking internal route state', () => {
    const unit = createPoliceUnit('police-snap', { longitude: 1, latitude: 1 }, 5_000);
    const snapshot: PoliceUnitState = {
      id: unit.id,
      mode: unit.mode,
      position: unit.position,
      headingRadians: unit.headingRadians,
      speedMetersPerSecond: unit.speedMetersPerSecond,
      damage: unit.damage,
    };
    expect(Object.keys(snapshot)).toEqual(
      expect.arrayContaining([
        'id',
        'mode',
        'position',
        'headingRadians',
        'speedMetersPerSecond',
        'damage',
      ]),
    );
    expect('route' in snapshot).toBe(false);
  });

  it('classifies getaway, hot delivery, and lay low as heat missions', () => {
    expect(isActiveHeatMissionKind('getaway')).toBe(true);
    expect(isActiveHeatMissionKind('hot-delivery')).toBe(true);
    expect(isActiveHeatMissionKind('lay-low')).toBe(true);
    expect(isActiveHeatMissionKind('delivery')).toBe(false);
  });
});
