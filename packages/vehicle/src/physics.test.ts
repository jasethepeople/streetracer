import { describe, expect, it } from 'vitest';
import { createVehicleState, stepVehicle } from './physics';

describe('arcade vehicle', () => {
  it('accelerates in the direction the car faces and records velocity', () => {
    const next = stepVehicle(
      createVehicleState(),
      { throttle: 1, steer: 0, brake: 0, handbrake: 0 },
      0.05,
    );
    expect(next.speedMetersPerSecond).toBeGreaterThan(0);
    expect(next.position.y).toBeGreaterThan(0);
    expect(next.position.x).toBeCloseTo(0);
    expect(next.velocity.y).toBeCloseTo(next.speedMetersPerSecond);
  });

  it('turns and caps unusually large frame deltas', () => {
    const next = stepVehicle(
      createVehicleState(),
      { throttle: 1, steer: 1, brake: 0, handbrake: 0 },
      1,
    );
    expect(next.speedMetersPerSecond).toBeCloseTo(0.69);
    expect(next.headingRadians).toBeGreaterThan(0);
  });

  it('brakes forward motion and allows reverse after slowing down', () => {
    const moving = { ...createVehicleState(), speedMetersPerSecond: 4 };
    const braking = stepVehicle(moving, { throttle: 0, steer: 0, brake: 1, handbrake: 0 }, 0.05);
    const reversing = stepVehicle(
      createVehicleState(),
      { throttle: 0, steer: 0, brake: 1, handbrake: 0 },
      0.05,
    );
    expect(braking.speedMetersPerSecond).toBeCloseTo(2.58);
    expect(reversing.speedMetersPerSecond).toBeLessThan(0);
    expect(reversing.velocity.y).toBeLessThan(0);
  });

  it('uses the handbrake to slow down without reversing', () => {
    const moving = { ...createVehicleState(), speedMetersPerSecond: 5 };
    const next = stepVehicle(moving, { throttle: 0, steer: 0, brake: 0, handbrake: 1 }, 0.05);
    expect(next.speedMetersPerSecond).toBeCloseTo(3.4);
  });
});
