/**
 * Client-side mirror of the server's wanted system.
 *
 * The server is the authority: it decides wanted levels, spawns pursuit units,
 * and sends `pursuit` / `busted` / `wrecked` messages. This module only
 * estimates heat between server updates so the HUD feels responsive. Its heat
 * estimate is reported to the server (rate-limited in main.ts) and the server
 * clamps whatever it receives.
 */

import type { LonLat } from '@openstreet-racer/shared';
import { lonLatToLocalMeters } from '@openstreet-racer/world';

export const WANTED_LEVELS = 5;
export const MAX_HEAT = 1;

const HEAT_DECAY_PER_SECOND = 0.006;
const SPEED_ESCAPE_THRESHOLD = 11.1; // ~40 km/h
const SPEED_ESCAPE_BONUS = 0.004;
const COLLISION_HEAT_MIN = 0.02;
const COLLISION_HEAT_MAX = 0.16;
const COLLISION_SPEED_MAX = 14;

export const NEAR_MISS_MIN_CLOSING_SPEED_MPS = 6;
export const NEAR_MISS_MAX_CLOSING_SPEED_MPS = 30;
// Detection gates (see detectNearMisses): the radius stays below typical
// opposing-lane separation (~3.5 m) so ordinary oncoming traffic is not
// flagged, and the player must be fast enough for the pass to be reckless.
export const NEAR_MISS_RADIUS_METERS = 3;
export const NEAR_MISS_MIN_PLAYER_SPEED_MPS = 8;
// Server near-miss heat is 0.08–0.3 of one wanted level; the client heat bar
// spans all WANTED_LEVELS levels, so the same event is scaled down here.
const NEAR_MISS_HEAT_MIN = 0.08 / WANTED_LEVELS;
const NEAR_MISS_HEAT_MAX = 0.3 / WANTED_LEVELS;

export type ClientChaseState = 'clear' | 'chase' | 'evading';

export interface PursuitEngagement {
  /** True when a police unit currently has line of sight to the player. */
  readonly visible: boolean;
  /** True when a police unit is close enough for its siren to be heard. */
  readonly sirenAudible: boolean;
}

export interface WantedTick {
  readonly heat: number;
  readonly wantedLevel: number;
  readonly decaying: boolean;
  readonly chaseState: ClientChaseState;
  readonly siren: boolean;
}

export class WantedSystem {
  private heatValue = 0;
  private serverLevel = 0;

  get heat(): number {
    return this.heatValue;
  }

  reset(): void {
    this.heatValue = 0;
    this.serverLevel = 0;
  }

  registerCollision(impactMetersPerSecond: number): void {
    if (impactMetersPerSecond < 2) return;
    const strength = Math.min(impactMetersPerSecond / COLLISION_SPEED_MAX, 1);
    this.heatValue = Math.min(
      MAX_HEAT,
      this.heatValue + COLLISION_HEAT_MIN + (COLLISION_HEAT_MAX - COLLISION_HEAT_MIN) * strength,
    );
  }

  /**
   * Reckless near-miss: brushing past another vehicle at 6–30 m/s closing
   * speed adds heat scaled between NEAR_MISS_HEAT_MIN and NEAR_MISS_HEAT_MAX.
   * Slow brushes below 6 m/s are ignored.
   */
  registerNearMiss(closingSpeedMetersPerSecond: number): void {
    if (
      !Number.isFinite(closingSpeedMetersPerSecond) ||
      closingSpeedMetersPerSecond < NEAR_MISS_MIN_CLOSING_SPEED_MPS
    ) {
      return;
    }
    const span = NEAR_MISS_MAX_CLOSING_SPEED_MPS - NEAR_MISS_MIN_CLOSING_SPEED_MPS;
    const scaled = Math.min(
      1,
      (closingSpeedMetersPerSecond - NEAR_MISS_MIN_CLOSING_SPEED_MPS) / span,
    );
    this.heatValue = Math.min(
      MAX_HEAT,
      this.heatValue + NEAR_MISS_HEAT_MIN + (NEAR_MISS_HEAT_MAX - NEAR_MISS_HEAT_MIN) * scaled,
    );
  }

