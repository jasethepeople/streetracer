import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ActiveMission,
  LeaderboardEntry,
  LeaderboardSnapshot,
  MissionOffer,
  PlayerProfile,
} from '@openstreet-racer/shared';
import { WANTED_MAX_LEVEL } from '@openstreet-racer/shared';
import { STARTING_VEHICLE_ID } from '@openstreet-racer/vehicle/catalog';

const STORE_VERSION = 1;
const MAX_COMPLETED_MISSION_IDS = 4_096;
const DEFAULT_DIRECTORY = fileURLToPath(
  new URL('../../../.data/openstreet-racer', import.meta.url),
);

export interface StoredPlayer {
  readonly profile: PlayerProfile;
  readonly handle: string;
  readonly areaScores: Readonly<Record<string, number>>;
  readonly areaCompletedAtMs: Readonly<Record<string, number>>;
  readonly bestRaceTimes: Readonly<Record<string, number>>;
  readonly bestRaceCompletedAtMs: Readonly<Record<string, number>>;
  readonly completedMissionIds: readonly string[];
}

export interface MissionAcceptance {
  readonly status: 'accepted' | 'active' | 'completed';
  readonly profile: PlayerProfile;
}

export class PlayerStore {
  private readonly filePath: string;
  private readonly players = new Map<string, StoredPlayer>();
  private loadPromise: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly playerQueues = new Map<string, Promise<void>>();

  constructor(directory = process.env.PLAYER_DATA_DIR ?? DEFAULT_DIRECTORY) {
    this.filePath = resolve(directory, 'players.json');
  }

  async getOrCreate(anonymousPlayerId: string, handle: string): Promise<PlayerProfile> {
    await this.ensureLoaded();
    return this.withPlayerLock(anonymousPlayerId, async () => {
      const current = this.players.get(anonymousPlayerId);
      if (!current) {
        const record = createPlayer(anonymousPlayerId, handle);
        this.players.set(anonymousPlayerId, record);
        await this.persist();
        return cloneProfile(record.profile);
      }
      if (current.handle !== handle) {
        this.players.set(anonymousPlayerId, { ...current, handle });
        await this.persist();
      }
      return cloneProfile(current.profile);
    });
  }

  async updateProfile(
    anonymousPlayerId: string,
    update: (profile: PlayerProfile) => PlayerProfile,
    handle?: string,
  ): Promise<PlayerProfile> {
    await this.ensureLoaded();
    return this.withPlayerLock(anonymousPlayerId, async () => {
      const current =
        this.players.get(anonymousPlayerId) ?? createPlayer(anonymousPlayerId, handle ?? 'Driver');
      const profile = sanitizeProfile(update(cloneProfile(current.profile)), anonymousPlayerId);
      this.players.set(anonymousPlayerId, {
        ...current,
        profile,
        handle: handle ?? current.handle,
      });
      await this.persist();
      return cloneProfile(profile);
    });
  }

  async acceptMission(
    anonymousPlayerId: string,
    handle: string,
    offer: MissionOffer,
    acceptedAtMs: number,
  ): Promise<MissionAcceptance> {
    await this.ensureLoaded();
    return this.withPlayerLock(anonymousPlayerId, async () => {
      const current =
        this.players.get(anonymousPlayerId) ?? createPlayer(anonymousPlayerId, handle);
      if (current.completedMissionIds.includes(offer.id)) {
        return { status: 'completed', profile: cloneProfile(current.profile) };
      }
      if (current.profile.activeMission) {
        return { status: 'active', profile: cloneProfile(current.profile) };
      }
      const profile = sanitizeProfile(
        {
          ...current.profile,
          activeMission: { offer, acceptedAtMs, startedAtMs: null, nextCheckpointIndex: 0 },
        },
        anonymousPlayerId,
      );
      this.players.set(anonymousPlayerId, { ...current, profile, handle });
      await this.persist();
      return { status: 'accepted', profile: cloneProfile(profile) };
    });
  }

  async hasCompletedMission(anonymousPlayerId: string, missionId: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.withPlayerLock(
      anonymousPlayerId,
      async () =>
        this.players.get(anonymousPlayerId)?.completedMissionIds.includes(missionId) ?? false,
    );
  }

