import {
  CLIENT_STATE_INTERVAL_MS,
  MAX_CHAT_CHARACTERS,
  PROTOCOL_VERSION,
  type ActiveMission,
  type LeaderboardSnapshot,
  type LonLat,
  type MissionOffer,
  type ImpactTargetKind,
  type NetworkCarState,
  type PlayerProfile,
  type PublicPlayerState,
  type RouteFailure,
  type RouteResult,
  type ServerMessage,
  type WorldSnapshot,
} from '@openstreet-racer/shared';

export interface MultiplayerClientCallbacks {
  readonly getCar: () => NetworkCarState;
  readonly onRoster: (players: readonly PublicPlayerState[], receivedAt: number) => void;
  readonly onPlayerState: (player: PublicPlayerState, receivedAt: number) => void;
  readonly onPlayerLeft: (playerId: string) => void;
  readonly onChat: (message: Extract<ServerMessage, { type: 'chat' }>) => void;
  readonly onWorld: (snapshot: WorldSnapshot, receivedAt: number) => void;
  readonly onRoute: (result: RouteResult | RouteFailure) => void;
  readonly onProfile: (profile: PlayerProfile) => void;
  readonly onMissions: (
    offers: readonly MissionOffer[],
    activeMission: ActiveMission | null,
  ) => void;
  readonly onLeaderboard: (snapshot: LeaderboardSnapshot) => void;
  readonly onRaceCreated: (offer: MissionOffer) => void;
  readonly onPursuit: (pursuit: Extract<ServerMessage, { type: 'pursuit' }>) => void;
  readonly onBusted: (busted: Extract<ServerMessage, { type: 'busted' }>) => void;
  readonly onWrecked: (wrecked: Extract<ServerMessage, { type: 'wrecked' }>) => void;
  readonly onStatus: (message: string) => void;
}

const PING_INTERVAL_MS = 10_000;
const MAX_BUFFERED_BYTES = 64 * 1024;

export class MultiplayerClient {
  private socket: WebSocket | null = null;
  private readonly stateTimer: number;
  private readonly pingTimer: number;
  private reconnectTimer = 0;
  private reconnectAttempt = 0;
  private sequence = 0;
  private routeSequence = 1;
  private handle = '';
  private joined = false;
  private disposed = false;

  constructor(
    private readonly url: string,
    private readonly requestedHandle: string,
    private readonly callbacks: MultiplayerClientCallbacks,
  ) {
    this.stateTimer = window.setInterval(() => this.sendState(), CLIENT_STATE_INTERVAL_MS);
    this.pingTimer = window.setInterval(() => this.sendPing(), PING_INTERVAL_MS);
    this.connect();
  }

  sendChat(text: string): boolean {
    const message = text.normalize('NFKC').trim();
    if (!message || Array.from(message).length > MAX_CHAT_CHARACTERS || !this.joined) return false;
    return this.send({ version: PROTOCOL_VERSION, type: 'chat', text: message });
  }

  requestRoute(destination: LonLat): number | null {
    if (!this.joined) return null;
    const requestId = this.routeSequence++;
    const sent = this.send({ version: PROTOCOL_VERSION, type: 'route', requestId, destination });
    return sent ? requestId : null;
  }

  requestMissions(): void {
    if (this.joined) this.send({ version: PROTOCOL_VERSION, type: 'missions-request' });
  }

  publishRace(title: string, destination: LonLat, waypoints?: readonly LonLat[]): boolean {
    if (!this.joined) return false;
    return this.send({
      version: PROTOCOL_VERSION,
      type: 'race-create',
      title,
      destination,
      ...(waypoints?.length ? { waypoints } : {}),
    });
  }

  sendMissionAction(
    action: 'accept' | 'abandon' | 'start' | 'checkpoint' | 'complete',
    missionId: string,
    checkpointIndex?: number,
  ): void {
    if (!this.joined) return;
    this.send({
      version: PROTOCOL_VERSION,
      type: 'mission-action',
      action,
      missionId,
      ...(checkpointIndex === undefined ? {} : { checkpointIndex }),
    });
  }

  sendGarageAction(action: 'buy' | 'select' | 'repair', vehicleId?: string): void {
    if (!this.joined) return;
    this.send({
      version: PROTOCOL_VERSION,
      type: 'garage-action',
      action,
      ...(vehicleId ? { vehicleId } : {}),
    });
  }

  requestLeaderboard(raceId?: string): void {
    if (!this.joined) return;
    this.send({
      version: PROTOCOL_VERSION,
      type: 'leaderboard-request',
      ...(raceId ? { raceId } : {}),
    });
  }

  sendDamageReport(damage: number): void {
    if (this.joined) this.send({ version: PROTOCOL_VERSION, type: 'damage-report', damage });
  }

  sendWantedHeat(heat: number): void {
    if (!this.joined) return;
    this.send({ version: PROTOCOL_VERSION, type: 'wanted-heat', heat });
  }

  sendImpactReport(targetKind: ImpactTargetKind, hardness: number): void {
    if (!this.joined || hardness < 25) return;
    this.send({ version: PROTOCOL_VERSION, type: 'impact-report', targetKind, hardness });
  }

