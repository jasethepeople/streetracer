import {
  FALLBACK_LOCATION,
  FALLBACK_LOCATION_LABEL,
  type LonLat,
  type NetworkCarState,
  type PlayerProfile,
  type RouteFailure,
  type RouteResult,
  type WorldSnapshot,
} from '@openstreet-racer/shared';
import {
  FIXED_TIME_STEP_SECONDS,
  FLOATING_ORIGIN_REBASE_METERS,
  publishPlayerCar,
  rebaseGameState,
  readGameState,
  resetGameState,
} from '@openstreet-racer/game';
import { haversineMeters, localMetersToLonLat } from '@openstreet-racer/world';
import { InputController, renderHud } from '@openstreet-racer/ui';
import { searchCity } from './location';
import { AmbientWorldStore } from './ambient-store';
import { VehicleAudio } from './vehicle-audio';
import { GameMap } from './road-map';
import { MultiplayerClient, defaultMultiplayerUrl, getOrCreateHandle } from './multiplayer-client';
import { RemotePlayerStore } from './remote-player-store';
import { GameMenu } from './game-menu';
import { loadVehicleMods } from './mod-loader';
import { DEFAULT_GAME_SETTINGS, ProgressStore, type GameSettings } from './progress-store';
import type { WorldRuntime } from './world-runtime';
import type { MissionMarker } from './world-renderer';
import './styles.css';

const MAX_FRAME_DELTA_SECONDS = 0.25;
const CHUNK_UPDATE_INTERVAL_MS = 450;
const STREET_QUERY_INTERVAL_MS = 450;

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing page element #${id}`);
  return found as T;
};

const mapError = element<HTMLDivElement>('map-error');
const searchMessage = element<HTMLParagraphElement>('search-message');
const cityForm = element<HTMLFormElement>('city-search');
const cityQuery = element<HTMLInputElement>('city-query');
const routeForm = element<HTMLFormElement>('route-form');
const routeQuery = element<HTMLInputElement>('route-query');
const routeStatus = element<HTMLElement>('route-status');
const routeClear = element<HTMLButtonElement>('route-clear');
const worldStatus = element<HTMLElement>('world-status');
const audioMute = element<HTMLButtonElement>('audio-mute');
const masterVolume = element<HTMLInputElement>('master-volume');
const volumeValue = element<HTMLOutputElement>('volume-value');
const locationButton = element<HTMLButtonElement>('use-location');
const debugOverlay = element<HTMLDivElement>('debug-overlay');
const cameraButton = element<HTMLButtonElement>('camera-toggle');
const playerLabelLayer = element<HTMLDivElement>('player-labels');
const chatToggle = element<HTMLButtonElement>('chat-toggle');
const nearbyCount = element<HTMLElement>('nearby-count');
const chatPanel = element<HTMLElement>('chat-panel');
const chatClose = element<HTMLButtonElement>('chat-close');
const chatLog = element<HTMLDivElement>('chat-log');
const chatForm = element<HTMLFormElement>('chat-form');
const chatInput = element<HTMLInputElement>('chat-input');
const networkStatus = element<HTMLElement>('network-status');
const hudElements = {
  speed: element<HTMLElement>('speed'),
  street: element<HTMLElement>('street'),
  location: element<HTMLElement>('location-label'),
  status: element<HTMLElement>('status'),
};

let currentSettings: GameSettings = DEFAULT_GAME_SETTINGS;
let currentProfile: PlayerProfile | null = null;
let reportedDamage = 0;
let nextDamageReportAt = 0;
let pendingMissionAction = '';
let pendingMissionActionUntil = 0;

