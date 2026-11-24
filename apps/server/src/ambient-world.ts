import type {
  AmbientActorState,
  TrafficControlSnapshot,
  TrafficControlState,
  WorldSnapshot,
} from '@openstreet-racer/shared';
import type { MissionOffer } from '@openstreet-racer/shared';
import {
  INTEREST_RADIUS_CELLS,
  MAX_ROUTE_DISTANCE_METERS,
  MAX_ROUTE_POINTS,
  MAX_WORLD_ACTORS,
  MAX_WORLD_CONTROLS,
  ROOM_TILE_ZOOM,
} from '@openstreet-racer/shared';
import {
  buildRoadGraph,
  findRoute as findRoadRoute,
  haversineMeters,
  localMetersToLonLat,
  nearestRoadNode,
  tileCellAt,
  tileNeighbors,
  type OsmElement,
  type RoadGraph,
  type RoadGraphEdge,
  type RoadGraphNode,
  type TileCell,
} from '@openstreet-racer/world';
import type { MissionMod } from './mod-loader';
import { generateMissionOffers } from './mission-generator';

const REGION_CACHE_LIMIT = 96;
const UNAVAILABLE_RETRY_MS = 30_000;
const SIGNAL_CYCLE_MS = 30_000;
const SIGNAL_GREEN_MS = 18_000;
const SIGNAL_YELLOW_MS = 3_000;
const MAX_CARS_PER_CELL = 2;
const MAX_PEDESTRIANS_PER_CELL = 2;
const MAX_CAR_ACCELERATION_MPS2 = 3.5;
const MAX_PED_ACCELERATION_MPS2 = 1.2;
const ROUTE_SNAP_DISTANCE_METERS = 350;

interface RegionDataSource {
  loadRegion(center: TileCell, radius?: number): Promise<readonly OsmElement[]>;
}

interface CellSimulation {
  readonly cell: TileCell;
  readonly vehicleGraph: RoadGraph;
  readonly pedestrianGraph: RoadGraph;
  readonly actors: SimulatedActor[];
  readonly controls: readonly RoadGraphNode[];
  lastUpdatedAt: number;
}

interface SimulatedActor {
  readonly id: string;
  readonly kind: 'vehicle' | 'pedestrian';
  readonly vehicleClass?: 'car' | 'van' | 'bus';
  readonly graph: RoadGraph;
  readonly random: Random;
  readonly cruiseFactor: number;
  readonly sidewalkSide: number;
  edge: RoadGraphEdge;
  progressMeters: number;
  speedMetersPerSecond: number;
  waitingAtNode: string | null;
  stopUntilMs: number;
  stoppedAtSign: string | null;
}

interface CellFailure {
  readonly retryAtMs: number;
}

export interface RoutePlan {
  readonly points: readonly Readonly<{ longitude: number; latitude: number }>[];
  readonly distanceMeters: number;
  readonly travelTimeSeconds: number;
}

export interface AmbientWorldService {
  prepare(location: { longitude: number; latitude: number }): Promise<void>;
  getSnapshot(
    location: { longitude: number; latitude: number },
    serverTimeMs?: number,
  ): WorldSnapshot;
  findRoute(
    origin: { longitude: number; latitude: number },
    destination: { longitude: number; latitude: number },
  ): Promise<RoutePlan>;
  getMissionOffers(location: {
    longitude: number;
    latitude: number;
  }): Promise<readonly MissionOffer[]>;
  setMissionMods?(mods: readonly MissionMod[]): void;
  roadInfoAt?(location: { longitude: number; latitude: number }): RoadInfo | null;
}

export interface RoadInfo {
  readonly limitMetersPerSecond: number | null;
  readonly roadDistanceMeters: number;
}

export class AmbientWorld implements AmbientWorldService {
  private readonly cells = new Map<string, CellSimulation>();
  private readonly regionCenters = new Set<string>();
  private readonly areaLoads = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, CellFailure>();

  private missionMods: readonly MissionMod[] = [];

  constructor(
    private readonly source: RegionDataSource,
    private readonly now: () => number = Date.now,
  ) {}

  setMissionMods(mods: readonly MissionMod[]): void {
    this.missionMods = mods;
  }

