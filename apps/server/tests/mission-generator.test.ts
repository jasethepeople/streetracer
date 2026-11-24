import { describe, expect, it } from 'vitest';
import { localMetersToLonLat, type OsmElement } from '@openstreet-racer/world';
import { compileModScript } from '@openstreet-racer/game';
import { createCommunityRaceOffer, generateMissionOffers } from '../src/mission-generator';

const origin = { longitude: -104.9903, latitude: 39.7392 };
const elements: readonly OsmElement[] = [
  ...Array.from({ length: 8 }, (_, index) => ({
    type: 'node' as const,
    id: index + 1,
    lon: -104.997 + index * 0.002,
    lat: 39.7392,
    tags:
      index === 0
        ? { shop: 'supermarket', name: 'Corner Market' }
        : index === 2
          ? { amenity: 'cafe', name: 'Creek Cafe' }
          : index === 4
            ? { amenity: 'school', name: 'Maple School' }
            : index === 7
              ? { tourism: 'museum', name: 'History Museum' }
              : {},
  })),
  { type: 'way', id: 10, nodes: [1, 2, 3, 4, 5, 6, 7, 8], tags: { highway: 'residential' } },
  { type: 'node', id: 20, lon: -104.9852, lat: 39.7396 },
  { type: 'node', id: 21, lon: -104.9848, lat: 39.7396 },
  { type: 'node', id: 22, lon: -104.9848, lat: 39.7391 },
  { type: 'node', id: 23, lon: -104.9852, lat: 39.7391 },
  { type: 'way', id: 90, nodes: [20, 21, 22, 23, 20], tags: {} },
  {
    type: 'relation',
    id: 91,
    members: [{ type: 'way', ref: 90, role: 'outer' }],
    tags: { leisure: 'park', name: 'Riverside Park', type: 'multipolygon' },
  },
];

describe('real-world mission generation', () => {
  it('builds repeatable deliveries, taxi fares, time trials, and checkpoint races from OSM places', () => {
    const first = generateMissionOffers(elements, origin, Date.UTC(2026, 10, 22, 12));
    const second = generateMissionOffers(elements, origin, Date.UTC(2026, 10, 22, 18));

    expect(first).toEqual(second);
    expect(first.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(['delivery', 'taxi', 'time-trial', 'checkpoint-race']),
    );
    expect(first.some((offer) => offer.pickup.name === 'Corner Market')).toBe(true);
    expect(first.some((offer) => offer.pickup.name === 'Riverside Park')).toBe(true);
    expect(
      first
        .filter((offer) => offer.kind !== 'getaway' && offer.kind !== 'lay-low')
        .every((offer) => offer.route.length >= 2 && offer.distanceMeters >= 300),
    ).toBe(true);
    const layLow = first.find((offer) => offer.kind === 'lay-low');
    expect(layLow).toBeDefined();
    expect(layLow?.pickup.id).toBe(layLow?.destination.id);
    expect(layLow?.checkpoints).toHaveLength(0);
    const getaway = first.find((offer) => offer.kind === 'getaway');
    expect(getaway).toBeDefined();
    expect(getaway?.minimumTimeSeconds).toBeGreaterThanOrEqual(45);
    const timeTrial = first.find((offer) => offer.kind === 'time-trial');
    const race = first.find((offer) => offer.kind === 'checkpoint-race');
    expect(timeTrial?.checkpoints.length).toBeGreaterThan(0);
    expect(race?.checkpoints.length).toBeGreaterThan(0);
  });

  it('falls back to named road checkpoints when an area has no tagged places', () => {
    const roadNodes = elements
      .filter((element) => element.type === 'node' && Number(element.id) <= 8)
      .map((node) => ({ ...node, tags: {} }));
    const road = elements.find((element) => element.type === 'way' && element.id === 10);
    const roadOnly = road ? [...roadNodes, road] : roadNodes;
    const offers = generateMissionOffers(roadOnly, origin, Date.UTC(2026, 10, 22, 12));
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((offer) => offer.pickup.category === 'street')).toBe(true);
  });

  it('builds a validated community race with visible ordered checkpoints', () => {
    const midpoint = localMetersToLonLat({ x: 400, y: 0 }, origin);
    const destination = localMetersToLonLat({ x: 800, y: 0 }, origin);
    const offer = createCommunityRaceOffer(
      'community-race-00000000-0000-4000-8000-000000000001',
      'My Street',
      'Driver-1234',
      origin,
      destination,
      { points: [origin, midpoint, destination], distanceMeters: 800, travelTimeSeconds: 60 },
    );

    expect(offer).toMatchObject({
      source: 'community',
      creatorHandle: 'Driver-1234',
      kind: 'checkpoint-race',
      title: 'Community race · My Street',
      distanceMeters: 800,
      checkpoints: [midpoint],
    });
  });

  it('creates a bounded published street race with ordered road checkpoints', () => {
    const finish = localMetersToLonLat({ x: 800, y: 0 }, origin);
    const midpoint = localMetersToLonLat({ x: 400, y: 0 }, origin);
    const offer = createCommunityRaceOffer(
      'community-race-12345678-1234-4234-9234-123456789abc',
      'My Street',
      'Driver-1234',
      origin,
      finish,
      {
        points: [origin, midpoint, finish],
        distanceMeters: 800,
        travelTimeSeconds: 60,
      },
    );
    expect(offer).toMatchObject({
      source: 'community',
      kind: 'checkpoint-race',
      creatorHandle: 'Driver-1234',
      title: 'Community race · My Street',
      checkpoints: [midpoint],
    });
    expect(
      createCommunityRaceOffer(
        'community-race-12345678-1234-4234-9234-123456789abd',
        'Too far',
        'Driver-1234',
        origin,
        finish,
        { points: [origin, finish], distanceMeters: 9_000, travelTimeSeconds: 600 },
      ),
    ).toBeNull();
  });
});

