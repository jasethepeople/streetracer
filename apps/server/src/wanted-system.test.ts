import { describe, expect, it } from 'vitest';
import {
  addWantedHeat,
  applyCooldown,
  applyImpact,
  applyRedLight,
  applySpeeding,
  bustedFineCents,
  createWantedState,
  DEFAULT_SPEED_LIMIT_MPS,
  isActiveHeatMissionKind,
  policeCountForLevel,
  policeCruiseSpeed,
  speedingThreshold,
  wreckRepairBillCents,
  WRECK_REPAIR_CENTS_PER_DAMAGE,
} from './wanted-system';

describe('wanted-system (server authority)', () => {
  it('clamps level and heat into range', () => {
    expect(createWantedState(-3, -1)).toEqual({ level: 0, heat: 0 });
    expect(createWantedState(9, 3)).toEqual({ level: 5, heat: 0.99 });
  });

  it('carries heat into levels and caps max-level heat', () => {
    const next = addWantedHeat(createWantedState(0, 0.8), 0.5);
    expect(next.level).toBe(1);
    expect(next.heat).toBeCloseTo(0.3, 5);
  });

  it('only escalates from speeding above the threshold', () => {
    expect(speedingThreshold(DEFAULT_SPEED_LIMIT_MPS)).toBeGreaterThan(DEFAULT_SPEED_LIMIT_MPS);
    expect(
      applySpeeding({ level: 0, heat: 0 }, DEFAULT_SPEED_LIMIT_MPS, DEFAULT_SPEED_LIMIT_MPS, 1),
    ).toEqual({
      level: 0,
      heat: 0,
    });
    const speeding = applySpeeding(
      { level: 0, heat: 0 },
      DEFAULT_SPEED_LIMIT_MPS * 2,
      DEFAULT_SPEED_LIMIT_MPS,
      2,
    );
    expect(speeding.heat).toBeGreaterThan(0);
    expect(applySpeeding({ level: 0, heat: 0 }, 0, DEFAULT_SPEED_LIMIT_MPS, 5).heat).toBe(0);
  });

  it('adds heat from red lights and impacts', () => {
    const red = applyRedLight({ level: 0, heat: 0 });
    expect(red.level).toBe(0);
    expect(red.heat).toBeCloseTo(0.5, 5);
    const bump = applyImpact({ level: 0, heat: 0 }, 'vehicle', 10);
    expect(bump.heat).toBe(0);
    const crash = applyImpact({ level: 0, heat: 0 }, 'vehicle', 60);
    expect(crash.heat).toBeGreaterThan(0);
    const pedestrian = applyImpact({ level: 0, heat: 0 }, 'pedestrian', 90);
    expect(pedestrian.level + pedestrian.heat).toBeGreaterThan(crash.level + crash.heat);
  });

  it('freezes cooldown while visible and cools faster when hidden', () => {
    const visible = applyCooldown({ level: 1, heat: 0.4 }, 10, 0);
    const hidden = applyCooldown({ level: 1, heat: 0.4 }, 10, 1);
    expect(visible.heat).toBeCloseTo(0.4, 5);
    expect(hidden.heat).toBeLessThan(0.4);
  });

  it('scales police fleet with level', () => {
    expect(policeCountForLevel(0)).toBe(0);
    expect(policeCountForLevel(1)).toBeGreaterThan(0);
    expect(policeCruiseSpeed(3)).toBeGreaterThan(policeCruiseSpeed(1));
  });

  it('bills wreck repairs and fines within balance bounds', () => {
    expect(wreckRepairBillCents(40)).toBe(40 * WRECK_REPAIR_CENTS_PER_DAMAGE);
    expect(bustedFineCents(1_000)).toBe(500);
    const fine = bustedFineCents(500_000);
    expect(fine).toBeGreaterThanOrEqual(500);
    expect(fine).toBeLessThanOrEqual(50_000);
  });

  it('recognises active heat mission kinds', () => {
    expect(isActiveHeatMissionKind('getaway')).toBe(true);
    expect(isActiveHeatMissionKind('hot-delivery')).toBe(true);
    expect(isActiveHeatMissionKind('lay-low')).toBe(true);
    expect(isActiveHeatMissionKind('delivery')).toBe(false);
  });
});
