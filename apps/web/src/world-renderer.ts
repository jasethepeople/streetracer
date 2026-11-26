import * as THREE from 'three';
import {
  MAX_WORLD_ACTORS,
  MAX_WORLD_CONTROLS,
  type AmbientActorState,
  type GameState,
  type LonLat,
  type PoliceUnitState,
  type TrafficControlSnapshot,
  type WorldSnapshot,
} from '@openstreet-racer/shared';
import type { ChunkGeometry, TileCell } from '@openstreet-racer/world';
import { lonLatToLocalMeters } from '@openstreet-racer/world';
import { getVehicleDefinition, type VehicleDefinition } from '@openstreet-racer/vehicle/catalog';
import type { TractionState } from '@openstreet-racer/vehicle/rapier';
import type { ChunkSink } from './chunk-streamer';
import type { RemotePlayerRenderState } from './remote-player-store';

interface RenderChunk {
  cell: TileCell;
  group: THREE.Group;
}

interface RemoteCarView {
  readonly group: THREE.Group;
  readonly label: HTMLDivElement;
  handle: string;
  vehicleId: string;
}

interface AmbientActorView {
  readonly group: THREE.Group;
  readonly kind: AmbientActorState['kind'];
}

interface TrafficControlView {
  readonly group: THREE.Group;
  readonly lamps: readonly THREE.Mesh[];
  readonly kind: TrafficControlSnapshot['kind'];
}

export interface StreamStats {
  active: number;
  loading: number;
  queued: number;
}

export interface MissionMarker {
  readonly location: Readonly<LonLat>;
  readonly kind: 'pickup' | 'checkpoint' | 'destination';
  readonly active: boolean;
}

interface PoliceCarView {
  readonly group: THREE.Group;
  readonly lightRed: THREE.MeshStandardMaterial;
  readonly lightBlue: THREE.MeshStandardMaterial;
  targetX: number;
  targetZ: number;
  heading: number;
}

interface MissionMarkerView {
  readonly group: THREE.Group;
  readonly location: Readonly<LonLat>;
}

interface PoliceCarView {
  readonly group: THREE.Group;
  readonly lightRed: THREE.MeshStandardMaterial;
  readonly lightBlue: THREE.MeshStandardMaterial;
  targetX: number;
  targetZ: number;
  heading: number;
}

// A single billboarded point sprite. All puffs share the fixed
// PointsMaterial size, so per-particle size is intentionally not tracked.
interface Puff {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  ageSeconds: number;
  lifetimeSeconds: number;
  color: THREE.Color;
}

const MAX_PIXEL_RATIO = 1.25;
const MAX_REMOTE_CARS = 48;
const REMOTE_CAR_DRAW_DISTANCE_METERS = 4_500;
const REMOTE_LABEL_DISTANCE_METERS = 1_800;
const AMBIENT_DRAW_DISTANCE_METERS = 2_200;
const TRAFFIC_CONTROL_DRAW_DISTANCE_METERS = 1_600;
const POLICE_LIGHT_FLASH_HZ = 2.4;
const MAX_SMOKE_PUFFS = 90;
const MAX_EXPLOSION_SPARKS = 60;
const SIREN_SIGHT_METERS = 1_000;
// Tire/engine smoke emission tuning (see planSmokeEmission / engineSmokeIntensity).
const BURNOUT_SMOKE_THRESHOLD = 0.12;
const SLIP_SMOKE_THRESHOLD = 0.28;
const DRIFT_SMOKE_THRESHOLD = 0.55;
const DRIFT_FRONT_INTENSITY_FACTOR = 0.7;
const ENGINE_SMOKE_DAMAGE_FLOOR = 65;
const ENGINE_SMOKE_DAMAGE_RANGE = 35;
const TIRE_SMOKE_PUFFS_PER_SECOND = 26;

const COLORS = {
  skyDay: new THREE.Color('#94c9e3'),
  skyNight: new THREE.Color('#091322'),
  ground: new THREE.MeshStandardMaterial({
    color: '#607f4f',
    roughness: 1,
    side: THREE.DoubleSide,
  }),
  road: new THREE.MeshStandardMaterial({
    color: '#30363a',
    roughness: 0.92,
    side: THREE.DoubleSide,
  }),
  markings: new THREE.MeshStandardMaterial({
    color: '#e7d27b',
    roughness: 0.8,
    side: THREE.DoubleSide,
  }),
  building: new THREE.MeshStandardMaterial({
    color: '#b6b1a8',
    roughness: 0.9,
    side: THREE.DoubleSide,
  }),
  green: new THREE.MeshStandardMaterial({ color: '#53704a', roughness: 1, side: THREE.DoubleSide }),
  water: new THREE.MeshStandardMaterial({
    color: '#287fa0',
    roughness: 0.65,
    side: THREE.DoubleSide,
  }),
};

/**
 * Surface-to-material bindings for streamed world chunks. Roads must stay on the
 * dark asphalt material while ground and green spaces stay on grass-green
 * materials; `WorldRenderer.addChunk` applies exactly this table.
 */
export const CHUNK_SURFACE_MATERIALS = [
  ['ground', () => COLORS.ground],
  ['greens', () => COLORS.green],
  ['waters', () => COLORS.water],
  ['roads', () => COLORS.road],
  ['markings', () => COLORS.markings],
  ['buildings', () => COLORS.building],
] as const;

export type ChunkSurfaceKey = (typeof CHUNK_SURFACE_MATERIALS)[number][0];

export interface TireSmokeSource {
  readonly axle: 'front' | 'rear';
  readonly intensity: number;
}

export interface SmokeEmissionPlan {
  readonly tires: readonly TireSmokeSource[];
  /** 0..1 engine smoke intensity derived from vehicle damage. */
  readonly engineIntensity: number;
}

/** 0..1 engine smoke intensity: nothing at damage <= 65, full smoke at 100. */
export function engineSmokeIntensity(damage: number): number {
  return clamp((damage - ENGINE_SMOKE_DAMAGE_FLOOR) / ENGINE_SMOKE_DAMAGE_RANGE, 0, 1);
}

/**
 * Pure, WebGL-free smoke decision: which axles emit tire smoke and how
 * strongly, plus the engine smoke intensity, from the vehicle traction state
 * and damage. Burnout spins the rear tires; sliding/drifting adds slip-based
 * rear smoke, and a hard drift also smokes the front tires.
 */
