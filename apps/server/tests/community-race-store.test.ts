import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localMetersToLonLat } from '@openstreet-racer/world';
import { createCommunityRaceOffer } from '../src/mission-generator';
import { CommunityRaceStore } from '../src/community-race-store';

const origin = { longitude: -104.9903, latitude: 39.7392 };
let directory = '';

const offer = createCommunityRaceOffer(
  'community-race-00000000-0000-4000-8000-000000000002',
  'My Neighborhood',
  'Driver-1234',
  origin,
  localMetersToLonLat({ x: 900, y: 0 }, origin),
  {
    points: [
      origin,
      localMetersToLonLat({ x: 450, y: 0 }, origin),
      localMetersToLonLat({ x: 900, y: 0 }, origin),
    ],
    distanceMeters: 900,
    travelTimeSeconds: 60,
  },
)!;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

describe('community race persistence', () => {
  it('publishes a race for nearby drivers and reloads it after a server restart', async () => {
    directory = await mkdtemp(join(tmpdir(), 'openstreet-racer-races-'));
    const firstStore = new CommunityRaceStore(directory);
    await expect(firstStore.create(offer)).resolves.toMatchObject({
      id: offer.id,
      source: 'community',
      title: 'Community race · My Neighborhood',
    });
    await expect(firstStore.listNearby(origin)).resolves.toHaveLength(1);
    await expect(
      firstStore.listNearby({ longitude: -104.8, latitude: 39.74 }),
    ).resolves.toHaveLength(0);
    await firstStore.close();

    const restartedStore = new CommunityRaceStore(directory);
    await expect(restartedStore.listNearby(origin)).resolves.toEqual([offer]);
    await expect(restartedStore.create(offer)).rejects.toThrow('already exists');
    await restartedStore.close();
  });
});
