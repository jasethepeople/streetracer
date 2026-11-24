export interface LonLat {
  longitude: number;
  latitude: number;
}

export interface Point2 {
  x: number;
  y: number;
}

export const FALLBACK_LOCATION: LonLat = { longitude: -104.9903, latitude: 39.7392 };
export const FALLBACK_LOCATION_LABEL = 'Denver, Colorado';
export const OPENFREEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
export const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';

export interface PlayerInput {
  readonly steer: number;
  readonly throttle: number;
  readonly brake: number;
  readonly handbrake: number;
}

export interface WheelState {
  readonly position: Readonly<{ x: number; y: number; z: number }>;
  readonly rotationRadians: number;
  readonly steeringRadians: number;
}

export interface CarState {
  readonly id: string;
  readonly vehicleId?: string;
  readonly damage?: number;
  readonly position: Readonly<Point2>;
  readonly velocity: Readonly<Point2>;
  readonly altitudeMeters: number;
  readonly verticalVelocityMetersPerSecond: number;
  readonly wheels: readonly WheelState[];
  readonly headingRadians: number;
  readonly speedMetersPerSecond: number;
}

export interface GameState {
  readonly origin: Readonly<LonLat>;
  readonly cars: readonly [CarState, ...CarState[]];
  readonly roadSpeedFactor: number;
  readonly missingRoadSamples: number;
}
export * from './protocol';
export * from './progression';
