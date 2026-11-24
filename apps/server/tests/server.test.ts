import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { MissionOffer, NetworkCarState, ServerMessage } from '@openstreet-racer/shared';
import { localMetersToLonLat } from '@openstreet-racer/world';
import { createGameServer } from '../src/index';
import { PlayerStore } from '../src/player-store';
import type { AmbientWorldService } from '../src/ambient-world';

const ORIGIN = { longitude: -104.9903, latitude: 39.7392 };
const MISSION_OFFER: MissionOffer = {
  id: 'mission-checkpoint-test',
  kind: 'checkpoint-race',
  title: 'Checkpoint race · Market → Park',
  areaKey: '14/3413/6218',
  pickup: { id: 'node-1', name: 'Market', category: 'shop', location: ORIGIN },
  destination: { id: 'node-2', name: 'Park', category: 'park', location: ORIGIN },
  route: [ORIGIN, localMetersToLonLat({ x: 100, y: 0 }, ORIGIN)],
  checkpoints: [ORIGIN],
  distanceMeters: 1_000,
  minimumTimeSeconds: 2,
  timeLimitSeconds: 120,
  rewardCents: 8_000,
};
const testDataDirectory = join(tmpdir(), `openstreet-racer-server-${randomUUID()}`);
const playerStore = new PlayerStore(testDataDirectory);
let serverTimeMs = 10_000;
const ambientWorld: AmbientWorldService = {
  prepare: async () => undefined,
  getSnapshot: (_location, serverTimeMs = 10_000) => ({
    status: 'ready',
    actors: [
      {
        id: 'traffic-test',
        kind: 'vehicle',
        vehicleClass: 'car',
        position: ORIGIN,
        headingRadians: Math.PI / 2,
        speedMetersPerSecond: 5,
      },
    ],
    controls: [],
    serverTimeMs,
  }),
  findRoute: async (origin, destination) => ({
    points: [origin, destination],
    distanceMeters: 100,
    travelTimeSeconds: 10,
  }),
  getMissionOffers: async () => [MISSION_OFFER],
};
const server = createGameServer({
  host: '127.0.0.1',
  port: 0,
  now: () => serverTimeMs,
  ambientWorld,
  playerStore,
});
let serverUrl = '';
const clients: WebSocket[] = [];

const started = server.listen().then(({ host, port }) => {
  serverUrl = `ws://${host}:${port}/ws`;
});

afterAll(async () => {
  for (const client of clients.splice(0)) client.terminate();
  await server.close();
  await playerStore.close();
  await rm(testDataDirectory, { recursive: true, force: true });
});

