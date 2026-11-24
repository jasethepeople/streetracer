import {
  MAX_EXTRAPOLATION_MS,
  type AmbientActorState,
  type TrafficControlSnapshot,
  type WorldSnapshot,
} from '@openstreet-racer/shared';
import { localMetersToLonLat, lonLatToLocalMeters } from '@openstreet-racer/world';

const INTERPOLATION_DELAY_MS = 250;
const MAX_ACTOR_SAMPLES = 2;

interface TimedActor {
  readonly at: number;
  readonly actor: AmbientActorState;
}

export class AmbientWorldStore {
  private readonly tracks = new Map<string, TimedActor[]>();
  private status: WorldSnapshot['status'] = 'loading';
  private controls: readonly TrafficControlSnapshot[] = [];
  private serverTimeMs = 0;

  push(snapshot: WorldSnapshot, receivedAt = performance.now()): void {
    this.status = snapshot.status;
    this.controls = snapshot.controls.map((control) => ({
      ...control,
      position: { ...control.position },
    }));
    this.serverTimeMs = snapshot.serverTimeMs;
    const seen = new Set<string>();

    for (const actor of snapshot.actors) {
      seen.add(actor.id);
      const track = this.tracks.get(actor.id) ?? [];
      if (track.at(-1)?.at === receivedAt) track.pop();
      track.push({ at: receivedAt, actor: copyActor(actor) });
      while (track.length > MAX_ACTOR_SAMPLES) track.shift();
      this.tracks.set(actor.id, track);
    }

    for (const id of this.tracks.keys()) {
      if (!seen.has(id)) this.tracks.delete(id);
    }
  }

  sample(now = performance.now()): WorldSnapshot {
    const target = now - INTERPOLATION_DELAY_MS;
    return {
      status: this.status,
      actors: [...this.tracks.values()].flatMap((track) => sampleTrack(track, target)),
      controls: this.controls,
      serverTimeMs: this.serverTimeMs,
    };
  }

  clear(): void {
    this.tracks.clear();
    this.controls = [];
    this.status = 'loading';
    this.serverTimeMs = 0;
  }
}

function sampleTrack(track: readonly TimedActor[], target: number): AmbientActorState[] {
  const first = track[0];
  const second = track[1];
  if (!first) return [];
  if (!second || target <= first.at) return [copyActor(first.actor)];

  const span = second.at - first.at;
  if (span <= 0 || target <= second.at) {
    const amount = span <= 0 ? 1 : clamp((target - first.at) / span, 0, 1);
    return [interpolateActor(first.actor, second.actor, amount)];
  }

  const extrapolationMs = clamp(target - second.at, 0, MAX_EXTRAPOLATION_MS);
  const distance = (second.actor.speedMetersPerSecond * extrapolationMs) / 1_000;
  if (distance <= 0) return [copyActor(second.actor)];
  const radians = second.actor.headingRadians;
  const position = localMetersToLonLat(
    { x: Math.sin(radians) * distance, y: Math.cos(radians) * distance },
    second.actor.position,
  );
  return [{ ...copyActor(second.actor), position }];
}

function interpolateActor(
  first: AmbientActorState,
  second: AmbientActorState,
  amount: number,
): AmbientActorState {
  const displacement = lonLatToLocalMeters(second.position, first.position);
  const heading = interpolateAngle(first.headingRadians, second.headingRadians, amount);
  return {
    ...copyActor(second),
    position: localMetersToLonLat(
      { x: displacement.x * amount, y: displacement.y * amount },
      first.position,
    ),
    headingRadians: heading,
    speedMetersPerSecond:
      first.speedMetersPerSecond +
      (second.speedMetersPerSecond - first.speedMetersPerSecond) * amount,
  };
}

function copyActor(actor: AmbientActorState): AmbientActorState {
  return { ...actor, position: { ...actor.position } };
}

function interpolateAngle(first: number, second: number, amount: number): number {
  const fullTurn = Math.PI * 2;
  const difference = ((((second - first + Math.PI) % fullTurn) + fullTurn) % fullTurn) - Math.PI;
  return (first + difference * amount + fullTurn) % fullTurn;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
