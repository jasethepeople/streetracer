import {
  MAX_CHAT_CHARACTERS,
  MAX_RACE_WAYPOINTS,
  MAX_MESSAGE_BYTES,
  MAX_FORWARD_SPEED_MPS,
  MAX_HANDLE_CHARACTERS,
  MAX_HORIZONTAL_VELOCITY_MPS,
  MAX_REVERSE_SPEED_MPS,
  MAX_TELEPORT_DISTANCE_METERS,
  MAX_VERTICAL_VELOCITY_MPS,
  PROTOCOL_VERSION,
  type ClientMessage,
  type LonLat,
  type NetworkCarState,
  type PublicPlayerState,
} from '@openstreet-racer/shared';
import { localMetersToLonLat, lonLatToLocalMeters } from '@openstreet-racer/world';

const MAX_RACE_TITLE_CHARACTERS = 48;

export type MessageParseResult =
  | { readonly ok: true; readonly message: ClientMessage }
  | { readonly ok: false; readonly code: string; readonly message: string };

export function parseClientMessage(text: string): MessageParseResult {
  if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
    return failure('MESSAGE_TOO_LARGE', 'Message exceeds the size limit.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return failure('INVALID_JSON', 'Message must be valid JSON.');
  }
  if (!isRecord(parsed)) return failure('INVALID_MESSAGE', 'Message must be a JSON object.');
  if (parsed.version !== PROTOCOL_VERSION) {
    return failure('UNSUPPORTED_VERSION', 'This client uses an unsupported protocol version.');
  }

  switch (parsed.type) {
    case 'hello': {
      if (typeof parsed.handle !== 'string')
        return failure('INVALID_HANDLE', 'Handle must be text.');
      const car = parseCarState(parsed.car);
      const anonymousPlayerId =
        parsed.anonymousPlayerId === undefined
          ? undefined
          : parseAnonymousPlayerId(parsed.anonymousPlayerId);
      if (!car || (parsed.anonymousPlayerId !== undefined && !anonymousPlayerId)) {
        return failure('INVALID_STATE', 'Initial player data contains invalid fields.');
      }
      return {
        ok: true,
        message: {
          version: 1,
          type: 'hello',
          handle: sanitizeHandle(parsed.handle),
          ...(anonymousPlayerId ? { anonymousPlayerId } : {}),
          car,
        },
      };
    }
    case 'state': {
      const seq = safeSequence(parsed.seq);
      const car = parseCarState(parsed.car);
      if (seq === null || !car)
        return failure('INVALID_STATE', 'Player state contains invalid fields.');
      return { ok: true, message: { version: 1, type: 'state', seq, car } };
    }
    case 'relocate': {
      const seq = safeSequence(parsed.seq);
      const car = parseCarState(parsed.car);
      if (seq === null || !car)
        return failure('INVALID_STATE', 'Player state contains invalid fields.');
      return { ok: true, message: { version: 1, type: 'relocate', seq, car } };
    }
    case 'chat': {
      if (typeof parsed.text !== 'string')
        return failure('INVALID_CHAT', 'Chat text must be a string.');
      const text = sanitizeChatText(parsed.text);
      if (!text) return failure('INVALID_CHAT', 'Chat message cannot be empty.');
      return { ok: true, message: { version: 1, type: 'chat', text } };
    }
    case 'ping': {
      const clientTimeMs = finiteNumber(parsed.clientTimeMs);
      if (clientTimeMs === null || clientTimeMs < 0 || clientTimeMs > Number.MAX_SAFE_INTEGER) {
        return failure('INVALID_PING', 'Ping timestamp is invalid.');
      }
      return { ok: true, message: { version: 1, type: 'ping', clientTimeMs } };
    }
    case 'route': {
      const requestId = safeSequence(parsed.requestId);
      const destination = parseLocation(parsed.destination);
      if (requestId === null || !destination) {
        return failure('INVALID_ROUTE', 'Route request is invalid.');
      }
      return { ok: true, message: { version: 1, type: 'route', requestId, destination } };
    }
    case 'missions-request':
      return { ok: true, message: { version: 1, type: 'missions-request' } };
    case 'mission-action': {
      const actions = ['accept', 'start', 'checkpoint', 'complete', 'abandon'] as const;
      const missionId = safeIdentifier(parsed.missionId, 96);
      const checkpointIndex =
        parsed.action === 'checkpoint' ? safeSequence(parsed.checkpointIndex) : undefined;
      if (
        !actions.includes(parsed.action as (typeof actions)[number]) ||
        !missionId ||
        (parsed.action === 'checkpoint' && checkpointIndex === null) ||
        (parsed.action !== 'checkpoint' && parsed.checkpointIndex !== undefined)
      ) {
        return failure('INVALID_MISSION_ACTION', 'Mission request is invalid.');
      }
      return {
        ok: true,
        message: {
          version: 1,
          type: 'mission-action',
          action: parsed.action as (typeof actions)[number],
          missionId,
          ...(checkpointIndex !== undefined && checkpointIndex !== null ? { checkpointIndex } : {}),
        },
      };
    }
    case 'garage-action': {
      const actions = ['buy', 'select', 'repair'] as const;
      const vehicleId =
        parsed.vehicleId === undefined ? undefined : safeVehicleId(parsed.vehicleId);
      if (
        !actions.includes(parsed.action as (typeof actions)[number]) ||
        (parsed.vehicleId !== undefined && !vehicleId) ||
        (parsed.action !== 'repair' && !vehicleId)
      ) {
        return failure('INVALID_GARAGE_ACTION', 'Garage request is invalid.');
      }
      return {
        ok: true,
        message: {
          version: 1,
          type: 'garage-action',
          action: parsed.action as (typeof actions)[number],
          ...(vehicleId ? { vehicleId } : {}),
        },
      };
    }
    case 'leaderboard-request': {
      const raceId = parsed.raceId === undefined ? undefined : safeIdentifier(parsed.raceId, 96);
      if (parsed.raceId !== undefined && !raceId) {
        return failure('INVALID_LEADERBOARD', 'Leaderboard request is invalid.');
      }
      return {
        ok: true,
        message: { version: 1, type: 'leaderboard-request', ...(raceId ? { raceId } : {}) },
      };
    }
    case 'damage-report': {
      const damage = finiteNumber(parsed.damage);
      if (damage === null || damage < 0 || damage > 100) {
        return failure('INVALID_DAMAGE', 'Vehicle damage is invalid.');
      }
      return { ok: true, message: { version: 1, type: 'damage-report', damage } };
    }    case 'impact-report': {
      const targetKind = parsed.targetKind;
      if (
        targetKind !== 'vehicle' &&
        targetKind !== 'pedestrian' &&
        targetKind !== 'police' &&
        targetKind !== 'prop'
      ) {
        return failure('INVALID_IMPACT', 'Impact target is invalid.');
      }
      const hardness = finiteNumber(parsed.hardness);
      if (hardness === null || hardness < 0 || hardness > 100) {
        return failure('INVALID_IMPACT', 'Impact hardness is invalid.');
      }
      return {
        ok: true,
        message: { version: 1, type: 'impact-report', targetKind, hardness },
      };
    }
    case 'race-create': {
      if (typeof parsed.title !== 'string') {
        return failure('INVALID_RACE', 'Race name must be text.');
      }
      const title = sanitizeRaceTitle(parsed.title);
      const destination = parseLocation(parsed.destination);
      if (!title || !destination) {
        return failure('INVALID_RACE', 'Race name or destination is invalid.');
      }
      let waypoints: readonly LonLat[] | undefined;
      if (parsed.waypoints !== undefined) {
        if (!Array.isArray(parsed.waypoints)) {
          return failure('INVALID_RACE', 'Race waypoints must be a list of locations.');
        }
        if (parsed.waypoints.length < 1 || parsed.waypoints.length > MAX_RACE_WAYPOINTS) {
          return failure(
            'INVALID_RACE',
            `Races accept 1-${MAX_RACE_WAYPOINTS} checkpoints dropped by the player.`,
          );
        }
        const points: LonLat[] = [];
        for (const waypoint of parsed.waypoints) {
          const point = parseLocation(waypoint);
          if (!point) {
            return failure('INVALID_RACE', 'Race waypoints must be valid locations.');
          }
          points.push(point);
        }
        waypoints = points;
      }
      return {
        ok: true,
        message: { version: 1, type: 'race-create', title, destination, waypoints },
      };
    }
    default:
      return failure('UNKNOWN_MESSAGE', 'Message type is not supported.');
  }
}