export function planSmokeEmission(
  traction: Readonly<TractionState> | null,
  damage: number,
): SmokeEmissionPlan {
  const burnout = clamp(traction?.burnout ?? 0, 0, 1);
  const sliding = Boolean(traction?.sliding);
  const slip = clamp(traction?.slipAmount ?? 0, 0, 1);
  let rearIntensity = 0;
  if (burnout >= BURNOUT_SMOKE_THRESHOLD) rearIntensity = burnout;
  if (sliding && slip >= SLIP_SMOKE_THRESHOLD) rearIntensity = Math.max(rearIntensity, slip);
  const tires: TireSmokeSource[] = [];
  if (rearIntensity > 0) tires.push({ axle: 'rear', intensity: rearIntensity });
  if (sliding && slip >= DRIFT_SMOKE_THRESHOLD) {
    tires.push({ axle: 'front', intensity: DRIFT_FRONT_INTENSITY_FACTOR * slip });
  }
  return { tires, engineIntensity: engineSmokeIntensity(damage) };
}

export class WorldRenderer implements ChunkSink {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(66, 1, 0.1, 3_000);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly world = new THREE.Group();
  private readonly car = new THREE.Group();
  private readonly carWheels: THREE.Group[] = [];
  private readonly dentMeshes: THREE.Mesh[] = [];
  private carVehicleId = 'sedan';
  private currentDamage = -1;
  private readonly remoteCars = new Map<string, RemoteCarView>();
  private readonly remoteGroup = new THREE.Group();
  private readonly ambientGroup = new THREE.Group();
  private readonly routeGroup = new THREE.Group();
  private readonly missionMarkerGroup = new THREE.Group();
  private readonly missionMarkerViews = new Map<string, MissionMarkerView>();
  private readonly policeGroup = new THREE.Group();
  private readonly policeViews = new Map<string, PoliceCarView>();
  private wantedLevel = 0;
  private readonly policeBodyGeometry = new THREE.BoxGeometry(1.7, 0.62, 4.1);
  private readonly policeCabinGeometry = new THREE.BoxGeometry(1.45, 0.5, 1.9);
  private readonly policeBarGeometry = new THREE.BoxGeometry(1.1, 0.13, 0.3);
  private readonly policeBodyMaterial = new THREE.MeshStandardMaterial({
    color: '#f2f4f5',
    roughness: 0.55,
    metalness: 0.18,
  });
  private readonly policeAccentMaterial = new THREE.MeshStandardMaterial({
    color: '#14161a',
    roughness: 0.45,
    metalness: 0.2,
  });
  private readonly smokeParticles: THREE.Points;
  private readonly smokePuffs: Puff[] = [];
  private readonly sparkPuffs: Puff[] = [];
  private readonly tireSmokeAccumulators: Record<'front' | 'rear', number> = {
    front: 0,
    rear: 0,
  };
  private explosionActiveUntil = 0;
  private readonly ambientActors = new Map<string, AmbientActorView>();
  private readonly trafficControls = new Map<string, TrafficControlView>();
  private routePoints: readonly LonLat[] = [];
  private routeLine: THREE.Line | null = null;
  private routeNeedsUpdate = true;
  private readonly remoteBodyGeometry = new THREE.BoxGeometry(1.8, 0.52, 3.6);
  private readonly remoteCabinGeometry = new THREE.BoxGeometry(1.35, 0.62, 1.7);
  private readonly remoteBodyMaterial = new THREE.MeshStandardMaterial({
    color: '#ef8354',
    roughness: 0.45,
  });
  private readonly remoteCabinMaterial = new THREE.MeshStandardMaterial({
    color: '#243d51',
    roughness: 0.25,
  });
  private readonly ambientLight = new THREE.HemisphereLight('#d7efff', '#333626', 1.1);
  private readonly sun = new THREE.DirectionalLight('#fff0c5', 2.2);
  private readonly currentSky = COLORS.skyNight.clone();
  private readonly chunks = new Map<string, RenderChunk>();
  private readonly debugOverlay: HTMLElement;
  private origin: LonLat = { longitude: -104.9903, latitude: 39.7392 };
  private resizeObserver: ResizeObserver | null = null;
  private debugVisible = false;
  private lastDebugAt = 0;
  private framesSinceDebug = 0;
  private fps = 0;
  private streamStats: StreamStats = { active: 0, loading: 0, queued: 0 };
  private physicsChunkCount = 0;
  private lastCameraPosition = new THREE.Vector3();
  private cameraMode: 'chase' | 'hood' = 'chase';

