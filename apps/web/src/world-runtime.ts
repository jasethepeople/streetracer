import type {
  CarState,
  GameState,
  LonLat,
  PlayerInput,
  Point2,
  PoliceUnitState,
  WorldSnapshot,
} from '@openstreet-racer/shared';
import {
  nearestRoadSpawn,
  lonLatToLocalMeters,
  tileCellAt,
  WORLD_TILE_ZOOM,
} from '@openstreet-racer/world';
import type { WorldFeature } from '@openstreet-racer/world';
import type { RapierVehicle } from '@openstreet-racer/vehicle/rapier';
import { ChunkStreamer } from './chunk-streamer';
import type { MissionMarker, WorldRenderer } from './world-renderer';
import type { RemotePlayerRenderState } from './remote-player-store';

export class WorldRuntime {
  private readonly chunks: ChunkStreamer;
  private origin: LonLat;
  private playerMoved = false;
  private spawnAligned = false;
  private worldSnapshot: WorldSnapshot | null = null;

  private constructor(
    private readonly renderer: WorldRenderer,
    private readonly vehicle: RapierVehicle,
    origin: LonLat,
    onStatus: (message: string) => void,
  ) {
    this.origin = { ...origin };
    this.chunks = new ChunkStreamer(renderer, vehicle, onStatus, (cell, features) => {
      this.alignSpawnToCenterRoad(cell.key, features, onStatus);
    });
  }

  static async create(
    worldElement: HTMLElement,
    playerLabelLayer: HTMLElement,
    debugOverlay: HTMLElement,
    origin: LonLat,
    onStatus: (message: string) => void,
  ): Promise<WorldRuntime> {
    let renderer: WorldRenderer | undefined;
    let vehicle: RapierVehicle | undefined;
    try {
      const [{ RapierVehicle }, { WorldRenderer }] = await Promise.all([
        import('@openstreet-racer/vehicle/rapier'),
        import('./world-renderer'),
      ]);
      renderer = new WorldRenderer(worldElement, playerLabelLayer, debugOverlay);
      vehicle = await RapierVehicle.create(origin);
      const runtime = new WorldRuntime(renderer, vehicle, origin, onStatus);
      return runtime;
    } catch (error) {
      vehicle?.dispose();
      renderer?.dispose();
      throw error;
    }
  }

  step(input: PlayerInput, deltaSeconds: number): CarState {
    if (Math.abs(input.steer) > 0.05 || input.throttle > 0.05 || input.brake > 0.05) {
      this.playerMoved = true;
    }
    return this.vehicle.step(input, deltaSeconds);
  }

  snapshot(): CarState {
    return this.vehicle.snapshot();
  }
  selectVehicle(vehicleId: string): CarState {
    return this.vehicle.switchVehicle(vehicleId);
  }

  setDamage(damage: number): CarState {
    this.vehicle.setDamage(damage);
    return this.vehicle.snapshot();
  }

  repair(): CarState {
    return this.vehicle.repair();
  }

  setImpactHandler(handler: ((impactMetersPerSecond: number) => void) | null): void {
    this.vehicle.onImpact = handler;
  }

  updatePursuit(police: readonly PoliceUnitState[], origin: LonLat, wantedLevel: number): void {
    this.renderer.updatePursuit(police, origin, wantedLevel);
  }

  triggerExplosion(): void {
    this.renderer.triggerExplosion();
  }

  setGraphicsQuality(quality: 'low' | 'medium' | 'high'): void {
    this.renderer.setGraphicsQuality(quality);
  }

  setWorldSnapshot(snapshot: WorldSnapshot): void {
    this.worldSnapshot = snapshot;
  }

  setRoute(points: readonly LonLat[] | null): void {
    this.renderer.setRoute(points);
  }

  setMissionMarkers(markers: readonly MissionMarker[]): void {
    this.renderer.setMissionMarkers(markers);
  }

  updateChunks(location: LonLat): void {
    this.chunks.update(location);
  }

  reset(origin: LonLat): CarState {
    this.origin = { ...origin };
    this.playerMoved = false;
    this.spawnAligned = false;
    this.chunks.reset();
    this.vehicle.reset(origin);
    this.renderer.reset(origin);
    this.worldSnapshot = null;
    this.renderer.setRoute(null);
    this.renderer.setMissionMarkers([]);
    this.updateChunks(origin);
    return this.vehicle.snapshot();
  }

  shiftOrigin(shift: Point2, nextOrigin: LonLat): void {
    this.origin = { ...nextOrigin };
    this.vehicle.shiftOrigin(shift, nextOrigin);
    this.renderer.shiftOrigin(shift, nextOrigin);
  }

  render(
    state: Readonly<GameState>,
    elapsedSeconds: number,
    deltaSeconds: number,
    remotePlayers: readonly RemotePlayerRenderState[] = [],
  ): void {
    const stats = this.chunks.getStats();
    this.renderer.setStreamStats(stats, this.vehicle.chunkCount);
    this.renderer.updateAmbientWorld(this.worldSnapshot, state.origin);
    this.renderer.render(state, elapsedSeconds, deltaSeconds, remotePlayers);
  }

  private alignSpawnToCenterRoad(
    cellKey: string,
    features: readonly WorldFeature[],
    onStatus: (message: string) => void,
  ): void {
    if (
      this.spawnAligned ||
      this.playerMoved ||
      cellKey !== tileCellAt(this.origin, WORLD_TILE_ZOOM).key
    ) {
      return;
    }
    const lines = worldRoadLines(features, this.origin);
    const spawn = nearestRoadSpawn({ x: 0, y: 0 }, lines, 0, 150);
    if (!spawn) return;
    this.vehicle.placeAt(spawn.point, spawn.headingRadians);
    this.spawnAligned = true;
    onStatus('Started on a nearby street · real roads loaded');
  }

  toggleDebug(): void {
    this.rendererDebugVisible = !this.rendererDebugVisible;
    this.renderer.setDebugVisible(this.rendererDebugVisible);
  }

  toggleCameraMode(): 'chase' | 'hood' {
    return this.renderer.toggleCameraMode();
  }

  dispose(): void {
    this.chunks.dispose();
    this.vehicle.dispose();
    this.renderer.dispose();
  }

  private rendererDebugVisible = false;
}

function worldRoadLines(features: readonly WorldFeature[], origin: LonLat): Point2[][] {
  const lines: Point2[][] = [];
  for (const feature of features) {
    if (feature.layer !== 'transportation') continue;
    const geometry = feature.geometry;
    const paths =
      geometry.type === 'LineString'
        ? [geometry.coordinates]
        : geometry.type === 'MultiLineString'
          ? geometry.coordinates
          : [];
    for (const path of paths) {
      const points = path.map(([longitude, latitude]) =>
        lonLatToLocalMeters({ longitude, latitude }, origin),
      );
      if (points.length > 1) lines.push(points);
    }
  }
  return lines;
}