export function sanitizeHandle(value: string): string {
  return Array.from(
    value
      .normalize('NFKC')
      .replace(/[\p{Cc}\p{Cf}]/gu, '')
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim(),
  )
    .slice(0, MAX_HANDLE_CHARACTERS)
    .join('');
}

export function sanitizeRaceTitle(value: string): string {
  return Array.from(
    value
      .normalize('NFKC')
      .replace(/[\p{Cc}\p{Cf}]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim(),
  )
    .slice(0, MAX_RACE_TITLE_CHARACTERS)
    .join('');
}

export function sanitizeChatText(value: string): string {
  return Array.from(
    value
      .normalize('NFKC')
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
  )
    .slice(0, MAX_CHAT_CHARACTERS)
    .join('');
}

export function limitTeleportDistance(
  next: NetworkCarState,
  previous: NetworkCarState | null,
  elapsedSeconds: number,
): NetworkCarState {
  if (!previous) return next;
  const displacement = lonLatToLocalMeters(next.position, previous.position);
  const distance = Math.hypot(displacement.x, displacement.y);
  const allowance = Math.min(
    MAX_TELEPORT_DISTANCE_METERS,
    MAX_FORWARD_SPEED_MPS * clamp(elapsedSeconds, 0, 2) * 1.5 + 3,
  );
  if (distance <= allowance || distance === 0) return next;
  const ratio = allowance / distance;
  return {
    ...next,
    position: localMetersToLonLat(
      { x: displacement.x * ratio, y: displacement.y * ratio },
      previous.position,
    ),
  };
}

export function publicPlayer(
  id: string,
  handle: string,
  car: NetworkCarState,
  serverTimeMs: number,
): PublicPlayerState {
  return {
    id,
    handle,
    car: {
      ...car,
      position: { ...car.position },
      velocity: { ...car.velocity },
    },
    serverTimeMs,
  };
}

function parseAnonymousPlayerId(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    return null;
  }
  return value.toLowerCase();
}

