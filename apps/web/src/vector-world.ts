import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import type { TileCell, WorldFeature, WorldGeometry } from '@openstreet-racer/world';

interface TileJson {
  tiles?: string[];
}

const TILEJSON_URL = 'https://tiles.openfreemap.org/planet';
const RELEVANT_LAYERS = [
  'transportation',
  'building',
  'park',
  'water',
  'waterway',
  'landcover',
  'landuse',
] as const;
const DRIVEABLE_CLASSES = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'minor',
  'service',
  'track',
  'path',
  'living_street',
  'residential',
  'unclassified',
  'road',
]);
const GREEN_CLASSES = new Set([
  'park',
  'forest',
  'wood',
  'grass',
  'scrub',
  'meadow',
  'heath',
  'cemetery',
  'garden',
  'pitch',
  'wetland',
]);
const TILE_CACHE_LIMIT = 16;
const tileCache = new Map<string, Promise<WorldFeature[]>>();
let tileTemplatePromise: Promise<string> | null = null;

export function fetchWorldFeatures(cell: TileCell): Promise<WorldFeature[]> {
  const existing = tileCache.get(cell.key);
  if (existing) {
    tileCache.delete(cell.key);
    tileCache.set(cell.key, existing);
    return existing;
  }

  const request = loadWorldFeatures(cell).catch((error: unknown) => {
    tileCache.delete(cell.key);
    throw error;
  });
  tileCache.set(cell.key, request);
  while (tileCache.size > TILE_CACHE_LIMIT) {
    const oldest = tileCache.keys().next().value;
    if (oldest === undefined) break;
    tileCache.delete(oldest);
  }
  return request;
}

async function loadWorldFeatures(cell: TileCell): Promise<WorldFeature[]> {
  const template = await getTileTemplate();
  const url = template
    .replaceAll('{z}', String(cell.z))
    .replaceAll('{x}', String(cell.x))
    .replaceAll('{y}', String(cell.y));
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Vector tile request returned HTTP ${response.status}.`);

  const bytes = new Uint8Array(await response.arrayBuffer());
  const vectorTile = new VectorTile(new PbfReader(bytes));
  const features: WorldFeature[] = [];
  for (const layerName of RELEVANT_LAYERS) {
    const layer = vectorTile.layers[layerName];
    if (!layer) continue;
    for (let index = 0; index < layer.length; index += 1) {
      const vectorFeature = layer.feature(index);
      const properties = vectorFeature.properties;
      if (!includeFeature(layerName, properties)) continue;
      const geojson = vectorFeature.toGeoJSON(cell.x, cell.y, cell.z);
      if (!isWorldGeometry(geojson.geometry)) continue;
      features.push({
        id: `${layerName}/${vectorFeature.id ?? index}`,
        layer: layerName,
        properties,
        geometry: geojson.geometry,
      });
    }
  }
  return features;
}

function getTileTemplate(): Promise<string> {
  if (!tileTemplatePromise) {
    tileTemplatePromise = fetch(TILEJSON_URL, { signal: AbortSignal.timeout(15_000) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Vector tile index returned HTTP ${response.status}.`);
        const tileJson = (await response.json()) as TileJson;
        const template = tileJson.tiles?.[0];
        if (
          !template ||
          !template.includes('{z}') ||
          !template.includes('{x}') ||
          !template.includes('{y}')
        ) {
          throw new Error('The OpenFreeMap vector tile index is missing its tile template.');
        }
        return template;
      })
      .catch((error: unknown) => {
        tileTemplatePromise = null;
        throw error;
      });
  }
  return tileTemplatePromise;
}

function includeFeature(
  layer: string,
  properties: Readonly<Record<string, string | number | boolean>>,
): boolean {
  if (layer === 'transportation') {
    const roadClass = properties.class;
    return typeof roadClass === 'string' && DRIVEABLE_CLASSES.has(roadClass);
  }
  if (layer === 'landuse' || layer === 'landcover') {
    const landClass = properties.class;
    return typeof landClass === 'string' && GREEN_CLASSES.has(landClass);
  }
  return true;
}

function isWorldGeometry(geometry: unknown): geometry is WorldGeometry {
  if (!geometry || typeof geometry !== 'object' || !('type' in geometry)) return false;
  const type = geometry.type;
  return (
    type === 'LineString' ||
    type === 'MultiLineString' ||
    type === 'Polygon' ||
    type === 'MultiPolygon'
  );
}
