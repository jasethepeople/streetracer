import { describe, expect, it } from 'vitest';
import {
  localMetersToLonLat,
  type WorldFeature,
  type WorldPosition,
} from '@openstreet-racer/world';
import type { LonLat, Point2 } from '@openstreet-racer/shared';
import {
  buildingClearanceMeters,
  nearestClearRoadSpawn,
  planSpawnAlignment,
  pointInRing,
  SPAWN_BUILDING_CLEARANCE_METERS,
  worldBuildingRings,
  worldRoadLines,
} from './world-runtime';

const ORIGIN: LonLat = { longitude: -104.9903, latitude: 39.7392 };

/** Exact meter-offset placement via the inverse projection. */
function at(x: number, y: number): WorldPosition {
  const { longitude, latitude } = localMetersToLonLat({ x, y }, ORIGIN);
  return [longitude, latitude];
}

function roadFeature(id: string, points: readonly Point2[]): WorldFeature {
  return {
    id,
    layer: 'transportation',
    properties: {},
    geometry: { type: 'LineString', coordinates: points.map((p) => at(p.x, p.y)) },
  };
}

function buildingFeature(id: string, ring: readonly Point2[]): WorldFeature {
  return {
    id,
    layer: 'building',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [ring.map((p) => at(p.x, p.y))] },
  };
}

/** Axis-aligned building square centered on (cx, cy) with the given half size. */
function squareBuilding(id: string, cx: number, cy: number, halfSize: number): WorldFeature {
  return buildingFeature(id, [
    { x: cx - halfSize, y: cy - halfSize },
    { x: cx + halfSize, y: cy - halfSize },
    { x: cx + halfSize, y: cy + halfSize },
    { x: cx - halfSize, y: cy + halfSize },
  ]);
}

const SQUARE: readonly Point2[] = [
  { x: -10, y: -10 },
  { x: 10, y: -10 },
  { x: 10, y: 10 },
  { x: -10, y: 10 },
];

describe('pointInRing', () => {
  it('detects points inside and outside a polygon ring', () => {
    expect(pointInRing({ x: 0, y: 0 }, SQUARE)).toBe(true);
    expect(pointInRing({ x: 5, y: -5 }, SQUARE)).toBe(true);
    expect(pointInRing({ x: 20, y: 0 }, SQUARE)).toBe(false);
    expect(pointInRing({ x: 0, y: -30 }, SQUARE)).toBe(false);
  });
});