  roadInfoAt(location: { longitude: number; latitude: number }): RoadInfo {
    const center = tileCellAt(location, ROOM_TILE_ZOOM);
    const cell = this.cells.get(center.key);
    if (!cell) return { limitMetersPerSecond: null, roadDistanceMeters: Number.POSITIVE_INFINITY };
    const snap = nearestRoadNode(cell.vehicleGraph, location, 200);
    if (!snap) return { limitMetersPerSecond: null, roadDistanceMeters: Number.POSITIVE_INFINITY };
    let limitMetersPerSecond: number | null = null;
    for (const edge of cell.vehicleGraph.edges) {
      if (edge.from !== snap.node.id && edge.to !== snap.node.id) continue;
      limitMetersPerSecond =
        limitMetersPerSecond === null
          ? edge.speedLimitMetersPerSecond
          : Math.max(limitMetersPerSecond, edge.speedLimitMetersPerSecond);
    }
    return { limitMetersPerSecond, roadDistanceMeters: snap.distanceMeters };
  }

  async prepare(location: { longitude: number; latitude: number }): Promise<void> {
    const center = tileCellAt(location, ROOM_TILE_ZOOM);
    if (this.regionCenters.has(center.key)) return;
    const failure = this.failures.get(center.key);
    if (failure && failure.retryAtMs > this.now()) return;
    this.failures.delete(center.key);
    const pending = this.areaLoads.get(center.key);
    if (pending) return pending;

    const load = this.loadNeighborhood(center).finally(() => {
      this.areaLoads.delete(center.key);
    });
    this.areaLoads.set(center.key, load);
    return load;
  }

  getSnapshot(
    location: { longitude: number; latitude: number },
    serverTimeMs = this.now(),
  ): WorldSnapshot {
    const center = tileCellAt(location, ROOM_TILE_ZOOM);
    void this.prepare(location).catch(() => undefined);
    const centerCell = this.cells.get(center.key);
    if (!centerCell) {
      return {
        status: this.failures.has(center.key) ? 'unavailable' : 'loading',
        actors: [],
        controls: [],
        serverTimeMs,
      };
    }

    const cells = tileNeighbors(center, INTEREST_RADIUS_CELLS)
      .map((cell) => this.cells.get(cell.key))
      .filter((cell): cell is CellSimulation => Boolean(cell));
    for (const cell of cells) advanceSimulation(cell, serverTimeMs);

    const actors = cells
      .flatMap((cell) => cell.actors.map((actor) => actorSnapshot(actor)))
      .sort(
        (first, second) =>
          haversineMeters(location, first.position) - haversineMeters(location, second.position),
      )
      .slice(0, MAX_WORLD_ACTORS);
    const controls = cells
      .flatMap((cell) => cell.controls.map((node) => controlSnapshot(node, serverTimeMs)))
      .sort(
        (first, second) =>
          haversineMeters(location, first.position) - haversineMeters(location, second.position),
      )
      .slice(0, MAX_WORLD_CONTROLS);

    return { status: 'ready', actors, controls, serverTimeMs };
  }

  async findRoute(
    origin: { longitude: number; latitude: number },
    destination: { longitude: number; latitude: number },
  ): Promise<RoutePlan> {
    if (haversineMeters(origin, destination) > MAX_ROUTE_DISTANCE_METERS) {
      throw new Error(`Choose a destination within ${MAX_ROUTE_DISTANCE_METERS / 1000} km.`);
    }
    const cell = tileCellAt(origin, ROOM_TILE_ZOOM);
    const cachedCell = this.cells.get(cell.key);
    const graph =
      cachedCell?.vehicleGraph ??
      buildRoadGraph(
        await this.source.loadRegion(cell, INTEREST_RADIUS_CELLS),
        cell.center,
        'vehicle',
      );
    const start = nearestRoadNode(graph, origin, ROUTE_SNAP_DISTANCE_METERS);
    const end = nearestRoadNode(graph, destination, ROUTE_SNAP_DISTANCE_METERS);
    if (!start || !end) throw new Error('Could not find a nearby drivable road for that route.');
    const route = findRoadRoute(graph, start.node.id, end.node.id);
    if (!route) throw new Error('No drivable route was found between those points.');
    return {
      points: sampleRoute(route.points, MAX_ROUTE_POINTS),
      distanceMeters: route.distanceMeters,
      travelTimeSeconds: route.travelTimeSeconds,
    };
  }

  async getMissionOffers(location: {
    longitude: number;
    latitude: number;
  }): Promise<readonly MissionOffer[]> {
    const center = tileCellAt(location, ROOM_TILE_ZOOM);
    const elements = await this.source.loadRegion(center, INTEREST_RADIUS_CELLS);
    return generateMissionOffers(elements, location, this.now(), this.missionMods);
  }

