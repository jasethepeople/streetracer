import type { LonLat, Point2 } from '@openstreet-racer/shared';
import { haversineMeters, lonLatToLocalMeters } from './geo';

export type OsmElement = OsmNodeElement | OsmWayElement | OsmRelationElement;

export interface OsmNodeElement {
  readonly type: 'node';
  readonly id: number | string;
  readonly lat: number;
  readonly lon: number;
  readonly tags?: Readonly<Record<string, string | undefined>>;
}

export interface OsmWayElement {
  readonly type: 'way';
  readonly id: number | string;
  readonly nodes: readonly (number | string)[];
  readonly tags?: Readonly<Record<string, string | undefined>>;
}

export interface OsmRelationMember {
  readonly type: 'node' | 'way' | 'relation';
  readonly ref: number | string;
  readonly role?: string;
}

export interface OsmRelationElement {
  readonly type: 'relation';
  readonly id: number | string;
  readonly members: readonly OsmRelationMember[];
  readonly tags?: Readonly<Record<string, string | undefined>>;
}

export type GraphMode = 'vehicle' | 'pedestrian';
export type RoadControl = 'traffic-signal' | 'stop-sign';

export interface RoadGraphNode {
  readonly id: string;
  readonly location: LonLat;
  readonly position: Point2;
  readonly tags: Readonly<Record<string, string>>;
  readonly control: RoadControl | null;
  readonly intersection: boolean;
}

export interface RoadGraphEdge {
  readonly id: string;
  readonly wayId: string;
  readonly from: string;
  readonly to: string;
  readonly lengthMeters: number;
  readonly speedLimitMetersPerSecond: number;
  readonly roadClass: string;
  readonly direction: 'forward' | 'backward';
  readonly oneWay: boolean;
}

export interface RoadGraph {
  readonly origin: LonLat;
  readonly mode: GraphMode;
  readonly nodes: ReadonlyMap<string, RoadGraphNode>;
  readonly edges: readonly RoadGraphEdge[];
  readonly outgoing: ReadonlyMap<string, readonly RoadGraphEdge[]>;
}

export const DEFAULT_SPEED_METERS_PER_SECOND: Readonly<Record<string, number>> = {
  motorway: 33.3,
  motorway_link: 16.7,
  trunk: 27.8,
  trunk_link: 16.7,
  primary: 22.2,
  primary_link: 16.7,
  secondary: 19.4,
  secondary_link: 13.9,
  tertiary: 16.7,
  tertiary_link: 11.1,
  unclassified: 13.9,
  residential: 13.9,
  living_street: 5.6,
  service: 8.3,
  track: 8.3,
  road: 11.1,
  raceway: 22.2,
  bus_guideway: 13.9,
};

const PEDESTRIAN_CLASSES = new Set([
  'footway',
  'pedestrian',
  'path',
  'steps',
  'cycleway',
  'bridleway',
]);

export function buildRoadGraph(
  elements: readonly OsmElement[],
  origin: LonLat,
  mode: GraphMode = 'vehicle',
): RoadGraph {
  const osmNodes = new Map<string, OsmNodeElement>();
  const wayElements = new Map<string, OsmWayElement>();
  for (const element of elements) {
    if (element.type === 'node') {
      if (Number.isFinite(element.lat) && Number.isFinite(element.lon)) {
        osmNodes.set(String(element.id), element);
      }
    } else if (element.type === 'way') {
      wayElements.set(String(element.id), element);
    }
  }

  const candidates: CandidateEdge[] = [];
  const incidentWays = new Map<string, Set<string>>();
  const incidentSegments = new Map<string, number>();
  const graphNodeTags = new Map<string, Readonly<Record<string, string>>>();

  for (const way of wayElements.values()) {
    const tags = cleanTags(way.tags);
    const highway = tags.highway;
    if (!highway || !isIncludedWay(tags, mode)) continue;
    const wayId = String(way.id);
    const direction = oneWayDirection(tags, mode);
    const forwardSpeed = speedForWay(tags, highway, 'forward', mode);
    const backwardSpeed = speedForWay(tags, highway, 'backward', mode);
    const nodes = way.nodes.map(String);
    for (let index = 0; index < nodes.length - 1; index += 1) {
      const from = nodes[index];
      const to = nodes[index + 1];
      const fromNode = osmNodes.get(from);
      const toNode = osmNodes.get(to);
      if (!fromNode || !toNode || from === to) continue;
      const fromLocation = { longitude: fromNode.lon, latitude: fromNode.lat };
      const toLocation = { longitude: toNode.lon, latitude: toNode.lat };
      const lengthMeters = haversineMeters(fromLocation, toLocation);
      if (!Number.isFinite(lengthMeters) || lengthMeters < 0.2 || lengthMeters > 2_000) continue;
      candidates.push({
        wayId,
        from,
        to,
        lengthMeters,
        forwardSpeedLimitMetersPerSecond: forwardSpeed,
        backwardSpeedLimitMetersPerSecond: backwardSpeed,
        roadClass: highway,
        direction,
      });
      for (const nodeId of [from, to]) {
        const ways = incidentWays.get(nodeId) ?? new Set<string>();
        ways.add(wayId);
        incidentWays.set(nodeId, ways);
        incidentSegments.set(nodeId, (incidentSegments.get(nodeId) ?? 0) + 1);
      }
    }
    for (const nodeId of nodes) {
      const node = osmNodes.get(nodeId);
      if (node && Object.keys(node.tags ?? {}).length > 0) {
        graphNodeTags.set(nodeId, cleanTags(node.tags));
      }
    }
  }

  const nodes = new Map<string, RoadGraphNode>();
  const edges: RoadGraphEdge[] = [];
  const outgoing = new Map<string, RoadGraphEdge[]>();
  for (const candidate of candidates) {
    for (const nodeId of [candidate.from, candidate.to]) {
      if (nodes.has(nodeId)) continue;
      const raw = osmNodes.get(nodeId);
      if (!raw) continue;
      const location = { longitude: raw.lon, latitude: raw.lat };
      const tags = graphNodeTags.get(nodeId) ?? cleanTags(raw.tags);
      nodes.set(nodeId, {
        id: nodeId,
        location,
        position: lonLatToLocalMeters(location, origin),
        tags,
        control: getRoadControl(tags),
        intersection:
          (incidentWays.get(nodeId)?.size ?? 0) > 1 || (incidentSegments.get(nodeId) ?? 0) > 2,
      });
    }
    if (candidate.direction !== 'backward') {
      addDirectedEdge(candidate, 'forward', nodes, edges, outgoing);
    }
    if (candidate.direction !== 'forward') {
      addDirectedEdge(candidate, 'backward', nodes, edges, outgoing);
    }
  }

  return {
    origin: { ...origin },
    mode,
    nodes,
    edges,
    outgoing,
  };
}

