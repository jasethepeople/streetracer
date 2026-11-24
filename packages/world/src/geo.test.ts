import { describe, expect, it } from 'vitest';
import { localMetersToLonLat, lonLatToLocalMeters } from './geo';

const equator = { longitude: 0, latitude: 0 };

describe('local coordinate conversion', () => {
  it('round-trips nearby coordinates', () => {
    const origin = { longitude: -104.99, latitude: 39.74 };
    const point = { longitude: -104.985, latitude: 39.745 };
    const local = lonLatToLocalMeters(point, origin);
    const restored = localMetersToLonLat(local, origin);

    expect(restored.longitude).toBeCloseTo(point.longitude, 8);
    expect(restored.latitude).toBeCloseTo(point.latitude, 8);
  });

  it('converts one degree at the equator to approximately 111.2 km', () => {
    const local = lonLatToLocalMeters({ longitude: 1, latitude: 1 }, equator);
    expect(local.x).toBeCloseTo(111_195, -1);
    expect(local.y).toBeCloseTo(111_195, -1);
  });

  it('uses a cosine longitude scale away from the equator', () => {
    const origin = { longitude: 0, latitude: 60 };
    const local = lonLatToLocalMeters({ longitude: 1, latitude: 60 }, origin);
    expect(local.x).toBeCloseTo(55_598, -1);
    expect(local.y).toBe(0);
  });

  it('takes the short path across the antimeridian', () => {
    const local = lonLatToLocalMeters(
      { longitude: -179.9, latitude: 0 },
      { longitude: 179.9, latitude: 0 },
    );
    expect(local.x).toBeCloseTo(22_239, -1);
  });
});
