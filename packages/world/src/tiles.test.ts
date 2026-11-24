import { describe, expect, it } from 'vitest';
import { tileCellAtXY, tileForLocation, tileNeighbors } from './tiles';

const DENVER = { longitude: -104.9903, latitude: 39.7392 };

describe('Web Mercator tile cells', () => {
  it('maps the same location to a stable z14 cell and round-trips its center', () => {
    const tile = tileForLocation(DENVER);
    expect(tile.z).toBe(14);
    expect(tile.key).toBe(`${tile.z}/${tile.x}/${tile.y}`);
    expect(tileForLocation(tile.center).key).toBe(tile.key);
  });

  it('wraps the antimeridian and clamps the Mercator latitude limit', () => {
    expect(tileForLocation({ longitude: 180, latitude: 0 }).x).toBe(0);
    expect(tileForLocation({ longitude: -180, latitude: 0 }).x).toBe(0);
    expect(tileForLocation({ longitude: 0, latitude: 90 }).y).toBe(0);
    expect(tileForLocation({ longitude: 0, latitude: -90 }).y).toBe(2 ** 14 - 1);
  });

  it('returns a unique neighboring cell set at tile and world edges', () => {
    const edge = tileCellAtXY(0, 0, 14);
    const neighbors = tileNeighbors(edge, 1);
    expect(neighbors).toHaveLength(6);
    expect(new Set(neighbors.map((tile) => tile.key)).size).toBe(neighbors.length);
    expect(neighbors.some((tile) => tile.x === 2 ** 14 - 1)).toBe(true);
    expect(neighbors.every((tile) => tile.y >= 0)).toBe(true);
  });

  it('rejects invalid zoom levels', () => {
    expect(() => tileForLocation(DENVER, 23)).toThrow(RangeError);
  });
});
