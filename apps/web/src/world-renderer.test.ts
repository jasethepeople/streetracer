import { describe, expect, it } from 'vitest';
import type { ChunkGeometry } from '@openstreet-racer/world';
import type { TractionState } from '@openstreet-racer/vehicle/rapier';
import {
  CHUNK_SURFACE_MATERIALS,
  engineSmokeIntensity,
  planSmokeEmission,
  type ChunkSurfaceKey,
} from './world-renderer';
import type { MeshStandardMaterial } from 'three';

const SURFACE_KEYS: readonly ChunkSurfaceKey[] = [
  'ground',
  'greens',
  'waters',
  'roads',
  'markings',
  'buildings',
];

function materialFor(surface: ChunkSurfaceKey): MeshStandardMaterial {
  const binding = CHUNK_SURFACE_MATERIALS.find(([key]) => key === surface);
  if (!binding) throw new Error(`No material binding for surface "${surface}".`);
  return binding[1]() as MeshStandardMaterial;
}

describe('chunk surface material mapping', () => {
  it('binds every ChunkGeometry surface exactly once', () => {
    const boundKeys = CHUNK_SURFACE_MATERIALS.map(([key]) => key);
    const geometryKeys: (keyof ChunkGeometry)[] = [
      'ground',
      'roads',
      'markings',
      'buildings',
      'greens',
      'waters',
    ];
    expect([...boundKeys].sort()).toEqual([...geometryKeys].sort());
    expect(new Set(boundKeys).size).toBe(SURFACE_KEYS.length);
  });

  it('assigns dark asphalt to road geometry, never a green material', () => {
    const road = materialFor('roads');
    expect(road.color.getHexString()).toBe('30363a');
    // Asphalt reads as a dark neutral surface: low luminance, no dominant hue.
    expect(Math.max(road.color.r, road.color.g, road.color.b)).toBeLessThan(0.25);
    expect(Math.abs(road.color.g - road.color.r)).toBeLessThan(0.05);
  });

  it('assigns green grass materials to ground and green-space geometry', () => {
    for (const surface of ['ground', 'greens'] as const) {
      const material = materialFor(surface);
      // Grass reads green: the green channel must dominate red and blue.
      expect(material.color.g).toBeGreaterThan(material.color.r);
      expect(material.color.g).toBeGreaterThan(material.color.b);
      // And it must be clearly brighter than the asphalt so roads stand out.
      const road = materialFor('roads');
      expect(material.color.g).toBeGreaterThan(road.color.g * 1.5);
    }
  });

  it('uses a distinct material instance per surface', () => {
    const materials = SURFACE_KEYS.map((surface) => materialFor(surface));
    expect(new Set(materials).size).toBe(SURFACE_KEYS.length);
  });
});

const NEUTRAL_TRACTION: TractionState = {
  burnout: 0,
  sliding: false,
  slipAmount: 0,
  wheelSpinRadiansPerSecond: 0,
};

describe('smoke emission planning', () => {
  it('emits no smoke for neutral traction with damage at or below 65', () => {
    for (const damage of [0, 30, 65]) {
      const plan = planSmokeEmission(NEUTRAL_TRACTION, damage);
      expect(plan.tires).toEqual([]);
      expect(plan.engineIntensity).toBe(0);
    }
  });

  it('emits no smoke when traction is unavailable and damage is low', () => {
    const plan = planSmokeEmission(null, 10);
    expect(plan.tires).toEqual([]);
    expect(plan.engineIntensity).toBe(0);
  });

  it('emits rear tire smoke at burnout intensity once burnout reaches 0.12', () => {
    const plan = planSmokeEmission({ ...NEUTRAL_TRACTION, burnout: 0.4 }, 0);
    expect(plan.tires).toEqual([{ axle: 'rear', intensity: 0.4 }]);
    expect(plan.engineIntensity).toBe(0);
    // A weak launch below the threshold stays clean.
    expect(planSmokeEmission({ ...NEUTRAL_TRACTION, burnout: 0.11 }, 0).tires).toEqual([]);
  });

  it('emits rear tire smoke at max(burnout, slip) while sliding at slip >= 0.28', () => {
    const slipDominant = planSmokeEmission(
      { ...NEUTRAL_TRACTION, sliding: true, slipAmount: 0.4, burnout: 0.2 },
      0,
    );
    expect(slipDominant.tires).toEqual([{ axle: 'rear', intensity: 0.4 }]);
    const burnoutDominant = planSmokeEmission(
      { ...NEUTRAL_TRACTION, sliding: true, slipAmount: 0.3, burnout: 0.5 },
      0,
    );
    expect(burnoutDominant.tires).toEqual([{ axle: 'rear', intensity: 0.5 }]);
    // Sliding gently below the slip threshold emits nothing.
    expect(
      planSmokeEmission({ ...NEUTRAL_TRACTION, sliding: true, slipAmount: 0.27 }, 0).tires,
    ).toEqual([]);
    // Slip without the sliding flag (e.g. a rounding artifact) emits nothing.
    expect(planSmokeEmission({ ...NEUTRAL_TRACTION, slipAmount: 0.4 }, 0).tires).toEqual([]);
  });

  it('adds front tire smoke at 0.7x slip during hard drifts (slip >= 0.55)', () => {
    const plan = planSmokeEmission({ ...NEUTRAL_TRACTION, sliding: true, slipAmount: 0.8 }, 0);
    expect(plan.tires).toHaveLength(2);
    expect(plan.tires[0]).toEqual({ axle: 'rear', intensity: 0.8 });
    expect(plan.tires[1]?.axle).toBe('front');
    expect(plan.tires[1]?.intensity).toBeCloseTo(0.56, 10);
    // A moderate slide above the slip threshold stays rear-only.
    const rearOnly = planSmokeEmission({ ...NEUTRAL_TRACTION, sliding: true, slipAmount: 0.54 }, 0);
    expect(rearOnly.tires).toEqual([{ axle: 'rear', intensity: 0.54 }]);
  });

  it('ramps engine smoke from 0 at damage 65 to 1 at damage 100', () => {
    expect(engineSmokeIntensity(0)).toBe(0);
    expect(engineSmokeIntensity(65)).toBe(0);
    expect(engineSmokeIntensity(82.5)).toBeCloseTo(0.5, 10);
    expect(engineSmokeIntensity(100)).toBe(1);
    expect(engineSmokeIntensity(140)).toBe(1);
    const plan = planSmokeEmission(NEUTRAL_TRACTION, 90);
    expect(plan.tires).toEqual([]);
    expect(plan.engineIntensity).toBeCloseTo((90 - 65) / 35, 10);
  });

  it('combines tire and engine smoke independently', () => {
    const plan = planSmokeEmission({ ...NEUTRAL_TRACTION, burnout: 0.6 }, 100);
    expect(plan.tires).toEqual([{ axle: 'rear', intensity: 0.6 }]);
    expect(plan.engineIntensity).toBe(1);
  });
});