  constructor(
    private readonly container: HTMLElement,
    private readonly playerLabelLayer: HTMLElement,
    debugOverlay: HTMLElement,
  ) {
    this.debugOverlay = debugOverlay;
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    this.renderer.setSize(container.clientWidth, container.clientHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.setAttribute(
      'aria-label',
      'Three-dimensional OpenStreetMap driving world',
    );
    this.renderer.domElement.setAttribute('role', 'img');
    container.replaceChildren(this.renderer.domElement);
    this.scene.add(
      this.world,
      this.remoteGroup,
      this.ambientGroup,
      this.routeGroup,
      this.missionMarkerGroup,
      this.policeGroup,
      this.ambientLight,
      this.sun,
      this.sun.target,
    );
    this.smokeParticles = new THREE.Points(
      WorldRenderer.createPuffGeometry(),
      WorldRenderer.createPuffMaterial(),
    );
    this.smokeParticles.frustumCulled = false;
    // Hidden until updateParticles() has live puffs; the geometry initializes
    // every point at the world origin with a black vertex color, which renders
    // as a stray black square on the ground if the points cloud is visible.
    this.smokeParticles.visible = false;
    this.scene.add(this.smokeParticles);
    this.scene.fog = new THREE.Fog(COLORS.skyDay, 900, 2_650);
    this.sun.position.set(-250, 600, -350);
    this.createCar();
    this.scene.add(this.car);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  setOrigin(origin: LonLat): void {
    this.origin = { ...origin };
    for (const chunk of this.chunks.values()) this.positionChunk(chunk);
    this.routeNeedsUpdate = true;
    this.updateMissionMarkerPositions();
  }

  reset(origin: LonLat): void {
    this.setOrigin(origin);
    this.lastCameraPosition.set(0, 0, 0);
    this.camera.position.set(0, 0, 0);
  }

  shiftOrigin(shift: { x: number; y: number }, nextOrigin: LonLat): void {
    this.lastCameraPosition.x -= shift.x;
    this.lastCameraPosition.z += shift.y;
    this.camera.position.x -= shift.x;
    this.camera.position.z += shift.y;
    this.setOrigin(nextOrigin);
  }

  setRoute(points: readonly LonLat[] | null): void {
    this.routePoints = points?.map((point) => ({ ...point })) ?? [];
    this.routeNeedsUpdate = true;
    this.updateRouteGeometry();
  }

  setMissionMarkers(markers: readonly MissionMarker[]): void {
    this.clearMissionMarkers();
    markers.forEach((marker, index) => {
      const group = new THREE.Group();
      const color =
        marker.kind === 'pickup' ? '#ffe165' : marker.kind === 'checkpoint' ? '#55e6bb' : '#f28d57';
      const opacity = marker.active ? 0.96 : 0.42;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(marker.active ? 1.2 : 0.8, marker.active ? 1.65 : 1.1, 24),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity,
          side: THREE.DoubleSide,
          depthTest: false,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.08;
      ring.renderOrder = 12;
      const beacon = new THREE.Mesh(
        new THREE.CylinderGeometry(
          marker.active ? 0.2 : 0.11,
          marker.active ? 0.32 : 0.18,
          marker.active ? 3.8 : 2.5,
          8,
        ),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false }),
      );
      beacon.position.y = marker.active ? 1.95 : 1.3;
      beacon.renderOrder = 12;
      const cap = new THREE.Mesh(
        new THREE.SphereGeometry(marker.active ? 0.48 : 0.3, 10, 8),
        new THREE.MeshBasicMaterial({ color, depthTest: false }),
      );
      cap.position.y = marker.active ? 4 : 2.7;
      cap.renderOrder = 12;
      group.add(ring, beacon, cap);
      this.missionMarkerGroup.add(group);
      this.missionMarkerViews.set(`${marker.kind}-${index}`, {
        group,
        location: { ...marker.location },
      });
    });
    this.updateMissionMarkerPositions();
  }

  clearRoute(): void {
    this.setRoute(null);
  }

  addChunk(cell: TileCell, geometry: ChunkGeometry): void {
    this.removeChunk(cell.key);
    const group = new THREE.Group();
    for (const [surface, material] of CHUNK_SURFACE_MATERIALS) {
      this.addSurface(group, geometry[surface], material(), surface);
    }
    const chunk = { cell, group };
    this.positionChunk(chunk);
    this.world.add(group);
    this.chunks.set(cell.key, chunk);
  }

  removeChunk(key: string): void {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.world.remove(chunk.group);
    chunk.group.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    this.chunks.delete(key);
  }

  updateAmbientWorld(snapshot: WorldSnapshot | null, origin: LonLat): void {
    const actors = snapshot?.status === 'ready' ? snapshot.actors : [];
    const visibleActors = actors
      .map((actor) => {
        const position = lonLatToLocalMeters(actor.position, origin);
        return { actor, position, distance: Math.hypot(position.x, position.y) };
      })
      .filter(({ distance }) => distance <= AMBIENT_DRAW_DISTANCE_METERS)
      .sort((first, second) => first.distance - second.distance)
      .slice(0, MAX_WORLD_ACTORS);
    const actorIds = new Set(visibleActors.map(({ actor }) => actor.id));

    for (const { actor, position } of visibleActors) {
      let view = this.ambientActors.get(actor.id);
      if (view && view.kind !== actor.kind) {
        this.removeAmbientActor(actor.id);
        view = undefined;
      }
      if (!view) {
        view = this.createAmbientActor(actor);
        this.ambientActors.set(actor.id, view);
      }
      view.group.position.set(position.x, 0.02, -position.y);
      view.group.rotation.y = Math.PI - actor.headingRadians;
    }
    for (const id of this.ambientActors.keys()) {
      if (!actorIds.has(id)) this.removeAmbientActor(id);
    }

    const controls = snapshot?.status === 'ready' ? snapshot.controls : [];
    const visibleControls = controls
      .map((control) => {
        const position = lonLatToLocalMeters(control.position, origin);
        return { control, position, distance: Math.hypot(position.x, position.y) };
      })
      .filter(({ distance }) => distance <= TRAFFIC_CONTROL_DRAW_DISTANCE_METERS)
      .sort((first, second) => first.distance - second.distance)
      .slice(0, MAX_WORLD_CONTROLS);
    const controlIds = new Set(visibleControls.map(({ control }) => control.id));

    for (const { control, position } of visibleControls) {
      let view = this.trafficControls.get(control.id);
      if (view && view.kind !== control.kind) {
        this.removeTrafficControl(control.id);
        view = undefined;
      }
      if (!view) {
        view = this.createTrafficControl(control);
        this.trafficControls.set(control.id, view);
      }
      view.group.position.set(position.x + 3.2, 0, -position.y);
      this.updateTrafficControl(view, control.state);
    }
    for (const id of this.trafficControls.keys()) {
      if (!controlIds.has(id)) this.removeTrafficControl(id);
    }
  }

  render(
    state: Readonly<GameState>,
    elapsedSeconds: number,
    deltaSeconds: number,
    remotePlayers: readonly RemotePlayerRenderState[] = [],
    traction: Readonly<TractionState> | null = null,
  ): void {
    const player = state.cars[0];
    this.updateRouteGeometry();

    const target = new THREE.Vector3(player.position.x, player.altitudeMeters, -player.position.y);
    this.ensureCarAppearance(player.vehicleId ?? 'sedan', player.damage ?? 0);
    this.car.position.copy(target);
    this.car.rotation.set(0, Math.PI - player.headingRadians, 0);
    this.updateWheels(player.wheels);
    const hoodView = this.cameraMode === 'hood';
    const localCameraOffset = hoodView
      ? new THREE.Vector3(0, 1.22, 1.08)
      : new THREE.Vector3(0, 5.2, -11.5);
    const cameraTarget = target.clone().add(localCameraOffset.applyQuaternion(this.car.quaternion));
    const lookAtTarget = hoodView
      ? target.clone().add(new THREE.Vector3(0, 1.05, 18).applyQuaternion(this.car.quaternion))
      : target.clone().add(new THREE.Vector3(0, 0.55, 0));
    const blend = 1 - Math.exp(-Math.max(0, deltaSeconds) * 5.5);
    if (this.lastCameraPosition.lengthSq() === 0) this.lastCameraPosition.copy(cameraTarget);
    this.lastCameraPosition.lerp(cameraTarget, blend);
    this.camera.position.copy(this.lastCameraPosition);
    this.camera.lookAt(lookAtTarget);
    this.updateRemotePlayers(remotePlayers, state);
    this.updateDayNight(elapsedSeconds, target);
    this.updateEffects(deltaSeconds, traction, player.damage ?? 0, elapsedSeconds);
    this.renderer.render(this.scene, this.camera);
    this.updateDebugOverlay();
  }

