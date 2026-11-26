import type { PoliceUnitMode, PoliceUnitState } from '@openstreet-racer/shared';
import { WANTED_MAX_LEVEL } from '@openstreet-racer/shared';
import type { LonLat } from '@openstreet-racer/shared';
import { haversineMeters } from '@openstreet-racer/world';

export const DEFAULT_SPEED_LIMIT_MPS = 13.9;
export const SPEEDING_OVER_FACTOR = 1.35;
export const SPEEDING_OVER_MARGIN_MPS = 6;
export const SPEEDING_HEAT_PER_SECOND = 0.09;
export const SPEEDING_MIN_SPEED_MPS = 12;
export const RED_LIGHT_HEAT = 0.5;
export const RED_LIGHT_RADIUS_METERS = 14;
export const RED_LIGHT_MIN_SPEED_MPS = 2;
export const IMPACT_MIN_HARDNESS = 25;
export const NEAR_MISS_MIN_CLOSING_SPEED_MPS = 6;
export const NEAR_MISS_MAX_CLOSING_SPEED_MPS = 30;
export const NEAR_MISS_MIN_HEAT = 0.08;
export const NEAR_MISS_MAX_HEAT = 0.3;
// Detection gates (evaluateNearMisses in index.ts): an ordinary opposing-lane
// pass sits ~3.5 m off the player's line, so the radius must stay below lane
// separation, and the player must be driving fast enough for the pass to be
// reckless rather than parking-lot shuffle.
export const NEAR_MISS_RADIUS_METERS = 3;
export const NEAR_MISS_MIN_PLAYER_SPEED_MPS = 8;
export const COOLDOWN_DECAY_PER_SECOND = 0.03;
export const BUSTED_CONTACT_SECONDS = 3;
export const BUSTED_CONTACT_SPEED_MPS = 3.5;
export const BUSTED_CONTACT_RADIUS_METERS = 10;
export const POLICE_COUNTS_BY_LEVEL: readonly number[] = [0, 1, 2, 4, 5, 6];
export const POLICE_SPEED_BASE_MPS = 30;
export const POLICE_SPEED_PER_LEVEL = 3.5;
export const POLICE_SPAWN_MIN_METERS = 220;
export const POLICE_SPAWN_MAX_METERS = 420;
export const POLICE_REPLACEMENT_SECONDS = 9;
export const POLICE_DAMAGE_PER_RAM = 26;
export const POLICE_IMPACT_RADIUS_METERS = 25;
export const ROADBLOCK_MIN_LEVEL = 4;
export const ROADBLOCK_AHEAD_METERS = 130;
export const ROADBLOCK_SPACING_METERS = 22;
export const AMBIENT_IMPACT_RADIUS_METERS = 30;
export const WANTED_SIGHT_RADIUS_METERS = 90;
export const WRECK_REPAIR_CENTS_PER_DAMAGE = 25;
export const BUSTED_FINE_MIN_CENTS = 500;
export const BUSTED_FINE_MAX_CENTS = 50_000;

export interface WantedState {
  readonly level: number;
  readonly heat: number;
}

export type ImpactTargetKind = 'vehicle' | 'pedestrian' | 'police' | 'prop';

const IMPACT_HEAT_BY_KIND: Record<ImpactTargetKind, number> = {
  vehicle: 0.5,
  pedestrian: 0.9,
  police: 0.75,
  prop: 0.3,
};

export function createWantedState(level = 0, heat = 0): WantedState {
  return clampWanted({ level, heat });
}

export function clampWanted(state: WantedState): WantedState {
  let level = Math.max(0, Math.min(WANTED_MAX_LEVEL, Math.floor(state.level)));
  let heat = Number.isFinite(state.heat) ? Math.max(0, state.heat) : 0;
  if (level >= WANTED_MAX_LEVEL) {
    level = WANTED_MAX_LEVEL;
    heat = Math.min(heat, 0.99);
  }
  while (heat >= 1 && level < WANTED_MAX_LEVEL) {
    level += 1;
    heat -= 1;
  }
  if (level >= WANTED_MAX_LEVEL) heat = Math.min(heat, 0.99);
  return { level, heat };
}

export function addWantedHeat(state: WantedState, amount: number): WantedState {
  if (!Number.isFinite(amount) || amount <= 0) return state;
  return clampWanted({ level: state.level, heat: state.heat + amount });
}

