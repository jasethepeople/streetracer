import type {
  CarState,
  GameState,
  LonLat,
  PlayerInput,
  Point2,
  PoliceUnitState,
  WorldSnapshot,
} from '@openstreet-racer/shared';
import { lonLatToLocalMeters, tileCellAt, WORLD_TILE_ZOOM } from '@openstreet-racer/world';
import type { WorldFeature } from '@openstreet-racer/world';
import type { RapierVehicle, TractionState } from '@openstreet-racer/vehicle/rapier';
import { ChunkStreamer } from './chunk-streamer';
import type { MissionMarker, WorldRenderer } from './world-renderer';
import type { RemotePlayerRenderState } from './remote-player-store';

export class WorldRuntime {
  private readonly chunks: ChunkStreamer;
  private origin: LonLat;
  private playerMoved = false;
  private spawnAligned = false;
  private centerFeatures: readonly WorldFeature[] | null = null;
  private worldSnapshot: WorldSnapshot | null = null;

  private constructor(
    private readonly renderer: WorldRenderer,
    private readonly vehicle: RapierVehicle,
    origin: LonLat,
    private readonly onStatus: (message: string) => void,
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

  /** Wheelspin/slide state of the player car for smoke, screech, and HUD hooks. */
  tractionState(): TractionState {
    return this.vehicle.traction();
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
    if (!this.spawnAligned) this.tryAlignSpawn(this.onStatus);
  }

  reset(origin: LonLat): CarState {
    this.origin = { ...origin };
    this.playerMoved = false;
    this.spawnAligned = false;
    this.centerFeatures = null;
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
    this.renderer.render(
      state,
      elapsedSeconds,
      deltaSeconds,
      remotePlayers,
      this.vehicle.traction(),
    );
  }

  private alignSpawnToCenterRoad(
    cellKey: string,
    features: readonly WorldFeature[],
    onStatus: (message: string) => void,
  ): void {
    if (this.spawnAligned || cellKey !== tileCellAt(this.origin, WORLD_TILE_ZOOM).key) return;
    // Cache the center-cell features so alignment can be retried until a
    // building-clear spawn is found (a later chunk may add missing roads).
    this.centerFeatures = features;
    this.tryAlignSpawn(onStatus);
  }

  private tryAlignSpawn(onStatus: (message: string) => void): void {
    if (this.spawnAligned) return;
    // A player who pressed a control before the streets loaded is still
    // aligned as long as they have not actually driven away — otherwise a
    // car stuck inside a streamed-in building collider would never escape.
    const spawn = planSpawnAlignment({
      centerFeatures: this.centerFeatures,
      origin: this.origin,
      pose: this.vehicle.snapshot(),
      playerMoved: this.playerMoved,
    });
    if (!spawn) return;
    this.vehicle.placeAt(spawn.point, spawn.headingRadians);
    this.spawnAligned = true;
    this.centerFeatures = null;
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

export function worldRoadLines(features: readonly WorldFeature[], origin: LonLat): Point2[][] {
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

const SPAWN_SAMPLE_STEP_METERS = 4;
export const SPAWN_BUILDING_CLEARANCE_METERS = 3.5;
const SPAWN_ALIGN_MAX_DISTANCE_METERS = 150;
const SPAWN_ALIGN_MOVED_AWAY_METERS = 40;
const SPAWN_ALIGN_MOVED_AWAY_SPEED_MPS = 2;

export interface ClearRoadSpawn {
  point: Point2;
  headingRadians: number;
  distanceMeters: number;
}

export interface SpawnAlignmentInput {
  /** Center-cell features; null until the center chunk has streamed in. */
  readonly centerFeatures: readonly WorldFeature[] | null;
  readonly origin: LonLat;
  readonly pose: {
    readonly position: Point2;
    readonly speedMetersPerSecond: number;
  };
  readonly playerMoved: boolean;
}

/**
 * Pure spawn-alignment decision: returns the nearest building-clear road
 * spawn for a player still sitting near the raw origin, or null when
 * alignment must not (yet) happen — no center features, every candidate
 * blocked by buildings (callers retry as more chunks stream in), or the
 * player has already driven away.
 */
export function planSpawnAlignment(input: SpawnAlignmentInput): ClearRoadSpawn | null {
  if (!input.centerFeatures) return null;
  const movedAway =
    Math.hypot(input.pose.position.x, input.pose.position.y) > SPAWN_ALIGN_MOVED_AWAY_METERS ||
    Math.abs(input.pose.speedMetersPerSecond) > SPAWN_ALIGN_MOVED_AWAY_SPEED_MPS;
  if (input.playerMoved && movedAway) return null;
  const lines = worldRoadLines(input.centerFeatures, input.origin);
  const buildings = worldBuildingRings(input.centerFeatures, input.origin);
  return nearestClearRoadSpawn(
    { x: 0, y: 0 },
    lines,
    buildings,
    0,
    SPAWN_ALIGN_MAX_DISTANCE_METERS,
  );
}

export function worldBuildingRings(features: readonly WorldFeature[], origin: LonLat): Point2[][] {
  const rings: Point2[][] = [];
  for (const feature of features) {
    if (feature.layer !== 'building') continue;
    const geometry = feature.geometry;
    const polygons =
      geometry.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry.type === 'MultiPolygon'
          ? geometry.coordinates
          : [];
    for (const polygon of polygons) {
      for (const ring of polygon) {
        const points = ring.map(([longitude, latitude]) =>
          lonLatToLocalMeters({ longitude, latitude }, origin),
        );
        if (points.length > 2) rings.push(points);
      }
    }
  }
  return rings;
}

/**
 * Finds the nearest road spawn that is not inside or tight against a building.
 * Spawning on a bare road centerline can still leave the chassis embedded in a
 * building collider (bad OSM overlap), which blocks forward motion; sampled
 * candidates are rejected unless a car-sized footprint clears every building.
 */
export function nearestClearRoadSpawn(
  position: Point2,
  lines: readonly (readonly Point2[])[],
  buildings: readonly (readonly Point2[])[],
  preferredHeading = 0,
  maximumDistanceMeters = Number.POSITIVE_INFINITY,
): ClearRoadSpawn | null {
  let nearest: ClearRoadSpawn | null = null;
  for (const line of lines) {
    for (let index = 1; index < line.length; index += 1) {
      const start = line[index - 1];
      const end = line[index];
      const segmentX = end.x - start.x;
      const segmentY = end.y - start.y;
      const segmentLength = Math.hypot(segmentX, segmentY);
      if (segmentLength === 0) continue;
      const samples = Math.max(1, Math.ceil(segmentLength / SPAWN_SAMPLE_STEP_METERS));
      const forward = Math.atan2(segmentX, segmentY);
      for (let sample = 0; sample <= samples; sample += 1) {
        const fraction = sample / samples;
        const point = { x: start.x + fraction * segmentX, y: start.y + fraction * segmentY };
        const distanceMeters = Math.hypot(position.x - point.x, position.y - point.y);
        if (distanceMeters > maximumDistanceMeters) continue;
        if (nearest && distanceMeters >= nearest.distanceMeters) continue;
        if (buildingClearanceMeters(point, buildings) < SPAWN_BUILDING_CLEARANCE_METERS) continue;
        nearest = { point, headingRadians: forward, distanceMeters };
      }
    }
  }
  if (!nearest) return null;
  const reverse = nearest.headingRadians + Math.PI;
  const forwardDistance = angleDistance(nearest.headingRadians, preferredHeading);
  const reverseDistance = angleDistance(reverse, preferredHeading);
  return reverseDistance < forwardDistance ? { ...nearest, headingRadians: reverse } : nearest;
}

export function buildingClearanceMeters(
  point: Point2,
  rings: readonly (readonly Point2[])[],
): number {
  let clearance = Number.POSITIVE_INFINITY;
  for (const ring of rings) {
    if (pointInRing(point, ring)) return 0;
    for (let index = 0; index < ring.length; index += 1) {
      const start = ring[index];
      const end = ring[(index + 1) % ring.length];
      const distance = distanceToSegment(point, start, end);
      if (distance < clearance) clearance = distance;
    }
  }
  return clearance;
}

export function pointInRing(point: Point2, ring: readonly Point2[]): boolean {
  let inside = false;
  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index, index += 1
  ) {
    const a = ring[index];
    const b = ring[previous];
    if (a.y > point.y !== b.y > point.y) {
      const crossingX = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
      if (point.x < crossingX) inside = !inside;
    }
  }
  return inside;
}

function distanceToSegment(point: Point2, start: Point2, end: Point2): number {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const lengthSquared = segmentX * segmentX + segmentY * segmentY;
  const fraction =
    lengthSquared === 0
      ? 0
      : clamp(
          ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) / lengthSquared,
          0,
          1,
        );
  return Math.hypot(
    point.x - (start.x + fraction * segmentX),
    point.y - (start.y + fraction * segmentY),
  );
}

function angleDistance(first: number, second: number): number {
  const difference = Math.abs(normalizeRadians(first) - normalizeRadians(second));
  return Math.min(difference, 2 * Math.PI - difference);
}

function normalizeRadians(angle: number): number {
  const fullTurn = 2 * Math.PI;
  return ((angle % fullTurn) + fullTurn) % fullTurn;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