describe('buildingClearanceMeters', () => {
  it('returns 0 inside a building and the edge distance outside', () => {
    expect(buildingClearanceMeters({ x: 0, y: 0 }, [SQUARE])).toBe(0);
    expect(buildingClearanceMeters({ x: 15, y: 0 }, [SQUARE])).toBeCloseTo(5, 6);
    expect(buildingClearanceMeters({ x: 14, y: 14 }, [SQUARE])).toBeCloseTo(Math.hypot(4, 4), 6);
  });

  it('is unbounded when there are no buildings', () => {
    expect(buildingClearanceMeters({ x: 0, y: 0 }, [])).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('nearestClearRoadSpawn', () => {
  const northSouthRoad = [
    [
      { x: 0, y: -100 },
      { x: 0, y: 100 },
    ],
  ] as const;

  it('rejects road samples inside or tight against a building covering the raw origin', () => {
    const buildings = [SQUARE]; // building occupies |x| <= 10, |y| <= 10 around the origin
    const spawn = nearestClearRoadSpawn({ x: 0, y: 0 }, northSouthRoad, buildings);
    expect(spawn).not.toBeNull();
    // The chosen sample must sit outside the building with car-sized clearance.
    expect(pointInRing(spawn!.point, SQUARE)).toBe(false);
    expect(buildingClearanceMeters(spawn!.point, buildings)).toBeGreaterThanOrEqual(
      SPAWN_BUILDING_CLEARANCE_METERS,
    );
    // Samples step every 4 m; the nearest accepted sample is 16 m out
    // (12 m would leave only 2 m of clearance and must be rejected).
    expect(spawn!.distanceMeters).toBeCloseTo(16, 6);
  });

  it('returns null when every candidate in range is blocked by buildings', () => {
    const huge = [
      [
        { x: -200, y: -200 },
        { x: 200, y: -200 },
        { x: 200, y: 200 },
        { x: -200, y: 200 },
      ],
    ];
    expect(nearestClearRoadSpawn({ x: 0, y: 0 }, northSouthRoad, huge, 0, 150)).toBeNull();
    // A road beyond the search radius is also not a spawn.
    const farRoad = [
      [
        { x: 300, y: -50 },
        { x: 300, y: 50 },
      ],
    ];
    expect(nearestClearRoadSpawn({ x: 0, y: 0 }, farRoad, [], 0, 150)).toBeNull();
  });

  it('picks the nearest clear point on a nearby road with the road heading', () => {
    const spawn = nearestClearRoadSpawn({ x: 0, y: 0 }, northSouthRoad, [], 0);
    expect(spawn).not.toBeNull();
    expect(spawn!.point.x).toBeCloseTo(0, 6);
    expect(spawn!.point.y).toBeCloseTo(0, 6);
    expect(spawn!.distanceMeters).toBeCloseTo(0, 6);
    // The road runs north, so the spawn heading faces along it (not sideways).
    expect(Math.abs(Math.sin(spawn!.headingRadians))).toBeCloseTo(0, 6);
  });

  it('flips the heading toward the preferred direction', () => {
    const spawn = nearestClearRoadSpawn({ x: 0, y: 0 }, northSouthRoad, [], Math.PI);
    expect(spawn).not.toBeNull();
    expect(Math.cos(spawn!.headingRadians)).toBeCloseTo(-1, 6);
  });
});

describe('worldRoadLines / worldBuildingRings', () => {
  it('projects road and building features into local meters around the origin', () => {
    const features = [
      roadFeature('road-1', [
        { x: 0, y: 0 },
        { x: 0, y: 50 },
      ]),
      squareBuilding('building-1', 0, 0, 10),
      {
        id: 'park-1',
        layer: 'greens',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[at(-5, -5), at(5, -5), at(5, 5), at(-5, 5)]],
        },
      } satisfies WorldFeature,
    ];
    const lines = worldRoadLines(features, ORIGIN);
    expect(lines).toHaveLength(1);
    expect(lines[0]![0]!.x).toBeCloseTo(0, 4);
    expect(lines[0]![1]!.y).toBeCloseTo(50, 4);
    const rings = worldBuildingRings(features, ORIGIN);
    expect(rings).toHaveLength(1); // the park polygon is not a building
    expect(pointInRing({ x: 0, y: 0 }, rings[0]!)).toBe(true);
  });
});

describe('planSpawnAlignment', () => {
  const idlePose = { position: { x: 0, y: 0 }, speedMetersPerSecond: 0 };
  const buildingAtOrigin = squareBuilding('building-origin', 0, 0, 10);
  const blockedRoad = roadFeature('road-blocked', [
    { x: 0, y: -100 },
    { x: 0, y: 100 },
  ]);

  it('returns null until the center-cell features have streamed in', () => {
    expect(
      planSpawnAlignment({
        centerFeatures: null,
        origin: ORIGIN,
        pose: idlePose,
        playerMoved: false,
      }),
    ).toBeNull();
  });

  it('can be retried until a building-clear spawn exists', () => {
    // First chunk: the only road within range is fully inside a giant
    // building footprint, so no clear spawn exists yet — the runtime must
    // keep retrying instead of locking in a bad spawn.
    const giant = squareBuilding('building-giant', 0, 0, 200);
    const first = planSpawnAlignment({
      centerFeatures: [giant, blockedRoad],
      origin: ORIGIN,
      pose: idlePose,
      playerMoved: false,
    });
    expect(first).toBeNull();
    // A later chunk revision adds the missing east-west road; the retry now
    // finds a clear spawn instead of giving up.
    const clearRoad = roadFeature('road-clear', [
      { x: -100, y: 60 },
      { x: 100, y: 60 },
    ]);
    const second = planSpawnAlignment({
      centerFeatures: [buildingAtOrigin, blockedRoad, clearRoad],
      origin: ORIGIN,
      pose: idlePose,
      playerMoved: false,
    });
    expect(second).not.toBeNull();
    const rings = worldBuildingRings([buildingAtOrigin], ORIGIN);
    expect(buildingClearanceMeters(second!.point, rings)).toBeGreaterThanOrEqual(
      SPAWN_BUILDING_CLEARANCE_METERS,
    );
  });

  it('moves a raw origin inside a building onto a nearby clear road', () => {
    const spawn = planSpawnAlignment({
      centerFeatures: [buildingAtOrigin, blockedRoad],
      origin: ORIGIN,
      pose: idlePose,
      playerMoved: false,
    });
    expect(spawn).not.toBeNull();
    const rings = worldBuildingRings([buildingAtOrigin], ORIGIN);
    expect(pointInRing(spawn!.point, rings[0]!)).toBe(false);
    expect(buildingClearanceMeters(spawn!.point, rings)).toBeGreaterThanOrEqual(
      SPAWN_BUILDING_CLEARANCE_METERS,
    );
  });

  it('stops aligning once the player has actually driven away', () => {
    const driven = planSpawnAlignment({
      centerFeatures: [buildingAtOrigin, blockedRoad],
      origin: ORIGIN,
      pose: { position: { x: 120, y: 0 }, speedMetersPerSecond: 0 },
      playerMoved: true,
    });
    expect(driven).toBeNull();
    const speeding = planSpawnAlignment({
      centerFeatures: [buildingAtOrigin, blockedRoad],
      origin: ORIGIN,
      pose: { position: { x: 0, y: 0 }, speedMetersPerSecond: 8 },
      playerMoved: true,
    });
    expect(speeding).toBeNull();
    // Pressing a control without driving away still aligns.
    const stationary = planSpawnAlignment({
      centerFeatures: [buildingAtOrigin, blockedRoad],
      origin: ORIGIN,
      pose: idlePose,
      playerMoved: true,
    });
    expect(stationary).not.toBeNull();
  });
});
