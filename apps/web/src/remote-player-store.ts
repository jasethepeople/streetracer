import {
  INTERPOLATION_DELAY_MS,
  MAX_EXTRAPOLATION_MS,
  type NetworkCarState,
  type PublicPlayerState,
} from '@openstreet-racer/shared';
import { localMetersToLonLat, lonLatToLocalMeters } from '@openstreet-racer/world';

export interface RemotePlayerRenderState {
  readonly id: string;
  readonly handle: string;
  readonly car: NetworkCarState;
}

interface TimedPlayerState {
  readonly player: PublicPlayerState;
  readonly receivedAt: number;
}

interface PlayerTrack {
  handle: string;
  samples: TimedPlayerState[];
}

const MAX_SAMPLES_PER_PLAYER = 4;

export class RemotePlayerStore {
  private readonly tracks = new Map<string, PlayerTrack>();

  setRoster(players: readonly PublicPlayerState[], receivedAt = performance.now()): void {
    const rosterIds = new Set(players.map((player) => player.id));
    for (const id of this.tracks.keys()) {
      if (!rosterIds.has(id)) this.tracks.delete(id);
    }
    for (const player of players) this.push(player, receivedAt);
  }

  push(player: PublicPlayerState, receivedAt = performance.now()): void {
    let track = this.tracks.get(player.id);
    if (!track) {
      track = { handle: player.handle, samples: [] };
      this.tracks.set(player.id, track);
    }
    track.handle = player.handle;
    const last = track.samples.at(-1);
    if (last && receivedAt < last.receivedAt) return;
    if (last && receivedAt === last.receivedAt) track.samples.pop();
    track.samples.push({ player, receivedAt });
    if (track.samples.length > MAX_SAMPLES_PER_PLAYER) track.samples.shift();
  }

  remove(playerId: string): void {
    this.tracks.delete(playerId);
  }

  clear(): void {
    this.tracks.clear();
  }

  sample(now = performance.now()): RemotePlayerRenderState[] {
    const targetTime = now - INTERPOLATION_DELAY_MS;
    const result: RemotePlayerRenderState[] = [];
    for (const [id, track] of this.tracks) {
      const state = sampleTrack(track.samples, targetTime);
      if (state) result.push({ id, handle: track.handle, car: state });
    }
    return result;
  }

  get size(): number {
    return this.tracks.size;
  }
}

function sampleTrack(
  samples: readonly TimedPlayerState[],
  targetTime: number,
): NetworkCarState | null {
  if (!samples.length) return null;
  const first = samples[0];
  const last = samples.at(-1)!;
  if (targetTime <= first.receivedAt) return first.player.car;
  if (samples.length === 1) {
    return extrapolateCar(
      first.player.car,
      clamp(targetTime - first.receivedAt, 0, MAX_EXTRAPOLATION_MS) / 1_000,
    );
  }

  for (let index = 1; index < samples.length; index += 1) {
    const right = samples[index];
    if (targetTime > right.receivedAt) continue;
    const left = samples[index - 1];
    const span = right.receivedAt - left.receivedAt;
    const amount = span > 0 ? clamp((targetTime - left.receivedAt) / span, 0, 1) : 1;
    return interpolateCar(left.player.car, right.player.car, amount);
  }

  const extraMs = clamp(targetTime - last.receivedAt, 0, MAX_EXTRAPOLATION_MS);
  return extrapolateCar(last.player.car, extraMs / 1_000);
}

function interpolateCar(
  left: NetworkCarState,
  right: NetworkCarState,
  amount: number,
): NetworkCarState {
  const rightLocal = lonLatToLocalMeters(right.position, left.position);
  const leftAltitude = left.altitudeMeters;
  const velocity = interpolateVelocity(left.velocity, right.velocity, amount);
  return {
    position: localMetersToLonLat(
      { x: rightLocal.x * amount, y: rightLocal.y * amount },
      left.position,
    ),
    altitudeMeters: lerp(leftAltitude, right.altitudeMeters, amount),
    velocity,
    headingRadians: interpolateAngle(left.headingRadians, right.headingRadians, amount),
    speedMetersPerSecond: lerp(left.speedMetersPerSecond, right.speedMetersPerSecond, amount),
  };
}

function extrapolateCar(car: NetworkCarState, seconds: number): NetworkCarState {
  const east = car.velocity.eastMetersPerSecond * seconds;
  const north = car.velocity.northMetersPerSecond * seconds;
  return {
    ...car,
    position: localMetersToLonLat({ x: east, y: north }, car.position),
    altitudeMeters: car.altitudeMeters + car.velocity.upMetersPerSecond * seconds,
  };
}

function interpolateVelocity(
  left: NetworkCarState['velocity'],
  right: NetworkCarState['velocity'],
  amount: number,
): NetworkCarState['velocity'] {
  return {
    eastMetersPerSecond: lerp(left.eastMetersPerSecond, right.eastMetersPerSecond, amount),
    northMetersPerSecond: lerp(left.northMetersPerSecond, right.northMetersPerSecond, amount),
    upMetersPerSecond: lerp(left.upMetersPerSecond, right.upMetersPerSecond, amount),
  };
}

function interpolateAngle(start: number, end: number, amount: number): number {
  const fullTurn = Math.PI * 2;
  const difference = ((((end - start + Math.PI) % fullTurn) + fullTurn) % fullTurn) - Math.PI;
  return (((start + difference * amount) % fullTurn) + fullTurn) % fullTurn;
}

function lerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
