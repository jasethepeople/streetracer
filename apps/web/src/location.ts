import type { LonLat } from '@openstreet-racer/shared';

export interface PlaceResult {
  location: LonLat;
  label: string;
}

interface NominatimResult {
  lat?: string;
  lon?: string;
  display_name?: string;
}

const SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const MIN_REQUEST_INTERVAL_MS = 1_000;
const RESULT_CACHE = new Map<string, PlaceResult | null>();
let requestQueue: Promise<void> = Promise.resolve();
let lastRequestStartedAt = 0;

export async function searchCity(query: string): Promise<PlaceResult | null> {
  const normalizedQuery = query.trim().replace(/\s+/g, ' ');
  if (normalizedQuery.length < 3) return null;

  const cacheKey = normalizedQuery.toLocaleLowerCase();
  if (RESULT_CACHE.has(cacheKey)) return RESULT_CACHE.get(cacheKey) ?? null;

  const request = requestQueue.then(async () => {
    const wait = Math.max(0, MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestStartedAt));
    if (wait > 0) await new Promise((resolve) => window.setTimeout(resolve, wait));
    lastRequestStartedAt = Date.now();

    const params = new URLSearchParams({ q: normalizedQuery, format: 'jsonv2', limit: '1' });
    const response = await fetch(`${SEARCH_URL}?${params}`, {
      headers: { 'Accept-Language': navigator.language || 'en' },
      referrer: `${window.location.origin}/`,
      referrerPolicy: 'origin',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Place search returned HTTP ${response.status}`);

    const results = (await response.json()) as NominatimResult[];
    const first = Array.isArray(results) ? results[0] : undefined;
    const latitude = Number(first?.lat);
    const longitude = Number(first?.lon);
    const place =
      Number.isFinite(latitude) && Number.isFinite(longitude)
        ? { location: { latitude, longitude }, label: first?.display_name ?? normalizedQuery }
        : null;
    RESULT_CACHE.set(cacheKey, place);
    if (RESULT_CACHE.size > 30) RESULT_CACHE.delete(RESULT_CACHE.keys().next().value as string);
    return place;
  });

  requestQueue = request.then(
    () => undefined,
    () => undefined,
  );
  return request;
}
