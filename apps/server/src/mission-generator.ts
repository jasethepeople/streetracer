import type { LonLat, MissionKind, MissionOffer, MissionPlace } from '@openstreet-racer/shared';
import { MAX_ROUTE_DISTANCE_METERS, ROOM_TILE_ZOOM } from '@openstreet-racer/shared';
import {
  buildRoadGraph,
  findRoute,
  haversineMeters,
  localMetersToLonLat,
  lonLatToLocalMeters,
  nearestRoadNode,
  tileCellAt,
  type OsmElement,
  type OsmNodeElement,
  type OsmRelationElement,
  type OsmWayElement,
  type RoadGraph,
} from '@openstreet-racer/world';
import type { ModScript } from '@openstreet-racer/game';
import type { MissionMod } from './mod-loader';

const MAX_MOD_OFFER_COUNT = 4;
const MIN_MOD_REWARD_CENTS = 100;
const MIN_REWARD_MULTIPLIER = 0.5;
const MAX_REWARD_MULTIPLIER = 2;
const MIN_TIME_MULTIPLIER = 0.5;
const MAX_TIME_MULTIPLIER = 3;

const MAX_OFFER_COUNT = 8;
const MAX_MISSION_ROUTE_POINTS = 10;
const MIN_ROUTE_DISTANCE_METERS = 300;
const MAX_PLACE_DISTANCE_METERS = 7_000;
const ROAD_SNAP_DISTANCE_METERS = 450;
const MISSION_KINDS: readonly MissionKind[] = ['delivery', 'taxi', 'time-trial', 'checkpoint-race'];
const HEAT_MISSION_KINDS: readonly MissionKind[] = ['getaway', 'hot-delivery', 'lay-low'];
const GETAWAY_REWARD_CENTS = 1_800;
const GETAWAY_MINIMUM_TIME_SECONDS = 45;
const GETAWAY_TIME_LIMIT_SECONDS = 420;
const LAY_LOW_REWARD_CENTS = 900;
const LAY_LOW_MINIMUM_TIME_SECONDS = 60;
const LAY_LOW_TIME_LIMIT_SECONDS = 480;
const HOT_DELIVERY_REWARD_MULTIPLIER = 2;

export interface CommunityRoutePlan {
  readonly points: readonly LonLat[];
  readonly distanceMeters: number;
  readonly travelTimeSeconds: number;
}

export function createCommunityRaceOffer(
  id: string,
  title: string,
  creatorHandle: string,
  start: LonLat,
  destination: LonLat,
  routePlan: CommunityRoutePlan,
  maxCheckpoints = 3,
): MissionOffer | null {
  const distanceMeters = Math.round(
    routePlan.distanceMeters +
      haversineMeters(start, routePlan.points[0] ?? start) +
      haversineMeters(routePlan.points.at(-1) ?? destination, destination),
  );
  if (
    distanceMeters < MIN_ROUTE_DISTANCE_METERS ||
    distanceMeters > MAX_ROUTE_DISTANCE_METERS ||
    routePlan.points.length < 2
  ) {
    return null;
  }
  const interiorPoints = routePlan.points.filter((point, index) => {
    const isFirstEndpoint = index === 0 && haversineMeters(start, point) < 5;
    const isLastEndpoint =
      index === routePlan.points.length - 1 && haversineMeters(destination, point) < 5;
    return !isFirstEndpoint && !isLastEndpoint;
  });
  const route = [start, ...interiorPoints, destination];
  const checkpointPoints = route.slice(1, -1);
  if (!checkpointPoints.length) {
    const destinationLocal = lonLatToLocalMeters(destination, start);
    checkpointPoints.push(
      localMetersToLonLat({ x: destinationLocal.x / 2, y: destinationLocal.y / 2 }, start),
    );
  }
  return {
    id,
    source: 'community',
    creatorHandle,
    kind: 'checkpoint-race',
    title: `Community race · ${title}`,
    areaKey: tileCellAt(start, ROOM_TILE_ZOOM).key,
    pickup: { id: `${id}:start`, name: `${title} start`, category: 'start', location: start },
    destination: {
      id: `${id}:finish`,
      name: `${title} finish`,
      category: 'finish',
      location: destination,
    },
    route: samplePoints(route, 24),
    checkpoints: samplePoints(checkpointPoints, maxCheckpoints),
    distanceMeters,
    minimumTimeSeconds: Math.max(10, Math.ceil(routePlan.travelTimeSeconds * 0.45)),
    timeLimitSeconds: Math.max(90, Math.ceil(routePlan.travelTimeSeconds * 2.2 + 45)),
    rewardCents: Math.min(10_000, Math.max(500, Math.round(500 + distanceMeters * 0.4))),
  };
}