  private async loadNeighborhood(center: TileCell): Promise<void> {
    const neighbors = tileNeighbors(center, INTEREST_RADIUS_CELLS);
    try {
      const elements = await this.source.loadRegion(center, INTEREST_RADIUS_CELLS);
      const vehicleGraph = buildRoadGraph(elements, center.center, 'vehicle');
      const pedestrianGraph = buildRoadGraph(elements, center.center, 'pedestrian');
      const loadedAt = this.now();
      for (const cell of neighbors) {
        if (!this.cells.has(cell.key)) {
          this.cells.set(
            cell.key,
            createCellSimulation(cell, vehicleGraph, pedestrianGraph, loadedAt),
          );
          this.failures.delete(cell.key);
        }
      }
      this.regionCenters.add(center.key);
      this.trimCache();
    } catch {
      const retryAtMs = this.now() + UNAVAILABLE_RETRY_MS;
      for (const cell of neighbors) this.failures.set(cell.key, { retryAtMs });
    }
  }

  private trimCache(): void {
    while (this.cells.size > REGION_CACHE_LIMIT) {
      const oldest = this.cells.keys().next().value;
      if (oldest === undefined) break;
      this.cells.delete(oldest);
      this.regionCenters.delete(oldest);
    }
  }
}

export function trafficSignalAt(
  nodeId: string,
  timestampMs: number,
): {
  state: TrafficControlState;
  changesInMs: number;
} {
  const offset = hashString(nodeId) % SIGNAL_CYCLE_MS;
  const position = (timestampMs + offset) % SIGNAL_CYCLE_MS;
  if (position < SIGNAL_GREEN_MS) {
    return { state: 'green', changesInMs: SIGNAL_GREEN_MS - position };
  }
  if (position < SIGNAL_GREEN_MS + SIGNAL_YELLOW_MS) {
    return {
      state: 'yellow',
      changesInMs: SIGNAL_GREEN_MS + SIGNAL_YELLOW_MS - position,
    };
  }
  return { state: 'red', changesInMs: SIGNAL_CYCLE_MS - position };
}

function createCellSimulation(
  cell: TileCell,
  vehicleGraph: RoadGraph,
  pedestrianGraph: RoadGraph,
  timestampMs: number,
): CellSimulation {
  const trafficEdges = cellEdges(vehicleGraph, cell).filter((edge) => edge.lengthMeters >= 7);
  const pedestrianEdges = cellEdges(pedestrianGraph, cell).filter((edge) => edge.lengthMeters >= 4);
  const actors = [
    ...createActors(cell, vehicleGraph, trafficEdges, 'vehicle', MAX_CARS_PER_CELL, timestampMs),
    ...createActors(
      cell,
      pedestrianGraph,
      pedestrianEdges,
      'pedestrian',
      MAX_PEDESTRIANS_PER_CELL,
      timestampMs,
    ),
  ];
  return {
    cell,
    vehicleGraph,
    pedestrianGraph,
    actors,
    controls: [...vehicleGraph.nodes.values()].filter(
      (node) => node.control && tileCellAt(node.location, cell.z).key === cell.key,
    ),
    lastUpdatedAt: timestampMs,
  };
}

function cellEdges(graph: RoadGraph, cell: TileCell): RoadGraphEdge[] {
  return graph.edges.filter((edge) => {
    const node = graph.nodes.get(edge.from);
    return node && tileCellAt(node.location, cell.z).key === cell.key;
  });
}

function createActors(
  cell: TileCell,
  graph: RoadGraph,
  edges: readonly RoadGraphEdge[],
  kind: SimulatedActor['kind'],
  maximum: number,
  timestampMs: number,
): SimulatedActor[] {
  const candidates = [...edges];
  const chooser = new Random(hashString(`${cell.key}:${kind}`));
  const actors: SimulatedActor[] = [];
  const count = Math.min(maximum, candidates.length);
  for (let index = 0; index < count; index += 1) {
    const edgeIndex = chooser.integer(candidates.length);
    const [edge] = candidates.splice(edgeIndex, 1);
    if (!edge) continue;
    const random = new Random(hashString(`${cell.key}:${kind}:${edge.id}:${index}`));
    const vehicleClass =
      kind === 'vehicle'
        ? random.next() < 0.08
          ? 'bus'
          : random.next() < 0.24
            ? 'van'
            : 'car'
        : undefined;
    actors.push({
      id: `${kind}:${cell.key}:${index}`,
      kind,
      ...(vehicleClass ? { vehicleClass } : {}),
      graph,
      random,
      cruiseFactor: kind === 'vehicle' ? 0.42 + random.next() * 0.2 : 1,
      sidewalkSide: random.next() < 0.5 ? -1 : 1,
      edge,
      progressMeters: random.next() * edge.lengthMeters * 0.68,
      speedMetersPerSecond: 0,
      waitingAtNode: null,
      stopUntilMs: 0,
      stoppedAtSign: null,
    });
  }
  for (const actor of actors) advanceActor(actor, 0, timestampMs);
  return actors;
}

