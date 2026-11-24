import { registerVehicleMod, type VehicleModManifest } from '@openstreet-racer/vehicle/catalog';

const MOD_INDEX_URL = '/mods/index.json';

export async function loadVehicleMods(): Promise<readonly VehicleModManifest[]> {
  const indexResponse = await fetch(MOD_INDEX_URL, { cache: 'no-store' });
  if (!indexResponse.ok) return [];
  const index: unknown = await indexResponse.json();
  if (!isRecord(index) || !Array.isArray(index.mods) || index.mods.length > 32) return [];
  const loaded: VehicleModManifest[] = [];
  for (const path of index.mods) {
    if (typeof path !== 'string' || !/^[a-z0-9-]{1,32}\/manifest\.json$/u.test(path)) continue;
    try {
      const response = await fetch(`/mods/${path}`, { cache: 'no-store' });
      if (!response.ok) continue;
      const value: unknown = await response.json();
      const expectedId = path.slice(0, path.indexOf('/'));
      if (!isRecord(value) || value.id !== expectedId) continue;
      loaded.push(registerVehicleMod(value));
    } catch (error) {
      console.warn(`Skipping invalid vehicle mod '${path}'.`, error);
    }
  }
  return loaded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