describe('mod missions', () => {
  it('places mod missions between matching OSM places and applies scripted multipliers', () => {
    const mods = [
      {
        id: 'rally',
        name: 'Rally Pack',
        missions: [
          {
            id: 'rally-market-dash',
            kind: 'delivery' as const,
            title: 'Market dash',
            rewardCents: 800,
            timeMultiplier: 1.5,
            placeCategories: ['shop'],
            rewardMultiplierScript: compileModScript('(if (> distance 2000) 2 1)'),
            timeLimitMultiplierScript: null,
          },
        ],
      },
    ];

    const offers = generateMissionOffers(elements, origin, Date.UTC(2026, 10, 22, 12), mods);

    const modOffer = offers.find((offer) => offer.source === 'mod');
    expect(modOffer).toBeDefined();
    expect(modOffer!.id).toMatch(/^mod-rally-market-dash-[0-9a-z]+$/u);
    expect(modOffer!.title).toBe('Market dash');
    expect(modOffer!.pickup.category).toBe('shop');
    expect(modOffer!.rewardCents).toBeGreaterThanOrEqual(400);
    expect(modOffer!.rewardCents).toBeLessThanOrEqual(1600);
    expect(modOffer!.timeLimitSeconds).toBeGreaterThan(90);
    expect(modOffer!.minimumTimeSeconds).toBeGreaterThanOrEqual(10);
  });

  it('skips mod missions when no matching place category exists nearby', () => {
    const mods = [
      {
        id: 'empty',
        name: 'Empty Pack',
        missions: [
          {
            id: 'empty-fuel-run',
            kind: 'taxi' as const,
            title: 'Fuel run',
            rewardCents: 500,
            timeMultiplier: 1,
            placeCategories: ['fuel station'],
            rewardMultiplierScript: null,
            timeLimitMultiplierScript: null,
          },
        ],
      },
    ];

    const offers = generateMissionOffers(elements, origin, Date.UTC(2026, 10, 22, 12), mods);

    expect(offers.some((offer) => offer.source === 'mod')).toBe(false);
  });
});