  setStreamStats(stats: StreamStats, physicsChunkCount: number): void {
    this.streamStats = stats;
    this.physicsChunkCount = physicsChunkCount;
  }

  setDebugVisible(visible: boolean): void {
    this.debugVisible = visible;
    this.debugOverlay.hidden = !visible;
  }

  setGraphicsQuality(quality: 'low' | 'medium' | 'high'): void {
    const cap = quality === 'low' ? 0.7 : quality === 'high' ? MAX_PIXEL_RATIO : 1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
    this.resize();
  }

  toggleCameraMode(): 'chase' | 'hood' {
    this.cameraMode = this.cameraMode === 'chase' ? 'hood' : 'chase';
    this.lastCameraPosition.set(0, 0, 0);
    return this.cameraMode;
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    for (const key of [...this.chunks.keys()]) this.removeChunk(key);
    for (const id of [...this.remoteCars.keys()]) this.removeRemoteCar(id);
    for (const id of [...this.ambientActors.keys()]) this.removeAmbientActor(id);
    for (const id of [...this.trafficControls.keys()]) this.removeTrafficControl(id);
    this.clearRoute();
    this.clearMissionMarkers();
    this.remoteBodyGeometry.dispose();
    this.remoteCabinGeometry.dispose();
    this.remoteBodyMaterial.dispose();
    this.remoteCabinMaterial.dispose();
    this.renderer.dispose();
    for (const material of [
      COLORS.ground,
      COLORS.road,
      COLORS.markings,
      COLORS.building,
      COLORS.green,
      COLORS.water,
    ]) {
      material.dispose();
    }
  }

