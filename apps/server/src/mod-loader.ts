import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Dirent } from 'node:fs';
import { compileModScript, type ModScript } from '@openstreet-racer/game';
import type { MissionKind } from '@openstreet-racer/shared';
import { registerVehicleMod, type VehicleModManifest } from '@openstreet-racer/vehicle/catalog';

const MAX_MISSIONS_PER_MOD = 8;
const MAX_TITLE_CHARACTERS = 72;
const MIN_REWARD_CENTS = 100;
const MAX_REWARD_CENTS = 10_000;
const MIN_TIME_MULTIPLIER = 0.5;
const MAX_TIME_MULTIPLIER = 3;
const MISSION_KINDS: readonly MissionKind[] = ['delivery', 'taxi', 'time-trial', 'checkpoint-race'];
const PLACE_CATEGORIES: readonly string[] = [
  'shop',
  'park',
  'school',
  'restaurant',
  'attraction',
  'fuel station',
];

export interface MissionModDefinition {
  readonly id: string;
  readonly kind: MissionKind;
  readonly title: string;
  readonly rewardCents: number;
  readonly timeMultiplier: number;
  readonly placeCategories: readonly string[];
  readonly rewardMultiplierScript: ModScript | null;
  readonly timeLimitMultiplierScript: ModScript | null;
}

export interface MissionMod {
  readonly id: string;
  readonly name: string;
  readonly missions: readonly MissionModDefinition[];
}

export async function loadVehicleMods(directory: string): Promise<readonly VehicleModManifest[]> {
  const loaded: VehicleModManifest[] = [];
  for (const { name, manifest } of await readModManifests(directory)) {
    if (!isRecord(manifest) || manifest.id !== name) {
      console.warn(`Skipping vehicle mod folder '${name}': id must match the folder name.`);
      continue;
    }
    try {
      loaded.push(registerVehicleMod(manifest));
    } catch (error) {
      console.warn(`Skipping invalid vehicle mod folder '${name}'.`, error);
    }
  }
  return loaded;
}

export async function loadMissionMods(directory: string): Promise<readonly MissionMod[]> {
  const loaded: MissionMod[] = [];
  for (const { name, manifest } of await readModManifests(directory)) {
    try {
      const mod = parseMissionMod(name, manifest);
      if (mod) loaded.push(mod);
    } catch (error) {
      console.warn(`Skipping invalid mission mod folder '${name}'.`, error);
    }
  }
  return loaded;
}

interface ModManifestEntry {
  readonly name: string;
  readonly manifest: unknown;
}

async function readModManifests(directory: string): Promise<readonly ModManifestEntry[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
  const manifests: ModManifestEntry[] = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    try {
      const path = join(directory, entry.name, 'manifest.json');
      manifests.push({ name: entry.name, manifest: JSON.parse(await readFile(path, 'utf8')) });
    } catch (error) {
      if (!isMissingFile(error)) {
        console.warn(`Skipping mod folder '${entry.name}': unreadable manifest.`, error);
      }
    }
  }
  return manifests;
}

function parseMissionMod(folderName: string, manifest: unknown): MissionMod | null {
  if (!isRecord(manifest) || manifest.id !== folderName) {
    throw new Error('Mod ID must match its folder name.');
  }
  const missions = manifest.missions;
  if (missions === undefined) return null;
  if (!Array.isArray(missions)) throw new Error('Missions must be an array.');
  if (missions.length > MAX_MISSIONS_PER_MOD) {
    throw new Error(`Mods may define at most ${MAX_MISSIONS_PER_MOD} missions.`);
  }
  const parsed: MissionModDefinition[] = [];
  for (const mission of missions) {
    parsed.push(parseMissionDefinition(folderName, mission));
  }
  return {
    id: folderName,
    name:
      typeof manifest.name === 'string' ? manifest.name.slice(0, MAX_TITLE_CHARACTERS) : folderName,
    missions: parsed,
  };
}

function parseMissionDefinition(modId: string, value: unknown): MissionModDefinition {
  if (!isRecord(value)) throw new Error('Each mission must be an object.');
  const entryId = value.id;
  if (typeof entryId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,47}$/u.test(entryId)) {
    throw new Error('Mission IDs must be 1-48 characters of a-z, 0-9, and hyphens.');
  }
  const id = `${modId}-${entryId}`;
  const kind = value.kind;
  if (typeof kind !== 'string' || !MISSION_KINDS.includes(kind as MissionKind)) {
    throw new Error(`Mission kind must be one of: ${MISSION_KINDS.join(', ')}.`);
  }
  const title = value.title;
  if (
    typeof title !== 'string' ||
    title.trim().length === 0 ||
    title.length > MAX_TITLE_CHARACTERS
  ) {
    throw new Error(
      `Mission '${modId}-${id}' needs a title of 1-${MAX_TITLE_CHARACTERS} characters.`,
    );
  }
  const rewardCents = value.rewardCents;
  if (
    typeof rewardCents !== 'number' ||
    !Number.isSafeInteger(rewardCents) ||
    rewardCents < MIN_REWARD_CENTS ||
    rewardCents > MAX_REWARD_CENTS
  ) {
    throw new Error(
      `Mission '${modId}-${id}' rewardCents must be an integer from ${MIN_REWARD_CENTS} to ${MAX_REWARD_CENTS}.`,
    );
  }
  const timeMultiplier = value.timeMultiplier ?? 1;
  if (
    typeof timeMultiplier !== 'number' ||
    !Number.isFinite(timeMultiplier) ||
    timeMultiplier < MIN_TIME_MULTIPLIER ||
    timeMultiplier > MAX_TIME_MULTIPLIER
  ) {
    throw new Error(
      `Mission '${modId}-${id}' timeMultiplier must be between ${MIN_TIME_MULTIPLIER} and ${MAX_TIME_MULTIPLIER}.`,
    );
  }
  const categories = value.placeCategories ?? [];
  if (!Array.isArray(categories) || categories.length > PLACE_CATEGORIES.length) {
    throw new Error(`Mission '${modId}-${id}' placeCategories must be an array.`);
  }
  for (const category of categories) {
    if (!PLACE_CATEGORIES.includes(category)) {
      throw new Error(
        `Mission '${modId}-${id}' placeCategories entries must be among: ${PLACE_CATEGORIES.join(', ')}.`,
      );
    }
  }
  const rules = value.rules ?? {};
  if (!isRecord(rules)) throw new Error(`Mission '${modId}-${id}' rules must be an object.`);
  const fullId = `${modId}-${id}`;
  const rewardMultiplierScript = compileOptionalScript(
    fullId,
    'rewardMultiplier',
    rules.rewardMultiplier,
  );
  const timeLimitMultiplierScript = compileOptionalScript(
    fullId,
    'timeLimitMultiplier',
    rules.timeLimitMultiplier,
  );
  return {
    id,
    kind: kind as MissionKind,
    title: title.trim(),
    rewardCents,
    timeMultiplier,
    placeCategories: [...categories].map(String),
    rewardMultiplierScript,
    timeLimitMultiplierScript,
  };
}

function compileOptionalScript(missionId: string, hook: string, source: unknown): ModScript | null {
  if (source === undefined || source === null) return null;
  if (typeof source !== 'string') {
    throw new Error(`Mission '${missionId}' rule '${hook}' must be a script string.`);
  }
  try {
    return compileModScript(source);
  } catch (error) {
    throw new Error(`Mission '${missionId}' rule '${hook}' is not a valid script.`, {
      cause: error,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
