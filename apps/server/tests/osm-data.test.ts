import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tileCellAt } from '@openstreet-racer/world';
import {
  buildOverpassQuery,
  defaultOverpassEndpoint,
  OsmDataError,
  OsmDataSource,
  regionBounds,
} from '../src/osm-data';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('OSM data source', () => {
  it('builds a bounded Overpass query for roads and control nodes', () => {
    const query = buildOverpassQuery({ west: -105.1, south: 39.7, east: -105.0, north: 39.8 });
    expect(query).toContain('way["highway"]');
    expect(query).toContain('traffic_signals|stop|crossing');
    expect(query).toContain('out body');
    expect(query).toContain('39.700000,-105.100000,39.800000,-105.000000');
  });

  it('deduplicates in-flight requests and caches parsed nodes and ways', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            elements: [
              { type: 'node', id: 1, lat: 39.7, lon: -105.1, tags: { highway: 'traffic_signals' } },
              { type: 'node', id: 2, lat: 39.71, lon: -105.09 },
              {
                type: 'way',
                id: 8,
                nodes: [1, 2],
                tags: { highway: 'residential', oneway: 'yes' },
              },
              { type: 'relation', id: 9, members: [] },
            ],
          }),
          { status: 200 },
        ),
    );
    const source = new OsmDataSource({
      fetcher,
      cacheDirectory: await temporaryDirectory(),
      minRequestIntervalMs: 0,
    });
    const bounds = { west: -105.1, south: 39.7, east: -105, north: 39.8 };
    const [first, second] = await Promise.all([
      source.loadBounds(bounds),
      source.loadBounds(bounds),
    ]);
    const third = await source.loadBounds(bounds);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first).toHaveLength(3);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('reuses its persistent cache after a new service instance starts', async () => {
    const cacheDirectory = await temporaryDirectory();
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            elements: [{ type: 'way', id: 4, nodes: [1, 2], tags: { highway: 'service' } }],
          }),
          {
            status: 200,
          },
        ),
    );
    const bounds = { west: -105.1, south: 39.7, east: -105, north: 39.8 };
    await new OsmDataSource({ fetcher, cacheDirectory, minRequestIntervalMs: 0 }).loadBounds(
      bounds,
    );
    const restored = await new OsmDataSource({
      fetcher: vi.fn(),
      cacheDirectory,
      minRequestIntervalMs: 0,
    }).loadBounds(bounds);

    expect(restored).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('selects a regional public mirror for common map regions', () => {
    expect(defaultOverpassEndpoint({ longitude: -104.99, latitude: 39.74 })).toContain('api-na');
    expect(defaultOverpassEndpoint({ longitude: -3.18, latitude: 55.95 })).toContain(
      '/api/interpreter',
    );
    expect(defaultOverpassEndpoint({ longitude: 151.2, latitude: -33.8 })).toContain('api-oc');
  });

  it('refuses a request with an unsafe bounding box', async () => {
    const source = new OsmDataSource({
      fetcher: vi.fn(),
      cacheDirectory: await temporaryDirectory(),
    });
    await expect(
      source.loadBounds({ west: -110, south: 35, east: -100, north: 45 }),
    ).rejects.toMatchObject({ name: 'OsmDataError', statusCode: 413 });
  });

  it('rejects Overpass memory-limit remarks instead of caching an empty map', async () => {
    const source = new OsmDataSource({
      fetcher: vi.fn(
        async () =>
          new Response(JSON.stringify({ elements: [], remark: 'runtime error: out of memory' }), {
            status: 200,
          }),
      ),
      cacheDirectory: await temporaryDirectory(),
      minRequestIntervalMs: 0,
      retryCount: 0,
    });
    await expect(
      source.loadBounds({ west: -105.1, south: 39.7, east: -105, north: 39.8 }),
    ).rejects.toThrow('Overpass reported: runtime error');
  });

  it('rejects an oversized response before parsing it', async () => {
    const source = new OsmDataSource({
      fetcher: vi.fn(
        async () => new Response('{}', { status: 200, headers: { 'content-length': '20000000' } }),
      ),
      cacheDirectory: await temporaryDirectory(),
      minRequestIntervalMs: 0,
    });
    await expect(
      source.loadBounds({ west: -105.1, south: 39.7, east: -105, north: 39.8 }),
    ).rejects.toThrow('16 MB safety limit');
  });

  it('splits a region at the international date line and preserves tile-sized coverage', () => {
    const cell = tileCellAt({ longitude: 179.99, latitude: 10 });
    const bounds = regionBounds(cell, 1);
    expect(bounds).toHaveLength(2);
    expect(bounds[0].east).toBe(180);
    expect(bounds[1].west).toBe(-180);
    expect(bounds.every((box) => box.south < box.north && box.west < box.east)).toBe(true);
  });

  it('applies the configured timeout and output-size limits in each query', () => {
    expect(() => buildOverpassQuery({ west: -180, south: -85, east: 180, north: 85 })).toThrow(
      OsmDataError,
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'openstreet-racer-osm-'));
  tempDirectories.push(directory);
  return directory;
}