  relocate(): void {
    if (!this.joined) return;
    this.send({
      version: PROTOCOL_VERSION,
      type: 'relocate',
      seq: this.sequence++,
      car: this.callbacks.getCar(),
    });
  }

  dispose(): void {
    this.disposed = true;
    window.clearInterval(this.stateTimer);
    window.clearInterval(this.pingTimer);
    window.clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, 'Leaving the game');
    this.socket = null;
  }

  private connect(): void {
    if (this.disposed) return;
    this.callbacks.onStatus('Connecting to nearby drivers…');
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (this.socket !== socket || this.disposed) return;
      this.reconnectAttempt = 0;
      this.joined = false;
      this.handle = this.requestedHandle || createGuestHandle();
      this.callbacks.onStatus('Connected · joining nearby drivers');
      this.send({
        version: PROTOCOL_VERSION,
        type: 'hello',
        handle: this.handle,
        anonymousPlayerId: getOrCreateAnonymousPlayerId(),
        car: this.callbacks.getCar(),
      });
    });
    socket.addEventListener('message', (event: MessageEvent<string>) => {
      if (this.socket !== socket || typeof event.data !== 'string') return;
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      this.receive(message);
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.joined = false;
      this.callbacks.onRoster([], performance.now());
      if (!this.disposed) {
        this.callbacks.onStatus('Multiplayer offline · reconnecting');
        this.scheduleReconnect();
      }
    });
    socket.addEventListener('error', () => {
      if (this.socket === socket)
        this.callbacks.onStatus('Multiplayer connection failed · retrying');
    });
  }

  private receive(message: ServerMessage): void {
    const receivedAt = performance.now();
    switch (message.type) {
      case 'welcome':
        this.joined = true;
        this.handle = message.handle;
        this.callbacks.onStatus(`Online as ${message.handle}`);
        this.callbacks.onProfile(message.profile);
        this.requestMissions();
        this.requestLeaderboard();
        break;
      case 'roster':
        this.callbacks.onRoster(message.players, receivedAt);
        break;
      case 'states':
        for (const player of message.players) this.callbacks.onPlayerState(player, receivedAt);
        break;
      case 'player-left':
        this.callbacks.onPlayerLeft(message.playerId);
        break;
      case 'chat':
        this.callbacks.onChat(message);
        break;
      case 'world':
        this.callbacks.onWorld(message.snapshot, receivedAt);
        break;
      case 'route-result':
        this.callbacks.onRoute(message.result);
        break;
      case 'missions':
        this.callbacks.onMissions(message.offers, message.activeMission);
        break;
      case 'progress':
        this.callbacks.onProfile(message.profile);
        break;
      case 'leaderboard':
        this.callbacks.onLeaderboard(message.snapshot);
        break;
      case 'race-created':
        this.callbacks.onRaceCreated(message.offer);
        break;
      case 'pursuit':
        this.callbacks.onPursuit(message);
        break;
      case 'busted':
        this.callbacks.onBusted(message);
        break;
      case 'wrecked':
        this.callbacks.onWrecked(message);
        break;
      case 'pong':
        break;
      case 'error':
        this.callbacks.onStatus(message.message);
        break;
    }
  }

  private sendState(): void {
    if (!this.joined) return;
    this.send({
      version: PROTOCOL_VERSION,
      type: 'state',
      seq: this.sequence++,
      car: this.callbacks.getCar(),
    });
  }

  private sendPing(): void {
    if (!this.joined) return;
    this.send({ version: PROTOCOL_VERSION, type: 'ping', clientTimeMs: performance.now() });
  }

  private send(message: object): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    if (this.socket.bufferedAmount > MAX_BUFFERED_BYTES) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    const delay = Math.min(5_000, 500 * 2 ** Math.min(this.reconnectAttempt, 4));
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(
      () => {
        this.reconnectTimer = 0;
        this.connect();
      },
      delay + Math.random() * 250,
    );
  }
}

export function defaultMultiplayerUrl(): string {
  const configured = import.meta.env.VITE_MULTIPLAYER_URL?.trim();
  const url = new URL(configured || '/ws', window.location.href);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  return url.toString();
}

export function getOrCreateHandle(): string {
  try {
    const key = 'openstreet-racer-handle';
    const saved = window.localStorage.getItem(key);
    if (saved) return saved;
    const handle = createGuestHandle();
    window.localStorage.setItem(key, handle);
    return handle;
  } catch {
    return createGuestHandle();
  }
}

export function getOrCreateAnonymousPlayerId(): string {
  try {
    const key = 'openstreet-racer-player-id';
    const saved = window.localStorage.getItem(key);
    if (saved && isUuid(saved)) return saved.toLowerCase();
    const value = new Uint8Array(16);
    crypto.getRandomValues(value);
    value[6] = ((value[6] ?? 0) & 0x0f) | 0x40;
    value[8] = ((value[8] ?? 0) & 0x3f) | 0x80;
    const id = [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const formatted = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
    window.localStorage.setItem(key, formatted);
    return formatted;
  } catch {
    return '00000000-0000-4000-8000-000000000000';
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function createGuestHandle(): string {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return `Driver-${(value[0] % 10_000).toString().padStart(4, '0')}`;
}
