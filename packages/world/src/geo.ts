import type { LonLat, Point2 } from '@openstreet-racer/shared';

const EARTH_RADIUS_METERS = 6_371_008.8;

export function lonLatToLocalMeters(point: LonLat, origin: LonLat): Point2 {
  const deltaLongitude = normalizeLongitudeDelta(point.longitude - origin.longitude);
  const latitudeScale = Math.cos(toRadians(origin.latitude));
  return {
    x: toRadians(deltaLongitude) * EARTH_RADIUS_METERS * latitudeScale,
    y: toRadians(point.latitude - origin.latitude) * EARTH_RADIUS_METERS,
  };
}

export function localMetersToLonLat(point: Point2, origin: LonLat): LonLat {
  const latitudeScale = Math.max(Math.abs(Math.cos(toRadians(origin.latitude))), 1e-6);
  return {
    longitude: normalizeLongitude(
      origin.longitude + toDegrees(point.x / (EARTH_RADIUS_METERS * latitudeScale)),
    ),
    latitude: origin.latitude + toDegrees(point.y / EARTH_RADIUS_METERS),
  };
}

export function haversineMeters(first: LonLat, second: LonLat): number {
  const latitudeDelta = toRadians(second.latitude - first.latitude);
  const longitudeDelta = toRadians(normalizeLongitudeDelta(second.longitude - first.longitude));
  const firstLatitude = toRadians(first.latitude);
  const secondLatitude = toRadians(second.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(Math.min(1, haversine)));
}

export function normalizeRadians(angle: number): number {
  const fullTurn = 2 * Math.PI;
  return ((angle % fullTurn) + fullTurn) % fullTurn;
}

function normalizeLongitudeDelta(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

function normalizeLongitude(degrees: number): number {
  return normalizeLongitudeDelta(degrees);
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}
