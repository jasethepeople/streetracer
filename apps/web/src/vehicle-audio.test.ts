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

  it('screeches and revs during a burnout even at a standstill', () => {
    const idle = vehicleAudioLevels(car(0, 0), { ...noInput, throttle: 1 });
    const burnout = vehicleAudioLevels(
      car(0, 0),
      { ...noInput, throttle: 1 },
      {
        burnout: 1,
        sliding: false,
        slipAmount: 0,
      },
    );

    expect(burnout.tireGain).toBeGreaterThan(idle.tireGain);
    expect(burnout.engineFrequencyHz).toBeGreaterThan(idle.engineFrequencyHz);
  });

  it('screeches when the physics reports a slide', () => {
    const straight = vehicleAudioLevels(car(0, 10), noInput, {
      burnout: 0,
      sliding: false,
      slipAmount: 0,
    });
    const drifting = vehicleAudioLevels(car(0, 10), noInput, {
      burnout: 0,
      sliding: true,
      slipAmount: 0.8,
    });

    expect(drifting.tireGain).toBeGreaterThan(straight.tireGain);
  });
});
