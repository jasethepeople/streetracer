import type { PlayerProfile } from '@openstreet-racer/shared';

export type GameLanguage = 'en' | 'es';
export type GraphicsQuality = 'low' | 'medium' | 'high';
export type ControlMode = 'keyboard' | 'touch' | 'both';

export interface GameSettings {
  readonly graphicsQuality: GraphicsQuality;
  readonly controlMode: ControlMode;
  readonly audioVolume: number;
  readonly audioMuted: boolean;
  readonly language: GameLanguage;
}

export const DEFAULT_GAME_SETTINGS: GameSettings = {
  graphicsQuality: 'medium',
  controlMode: 'both',
  audioVolume: 0.3,
  audioMuted: false,
  language: 'en',
};

const DATABASE_NAME = 'openstreet-racer';
const DATABASE_VERSION = 1;
const STORE_NAME = 'save';
const SETTINGS_KEY = 'settings';
const PROFILE_KEY = 'profile';

export class ProgressStore {
  private readonly memory = new Map<string, unknown>();
  private databasePromise: Promise<IDBDatabase | null> | null = null;

  constructor(
    private readonly factory: IDBFactory | undefined = globalThis.indexedDB,
    private readonly databaseName = DATABASE_NAME,
  ) {}

  async loadSettings(): Promise<GameSettings> {
    return parseSettings(await this.get(SETTINGS_KEY));
  }

  async saveSettings(settings: GameSettings): Promise<GameSettings> {
    const clean = parseSettings(settings);
    await this.put(SETTINGS_KEY, clean);
    return clean;
  }

  async saveProfile(profile: PlayerProfile): Promise<void> {
    await this.put(PROFILE_KEY, profile);
  }

  async loadProfile(): Promise<PlayerProfile | null> {
    const value = await this.get(PROFILE_KEY);
    if (!isRecord(value)) return null;
    if (
      typeof value.anonymousPlayerId !== 'string' ||
      typeof value.balanceCents !== 'number' ||
      !Array.isArray(value.ownedVehicleIds) ||
      typeof value.selectedVehicleId !== 'string' ||
      typeof value.damage !== 'number' ||
      typeof value.totalMissions !== 'number'
    ) {
      return null;
    }
    return value as unknown as PlayerProfile;
  }

  close(): void {
    void this.databasePromise?.then((database) => database?.close());
    this.databasePromise = null;
  }

  private async get(key: string): Promise<unknown> {
    const database = await this.openDatabase();
    if (!database) return this.memory.get(key);
    return new Promise((resolve) => {
      try {
        const request = database
          .transaction(STORE_NAME, 'readonly')
          .objectStore(STORE_NAME)
          .get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(this.memory.get(key));
      } catch {
        resolve(this.memory.get(key));
      }
    });
  }

  private async put(key: string, value: unknown): Promise<void> {
    this.memory.set(key, value);
    const database = await this.openDatabase();
    if (!database) return;
    await new Promise<void>((resolve) => {
      try {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).put(value, key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
        transaction.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  private openDatabase(): Promise<IDBDatabase | null> {
    if (!this.factory) return Promise.resolve(null);
    if (!this.databasePromise) {
      this.databasePromise = new Promise((resolve) => {
        try {
          const request = this.factory!.open(this.databaseName, DATABASE_VERSION);
          request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE_NAME)) {
              request.result.createObjectStore(STORE_NAME);
            }
          };
          request.onsuccess = () => {
            const database = request.result;
            database.onversionchange = () => database.close();
            resolve(database);
          };
          request.onerror = () => resolve(null);
          request.onblocked = () => resolve(null);
        } catch {
          resolve(null);
        }
      });
    }
    return this.databasePromise;
  }
}

function parseSettings(value: unknown): GameSettings {
  if (!isRecord(value)) return DEFAULT_GAME_SETTINGS;
  return {
    graphicsQuality:
      value.graphicsQuality === 'low' || value.graphicsQuality === 'high'
        ? value.graphicsQuality
        : 'medium',
    controlMode:
      value.controlMode === 'keyboard' || value.controlMode === 'touch'
        ? value.controlMode
        : 'both',
    audioVolume:
      typeof value.audioVolume === 'number' && Number.isFinite(value.audioVolume)
        ? Math.max(0, Math.min(1, value.audioVolume))
        : DEFAULT_GAME_SETTINGS.audioVolume,
    audioMuted: value.audioMuted === true,
    language: value.language === 'es' ? 'es' : 'en',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