export function speedingThreshold(limitMetersPerSecond: number): number {
  const limit =
    Number.isFinite(limitMetersPerSecond) && limitMetersPerSecond > 0
      ? limitMetersPerSecond
      : DEFAULT_SPEED_LIMIT_MPS;
  return Math.max(limit * SPEEDING_OVER_FACTOR, limit + SPEEDING_OVER_MARGIN_MPS);
}

export function isSpeeding(speedMetersPerSecond: number, limitMetersPerSecond: number): boolean {
  return (
    speedMetersPerSecond >= SPEEDING_MIN_SPEED_MPS &&
    speedMetersPerSecond > speedingThreshold(limitMetersPerSecond)
  );
}

export function applySpeeding(
  state: WantedState,
  speedMetersPerSecond: number,
  limitMetersPerSecond: number,
  elapsedSeconds: number,
): WantedState {
  if (!isSpeeding(speedMetersPerSecond, limitMetersPerSecond)) return state;
  const dt = Math.max(0, Math.min(5, elapsedSeconds));
  return addWantedHeat(state, SPEEDING_HEAT_PER_SECOND * dt);
}

export function applyImpact(
  state: WantedState,
  targetKind: ImpactTargetKind,
  hardness: number,
): WantedState {
  if (!Number.isFinite(hardness) || hardness < IMPACT_MIN_HARDNESS) return state;
  const scaled = 0.5 + Math.max(0, Math.min(100, hardness)) / 100;
  return addWantedHeat(state, IMPACT_HEAT_BY_KIND[targetKind] * scaled);
}

export function applyRedLight(state: WantedState): WantedState {
  return addWantedHeat(state, RED_LIGHT_HEAT);
}

/**
 * Reckless near-miss: brushing past another vehicle at a high closing speed
 * adds heat scaled from NEAR_MISS_MIN_HEAT (at 6 m/s closing) up to
 * NEAR_MISS_MAX_HEAT (at 30+ m/s closing). Slow brushes below 6 m/s are
 * ignored so normal city driving and parking bumps stay heat-free.
 */
export function applyNearMiss(
  state: WantedState,
  closingSpeedMetersPerSecond: number,
): WantedState {
  if (
    !Number.isFinite(closingSpeedMetersPerSecond) ||
    closingSpeedMetersPerSecond < NEAR_MISS_MIN_CLOSING_SPEED_MPS
  ) {
    return state;
  }
  const span = NEAR_MISS_MAX_CLOSING_SPEED_MPS - NEAR_MISS_MIN_CLOSING_SPEED_MPS;
  const scaled = Math.min(
    1,
    (closingSpeedMetersPerSecond - NEAR_MISS_MIN_CLOSING_SPEED_MPS) / span,
  );
  return addWantedHeat(
    state,
    NEAR_MISS_MIN_HEAT + (NEAR_MISS_MAX_HEAT - NEAR_MISS_MIN_HEAT) * scaled,
  );
}

export function applyCooldown(
  state: WantedState,
  elapsedSeconds: number,
  multiplier = 1,
): WantedState {
  const dt = Math.max(0, Math.min(30, elapsedSeconds));
  if (dt === 0) return state;
  const decay = COOLDOWN_DECAY_PER_SECOND * multiplier * dt;
  let level = state.level;
  let heat = state.heat - decay;
  while (heat < 0 && level > 0) {
    level -= 1;
    heat += 1;
  }
  if (level === 0 && heat < 0) heat = 0;
  return clampWanted({ level, heat });
}

export function policeCountForLevel(level: number): number {
  const index = Math.max(0, Math.min(WANTED_MAX_LEVEL, Math.floor(level)));
  return POLICE_COUNTS_BY_LEVEL[index] ?? 0;
}

export function policeCruiseSpeed(level: number): number {
  const clamped = Math.max(1, Math.min(WANTED_MAX_LEVEL, Math.floor(level)));
  return POLICE_SPEED_BASE_MPS + POLICE_SPEED_PER_LEVEL * (clamped - 1);
}

export interface PursuitPoliceUnit {
  readonly id: string;
  mode: PoliceUnitMode;
  position: LonLat;
  headingRadians: number;
  speedMetersPerSecond: number;
  damage: number;
  route: readonly LonLat[];
  routeIndex: number;
  reRouteAtMs: number;
  respawnAtMs: number;
  disabledAtMs: number;
}