export function parseMaxspeed(value: string | undefined, fallbackMetersPerSecond: number): number {
  if (!value) return fallbackMetersPerSecond;
  const normalized = value.trim().toLowerCase().split(';')[0].trim();
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(km\/h|kmh|kph|mph)?$/);
  if (!match) return fallbackMetersPerSecond;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 1 || amount > 200) return fallbackMetersPerSecond;
  const metersPerSecond = match[2] === 'mph' ? amount * 0.44704 : amount / 3.6;
  return Math.min(55, Math.max(1, metersPerSecond));
}

function isIncludedWay(tags: Readonly<Record<string, string>>, mode: GraphMode): boolean {
  const highway = tags.highway;
  if (!highway || ['no', 'private'].includes(tags.access ?? '')) return false;
  if (mode === 'vehicle') {
    if (
      [tags.vehicle, tags.motor_vehicle, tags.motorcar].some((value) =>
        ['no', 'private'].includes(value ?? ''),
      )
    ) {
      return false;
    }
    return highway in DEFAULT_SPEED_METERS_PER_SECOND;
  }
  if (['no', 'private'].includes(tags.foot ?? '')) return false;
  if (PEDESTRIAN_CLASSES.has(highway)) return true;
  return Boolean(tags.sidewalk && !['no', 'none', 'separate'].includes(tags.sidewalk));
}

function speedForWay(
  tags: Readonly<Record<string, string>>,
  highway: string,
  direction: 'forward' | 'backward',
  mode: GraphMode,
): number {
  if (mode === 'pedestrian') return 1.4;
  const defaultSpeed = DEFAULT_SPEED_METERS_PER_SECOND[highway] ?? 11.1;
  const directional =
    direction === 'forward' ? tags['maxspeed:forward'] : tags['maxspeed:backward'];
  return parseMaxspeed(directional ?? tags.maxspeed, defaultSpeed);
}

function oneWayDirection(
  tags: Readonly<Record<string, string>>,
  mode: GraphMode,
): 'forward' | 'backward' | 'both' {
  const value = (
    mode === 'pedestrian'
      ? tags['oneway:foot']
      : (tags['oneway:motor_vehicle'] ?? tags['oneway:vehicle'] ?? tags.oneway)
  )?.toLowerCase();
  if (value === '-1') return 'backward';
  if (['yes', 'true', '1'].includes(value ?? '')) return 'forward';
  if (mode === 'vehicle' && ['roundabout', 'circular'].includes(tags.junction ?? '')) {
    return 'forward';
  }
  return 'both';
}

function getRoadControl(tags: Readonly<Record<string, string>>): RoadControl | null {
  if (tags.highway === 'traffic_signals' || tags.crossing === 'traffic_signals') {
    return 'traffic-signal';
  }
  if (tags.highway === 'stop' || tags.traffic_sign === 'stop') return 'stop-sign';
  return null;
}

function cleanTags(
  tags: Readonly<Record<string, string | undefined>> | undefined,
): Readonly<Record<string, string>> {
  if (!tags) return {};
  return Object.fromEntries(
    Object.entries(tags).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

interface CandidateEdge {
  readonly wayId: string;
  readonly from: string;
  readonly to: string;
  readonly lengthMeters: number;
  readonly forwardSpeedLimitMetersPerSecond: number;
  readonly backwardSpeedLimitMetersPerSecond: number;
  readonly roadClass: string;
  readonly direction: 'forward' | 'backward' | 'both';
}

function addDirectedEdge(
  candidate: CandidateEdge,
  direction: 'forward' | 'backward',
  nodes: ReadonlyMap<string, RoadGraphNode>,
  edges: RoadGraphEdge[],
  outgoing: Map<string, RoadGraphEdge[]>,
): void {
  const from = direction === 'forward' ? candidate.from : candidate.to;
  const to = direction === 'forward' ? candidate.to : candidate.from;
  if (!nodes.has(from) || !nodes.has(to)) return;
  const edge: RoadGraphEdge = {
    id: `${candidate.wayId}:${from}>${to}`,
    wayId: candidate.wayId,
    from,
    to,
    lengthMeters: candidate.lengthMeters,
    speedLimitMetersPerSecond:
      direction === 'forward'
        ? candidate.forwardSpeedLimitMetersPerSecond
        : candidate.backwardSpeedLimitMetersPerSecond,
    roadClass: candidate.roadClass,
    direction,
    oneWay: candidate.direction !== 'both',
  };
  edges.push(edge);
  const outgoingEdges = outgoing.get(from) ?? [];
  outgoingEdges.push(edge);
  outgoing.set(from, outgoingEdges);
}
