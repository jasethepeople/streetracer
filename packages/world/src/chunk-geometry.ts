import earcut from 'earcut';
import type { LonLat } from '@openstreet-racer/shared';
import { lonLatToLocalMeters } from './geo';
import type { TileCell } from './tiles';

export const MAX_CHUNK_TRIANGLES = 15_000;

export type WorldPosition = readonly [longitude: number, latitude: number];
export type WorldGeometry =
  | { readonly type: 'LineString'; readonly coordinates: readonly WorldPosition[] }
  | {
      readonly type: 'MultiLineString';
      readonly coordinates: readonly (readonly WorldPosition[])[];
    }
  | { readonly type: 'Polygon'; readonly coordinates: readonly (readonly WorldPosition[])[] }
  | {
      readonly type: 'MultiPolygon';
      readonly coordinates: readonly (readonly (readonly WorldPosition[])[])[];
    }
  | {
      readonly type: 'Point' | 'MultiPoint' | 'GeometryCollection';
      readonly coordinates?: unknown;
    };

export interface WorldFeature {
  readonly id: string;
  readonly layer: string;
  readonly properties: Readonly<Record<string, string | number | boolean | null>>;
  readonly geometry: WorldGeometry;
}

export interface ChunkMeshData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

export interface ChunkGeometry {
  readonly ground: ChunkMeshData;
  readonly roads: ChunkMeshData;
  readonly markings: ChunkMeshData;
  readonly buildings: ChunkMeshData;
  readonly greens: ChunkMeshData;
  readonly waters: ChunkMeshData;
  readonly triangles: number;
}

interface MeshBuilder {
  positions: number[];
  indices: number[];
}