export function createPoliceUnit(
  id: string,
  position: LonLat,
  nowMs: number,
  mode: PoliceUnitMode = 'chase',
): PursuitPoliceUnit {
  return {
    id,
    mode,
    position,
    headingRadians: 0,
    speedMetersPerSecond: 0,
    damage: 0,
    route: [],
    routeIndex: 0,
    reRouteAtMs: 0,
    respawnAtMs: nowMs,
    disabledAtMs: 0,
  };
}

export function damagePoliceUnit(unit: PursuitPoliceUnit, amount: number): void {
  unit.damage = Math.max(0, Math.min(100, unit.damage + Math.max(0, amount)));
  if (unit.damage >= 100) {
    unit.mode = 'disabled';
    unit.speedMetersPerSecond = 0;
    unit.disabledAtMs = Date.now();
  }
}

export function isUnitDisabled(unit: PursuitPoliceUnit): boolean {
  return unit.mode === 'disabled';
}

export function activeUnitCount(units: readonly PursuitPoliceUnit[]): number {
  return units.filter((unit) => unit.mode !== 'disabled').length;
}

export function policeUnitSnapshot(unit: PursuitPoliceUnit): PoliceUnitState {
  return {
    id: unit.id,
    mode: unit.mode,
    position: unit.position,
    headingRadians: unit.headingRadians,
    speedMetersPerSecond: unit.speedMetersPerSecond,
    damage: unit.damage,
  };
}

export interface PoliceAdvanceOptions {
  readonly target: Readonly<LonLat>;
  readonly cruiseSpeedMetersPerSecond: number;
  readonly elapsedSeconds: number;
  readonly nowMs: number;
}

export function advancePoliceUnit(
  unit: PursuitPoliceUnit,
  options: PoliceAdvanceOptions,
): 'moved' | 'needs-route' | 'disabled' {
  if (unit.mode === 'disabled') return 'disabled';
  const dt = Math.max(0, Math.min(5, options.elapsedSeconds));
  if (unit.mode === 'roadblock') {
    unit.speedMetersPerSecond = 0;
    return 'moved';
  }
  const remaining = unit.route.slice(unit.routeIndex);
  if (remaining.length < 2 || options.nowMs >= unit.reRouteAtMs) return 'needs-route';
  const distance = options.cruiseSpeedMetersPerSecond * dt;
  return advanceAlongRoute(unit, remaining, distance, options);
}

function advanceAlongRoute(
  unit: PursuitPoliceUnit,
  remaining: readonly LonLat[],
  distance: number,
  options: PoliceAdvanceOptions,
): 'moved' | 'needs-route' {
  let budget = distance;
  let index = unit.routeIndex;
  let current = unit.position;
  while (budget > 0 && index < unit.route.length - 1) {
    const next = unit.route[index + 1]!;
    const leg = haversineMeters(current, next);
    if (leg <= 0.01) {
      index += 1;
      current = next;
      continue;
    }
    if (leg > budget) {
      const fraction = budget / leg;
      unit.position = interpolate(current, next, fraction);
      unit.headingRadians = headingBetween(current, next);
      unit.routeIndex = index;
      unit.speedMetersPerSecond = options.cruiseSpeedMetersPerSecond;
      return 'moved';
    }
    budget -= leg;
    index += 1;
    current = next;
  }
  unit.routeIndex = Math.max(0, unit.route.length - 2);
  unit.position = unit.route[unit.route.length - 1] ?? unit.position;
  unit.headingRadians = headingBetween(
    unit.route[unit.route.length - 2] ?? unit.position,
    unit.position,
  );
  unit.speedMetersPerSecond = options.cruiseSpeedMetersPerSecond;
  return haversineMeters(unit.position, options.target) < 60 ? 'moved' : 'needs-route';
}

export function headingBetween(from: Readonly<LonLat>, to: Readonly<LonLat>): number {
  const dx =
    (to.longitude - from.longitude) *
    Math.cos(((from.latitude + to.latitude) / 2) * (Math.PI / 180));
  const dy = to.latitude - from.latitude;
  if (dx === 0 && dy === 0) return 0;
  return Math.atan2(dx, dy);
}

export function interpolate(
  from: Readonly<LonLat>,
  to: Readonly<LonLat>,
  fraction: number,
): LonLat {
  return {
    longitude: from.longitude + (to.longitude - from.longitude) * fraction,
    latitude: from.latitude + (to.latitude - from.latitude) * fraction,
  };
}

