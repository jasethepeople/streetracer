import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getVehicleDefinition } from '@openstreet-racer/vehicle/catalog';
import { loadMissionMods, loadVehicleMods } from '../src/mod-loader';

const validManifest = {
  schemaVersion: 1,
  id: 'test-mod',
  name: 'Test Mod',
  version: '1.0.0',
  description: 'A test vehicle mod.',
  vehicles: [
    {
      id: 'mod-test-mod-cart',
      name: 'Test Cart',
      category: 'Community mod',
      costCents: 100,
      visual: 'sedan',
      dimensions: {
        width: 1.8,
        length: 4,
        height: 1.4,
        wheelbase: 2.6,
        track: 1.6,
        wheelRadius: 0.34,
      },
      handling: {
        massKg: 1200,
        engineForce: 6000,
        brakeForce: 9000,
        maxSpeedMps: 40,
        maxReverseMps: 5,
        steeringRadians: 0.55,
        grip: 6,
        suspensionStiffness: 30,
      },
    },
  ],
};

const mismatchedManifest = {
  ...validManifest,
  id: 'test-mod-2',
  vehicles: [
    {
      ...validManifest.vehicles[0]!,
      id: 'mod-test-mod-2-cart',
      name: 'Other Cart',
    },
  ],
};

let directory = '';

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = '';
});

describe('loadVehicleMods', () => {
  it('loads a valid mod folder and registers its vehicles', async () => {
    directory = await mkdtemp(join(tmpdir(), 'osr-mods-'));
    const modDir = join(directory, 'test-mod');
    await mkdir(modDir);
    await writeFile(join(modDir, 'manifest.json'), JSON.stringify(validManifest));

    const mods = await loadVehicleMods(directory);

    expect(mods).toHaveLength(1);
    expect(mods[0]!.id).toBe('test-mod');
    expect(getVehicleDefinition('mod-test-mod-cart').name).toBe('Test Cart');
  });

  it('skips folders whose manifest ID does not match the folder name', async () => {
    directory = await mkdtemp(join(tmpdir(), 'osr-mods-'));
    const modDir = join(directory, 'wrong-folder');
    await mkdir(modDir);
    await writeFile(join(modDir, 'manifest.json'), JSON.stringify(mismatchedManifest));

    const mods = await loadVehicleMods(directory);

    expect(mods).toHaveLength(0);
    expect(getVehicleDefinition('mod-test-mod-2-cart').name).not.toBe('Other Cart');
  });

  it('skips folders with invalid JSON and treats a missing directory as empty', async () => {
    directory = await mkdtemp(join(tmpdir(), 'osr-mods-'));
    const modDir = join(directory, 'broken');
    await mkdir(modDir);
    await writeFile(join(modDir, 'manifest.json'), '{not json');

    expect(await loadVehicleMods(directory)).toHaveLength(0);
    expect(await loadVehicleMods(join(directory, 'missing'))).toHaveLength(0);
  });
});

const validMissionManifest = {
  schemaVersion: 1,
  id: 'mission-mod',
  name: 'Mission Mod',
  version: '1.0.0',
  description: 'A test mission mod.',
  missions: [
    {
      id: 'market-dash',
      kind: 'delivery',
      title: 'Market dash',
      rewardCents: 800,
      timeMultiplier: 1.2,
      placeCategories: ['shop'],
      rules: { rewardMultiplier: '(if (> distance 2000) 1.5 1)' },
    },
  ],
};

describe('loadMissionMods', () => {
  it('loads and compiles mission mod rules', async () => {
    directory = await mkdtemp(join(tmpdir(), 'osr-missions-'));
    const modDir = join(directory, 'mission-mod');
    await mkdir(modDir);
    await writeFile(join(modDir, 'manifest.json'), JSON.stringify(validMissionManifest));

    const mods = await loadMissionMods(directory);

    expect(mods).toHaveLength(1);
    expect(mods[0]!.id).toBe('mission-mod');
    expect(mods[0]!.missions).toHaveLength(1);
    const mission = mods[0]!.missions[0]!;
    expect(mission.id).toBe('mission-mod-market-dash');
    expect(mission.rewardCents).toBe(800);
    expect(mission.timeMultiplier).toBe(1.2);
    expect(mission.placeCategories).toEqual(['shop']);
    expect(mission.rewardMultiplierScript).not.toBeNull();
    expect(mission.timeLimitMultiplierScript).toBeNull();
  });

  it('skips mods with invalid scripts or out-of-range rewards', async () => {
    directory = await mkdtemp(join(tmpdir(), 'osr-missions-'));
    const broken = join(directory, 'broken-script');
    await mkdir(broken);
    await writeFile(
      join(broken, 'manifest.json'),
      JSON.stringify({
        ...validMissionManifest,
        missions: [
          {
            ...validMissionManifest.missions[0]!,
            rules: { rewardMultiplier: '(fetch "http://x")' },
            id: 'broken-script',
          },
        ],
      }),
    );
    const greedy = join(directory, 'greedy');
    await mkdir(greedy);
    await writeFile(
      join(greedy, 'manifest.json'),
      JSON.stringify({
        ...validMissionManifest,
        missions: [{ ...validMissionManifest.missions[0]!, rewardCents: 99 }],
        id: 'greedy',
      }),
    );

    expect(await loadMissionMods(directory)).toHaveLength(0);
  });

  it('ignores folders without a missions section', async () => {
    directory = await mkdtemp(join(tmpdir(), 'osr-missions-'));
    const modDir = join(directory, 'test-mod');
    await mkdir(modDir);
    await writeFile(join(modDir, 'manifest.json'), JSON.stringify(validManifest));

    expect(await loadMissionMods(directory)).toHaveLength(0);
  });
});
