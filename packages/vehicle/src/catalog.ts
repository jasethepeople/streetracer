import vehicleData from '../data/vehicles.json';

export type VehicleVisual = 'sedan' | 'truck' | 'sports-car' | 'motorbike';

export interface VehicleDefinition {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly costCents: number;
  readonly visual: VehicleVisual;
  readonly dimensions: Readonly<{
    width: number;
    length: number;
    height: number;
    wheelbase: number;
    track: number;
    wheelRadius: number;
  }>;
  readonly handling: Readonly<{
    massKg: number;
    engineForce: number;
    brakeForce: number;
    maxSpeedMps: number;
    maxReverseMps: number;
    steeringRadians: number;
    grip: number;
    suspensionStiffness: number;
  }>;
}

export interface VehicleModManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly vehicles: readonly VehicleDefinition[];
}

export const STARTING_VEHICLE_ID = 'sedan';
export const VEHICLE_CATALOG: readonly VehicleDefinition[] = validateCatalog(vehicleData);

const communityVehicles = new Map<string, VehicleDefinition>();
const registeredMods = new Map<string, VehicleModManifest>();

export function getVehicleCatalog(): readonly VehicleDefinition[] {
  return [...VEHICLE_CATALOG, ...communityVehicles.values()];
}

export function getVehicleDefinition(id: string | undefined): VehicleDefinition {
  return getVehicleCatalog().find((vehicle) => vehicle.id === id) ?? VEHICLE_CATALOG[0]!;
}

export function isVehicleId(id: string): boolean {
  return getVehicleCatalog().some((vehicle) => vehicle.id === id);
}

export function registerVehicleMod(value: unknown): VehicleModManifest {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Vehicle mod manifest version is unsupported.');
  }
  const id = stringField(value.id);
  const name = stringField(value.name);
  const version = stringField(value.version);
  const description = stringField(value.description);
  if (
    !/^[a-z0-9-]{1,32}$/.test(id) ||
    !name ||
    name.length > 48 ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    description.length > 160
  ) {
    throw new Error('Vehicle mod identity is invalid.');
  }
  const vehicles = parseVehicleDefinitions(value.vehicles);
  if (vehicles.length > 8 || vehicles.some((vehicle) => !vehicle.id.startsWith(`mod-${id}-`))) {
    throw new Error('Vehicle mod IDs must use their mod prefix and stay within the limit.');
  }
  const mod: VehicleModManifest = { schemaVersion: 1, id, name, version, description, vehicles };
  const previousMod = registeredMods.get(id);
  if (previousMod && JSON.stringify(previousMod) !== JSON.stringify(mod)) {
    throw new Error('A different vehicle mod with this ID is already loaded.');
  }
  for (const vehicle of vehicles) {
    if (
      VEHICLE_CATALOG.some((base) => base.id === vehicle.id) ||
      (communityVehicles.has(vehicle.id) &&
        JSON.stringify(communityVehicles.get(vehicle.id)) !== JSON.stringify(vehicle))
    ) {
      throw new Error(`Vehicle ID ${vehicle.id} is already registered.`);
    }
  }
  for (const vehicle of vehicles) communityVehicles.set(vehicle.id, vehicle);
  registeredMods.set(id, mod);
  return mod;
}

export function getRegisteredVehicleMods(): readonly VehicleModManifest[] {
  return [...registeredMods.values()];
}

function validateCatalog(value: unknown): readonly VehicleDefinition[] {
  if (!Array.isArray(value) || value.length < 4) {
    throw new Error('Vehicle catalog needs at least four vehicles.');
  }
  const definitions = parseVehicleDefinitions(value);
  if (!definitions.some(({ id }) => id === STARTING_VEHICLE_ID)) {
    throw new Error('Vehicle catalog must include the starting sedan.');
  }
  return definitions;
}

function parseVehicleDefinitions(value: unknown): readonly VehicleDefinition[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new Error('Vehicle definition list is invalid.');
  }
  const definitions = value.map(parseVehicleDefinition);
  if (new Set(definitions.map(({ id }) => id)).size !== definitions.length) {
    throw new Error('Vehicle catalog IDs must be unique.');
  }
  return definitions;
}

function parseVehicleDefinition(entry: unknown): VehicleDefinition {
  if (!isRecord(entry) || !isRecord(entry.dimensions) || !isRecord(entry.handling)) {
    throw new Error('Vehicle catalog entry is malformed.');
  }
  const visual = entry.visual;
  if (
    visual !== 'sedan' &&
    visual !== 'truck' &&
    visual !== 'sports-car' &&
    visual !== 'motorbike'
  ) {
    throw new Error('Vehicle catalog visual is not supported.');
  }
  const definition: VehicleDefinition = {
    id: stringField(entry.id),
    name: stringField(entry.name),
    category: stringField(entry.category),
    costCents: numberField(entry.costCents, 0, 100_000_000),
    visual,
    dimensions: {
      width: numberField(entry.dimensions.width, 0.5, 5),
      length: numberField(entry.dimensions.length, 1, 12),
      height: numberField(entry.dimensions.height, 0.5, 4),
      wheelbase: numberField(entry.dimensions.wheelbase, 0.5, 8),
      track: numberField(entry.dimensions.track, 0.3, 4),
      wheelRadius: numberField(entry.dimensions.wheelRadius, 0.2, 1),
    },
    handling: {
      massKg: numberField(entry.handling.massKg, 100, 20_000),
      engineForce: numberField(entry.handling.engineForce, 100, 30_000),
      brakeForce: numberField(entry.handling.brakeForce, 100, 20_000),
      maxSpeedMps: numberField(entry.handling.maxSpeedMps, 1, 80),
      maxReverseMps: numberField(entry.handling.maxReverseMps, 1, 20),
      steeringRadians: numberField(entry.handling.steeringRadians, 0.1, 1.2),
      grip: numberField(entry.handling.grip, 1, 12),
      suspensionStiffness: numberField(entry.handling.suspensionStiffness, 5, 150),
    },
  };
  if (
    !/^[a-z0-9-]{1,32}$/.test(definition.id) ||
    !definition.name ||
    definition.name.length > 48 ||
    !definition.category ||
    definition.category.length > 32
  ) {
    throw new Error('Vehicle catalog identity is invalid.');
  }
  return definition;
}

function stringField(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Vehicle catalog text field is invalid.');
  return value;
}

function numberField(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error('Vehicle catalog number is invalid.');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
