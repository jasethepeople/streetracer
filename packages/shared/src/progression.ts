import type { LonLat } from './index';

export type MissionKind =
  'delivery' | 'taxi' | 'time-trial' | 'checkpoint-race' | 'getaway' | 'hot-delivery' | 'lay-low';

export const WANTED_MAX_LEVEL = 5 as const;

export interface MissionPlace {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly location: Readonly<LonLat>;
}

export interface MissionOffer {
  readonly id: string;
  readonly source?: 'community' | 'mod';
  readonly creatorHandle?: string;
  readonly kind: MissionKind;
  readonly title: string;
  readonly areaKey: string;
  readonly pickup: MissionPlace;
  readonly destination: MissionPlace;
  readonly route: readonly Readonly<LonLat>[];
  readonly checkpoints: readonly Readonly<LonLat>[];
  readonly distanceMeters: number;
  readonly minimumTimeSeconds: number;
  readonly timeLimitSeconds: number;
  readonly rewardCents: number;
}

export interface ActiveMission {
  readonly offer: MissionOffer;
  readonly acceptedAtMs: number;
  readonly startedAtMs: number | null;
  readonly nextCheckpointIndex: number;
  /** Wanted level the mission itself set when it started (getaway / hot-delivery). */
  readonly missionLevel?: number;
}

export interface PlayerProfile {
  readonly anonymousPlayerId: string;
  readonly balanceCents: number;
  readonly ownedVehicleIds: readonly string[];
  readonly selectedVehicleId: string;
  readonly damage: number;
  readonly totalMissions: number;
  readonly activeMission: ActiveMission | null;
  /** Whole wanted stars, 0..WANTED_MAX_LEVEL. */
  readonly wantedLevel: number;
  /** Fractional heat toward the next star, 0..<1. */
  readonly wantedHeat: number;
}

export interface LeaderboardEntry {
  readonly anonymousPlayerId: string;
  readonly handle: string;
  readonly score: number;
  readonly timeSeconds: number | null;
  readonly completedAtMs: number;
}

export interface LeaderboardSnapshot {
  readonly areaKey: string;
  readonly raceId: string | null;
  readonly entries: readonly LeaderboardEntry[];
}
