import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tileCellAtXY, type TileCell, type OsmElement } from '@openstreet-racer/world';

const GLOBAL_ENDPOINT = 'https://overpass.private.coffee/api/interpreter';
const REGIONAL_ENDPOINTS = {
  northAmerica: 'https://ovp.dresel.systems/api-na/interpreter',
  centralAmerica: 'https://ovp.dresel.systems/api-ca/interpreter',
  southAmerica: 'https://ovp.dresel.systems/api-sa/interpreter',
  europe: 'https://ovp.dresel.systems/api/interpreter',
  africa: 'https://ovp.dresel.systems/api-af/interpreter',
  asia: 'https://ovp.dresel.systems/api-as/interpreter',
  oceania: 'https://ovp.dresel.systems/api-oc/interpreter',
} as const;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 1_100;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ELEMENTS = 160_000;
const MAX_REGION_RADIUS = 1;
const MAX_QUERY_AREA_KM2 = 150;
const MAX_QUERY_SIDE_KM = 25;
const MAX_DISK_ENTRIES = 128;

type Fetcher = typeof fetch;

interface CachedElements {
  readonly cachedAt: number;
  readonly elements: readonly OsmElement[];
}

interface OsmDataOptions {
  readonly endpoint?: string;
  readonly cacheDirectory?: string;
  readonly ttlMs?: number;
  readonly minRequestIntervalMs?: number;
  readonly fetcher?: Fetcher;
  readonly now?: () => number;
  readonly retryCount?: number;
  readonly userAgent?: string;
}

export interface GeoBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

export class OsmDataError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502,
  ) {
    super(message);
    this.name = 'OsmDataError';
  }
}

export class OsmDataSource {
  private readonly endpointOverride: string | undefined;
  private readonly cacheDirectory: string;
  private readonly ttlMs: number;
  private readonly minRequestIntervalMs: number;
  private readonly fetcher: Fetcher;
  private readonly now: () => number;
  private readonly retryCount: number;
  private readonly userAgent: string;
  private readonly memory = new Map<string, CachedElements>();
  private readonly inFlight = new Map<string, Promise<readonly OsmElement[]>>();
  private requestQueue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;

  constructor(options: OsmDataOptions = {}) {
    const endpoint = options.endpoint ?? process.env.OSM_OVERPASS_URL;
    this.endpointOverride = endpoint?.trim() || undefined;
    this.cacheDirectory = resolve(
      options.cacheDirectory ?? process.env.OSM_CACHE_DIR ?? '.cache/openstreet-racer/osm',
    );
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? DEFAULT_MIN_REQUEST_INTERVAL_MS;
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.retryCount = options.retryCount ?? 2;
    this.userAgent =
      options.userAgent ??
      (process.env.OSM_CONTACT_EMAIL
        ? `OpenStreetRacer/0.1 (mailto:${process.env.OSM_CONTACT_EMAIL})`
        : 'OpenStreetRacer/0.1');
  }

  async loadRegion(center: TileCell, radius = 1): Promise<readonly OsmElement[]> {
    const boundedRadius = Math.max(0, Math.min(MAX_REGION_RADIUS, Math.trunc(radius)));
    const boundsList = regionBounds(center, boundedRadius);
    const elementSets = await Promise.all(boundsList.map((bounds) => this.loadBounds(bounds)));
    const elements = new Map<string, OsmElement>();
    for (const set of elementSets) {
      for (const element of set) elements.set(`${element.type}/${element.id}`, element);
    }
    return [...elements.values()];
  }

