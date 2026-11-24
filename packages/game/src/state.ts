import {
  FALLBACK_LOCATION,
  type CarState,
  type GameState,
  type LonLat,
  type PlayerInput,
  type Point2,
} from '@openstreet-racer/shared';
import { constrainToRoad, lonLatToLocalMeters } from '@openstreet-racer/world';
import { createVehicleState, stepVehicle } from '@openstreet-racer/vehicle/physics';

export const FIXED_TIME_STEP_SECONDS = 1 / 60;
export const FLOATING_ORIGIN_REBASE_METERS = 1_200;
const EMPTY_INPUT: PlayerInput = { steer: 0, throttle: 0, brake: 0, handbrake: 0 };

let gameState = createGameState(FALLBACK_LOCATION);

export function readGameState(): Readonly<GameState> {
  return gameState;
}

export function getPlayerCar(state: Readonly<GameState>): CarState {
  return state.cars[0];
}

export function resetGameState(origin: LonLat): void {
  gameState = createGameState(origin);
}

export function publishPlayerCar(car: CarState): void {
  gameState = {
    ...gameState,
    cars: [copyCar(car), ...gameState.cars.slice(1)],
  };
}

export function rebaseGameState(origin: LonLat): Point2 {
  const shift = lonLatToLocalMeters(origin, gameState.origin);
  gameState = {
    ...gameState,
    origin: { longitude: origin.longitude, latitude: origin.latitude },
    cars: gameState.cars.map((car) => ({
      ...car,
      position: { x: car.position.x - shift.x, y: car.position.y - shift.y },
    })) as [CarState, ...CarState[]],
  };
  return shift;
}

export function updateRoadLines(lines: readonly (readonly Point2[])[]): void {
  const validLines = lines.filter(
    (line) =>
      line.length > 1 &&
      line.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
  );

  if (!validLines.length) {
    const missingRoadSamples = gameState.missingRoadSamples + 1;
    gameState = {
      ...gameState,
      roadSpeedFactor: missingRoadSamples >= 3 ? 0.18 : 1,
      missingRoadSamples,
    };
    return;
  }

  const player = getPlayerCar(gameState);
  const constraint = constrainToRoad(player.position, validLines);
  const updatedPlayer = { ...player, position: constraint.position };
  gameState = {
    ...gameState,
    cars: [updatedPlayer, ...gameState.cars.slice(1)],
    roadSpeedFactor: clamp(constraint.speedFactor, 0, 1),
    missingRoadSamples: 0,
  };
}

export function simulateGameStep(input: PlayerInput = EMPTY_INPUT): void {
  const player = getPlayerCar(gameState);
  const nextPlayer = stepVehicle(player, input, FIXED_TIME_STEP_SECONDS);
  const speed =
    nextPlayer.speedMetersPerSecond *
    Math.pow(gameState.roadSpeedFactor, FIXED_TIME_STEP_SECONDS * 1.2);
  const velocityScale =
    nextPlayer.speedMetersPerSecond === 0 ? 0 : speed / nextPlayer.speedMetersPerSecond;
  const updatedPlayer = {
    ...nextPlayer,
    speedMetersPerSecond: speed,
    velocity: {
      x: nextPlayer.velocity.x * velocityScale,
      y: nextPlayer.velocity.y * velocityScale,
    },
  };

  gameState = {
    ...gameState,
    cars: [updatedPlayer, ...gameState.cars.slice(1)],
  };
}

function copyCar(car: CarState): CarState {
  return {
    ...car,
    position: { ...car.position },
    velocity: { ...car.velocity },
    wheels: car.wheels.map((wheel) => ({ ...wheel, position: { ...wheel.position } })),
  };
}

function createGameState(origin: LonLat): GameState {
  return {
    origin: { longitude: origin.longitude, latitude: origin.latitude },
    cars: [createVehicleState()],
    roadSpeedFactor: 1,
    missingRoadSamples: 0,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
