import { describe, expect, it } from 'vitest';
import type { PlayerProfile } from '@openstreet-racer/shared';
import { ProgressStore } from './progress-store';

const profile: PlayerProfile = {
  anonymousPlayerId: '1ca26dae-3d6f-4c69-9c27-9a26c4563412',
  balanceCents: 2500,
  ownedVehicleIds: ['sedan', 'sports-car'],
  selectedVehicleId: 'sports-car',
  damage: 10,
  totalMissions: 2,
  activeMission: null,
};

describe('local progress store', () => {
  it('keeps settings and a profile in its fallback store when IndexedDB is unavailable', async () => {
    const store = new ProgressStore(undefined, 'openstreet-racer-test');
    await store.saveSettings({
      graphicsQuality: 'high',
      controlMode: 'touch',
      audioVolume: 0.65,
      audioMuted: true,
      language: 'es',
    });
    await store.saveProfile(profile);
    expect(await store.loadSettings()).toEqual({
      graphicsQuality: 'high',
      controlMode: 'touch',
      audioVolume: 0.65,
      audioMuted: true,
      language: 'es',
    });
    expect(await store.loadProfile()).toEqual(profile);
  });

  it('bounds invalid settings and falls back to safe defaults', async () => {
    const store = new ProgressStore(undefined, 'openstreet-racer-invalid-settings-test');
    const settings = await store.saveSettings({
      graphicsQuality: 'ultra' as never,
      controlMode: 'mouse' as never,
      audioVolume: 9,
      audioMuted: false,
      language: 'fr' as never,
    });
    expect(settings).toMatchObject({
      graphicsQuality: 'medium',
      controlMode: 'both',
      audioVolume: 1,
      language: 'en',
    });
  });
});