  async loadBounds(bounds: GeoBounds): Promise<readonly OsmElement[]> {
    const safeBounds = validateBounds(bounds);
    const endpoint =
      this.endpointOverride ??
      defaultOverpassEndpoint({
        longitude: (safeBounds.west + safeBounds.east) / 2,
        latitude: (safeBounds.south + safeBounds.north) / 2,
      });
    const key = createHash('sha256')
      .update(`v2:${endpoint}:${boundsKey(safeBounds)}`)
      .digest('hex');
    const memoryHit = this.getMemory(key);
    if (memoryHit) return memoryHit;
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const request = this.readDisk(key).then(async (diskHit) => {
      if (diskHit) {
        this.setMemory(key, diskHit.elements, diskHit.cachedAt);
        return diskHit.elements;
      }
      const elements = await this.fetchBounds(safeBounds, endpoint);
      const entry = { cachedAt: this.now(), elements };
      this.setMemory(key, elements, entry.cachedAt);
      await this.writeDisk(key, entry).catch(() => undefined);
      return elements;
    });
    this.inFlight.set(key, request);
    try {
      return await request;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async fetchBounds(bounds: GeoBounds, endpoint: string): Promise<readonly OsmElement[]> {
    const query = buildOverpassQuery(bounds);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      try {
        const response = await this.queuedFetch(query, endpoint);
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          if (!retryable || attempt === this.retryCount) {
            throw new OsmDataError(`Overpass returned HTTP ${response.status}.`, response.status);
          }
          await wait(retryDelay(response.headers.get('retry-after'), attempt));
          continue;
        }
        const contentLength = Number(response.headers.get('content-length') ?? 0);
        if (contentLength > MAX_RESPONSE_BYTES) {
          throw new OsmDataError('Overpass response exceeded the 16 MB safety limit.', 413);
        }
        const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          throw new OsmDataError('Overpass returned invalid JSON.');
        }
        return parseElements(payload);
      } catch (error) {
        lastError = error;
        if (error instanceof OsmDataError && error.statusCode < 500) throw error;
        if (attempt === this.retryCount) break;
        await wait(retryDelay(null, attempt));
      }
    }
    const detail = lastError instanceof Error ? lastError.message : 'request failed';
    throw new OsmDataError(`Unable to load OpenStreetMap road data: ${detail}`);
  }

  private async queuedFetch(query: string, endpoint: string): Promise<Response> {
    let release!: () => void;
    const previous = this.requestQueue;
    this.requestQueue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    try {
      const waitMs = Math.max(0, this.nextRequestAt - this.now());
      if (waitMs > 0) await wait(waitMs);
      this.nextRequestAt = this.now() + this.minRequestIntervalMs;
      return await this.fetcher(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'user-agent': this.userAgent,
          accept: 'application/json',
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(30_000),
      });
    } finally {
      release();
    }
  }

  private getMemory(key: string): readonly OsmElement[] | undefined {
    const entry = this.memory.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.cachedAt >= this.ttlMs) {
      this.memory.delete(key);
      return undefined;
    }
    this.memory.delete(key);
    this.memory.set(key, entry);
    return entry.elements;
  }

  private setMemory(key: string, elements: readonly OsmElement[], cachedAt = this.now()): void {
    this.memory.delete(key);
    this.memory.set(key, { cachedAt, elements });
    while (this.memory.size > MAX_DISK_ENTRIES) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
  }

  private async readDisk(key: string): Promise<CachedElements | undefined> {
    const path = resolve(this.cacheDirectory, `${key}.json`);
    try {
      const fileInfo = await stat(path);
      if (fileInfo.size > MAX_RESPONSE_BYTES) {
        await rm(path, { force: true });
        return undefined;
      }
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!isCacheRecord(parsed) || this.now() - parsed.cachedAt >= this.ttlMs) {
        await rm(path, { force: true });
        return undefined;
      }
      try {
        return {
          cachedAt: parsed.cachedAt,
          elements: parseElements({ elements: parsed.elements }),
        };
      } catch {
        await rm(path, { force: true });
        return undefined;
      }
    } catch {
      return undefined;
    }
  }

  private async writeDisk(key: string, entry: CachedElements): Promise<void> {
    await mkdir(this.cacheDirectory, { recursive: true });
    const path = resolve(this.cacheDirectory, `${key}.json`);
    const temporaryPath = `${path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(entry), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, path);
    await this.pruneDisk();
  }

  private async pruneDisk(): Promise<void> {
    const names = await readdir(this.cacheDirectory).catch(() => [] as string[]);
    const entries = await Promise.all(
      names
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map(async (name) => {
          const path = resolve(this.cacheDirectory, name);
          const info = await stat(path).catch(() => null);
          return info ? { path, modifiedAt: info.mtimeMs } : null;
        }),
    );
    const valid = entries
      .filter((entry) => entry !== null)
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
    for (const stale of valid.slice(MAX_DISK_ENTRIES)) await rm(stale.path, { force: true });
  }
}

export function regionBounds(center: TileCell, radius: number): GeoBounds[] {
  const scale = 2 ** center.z;
  const leftX = center.x - radius;
  const rightX = center.x + radius + 1;
  const topY = Math.max(0, center.y - radius);
  const bottomY = Math.min(scale, center.y + radius + 1);
  const north = tileCellAtXY(center.x, topY, center.z).bounds.north;
  const south = tileCellAtXY(center.x, bottomY - 1, center.z).bounds.south;
  const west = (leftX / scale) * 360 - 180;
  const east = (rightX / scale) * 360 - 180;
  if (west < -180) {
    return [
      { west: west + 360, south, east: 180, north },
      { west: -180, south, east, north },
    ];
  }
  if (east > 180) {
    return [
      { west, south, east: 180, north },
      { west: -180, south, east: east - 360, north },
    ];
  }
  return [{ west, south, east, north }];
}

export function defaultOverpassEndpoint(location: {
  readonly longitude: number;
  readonly latitude: number;
}): string {
  const { longitude, latitude } = location;
  if (latitude <= -10 && longitude >= 90) return REGIONAL_ENDPOINTS.oceania;
  if (latitude >= 5 && latitude < 25 && longitude >= -118 && longitude <= -77) {
    return REGIONAL_ENDPOINTS.centralAmerica;
  }
  if (latitude >= -56 && latitude < 12 && longitude >= -82 && longitude <= -34) {
    return REGIONAL_ENDPOINTS.southAmerica;
  }
  if (latitude >= 15 && longitude >= -170 && longitude <= -50)
    return REGIONAL_ENDPOINTS.northAmerica;
  if (latitude >= 35 && longitude >= -25 && longitude <= 45) return REGIONAL_ENDPOINTS.europe;
  if (latitude >= -36 && latitude < 35 && longitude >= -20 && longitude <= 55) {
    return REGIONAL_ENDPOINTS.africa;
  }
  if (latitude >= -12 && longitude >= 25) return REGIONAL_ENDPOINTS.asia;
  return GLOBAL_ENDPOINT;
}

export function buildOverpassQuery(bounds: GeoBounds): string {
  const safe = validateBounds(bounds);
  const bbox = `${safe.south.toFixed(6)},${safe.west.toFixed(6)},${safe.north.toFixed(6)},${safe.east.toFixed(6)}`;
  const amenity =
    'restaurant|cafe|fast_food|pub|bar|school|college|university|kindergarten|hospital|clinic|pharmacy|bank|fuel|marketplace';
  const leisure = 'park|playground|sports_centre';
  const tourism = 'museum|attraction';
  const placeQueries = ['node', 'way', 'relation']
    .flatMap((type) => [
      `${type}["shop"](${bbox});`,
      `${type}["amenity"~"^(${amenity})$"](${bbox});`,
      `${type}["leisure"~"^(${leisure})$"](${bbox});`,
      `${type}["tourism"~"^(${tourism})$"](${bbox});`,
    ])
    .join('');
  return `[out:json][timeout:25][maxsize:16777216];(way["highway"](${bbox});node["highway"~"^(traffic_signals|stop|crossing)$"](${bbox});${placeQueries});(._;>;>;);out body;`;
}

function validateBounds(bounds: GeoBounds): GeoBounds {
  const { west, south, east, north } = bounds;
  if (
    ![west, south, east, north].every(Number.isFinite) ||
    west < -180 ||
    east > 180 ||
    west >= east ||
    south < -85.0511 ||
    north > 85.0511 ||
    south >= north
  ) {
    throw new OsmDataError('The requested OpenStreetMap bounds are invalid.', 400);
  }
  const latitudeKm = (north - south) * 111.32;
  const longitudeKm = (east - west) * 111.32 * Math.cos((((south + north) / 2) * Math.PI) / 180);
  if (
    latitudeKm > MAX_QUERY_SIDE_KM ||
    longitudeKm > MAX_QUERY_SIDE_KM ||
    latitudeKm * longitudeKm > MAX_QUERY_AREA_KM2
  ) {
    throw new OsmDataError('The requested OpenStreetMap area is too large.', 413);
  }
  return { west, south, east, north };
}

function boundsKey(bounds: GeoBounds): string {
  return createHash('sha256')
    .update(
      [bounds.west, bounds.south, bounds.east, bounds.north]
        .map((value) => value.toFixed(6))
        .join(','),
    )
    .digest('hex');
}

async function readBoundedText(response: Response, limitBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limitBytes) {
      throw new OsmDataError('Overpass response exceeded the 16 MB safety limit.', 413);
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limitBytes) {
        await reader.cancel();
        throw new OsmDataError('Overpass response exceeded the 16 MB safety limit.', 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function parseElements(payload: unknown): readonly OsmElement[] {
  const remark =
    payload && typeof payload === 'object' ? (payload as { remark?: unknown }).remark : undefined;
  if (typeof remark === 'string' && remark.trim()) {
    throw new OsmDataError(`Overpass reported: ${remark.trim().slice(0, 300)}`);
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray((payload as { elements?: unknown }).elements)
  ) {
    throw new OsmDataError('Overpass response did not contain an elements array.');
  }
  const rawElements = (payload as { elements: unknown[] }).elements;
  if (rawElements.length > MAX_ELEMENTS) {
    throw new OsmDataError('Overpass returned too many map elements.', 413);
  }
  const elements: OsmElement[] = [];
  for (const raw of rawElements) {
    if (!raw || typeof raw !== 'object') continue;
    const element = raw as Record<string, unknown>;
    const id = element.id;
    const tags = parseTags(element.tags);
    if ((typeof id !== 'number' && typeof id !== 'string') || !tags) continue;
    if (element.type === 'node') {
      const lat = element.lat;
      const lon = element.lon;
      if (
        typeof lat !== 'number' ||
        typeof lon !== 'number' ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        lat < -90 ||
        lat > 90 ||
        lon < -180 ||
        lon > 180
      )
        continue;
      elements.push({ type: 'node', id, lat, lon, tags });
    } else if (element.type === 'way' && Array.isArray(element.nodes)) {
      const nodes = element.nodes.filter(
        (node): node is number | string => typeof node === 'number' || typeof node === 'string',
      );
      if (nodes.length >= 2) elements.push({ type: 'way', id, nodes, tags });
    } else if (element.type === 'relation' && Array.isArray(element.members)) {
      const members = element.members.flatMap(
        (member): { type: 'node' | 'way' | 'relation'; ref: number | string; role?: string }[] => {
          if (!member || typeof member !== 'object') return [];
          const value = member as Record<string, unknown>;
          if (
            (value.type !== 'node' && value.type !== 'way' && value.type !== 'relation') ||
            (typeof value.ref !== 'number' && typeof value.ref !== 'string')
          ) {
            return [];
          }
          return [
            {
              type: value.type,
              ref: value.ref,
              ...(typeof value.role === 'string' ? { role: value.role } : {}),
            },
          ];
        },
      );
      if (members.length) elements.push({ type: 'relation', id, members, tags });
    }
  }
  return elements;
}

function parseTags(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const tags: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value))
    if (typeof entry === 'string') tags[key] = entry;
  return tags;
}

function isCacheRecord(
  value: unknown,
): value is { readonly cachedAt: number; readonly elements: unknown[] } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return Number.isFinite(record.cachedAt) && Array.isArray(record.elements);
}

function retryDelay(header: string | null, attempt: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(1_000, Math.min(30_000, seconds * 1_000));
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(1_000, Math.min(30_000, date - Date.now()));
  }
  return Math.min(10_000, 1_000 * 2 ** attempt);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}
