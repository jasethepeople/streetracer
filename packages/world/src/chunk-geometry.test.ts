import { describe, expect, it } from 'vitest';
import { localMetersToLonLat } from './geo';
import {
  createChunkGeometry,
  MAX_CHUNK_TRIANGLES,
  roadWidthMeters,
  type WorldFeature,
} from './chunk-geometry';
import { tileCellAt } from './tiles';

const cell = tileCellAt({ longitude: -104.99, latitude: 39.74 });

function polygonFeature(layer: string, id: string, radius: number, properties = {}): WorldFeature {
  const points = [
    [-radius, -radius],
    [radius, -radius],
    [radius, radius],
    [-radius, radius],
    [-radius, -radius],
  ] as const;
  return {
    id,
    layer,
    properties,
    geometry: {
      type: 'Polygon',
      coordinates: [
        points.map(([x, y]) => {
          const point = localMetersToLonLat({ x, y }, cell.center);
          return [point.longitude, point.latitude] as const;
        }),
      ],
    },
  };
}

describe('chunk geometry', () => {
  it('uses lane tags and road class to choose plausible ribbon widths', () => {
    expect(roadWidthMeters({ class: 'residential' })).toBe(6);
    expect(roadWidthMeters({ class: 'primary', lanes: 4 })).toBe(12.8);
  });

  it('builds ground, roads, green space, water, and extruded buildings', () => {
    const roadPointA = localMetersToLonLat({ x: -15, y: 0 }, cell.center);
    const roadPointB = localMetersToLonLat({ x: 15, y: 0 }, cell.center);
    const road: WorldFeature = {
      id: 'road-1',
      layer: 'transportation',
      properties: { class: 'residential', lanes: 2 },
      geometry: {
        type: 'LineString',
        coordinates: [
          [roadPointA.longitude, roadPointA.latitude],
          [roadPointB.longitude, roadPointB.latitude],
        ],
      },
    };
    const geometry = createChunkGeometry(cell, [
      road,
      polygonFeature('building', 'building-1', 8, { height: '9.5 m' }),
      polygonFeature('park', 'park-1', 14),
      polygonFeature('water', 'water-1', 20),
    ]);

    expect(geometry.ground.indices.length).toBe(6);
    expect(geometry.ground.normals.length).toBe(geometry.ground.positions.length);
    expect(geometry.roads.indices.length).toBeGreaterThan(0);
    expect(geometry.markings.indices.length).toBeGreaterThan(0);
    expect(geometry.buildings.indices.length).toBeGreaterThan(0);
    expect(Math.max(...geometry.buildings.positions.filter((_, index) => index % 3 === 1))).toBe(
      9.5,
    );
    expect(geometry.greens.indices.length).toBeGreaterThan(0);
    expect(geometry.waters.indices.length).toBeGreaterThan(0);
    expect(geometry.triangles).toBeLessThanOrEqual(MAX_CHUNK_TRIANGLES);
  });

  it('converts imperial OSM height tags into meters', () => {
    const geometry = createChunkGeometry(cell, [
      polygonFeature('building', 'feet', 8, { height: '10 ft' }),
    ]);
    const heights = [...geometry.buildings.positions].filter((_, index) => index % 3 === 1);
    expect(Math.max(...heights)).toBeCloseTo(3.048, 3);
  });

  it('uses a stable plausible fallback instead of OpenMapTiles short render heights', () => {
    const first = createChunkGeometry(cell, [
      polygonFeature('building', 'stable-id', 8, { render_height: 2 }),
    ]);
    const second = createChunkGeometry(cell, [
      polygonFeature('building', 'stable-id', 8, { render_height: 2 }),
    ]);
    const heights = (geometry: typeof first) =>
      [...geometry.buildings.positions].filter((_, index) => index % 3 === 1);
    expect(Math.max(...heights(first))).toBeGreaterThan(0);
    expect(heights(first)).toEqual(heights(second));
  });

  it('never exceeds the hard triangle budget, even for dense cells', () => {
    const buildings = Array.from({ length: 30 }, (_, index) =>
      polygonFeature('building', `building-${index}`, 4 + index / 10),
    );
    const geometry = createChunkGeometry(cell, buildings, 100);
    expect(geometry.triangles).toBeLessThanOrEqual(100);
  });
});