  async recordMissionCompletion(
    anonymousPlayerId: string,
    handle: string,
    offer: MissionOffer,
    durationSeconds: number,
    completedAtMs: number,
  ): Promise<PlayerProfile | null> {
    await this.ensureLoaded();
    return this.withPlayerLock(anonymousPlayerId, async () => {
      const current =
        this.players.get(anonymousPlayerId) ?? createPlayer(anonymousPlayerId, handle);
      if (
        current.completedMissionIds.includes(offer.id) ||
        current.profile.activeMission?.offer.id !== offer.id ||
        !Number.isFinite(durationSeconds) ||
        durationSeconds <= 0 ||
        !Number.isSafeInteger(completedAtMs)
      ) {
        return null;
      }
      const areaScores = {
        ...current.areaScores,
        [offer.areaKey]: (current.areaScores[offer.areaKey] ?? 0) + offer.rewardCents,
      };
      const areaCompletedAtMs = { ...current.areaCompletedAtMs, [offer.areaKey]: completedAtMs };
      const bestRaceTimes = { ...current.bestRaceTimes };
      const bestRaceCompletedAtMs = { ...current.bestRaceCompletedAtMs };
      if (isRace(offer.kind) && durationSeconds < (bestRaceTimes[offer.id] ?? Infinity)) {
        bestRaceTimes[offer.id] = durationSeconds;
        bestRaceCompletedAtMs[offer.id] = completedAtMs;
      }
      const completedMissionIds = [...current.completedMissionIds, offer.id].slice(
        -MAX_COMPLETED_MISSION_IDS,
      );
      const profile = sanitizeProfile(
        {
          ...current.profile,
          balanceCents: current.profile.balanceCents + offer.rewardCents,
          totalMissions: current.profile.totalMissions + 1,
          activeMission: null,
        },
        anonymousPlayerId,
      );
      this.players.set(anonymousPlayerId, {
        profile,
        handle,
        areaScores,
        areaCompletedAtMs,
        bestRaceTimes,
        bestRaceCompletedAtMs,
        completedMissionIds,
      });
      await this.persist();
      return cloneProfile(profile);
    });
  }

  async getLeaderboard(areaKey: string, raceId: string | null): Promise<LeaderboardSnapshot> {
    await this.ensureLoaded();
    const entries: LeaderboardEntry[] = [];
    for (const [anonymousPlayerId, record] of this.players) {
      if (raceId) {
        const timeSeconds = record.bestRaceTimes[raceId];
        if (timeSeconds === undefined) continue;
        entries.push({
          anonymousPlayerId,
          handle: record.handle,
          score: Math.round(1_000_000 / Math.max(1, timeSeconds)),
          timeSeconds,
          completedAtMs: record.bestRaceCompletedAtMs[raceId] ?? 0,
        });
      } else {
        const score = record.areaScores[areaKey] ?? 0;
        if (score <= 0) continue;
        entries.push({
          anonymousPlayerId,
          handle: record.handle,
          score,
          timeSeconds: null,
          completedAtMs: record.areaCompletedAtMs[areaKey] ?? 0,
        });
      }
    }
    entries.sort((left, right) =>
      raceId
        ? (left.timeSeconds ?? Infinity) - (right.timeSeconds ?? Infinity)
        : right.score - left.score,
    );
    return { areaKey, raceId, entries: entries.slice(0, 10) };
  }

  async close(): Promise<void> {
    await this.ensureLoaded();
    await this.writeQueue;
  }

  private async withPlayerLock<T>(anonymousPlayerId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.playerQueues.get(anonymousPlayerId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    this.playerQueues.set(anonymousPlayerId, current);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.playerQueues.get(anonymousPlayerId) === current) {
        this.playerQueues.delete(anonymousPlayerId);
      }
    }
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
      throw new Error('Player data is not valid JSON; refusing to overwrite it.');
    }
    if (!isRecord(parsed) || parsed.version !== STORE_VERSION || !isRecord(parsed.players)) {
      throw new Error('Player data has an unsupported format; refusing to overwrite it.');
    }
    for (const [id, value] of Object.entries(parsed.players)) {
      const record = parseStoredPlayer(id, value);
      if (record) this.players.set(id, record);
    }
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify({
      version: STORE_VERSION,
      players: Object.fromEntries(this.players),
    });
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

function createPlayer(anonymousPlayerId: string, handle: string): StoredPlayer {
  return {
    profile: {
      anonymousPlayerId,
      balanceCents: 0,
      ownedVehicleIds: [STARTING_VEHICLE_ID],
      selectedVehicleId: STARTING_VEHICLE_ID,
      damage: 0,
      totalMissions: 0,
      activeMission: null,
      wantedLevel: 0,
      wantedHeat: 0,
    },
    handle,
    areaScores: {},
    areaCompletedAtMs: {},
    bestRaceTimes: {},
    bestRaceCompletedAtMs: {},
    completedMissionIds: [],
  };
}

function cloneProfile(profile: PlayerProfile): PlayerProfile {
  return {
    ...profile,
    ownedVehicleIds: [...profile.ownedVehicleIds],
    activeMission: cloneMission(profile.activeMission),
  };
}

function cloneMission(mission: ActiveMission | null): ActiveMission | null {
  if (!mission) return null;
  return {
    ...mission,
    offer: {
      ...mission.offer,
      pickup: { ...mission.offer.pickup, location: { ...mission.offer.pickup.location } },
      destination: {
        ...mission.offer.destination,
        location: { ...mission.offer.destination.location },
      },
      route: mission.offer.route.map((point) => ({ ...point })),
      checkpoints: mission.offer.checkpoints.map((point) => ({ ...point })),
    },
  };
}