export function generateMissionOffers(
  elements: readonly OsmElement[],
  location: LonLat,
  nowMs = Date.now(),
  mods: readonly MissionMod[] = [],
): readonly MissionOffer[] {
  const areaKey = tileCellAt(location, ROOM_TILE_ZOOM).key;
  const graph = buildRoadGraph(elements, location, 'vehicle');
  const places = collectPlaces(elements)
    .filter((place) => haversineMeters(location, place.location) <= MAX_PLACE_DISTANCE_METERS)
    .sort(
      (first, second) =>
        haversineMeters(location, first.location) - haversineMeters(location, second.location),
    )
    .slice(0, 12);
  const candidates = places.length >= 2 ? places : collectRoadPlaces(graph, location);
  if (candidates.length < 2) return [];

  const seed = new Date(nowMs).toISOString().slice(0, 10);
  const offers: MissionOffer[] = [];
  const usedPairs = new Set<string>();
  for (let index = 0; index < MISSION_KINDS.length && offers.length < MAX_OFFER_COUNT; index += 1) {
    const kind = MISSION_KINDS[index]!;
    let offer: MissionOffer | null = null;
    for (let shift = 0; shift < candidates.length && !offer; shift += 1) {
      const first = candidates[(index + shift) % candidates.length]!;
      for (let offset = 1; offset < candidates.length; offset += 1) {
        const second = candidates[(index + shift + offset) % candidates.length]!;
        const pairKey = `${first.id}|${second.id}`;
        if (first.id === second.id || usedPairs.has(pairKey)) continue;
        offer = createOffer(graph, first, second, kind, areaKey, seed);
        if (offer) usedPairs.add(pairKey);
        if (offer) break;
      }
    }
    if (offer) offers.push(offer);
  }

  if (offers.length < MAX_OFFER_COUNT && candidates.length >= 2) {
  for (const kind of HEAT_MISSION_KINDS) {
    if (offers.length >= MAX_OFFER_COUNT - 1) break;
    const offer = createHeatOffer(graph, kind, candidates, areaKey, seed);
    if (offer) offers.push(offer);
  }

    for (let index = 0; index < candidates.length && offers.length < MAX_OFFER_COUNT; index += 1) {
      const first = candidates[index]!;
      const second = candidates[(index + 1) % candidates.length]!;
      const kind = MISSION_KINDS[offers.length % MISSION_KINDS.length]!;
      const offer = createOffer(graph, first, second, kind, areaKey, seed);
      if (offer && !offers.some((existing) => existing.id === offer?.id)) offers.push(offer);
    }
  }

  for (const mod of mods) {
    for (const mission of mod.missions) {
      if (offers.length >= MAX_OFFER_COUNT + MAX_MOD_OFFER_COUNT) break;
      const matching = mission.placeCategories.length
        ? candidates.filter((place) => mission.placeCategories.includes(place.category))
        : candidates;
      const pickup = matching[0];
      const destination = candidates.find((place) => place.id !== pickup?.id);
      if (!pickup || !destination) continue;
      const offer = createOffer(graph, pickup, destination, mission.kind, areaKey, seed, {
        id: `mod-${mission.id}-${hash(`${seed}:${areaKey}:${mission.id}`)}`,
        title: mission.title,
        rewardCents: mission.rewardCents,
        rewardMultiplierScript: mission.rewardMultiplierScript,
        timeMultiplier: mission.timeMultiplier,
        timeLimitMultiplierScript: mission.timeLimitMultiplierScript,
        source: 'mod',
        creatorHandle: mod.name,
      });
      if (offer && !offers.some((existing) => existing.id === offer.id)) offers.push(offer);
    }
  }

  return offers;
}