function advanceSimulation(simulation: CellSimulation, timestampMs: number): void {
  const elapsed = Math.max(0, Math.min(2_000, timestampMs - simulation.lastUpdatedAt));
  if (elapsed === 0) return;
  const steps = Math.ceil(elapsed / 100);
  const stepSeconds = elapsed / steps / 1_000;
  let stepTime = simulation.lastUpdatedAt;
  for (let step = 0; step < steps; step += 1) {
    stepTime += stepSeconds * 1_000;
    for (const actor of simulation.actors) advanceActor(actor, stepSeconds, stepTime);
  }
  simulation.lastUpdatedAt = timestampMs;
}

function advanceActor(actor: SimulatedActor, deltaSeconds: number, timestampMs: number): void {
  const graph = actor.graph;
  const edge = actor.edge;
  const destination = graph.nodes.get(edge.to);
  if (!destination) return;
  const distanceToEnd = Math.max(0, edge.lengthMeters - actor.progressMeters);
  const control = destination.control;
  let desiredSpeed =
    actor.kind === 'pedestrian' ? 1.3 : edge.speedLimitMetersPerSecond * actor.cruiseFactor;
  let stopLineMeters = 0;

  if (control === 'traffic-signal') {
    const phase = trafficSignalAt(destination.id, timestampMs).state;
    if (phase !== 'green') {
      stopLineMeters = 2.5;
      desiredSpeed = Math.min(
        desiredSpeed,
        Math.sqrt(2 * 4.5 * Math.max(0, distanceToEnd - stopLineMeters)),
      );
    }
  } else if (control === 'stop-sign' && actor.stoppedAtSign !== destination.id) {
    stopLineMeters = 1.5;
    desiredSpeed = Math.min(
      desiredSpeed,
      Math.sqrt(2 * 3 * Math.max(0, distanceToEnd - stopLineMeters)),
    );
    if (distanceToEnd <= stopLineMeters + 0.4 && actor.speedMetersPerSecond < 0.25) {
      actor.waitingAtNode = destination.id;
      actor.stopUntilMs ||= timestampMs + 1_200;
      desiredSpeed = timestampMs >= actor.stopUntilMs ? Math.min(desiredSpeed, 1) : 0;
      if (timestampMs >= actor.stopUntilMs) actor.stoppedAtSign = destination.id;
    }
  }

  const acceleration =
    actor.kind === 'pedestrian' ? MAX_PED_ACCELERATION_MPS2 : MAX_CAR_ACCELERATION_MPS2;
  actor.speedMetersPerSecond = moveToward(
    actor.speedMetersPerSecond,
    desiredSpeed,
    acceleration * deltaSeconds,
  );
  if (deltaSeconds <= 0) return;

  let distanceToMove = actor.speedMetersPerSecond * deltaSeconds;
  let crossings = 0;
  while (distanceToMove > 0 && crossings < 4) {
    const remaining = Math.max(0, actor.edge.lengthMeters - actor.progressMeters);
    if (distanceToMove < remaining) {
      actor.progressMeters += distanceToMove;
      break;
    }
    actor.progressMeters = actor.edge.lengthMeters;
    const endNode = actor.graph.nodes.get(actor.edge.to);
    if (!endNode) break;
    if (
      endNode.control === 'traffic-signal' &&
      trafficSignalAt(endNode.id, timestampMs).state !== 'green'
    ) {
      actor.progressMeters = Math.max(0, actor.edge.lengthMeters - 2.5);
      actor.speedMetersPerSecond = 0;
      break;
    }
    if (endNode.control === 'stop-sign' && actor.stoppedAtSign !== endNode.id) {
      actor.progressMeters = Math.max(0, actor.edge.lengthMeters - stopLineMeters);
      break;
    }
    distanceToMove -= remaining;
    const next = nextEdge(actor, endNode.id);
    if (!next) {
      actor.speedMetersPerSecond = 0;
      break;
    }
    actor.edge = next;
    actor.progressMeters = 0;
    actor.waitingAtNode = null;
    actor.stopUntilMs = 0;
    actor.stoppedAtSign = null;
    crossings += 1;
  }
}

