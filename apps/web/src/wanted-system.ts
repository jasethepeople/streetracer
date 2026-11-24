/**
 * Client-side mirror of the server's wanted system.
 *
 * The server is the authority: it decides wanted levels, spawns pursuit units,
 * and sends `pursuit` / `busted` / `wrecked` messages. This module only
 * estimates heat between server updates so the HUD feels responsive. Its heat
 * estimate is reported to the server (rate-limited in main.ts) and the server
 * clamps whatever it receives.
 */

export const WANTED_LEVELS = 5;
export const MAX_HEAT = 1;

const HEAT_DECAY_PER_SECOND = 0.006;
const SPEED_ESCAPE_THRESHOLD = 11.1; // ~40 km/h
const SPEED_ESCAPE_BONUS = 0.004;
const COLLISION_HEAT_MIN = 0.02;
const COLLISION_HEAT_MAX = 0.16;
const COLLISION_SPEED_MAX = 14;

export interface WantedTick {
  readonly heat: number;
  readonly wantedLevel: number;
  readonly decaying: boolean;
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

  applyServerPursuit(level: number): void {
    this.serverLevel = Math.max(0, Math.min(WANTED_LEVELS, Math.floor(level)));
  }

  tick(
    speedMetersPerSecond: number,
    damage: number,
    pursuitActive: boolean,
    deltaSeconds: number,
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
    return { heat: this.heatValue, wantedLevel, decaying };
  }

  private get wantedLevel(): number {
    const scaled =
      this.heatValue > 0
        ? Math.min(WANTED_LEVELS, Math.floor(this.heatValue * WANTED_LEVELS) + 1)
        : 0;
    return Math.max(this.serverLevel, scaled);
  }
}
