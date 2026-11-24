import type { CarState, PlayerInput } from '@openstreet-racer/shared';
import { getVehicleDefinition, STARTING_VEHICLE_ID } from './catalog';

export type VehicleState = CarState;
export type DriveInput = PlayerInput;

export function createVehicleState(
  id = 'player',
  vehicleId = STARTING_VEHICLE_ID,
  damage = 0,
): VehicleState {
  const vehicle = getVehicleDefinition(vehicleId);
  const { dimensions } = vehicle;
  const wheels =
    vehicle.visual === 'motorbike'
      ? [
          { x: 0, z: dimensions.wheelbase / 2 },
          { x: 0, z: -dimensions.wheelbase / 2 },
        ]
      : [
          { x: -dimensions.track / 2, z: dimensions.wheelbase / 2 },
          { x: dimensions.track / 2, z: dimensions.wheelbase / 2 },
          { x: -dimensions.track / 2, z: -dimensions.wheelbase / 2 },
          { x: dimensions.track / 2, z: -dimensions.wheelbase / 2 },
        ];
  return {
    id,
    vehicleId: vehicle.id,
    damage: clamp(damage, 0, 100),
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    altitudeMeters: 0.86,
    verticalVelocityMetersPerSecond: 0,
    wheels: wheels.map(({ x, z }) => ({
      position: { x, y: -dimensions.height * 0.35, z },
      rotationRadians: 0,
      steeringRadians: 0,
    })),
    headingRadians: 0,
    speedMetersPerSecond: 0,
  };
}

export function stepVehicle(
  state: VehicleState,
  input: DriveInput,
  deltaSeconds: number,
): VehicleState {
  const delta = clamp(Number.isFinite(deltaSeconds) ? deltaSeconds : 0, 0, 0.05);
  const throttle = clamp(input.throttle, 0, 1);
  const steering = clamp(input.steer, -1, 1);
  const brake = clamp(input.brake, 0, 1);
  const handbrake = clamp(input.handbrake, 0, 1);
  const vehicle = getVehicleDefinition(state.vehicleId);
  const damageFactor = 1 - clamp(state.damage ?? 0, 0, 100) * 0.0045;
  let speed = state.speedMetersPerSecond;

  if (brake > 0) {
    speed =
      speed > 0.5
        ? Math.max(0, speed - brake * 22 * (vehicle.handling.brakeForce / 1_700) * delta)
        : Math.max(-vehicle.handling.maxReverseMps, speed - brake * 4 * delta);
  } else if (throttle > 0) {
    speed =
      speed < 0
        ? Math.min(
            0,
            speed +
              ((throttle * vehicle.handling.engineForce) / vehicle.handling.massKg) * 3.45 * delta,
          )
        : Math.min(
            vehicle.handling.maxSpeedMps,
            speed +
              ((throttle * vehicle.handling.engineForce) / vehicle.handling.massKg) *
                3.45 *
                damageFactor *
                delta,
          );
  } else if (handbrake === 0) {
    speed *= Math.exp(-1.5 * delta);
  }

  speed = moveTowardZero(speed, handbrake * 32 * delta);
  speed = clamp(speed, -vehicle.handling.maxReverseMps, vehicle.handling.maxSpeedMps);

  const speedRatio = Math.min(Math.abs(speed) / 8, 1);
  const turnRate =
    steering *
    vehicle.handling.steeringRadians *
    (0.6 + speedRatio) *
    Math.sign(speed || 1) *
    (1 - (state.damage ?? 0) * 0.0025);
  const headingRadians = wrapRadians(state.headingRadians + turnRate * delta);
  const velocity = {
    x: Math.sin(headingRadians) * speed,
    y: Math.cos(headingRadians) * speed,
  };

  return {
    ...state,
    position: {
      x: state.position.x + velocity.x * delta,
      y: state.position.y + velocity.y * delta,
    },
    velocity,
    altitudeMeters: state.altitudeMeters,
    verticalVelocityMetersPerSecond: state.verticalVelocityMetersPerSecond,
    wheels: state.wheels,
    headingRadians,
    speedMetersPerSecond: speed,
  };
}

function moveTowardZero(value: number, amount: number): number {
  if (value > 0) return Math.max(0, value - amount);
  if (value < 0) return Math.min(0, value + amount);
  return 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : 0;
}

function wrapRadians(angle: number): number {
  const fullTurn = 2 * Math.PI;
  return ((angle % fullTurn) + fullTurn) % fullTurn;
}
