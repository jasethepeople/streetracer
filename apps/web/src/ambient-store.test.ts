import { describe, expect, it } from 'vitest';
import type { AmbientActorState, WorldSnapshot } from '@openstreet-racer/shared';
import { lonLatToLocalMeters } from '@openstreet-racer/world';
import { AmbientWorldStore } from './ambient-store';

const origin = { longitude: -104.99, latitude: 39.74 };

const actor: AmbientActorState = {
  id: 'traffic-1',
  kind: 'vehicle',
  vehicleClass: 'car',
  position: origin,
  headingRadians: Math.PI / 2,
  speedMetersPerSecond: 20,
};

describe('ambient world interpolation', () => {
  it('smoothly interpolates server traffic snapshots', () => {
    const store = new AmbientWorldStore();
    store.push(snapshot([actor]), 0);
    store.push(
      snapshot([
        { ...actor, position: { longitude: origin.longitude + 0.0001, latitude: origin.latitude } },
      ]),
      500,
    );

    const sampled = store.sample(500).actors[0];
    expect(sampled).toBeDefined();
    expect(lonLatToLocalMeters(sampled!.position, origin).x).toBeCloseTo(4.3, 0);
  });

  it('extrapolates only briefly and caps at the latest server pose', () => {
    const store = new AmbientWorldStore();
    store.push(snapshot([actor]), 0);
    store.push(
      snapshot([
        { ...actor, position: { longitude: origin.longitude + 0.0001, latitude: origin.latitude } },
      ]),
      500,
    );

    const sampled = store.sample(1_000).actors[0];
    expect(sampled).toBeDefined();
    expect(lonLatToLocalMeters(sampled!.position, origin).x).toBeCloseTo(11.3, 0);
  });

  it('removes actors missing from the next region snapshot', () => {
    const store = new AmbientWorldStore();
    store.push(snapshot([actor]), 0);
    store.push(snapshot([]), 500);

    expect(store.sample(500).actors).toEqual([]);
  });

  it('preserves world status and traffic-control phases', () => {
    const store = new AmbientWorldStore();
    store.push(
      {
        ...snapshot([]),
        status: 'ready',
        controls: [
          {
            id: 'signal-1',
            kind: 'traffic-signal',
            state: 'red',
            position: origin,
            changesInMs: 1200,
          },
        ],
      },
      100,
    );

    const sampled = store.sample(400);
    expect(sampled.status).toBe('ready');
    expect(sampled.controls[0]?.state).toBe('red');
  });
});

function snapshot(actors: readonly AmbientActorState[]): WorldSnapshot {
  return { status: 'ready', actors, controls: [], serverTimeMs: 1000 };
}
