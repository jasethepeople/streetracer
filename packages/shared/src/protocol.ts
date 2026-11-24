import type { LonLat } from './index';
import type {
  ActiveMission,
  LeaderboardSnapshot,
  MissionOffer,
  PlayerProfile,
} from './progression';

export const PROTOCOL_VERSION = 1 as const;
export const ROOM_TILE_ZOOM = 14;
export const INTEREST_RADIUS_CELLS = 1;
export const MAX_PLAYERS_PER_CELL = 64;
export const MAX_RELAYED_PLAYERS = 96;
export const CHAT_WINDOW_MS = 10_000;
export const CHAT_MESSAGES_PER_WINDOW = 3;
export const MAX_STATE_MESSAGES_PER_SECOND = 20;
export const MAX_CONNECTIONS = 2_000;
export const MAX_MESSAGE_BYTES = 4_096;
export const MAX_CHAT_CHARACTERS = 160;
export const MAX_HANDLE_CHARACTERS = 20;
export const CLIENT_STATE_INTERVAL_MS = 100;
export const SERVER_BROADCAST_INTERVAL_MS = 100;
export const INTERPOLATION_DELAY_MS = 100;
export const MAX_EXTRAPOLATION_MS = 150;
export const MAX_FORWARD_SPEED_MPS = 36;
export const MAX_REVERSE_SPEED_MPS = 12;
export const MAX_HORIZONTAL_VELOCITY_MPS = 36;
export const MAX_VERTICAL_VELOCITY_MPS = 12;
export const MAX_TELEPORT_DISTANCE_METERS = 60;
export const RELOCATION_WINDOW_MS = 60_000;
export const RELOCATIONS_PER_WINDOW = 6;
export const MAX_WORLD_ACTORS = 48;
export const MAX_WORLD_CONTROLS = 24;
export const MAX_WORLD_MESSAGE_BYTES = 12_288;
export const MAX_ROUTE_DISTANCE_METERS = 7_000;
export const MAX_ROUTE_POINTS = 256;
export const ROUTE_WINDOW_MS = 60_000;
export const ROUTES_PER_WINDOW = 2;
export const MAX_RACE_WAYPOINTS = 5;
export const MIN_RACE_LEG_METERS = 100;
export const WANTED_SIGHT_RADIUS_METERS = 90;

export type PoliceUnitMode = 'chase' | 'roadblock' | 'disabled';

export interface PoliceUnitState {
  readonly id: string;
  readonly mode: PoliceUnitMode;
  readonly position: Readonly<LonLat>;
  readonly headingRadians: number;
  readonly speedMetersPerSecond: number;
  readonly damage: number;
}

export interface NetworkCarState {
  readonly vehicleId?: string;
  readonly position: Readonly<LonLat>;
  readonly altitudeMeters: number;
  readonly velocity: Readonly<{
    eastMetersPerSecond: number;
    northMetersPerSecond: number;
    upMetersPerSecond: number;
  }>;
  readonly headingRadians: number;
  readonly speedMetersPerSecond: number;
}

export interface PublicPlayerState {
  readonly id: string;
  readonly handle: string;
  readonly car: NetworkCarState;
  readonly serverTimeMs: number;
}

export type AmbientActorKind = 'vehicle' | 'pedestrian';
export type AmbientVehicleClass = 'car' | 'van' | 'bus';
export type TrafficControlKind = 'traffic-signal' | 'stop-sign';
export type TrafficControlState = 'red' | 'yellow' | 'green' | 'stop';

export interface AmbientActorState {
  readonly id: string;
  readonly kind: AmbientActorKind;
  readonly vehicleClass?: AmbientVehicleClass;
  readonly position: Readonly<LonLat>;
  readonly headingRadians: number;
  readonly speedMetersPerSecond: number;
}

export interface TrafficControlSnapshot {
  readonly id: string;
  readonly kind: TrafficControlKind;
  readonly state: TrafficControlState;
  readonly position: Readonly<LonLat>;
  readonly changesInMs: number;
}

export interface WorldSnapshot {
  readonly status: 'loading' | 'ready' | 'unavailable';
  readonly actors: readonly AmbientActorState[];
  readonly controls: readonly TrafficControlSnapshot[];
  readonly serverTimeMs: number;
}

export type ImpactTargetKind = 'vehicle' | 'pedestrian' | 'police' | 'prop';

export interface RouteResult {
  readonly requestId: number;
  readonly ok: true;
  readonly points: readonly Readonly<LonLat>[];
  readonly distanceMeters: number;
  readonly travelTimeSeconds: number;
}

