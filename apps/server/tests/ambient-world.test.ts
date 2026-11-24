import { describe, expect, it, vi } from 'vitest';
import { lonLatToLocalMeters, type OsmElement } from '@openstreet-racer/world';
import { AmbientWorld, trafficSignalAt } from '../src/ambient-world';

const origin = { longitude: -104.9903, latitude: 39.7392 };
const elements: readonly OsmElement[] = [
  { type: 'node', id: 1, lon: -104.9903, lat: 39.7392, tags: { highway: 'traffic_signals' } },
  { type: 'node', id: 2, lon: -104.9893, lat: 39.7392 },
  { type: 'node', id: 3, lon: -104.9883, lat: 39.7392, tags: { highway: 'stop' } },
  { type: 'node', id: 4, lon: -104.9873, lat: 39.7392 },
  { type: 'node', id: 5, lon: -104.9903, lat: 39.7395 },
  { type: 'node', id: 6, lon: -104.9893, lat: 39.7395 },
  {
    type: 'way',
    id: 10,
    nodes: [1, 2, 3, 4],
    tags: { highway: 'residential', oneway: 'yes', maxspeed: '25 mph' },
  },
  { type: 'way', id: 11, nodes: [5, 6], tags: { highway: 'footway' } },
];

describe('deterministic ambient world', () => {
  it('shares seeded traffic, pedestrians, and traffic controls for the same map cells', async () => {
    const first = createWorld();
    const second = createWorld();
    await Promise.all([first.prepare(origin), second.prepare(origin)]);

    const timestamp = Date.UTC(2026, 2, 11, 12);
    const firstSnapshot = first.getSnapshot(origin, timestamp);
    const secondSnapshot = second.getSnapshot(origin, timestamp);

    expect(firstSnapshot.status).toBe('ready');
    expect(firstSnapshot).toEqual(secondSnapshot);
    expect(firstSnapshot.actors.some((actor) => actor.kind === 'vehicle')).toBe(true);
    expect(firstSnapshot.actors.some((actor) => actor.kind === 'pedestrian')).toBe(true);
    expect(firstSnapshot.controls.map((control) => control.kind)).toEqual(
      expect.arrayContaining(['traffic-signal', 'stop-sign']),
    );
    expect(firstSnapshot.actors.length).toBeLessThanOrEqual(48);
  });

  it('keeps opposing traffic on opposite sides of a two-way road', async () => {
    const laneElements: readonly OsmElement[] = [
      { type: 'node', id: 101, lon: -104.9913, lat: 39.7392 },
      { type: 'node', id: 102, lon: -104.9893, lat: 39.7392 },
      { type: 'way', id: 110, nodes: [101, 102], tags: { highway: 'residential' } },
    ];
    const world = new AmbientWorld({ loadRegion: vi.fn(async () => laneElements) }, () =>
      Date.UTC(2026, 2, 11, 12),
    );
    await world.prepare(origin);
    const cars = world
      .getSnapshot(origin, Date.UTC(2026, 2, 11, 12))
      .actors.filter((actor) => actor.kind === 'vehicle');
    const laneSides = cars.map((car) => Math.sign(lonLatToLocalMeters(car.position, origin).y));

    expect(cars).toHaveLength(2);
    expect(laneSides).toContain(-1);
    expect(laneSides).toContain(1);
  });

  it('builds drivable routes from the already loaded OSM graph', async () => {
    const source = { loadRegion: vi.fn(async () => elements) };
    const world = new AmbientWorld(source, () => Date.UTC(2026, 2, 11, 12));
    const destination = { longitude: -104.9873, latitude: 39.7392 };
    await world.prepare(origin);
    const route = await world.findRoute(origin, destination);

    expect(source.loadRegion).toHaveBeenCalledTimes(1);
    expect(route.points.length).toBeGreaterThan(1);
    expect(route.distanceMeters).toBeGreaterThan(200);
    expect(route.travelTimeSeconds).toBeGreaterThan(0);
    expect(route.points[0]).toEqual(origin);
    expect(route.points.at(-1)).toEqual(destination);
  });

  it('rejects route requests outside the bounded neighborhood', async () => {
    const world = createWorld();
    await expect(world.findRoute(origin, { longitude: -104.8, latitude: 39.7392 })).rejects.toThrow(
      'within 7 km',
    );
  });

  it('uses a stable, repeating traffic-light phase for every client', () => {
    const first = trafficSignalAt('signal-123', 15_000);
    expect(trafficSignalAt('signal-123', 15_000)).toEqual(first);
    expect(trafficSignalAt('signal-123', 15_000 + 30_000)).toEqual(first);
    expect(first.changesInMs).toBeGreaterThan(0);
  });

  it('reports world data as unavailable after a failed region fetch', async () => {
    const source = { loadRegion: vi.fn().mockRejectedValue(new Error('Overpass unavailable')) };
    const world = new AmbientWorld(source, () => 1_000);
    await expect(world.prepare(origin)).resolves.toBeUndefined();
    expect(world.getSnapshot(origin, 1_000).status).toBe('unavailable');
  });
});

function createWorld(): AmbientWorld {
  const source = { loadRegion: vi.fn(async () => elements) };
  return new AmbientWorld(source, () => Date.UTC(2026, 2, 11, 12));
}
