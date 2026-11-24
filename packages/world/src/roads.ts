import type { Point2 } from '@openstreet-racer/shared';
import { normalizeRadians } from './geo';

export interface NearestRoadPoint {
  point: Point2;
  distanceMeters: number;
}

export interface RoadConstraint {
  position: Point2;
  distanceMeters: number;
  speedFactor: number;
  snapped: boolean;
}

export interface RoadConstraintOptions {
  snapRadiusMeters?: number;
  snapStrength?: number;
  slowdownStartMeters?: number;
  slowdownEndMeters?: number;
  minimumSpeedFactor?: number;
}

export function nearestPointOnRoad(
  position: Point2,
  lines: readonly (readonly Point2[])[],
): NearestRoadPoint | null {
  let nearest: NearestRoadPoint | null = null;

  for (const line of lines) {
    if (line.length === 1) nearest = chooseNearest(position, line[0], nearest);

    for (let index = 1; index < line.length; index += 1) {
      const start = line[index - 1];
      const end = line[index];
      const segmentX = end.x - start.x;
      const segmentY = end.y - start.y;
      const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
      const fraction =
        segmentLengthSquared === 0
          ? 0
          : clamp(
              ((position.x - start.x) * segmentX + (position.y - start.y) * segmentY) /
                segmentLengthSquared,
              0,
              1,
            );
      nearest = chooseNearest(
        position,
        {
          x: start.x + fraction * segmentX,
          y: start.y + fraction * segmentY,
        },
        nearest,
      );
    }
  }

  return nearest;
}

export interface RoadSpawnPoint extends NearestRoadPoint {
  headingRadians: number;
}

export function nearestRoadSpawn(
  position: Point2,
  lines: readonly (readonly Point2[])[],
  preferredHeading = 0,
  maximumDistanceMeters = Number.POSITIVE_INFINITY,
): RoadSpawnPoint | null {
  let nearest: RoadSpawnPoint | null = null;
  const preferred = normalizeRadians(preferredHeading);

  for (const line of lines) {
    if (line.length === 1) {
      const point = line[0];
      if (!point) continue;
      const candidate = { ...point };
      const distanceMeters = Math.hypot(position.x - point.x, position.y - point.y);
      if (distanceMeters > maximumDistanceMeters) continue;
      if (!nearest || distanceMeters < nearest.distanceMeters) {
        nearest = { point: candidate, distanceMeters, headingRadians: preferred };
      }
    }

    for (let index = 1; index < line.length; index += 1) {
      const start = line[index - 1];
      const end = line[index];
      if (!start || !end) continue;
      const segmentX = end.x - start.x;
      const segmentY = end.y - start.y;
      const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
      if (segmentLengthSquared === 0) continue;
      const fraction = clamp(
        ((position.x - start.x) * segmentX + (position.y - start.y) * segmentY) /
          segmentLengthSquared,
        0,
        1,
      );
      const point = {
        x: start.x + fraction * segmentX,
        y: start.y + fraction * segmentY,
      };
      const distanceMeters = Math.hypot(position.x - point.x, position.y - point.y);
      if (distanceMeters > maximumDistanceMeters) continue;
      if (nearest && distanceMeters >= nearest.distanceMeters) continue;
      const forward = normalizeRadians(Math.atan2(segmentX, segmentY));
      const reverse = normalizeRadians(forward + Math.PI);
      const headingRadians =
        angleDifference(forward, preferred) <= angleDifference(reverse, preferred)
          ? forward
          : reverse;
      nearest = { point, distanceMeters, headingRadians };
    }
  }

  return nearest;
}

export function constrainToRoad(
  position: Point2,
  lines: readonly (readonly Point2[])[],
  options: RoadConstraintOptions = {},
): RoadConstraint {
  const nearest = nearestPointOnRoad(position, lines);
  if (!nearest) {
    return {
      position: { ...position },
      distanceMeters: Number.POSITIVE_INFINITY,
      speedFactor: 1,
      snapped: false,
    };
  }

  const snapRadius = options.snapRadiusMeters ?? 2.5;
  const snapStrength = clamp(options.snapStrength ?? 0.16, 0, 1);
  const slowdownStart = options.slowdownStartMeters ?? 3;
  const slowdownEnd = options.slowdownEndMeters ?? 22;
  const minimumSpeedFactor = clamp(options.minimumSpeedFactor ?? 0.18, 0, 1);
  const snapped = nearest.distanceMeters <= snapRadius;
  const speedFactor = speedFactorForDistance(
    nearest.distanceMeters,
    slowdownStart,
    slowdownEnd,
    minimumSpeedFactor,
  );

  return {
    position: snapped
      ? {
          x: position.x + (nearest.point.x - position.x) * snapStrength,
          y: position.y + (nearest.point.y - position.y) * snapStrength,
        }
      : { ...position },
    distanceMeters: nearest.distanceMeters,
    speedFactor,
    snapped,
  };
}

export function speedFactorForDistance(
  distanceMeters: number,
  slowdownStartMeters = 3,
  slowdownEndMeters = 22,
  minimumSpeedFactor = 0.18,
): number {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= slowdownStartMeters) return 1;
  if (distanceMeters >= slowdownEndMeters) return minimumSpeedFactor;
  const progress =
    (distanceMeters - slowdownStartMeters) / (slowdownEndMeters - slowdownStartMeters);
  return 1 - progress * (1 - minimumSpeedFactor);
}

function chooseNearest(
  position: Point2,
  candidate: Point2,
  current: NearestRoadPoint | null,
): NearestRoadPoint {
  const distanceMeters = Math.hypot(position.x - candidate.x, position.y - candidate.y);
  return current && current.distanceMeters <= distanceMeters
    ? current
    : { point: candidate, distanceMeters };
}

function angleDifference(first: number, second: number): number {
  const difference = Math.abs(normalizeRadians(first) - normalizeRadians(second));
  return Math.min(difference, 2 * Math.PI - difference);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