let locationLabel = FALLBACK_LOCATION_LABEL;
let startingLocation: LonLat = { ...FALLBACK_LOCATION };
let statusMessage = 'Starting 3D driving world…';
let streetName: string | null = null;
let lastFrameAt = performance.now();
let accumulator = 0;
let nextChunkUpdateAt = 0;
let nextStreetQueryAt = 0;
let searchTimer = 0;
let locationRequestInFlight = false;
let elapsedSeconds = 0;
let runtime: WorldRuntime | null = null;
let multiplayer: MultiplayerClient | null = null;
const ambientWorldStore = new AmbientWorldStore();
let pendingRouteId: number | null = null;
let pendingRouteLabel = '';
const remotePlayerStore = new RemotePlayerStore();
let frameRequestId = 0;
const progressStore = new ProgressStore();
const gameMap = new GameMap(
  element('minimap'),
  () => {
    if (statusMessage === 'Starting 3D driving world…') {
      statusMessage = 'WASD / arrows drive · Space handbrake · C camera · F3 debug';
    }
    const current = readGameState();
    const player = current.cars[0];
    gameMap.follow(
      localMetersToLonLat(player.position, current.origin),
      degreesFromRadians(player.headingRadians),
    );
  },
  (message) => {
    mapError.textContent = message;
    mapError.hidden = false;
  },
);
const controls = new InputController(element('joystick'), element('joystick-knob'));
const vehicleAudio = new VehicleAudio();
const gameMenu = new GameMenu(
  element('game-menu'),
  element<HTMLButtonElement>('game-menu-toggle'),
  currentSettings,
  {
    requestMissions: () => multiplayer?.requestMissions(),
    missionAction: (action, missionId) => multiplayer?.sendMissionAction(action, missionId),
    garageAction: (action, vehicleId) => multiplayer?.sendGarageAction(action, vehicleId),
    respawn: respawnPlayer,
    requestLeaderboard: (raceId) => multiplayer?.requestLeaderboard(raceId),
    publishRace: publishCommunityRace,
    getCarPosition: () => {
      const state = readGameState();
      const car = state.cars[0];
      return car ? localMetersToLonLat(car.position, state.origin) : null;
    },
    saveSettings: applySettings,
  },
);
controls.setMode(currentSettings.controlMode);
void progressStore.loadProfile().then((profile) => {
  if (!profile || currentProfile) return;
  currentProfile = profile;
  gameMenu.setProfile(profile);
});

void progressStore.loadSettings().then((settings) => applySettings(settings, true));
masterVolume.value = String(vehicleAudio.volume);
updateAudioControls();
window.addEventListener('pointerdown', () => vehicleAudio.activate(), { once: true });
window.addEventListener('keydown', () => vehicleAudio.activate(), { once: true });
masterVolume.addEventListener('input', () => {
  applySettings({ ...currentSettings, audioVolume: Number(masterVolume.value) });
});
audioMute.addEventListener('click', () => {
  applySettings({ ...currentSettings, audioMuted: !vehicleAudio.muted });
});

function startAt(location: LonLat, label: string, status: string): void {
  const origin = {
    longitude: clamp(
      Number.isFinite(location.longitude) ? location.longitude : FALLBACK_LOCATION.longitude,
      -180,
      180,
    ),
    latitude: clamp(
      Number.isFinite(location.latitude) ? location.latitude : FALLBACK_LOCATION.latitude,
      -85,
      85,
    ),
  };
  resetGameState(origin);
  startingLocation = { ...origin };

  if (runtime) publishPlayerCar(runtime.reset(origin));
  locationLabel = label;
  statusMessage = status;
  streetName = null;
  nextChunkUpdateAt = 0;
  nextStreetQueryAt = 0;
  accumulator = 0;
  gameMap.follow(origin, 0);
  ambientWorldStore.clear();
  worldStatus.textContent = 'Loading real OpenStreetMap roads…';
  pendingRouteId = null;
  runtime?.setRoute(null);
  gameMap.setRoute(null);
  routeStatus.textContent = 'Enter a place to plan a route.';
  if (currentProfile?.activeMission) renderActiveMission();

  multiplayer?.relocate();
}

function respawnPlayer(): void {
  if (!runtime) {
    gameMenu.setStatus('The world is still loading.');
    return;
  }
  startAt(startingLocation, locationLabel, 'Respawned at your starting area');
  gameMenu.setStatus('Respawned. Vehicle damage remains until repaired.');
}

function requestLocation(): void {
  if (!('geolocation' in navigator) || locationRequestInFlight) {
    if (!('geolocation' in navigator)) statusMessage = 'Location unavailable — search for a city';
    return;
  }
  locationRequestInFlight = true;
  statusMessage = 'Waiting for location permission…';
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      locationRequestInFlight = false;
      startAt(
        { longitude: coords.longitude, latitude: coords.latitude },
        'Your location',
        'Location found — loading nearby streets',
      );
    },
    (error) => {
      locationRequestInFlight = false;
      statusMessage =
        error.code === error.PERMISSION_DENIED
          ? 'Location permission denied — search for a city'
          : 'Location unavailable — search for a city';
    },
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
  );
}