export interface RouteFailure {
  readonly requestId: number;
  readonly ok: false;
  readonly message: string;
}

export type ClientMessage =
  | {
      readonly version: 1;
      readonly type: 'hello';
      readonly handle: string;
      readonly anonymousPlayerId?: string;
      readonly car: NetworkCarState;
    }
  | {
      readonly version: 1;
      readonly type: 'state';
      readonly seq: number;
      readonly car: NetworkCarState;
    }
  | {
      readonly version: 1;
      readonly type: 'relocate';
      readonly seq: number;
      readonly car: NetworkCarState;
    }
  | { readonly version: 1; readonly type: 'chat'; readonly text: string }
  | { readonly version: 1; readonly type: 'ping'; readonly clientTimeMs: number }
  | {
      readonly version: 1;
      readonly type: 'route';
      readonly requestId: number;
      readonly destination: Readonly<LonLat>;
    }
  | { readonly version: 1; readonly type: 'missions-request' }
  | {
      readonly version: 1;
      readonly type: 'mission-action';
      readonly action: 'accept' | 'start' | 'checkpoint' | 'complete' | 'abandon';
      readonly missionId: string;
      readonly checkpointIndex?: number;
    }
  | {
      readonly version: 1;
      readonly type: 'garage-action';
      readonly action: 'buy' | 'select' | 'repair';
      readonly vehicleId?: string;
    }
  | {
      readonly version: 1;
      readonly type: 'leaderboard-request';
      readonly raceId?: string;
    }
  | { readonly version: 1; readonly type: 'damage-report'; readonly damage: number }
  | {
      readonly version: 1;
      readonly type: 'impact-report';
      readonly hardness: number;
      readonly targetKind: ImpactTargetKind;
    }
  | {
      readonly version: 1;
      readonly type: 'race-create';
      readonly title: string;
      readonly destination: Readonly<LonLat>;
      readonly waypoints?: readonly Readonly<LonLat>[];
    }
  | { readonly version: 1; readonly type: 'wanted-heat'; readonly heat: number };

export type ServerMessage =
  | {
      readonly version: 1;
      readonly type: 'welcome';
      readonly playerId: string;
      readonly handle: string;
      readonly serverTimeMs: number;
      readonly profile: PlayerProfile;
    }
  | {
      readonly version: 1;
      readonly type: 'roster';
      readonly players: readonly PublicPlayerState[];
      readonly serverTimeMs: number;
    }
  | {
      readonly version: 1;
      readonly type: 'states';
      readonly players: readonly PublicPlayerState[];
      readonly serverTimeMs: number;
    }
  | { readonly version: 1; readonly type: 'player-left'; readonly playerId: string }
  | {
      readonly version: 1;
      readonly type: 'chat';
      readonly playerId: string;
      readonly handle: string;
      readonly text: string;
      readonly serverTimeMs: number;
    }
  | {
      readonly version: 1;
      readonly type: 'pong';
      readonly clientTimeMs: number;
      readonly serverTimeMs: number;
    }
  | {
      readonly version: 1;
      readonly type: 'world';
      readonly snapshot: WorldSnapshot;
    }
  | {
      readonly version: 1;
      readonly type: 'route-result';
      readonly result: RouteResult | RouteFailure;
    }
  | {
      readonly version: 1;
      readonly type: 'missions';
      readonly offers: readonly MissionOffer[];
      readonly activeMission: ActiveMission | null;
    }
  | { readonly version: 1; readonly type: 'progress'; readonly profile: PlayerProfile }
  | {
      readonly version: 1;
      readonly type: 'busted';
      readonly fineCents: number;
      readonly respawnAt: Readonly<LonLat>;
      readonly serverTimeMs: number;
    }
  | {
      readonly version: 1;
      readonly type: 'wrecked';
      readonly repairBillCents: number;
      readonly respawnAt: Readonly<LonLat>;
      readonly serverTimeMs: number;
    }
  | { readonly version: 1; readonly type: 'leaderboard'; readonly snapshot: LeaderboardSnapshot }
  | { readonly version: 1; readonly type: 'race-created'; readonly offer: MissionOffer }
  | {
      readonly version: 1;
      readonly type: 'pursuit';
      readonly level: number;
      readonly heat: number;
      readonly cooldownActive: boolean;
      readonly police: readonly PoliceUnitState[];
      readonly sightRadiusMeters: number;
      readonly serverTimeMs: number;
    }
  | {
      readonly version: 1;
      readonly type: 'error';
      readonly code: string;
      readonly message: string;
    };
