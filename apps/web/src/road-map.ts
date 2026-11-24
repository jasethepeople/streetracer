import {
  Map as MapLibreMap,
  setWorkerUrl,
  type GeoJSONSource,
  type MapGeoJSONFeature,
  type MapOptions,
} from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { lonLatToLocalMeters, nearestPointOnRoad } from '@openstreet-racer/world';
import type { LonLat, PoliceUnitState } from '@openstreet-racer/shared';
import { OPENFREEMAP_STYLE_URL } from '@openstreet-racer/shared';
import 'maplibre-gl/dist/maplibre-gl.css';

setWorkerUrl(workerUrl);

const ROAD_LAYER_ID = 'osr-road-query';
const STREET_LABEL_LAYERS = ['highway-name-major', 'highway-name-minor', 'highway-name-path'];
const DRIVABLE_CLASSES = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'minor',
  'service',
  'residential',
  'living_street',
  'unclassified',
  'road',
];

export class GameMap {
  private readonly map: MapLibreMap;
  private loaded = false;
  private lastCamera: { longitude: number; latitude: number; bearing: number } | null = null;
  private lastUpdateAt = 0;
  private routePoints: readonly LonLat[] = [];
  private pursuitUnits: readonly PoliceUnitState[] = [];

  constructor(container: HTMLElement, onLoad: () => void, onError: (message: string) => void) {
    const options: MapOptions = {
      container,
      style: OPENFREEMAP_STYLE_URL,
      center: [-104.9903, 39.7392],
      zoom: 15.1,
      pitch: 0,
      attributionControl: false,
      interactive: false,
      maxZoom: 19,
    };
    this.map = new MapLibreMap(options);
    this.map.once('load', () => {
      this.map.resize();
      this.addRoadQueryLayer();
      this.addRouteLayer();
      this.addPursuitLayer();
      this.loaded = true;
      this.syncRouteLayer();
      this.syncPursuitLayer();
      onLoad();
    });
    window.addEventListener('resize', () => this.map.resize());
    this.map.on('error', () => onError('Map tiles are having trouble loading.'));
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  setRoute(points: readonly LonLat[] | null): void {
    this.routePoints = points ?? [];
    this.syncRouteLayer();
  }

  setPursuit(units: readonly PoliceUnitState[]): void {
    this.pursuitUnits = units;
    this.syncPursuitLayer();
  }

  follow(location: LonLat, headingDegrees: number): void {
    if (!this.loaded) return;
    const now = performance.now();
    const last = this.lastCamera;
    const moved =
      !last ||
      Math.abs(location.longitude - last.longitude) > 0.000015 ||
      Math.abs(location.latitude - last.latitude) > 0.000015;
    const turned = !last || Math.abs(headingDegrees - last.bearing) > 1.5;
    if (now - this.lastUpdateAt < 120 || (!moved && !turned)) return;
    this.map.jumpTo({ center: [location.longitude, location.latitude], bearing: headingDegrees });
    this.lastCamera = {
      longitude: location.longitude,
      latitude: location.latitude,
      bearing: headingDegrees,
    };
    this.lastUpdateAt = now;
  }

  streetNameNear(location: LonLat): string | null {
    if (!this.loaded) return null;
    const center = this.map.project([location.longitude, location.latitude]);
    const radius = 92;
    const roadFeatures = this.map.queryRenderedFeatures(
      [
        [center.x - radius, center.y - radius],
        [center.x + radius, center.y + radius],
      ],
      { layers: [ROAD_LAYER_ID] },
    );
    const namedRoads = roadFeatures
      .map((feature) => {
        const name = streetName(feature);
        if (!name) return null;
        const localLines = lineCoordinates(feature).map((line) =>
          line
            .filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]))
            .map(([longitude, latitude]) => lonLatToLocalMeters({ longitude, latitude }, location)),
        );
        const nearest = nearestPointOnRoad({ x: 0, y: 0 }, localLines);
        return nearest ? { name, distanceMeters: nearest.distanceMeters } : null;
      })
      .filter(
        (candidate): candidate is { name: string; distanceMeters: number } => candidate !== null,
      )
      .sort((left, right) => left.distanceMeters - right.distanceMeters);
    if (namedRoads[0]) return namedRoads[0].name;

    const availableLayers = STREET_LABEL_LAYERS.filter((layer) =>
      Boolean(this.map.getLayer(layer)),
    );
    if (!availableLayers.length) return null;
    const labelFeatures = this.map.queryRenderedFeatures(
      [
        [center.x - radius, center.y - radius],
        [center.x + radius, center.y + radius],
      ],
      { layers: availableLayers },
    );
    for (const feature of labelFeatures) {
      const name = streetName(feature);
      if (name) return name;
    }
    return null;
  }

  private addRouteLayer(): void {
    this.map.addSource('osr-route', {
      type: 'geojson',
      data: routeFeature(this.routePoints),
    });
    this.map.addLayer({
      id: 'osr-route-line',
      type: 'line',
      source: 'osr-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#4ce0ac',
        'line-width': 5,
        'line-opacity': 0.92,
      },
    });
  }

  private syncRouteLayer(): void {
    if (!this.loaded) return;
    const source = this.map.getSource('osr-route') as GeoJSONSource | undefined;
    source?.setData(routeFeature(this.routePoints));
  }

  private addPursuitLayer(): void {
    this.map.addSource('osr-pursuit', {
      type: 'geojson',
      data: pursuitFeature(this.pursuitUnits),
    });
    this.map.addLayer({
      id: 'osr-pursuit-dots',
      type: 'circle',
      source: 'osr-pursuit',
      paint: {
        'circle-color': '#f43f5e',
        'circle-radius': 7,
        'circle-stroke-color': '#fecdd3',
        'circle-stroke-width': 2,
        'circle-opacity': 0.95,
      },
    });
  }

  private syncPursuitLayer(): void {
    if (!this.loaded) return;
    const source = this.map.getSource('osr-pursuit') as GeoJSONSource | undefined;
    source?.setData(pursuitFeature(this.pursuitUnits));
  }

  private addRoadQueryLayer(): void {
    const labelLayer = STREET_LABEL_LAYERS.find((layer) => Boolean(this.map.getLayer(layer)));
    this.map.addLayer(
      {
        id: ROAD_LAYER_ID,
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        filter: ['match', ['get', 'class'], DRIVABLE_CLASSES, true, false],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#10b981',
          'line-width': 12,
          'line-opacity': 0.015,
        },
      },
      labelLayer,
    );
  }
}

function lineCoordinates(feature: MapGeoJSONFeature): number[][][] {
  if (feature.geometry.type === 'LineString') return [feature.geometry.coordinates];
  if (feature.geometry.type === 'MultiLineString') return feature.geometry.coordinates;
  return [];
}

function streetName(feature: MapGeoJSONFeature): string | null {
  const properties = feature.properties;
  const value = properties?.name_en ?? properties?.['name:latin'] ?? properties?.name;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function routeFeature(points: readonly LonLat[]) {
  return {
    type: 'Feature' as const,
    properties: {},
    geometry: {
      type: 'LineString' as const,
      coordinates: points.map((point) => [point.longitude, point.latitude]),
    },
  };
}

function pursuitFeature(units: readonly PoliceUnitState[]) {
  return {
    type: 'FeatureCollection' as const,
    features: units.map((unit) => ({
      type: 'Feature' as const,
      properties: { id: unit.id },
      geometry: {
        type: 'Point' as const,
        coordinates: [unit.position.longitude, unit.position.latitude],
      },
    })),
  };
}