cityForm.addEventListener('submit', (event) => {
  event.preventDefault();
  window.clearTimeout(searchTimer);
  const query = cityQuery.value.trim();
  if (query.length < 3) {
    searchMessage.textContent = 'Enter at least 3 characters.';
    return;
  }
  searchMessage.textContent = 'Searching…';
  searchTimer = window.setTimeout(() => {
    void searchCity(query)
      .then((place) => {
        if (!place) {
          searchMessage.textContent = 'No matching place found.';
          return;
        }
        startAt(
          place.location,
          place.label.split(',').slice(0, 2).join(', '),
          'City loaded — streaming the 3D world',
        );
        searchMessage.textContent = '';
      })
      .catch(() => {
        searchMessage.textContent =
          'Place search is unavailable. The current location is unchanged.';
      });
  }, 550);
});

routeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = routeQuery.value.trim();
  if (query.length < 3) {
    routeStatus.textContent = 'Enter at least three characters for a destination.';
    return;
  }
  pendingRouteId = null;
  pendingRouteLabel = '';
  runtime?.setRoute(null);
  gameMap.setRoute(null);
  routeStatus.textContent = 'Looking up destination…';
  void searchCity(query)
    .then((place) => {
      if (!place) {
        routeStatus.textContent = 'No matching destination found.';
        return;
      }
      const requestId = multiplayer?.requestRoute(place.location);
      if (requestId === null || requestId === undefined) {
        routeStatus.textContent = 'Connect to the game server to plan a route.';
        return;
      }
      pendingRouteId = requestId;
      pendingRouteLabel = place.label.split(',').slice(0, 2).join(', ');
      routeStatus.textContent = `Finding a road route to ${pendingRouteLabel}…`;
    })
    .catch(() => {
      routeStatus.textContent = 'Place search is unavailable. Try again shortly.';
    });
});

routeClear.addEventListener('click', () => {
  pendingRouteId = null;
  if (currentProfile?.activeMission) {
    renderActiveMission();
    routeStatus.textContent = 'The active mission route cannot be cleared.';
    return;
  }
  runtime?.setRoute(null);
  gameMap.setRoute(null);
  routeStatus.textContent = 'Route cleared.';
});

locationButton.addEventListener('click', requestLocation);
cameraButton.addEventListener('click', toggleCameraMode);
window.addEventListener('keydown', (event) => {
  if (event.repeat) return;
  if (event.code === 'F3') {
    event.preventDefault();
    runtime?.toggleDebug();
    return;
  }
  if (event.code !== 'KeyC') return;
  if (
    event.target instanceof HTMLElement &&
    event.target.closest('input, textarea, select, [contenteditable="true"]')
  ) {
    return;
  }
  event.preventDefault();
  toggleCameraMode();
});

function toggleCameraMode(): void {
  const mode = runtime?.toggleCameraMode();
  if (!mode) return;
  const hood = mode === 'hood';
  cameraButton.textContent = hood ? 'Chase view' : 'Hood view';
  cameraButton.setAttribute('aria-pressed', String(hood));
  cameraButton.setAttribute('aria-label', `Switch to ${hood ? 'chase' : 'hood'} camera`);
}

chatToggle.addEventListener('click', () => {
  chatPanel.hidden = !chatPanel.hidden;
  chatToggle.setAttribute('aria-expanded', String(!chatPanel.hidden));
  if (!chatPanel.hidden) chatInput.focus();
});

chatClose.addEventListener('click', () => {
  chatPanel.hidden = true;
  chatToggle.setAttribute('aria-expanded', 'false');
});

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!multiplayer?.sendChat(chatInput.value)) {
    networkStatus.textContent = 'Connect to nearby drivers before chatting.';
    return;
  }
  chatInput.value = '';
});

