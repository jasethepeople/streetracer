import { describe, expect, it } from 'vitest';
import {
  constrainToRoad,
  nearestPointOnRoad,
  nearestRoadSpawn,
  speedFactorForDistance,
} from './roads';

const eastWestRoad = [
  [
    { x: -100, y: 0 },
    { x: 100, y: 0 },
  ],
];

describe('road geometry', () => {
  it('projects onto the nearest point on a rendered road segment', () => {
    const nearest = nearestPointOnRoad({ x: 12, y: 3 }, eastWestRoad);
    expect(nearest?.point.x).toBeCloseTo(12);
    expect(nearest?.point.y).toBe(0);
    expect(nearest?.distanceMeters).toBe(3);
  });

  it('selects a nearby road-aligned spawn and chooses the direction closest to the preferred heading', () => {
    const spawn = nearestRoadSpawn({ x: 0, y: 8 }, eastWestRoad, 0);
    expect(spawn?.point).toEqual({ x: 0, y: 0 });
    expect(spawn?.distanceMeters).toBe(8);
    expect(spawn?.headingRadians).toBeCloseTo(Math.PI / 2);
  });

  it('soft-snaps a nearby car toward the road centerline', () => {
    const result = constrainToRoad({ x: 12, y: 2 }, eastWestRoad);
    expect(result.snapped).toBe(true);
    expect(result.position.y).toBeCloseTo(1.68);
    expect(result.speedFactor).toBe(1);
  });

  it('slows the car when it leaves the road and bottoms out at the configured floor', () => {
    expect(speedFactorForDistance(12)).toBeLessThan(1);
    expect(speedFactorForDistance(50)).toBeCloseTo(0.18);
  });

  it('leaves the vehicle unconstrained when rendered road tiles are unavailable', () => {
    expect(constrainToRoad({ x: 1, y: 2 }, [])).toEqual({
      position: { x: 1, y: 2 },
      distanceMeters: Number.POSITIVE_INFINITY,
      speedFactor: 1,
      snapped: false,
    });
  });
});