function safeIdentifier(value: unknown, maximumLength: number): string | null {
  return typeof value === 'string' && value.length <= maximumLength && /^[a-z0-9:-]+$/iu.test(value)
    ? value
    : null;
}

function safeVehicleId(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 32 && /^[a-z0-9-]+$/u.test(value)
    ? value
    : null;
}

function parseLocation(value: unknown): LonLat | null {
  if (!isRecord(value)) return null;
  const longitude = finiteNumber(value.longitude);
  const latitude = finiteNumber(value.latitude);
  if (
    longitude === null ||
    latitude === null ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -85.05113 ||
    latitude > 85.05113
  ) {
    return null;
  }
  return { longitude, latitude };
}

function parseCarState(value: unknown): NetworkCarState | null {
  if (!isRecord(value) || !isRecord(value.position) || !isRecord(value.velocity)) return null;
  const longitude = finiteNumber(value.position.longitude);
  const latitude = finiteNumber(value.position.latitude);
  const altitude = finiteNumber(value.altitudeMeters);
  const east = finiteNumber(value.velocity.eastMetersPerSecond);
  const north = finiteNumber(value.velocity.northMetersPerSecond);
  const up = finiteNumber(value.velocity.upMetersPerSecond);
  const heading = finiteNumber(value.headingRadians);
  const speed = finiteNumber(value.speedMetersPerSecond);
  const vehicleId = value.vehicleId === undefined ? 'sedan' : safeVehicleId(value.vehicleId);
  if (
    longitude === null ||
    latitude === null ||
    altitude === null ||
    east === null ||
    north === null ||
    up === null ||
    heading === null ||
    speed === null ||
    !vehicleId
  ) {
    return null;
  }
  if (longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) return null;
  const velocity = clampVector(east, north, MAX_HORIZONTAL_VELOCITY_MPS);
  return {
    vehicleId,
    position: { longitude, latitude: clamp(latitude, -85.05113, 85.05113) },
    altitudeMeters: clamp(altitude, -20, 200),
    velocity: {
      eastMetersPerSecond: velocity.x,
      northMetersPerSecond: velocity.y,
      upMetersPerSecond: clamp(up, -MAX_VERTICAL_VELOCITY_MPS, MAX_VERTICAL_VELOCITY_MPS),
    },
    headingRadians: normalizeRadians(heading),
    speedMetersPerSecond: clamp(speed, -MAX_REVERSE_SPEED_MPS, MAX_FORWARD_SPEED_MPS),
  };
}

function clampVector(x: number, y: number, maximum: number): { x: number; y: number } {
  const length = Math.hypot(x, y);
  if (length <= maximum || length === 0) return { x, y };
  const ratio = maximum / length;
  return { x: x * ratio, y: y * ratio };
}

function safeSequence(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeRadians(value: number): number {
  const fullTurn = Math.PI * 2;
  return ((value % fullTurn) + fullTurn) % fullTurn;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(code: string, message: string): MessageParseResult {
  return { ok: false, code, message };
}
