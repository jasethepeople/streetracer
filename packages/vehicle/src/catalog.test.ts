import { describe, expect, it } from 'vitest';
import { getVehicleDefinition, STARTING_VEHICLE_ID, VEHICLE_CATALOG } from './catalog';

describe('data-driven vehicle catalog', () => {
  it('contains the required distinct vehicle types and a free starting sedan', () => {
    expect(VEHICLE_CATALOG.map(({ visual }) => visual)).toEqual([
      'sedan',
      'truck',
      'sports-car',
      'motorbike',
    ]);
    expect(getVehicleDefinition(STARTING_VEHICLE_ID).costCents).toBe(0);
    expect(new Set(VEHICLE_CATALOG.map(({ id }) => id)).size).toBe(4);
  });

  it('gives each vehicle a distinct handling profile', () => {
    expect(new Set(VEHICLE_CATALOG.map(({ handling }) => handling.maxSpeedMps)).size).toBe(4);
    expect(new Set(VEHICLE_CATALOG.map(({ handling }) => handling.massKg)).size).toBe(4);
    expect(getVehicleDefinition('missing').id).toBe(STARTING_VEHICLE_ID);
  });
});