function connectMultiplayer(): void {
  multiplayer = new MultiplayerClient(defaultMultiplayerUrl(), getOrCreateHandle(), {
    getCar: networkCarState,
    onRoster: (players, receivedAt) => {
      remotePlayerStore.setRoster(players, receivedAt);
      updateNearbyCount();
      if (!chatLog.children.length) setChatEmpty();
    },
    onPlayerState: (player, receivedAt) => remotePlayerStore.push(player, receivedAt),
    onPlayerLeft: (playerId) => {
      remotePlayerStore.remove(playerId);
      updateNearbyCount();
      if (!remotePlayerStore.size && !chatLog.querySelector('.chat-line')) setChatEmpty();
    },
    onWorld: (snapshot, receivedAt) => {
      ambientWorldStore.push(snapshot, receivedAt);
      worldStatus.textContent = describeWorld(snapshot);
    },
    onRoute: handleRouteResult,
    onProfile: applyProfile,
    onMissions: (offers, activeMission) => {
      gameMenu.setOffers(offers, activeMission);
    },
    onLeaderboard: (snapshot) => gameMenu.setLeaderboard(snapshot),
    onRaceCreated: (offer) => {
      gameMenu.setStatus(`Published ${offer.title}. Nearby players can now find it.`);
    },
    onChat: (message) => appendChatLine(message.handle, message.text),
    onStatus: (message) => {
      networkStatus.textContent = message;
      gameMenu.setStatus(message);
      if (/offline|failed|connecting/iu.test(message)) {
        ambientWorldStore.clear();
        runtime?.setWorldSnapshot(ambientWorldStore.sample());
        worldStatus.textContent = 'World traffic sync paused.';
      }
    },
  });
}

function networkCarState(): NetworkCarState {
  const state = readGameState();
  const car = state.cars[0];
  return {
    vehicleId: car.vehicleId ?? 'sedan',
    position: localMetersToLonLat(car.position, state.origin),
    altitudeMeters: car.altitudeMeters,
    velocity: {
      eastMetersPerSecond: car.velocity.x,
      northMetersPerSecond: car.velocity.y,
      upMetersPerSecond: car.verticalVelocityMetersPerSecond,
    },
    headingRadians: car.headingRadians,
    speedMetersPerSecond: car.speedMetersPerSecond,
  };
}

function applyProfile(profile: PlayerProfile): void {
  const previousMissionId = currentProfile?.activeMission?.offer.id;
  currentProfile = profile;
  gameMenu.setProfile(profile);
  void progressStore.saveProfile(profile);
  reportedDamage = profile.damage;
  if (previousMissionId !== profile.activeMission?.offer.id) {
    pendingMissionAction = '';
  }
  if (runtime) {
    const currentVehicleId = readGameState().cars[0].vehicleId ?? 'sedan';
    if (currentVehicleId !== profile.selectedVehicleId) {
      publishPlayerCar(runtime.selectVehicle(profile.selectedVehicleId));
    }
    const currentDamage = readGameState().cars[0].damage ?? 0;
    if (currentDamage !== profile.damage) publishPlayerCar(runtime.setDamage(profile.damage));
  }
  if (profile.activeMission) {
    renderActiveMission();
  } else if (previousMissionId) {
    runtime?.setRoute(null);
    runtime?.setMissionMarkers([]);
    gameMap.setRoute(null);
  }
}

function renderActiveMission(): void {
  const active = currentProfile?.activeMission;
  if (!active) return;
  const { offer } = active;
  const route = active.startedAtMs === null ? [offer.pickup.location, ...offer.route] : offer.route;
  const markers: MissionMarker[] = [];
  if (active.startedAtMs === null) {
    markers.push({ location: offer.pickup.location, kind: 'pickup', active: true });
  }
  offer.checkpoints.forEach((location, index) => {
    if (index < active.nextCheckpointIndex) return;
    markers.push({
      location,
      kind: 'checkpoint',
      active: index === active.nextCheckpointIndex,
    });
  });
  markers.push({
    location: offer.destination.location,
    kind: 'destination',
    active: active.startedAtMs !== null && active.nextCheckpointIndex >= offer.checkpoints.length,
  });
  runtime?.setRoute(route);
  runtime?.setMissionMarkers(markers);
  gameMap.setRoute(route);
}

function updateMissionProgress(location: LonLat, now: number): void {
  const mission = currentProfile?.activeMission;
  if (!mission || !multiplayer) {
    pendingMissionAction = '';
    return;
  }
  let action: 'start' | 'checkpoint' | 'complete';
  let checkpointIndex: number | undefined;
  let target: LonLat;
  let radius: number;
  if (mission.startedAtMs === null) {
    action = 'start';
    target = mission.offer.pickup.location;
    radius = 45;
  } else if (mission.nextCheckpointIndex < mission.offer.checkpoints.length) {
    action = 'checkpoint';
    checkpointIndex = mission.nextCheckpointIndex;
    target = mission.offer.checkpoints[checkpointIndex]!;
    radius = 55;
  } else {
    action = 'complete';
    target = mission.offer.destination.location;
    radius = 45;
  }
  const key = `${mission.offer.id}:${action}:${checkpointIndex ?? ''}`;
  if (haversineMeters(location, target) > radius) {
    if (pendingMissionAction === key && now >= pendingMissionActionUntil) pendingMissionAction = '';
    return;
  }
  if (pendingMissionAction === key && now < pendingMissionActionUntil) return;
  multiplayer.sendMissionAction(action, mission.offer.id, checkpointIndex);
  pendingMissionAction = key;
  pendingMissionActionUntil = now + 1_500;
}

