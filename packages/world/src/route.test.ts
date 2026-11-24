import { describe, expect, it } from 'vitest';
import { findRoute, nearestRoadNode } from './route';
import { buildRoadGraph, type OsmElement } from './road-graph';
import type { LonLat } from '@openstreet-racer/shared';

const origin: LonLat = { longitude: -104.99, latitude: 39.74 };

function node(id: number, east: number, north: number): OsmElement {
  return {
    type: 'node',
    id,
    lon: origin.longitude + east / 85_000,
    lat: origin.latitude + north / 111_000,
  };
}

function way(id: number, nodes: number[], maxspeed: string): OsmElement {
  return { type: 'way', id, nodes, tags: { highway: 'residential', maxspeed, oneway: 'yes' } };
}

function createGraph() {
  const elements = [
    node(1, 0, 0),
    node(2, 0, 500),
    node(3, 500, 0),
    node(4, 500, 500),
    node(5, 1_000, 500),
    way(10, [1, 2], '10'),
    way(11, [2, 5], '10'),
    way(12, [1, 3], '60'),
    way(13, [3, 4], '60'),
    way(14, [4, 5], '60'),
  ] satisfies OsmElement[];
  return buildRoadGraph(elements, origin);
}

describe('road routing', () => {
  it('uses speed limits to find the fastest directed route', () => {
    const graph = createGraph();
    const route = findRoute(graph, '1', '5');
    expect(route?.nodeIds).toEqual(['1', '3', '4', '5']);
    expect(route?.edges.every((edge) => edge.direction === 'forward')).toBe(true);
    expect(route?.distanceMeters).toBeGreaterThan(1_400);
    expect(route?.travelTimeSeconds).toBeLessThan(100);
  });

  it('rejects routes against one-way direction and disconnected destinations', () => {
    const graph = createGraph();
    expect(findRoute(graph, '5', '1')).toBeNull();
    expect(findRoute(graph, '1', 'missing')).toBeNull();
  });

  it('returns a zero-length route when start and destination snap to the same node', () => {
    const route = findRoute(createGraph(), '1', '1');
    expect(route).toMatchObject({
      nodeIds: ['1'],
      edges: [],
      distanceMeters: 0,
      travelTimeSeconds: 0,
    });
  });

  it('snaps locations only to connected nodes within the requested radius', () => {
    const graph = createGraph();
    const nearby = nearestRoadNode(
      graph,
      { longitude: origin.longitude + 0.000001, latitude: origin.latitude },
      50,
    );
    expect(nearby?.node.id).toBe('1');
    expect(nearestRoadNode(graph, { longitude: -104.9, latitude: 39.8 }, 50)).toBeNull();
  });
});
