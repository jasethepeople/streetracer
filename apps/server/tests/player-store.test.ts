import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MissionOffer } from '@openstreet-racer/shared';
import { PlayerStore } from '../src/player-store';

const playerId = '1ca26dae-3d6f-4c69-9c27-9a26c4563412';
const offer: MissionOffer = {
  id: 'mission-test-1',
  kind: 'time-trial',
  title: 'Time trial · Market → Park',
  areaKey: '14/3413/6218',
  pickup: {
    id: 'node-1',
    name: 'Market',
    category: 'shop',
    location: { longitude: -104.99, latitude: 39.74 },
  },
  destination: {
    id: 'node-2',
    name: 'Park',
    category: 'park',
    location: { longitude: -104.985, latitude: 39.74 },
  },
  route: [
    { longitude: -104.99, latitude: 39.74 },
    { longitude: -104.985, latitude: 39.74 },
  ],
  checkpoints: [],
  distanceMeters: 420,
  minimumTimeSeconds: 10,
  timeLimitSeconds: 120,
  rewardCents: 700,
};
let directory = '';

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

describe('persistent player progression', () => {
  it('saves earnings and race records across server restarts and rejects duplicate rewards', async () => {
    directory = await mkdtemp(join(tmpdir(), 'openstreet-racer-player-'));
    const firstStore = new PlayerStore(directory);
    const initial = await firstStore.getOrCreate(playerId, 'Driver-1234');
    expect(initial.balanceCents).toBe(0);
    expect(initial.ownedVehicleIds).toEqual(['sedan']);

    const activeProfile = await firstStore.updateProfile(playerId, (profile) => ({
      ...profile,
      activeMission: {
        offer,
        acceptedAtMs: 1_000,
        startedAtMs: 2_000,
        nextCheckpointIndex: 0,
      },
    }));
    expect(activeProfile.activeMission?.offer.id).toBe(offer.id);

    const earned = await firstStore.recordMissionCompletion(
      playerId,
      'Driver-1234',
      offer,
      42,
      44_000,
    );
    expect(earned?.balanceCents).toBe(700);
    await expect(
      firstStore.recordMissionCompletion(playerId, 'Driver-1234', offer, 42, 45_000),
    ).resolves.toBeNull();
    await firstStore.close();

    const restartedStore = new PlayerStore(directory);
    const restored = await restartedStore.getOrCreate(playerId, 'Driver-1234');
    expect(restored.balanceCents).toBe(700);
    expect(restored.totalMissions).toBe(1);
    expect(restored.activeMission).toBeNull();
    await expect(restartedStore.getLeaderboard(offer.areaKey, null)).resolves.toMatchObject({
      entries: [{ anonymousPlayerId: playerId, score: 700, completedAtMs: 44_000 }],
    });
    await expect(restartedStore.getLeaderboard(offer.areaKey, offer.id)).resolves.toMatchObject({
      entries: [{ anonymousPlayerId: playerId, timeSeconds: 42, completedAtMs: 44_000 }],
    });
    await restartedStore.close();
  });
});