export function offsetLonLat(
  origin: Readonly<LonLat>,
  headingRadians: number,
  distanceMeters: number,
): LonLat {
  const metersPerDegreeLatitude = 111_320;
  const north = Math.cos(headingRadians) * distanceMeters;
  const east = Math.sin(headingRadians) * distanceMeters;
  return {
    longitude:
      origin.longitude +
      east / (metersPerDegreeLatitude * Math.cos(origin.latitude * (Math.PI / 180))),
    latitude: origin.latitude + north / metersPerDegreeLatitude,
  };
}

export function shouldDeployRoadblock(level: number): boolean {
  return Number.isFinite(level) && Math.floor(level) >= ROADBLOCK_MIN_LEVEL;
}

export function roadblockAnchor(
  routePoints: readonly LonLat[],
  spacingMeters = ROADBLOCK_SPACING_METERS,
): LonLat[] {
  if (routePoints.length < 2) return [];
  const positions: LonLat[] = [];
  let traveled = 0;
  let nextAt = ROADBLOCK_AHEAD_METERS * 0.7;
  for (let index = 1; index < routePoints.length && positions.length < 3; index += 1) {
    const from = routePoints[index - 1]!;
    const to = routePoints[index]!;
    const leg = haversineMeters(from, to);
    while (traveled + leg >= nextAt && positions.length < 3) {
      const fraction = (nextAt - traveled) / leg;
      positions.push(interpolate(from, to, fraction));
      nextAt += spacingMeters;
    }
    traveled += leg;
  }
  return positions;
}

export interface BustedContactResult {
  readonly contactSeconds: number;
  readonly busted: boolean;
}

export function bustedContactUpdate(
  contactSeconds: number,
  inContact: boolean,
  elapsedSeconds: number,
): BustedContactResult {
  const dt = Math.max(0, Math.min(5, elapsedSeconds));
  const updated = inContact ? contactSeconds + dt : 0;
  return { contactSeconds: updated, busted: updated >= BUSTED_CONTACT_SECONDS };
}

export function isActiveHeatMissionKind(kind: string): boolean {
  return kind === 'getaway' || kind === 'hot-delivery' || kind === 'lay-low';
}

export function bustedFineCents(balanceCents: number): number {
  const balance = Math.max(0, Math.floor(balanceCents));
  if (balance === 0) return 0;
  const raw = Math.max(BUSTED_FINE_MIN_CENTS, Math.round(balance * 0.15));
  return Math.min(raw, BUSTED_FINE_MAX_CENTS, balance);
}

export function wreckRepairBillCents(damage: number): number {
  return Math.ceil(Math.max(0, Math.min(100, damage)) * WRECK_REPAIR_CENTS_PER_DAMAGE);
}

export function isVisibleByPolice(
  playerPosition: Readonly<LonLat>,
  units: readonly PursuitPoliceUnit[],
  sightRadiusMeters = 90,
): boolean {
  return units.some(
    (unit) =>
      unit.mode !== 'disabled' &&
      haversineMeters(playerPosition, unit.position) <= sightRadiusMeters,
  );
}

export function nearestUnitDistance(
  playerPosition: Readonly<LonLat>,
  units: readonly PursuitPoliceUnit[],
): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const unit of units) {
    if (unit.mode === 'disabled') continue;
    nearest = Math.min(nearest, haversineMeters(playerPosition, unit.position));
  }
  return nearest;
}

export function policeUnitsNear(
  units: readonly PursuitPoliceUnit[],
  position: Readonly<LonLat>,
  radiusMeters: number,
): readonly PursuitPoliceUnit[] {
  return units.filter(
    (unit) => unit.mode !== 'disabled' && haversineMeters(position, unit.position) <= radiusMeters,
  );
}

export function repairPoliceUnitStatus(
  units: readonly PursuitPoliceUnit[],
  targetCount: number,
  spawnUnit: () => PursuitPoliceUnit,
): readonly PursuitPoliceUnit[] {
  const kept = [...units];
  while (kept.filter((unit) => unit.mode !== 'disabled').length < targetCount) {
    kept.push(spawnUnit());
  }
  let overflow = kept.length - Math.max(targetCount, 0);
  for (let index = kept.length - 1; index >= 0 && overflow > 0; index -= 1) {
    if (kept[index]!.mode === 'disabled') {
      kept.splice(index, 1);
      overflow -= 1;
    }
  }
  return kept;
}

