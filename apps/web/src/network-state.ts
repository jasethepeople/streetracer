import type { CarState, LonLat, NetworkCarState } from '@openstreet-racer/shared';
import { localMetersToLonLat } from '@openstreet-racer/world';

export function toNetworkCarState(
  car: Readonly<CarState>,
  origin: Readonly<LonLat>,
): NetworkCarState {
  return {
    position: localMetersToLonLat(car.position, origin),
    altitudeMeters: car.altitudeMeters,
    velocity: {
      eastMetersPerSecond: car.velocity.x,
      northMetersPerSecond: car.velocity.y,
      upMetersPerSecond: car.verticalVelocityMetersPerSecond,
    },
    headingRadians: car.headingRadians,
    speedMetersPerSecond: car.speedMetersPerSecond,
  };
}