function createHeatOffer(
  graph: RoadGraph,
  kind: MissionKind,
  candidates: readonly MissionPlace[],
  areaKey: string,
  seed: string,
): MissionOffer | null {
  const first = candidates[0];
  const second = candidates[1];
  if (!first || !second) return null;
  if (kind === 'getaway') {
    const base = createOffer(graph, first, second, kind, areaKey, seed);
    if (!base) return null;
    return {
      ...base,
      title: `Getaway · lose the heat near ${first.name}`,
      minimumTimeSeconds: GETAWAY_MINIMUM_TIME_SECONDS,
      timeLimitSeconds: GETAWAY_TIME_LIMIT_SECONDS,
      rewardCents: GETAWAY_REWARD_CENTS,
    };
  }
  if (kind === 'hot-delivery') {
    const base = createOffer(graph, first, second, kind, areaKey, seed);
    if (!base) return null;
    return {
      ...base,
      title: `Hot delivery · ${first.name} → ${second.name}`,
      rewardCents: Math.min(10_000, base.rewardCents * HOT_DELIVERY_REWARD_MULTIPLIER),
    };
  }
  const hideouts = candidates.filter(
    (place) => place.category === 'parking' || place.category === 'fuel',
  );
  const hideout = hideouts[0] ?? first;
  const anchor = candidates.find((place) => place.id !== hideout.id);
  if (!anchor) return null;
  const base = createOffer(graph, hideout, anchor, kind, areaKey, seed);
  if (!base) return null;
  return {
    ...base,
    pickup: hideout,
    destination: hideout,
    route: [hideout.location],
    checkpoints: [],
    distanceMeters: 0,
    title: `Lay low · hideout at ${hideout.name}`,
    minimumTimeSeconds: LAY_LOW_MINIMUM_TIME_SECONDS,
    timeLimitSeconds: LAY_LOW_TIME_LIMIT_SECONDS,
    rewardCents: LAY_LOW_REWARD_CENTS,
  };
}

interface OfferOverrides {
  readonly id: string;
  readonly title: string;
  readonly rewardCents?: number;
  readonly rewardMultiplierScript?: ModScript | null;
  readonly timeMultiplier?: number;
  readonly timeLimitMultiplierScript?: ModScript | null;
  readonly source?: 'mod';
  readonly creatorHandle?: string;
}

function createOffer(
  graph: RoadGraph,
  pickup: MissionPlace,
  destination: MissionPlace,
  kind: MissionKind,
  areaKey: string,
  seed: string,
  overrides?: OfferOverrides,
): MissionOffer | null {
  const start = nearestRoadNode(graph, pickup.location, ROAD_SNAP_DISTANCE_METERS);
  const end = nearestRoadNode(graph, destination.location, ROAD_SNAP_DISTANCE_METERS);
  if (!start || !end || start.node.id === end.node.id) return null;
  const roadRoute = findRoute(graph, start.node.id, end.node.id);
  if (
    !roadRoute ||
    roadRoute.distanceMeters < MIN_ROUTE_DISTANCE_METERS ||
    roadRoute.distanceMeters > MAX_ROUTE_DISTANCE_METERS
  ) {
    return null;
  }
  const scriptContext = {
    speedMetersPerSecond: 0,
    damageFraction: 0,
    distanceMeters: roadRoute.distanceMeters,
    elapsedSeconds: roadRoute.travelTimeSeconds,
    completedMissions: 0,
    placeCategory: destination.category,
  };
  const rewardMultiplier = clampMultiplier(
    runMultiplierScript(overrides?.rewardMultiplierScript, scriptContext),
    MIN_REWARD_MULTIPLIER,
    MAX_REWARD_MULTIPLIER,
  );
  const timeMultiplier = clampMultiplier(
    (overrides?.timeMultiplier ?? 1) *
      runMultiplierScript(overrides?.timeLimitMultiplierScript, scriptContext, 1),
    MIN_TIME_MULTIPLIER,
    MAX_TIME_MULTIPLIER,
  );
  const baseRewardCents =
    overrides?.rewardCents ?? Math.round(500 + roadRoute.distanceMeters * 0.4);
  return {
    id:
      overrides?.id ??
      `mission-${hash(`${seed}:${areaKey}:${kind}:${pickup.id}:${destination.id}`)}`,
    kind,
    source: overrides?.source,
    creatorHandle: overrides?.creatorHandle,
    title: overrides?.title ?? missionTitle(kind, pickup, destination),
    areaKey,
    pickup,
    destination,
    route: samplePoints(roadRoute.points, MAX_MISSION_ROUTE_POINTS),
    checkpoints: createCheckpoints(kind, roadRoute.points),
    distanceMeters: Math.round(roadRoute.distanceMeters),
    minimumTimeSeconds: Math.max(
      10,
      Math.ceil(roadRoute.travelTimeSeconds * 0.45 * timeMultiplier),
    ),
    timeLimitSeconds: Math.max(
      90,
      Math.ceil(roadRoute.travelTimeSeconds * 2.2 * timeMultiplier + 45),
    ),
    rewardCents:
      overrides?.rewardCents === undefined
        ? Math.min(10_000, Math.max(500, Math.round(baseRewardCents * rewardMultiplier)))
        : Math.min(
            10_000,
            Math.max(MIN_MOD_REWARD_CENTS, Math.round(baseRewardCents * rewardMultiplier)),
          ),
  };
}