export function createChunkGeometry(
  cell: Pick<TileCell, 'center' | 'halfSizeMeters'>,
  features: readonly WorldFeature[],
  triangleLimit = MAX_CHUNK_TRIANGLES,
): ChunkGeometry {
  const limit = Math.max(2, Math.min(MAX_CHUNK_TRIANGLES, Math.trunc(triangleLimit)));
  const meshes = {
    ground: builder(),
    roads: builder(),
    markings: builder(),
    buildings: builder(),
    greens: builder(),
    waters: builder(),
  };
  const roadBudget = Math.floor((limit - 2) * 0.48);
  const buildingBudget = Math.floor((limit - 2) * 0.34);
  const markingBudget = Math.floor((limit - 2) * 0.08);
  let roadTriangles = 0;
  let markingTriangles = 0;
  let buildingTriangles = 0;
  const half = cell.halfSizeMeters;
  const groundBase = addQuad(
    meshes.ground,
    [-half, -half],
    [-half, half],
    [half, half],
    [half, -half],
    -0.12,
  );
  const polygonFeatures = features.filter((feature) => isPolygonGeometry(feature.geometry));
  const roadFeatures = features.filter((feature) => feature.layer === 'transportation');

  for (const feature of roadFeatures) {
    if (roadTriangles >= roadBudget) break;
    const width = roadWidthMeters(feature.properties);
    const roadClass = stringValue(feature.properties.class ?? feature.properties.subclass);
    const markRoad = shouldMarkRoad(roadClass, feature.properties);
    for (const line of lineParts(feature.geometry)) {
      const points = localPoints(line, cell.center, half);
      for (
        let index = 0;
        index + 1 < points.length && roadTriangles + 2 <= roadBudget;
        index += 1
      ) {
        const first = points[index];
        const second = points[index + 1];
        const dx = second[0] - first[0];
        const dz = second[1] - first[1];
        const length = Math.hypot(dx, dz);
        if (length < 0.15) continue;
        const offsetX = (-dz / length) * width * 0.5;
        const offsetZ = (dx / length) * width * 0.5;
        roadTriangles += addQuad(
          meshes.roads,
          [first[0] + offsetX, first[1] + offsetZ],
          [first[0] - offsetX, first[1] - offsetZ],
          [second[0] - offsetX, second[1] - offsetZ],
          [second[0] + offsetX, second[1] + offsetZ],
          -0.025,
        );
      }
      if (markRoad && markingTriangles + 2 <= markingBudget) {
        markingTriangles += addDashedCenterLine(
          meshes.markings,
          points,
          markingBudget - markingTriangles,
        );
      }
    }
  }

  let triangles = groundBase + roadTriangles + markingTriangles;
  const prioritizedPolygons = [
    ...polygonFeatures.filter((feature) => feature.layer === 'building'),
    ...polygonFeatures.filter((feature) => feature.layer !== 'building'),
  ];

  for (const feature of prioritizedPolygons) {
    if (triangles >= limit) break;
    const polygons = polygonParts(feature.geometry);
    if (feature.layer === 'building') {
      const height = buildingHeight(feature.properties, feature.id);
      const minHeight = buildingMinHeight(feature.properties, height);
      for (const polygon of polygons) {
        if (buildingTriangles >= buildingBudget) break;
        const positionsBefore = meshes.buildings.positions.length;
        const indicesBefore = meshes.buildings.indices.length;
        const count = addExtrudedPolygon(
          meshes.buildings,
          polygon,
          cell.center,
          half,
          minHeight,
          height,
        );
        if (buildingTriangles + count > buildingBudget || triangles + count > limit) {
          meshes.buildings.positions.length = positionsBefore;
          meshes.buildings.indices.length = indicesBefore;
          continue;
        }
        triangles += count;
        buildingTriangles += count;
      }
      continue;
    }

    const target = feature.layer === 'water' ? meshes.waters : meshes.greens;
    const height = feature.layer === 'water' ? -0.055 : -0.085;
    for (const polygon of polygons) {
      const positionsBefore = target.positions.length;
      const indicesBefore = target.indices.length;
      const count = addPolygonSurface(target, polygon, cell.center, half, height);
      if (triangles + count > limit) {
        target.positions.length = positionsBefore;
        target.indices.length = indicesBefore;
        continue;
      }
      triangles += count;
    }
  }

  for (const feature of features) {
    if (triangles >= limit) break;
    if (feature.layer !== 'waterway') continue;
    for (const line of lineParts(feature.geometry)) {
      const points = localPoints(line, cell.center, half);
      for (let index = 0; index + 1 < points.length && triangles + 2 <= limit; index += 1) {
        const first = points[index];
        const second = points[index + 1];
        const dx = second[0] - first[0];
        const dz = second[1] - first[1];
        const length = Math.hypot(dx, dz);
        if (length < 0.15) continue;
        const offsetX = (-dz / length) * 1.8;
        const offsetZ = (dx / length) * 1.8;
        triangles += addQuad(
          meshes.waters,
          [first[0] + offsetX, first[1] + offsetZ],
          [first[0] - offsetX, first[1] - offsetZ],
          [second[0] - offsetX, second[1] - offsetZ],
          [second[0] + offsetX, second[1] + offsetZ],
          -0.05,
        );
      }
    }
  }

  return {
    ground: finalize(meshes.ground),
    roads: finalize(meshes.roads),
    markings: finalize(meshes.markings),
    buildings: finalize(meshes.buildings),
    greens: finalize(meshes.greens),
    waters: finalize(meshes.waters),
    triangles,
  };
}

export function roadWidthMeters(properties: WorldFeature['properties']): number {
  const roadClass = stringValue(properties.class ?? properties.subclass).toLowerCase();
  const base =
    roadClass === 'motorway' || roadClass === 'trunk'
      ? 13
      : roadClass === 'primary'
        ? 10
        : roadClass === 'secondary'
          ? 8.5
          : roadClass === 'tertiary'
            ? 7
            : roadClass === 'residential' || roadClass === 'living_street'
              ? 6
              : roadClass === 'service' || roadClass === 'track'
                ? 4
                : 5.5;
  const lanes = finiteNumber(properties.lanes);
  return Math.min(22, Math.max(3.2, lanes ? lanes * 3.2 : base));
}