describe('WebSocket game server', () => {
  it('joins nearby drivers, relays bounded state and chat, and reports health', async () => {
    await started;
    const first = await connect('Alpha');
    const firstWelcome = await first.waitFor((message) => message.type === 'welcome');
    expect(firstWelcome.type).toBe('welcome');
    if (firstWelcome.type !== 'welcome') return;

    const firstRoster = await first.waitFor((message) => message.type === 'roster');
    expect(firstRoster.type).toBe('roster');
    if (firstRoster.type !== 'roster') return;
    expect(firstRoster.players).toHaveLength(0);

    const firstWorld = await first.waitFor((message) => message.type === 'world');
    expect(firstWorld.type).toBe('world');
    if (firstWorld.type !== 'world') return;
    expect(firstWorld.snapshot.status).toBe('ready');
    expect(firstWorld.snapshot.actors.map((actor) => actor.id)).toEqual(['traffic-test']);

    const second = await connect('Bravo');
    const secondWelcome = await second.waitFor((message) => message.type === 'welcome');
    expect(secondWelcome.type).toBe('welcome');
    const secondRoster = await second.waitFor((message) => message.type === 'roster');
    expect(secondRoster.type).toBe('roster');
    if (secondRoster.type !== 'roster' || secondWelcome.type !== 'welcome') return;
    expect(secondRoster.players.map((player) => player.id)).toContain(firstWelcome.playerId);

    const secondWorld = await second.waitFor((message) => message.type === 'world');
    expect(secondWorld.type).toBe('world');
    if (secondWorld.type !== 'world') return;
    expect(secondWorld.snapshot.actors).toEqual(firstWorld.snapshot.actors);

    first.socket.send(
      JSON.stringify({
        version: 1,
        type: 'route',
        requestId: 1,
        destination: localMetersToLonLat({ x: 100, y: 0 }, ORIGIN),
      }),
    );
    const route = await first.waitFor((message) => message.type === 'route-result');
    expect(route.type).toBe('route-result');
    if (route.type !== 'route-result') return;
    expect(route.result).toMatchObject({ requestId: 1, ok: true, distanceMeters: 100 });

    const firstUpdatedRoster = await first.waitFor(
      (message) =>
        message.type === 'roster' &&
        message.players.some((player) => player.id === secondWelcome.playerId),
    );
    expect(firstUpdatedRoster.type).toBe('roster');

    const movedCar = {
      ...carAt(0, 0),
      position: localMetersToLonLat({ x: 1_000, y: 0 }, ORIGIN),
      speedMetersPerSecond: 200,
      velocity: { eastMetersPerSecond: 100, northMetersPerSecond: 100, upMetersPerSecond: 0 },
    };
    first.socket.send(JSON.stringify({ version: 1, type: 'state', seq: 1, car: movedCar }));
    const relayedState = await second.waitFor(
      (message) =>
        message.type === 'states' &&
        message.players.some((player) => player.id === firstWelcome.playerId),
    );
    expect(relayedState.type).toBe('states');
    if (relayedState.type === 'states') {
      const player = relayedState.players.find((entry) => entry.id === firstWelcome.playerId)!;
      expect(player.car.speedMetersPerSecond).toBe(36);
      expect(player.car.velocity.eastMetersPerSecond).toBeCloseTo(25.455, 2);
      expect(player.car.position.longitude).toBeLessThan(movedCar.position.longitude);
    }

    const firstChat = first.waitFor((message) => message.type === 'chat');
    const secondChat = second.waitFor((message) => message.type === 'chat');
    first.socket.send(JSON.stringify({ version: 1, type: 'chat', text: 'Hello, nearby drivers!' }));
    await expect(firstChat).resolves.toMatchObject({
      type: 'chat',
      handle: 'Alpha',
      text: 'Hello, nearby drivers!',
    });
    await expect(secondChat).resolves.toMatchObject({
      type: 'chat',
      handle: 'Alpha',
      text: 'Hello, nearby drivers!',
    });

    const response = await fetch(serverUrl.replace(/^ws/, 'http').replace('/ws', '/health'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'ok', players: 2 });
  });
  it('validates mission checkpoints, saves rewards, and applies garage and repair actions', async () => {
    await started;
    serverTimeMs = 20_000;
    const client = await connect('Driver', '0c2f08c5-34a1-49f4-8c35-8d5168f75e0a');
    const welcome = await client.waitFor((message) => message.type === 'welcome');
    expect(welcome.type).toBe('welcome');

    client.socket.send(JSON.stringify({ version: 1, type: 'missions-request' }));
    const missions = await client.waitFor((message) => message.type === 'missions');
    expect(missions).toMatchObject({ offers: [{ id: MISSION_OFFER.id }] });

    client.socket.send(
      JSON.stringify({
        version: 1,
        type: 'mission-action',
        action: 'accept',
        missionId: MISSION_OFFER.id,
      }),
    );
    const accepted = await client.waitFor(
      (message) =>
        message.type === 'progress' && message.profile.activeMission?.startedAtMs === null,
    );
    expect(accepted.type).toBe('progress');

    const startedProfile = client.waitFor(
      (message) =>
        message.type === 'progress' &&
        message.profile.activeMission?.startedAtMs !== null &&
        message.profile.activeMission?.startedAtMs !== undefined,
    );
    client.socket.send(
      JSON.stringify({
        version: 1,
        type: 'mission-action',
        action: 'start',
        missionId: MISSION_OFFER.id,
      }),
    );
    await expect(startedProfile).resolves.toMatchObject({
      type: 'progress',
      profile: { activeMission: { startedAtMs: 20_000 } },
    });

    const checkpointError = client.waitFor(
      (message) => message.type === 'error' && message.code === 'CHECKPOINTS_REMAINING',
    );
    client.socket.send(
      JSON.stringify({
        version: 1,
        type: 'mission-action',
        action: 'complete',
        missionId: MISSION_OFFER.id,
      }),
    );
    await expect(checkpointError).resolves.toMatchObject({ type: 'error' });

    const checkpointed = client.waitFor(
      (message) =>
        message.type === 'progress' && message.profile.activeMission?.nextCheckpointIndex === 1,
    );
    client.socket.send(
      JSON.stringify({
        version: 1,
        type: 'mission-action',
        action: 'checkpoint',
        missionId: MISSION_OFFER.id,
        checkpointIndex: 0,
      }),
    );
    await expect(checkpointed).resolves.toMatchObject({
      type: 'progress',
      profile: { activeMission: { nextCheckpointIndex: 1 } },
    });

    serverTimeMs = 25_000;
    const earned = client.waitFor(
      (message) => message.type === 'progress' && message.profile.balanceCents === 8_000,
    );
    const raceLeaderboard = client.waitFor(
      (message) => message.type === 'leaderboard' && message.snapshot.raceId === MISSION_OFFER.id,
    );
    client.socket.send(
      JSON.stringify({
        version: 1,
        type: 'mission-action',
        action: 'complete',
        missionId: MISSION_OFFER.id,
      }),
    );
    await expect(earned).resolves.toMatchObject({
      type: 'progress',
      profile: { totalMissions: 1, activeMission: null },
    });
    await expect(raceLeaderboard).resolves.toMatchObject({
      type: 'leaderboard',
      snapshot: { entries: [{ timeSeconds: 5 }] },
    });

    const bought = client.waitFor(
      (message) =>
        message.type === 'progress' &&
        message.profile.balanceCents === 5_500 &&
        message.profile.ownedVehicleIds.includes('motorbike'),
    );
    client.socket.send(
      JSON.stringify({ version: 1, type: 'garage-action', action: 'buy', vehicleId: 'motorbike' }),
    );
    await expect(bought).resolves.toMatchObject({
      type: 'progress',
      profile: { selectedVehicleId: 'sedan' },
    });

    const selected = client.waitFor(
      (message) => message.type === 'progress' && message.profile.selectedVehicleId === 'motorbike',
    );
    client.socket.send(
      JSON.stringify({
        version: 1,
        type: 'garage-action',
        action: 'select',
        vehicleId: 'motorbike',
      }),
    );
    await selected;

    const damaged = client.waitFor(
      (message) => message.type === 'progress' && message.profile.damage === 20,
    );
    client.socket.send(JSON.stringify({ version: 1, type: 'damage-report', damage: 40 }));
    await damaged;

    const repaired = client.waitFor(
      (message) =>
        message.type === 'progress' &&
        message.profile.damage === 0 &&
        message.profile.balanceCents === 5_000,
    );
    client.socket.send(JSON.stringify({ version: 1, type: 'garage-action', action: 'repair' }));
    await expect(repaired).resolves.toMatchObject({
      type: 'progress',
      profile: { balanceCents: 5_000, damage: 0 },
    });
  });
});

