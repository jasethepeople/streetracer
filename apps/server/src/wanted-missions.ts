import type { ActiveMission, MissionOffer } from '@openstreet-racer/shared';
import { WANTED_MAX_LEVEL } from '@openstreet-racer/shared';

export const GETAWAY_START_LEVEL = 3;
export const GETAWAY_BASE_REWARD_CENTS = 600;
export const GETAWAY_REWARD_PER_LEVEL_CENTS = 400;
export const GETAWAY_MIN_SECONDS = 45;
export const HOT_DELIVERY_HEAT_LEVEL = 3;
export const HOT_DELIVERY_REWARD_MULTIPLIER = 2;
export const LAY_LOW_BASE_REWARD_CENTS = 400;
export const LAY_LOW_REWARD_PER_LEVEL_CENTS = 100;
export const LAY_LOW_HIDEOUT_RADIUS_METERS = 60;
export const LAY_LOW_ABANDON_RADIUS_METERS = 150;
export const LAY_LOW_DECAY_MULTIPLIER = 4;
export const HOT_DELIVERY_DECAY_MULTIPLIER = 0;
export const HOT_DELIVERY_COMPLETION_HEAT = 0.5;

export function isHeatMission(kind: MissionOffer['kind']): boolean {
  return kind === 'getaway' || kind === 'hot-delivery' || kind === 'lay-low';
}

export function getawayRewardCents(startLevel: number): number {
  const level = Math.max(1, Math.min(WANTED_MAX_LEVEL, Math.round(startLevel)));
  return GETAWAY_BASE_REWARD_CENTS + GETAWAY_REWARD_PER_LEVEL_CENTS * level;
}

export function layLowRewardCents(startLevel: number): number {
  const level = Math.max(0, Math.min(WANTED_MAX_LEVEL, Math.round(startLevel)));
  return LAY_LOW_BASE_REWARD_CENTS + LAY_LOW_REWARD_PER_LEVEL_CENTS * level;
}

export function hotDeliveryRewardCents(baseRewardCents: number): number {
  return Math.max(100, Math.round(baseRewardCents * HOT_DELIVERY_REWARD_MULTIPLIER));
}

export function heatMissionStartLevel(kind: MissionOffer['kind']): number | null {
  if (kind === 'getaway') return GETAWAY_START_LEVEL;
  if (kind === 'hot-delivery') return HOT_DELIVERY_HEAT_LEVEL;
  return null;
}

export function cooldownMultiplierFor(kind: MissionOffer['kind'] | null): number {
  if (kind === 'hot-delivery') return HOT_DELIVERY_DECAY_MULTIPLIER;
  if (kind === 'lay-low') return LAY_LOW_DECAY_MULTIPLIER;
  return 1;
}

export interface HeatMissionState {
  readonly complete: boolean;
  readonly failed: boolean;
  readonly reason: string | null;
}

export function evaluateHeatMission(
  mission: ActiveMission,
  wantedLevel: number,
  distanceFromHideoutMeters: number | null,
): HeatMissionState {
  const kind = mission.offer.kind;
  if (kind === 'getaway') {
    return wantedLevel === 0
      ? { complete: true, failed: false, reason: null }
      : { complete: false, failed: false, reason: null };
  }
  if (kind === 'lay-low') {
    if (wantedLevel === 0) return { complete: true, failed: false, reason: null };
    if (
      distanceFromHideoutMeters !== null &&
      distanceFromHideoutMeters > LAY_LOW_ABANDON_RADIUS_METERS
    ) {
      return { complete: false, failed: true, reason: 'You left the hideout.' };
    }
    return { complete: false, failed: false, reason: null };
  }
  return { complete: false, failed: false, reason: null };
}

export function heatMissionReward(mission: ActiveMission): number | null {
  const kind = mission.offer.kind;
  const startLevel = mission.missionLevel ?? 0;
  if (kind === 'getaway') return getawayRewardCents(startLevel);
  if (kind === 'lay-low') return layLowRewardCents(startLevel);
  if (kind === 'hot-delivery') return hotDeliveryRewardCents(mission.offer.rewardCents);
  return null;
}
