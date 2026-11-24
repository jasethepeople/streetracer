import { describe, expect, it } from 'vitest';
import type { NetworkCarState, PublicPlayerState } from '@openstreet-racer/shared';
import { localMetersToLonLat, lonLatToLocalMeters } from '@openstreet-racer/world';
import { RemotePlayerStore } from './remote-player-store';

const ORIGIN = { longitude: -104.99, latitude: 39.74 };

describe('RemotePlayerStore', () => {
  it('interpolates position and heading across the angle wrap', () => {
    const store = new RemotePlayerStore();
    store.setRoster([player('a', car(0, Math.PI * 2 - 0.1))], 0);
    store.push(player('a', car(20, 0.1)), 200);

    const sampled = store.sample(250)[0].car;
    const position = lonLatToLocalMeters(sampled.position, ORIGIN);

    expect(position.x).toBeCloseTo(15, 1);
    expect(sampled.headingRadians).toBeCloseTo(0.05, 2);
  });

  it('extrapolates a single recent sample only up to the configured horizon', () => {
    const store = new RemotePlayerStore();
    store.setRoster([player('a', car(0, 0, 10))], 100);

    const sample = store.sample(350)[0].car;
    const position = lonLatToLocalMeters(sample.position, ORIGIN);

    expect(position.x).toBeCloseTo(1.5, 1);
  });

  it("removes players that leave the server's current roster", () => {
    const store = new RemotePlayerStore();
    store.setRoster([player('a', car(0, 0)), player('b', car(2, 0))], 0);
    store.setRoster([player('b', car(3, 0))], 100);

    expect(store.size).toBe(1);
    expect(store.sample(200).map((remote) => remote.id)).toEqual(['b']);
  });
});

function player(id: string, state: NetworkCarState): PublicPlayerState {
  return { id, handle: `Driver-${id}`, car: state, serverTimeMs: 0 };
}

function car(
  eastMeters: number,
  headingRadians: number,
  speedMetersPerSecond = 0,
): NetworkCarState {
  return {
    position: localMetersToLonLat({ x: eastMeters, y: 0 }, ORIGIN),
    altitudeMeters: 0.6,
    velocity: {
      eastMetersPerSecond: speedMetersPerSecond,
      northMetersPerSecond: 0,
      upMetersPerSecond: 0,
    },
    headingRadians,
    speedMetersPerSecond,
  };
}