  private addSurface(
    group: THREE.Group,
    data: ChunkGeometry['ground'],
    material: THREE.Material,
    name = '',
  ): void {
    if (!data.indices.length || !data.positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    group.add(mesh);
  }

  private updateRouteGeometry(): void {
    if (!this.routeNeedsUpdate) return;
    this.routeNeedsUpdate = false;
    if (this.routeLine) {
      this.routeGroup.remove(this.routeLine);
      this.routeLine.geometry.dispose();
      (this.routeLine.material as THREE.Material).dispose();
      this.routeLine = null;
    }
    if (this.routePoints.length < 2) return;

    const positions = new Float32Array(this.routePoints.length * 3);
    this.routePoints.forEach((point, index) => {
      const local = lonLatToLocalMeters(point, this.origin);
      positions[index * 3] = local.x;
      positions[index * 3 + 1] = 0.18;
      positions[index * 3 + 2] = -local.y;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color: '#73f0bb',
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });
    this.routeLine = new THREE.Line(geometry, material);
    this.routeLine.renderOrder = 10;
    this.routeGroup.add(this.routeLine);
  }

  private updateMissionMarkerPositions(): void {
    for (const view of this.missionMarkerViews.values()) {
      const position = lonLatToLocalMeters(view.location, this.origin);
      view.group.position.set(position.x, 0, -position.y);
    }
  }

  private clearMissionMarkers(): void {
    for (const view of this.missionMarkerViews.values()) {
      this.missionMarkerGroup.remove(view.group);
      view.group.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.dispose();
      });
    }
    this.missionMarkerViews.clear();
  }

  private createAmbientActor(actor: AmbientActorState): AmbientActorView {
    const group = new THREE.Group();
    if (actor.kind === 'vehicle') {
      const palette = ['#e76f51', '#4e79a7', '#f2c14e', '#9b8ac4', '#65b891', '#d7dce2'];
      const color = palette[hashString(actor.id) % palette.length];
      const body = new THREE.MeshStandardMaterial({ color, roughness: 0.56 });
      const cabin = new THREE.MeshStandardMaterial({ color: '#283943', roughness: 0.34 });
      const bodyMesh = new THREE.Mesh(this.remoteBodyGeometry, body);
      bodyMesh.position.y = 0.42;
      const cabinMesh = new THREE.Mesh(this.remoteCabinGeometry, cabin);
      cabinMesh.position.set(0, 0.93, -0.12);
      group.add(bodyMesh, cabinMesh);
      if (actor.vehicleClass === 'van') group.scale.set(1.08, 1.08, 1.18);
      if (actor.vehicleClass === 'bus') group.scale.set(1.18, 1.12, 1.52);
    } else {
      const clothing = new THREE.MeshStandardMaterial({
        color: pedestrianColor(actor.id),
        roughness: 0.84,
      });
      const skin = new THREE.MeshStandardMaterial({ color: '#d3a37c', roughness: 0.9 });
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.7, 3, 6), clothing);
      body.position.y = 0.64;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), skin);
      head.position.y = 1.28;
      group.add(body, head);
    }
    this.ambientGroup.add(group);
    return { group, kind: actor.kind };
  }

  private removeAmbientActor(id: string): void {
    const view = this.ambientActors.get(id);
    if (!view) return;
    this.ambientGroup.remove(view.group);
    view.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      if (
        object.geometry !== this.remoteBodyGeometry &&
        object.geometry !== this.remoteCabinGeometry
      ) {
        object.geometry.dispose();
      }
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    });
    this.ambientActors.delete(id);
  }

  private createTrafficControl(control: TrafficControlSnapshot): TrafficControlView {
    const group = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.07, 3.25, 6),
      new THREE.MeshStandardMaterial({ color: '#687b7c', roughness: 0.75 }),
    );
    pole.position.y = 1.62;
    group.add(pole);
    let lamps: THREE.Mesh[] = [];
    if (control.kind === 'traffic-signal') {
      const housing = new THREE.Mesh(
        new THREE.BoxGeometry(0.38, 1.08, 0.3),
        new THREE.MeshStandardMaterial({ color: '#171d21', roughness: 0.38 }),
      );
      housing.position.set(0, 3.14, 0);
      group.add(housing);
      lamps = ['#f04747', '#f7ca54', '#61d98f'].map((color, index) => {
        const material = new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.05,
          roughness: 0.32,
        });
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), material);
        lamp.position.set(0, 3.48 - index * 0.34, 0.17);
        group.add(lamp);
        return lamp;
      });
    } else {
      const sign = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.48, 0),
        new THREE.MeshStandardMaterial({ color: '#d94d49', roughness: 0.68 }),
      );
      sign.position.set(0, 3.02, 0.12);
      group.add(sign);
    }
    this.ambientGroup.add(group);
    return { group, lamps, kind: control.kind };
  }

  private updateTrafficControl(
    view: TrafficControlView,
    state: TrafficControlSnapshot['state'],
  ): void {
    if (view.kind !== 'traffic-signal') return;
    const activeIndex = state === 'red' ? 0 : state === 'yellow' ? 1 : state === 'green' ? 2 : -1;
    view.lamps.forEach((lamp, index) => {
      const material = lamp.material as THREE.MeshStandardMaterial;
      material.emissiveIntensity = index === activeIndex ? 1.8 : 0.035;
    });
  }

  private removeTrafficControl(id: string): void {
    const view = this.trafficControls.get(id);
    if (!view) return;
    this.ambientGroup.remove(view.group);
    view.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    });
    this.trafficControls.delete(id);
  }

  private positionChunk(chunk: RenderChunk): void {
    const offset = lonLatToLocalMeters(chunk.cell.center, this.origin);
    chunk.group.position.set(offset.x, 0, -offset.y);
  }

  private createCar(vehicleId = 'sedan'): void {
    const definition = getVehicleDefinition(vehicleId);
    const { width, length, height, wheelbase, track, wheelRadius } = definition.dimensions;
    const bodyMaterial = new THREE.MeshStandardMaterial({
      color:
        definition.visual === 'sports-car'
          ? '#e68a4f'
          : definition.visual === 'truck'
            ? '#4b89a4'
            : definition.visual === 'motorbike'
              ? '#e0bd58'
              : '#16bd87',
      roughness: 0.4,
      metalness: 0.14,
    });
    const glassMaterial = new THREE.MeshStandardMaterial({ color: '#183c46', roughness: 0.22 });
    const trimMaterial = new THREE.MeshStandardMaterial({ color: '#d9f6ed', roughness: 0.38 });
    const tireMaterial = new THREE.MeshStandardMaterial({ color: '#15191a', roughness: 0.92 });
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(width, Math.max(0.28, height * 0.34), length),
      bodyMaterial,
    );
    body.position.y = height * 0.2;
    this.car.add(body);

    if (definition.visual === 'motorbike') {
      const tank = new THREE.Mesh(
        new THREE.BoxGeometry(width * 0.72, height * 0.22, length * 0.28),
        bodyMaterial,
      );
      tank.position.set(0, height * 0.53, length * 0.04);
      const seat = new THREE.Mesh(
        new THREE.BoxGeometry(width * 0.48, height * 0.08, length * 0.34),
        glassMaterial,
      );
      seat.position.set(0, height * 0.49, -length * 0.2);
      this.car.add(tank, seat);
      for (let index = 0; index < 2; index += 1) {
        const wheel = new THREE.Group();
        const tire = new THREE.Mesh(
          new THREE.CylinderGeometry(wheelRadius, wheelRadius, 0.16, 14),
          tireMaterial,
        );
        tire.rotation.z = Math.PI / 2;
        wheel.add(tire);
        this.carWheels.push(wheel);
        this.car.add(wheel);
      }
    } else {
      if (definition.visual === 'truck') {
        const cabin = new THREE.Mesh(
          new THREE.BoxGeometry(width * 0.8, height * 0.48, length * 0.34),
          glassMaterial,
        );
        cabin.position.set(0, height * 0.64, length * 0.26);
        const cargo = new THREE.Mesh(
          new THREE.BoxGeometry(width * 0.92, height * 0.38, length * 0.46),
          bodyMaterial,
        );
        cargo.position.set(0, height * 0.53, -length * 0.2);
        this.car.add(cabin, cargo);
      } else {
        const cabinScale = definition.visual === 'sports-car' ? 0.64 : 0.74;
        const cabinHeight = definition.visual === 'sports-car' ? 0.34 : 0.42;
        const cabin = new THREE.Mesh(
          new THREE.BoxGeometry(width * cabinScale, height * cabinHeight, length * 0.43),
          glassMaterial,
        );
        cabin.position.set(0, height * 0.56, -length * 0.035);
        const roof = new THREE.Mesh(
          new THREE.BoxGeometry(width * 0.56, height * 0.07, length * 0.23),
          bodyMaterial,
        );
        roof.position.set(
          0,
          height * (definition.visual === 'sports-car' ? 0.77 : 0.79),
          -length * 0.04,
        );
        this.car.add(cabin, roof);
      }
      for (let index = 0; index < 4; index += 1) {
        const wheel = new THREE.Group();
        const tire = new THREE.Mesh(
          new THREE.CylinderGeometry(wheelRadius, wheelRadius, 0.24, 12),
          tireMaterial,
        );
        tire.rotation.z = Math.PI / 2;
        const hub = new THREE.Mesh(
          new THREE.CylinderGeometry(wheelRadius * 0.46, wheelRadius * 0.46, 0.25, 10),
          trimMaterial,
        );
        hub.rotation.z = Math.PI / 2;
        wheel.add(tire, hub);
        this.carWheels.push(wheel);
        this.car.add(wheel);
      }
    }

    const dentMaterial = new THREE.MeshStandardMaterial({
      color: '#303536',
      roughness: 1,
      transparent: true,
      opacity: 0.76,
    });
    for (let index = 0; index < 4; index += 1) {
      const dent = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 5), dentMaterial);
      dent.scale.set(1.4, 0.2, 0.7);
      dent.position.set(
        index % 2 ? width * 0.36 : -width * 0.36,
        height * 0.25,
        index < 2 ? length * 0.34 : -length * 0.34,
      );
      this.dentMeshes.push(dent);
      this.car.add(dent);
    }
    const lightMaterial = new THREE.MeshStandardMaterial({
      color: '#fff1bc',
      emissive: '#d99a3f',
      emissiveIntensity: 0.55,
    });
    const headlight = new THREE.Mesh(
      new THREE.BoxGeometry(width * 0.16, 0.12, 0.06),
      lightMaterial,
    );
    const leftLight = headlight.clone();
    leftLight.position.set(-width * 0.32, height * 0.28, length * 0.49);
    const rightLight = headlight.clone();
    rightLight.position.set(width * 0.32, height * 0.28, length * 0.49);
    this.car.add(leftLight, rightLight);
    this.carVehicleId = definition.id;
    void wheelbase;
    void track;
  }

  private ensureCarAppearance(vehicleId: string, damage: number): void {
    if (vehicleId !== this.carVehicleId) {
      this.car.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.dispose();
      });
      this.car.clear();
      this.carWheels.length = 0;
      this.dentMeshes.length = 0;
      this.createCar(vehicleId);
      this.currentDamage = -1;
    }
    const boundedDamage = clamp(damage, 0, 100);
    if (boundedDamage === this.currentDamage) return;
    this.dentMeshes.forEach((dent, index) => {
      dent.visible = boundedDamage >= (index + 1) * 16;
      dent.scale.set(1.4 + boundedDamage * 0.006, 0.2, 0.7 + boundedDamage * 0.003);
    });
    this.currentDamage = boundedDamage;
  }

  private updateRemotePlayers(
    players: readonly RemotePlayerRenderState[],
    state: Readonly<GameState>,
  ): void {
    const localPosition = state.cars[0].position;
    const candidates = players
      .map((player) => {
        const position = lonLatToLocalMeters(player.car.position, state.origin);
        const distance = Math.hypot(position.x - localPosition.x, position.y - localPosition.y);
        return { player, position, distance };
      })
      .filter((candidate) => candidate.distance <= REMOTE_CAR_DRAW_DISTANCE_METERS)
      .sort((left, right) => left.distance - right.distance)
      .slice(0, MAX_REMOTE_CARS);
    const visibleIds = new Set(candidates.map(({ player }) => player.id));

    for (const { player, position, distance } of candidates) {
      let view = this.remoteCars.get(player.id);
      const vehicleId = player.car.vehicleId ?? 'sedan';
      if (view && view.vehicleId !== vehicleId) {
        this.removeRemoteCar(player.id);
        view = undefined;
      }
      if (!view) {
        view = this.createRemoteCar(player.id, player.handle, vehicleId);
        this.remoteCars.set(player.id, view);
      }
      view.handle = player.handle;
      view.label.textContent = player.handle;
      view.label.setAttribute('aria-label', `Nearby driver ${player.handle}`);
      view.group.position.set(position.x, player.car.altitudeMeters, -position.y);
      view.group.rotation.y = Math.PI - player.car.headingRadians;
      view.group.visible = distance <= REMOTE_CAR_DRAW_DISTANCE_METERS;
      view.label.hidden = distance > REMOTE_LABEL_DISTANCE_METERS;
      if (view.label.hidden) continue;

      const labelPosition = new THREE.Vector3(
        position.x,
        player.car.altitudeMeters + 2.5,
        -position.y,
      ).project(this.camera);
      const onScreen =
        labelPosition.z >= -1 &&
        labelPosition.z <= 1 &&
        Math.abs(labelPosition.x) <= 1.05 &&
        Math.abs(labelPosition.y) <= 1.05;
      view.label.hidden = !onScreen;
      if (onScreen) {
        view.label.style.left = `${((labelPosition.x + 1) * 0.5 * this.container.clientWidth).toFixed(1)}px`;
        view.label.style.top = `${((1 - labelPosition.y) * 0.5 * this.container.clientHeight).toFixed(1)}px`;
      }
    }

    for (const id of this.remoteCars.keys()) {
      if (!visibleIds.has(id)) this.removeRemoteCar(id);
    }
  }

  private createRemoteCar(id: string, handle: string, vehicleId: string): RemoteCarView {
    const group = new THREE.Group();
    const visual = getVehicleDefinition(vehicleId).visual;
    const body = new THREE.Mesh(this.remoteBodyGeometry, this.remoteBodyMaterial);
    body.position.y = 0.02;
    const cabin = new THREE.Mesh(this.remoteCabinGeometry, this.remoteCabinMaterial);
    cabin.position.set(0, 0.5, -0.05);
    if (visual === 'truck') group.scale.set(1.12, 1.2, 1.42);
    if (visual === 'sports-car') group.scale.set(0.94, 0.82, 1.12);
    if (visual === 'motorbike') group.scale.set(0.48, 0.8, 0.68);
    group.add(body, cabin);
    this.remoteGroup.add(group);

    const label = document.createElement('div');
    label.className = 'player-label';
    label.dataset.playerId = id;
    label.textContent = handle;
    label.setAttribute('aria-label', `Nearby driver ${handle}`);
    this.playerLabelLayer.append(label);
    return { group, label, handle, vehicleId };
  }

  private removeRemoteCar(id: string): void {
    const view = this.remoteCars.get(id);
    if (!view) return;
    this.remoteGroup.remove(view.group);
    view.label.remove();
    this.remoteCars.delete(id);
  }

  updatePursuit(police: readonly PoliceUnitState[], origin: LonLat, wantedLevel: number): void {
    this.origin = { ...origin };
    const visibleIds = new Set<string>();
    for (const unit of police) {
      const position = lonLatToLocalMeters(unit.position, origin);
      const distance = Math.hypot(position.x, position.y);
      if (distance > SIREN_SIGHT_METERS) continue;
      visibleIds.add(unit.id);
      let view = this.policeViews.get(unit.id);
      if (!view) {
        view = this.createPoliceCar();
        this.policeViews.set(unit.id, view);
      }
      view.targetX = position.x;
      view.targetZ = -position.y;
      view.heading = unit.headingRadians;
      const disabled = unit.mode === 'disabled' || unit.damage >= 100;
      view.group.visible = !disabled || unit.damage < 100;
      view.lightRed.emissiveIntensity = disabled ? 0.05 : 1.6;
      view.lightBlue.emissiveIntensity = disabled ? 0.05 : 1.6;
    }
    for (const id of [...this.policeViews.keys()]) {
      if (!visibleIds.has(id)) {
        const view = this.policeViews.get(id);
        if (view) this.policeGroup.remove(view.group);
        view?.group.traverse((object) => {
          if (object instanceof THREE.Mesh) object.geometry.dispose();
        });
        this.policeViews.delete(id);
      }
    }
    this.wantedLevel = wantedLevel;
  }

  triggerExplosion(): void {
    this.explosionActiveUntil = performance.now() + 1_400;
    const center = this.car.position.clone();
    for (let index = 0; index < MAX_EXPLOSION_SPARKS; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 4 + Math.random() * 14;
      this.sparkPuffs.push({
        position: center.clone().add(new THREE.Vector3(0, 0.8, 0)),
        velocity: new THREE.Vector3(
          Math.cos(angle) * speed,
          4 + Math.random() * 9,
          Math.sin(angle) * speed,
        ),
        ageSeconds: 0,
        lifetimeSeconds: 0.7 + Math.random() * 0.7,
        color: new THREE.Color().setHSL(0.06 + Math.random() * 0.06, 0.95, 0.55),
      });
    }
  }

  private static createPuffGeometry(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array((MAX_SMOKE_PUFFS + MAX_EXPLOSION_SPARKS) * 3);
    const colors = new Float32Array((MAX_SMOKE_PUFFS + MAX_EXPLOSION_SPARKS) * 3);
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  }

  private static createPuffMaterial(): THREE.PointsMaterial {
    return new THREE.PointsMaterial({
      size: 1.6,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      vertexColors: true,
      sizeAttenuation: true,
    });
  }

  private createPoliceCar(): PoliceCarView {
    const group = new THREE.Group();
    const body = new THREE.Mesh(this.policeBodyGeometry, this.policeBodyMaterial);
    body.position.y = 0.32;
    const stripe = new THREE.Mesh(this.policeBarGeometry, this.policeAccentMaterial);
    stripe.scale.set(1.4, 1.1, 1.9);
    stripe.position.set(0, 0.33, 0.2);
    const cabin = new THREE.Mesh(this.policeCabinGeometry, this.policeAccentMaterial);
    cabin.position.set(0, 0.85, -0.1);
    const lightRed = new THREE.MeshStandardMaterial({
      color: '#2a0505',
      emissive: new THREE.Color('#ff2a2a'),
      emissiveIntensity: 1.6,
      roughness: 0.4,
    });
    const lightBlue = new THREE.MeshStandardMaterial({
      color: '#050a2a',
      emissive: new THREE.Color('#2a6aff'),
      emissiveIntensity: 1.6,
      roughness: 0.4,
    });
    const lampLeft = new THREE.Mesh(this.policeBarGeometry, lightRed);
    lampLeft.position.set(-0.32, 1.16, -0.1);
    lampLeft.scale.set(0.55, 1, 1);
    const lampRight = new THREE.Mesh(this.policeBarGeometry, lightBlue);
    lampRight.position.set(0.32, 1.16, -0.1);
    lampRight.scale.set(0.55, 1, 1);
    group.add(body, stripe, cabin, lampLeft, lampRight);
    this.policeGroup.add(group);
    return { group, lightRed, lightBlue, targetX: 0, targetZ: 0, heading: 0 };
  }

  private updateEffects(
    deltaSeconds: number,
    traction: Readonly<TractionState> | null,
    damage: number,
    elapsedSeconds: number,
  ): void {
    const delta = Math.max(0, deltaSeconds);
    const plan = planSmokeEmission(traction, damage);
    const definition = getVehicleDefinition(this.carVehicleId);
    // Frame-rate independent emission: accumulate fractional puffs per axle at
    // TIRE_SMOKE_PUFFS_PER_SECOND * intensity per tire and spawn whole puffs.
    for (const axle of ['rear', 'front'] as const) {
      const source = plan.tires.find((tire) => tire.axle === axle);
      if (!source) {
        this.tireSmokeAccumulators[axle] = 0;
        continue;
      }
      const tireCount = definition.visual === 'motorbike' ? 1 : 2;
      this.tireSmokeAccumulators[axle] +=
        TIRE_SMOKE_PUFFS_PER_SECOND * source.intensity * tireCount * delta;
      while (this.tireSmokeAccumulators[axle] >= 1) {
        this.tireSmokeAccumulators[axle] -= 1;
        this.spawnTireSmoke(axle, source.intensity, definition);
      }
    }
    if (plan.engineIntensity > 0) {
      const hoodOffset = new THREE.Vector3(
        0,
        0.35,
        definition.dimensions.length * 0.32,
      ).applyQuaternion(this.car.quaternion);
      this.spawnEngineSmoke(this.car.position.clone().add(hoodOffset), damage);
    }
    this.updatePoliceCars(deltaSeconds, elapsedSeconds);
    this.updateParticles(deltaSeconds);
  }

  private spawnTireSmoke(
    axle: 'front' | 'rear',
    intensity: number,
    definition: VehicleDefinition,
  ): void {
    if (this.smokePuffs.length >= MAX_SMOKE_PUFFS) return;
    const { track, wheelbase, wheelRadius } = definition.dimensions;
    // Emit at the actual wheel positions from the active vehicle definition,
    // rotated into world space by the car's orientation.
    const side = Math.random() < 0.5 ? -1 : 1;
    const lateral = definition.visual === 'motorbike' ? 0 : side * track * 0.5;
    const longitudinal = (axle === 'front' ? 1 : -1) * wheelbase * 0.5;
    const offset = new THREE.Vector3(lateral, wheelRadius * 0.5, longitudinal).applyQuaternion(
      this.car.quaternion,
    );
    // Light gray to near-white tire smoke.
    const shade = 0.72 + Math.random() * 0.2;
    this.smokePuffs.push({
      position: this.car.position.clone().add(offset),
      velocity: new THREE.Vector3(
        (Math.random() - 0.5) * 1.4,
        0.5 + Math.random() * (0.6 + intensity),
        (Math.random() - 0.5) * 1.4,
      ),
      ageSeconds: 0,
      lifetimeSeconds: 0.7 + Math.random() * 1.1,
      color: new THREE.Color(shade, shade, shade),
    });
  }

  private updatePoliceCars(deltaSeconds: number, elapsedSeconds: number): void {
    const blend = 1 - Math.exp(-Math.max(0, deltaSeconds) * 4.5);
    const flashPhase = Math.sin(elapsedSeconds * Math.PI * 2 * POLICE_LIGHT_FLASH_HZ) >= 0;
    for (const view of this.policeViews.values()) {
      const position = view.group.position;
      position.x += (view.targetX - position.x) * blend;
      position.z += (view.targetZ - position.z) * blend;
      view.group.rotation.y = Math.PI - view.heading;
      if (view.group.visible) {
        view.lightRed.emissiveIntensity = flashPhase ? 2.4 : 0.15;
        view.lightBlue.emissiveIntensity = flashPhase ? 0.15 : 2.4;
      }
    }
  }

  private updateParticles(deltaSeconds: number): void {
    const geometry = this.smokeParticles.geometry;
    const positionAttribute = geometry.getAttribute('position') as THREE.BufferAttribute;
    const colorAttribute = geometry.getAttribute('color') as THREE.BufferAttribute;
    let index = 0;
    const writePuff = (puff: Puff, sink: number): void => {
      puff.ageSeconds += deltaSeconds;
      puff.position.addScaledVector(puff.velocity, deltaSeconds);
      puff.velocity.multiplyScalar(1 - Math.min(1, deltaSeconds * 1.6));
      puff.velocity.y += sink * deltaSeconds;
      if (puff.ageSeconds >= puff.lifetimeSeconds || index >= positionAttribute.count) return;
      const fade = 1 - puff.ageSeconds / puff.lifetimeSeconds;
      positionAttribute.setXYZ(index, puff.position.x, puff.position.y, puff.position.z);
      colorAttribute.setXYZ(index, puff.color.r * fade, puff.color.g * fade, puff.color.b * fade);
      index += 1;
    };
    this.smokePuffs.slice().forEach((puff, puffIndex) => {
      if (puff.ageSeconds >= puff.lifetimeSeconds) {
        this.smokePuffs.splice(puffIndex, 1);
        return;
      }
      writePuff(puff, 1.4);
    });
    this.sparkPuffs.slice().forEach((puff, puffIndex) => {
      if (puff.ageSeconds >= puff.lifetimeSeconds) {
        this.sparkPuffs.splice(puffIndex, 1);
        return;
      }
      writePuff(puff, -7.5);
    });
    for (let rest = index; rest < positionAttribute.count; rest += 1) {
      positionAttribute.setXYZ(rest, 0, -500, 0);
    }
    positionAttribute.needsUpdate = true;
    colorAttribute.needsUpdate = true;
    this.smokeParticles.visible = index > 0;
  }

  private spawnEngineSmoke(origin: THREE.Vector3, damage: number): void {
    const intensity = engineSmokeIntensity(damage);
    if (intensity <= 0) return;
    if (Math.random() > intensity * 0.55) return;
    if (this.smokePuffs.length >= MAX_SMOKE_PUFFS) return;
    this.smokePuffs.push({
      position: origin.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.95, 0.4)),
      velocity: new THREE.Vector3(
        (Math.random() - 0.5) * 0.8,
        1.1 + Math.random(),
        (Math.random() - 0.5) * 0.8,
      ),
      ageSeconds: 0,
      lifetimeSeconds: 1.1 + Math.random() * 0.8,
      color: new THREE.Color(intensity > 0.75 ? 0x222222 : 0x8a8a8a),
    });
  }

  private updateWheels(wheels: GameState['cars'][number]['wheels']): void {
    for (let index = 0; index < this.carWheels.length; index += 1) {
      const state = wheels[index];
      if (!state) continue;
      const wheel = this.carWheels[index];
      wheel.position.set(state.position.x, state.position.y, state.position.z);
      wheel.rotation.set(state.rotationRadians, state.steeringRadians, 0);
    }
  }

  private updateDayNight(elapsedSeconds: number, target: THREE.Vector3): void {
    const phase = ((elapsedSeconds % 600) / 600) * Math.PI * 2;
    const daylight = clamp((Math.sin(phase + Math.PI / 2) + 0.12) / 0.82, 0.08, 1);
    this.currentSky.copy(COLORS.skyNight).lerp(COLORS.skyDay, daylight);
    this.scene.background = this.currentSky;
    if (this.scene.fog instanceof THREE.Fog) this.scene.fog.color.copy(this.currentSky);
    this.ambientLight.intensity = 0.34 + daylight * 0.84;
    this.sun.intensity = 0.12 + daylight * 2.15;
    this.sun.target.position.copy(target);
    this.sun.position.set(
      target.x + Math.cos(phase) * 550,
      target.y + 70 + daylight * 620,
      target.z + Math.sin(phase) * 500,
    );
  }

  private updateDebugOverlay(): void {
    if (!this.debugVisible) return;
    const now = performance.now();
    this.framesSinceDebug += 1;
    if (now - this.lastDebugAt < 250) return;
    const delta = now - this.lastDebugAt;
    this.fps = delta > 0 ? (this.framesSinceDebug * 1_000) / delta : 0;
    this.framesSinceDebug = 0;
    this.lastDebugAt = now;
    const info = this.renderer.info.render;
    this.debugOverlay.textContent = [
      `FPS ${this.fps.toFixed(0)}  ·  Draw calls ${info.calls}`,
      `Triangles ${info.triangles.toLocaleString()}  ·  Chunks ${this.streamStats.active} active / ${this.physicsChunkCount} colliders`,
      `Loading ${this.streamStats.loading}  ·  Queued ${this.streamStats.queued}  ·  z14`,
      `Camera ${this.cameraMode} · F3 hides this panel`,
    ].join('\n');
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pedestrianColor(id: string): string {
  const palette = ['#ffd166', '#ef476f', '#06d6a0', '#a78bfa', '#f4a261', '#66c7f4'];
  return palette[hashString(id) % palette.length] ?? '#ffd166';
}