export function roadblockUnitsFromRoute(
  routePoints: readonly Readonly<LonLat>[],
  nowMs: number,
  unitIndex: number,
): readonly PursuitPoliceUnit[] {
  return roadblockAnchor(routePoints).map((position, offset) => {
    const unit = createPoliceUnit(
      `police-roadblock-${unitIndex}-${offset}-${nowMs}`,
      position,
      nowMs,
      'roadblock',
    );
    unit.speedMetersPerSecond = 0;
    return unit;
  });
}

export type PursuitStatus = 'clear' | 'chase' | 'roadblock' | 'evading';

/**
 * Summarises the pursuit for HUD/telemetry:
 * - `clear` when there is no wanted level,
 * - `roadblock` when any deployed unit is manning a roadblock,
 * - `chase` when at least one active unit currently sees the player,
 * - `evading` otherwise (wanted, but line of sight is broken).
 */
export function pursuitStatus(
  level: number,
  units: readonly PursuitPoliceUnit[],
  visible: boolean,
): PursuitStatus {
  if (!Number.isFinite(level) || level <= 0) return 'clear';
  const active = units.filter((unit) => unit.mode !== 'disabled');
  if (active.some((unit) => unit.mode === 'roadblock')) return 'roadblock';
  if (visible && active.length > 0) return 'chase';
  return 'evading';
}

export const POLICE_SIREN_RADIUS_METERS = 250;

/**
 * Whether the player can hear a police siren: any active (non-disabled) unit
 * within the audible radius, which defaults to POLICE_SIREN_RADIUS_METERS.
 */
export function policeSirenAudible(
  playerPosition: Readonly<LonLat>,
  units: readonly PursuitPoliceUnit[],
  radiusMeters = POLICE_SIREN_RADIUS_METERS,
): boolean {
  const radius = Number.isFinite(radiusMeters) && radiusMeters > 0 ? radiusMeters : 0;
  return units.some(
    (unit) => unit.mode !== 'disabled' && haversineMeters(playerPosition, unit.position) <= radius,
  );
}

export const ESCAPE_HIDDEN_SECONDS = 8;
export const ESCAPE_DISTANCE_METERS = 350;
export const ESCAPE_DISTANCE_SECONDS = 3;

export interface EscapeState {
  readonly escaped: boolean;
  readonly hiddenSeconds: number;
  readonly separatedSeconds: number;
}

export interface EscapeUpdate {
  readonly visible: boolean;
  /** Distance to the nearest active unit; pass Infinity/NaN when no units remain. */
  readonly nearestUnitMeters: number;
  readonly elapsedSeconds: number;
}

export function createEscapeState(): EscapeState {
  return { escaped: false, hiddenSeconds: 0, separatedSeconds: 0 };
}

/**
 * Escape rules: the player escapes after staying out of police line of sight
 * for ESCAPE_HIDDEN_SECONDS, or after keeping at least ESCAPE_DISTANCE_METERS
 * of separation for ESCAPE_DISTANCE_SECONDS. With no active units the nearest
 * distance is effectively infinite, so the separation timer runs. Once
 * escaped the state sticks while the player stays hidden, but a unit that
 * regains line of sight re-engages the pursuit and clears the escape.
 */
export function updateEscape(state: EscapeState, update: EscapeUpdate): EscapeState {
  if (state.escaped) {
    if (!update.visible) return state;
    return { escaped: false, hiddenSeconds: 0, separatedSeconds: 0 };
  }
  const dt = Math.max(
    0,
    Math.min(30, Number.isFinite(update.elapsedSeconds) ? update.elapsedSeconds : 0),
  );
  const nearest =
    Number.isFinite(update.nearestUnitMeters) && update.nearestUnitMeters >= 0
      ? update.nearestUnitMeters
      : Number.POSITIVE_INFINITY;
  const hiddenSeconds = update.visible ? 0 : state.hiddenSeconds + dt;
  const separatedSeconds = nearest >= ESCAPE_DISTANCE_METERS ? state.separatedSeconds + dt : 0;
  const escaped =
    hiddenSeconds >= ESCAPE_HIDDEN_SECONDS || separatedSeconds >= ESCAPE_DISTANCE_SECONDS;
  return { escaped, hiddenSeconds, separatedSeconds };
}
