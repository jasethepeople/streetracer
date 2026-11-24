import { describe, expect, it } from 'vitest';
import type { CarState } from '@openstreet-racer/shared';
import { toNetworkCarState } from './network-state';

const ORIGIN = { longitude: -104.99, latitude: 39.74 };

describe('network vehicle snapshots', () => {
  it('converts local east/north position and velocity to the shared geographic schema', () => {
    const car: CarState = {
      id: 'player',
      position: { x: 12, y: -4 },
      velocity: { x: 3, y: 5 },
      altitudeMeters: 0.7,
      verticalVelocityMetersPerSecond: -0.2,
      wheels: [],
      headingRadians: 1.25,
      speedMetersPerSecond: 5.8,
    };

    const state = toNetworkCarState(car, ORIGIN);

    expect(state.position.longitude).toBeGreaterThan(ORIGIN.longitude);
    expect(state.position.latitude).toBeLessThan(ORIGIN.latitude);
    expect(state.velocity).toEqual({
      eastMetersPerSecond: 3,
      northMetersPerSecond: 5,
      upMetersPerSecond: -0.2,
    });
    expect(state.headingRadians).toBe(1.25);
  });
});