function runMultiplierScript(
  script: ModScript | null | undefined,
  context: {
    readonly speedMetersPerSecond: number;
    readonly damageFraction: number;
    readonly distanceMeters: number;
    readonly elapsedSeconds: number;
    readonly completedMissions: number;
    readonly placeCategory: string;
  },
  fallback = 1,
): number {
  if (!script) return fallback;
  try {
    const result = script(context);
    return typeof result === 'number' && Number.isFinite(result) ? result : fallback;
  } catch {
    return fallback;
  }
}

function clampMultiplier(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function collectPlaces(elements: readonly OsmElement[]): MissionPlace[] {
  const nodes = new Map<string, OsmNodeElement>();
  const ways = new Map<string, OsmWayElement>();
  for (const element of elements) {
    if (element.type === 'node') nodes.set(String(element.id), element);
    else if (element.type === 'way') ways.set(String(element.id), element);
  }
  const places: MissionPlace[] = [];
  const seen = new Set<string>();
  for (const element of elements) {
    const tags = stringTags(element.tags);
    const category = placeCategory(tags);
    if (!category) continue;
    const place =
      element.type === 'node'
        ? nodePlace(element, category)
        : element.type === 'way'
          ? wayPlace(element, nodes, category)
          : relationPlace(element, ways, nodes, category);
    if (!place || seen.has(place.id)) continue;
    seen.add(place.id);
    places.push(place);
  }
  return places;
}

function stringTags(
  tags: Readonly<Record<string, string | undefined>> | undefined,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags ?? {})) {
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

function nodePlace(node: OsmNodeElement, category: string): MissionPlace {
  const location = { longitude: node.lon, latitude: node.lat };
  return {
    id: `node-${node.id}`,
    name: safePlaceName(node.tags?.name, category, node.id),
    category,
    location,
  };
}

function wayPlace(
  way: OsmWayElement,
  nodes: ReadonlyMap<string, OsmNodeElement>,
  category: string,
): MissionPlace | null {
  const location = centroid(wayPoints(way, nodes));
  if (!location) return null;
  return {
    id: `way-${way.id}`,
    name: safePlaceName(way.tags?.name, category, way.id),
    category,
    location,
  };
}

function relationPlace(
  relation: OsmRelationElement,
  ways: ReadonlyMap<string, OsmWayElement>,
  nodes: ReadonlyMap<string, OsmNodeElement>,
  category: string,
): MissionPlace | null {
  const outerWays = relation.members.filter(
    (member) => member.type === 'way' && (member.role === 'outer' || !member.role),
  );
  const memberWays = outerWays.length
    ? outerWays
    : relation.members.filter((member) => member.type === 'way');
  const points = memberWays.flatMap((member) => {
    const way = ways.get(String(member.ref));
    return way ? wayPoints(way, nodes) : [];
  });
  const location = centroid(points);
  if (!location) return null;
  return {
    id: `relation-${relation.id}`,
    name: safePlaceName(relation.tags?.name, category, relation.id),
    category,
    location,
  };
}

function wayPoints(way: OsmWayElement, nodes: ReadonlyMap<string, OsmNodeElement>): LonLat[] {
  const points = way.nodes
    .map((id) => nodes.get(String(id)))
    .filter((node): node is OsmNodeElement => Boolean(node))
    .map((node) => ({ longitude: node.lon, latitude: node.lat }));
  if (
    points.length > 2 &&
    points[0]?.longitude === points[points.length - 1]?.longitude &&
    points[0]?.latitude === points[points.length - 1]?.latitude
  ) {
    points.pop();
  }
  return points;
}

function centroid(points: readonly LonLat[]): LonLat | null {
  if (!points.length) return null;
  return points.reduce(
    (center, point) => ({
      longitude: center.longitude + point.longitude / points.length,
      latitude: center.latitude + point.latitude / points.length,
    }),
    { longitude: 0, latitude: 0 },
  );
}

function collectRoadPlaces(graph: RoadGraph, location: LonLat): MissionPlace[] {
  return [...graph.nodes.values()]
    .filter((node) => haversineMeters(location, node.location) <= MAX_PLACE_DISTANCE_METERS)
    .sort(
      (first, second) =>
        haversineMeters(location, first.location) - haversineMeters(location, second.location),
    )
    .slice(0, 16)
    .map((node, index) => ({
      id: `road-${node.id}`,
      name: index === 0 ? 'Nearby intersection' : `Street checkpoint ${index + 1}`,
      category: 'street',
      location: node.location,
    }));
}

function placeCategory(tags: Readonly<Record<string, string>>): string | null {
  if (tags.shop) return 'shop';
  if (
    tags.leisure === 'park' ||
    tags.leisure === 'playground' ||
    tags.leisure === 'sports_centre'
  ) {
    return 'park';
  }
  if (/^(school|college|university|kindergarten)$/u.test(tags.amenity ?? '')) return 'school';
  if (/^(restaurant|cafe|fast_food|pub|bar)$/u.test(tags.amenity ?? '')) return 'restaurant';
  if (/^(hospital|clinic|pharmacy|bank|fuel|marketplace)$/u.test(tags.amenity ?? '')) {
    return tags.amenity === 'fuel' ? 'fuel station' : (tags.amenity ?? 'place');
  }
  if (tags.tourism === 'museum' || tags.tourism === 'attraction') return 'attraction';
  return null;
}

function safePlaceName(value: string | undefined, category: string, id: number | string): string {
  const normalized = value
    ?.replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .slice(0, 72);
  return normalized || `${titleCase(category)} ${String(id).slice(-5)}`;
}

function missionTitle(kind: MissionKind, pickup: MissionPlace, destination: MissionPlace): string {
  const prefix = {
    delivery: 'Delivery',
    taxi: 'Taxi fare',
    'time-trial': 'Time trial',
    'checkpoint-race': 'Checkpoint race',
    getaway: 'Getaway',
    'hot-delivery': 'Hot delivery',
    'lay-low': 'Lay low',
  }[kind];
  return `${prefix} · ${pickup.name} → ${destination.name}`;
}

function createCheckpoints(kind: MissionKind, route: readonly LonLat[]): readonly LonLat[] {
  if ((kind !== 'time-trial' && kind !== 'checkpoint-race') || route.length < 2) return [];
  const interior = route.slice(1, -1);
  return samplePoints(interior.length ? interior : [route.at(-1)!], 3);
}

function samplePoints(points: readonly LonLat[], maximum: number): readonly LonLat[] {
  if (points.length <= maximum) return points.map((point) => ({ ...point }));
  return Array.from({ length: maximum }, (_, index) => {
    const point = points[Math.round((index * (points.length - 1)) / (maximum - 1))]!;
    return { ...point };
  });
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function hash(value: string): string {
  let result = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16_777_619);
  }
  return (result >>> 0).toString(36);
}
