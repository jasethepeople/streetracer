import type { LonLat } from '@openstreet-racer/shared';
import { lonLatToLocalMeters } from './geo';
import type { RoadGraph, RoadGraphEdge, RoadGraphNode } from './road-graph';

export interface RoadRoute {
  readonly nodeIds: readonly string[];
  readonly edges: readonly RoadGraphEdge[];
  readonly points: readonly LonLat[];
  readonly distanceMeters: number;
  readonly travelTimeSeconds: number;
}

export interface RouteSnap {
  readonly node: RoadGraphNode;
  readonly distanceMeters: number;
}

export function nearestRoadNode(
  graph: RoadGraph,
  location: LonLat,
  maxDistanceMeters = 1_500,
): RouteSnap | null {
  const connected = new Set<string>();
  for (const edge of graph.edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }

  let nearest: RouteSnap | null = null;
  for (const node of graph.nodes.values()) {
    if (!connected.has(node.id)) continue;
    const offset = lonLatToLocalMeters(node.location, location);
    const distanceMeters = Math.hypot(offset.x, offset.y);
    if (
      distanceMeters > maxDistanceMeters ||
      (nearest && distanceMeters >= nearest.distanceMeters)
    ) {
      continue;
    }
    nearest = { node, distanceMeters };
  }
  return nearest;
}

export function findRoute(
  graph: RoadGraph,
  startNodeId: string,
  destinationNodeId: string,
): RoadRoute | null {
  if (!graph.nodes.has(startNodeId) || !graph.nodes.has(destinationNodeId)) return null;
  if (startNodeId === destinationNodeId) {
    const node = graph.nodes.get(startNodeId)!;
    return {
      nodeIds: [startNodeId],
      edges: [],
      points: [node.location],
      distanceMeters: 0,
      travelTimeSeconds: 0,
    };
  }

  const fastestSpeed = graph.edges.reduce(
    (maximum, edge) => Math.max(maximum, edge.speedLimitMetersPerSecond),
    1,
  );
  const open = new MinHeap();
  const cameFrom = new Map<string, RoadGraphEdge>();
  const costTo = new Map<string, number>([[startNodeId, 0]]);
  const start = graph.nodes.get(startNodeId)!;
  const destination = graph.nodes.get(destinationNodeId)!;
  open.push({
    id: startNodeId,
    score: heuristic(start.location, destination.location, fastestSpeed),
  });
  const visited = new Set<string>();

  while (open.size > 0) {
    const current = open.pop()!;
    if (visited.has(current.id)) continue;
    if (current.id === destinationNodeId) break;
    visited.add(current.id);
    const currentCost = costTo.get(current.id);
    if (currentCost === undefined) continue;

    for (const edge of graph.outgoing.get(current.id) ?? []) {
      const speed = Math.max(0.1, edge.speedLimitMetersPerSecond);
      const nextCost = currentCost + edge.lengthMeters / speed;
      if (nextCost >= (costTo.get(edge.to) ?? Number.POSITIVE_INFINITY)) continue;
      costTo.set(edge.to, nextCost);
      cameFrom.set(edge.to, edge);
      const nextNode = graph.nodes.get(edge.to);
      if (!nextNode) continue;
      open.push({
        id: edge.to,
        score: nextCost + heuristic(nextNode.location, destination.location, fastestSpeed),
      });
    }
  }

  const travelTimeSeconds = costTo.get(destinationNodeId);
  if (travelTimeSeconds === undefined) return null;

  const reversedEdges: RoadGraphEdge[] = [];
  let cursor = destinationNodeId;
  while (cursor !== startNodeId) {
    const edge = cameFrom.get(cursor);
    if (!edge) return null;
    reversedEdges.push(edge);
    cursor = edge.from;
  }
  const edges = reversedEdges.reverse();
  const nodeIds = [startNodeId, ...edges.map((edge) => edge.to)];
  const distanceMeters = edges.reduce((total, edge) => total + edge.lengthMeters, 0);
  return {
    nodeIds,
    edges,
    points: nodeIds.map((id) => graph.nodes.get(id)!.location),
    distanceMeters,
    travelTimeSeconds,
  };
}

function heuristic(first: LonLat, second: LonLat, fastestSpeed: number): number {
  const offset = lonLatToLocalMeters(second, first);
  return Math.hypot(offset.x, offset.y) / fastestSpeed;
}

interface HeapItem {
  readonly id: string;
  readonly score: number;
}

class MinHeap {
  private readonly values: HeapItem[] = [];

  get size(): number {
    return this.values.length;
  }

  push(item: HeapItem): void {
    this.values.push(item);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.values[parent].score <= item.score) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = item;
  }

  pop(): HeapItem | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (!first || !last || this.values.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.values.length) break;
      let child = left;
      if (right < this.values.length && this.values[right].score < this.values[left].score)
        child = right;
      if (this.values[child].score >= last.score) break;
      this.values[index] = this.values[child];
      index = child;
    }
    this.values[index] = last;
    return first;
  }
}