function sanitizeProfile(profile: PlayerProfile, anonymousPlayerId: string): PlayerProfile {
  const ownedVehicleIds = [...new Set(profile.ownedVehicleIds.filter(isSafeVehicleId))];
  if (!ownedVehicleIds.includes(STARTING_VEHICLE_ID)) ownedVehicleIds.unshift(STARTING_VEHICLE_ID);
  const selectedVehicleId = ownedVehicleIds.includes(profile.selectedVehicleId)
    ? profile.selectedVehicleId
    : STARTING_VEHICLE_ID;
  return {
    anonymousPlayerId,
    balanceCents: clampInteger(profile.balanceCents, 0, 2_000_000_000),
    ownedVehicleIds,
    selectedVehicleId,
    damage: clampInteger(profile.damage, 0, 100),
    totalMissions: clampInteger(profile.totalMissions, 0, 1_000_000_000),
    activeMission: profile.activeMission ? cloneMission(profile.activeMission) : null,
    wantedLevel: clampInteger(profile.wantedLevel, 0, WANTED_MAX_LEVEL),
    wantedHeat: clampNumber(profile.wantedHeat, 0, 1),
  };
}

function parseStoredPlayer(id: string, value: unknown): StoredPlayer | null {
  if (!/^[0-9a-f-]{36}$/iu.test(id) || !isRecord(value) || !isRecord(value.profile)) return null;
  const source = value.profile;
  if (
    typeof source.balanceCents !== 'number' ||
    !Array.isArray(source.ownedVehicleIds) ||
    typeof source.selectedVehicleId !== 'string' ||
    typeof source.damage !== 'number' ||
    typeof source.totalMissions !== 'number'
  ) {
    return null;
  }
  const profile = sanitizeProfile(
    {
      anonymousPlayerId: id,
      balanceCents: source.balanceCents,
      ownedVehicleIds: source.ownedVehicleIds.filter(
        (vehicleId): vehicleId is string => typeof vehicleId === 'string',
      ),
      selectedVehicleId: source.selectedVehicleId,
      damage: source.damage,
      totalMissions: source.totalMissions,
      activeMission: parseActiveMission(source.activeMission),
      wantedLevel: typeof source.wantedLevel === 'number' ? source.wantedLevel : 0,
      wantedHeat: typeof source.wantedHeat === 'number' ? source.wantedHeat : 0,
    },
    id,
  );
  return {
    profile,
    handle: typeof value.handle === 'string' ? value.handle.slice(0, 20) : 'Driver',
    areaScores: safeNumberMap(value.areaScores),
    areaCompletedAtMs: safeNumberMap(value.areaCompletedAtMs),
    bestRaceTimes: safeNumberMap(value.bestRaceTimes),
    bestRaceCompletedAtMs: safeNumberMap(value.bestRaceCompletedAtMs),
    completedMissionIds: Array.isArray(value.completedMissionIds)
      ? value.completedMissionIds.filter(isSafeMissionId).slice(-MAX_COMPLETED_MISSION_IDS)
      : [],
  };
}

function parseActiveMission(value: unknown): ActiveMission | null {
  if (!isRecord(value) || !isRecord(value.offer)) return null;
  const offer = value.offer;
  if (
    typeof offer.id !== 'string' ||
    !isSafeMissionId(offer.id) ||
    typeof offer.kind !== 'string' ||
    !['delivery', 'taxi', 'time-trial', 'checkpoint-race'].includes(offer.kind) ||
    typeof offer.title !== 'string' ||
    typeof offer.areaKey !== 'string' ||
    !isMissionPlace(offer.pickup) ||
    !isMissionPlace(offer.destination) ||
    !Array.isArray(offer.route) ||
    !offer.route.every(isLonLat) ||
    !Array.isArray(offer.checkpoints) ||
    !offer.checkpoints.every(isLonLat) ||
    typeof offer.distanceMeters !== 'number' ||
    typeof offer.rewardCents !== 'number' ||
    typeof offer.minimumTimeSeconds !== 'number' ||
    typeof offer.timeLimitSeconds !== 'number' ||
    typeof value.acceptedAtMs !== 'number' ||
    !(value.startedAtMs === null || typeof value.startedAtMs === 'number') ||
    typeof value.nextCheckpointIndex !== 'number'
  ) {
    return null;
  }
  return value as unknown as ActiveMission;
}

function isMissionPlace(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length <= 96 &&
    typeof value.name === 'string' &&
    value.name.length <= 120 &&
    typeof value.category === 'string' &&
    isLonLat(value.location)
  );
}

function isLonLat(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.longitude === 'number' &&
    Number.isFinite(value.longitude) &&
    value.longitude >= -180 &&
    value.longitude <= 180 &&
    typeof value.latitude === 'number' &&
    Number.isFinite(value.latitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90
  );
}

function safeNumberMap(value: unknown): Readonly<Record<string, number>> {
  if (!isRecord(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, number] of Object.entries(value)) {
    if (Number.isFinite(number) && typeof number === 'number' && number >= 0) result[key] = number;
  }
  return result;
}

function isRace(kind: MissionOffer['kind']): boolean {
  return kind === 'time-trial' || kind === 'checkpoint-race';
}

function isSafeMissionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9:-]{1,96}$/iu.test(value);
}

function isSafeVehicleId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9-]{1,32}$/u.test(value);
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.trunc(Math.max(minimum, Math.min(maximum, value))) : minimum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : minimum;
}