function shouldMarkRoad(roadClass: string, properties: WorldFeature['properties']): boolean {
  const laneCount = finiteNumber(properties.lanes);
  return (
    (laneCount !== null && laneCount >= 2) ||
    [
      'motorway',
      'trunk',
      'primary',
      'secondary',
      'tertiary',
      'residential',
      'living_street',
      'unclassified',
    ].includes(roadClass)
  );
}

function addDashedCenterLine(
  mesh: MeshBuilder,
  points: readonly (readonly [number, number])[],
  triangleLimit: number,
): number {
  const dashLength = 3.2;
  const period = 7.5;
  const halfWidth = 0.07;
  let distance = 0;
  let triangles = 0;

  for (let index = 0; index + 1 < points.length; index += 1) {
    if (triangles + 2 > triangleLimit) break;
    const first = points[index];
    const second = points[index + 1];
    if (!first || !second) continue;
    const dx = second[0] - first[0];
    const dz = second[1] - first[1];
    const length = Math.hypot(dx, dz);
    if (length < 0.15) continue;

    let offset = 0;
    while (offset < length && triangles + 2 <= triangleLimit) {
      const phase = (distance + offset) % period;
      const visible = phase < dashLength;
      const interval = Math.min(length - offset, visible ? dashLength - phase : period - phase);
      if (visible && interval > 0.15) {
        const startRatio = offset / length;
        const endRatio = (offset + interval) / length;
        const start: [number, number] = [first[0] + dx * startRatio, first[1] + dz * startRatio];
        const end: [number, number] = [first[0] + dx * endRatio, first[1] + dz * endRatio];
        const normalX = (-dz / length) * halfWidth;
        const normalZ = (dx / length) * halfWidth;
        triangles += addQuad(
          mesh,
          [start[0] + normalX, start[1] + normalZ],
          [start[0] - normalX, start[1] - normalZ],
          [end[0] - normalX, end[1] - normalZ],
          [end[0] + normalX, end[1] + normalZ],
          -0.015,
        );
      }
      offset += Math.max(interval, 0.1);
    }
    distance += length;
  }

  return triangles;
}

function buildingHeight(properties: WorldFeature['properties'], id: string): number {
  const tagged = metersValue(properties.height);
  if (tagged) return Math.min(80, tagged);
  const levels = positiveNumber(properties['building:levels'] ?? properties.levels);
  if (levels) return Math.min(80, levels * 3.1);
  const rendered = metersValue(properties.render_height);
  if (rendered && rendered >= 5) return Math.min(80, rendered);
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return 5 + ((hash >>> 0) % 21);
}

function buildingMinHeight(properties: WorldFeature['properties'], height: number): number {
  const tagged = metersValue(properties.render_min_height ?? properties.min_height);
  return Math.min(height - 0.5, tagged ?? 0);
}

function metersValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*(m|meter|meters|ft|feet|')?$/i);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 0) return null;
  return match[2]?.toLowerCase().startsWith('f') || match[2] === "'" ? number * 0.3048 : number;
}

function positiveNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function lineParts(geometry: WorldGeometry): readonly (readonly WorldPosition[])[] {
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

function polygonParts(geometry: WorldGeometry): readonly (readonly (readonly WorldPosition[])[])[] {
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function isPolygonGeometry(geometry: WorldGeometry): boolean {
  return geometry.type === 'Polygon' || geometry.type === 'MultiPolygon';
}

function localPoints(
  positions: readonly WorldPosition[],
  origin: LonLat,
  half: number,
): [number, number][] {
  const points: [number, number][] = [];
  for (const [longitude, latitude] of positions) {
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
    const local = lonLatToLocalMeters({ longitude, latitude }, origin);
    points.push([clamp(local.x, -half, half), clamp(-local.y, -half, half)]);
  }
  return points;
}

function addPolygonSurface(
  mesh: MeshBuilder,
  rings: readonly (readonly WorldPosition[])[],
  origin: LonLat,
  half: number,
  height: number,
): number {
  if (!rings.length) return 0;
  const localRings = rings.map((ring) => localPoints(ring, origin, half));
  const flat = localRings.flatMap((ring) => ring.flatMap(([x, z]) => [x, -z]));
  const holes: number[] = [];
  let pointCount = localRings[0].length;
  for (let index = 1; index < localRings.length; index += 1) {
    holes.push(pointCount);
    pointCount += localRings[index].length;
  }
  const triangles = earcut(flat, holes, 2);
  if (triangles.length < 3) return 0;
  const vertexStart = mesh.positions.length / 3;
  for (const ring of localRings) {
    for (const [x, z] of ring) mesh.positions.push(x, height, z);
  }
  for (const triangle of triangles) mesh.indices.push(vertexStart + triangle);
  return triangles.length / 3;
}

function addExtrudedPolygon(
  mesh: MeshBuilder,
  rings: readonly (readonly WorldPosition[])[],
  origin: LonLat,
  half: number,
  minHeight: number,
  height: number,
): number {
  const startPositions = mesh.positions.length;
  const startIndices = mesh.indices.length;
  let triangles = addPolygonSurface(mesh, rings, origin, half, height);
  if (triangles === 0) return 0;
  for (const ring of rings) {
    const points = localPoints(ring, origin, half);
    const segmentCount = points.length > 2 ? points.length - 1 : 0;
    for (let index = 0; index < segmentCount; index += 1) {
      const first = points[index];
      const second = points[index + 1];
      const base = mesh.positions.length / 3;
      mesh.positions.push(
        first[0],
        minHeight,
        first[1],
        second[0],
        minHeight,
        second[1],
        second[0],
        height,
        second[1],
        first[0],
        height,
        first[1],
      );
      mesh.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      triangles += 2;
    }
  }
  const addedTriangles = triangles;
  if (mesh.positions.length === startPositions) mesh.positions.length = startPositions;
  if (mesh.indices.length === startIndices) mesh.indices.length = startIndices;
  return addedTriangles;
}

function addQuad(
  mesh: MeshBuilder,
  first: readonly [number, number],
  second: readonly [number, number],
  third: readonly [number, number],
  fourth: readonly [number, number],
  height: number,
): number {
  const base = mesh.positions.length / 3;
  mesh.positions.push(
    first[0],
    height,
    first[1],
    second[0],
    height,
    second[1],
    third[0],
    height,
    third[1],
    fourth[0],
    height,
    fourth[1],
  );
  mesh.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  return 2;
}

function builder(): MeshBuilder {
  return { positions: [], indices: [] };
}

function finalize(mesh: MeshBuilder): ChunkMeshData {
  const positions = new Float32Array(mesh.positions);
  const indices = new Uint32Array(mesh.indices);
  const normals = new Float32Array(positions.length);
  for (let index = 0; index + 2 < indices.length; index += 3) {
    const first = indices[index] * 3;
    const second = indices[index + 1] * 3;
    const third = indices[index + 2] * 3;
    const abx = positions[second] - positions[first];
    const aby = positions[second + 1] - positions[first + 1];
    const abz = positions[second + 2] - positions[first + 2];
    const acx = positions[third] - positions[first];
    const acy = positions[third + 1] - positions[first + 1];
    const acz = positions[third + 2] - positions[first + 2];
    const normalX = aby * acz - abz * acy;
    const normalY = abz * acx - abx * acz;
    const normalZ = abx * acy - aby * acx;
    for (const vertex of [first, second, third]) {
      normals[vertex] += normalX;
      normals[vertex + 1] += normalY;
      normals[vertex + 2] += normalZ;
    }
  }
  for (let index = 0; index + 2 < normals.length; index += 3) {
    const length = Math.hypot(normals[index], normals[index + 1], normals[index + 2]) || 1;
    normals[index] /= length;
    normals[index + 1] /= length;
    normals[index + 2] /= length;
  }
  return { positions, normals, indices };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
