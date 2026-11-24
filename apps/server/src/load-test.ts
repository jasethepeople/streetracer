import WebSocket from 'ws';
import type { LonLat, NetworkCarState, ServerMessage } from '@openstreet-racer/shared';
import { localMetersToLonLat } from '@openstreet-racer/world';
import { createGameServer } from './index';

const CLIENT_COUNT = 20;
const UPDATE_INTERVAL_MS = 100;
const DEFAULT_DURATION_MS = 5_000;

class FakeClient {
  readonly socket: WebSocket;
  readonly messages: ServerMessage[] = [];
  private readonly waiters: {
    readonly predicate: (message: ServerMessage) => boolean;
    readonly resolve: (message: ServerMessage) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }[] = [];

  constructor(url: string) {
    this.socket = new WebSocket(url, { perMessageDeflate: false });
    this.socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      this.messages.push(message);
      for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
        const waiter = this.waiters[index];
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        this.waiters.splice(index, 1);
        waiter.resolve(message);
      }
    });
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
  }

  waitFor(
    predicate: (message: ServerMessage) => boolean,
    timeoutMs = 5_000,
  ): Promise<ServerMessage> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('Timed out waiting for a server message.'));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  send(message: object): void {
    this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.socket.terminate();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Fake client closed.'));
    }
    this.waiters.length = 0;
  }
}

async function runLoadTest(): Promise<void> {
  const durationMs = Math.max(
    1_000,
    Number(process.env.LOAD_TEST_DURATION_MS) || DEFAULT_DURATION_MS,
  );
  const origin: LonLat = { longitude: -104.9903, latitude: 39.7392 };
  const server = createGameServer({
    host: '127.0.0.1',
    port: 0,
    webRoot: '/tmp/openstreet-racer-no-web',
    ambientWorld: null,
  });
  const cpuStart = process.cpuUsage();
  const startedAt = performance.now();
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string')
    throw new Error('Load-test server did not bind a port.');
  const clients = Array.from(
    { length: CLIENT_COUNT },
    () => new FakeClient(`ws://127.0.0.1:${address.port}/ws`),
  );

  try {
    await Promise.all(clients.map((client) => client.open()));
    clients.forEach((client, index) => {
      client.send({
        version: 1,
        type: 'hello',
        handle: `Load-${index.toString().padStart(2, '0')}`,
        car: createCar(origin, 0, 0),
      });
    });
    await Promise.all(
      clients.map((client) => client.waitFor((message) => message.type === 'welcome')),
    );
    await Promise.all(
      clients.map((client) => client.waitFor((message) => message.type === 'roster')),
    );

    const loopStartedAt = performance.now();
    let sequence = 0;
    const update = setInterval(() => {
      const elapsed = (performance.now() - loopStartedAt) / 1_000;
      clients.forEach((client, index) => {
        const angle = elapsed * 0.35 + (index * Math.PI * 2) / CLIENT_COUNT;
        const radius = 35;
        const east = Math.cos(angle) * radius;
        const north = Math.sin(angle) * radius;
        const velocityEast = -Math.sin(angle) * radius * 0.35;
        const velocityNorth = Math.cos(angle) * radius * 0.35;
        const car = createCar(origin, east, north, velocityEast, velocityNorth);
        client.send({ version: 1, type: 'state', seq: sequence++, car });
      });
    }, UPDATE_INTERVAL_MS);

    await delay(durationMs);
    clearInterval(update);
    await delay(250);

    const relayedPlayers = clients.reduce(
      (total, client) =>
        total +
        client.messages
          .filter(
            (message): message is Extract<ServerMessage, { type: 'states' }> =>
              message.type === 'states',
          )
          .reduce((count, message) => count + message.players.length, 0),
      0,
    );
    const missingPeers = clients.filter(
      (client) => !client.messages.some((message) => message.type === 'states'),
    ).length;
    const metrics = server.getMetrics();
    const elapsedSeconds = (performance.now() - startedAt) / 1_000;
    const cpu = process.cpuUsage(cpuStart);
    const cpuSeconds = (cpu.user + cpu.system) / 1_000_000;
    const health = await fetch(`http://127.0.0.1:${address.port}/health`).then((response) =>
      response.json(),
    );

    if (missingPeers || metrics.players !== CLIENT_COUNT || relayedPlayers === 0) {
      throw new Error(
        `Load test failed: missing peers=${missingPeers}, metrics=${JSON.stringify(metrics)}.`,
      );
    }
    console.log(
      `PASS · ${CLIENT_COUNT} clients · 10 Hz state updates · ${relayedPlayers} relayed player states · ` +
        `${elapsedSeconds.toFixed(1)} s wall / ${cpuSeconds.toFixed(2)} s CPU · health=${JSON.stringify(health)}`,
    );
  } finally {
    for (const client of clients) client.close();
    await server.close();
  }
}

function createCar(
  origin: LonLat,
  east: number,
  north: number,
  velocityEast = 0,
  velocityNorth = 0,
): NetworkCarState {
  const speed = Math.hypot(velocityEast, velocityNorth);
  return {
    position: localMetersToLonLat({ x: east, y: north }, origin),
    altitudeMeters: 0.6,
    velocity: {
      eastMetersPerSecond: velocityEast,
      northMetersPerSecond: velocityNorth,
      upMetersPerSecond: 0,
    },
    headingRadians: Math.atan2(velocityEast, velocityNorth),
    speedMetersPerSecond: speed,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

void runLoadTest().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
