import { describe, expect, it } from 'vitest';
import type { CarState, PlayerInput } from '@openstreet-racer/shared';
import { vehicleAudioLevels } from './vehicle-audio';

const noInput: PlayerInput = { steer: 0, throttle: 0, brake: 0, handbrake: 0 };

function car(
  east: number,
  north: number,
  headingRadians = 0,
): Pick<CarState, 'velocity' | 'headingRadians'> {
  return {
    velocity: { x: east, y: north },
    headingRadians,
  };
}

describe('procedural vehicle audio', () => {
  it('raises engine pitch and volume with speed and throttle', () => {
    const idle = vehicleAudioLevels(car(0, 0), noInput);
    const moving = vehicleAudioLevels(car(0, 12), { ...noInput, throttle: 0.5 });

    expect(moving.engineFrequencyHz).toBeGreaterThan(idle.engineFrequencyHz);
    expect(moving.engineGain).toBeGreaterThan(idle.engineGain);
  });

  it('adds tire noise for lateral slip and handbrake use', () => {
    const straight = vehicleAudioLevels(car(0, 10), noInput);
    const sliding = vehicleAudioLevels(car(6, 10), { ...noInput, handbrake: 1 });

    expect(sliding.tireGain).toBeGreaterThan(straight.tireGain);
  });
});
