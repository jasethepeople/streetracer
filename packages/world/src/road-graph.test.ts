import { describe, expect, it } from 'vitest';
import { buildRoadGraph, parseMaxspeed, type OsmElement } from './road-graph';

const origin = { longitude: -104.99, latitude: 39.74 };

function node(id: number, east: number, north: number, tags?: Record<string, string>): OsmElement {
  return {
    type: 'node',
    id,
    lon: origin.longitude + east / 85_000,
    lat: origin.latitude + north / 111_000,
    tags,
  };
}

function way(id: number, nodes: number[], tags: Record<string, string>): OsmElement {
  return { type: 'way', id, nodes, tags };
}

const nodes = [node(1, 0, 0), node(2, 20, 0), node(3, 40, 0), node(4, 20, 20)];

describe('buildRoadGraph', () => {
  it('preserves node IDs, intersections, and traffic controls', () => {
    const elements: OsmElement[] = [
      ...nodes,
      { ...node(2, 20, 0, { highway: 'traffic_signals' }) },
      way(10, [1, 2, 3], { highway: 'residential' }),
      way(11, [2, 4], { highway: 'service' }),
    ];
    const graph = buildRoadGraph(elements, origin);
    expect(graph.nodes.get('2')).toMatchObject({ control: 'traffic-signal', intersection: true });
    expect(graph.outgoing.get('2')).toHaveLength(3);
  });

  it('honors one-way and reverse one-way direction', () => {
    const forward = buildRoadGraph(
      [...nodes.slice(0, 2), way(20, [1, 2], { highway: 'primary', oneway: 'yes' })],
      origin,
    );
    expect(forward.edges.map(({ from, to }) => [from, to])).toEqual([['1', '2']]);

    const reverse = buildRoadGraph(
      [...nodes.slice(0, 2), way(21, [1, 2], { highway: 'primary', oneway: '-1' })],
      origin,
    );
    expect(reverse.edges.map(({ from, to }) => [from, to])).toEqual([['2', '1']]);
  });

  it('uses directional maxspeed tags and supports km/h and mph', () => {
    const graph = buildRoadGraph(
      [
        ...nodes.slice(0, 2),
        way(30, [1, 2], {
          highway: 'residential',
          maxspeed: '30 mph',
          'maxspeed:forward': '50 km/h',
        }),
      ],
      origin,
    );
    expect(
      graph.edges.find((edge) => edge.direction === 'forward')?.speedLimitMetersPerSecond,
    ).toBeCloseTo(13.8889, 3);
    expect(
      graph.edges.find((edge) => edge.direction === 'backward')?.speedLimitMetersPerSecond,
    ).toBeCloseTo(13.4112, 3);
    expect(parseMaxspeed('walk', 8)).toBe(8);
  });

  it('excludes restricted vehicle roads and honors pedestrian access and one-way tags', () => {
    const vehicle = buildRoadGraph(
      [
        ...nodes.slice(0, 3),
        way(40, [1, 2], { highway: 'residential', motor_vehicle: 'no' }),
        way(41, [2, 3], { highway: 'footway' }),
      ],
      origin,
      'vehicle',
    );
    expect(vehicle.edges).toHaveLength(0);

    const pedestrians = buildRoadGraph(
      [
        ...nodes.slice(0, 3),
        way(42, [1, 2], { highway: 'footway', foot: 'yes', 'oneway:foot': 'yes' }),
        way(43, [2, 3], { highway: 'footway', foot: 'no' }),
      ],
      origin,
      'pedestrian',
    );
    expect(pedestrians.edges).toHaveLength(1);
    expect(pedestrians.edges[0]).toMatchObject({ direction: 'forward', oneWay: true });
    expect(pedestrians.edges[0]?.speedLimitMetersPerSecond).toBe(1.4);
  });

  it('defaults missing or malformed speeds and recognizes stop controls', () => {
    const graph = buildRoadGraph(
      [
        node(1, 0, 0, { highway: 'stop' }),
        node(2, 20, 0),
        way(50, [1, 2], { highway: 'residential', maxspeed: 'signals' }),
      ],
      origin,
    );
    expect(graph.nodes.get('1')?.control).toBe('stop-sign');
    expect(graph.edges[0]?.speedLimitMetersPerSecond).toBe(13.9);
  });
});