function publishCommunityRace(
  title: string,
  destinationQuery: string,
  waypoints?: readonly LonLat[],
): void {
  if (!multiplayer) {
    gameMenu.setStatus('Connect to the game server before publishing a race.');
    return;
  }
  if (waypoints?.length) {
    const finish = waypoints.at(-1)!;
    if (!multiplayer.publishRace(title, finish, waypoints)) {
      gameMenu.setStatus('Connect to the game server before publishing a race.');
      return;
    }
    gameMenu.setStatus('Planning a road route through your checkpoints…');
    return;
  }
  gameMenu.setStatus('Looking up the race destination…');
  void searchCity(destinationQuery)
    .then((place) => {
      if (!place) {
        gameMenu.setStatus('No matching destination found.');
        return;
      }
      if (!multiplayer?.publishRace(title, place.location)) {
        gameMenu.setStatus('Connect to the game server before publishing a race.');
        return;
      }
      gameMenu.setStatus('Planning a road route for your race…');
    })
    .catch(() => gameMenu.setStatus('Place search is unavailable. Try again shortly.'));
}

function handleRouteResult(result: RouteResult | RouteFailure): void {
  if (result.requestId !== pendingRouteId) return;
  pendingRouteId = null;
  if (!result.ok) {
    routeStatus.textContent = result.message;
    return;
  }
  runtime?.setRoute(result.points);
  gameMap.setRoute(result.points);
  const distance =
    result.distanceMeters < 1_000
      ? `${Math.round(result.distanceMeters)} m`
      : `${(result.distanceMeters / 1_000).toFixed(1)} km`;
  const minutes = Math.max(1, Math.round(result.travelTimeSeconds / 60));
  routeStatus.textContent = `${pendingRouteLabel}: ${distance} · about ${minutes} min`;
}

function describeWorld(snapshot: WorldSnapshot): string {
  if (snapshot.status === 'loading') return 'Loading real OpenStreetMap roads…';
  if (snapshot.status === 'unavailable') return 'OpenStreetMap data unavailable — retrying';
  const cars = snapshot.actors.filter((actor) => actor.kind === 'vehicle').length;
  const pedestrians = snapshot.actors.length - cars;
  const signals = snapshot.controls.filter((control) => control.kind === 'traffic-signal').length;
  return `${cars} traffic · ${pedestrians} pedestrians · ${signals} signals`;
}

function appendChatLine(handle: string, text: string): void {
  chatLog.querySelector('.chat-empty')?.remove();
  const line = document.createElement('div');
  line.className = 'chat-line';
  const name = document.createElement('strong');
  name.textContent = handle;
  const message = document.createElement('span');
  message.textContent = ` ${text}`;
  line.append(name, message);
  chatLog.append(line);
  while (chatLog.children.length > 20) chatLog.firstElementChild?.remove();
  chatLog.scrollTop = chatLog.scrollHeight;
}

function setChatEmpty(): void {
  if (chatLog.children.length) return;
  const empty = document.createElement('div');
  empty.className = 'chat-empty';
  empty.textContent = 'No nearby drivers yet.';
  chatLog.append(empty);
}

function updateNearbyCount(): void {
  nearbyCount.textContent = String(remotePlayerStore.size);
}

function updateAudioControls(): void {
  const isMuted = vehicleAudio.muted;
  audioMute.textContent = isMuted ? 'Unmute' : 'Mute';
  audioMute.setAttribute('aria-label', isMuted ? 'Unmute sound' : 'Mute sound');
  audioMute.setAttribute('aria-pressed', String(isMuted));
  masterVolume.value = String(vehicleAudio.volume);
  volumeValue.value = `${Math.round(vehicleAudio.volume * 100)}%`;
  volumeValue.textContent = volumeValue.value;
}

