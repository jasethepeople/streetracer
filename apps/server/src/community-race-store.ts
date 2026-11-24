import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LonLat, MissionOffer } from '@openstreet-racer/shared';
import { MAX_ROUTE_DISTANCE_METERS } from '@openstreet-racer/shared';
import { haversineMeters } from '@openstreet-racer/world';

const STORE_VERSION = 1;
const MAX_STORED_RACES = 500;
const MAX_STORED_CHECKPOINTS = 6;
const MAX_RACES_PER_QUERY = 24;
const DEFAULT_DIRECTORY = fileURLToPath(
  new URL('../../../.data/openstreet-racer', import.meta.url),
);

export class CommunityRaceStore {
  private readonly filePath: string;
  private readonly races = new Map<string, MissionOffer>();
  private loadPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(directory = process.env.PLAYER_DATA_DIR ?? DEFAULT_DIRECTORY) {
    this.filePath = resolve(directory, 'community-races.json');
  }

  async create(offer: MissionOffer): Promise<MissionOffer> {
    await this.ensureLoaded();
    if (!isCommunityRace(offer)) throw new Error('Community race is invalid.');
    if (this.races.has(offer.id)) throw new Error('Community race ID already exists.');
    this.races.set(offer.id, cloneOffer(offer));
    while (this.races.size > MAX_STORED_RACES) {
      const oldest = this.races.keys().next().value;
      if (oldest === undefined) break;
      this.races.delete(oldest);
    }
    await this.persist();
    return cloneOffer(offer);
  }

  async listNearby(
    location: LonLat,
    radiusMeters = MAX_ROUTE_DISTANCE_METERS,
  ): Promise<readonly MissionOffer[]> {
    await this.ensureLoaded();
    return [...this.races.values()]
      .filter((offer) => haversineMeters(location, offer.pickup.location) <= radiusMeters)
      .sort(
        (first, second) =>
          haversineMeters(location, first.pickup.location) -
          haversineMeters(location, second.pickup.location),
      )
      .slice(0, MAX_RACES_PER_QUERY)
      .map(cloneOffer);
  }

  async close(): Promise<void> {
    await this.ensureLoaded();
    await this.writeQueue;
  }

  private ensureLoaded(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.load();
    return this.loadPromise;
  }

  private async load(): Promise<void> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new Error('Community race data is not valid JSON; refusing to overwrite it.');
    }
    if (!isRecord(parsed) || parsed.version !== STORE_VERSION || !Array.isArray(parsed.races)) {
      throw new Error('Community race data has an unsupported format; refusing to overwrite it.');
    }
    for (const value of parsed.races) {
      if (isCommunityRace(value)) this.races.set(value.id, cloneOffer(value));
    }
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify({ version: STORE_VERSION, races: [...this.races.values()] });
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await mkdir(resolve(this.filePath, '..'), { recursive: true });
        const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
        await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600 });
        await rename(temporaryPath, this.filePath);
      });
    return this.writeQueue;
  }
}

function isCommunityRace(value: unknown): value is MissionOffer {
  if (!isRecord(value)) return false;
  if (
    value.source !== 'community' ||
    value.kind !== 'checkpoint-race' ||
    !isSafeText(value.id, 96) ||
    !/^community-race-[0-9a-f-]{36}$/iu.test(value.id) ||
    !isSafeText(value.creatorHandle, 20) ||
    !isSafeText(value.title, 72) ||
    !isSafeText(value.areaKey, 32) ||
    !isMissionPlace(value.pickup) ||
    !isMissionPlace(value.destination) ||
    !Array.isArray(value.route) ||
    value.route.length < 2 ||
    value.route.length > 32 ||
    !value.route.every(isLonLat) ||
    !Array.isArray(value.checkpoints) ||
    value.checkpoints.length < 1 ||
    value.checkpoints.length > MAX_STORED_CHECKPOINTS ||
    !value.checkpoints.every(isLonLat) ||
    !isBoundedNumber(value.distanceMeters, 300, MAX_ROUTE_DISTANCE_METERS) ||
    !isBoundedNumber(value.minimumTimeSeconds, 2, 600) ||
    !isBoundedNumber(value.timeLimitSeconds, value.minimumTimeSeconds, 1_800) ||
    !isBoundedNumber(value.rewardCents, 1, 10_000)
  ) {
    return false;
  }
  return true;
}

function isMissionPlace(value: unknown): boolean {
  return (
    isRecord(value) &&
    isSafeText(value.id, 96) &&
    isSafeText(value.name, 72) &&
    isSafeText(value.category, 32) &&
    isLonLat(value.location)
  );
}

function isLonLat(value: unknown): value is LonLat {
  return (
    isRecord(value) &&
    typeof value.longitude === 'number' &&
    Number.isFinite(value.longitude) &&
    value.longitude >= -180 &&
    value.longitude <= 180 &&
    typeof value.latitude === 'number' &&
    Number.isFinite(value.latitude) &&
    value.latitude >= -85.05113 &&
    value.latitude <= 85.05113
  );
}

function isSafeText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function isBoundedNumber(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
  );
}

function cloneOffer(offer: MissionOffer): MissionOffer {
  return {
    ...offer,
    pickup: { ...offer.pickup, location: { ...offer.pickup.location } },
    destination: { ...offer.destination, location: { ...offer.destination.location } },
    route: offer.route.map((point) => ({ ...point })),
    checkpoints: offer.checkpoints.map((point) => ({ ...point })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