function nextEdge(actor: SimulatedActor, nodeId: string): RoadGraphEdge | undefined {
  const outgoing = actor.graph.outgoing.get(nodeId) ?? [];
  if (outgoing.length <= 1) return outgoing[0];
  const alternatives = outgoing.filter((edge) => edge.to !== actor.edge.from);
  const choices = alternatives.length ? alternatives : outgoing;
  return choices[actor.random.integer(choices.length)];
}

function actorSnapshot(actor: SimulatedActor): AmbientActorState {
  const from = actor.graph.nodes.get(actor.edge.from);
  const to = actor.graph.nodes.get(actor.edge.to);
  if (!from || !to) {
    return {
      id: actor.id,
      kind: actor.kind,
      ...(actor.vehicleClass ? { vehicleClass: actor.vehicleClass } : {}),
      position: actor.graph.origin,
      headingRadians: 0,
      speedMetersPerSecond: 0,
    };
  }
  const ratio = Math.max(0, Math.min(1, actor.progressMeters / actor.edge.lengthMeters));
  const directionX = to.position.x - from.position.x;
  const directionY = to.position.y - from.position.y;
  const length = Math.hypot(directionX, directionY) || 1;
  const laneBlend = actor.edge.oneWay
    ? 0
    : Math.min(1, actor.progressMeters / 6, (actor.edge.lengthMeters - actor.progressMeters) / 6);
  const laneOffset = actor.kind === 'vehicle' ? 1.6 * laneBlend : 0;
  const sidewalkOffset =
    actor.kind === 'pedestrian' && !isPedestrianPath(actor.edge.roadClass)
      ? actor.sidewalkSide * 2.8
      : 0;
  const point = {
    x:
      from.position.x +
      directionX * ratio +
      (directionY / length) * laneOffset -
      (directionY / length) * sidewalkOffset,
    y:
      from.position.y +
      directionY * ratio -
      (directionX / length) * laneOffset +
      (directionX / length) * sidewalkOffset,
  };
  return {
    id: actor.id,
    kind: actor.kind,
    ...(actor.vehicleClass ? { vehicleClass: actor.vehicleClass } : {}),
    position: localMetersToLonLat(point, actor.graph.origin),
    headingRadians: Math.atan2(directionX, directionY),
    speedMetersPerSecond: actor.speedMetersPerSecond,
  };
}

function controlSnapshot(node: RoadGraphNode, timestampMs: number): TrafficControlSnapshot {
  const phase =
    node.control === 'traffic-signal'
      ? trafficSignalAt(node.id, timestampMs)
      : { state: 'stop' as const, changesInMs: 0 };
  return {
    id: node.id,
    kind: node.control ?? 'stop-sign',
    state: phase.state,
    position: node.location,
    changesInMs: phase.changesInMs,
  };
}

function sampleRoute(
  points: readonly { longitude: number; latitude: number }[],
  maximum: number,
): readonly { longitude: number; latitude: number }[] {
  if (points.length <= maximum) return points;
  const sampled: { longitude: number; latitude: number }[] = [];
  for (let index = 0; index < maximum; index += 1) {
    const sourceIndex = Math.round((index * (points.length - 1)) / (maximum - 1));
    sampled.push(points[sourceIndex]!);
  }
  return sampled;
}

function moveToward(value: number, target: number, amount: number): number {
  if (value < target) return Math.min(target, value + amount);
  return Math.max(target, value - amount);
}

function isPedestrianPath(roadClass: string): boolean {
  return ['footway', 'pedestrian', 'path', 'steps', 'cycleway', 'bridleway'].includes(roadClass);
}

function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

class Random {
  private state: number;

  constructor(seed: number) {
    this.state = seed || 1;
  }

  next(): number {
    this.state ^= this.state << 13;
    this.state ^= this.state >>> 17;
    this.state ^= this.state << 5;
    return (this.state >>> 0) / 0x1_0000_0000;
  }

  integer(maximum: number): number {
    return maximum > 1 ? Math.floor(this.next() * maximum) : 0;
  }
}