function applySettings(settings: GameSettings, refreshMenu = false): void {
  currentSettings = settings;
  controls.setMode(settings.controlMode);
  vehicleAudio.setVolume(settings.audioVolume);
  vehicleAudio.setMuted(settings.audioMuted);
  runtime?.setGraphicsQuality(settings.graphicsQuality);
  document.documentElement.lang = settings.language;
  updateAudioControls();
  if (refreshMenu) gameMenu.setSettings(settings);
  void progressStore.saveSettings(settings);
}

async function initializeWorld(): Promise<void> {
  try {
    const mods = await loadVehicleMods().catch(() => []);
    if (mods.length) {
      gameMenu.refresh();
      gameMenu.setStatus(`${mods.length} local vehicle mod${mods.length === 1 ? '' : 's'} loaded.`);
    }
    const { WorldRuntime } = await import('./world-runtime');
    runtime = await WorldRuntime.create(
      element('world'),
      playerLabelLayer,
      debugOverlay,
      readGameState().origin,
      (message) => {
        statusMessage = message;
      },
    );
    publishPlayerCar(runtime.reset(readGameState().origin));
    if (currentProfile?.activeMission) renderActiveMission();
    statusMessage = 'Physics ready — streaming nearby streets';
    connectMultiplayer();
    setChatEmpty();
  } catch (error) {
    statusMessage = '3D world could not start in this browser';
    mapError.textContent =
      error instanceof Error ? error.message : 'WebAssembly or WebGL is unavailable.';
    mapError.hidden = false;
  }
}

function frame(now: number): void {
  const delta = clamp((now - lastFrameAt) / 1_000, 0, MAX_FRAME_DELTA_SECONDS);
  lastFrameAt = now;
  elapsedSeconds += delta;
  const frameInput = controls.read();
  if (runtime) {
    accumulator = Math.min(accumulator + delta, MAX_FRAME_DELTA_SECONDS);
    while (accumulator >= FIXED_TIME_STEP_SECONDS) {
      const car = runtime.step(frameInput, FIXED_TIME_STEP_SECONDS);
      publishPlayerCar(car);
      const current = readGameState();
      if (Math.hypot(car.position.x, car.position.y) >= FLOATING_ORIGIN_REBASE_METERS) {
        const nextOrigin = localMetersToLonLat(car.position, current.origin);
        const shift = rebaseGameState(nextOrigin);
        runtime.shiftOrigin(shift, nextOrigin);
      }
      accumulator -= FIXED_TIME_STEP_SECONDS;
    }
  } else {
    accumulator = 0;
  }

  const current = readGameState();
  const player = current.cars[0];
  const location = localMetersToLonLat(player.position, current.origin);
  vehicleAudio.update(player, frameInput);
  if (multiplayer && (player.damage ?? 0) > reportedDamage && now >= nextDamageReportAt) {
    multiplayer.sendDamageReport(player.damage ?? 0);
    reportedDamage = player.damage ?? 0;
    nextDamageReportAt = now + 1_000;
  }
  updateMissionProgress(location, now);

  if (gameMap.isLoaded()) {
    if (now >= nextStreetQueryAt) {
      streetName = gameMap.streetNameNear(location);
      nextStreetQueryAt = now + STREET_QUERY_INTERVAL_MS;
    }
    gameMap.follow(location, degreesFromRadians(player.headingRadians));
  }
  if (runtime && now >= nextChunkUpdateAt) {
    runtime.updateChunks(location);
    nextChunkUpdateAt = now + CHUNK_UPDATE_INTERVAL_MS;
  }

  runtime?.setWorldSnapshot(ambientWorldStore.sample(now));
  runtime?.render(current, elapsedSeconds, delta, remotePlayerStore.sample(now));
  renderHud(hudElements, {
    speedMetersPerSecond: player.speedMetersPerSecond,
    streetName,
    locationLabel,
    statusMessage,
  });
  frameRequestId = requestAnimationFrame(frame);
}

void initializeWorld();
requestLocation();
frameRequestId = requestAnimationFrame(frame);
window.addEventListener('beforeunload', () => {
  cancelAnimationFrame(frameRequestId);
  controls.destroy();
  multiplayer?.dispose();
  vehicleAudio.destroy();
  runtime?.dispose();
});

function degreesFromRadians(radians: number): number {
  return (radians * 180) / Math.PI;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : 0;
}
