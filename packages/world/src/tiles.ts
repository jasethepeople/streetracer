import type { LonLat } from '@openstreet-racer/shared';

export const WORLD_TILE_ZOOM = 14;

export interface TileCell {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly key: string;
  readonly center: LonLat;
  readonly bounds: {
    readonly west: number;
    readonly south: number;
    readonly east: number;
    readonly north: number;
  };
  readonly halfSizeMeters: number;
}

export function tileCellAt(location: LonLat, z = WORLD_TILE_ZOOM): TileCell {
  const zoom = validateZoom(z);
  const scale = 2 ** zoom;
  const longitude = ((((location.longitude + 180) % 360) + 360) % 360) - 180;
  const latitude = clamp(location.latitude, -85.05112878, 85.05112878);
  const x = Math.floor(((longitude + 180) / 360) * scale);
  const latitudeRadians = (latitude * Math.PI) / 180;
  const y = clamp(
    Math.floor(((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2) * scale),
    0,
    scale - 1,
  );
  return createTileCell(x, y, zoom);
}

export function tileForLocation(location: LonLat, z = WORLD_TILE_ZOOM): TileCell {
  return tileCellAt(location, z);
}

export function tileCellAtXY(x: number, y: number, z = WORLD_TILE_ZOOM): TileCell {
  const zoom = validateZoom(z);
  const scale = 2 ** zoom;
  const wrappedX = ((Math.trunc(x) % scale) + scale) % scale;
  const clampedY = Math.max(0, Math.min(scale - 1, Math.trunc(y)));
  return createTileCell(wrappedX, clampedY, zoom);
}

export function tileNeighbors(cell: TileCell, radius: number): TileCell[] {
  const neighbors = new Map<string, TileCell>();
  const distance = Math.max(0, Math.min(4, Math.trunc(radius)));
  for (let dy = -distance; dy <= distance; dy += 1) {
    for (let dx = -distance; dx <= distance; dx += 1) {
      const neighbor = tileCellAtXY(cell.x + dx, cell.y + dy, cell.z);
      neighbors.set(neighbor.key, neighbor);
    }
  }
  return [...neighbors.values()];
}

function createTileCell(x: number, y: number, z: number): TileCell {
  const scale = 2 ** z;
  const west = (x / scale) * 360 - 180;
  const east = ((x + 1) / scale) * 360 - 180;
  const north = tileYToLatitude(y, scale);
  const south = tileYToLatitude(y + 1, scale);
  const center = {
    longitude: (west + east) / 2,
    latitude: tileYToLatitude(y + 0.5, scale),
  };
  const projectedTileWidth = (2 * Math.PI * 6_378_137) / scale;
  const halfSizeMeters = (projectedTileWidth * Math.cos((center.latitude * Math.PI) / 180)) / 2;
  return {
    z,
    x,
    y,
    key: `${z}/${x}/${y}`,
    center,
    bounds: { west, south, east, north },
    halfSizeMeters,
  };
}

function tileYToLatitude(y: number, scale: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / scale))) * 180) / Math.PI;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function validateZoom(z: number): number {
  if (!Number.isInteger(z) || z < 0 || z > 22)
    throw new RangeError('Tile zoom must be an integer from 0 to 22.');
  return z;
}
