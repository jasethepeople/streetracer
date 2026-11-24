import { afterAll, describe, expect, it } from 'vitest';
import { localMetersToLonLat } from '@openstreet-racer/world';
import { tileCellAt } from '@openstreet-racer/world';
import { createChunkGeometry, type WorldFeature } from '@openstreet-racer/world';
import { RapierVehicle } from './rapier-vehicle';

const origin = tileCellAt({ longitude: -104.99, latitude: 39.74 });
const throttle = { steer: 0, throttle: 1, brake: 0, handbrake: 0 };
let vehicle: RapierVehicle | undefined;

afterAll(() => vehicle?.dispose());

describe('Rapier raycast vehicle', () => {
  it('accelerates with suspension and keeps its physics pose in plain game-state form', async () => {
    vehicle = await RapierVehicle.create(origin.center);
    let pose = vehicle.snapshot();
    for (let index = 0; index < 180; index += 1) pose = vehicle.step(throttle, 1 / 60);
    expect(pose.speedMetersPerSecond).toBeGreaterThan(3);
    expect(pose.position.y).toBeGreaterThan(4);
    expect(pose.wheels).toHaveLength(4);
  });

  it('keeps left steering and geographic heading aligned', async () => {
    vehicle?.dispose();
    vehicle = await RapierVehicle.create(origin.center);
    let pose = vehicle.snapshot();
    for (let index = 0; index < 60; index += 1) {
      pose = vehicle.step({ ...throttle, steer: -0.25 }, 1 / 60);
    }
    expect(pose.position.x).toBeLessThan(0);
    expect(pose.headingRadians).toBeGreaterThan(5.5);
    expect(pose.headingRadians).toBeLessThan(2 * Math.PI);
  });

  it('uses generated building geometry as a solid collision barrier', async () => {
    vehicle?.dispose();
    vehicle = await RapierVehicle.create(origin.center);
    const wallPoints = [
      [-4, 6],
      [4, 6],
      [4, 9],
      [-4, 9],
      [-4, 6],
    ] as const;
    const wall: WorldFeature = {
      id: 'test-wall',
      layer: 'building',
      properties: { height: 8 },
      geometry: {
        type: 'Polygon',
        coordinates: [
          wallPoints.map(([x, north]) => {
            const point = localMetersToLonLat({ x, y: north }, origin.center);
            return [point.longitude, point.latitude] as const;
          }),
        ],
      },
    };
    vehicle.addChunk(origin, createChunkGeometry(origin, [wall]));
    let pose = vehicle.snapshot();
    for (let index = 0; index < 300; index += 1) pose = vehicle.step(throttle, 1 / 60);
    expect(pose.position.y).toBeLessThan(6);
    expect(pose.speedMetersPerSecond).toBeLessThan(2);
    expect(vehicle.chunkCount).toBe(1);
  });

  it('switches to an owned vehicle shape and keeps damage repairable', async () => {
    vehicle?.dispose();
    vehicle = await RapierVehicle.create(origin.center);
    const bike = vehicle.switchVehicle('motorbike');
    expect(bike.vehicleId).toBe('motorbike');
    expect(bike.wheels).toHaveLength(2);

    vehicle.setDamage(42);
    expect(vehicle.snapshot().damage).toBe(42);
    expect(vehicle.repair().damage).toBe(0);
  });
});
