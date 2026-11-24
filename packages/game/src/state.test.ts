import { afterEach, describe, expect, it } from 'vitest';
import {
  publishPlayerCar,
  rebaseGameState,
  resetGameState,
  readGameState,
  simulateGameStep,
  updateRoadLines,
} from './state';
import { localMetersToLonLat } from '@openstreet-racer/world';

const origin = { longitude: -104.99, latitude: 39.74 };
const throttleInput = { steer: 0, throttle: 1, brake: 0, handbrake: 0 };

afterEach(() => resetGameState(origin));

describe('plain game state and fixed-step simulation', () => {
  it('keeps old state snapshots stable when simulation advances', () => {
    resetGameState(origin);
    const before = readGameState();

    simulateGameStep(throttleInput);

    const after = readGameState();
    expect(after).not.toBe(before);
    expect(before.cars[0].speedMetersPerSecond).toBe(0);
    expect(after.cars[0].speedMetersPerSecond).toBeCloseTo(0.23);
    expect(after.cars[0].velocity.y).toBeCloseTo(0.23);
    expect(after.cars[0].position.y).toBeGreaterThan(0);
  });

  it('softly constrains the car to valid nearby road geometry', () => {
    resetGameState(origin);
    updateRoadLines([
      [
        { x: -20, y: 1 },
        { x: 20, y: 1 },
      ],
    ]);

    const state = readGameState();
    expect(state.cars[0].position.y).toBeCloseTo(0.16);
    expect(state.roadSpeedFactor).toBe(1);
    expect(state.missingRoadSamples).toBe(0);
  });

  it('rebases the floating origin while preserving the player’s geographic location', () => {
    resetGameState(origin);
    const player = readGameState().cars[0];
    publishPlayerCar({ ...player, position: { x: 1_650, y: -820 } });
    const before = readGameState();
    const expected = localMetersToLonLat(before.cars[0].position, before.origin);
    const shift = rebaseGameState(expected);
    const after = readGameState();
    const actual = localMetersToLonLat(after.cars[0].position, after.origin);

    expect(shift.x).toBeCloseTo(1_650, 0);
    expect(shift.y).toBeCloseTo(-820, 0);
    expect(after.cars[0].position.x).toBeCloseTo(0, 1);
    expect(after.cars[0].position.y).toBeCloseTo(0, 1);
    expect(actual.longitude).toBeCloseTo(expected.longitude, 7);
    expect(actual.latitude).toBeCloseTo(expected.latitude, 7);
  });

  it('uses a safe slowdown fallback when road features are unavailable or malformed', () => {
    resetGameState(origin);
    updateRoadLines([]);
    updateRoadLines([[{ x: Number.NaN, y: 0 }]]);
    updateRoadLines([]);

    expect(readGameState().roadSpeedFactor).toBe(0.18);
    simulateGameStep(throttleInput);
    expect(readGameState().cars[0].speedMetersPerSecond).toBeLessThan(0.25);
    expect(readGameState().cars[0].speedMetersPerSecond).toBeGreaterThan(0);
  });
});