interface ConnectedClient {
  readonly socket: WebSocket;
  waitFor(predicate: (message: ServerMessage) => boolean): Promise<ServerMessage>;
}

async function connect(handle: string, anonymousPlayerId?: string): Promise<ConnectedClient> {
  const socket = new WebSocket(serverUrl);
  clients.push(socket);
  const messages: ServerMessage[] = [];
  const waiters = new Set<{
    predicate: (message: ServerMessage) => boolean;
    resolve: (message: ServerMessage) => void;
    reject: (error: Error) => void;
  }>();
  socket.on('message', (data) => {
    let message: ServerMessage;
    try {
      message = JSON.parse(data.toString()) as ServerMessage;
    } catch {
      return;
    }
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      waiters.delete(waiter);
      waiter.resolve(message);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.send(
    JSON.stringify({
      version: 1,
      type: 'hello',
      handle,
      ...(anonymousPlayerId ? { anonymousPlayerId } : {}),
      car: carAt(0, 0),
    }),
  );
  return {
    socket,
    waitFor(predicate) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject };
        waiters.add(waiter);
        setTimeout(() => {
          if (!waiters.delete(waiter)) return;
          reject(new Error(`Timed out waiting for message from ${handle}`));
        }, 2_000).unref();
      });
    },
  };
}

function carAt(eastMeters: number, northMeters: number): NetworkCarState {
  return {
    position: localMetersToLonLat({ x: eastMeters, y: northMeters }, ORIGIN),
    altitudeMeters: 0.6,
    velocity: { eastMetersPerSecond: 0, northMetersPerSecond: 0, upMetersPerSecond: 0 },
    headingRadians: 0,
    speedMetersPerSecond: 0,
  };
}