  applyServerPursuit(level: number): void {
    this.serverLevel = Math.max(0, Math.min(WANTED_LEVELS, Math.floor(level)));
  }

  tick(
    speedMetersPerSecond: number,
    damage: number,
    pursuitActive: boolean,
    deltaSeconds: number,
    engagement?: PursuitEngagement,
  ): WantedTick {
    const previousLevel = this.wantedLevel;
    const decaying = !pursuitActive;
    if (decaying) {
      this.heatValue = Math.max(0, this.heatValue - HEAT_DECAY_PER_SECOND * deltaSeconds);
      if (speedMetersPerSecond >= SPEED_ESCAPE_THRESHOLD) {
        this.heatValue = Math.max(0, this.heatValue - SPEED_ESCAPE_BONUS * deltaSeconds);
      }
    } else {
      this.heatValue = Math.min(
        MAX_HEAT,
        this.heatValue + (0.045 + Math.min(damage, 1) * 0.02) * deltaSeconds,
      );
    }
    const wantedLevel = this.wantedLevel;
    if (wantedLevel > previousLevel && wantedLevel >= 1) {
      // Escalation moment: nudge heat upward so the next star is sticky.
      this.heatValue = Math.min(MAX_HEAT, this.heatValue + 0.02);
    }
    const visible = engagement?.visible ?? pursuitActive;
    const chaseState: ClientChaseState = wantedLevel <= 0 ? 'clear' : visible ? 'chase' : 'evading';
    const siren = wantedLevel > 0 && pursuitActive && (engagement?.sirenAudible ?? true);
    return { heat: this.heatValue, wantedLevel, decaying, chaseState, siren };
  }

  private get wantedLevel(): number {
    const scaled =
      this.heatValue > 0
        ? Math.min(WANTED_LEVELS, Math.floor(this.heatValue * WANTED_LEVELS) + 1)
        : 0;
    return Math.max(this.serverLevel, scaled);
  }
}

export interface NearMissVehicle {
  readonly id: string;
  readonly position: Readonly<LonLat>;
  readonly headingRadians: number;
  readonly speedMetersPerSecond: number;
}

export interface NearMissEvent {
  readonly actorId: string;
  readonly closingSpeedMetersPerSecond: number;
}

/**
 * Pure near-miss detection against the sampled ambient traffic. A near miss
 * is another vehicle passing within NEAR_MISS_RADIUS_METERS while the
 * player-relative closing speed along the line between the vehicles is at
 * least NEAR_MISS_MIN_CLOSING_SPEED_MPS and the player is driving at least
 * NEAR_MISS_MIN_PLAYER_SPEED_MPS — ordinary opposing-lane passes and slow
 * crawling through tight gaps do not count. Callers rate-limit per actor id.
 */
export function detectNearMisses(
  player: {
    readonly position: Readonly<LonLat>;
    readonly headingRadians: number;
    readonly speedMetersPerSecond: number;
  },
  vehicles: readonly NearMissVehicle[],
): NearMissEvent[] {
  const events: NearMissEvent[] = [];
  if (player.speedMetersPerSecond < NEAR_MISS_MIN_PLAYER_SPEED_MPS) return events;
  const playerEast = Math.sin(player.headingRadians) * player.speedMetersPerSecond;
  const playerNorth = Math.cos(player.headingRadians) * player.speedMetersPerSecond;
  for (const vehicle of vehicles) {
    const offset = lonLatToLocalMeters(vehicle.position, player.position);
    const distance = Math.hypot(offset.x, offset.y);
    if (distance < 0.5 || distance > NEAR_MISS_RADIUS_METERS) continue;
    const relativeEast =
      playerEast - Math.sin(vehicle.headingRadians) * vehicle.speedMetersPerSecond;
    const relativeNorth =
      playerNorth - Math.cos(vehicle.headingRadians) * vehicle.speedMetersPerSecond;
    const closing = (relativeEast * offset.x + relativeNorth * offset.y) / distance;
    if (closing < NEAR_MISS_MIN_CLOSING_SPEED_MPS) continue;
    events.push({ actorId: vehicle.id, closingSpeedMetersPerSecond: closing });
  }
  return events;
}
