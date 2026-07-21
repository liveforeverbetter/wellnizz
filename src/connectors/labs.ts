import { getPool } from '../db/pool.js';
import type { LabSearchResult } from '../types.js';

export interface LabSearchInput {
  provider?: 'quest' | 'synlab' | 'all';
  postal_code?: string;
  city?: string;
  country?: string;
  lat?: number;
  lon?: number;
  radius_miles?: number;
}

interface YextEntityResponse {
  response?: {
    entities?: YextEntity[];
    count?: number;
  };
}

interface YextEntity {
  meta?: { id: string; uid: string };
  name: string;
  address?: { line1?: string; city?: string; region?: string; postalCode?: string; countryCode?: string };
  geocodedCoordinate?: { latitude: number; longitude: number };
  mainPhone?: string;
  websiteUrl?: string;
  description?: string;
}

const QUEST_API_BASE = process.env.QUEST_LOCATIONS_API_URL ?? 'https://cdn.yextapis.com/v2/accounts/me';
const QUEST_API_KEY = process.env.QUEST_LOCATIONS_API_KEY ?? '';
const QUEST_EXPERIENCE_KEY = process.env.QUEST_YEXT_EXPERIENCE_KEY ?? '';
const SYNLAB_API_KEY = process.env.SYNLAB_API_KEY ?? '';
const LAB_LOCATION_RESULT_LIMIT = Number(process.env.LAB_LOCATION_RESULT_LIMIT ?? '25');

export async function searchLabs(input: LabSearchInput): Promise<LabSearchResult[]> {
  const providers = input.provider && input.provider !== 'all' ? [input.provider] : ['quest', 'synlab'] as const;
  return Promise.all(providers.map(provider => provider === 'quest' ? questLocator(input) : synlabLocator(input)));
}

async function questLocator(input: LabSearchInput): Promise<LabSearchResult> {
  const stored = await storedCatalogResult('quest', input, 'https://appointment.questdiagnostics.com/as-home');
  if (stored) return stored;

  if (QUEST_API_KEY && QUEST_EXPERIENCE_KEY) {
    try {
      const locations = await queryYextSearch(input);
      if (locations.length > 0) {
        return {
          provider: 'quest',
          status: 'partner_api_result',
          query: { ...input },
          locator_url: questHandoffUrl(input),
          booking_url: 'https://appointment.questdiagnostics.com/as-home',
          notes: [`Live location data via Yext Search API.`],
          locations,
        };
      }
    } catch {
      // Fall through to handoff
    }
  }

  return questHandoff(input);
}

interface YextSearchResponse {
  response?: {
    results?: Array<{
      data?: {
        id?: string;
        name?: string;
        address?: { line1?: string; city?: string; region?: string; postalCode?: string };
        geocodedCoordinate?: { latitude: number; longitude: number };
        mainPhone?: string;
        websiteUrl?: string;
        distance?: number;
      };
    }>;
  };
}

async function queryYextSearch(input: LabSearchInput): Promise<Array<{ id: string; name: string; address: string; distance_miles?: number; phone?: string; booking_url?: string; source_url?: string }>> {
  const params = new URLSearchParams({
    api_key: QUEST_API_KEY,
    v: '20231001',
    experienceKey: QUEST_EXPERIENCE_KEY,
    locale: 'en',
    verticalKey: 'locations',
    limit: '25',
    retrieveFacets: 'false',
    skipSpellCheck: 'true',
    referrerPageUrl: 'https://locations.questdiagnostics.com/locator',
  });

  const location = [input.lat, input.lon].filter(v => v != null).join(',')
    || input.postal_code
    || input.city
    || '';
  if (location) params.set('input', location);
  if (input.lat != null && input.lon != null) {
    params.set('location', `${input.lat},${input.lon}`);
    params.set('radius', String(Math.round((input.radius_miles ?? 25) * 1609.34)));
  }

  const url = `https://liveapi.yext.com/v2/accounts/me/answers/vertical/query?${params.toString()}`;
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'Wellnizz/1.0' },
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) throw new Error(`Yext API returned ${response.status}`);
  const body = await response.json() as YextSearchResponse;
  return (body.response?.results ?? []).map(r => {
    const d = r.data ?? {};
    return {
      id: `quest_${d.id ?? ''}`,
      name: d.name ?? '',
      address: [d.address?.line1, d.address?.city, d.address?.region, d.address?.postalCode].filter(Boolean).join(', '),
      distance_miles: d.distance != null ? Math.round(d.distance / 1609.34 * 10) / 10 : undefined,
      phone: d.mainPhone,
      booking_url: 'https://appointment.questdiagnostics.com/as-home',
      source_url: d.websiteUrl ?? `https://locations.questdiagnostics.com/locator`,
    };
  });
}

function questHandoff(input: LabSearchInput): LabSearchResult {
  return {
    provider: 'quest',
    status: 'locator_handoff',
    query: { ...input },
    locator_url: questHandoffUrl(input),
    booking_url: 'https://appointment.questdiagnostics.com/as-home',
    notes: [
      'Live Quest location lookup is temporarily unavailable. The locator handoff URL will open the official Quest search.',
      'Quest locations are patient service centers for sample collection; availability and appointment rules vary by location.',
    ],
    locations: [],
  };
}

function questHandoffUrl(input: LabSearchInput): string {
  const query = input.postal_code ?? input.city ?? [input.lat, input.lon].filter(v => v != null).join(',');
  const locator = new URL('https://locations.questdiagnostics.com/locator');
  if (query) locator.searchParams.set('q', query);
  return locator.toString();
}

async function synlabLocator(input: LabSearchInput): Promise<LabSearchResult> {
  const stored = await storedCatalogResult('synlab', input);
  if (stored) return stored;

  if (SYNLAB_API_KEY) {
    try {
      const params = new URLSearchParams();
      if (input.lat != null) params.set('lat', String(input.lat));
      if (input.lon != null) params.set('lon', String(input.lon));
      if (input.postal_code) params.set('zip', input.postal_code);
      if (input.city) params.set('city', input.city);
      if (input.country) params.set('country', input.country);
      params.set('radius', String(input.radius_miles ?? 25));
      params.set('limit', '25');

      const response = await fetch(`https://www.synlab.com/api/lablocator/search?${params.toString()}`, {
        headers: {
          accept: 'application/json',
          'user-agent': 'Wellnizz/1.0',
          authorization: `Bearer ${SYNLAB_API_KEY}`,
        },
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok && response.headers.get('content-type')?.includes('json')) {
        const body = await response.json() as Record<string, unknown>;
        const labs = extractSynlabLocations(body);
        if (labs.length > 0) {
          return {
            provider: 'synlab',
            status: 'partner_api_result',
            query: { ...input },
            locator_url: synlabHandoffUrl(input),
            notes: [],
            locations: labs,
          };
        }
      }
    } catch {
      // Fall through to handoff
    }
  }

  return synlabHandoff(input);
}

function extractSynlabLocations(body: Record<string, unknown>): Array<{ id: string; name: string; address: string; distance_miles?: number; phone?: string; booking_url?: string; source_url?: string }> {
  const candidates = body.labs ?? body.results ?? body.locations ?? body.data ?? [];
  if (!Array.isArray(candidates)) return [];
  return candidates.map((loc: Record<string, unknown>) => ({
    id: `synlab_${loc.id ?? loc.labId ?? loc.uid ?? ''}`,
    name: String(loc.companyName ?? loc.name ?? loc.title ?? ''),
    address: [loc.address, loc.zip, loc.city, loc.country].filter(v => v != null).join(', '),
    distance_miles: typeof loc.distance === 'number' ? loc.distance : undefined,
    phone: typeof loc.phone === 'string' ? loc.phone : typeof loc.email === 'string' ? loc.email : undefined,
    booking_url: typeof loc.bookingUrl === 'string' ? loc.bookingUrl : undefined,
    source_url: loc.labId ? `https://www.synlab.com/lablocator/lab/${loc.labId}` : undefined,
  }));
}

function synlabHandoff(input: LabSearchInput): LabSearchResult {
  return {
    provider: 'synlab',
    status: 'locator_handoff',
    query: { ...input },
    locator_url: synlabHandoffUrl(input),
    notes: [
      'Live SYNLAB location lookup is temporarily unavailable. The locator handoff URL will open the official SYNLAB search.',
      'SYNLAB coverage varies by country; not every location offers every direct-to-consumer panel.',
    ],
    locations: [],
  };
}

function synlabHandoffUrl(input: LabSearchInput): string {
  const locator = new URL('https://www.synlab.com/lablocator');
  if (input.lat != null) locator.searchParams.set('lat', String(input.lat));
  if (input.lon != null) locator.searchParams.set('lon', String(input.lon));
  return locator.toString();
}

function haversineDistance(
  lat1: number | undefined,
  lon1: number | undefined,
  lat2: number,
  lon2: number,
): number | undefined {
  if (lat1 == null || lon1 == null) return undefined;
  const R = 3959;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 10) / 10;
}

interface StoredLabLocationRow {
  provider: 'quest' | 'synlab';
  provider_location_id: string;
  name: string;
  address_line_1?: string | null;
  address_line_2?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  phone?: string | null;
  booking_url?: string | null;
  source_url?: string | null;
}

async function storedCatalogResult(provider: 'quest' | 'synlab', input: LabSearchInput, defaultBookingUrl?: string): Promise<LabSearchResult | undefined> {
  const locations = await queryStoredLabLocations(provider, input);
  if (locations.length === 0) return undefined;
  return {
    provider,
    status: 'partner_api_result',
    query: { ...input },
    locator_url: provider === 'quest' ? questHandoffUrl(input) : synlabHandoffUrl(input),
    booking_url: defaultBookingUrl,
    notes: ['Location data served from the Wellnizz stored lab-location catalog.'],
    locations: locations.map(row => ({
      id: `${row.provider}_${row.provider_location_id}`,
      name: row.name,
      address: formatStoredAddress(row),
      distance_miles: row.latitude != null && row.longitude != null
        ? haversineDistance(input.lat, input.lon, Number(row.latitude), Number(row.longitude))
        : undefined,
      latitude: row.latitude == null ? undefined : Number(row.latitude),
      longitude: row.longitude == null ? undefined : Number(row.longitude),
      phone: row.phone ?? undefined,
      booking_url: row.booking_url ?? defaultBookingUrl,
      source_url: row.source_url ?? undefined,
    })).sort((a, b) => (a.distance_miles ?? Number.POSITIVE_INFINITY) - (b.distance_miles ?? Number.POSITIVE_INFINITY)),
  };
}

async function queryStoredLabLocations(provider: 'quest' | 'synlab', input: LabSearchInput): Promise<StoredLabLocationRow[]> {
  // The stored catalog lives in Postgres. Without a durable store configured
  // (e.g. STORE_MODE=memory), skip straight to the locator handoff.
  if ((process.env.STORE_MODE ?? 'postgres').toLowerCase() !== 'postgres' || !process.env.DATABASE_URL) return [];

  const conditions = ['provider = $1', 'is_active = true'];
  const params: unknown[] = [provider];
  if (input.country) { params.push(input.country); conditions.push(`country ilike $${params.length}`); }
  if (input.postal_code) { params.push(`${input.postal_code}%`); conditions.push(`postal_code ilike $${params.length}`); }
  if (input.city) { params.push(`%${input.city}%`); conditions.push(`city ilike $${params.length}`); }
  if (input.lat != null && input.lon != null) {
    const radiusMiles = input.radius_miles ?? 25;
    const latDelta = radiusMiles / 69;
    const lonDelta = radiusMiles / Math.max(Math.cos(input.lat * Math.PI / 180) * 69, 1);
    params.push(input.lat - latDelta); conditions.push(`latitude >= $${params.length}`);
    params.push(input.lat + latDelta); conditions.push(`latitude <= $${params.length}`);
    params.push(input.lon - lonDelta); conditions.push(`longitude >= $${params.length}`);
    params.push(input.lon + lonDelta); conditions.push(`longitude <= $${params.length}`);
  }
  const limit = Math.max(LAB_LOCATION_RESULT_LIMIT * 4, LAB_LOCATION_RESULT_LIMIT);

  try {
    const result = await getPool().query(
      `select provider, provider_location_id, name, address_line_1, address_line_2, city, region,
              postal_code, country, latitude, longitude, phone, booking_url, source_url
       from health_api.lab_locations where ${conditions.join(' and ')} limit ${limit}`,
      params,
    );
    const rows = result.rows as StoredLabLocationRow[];
    return rows
      .map(row => ({ ...row }))
      .filter(row => {
        if (input.lat == null || input.lon == null || row.latitude == null || row.longitude == null) return true;
        const distance = haversineDistance(input.lat, input.lon, Number(row.latitude), Number(row.longitude));
        return distance == null || distance <= (input.radius_miles ?? 25);
      })
      .sort((a, b) => {
        const aDistance = a.latitude == null || a.longitude == null ? Number.POSITIVE_INFINITY : haversineDistance(input.lat, input.lon, Number(a.latitude), Number(a.longitude)) ?? Number.POSITIVE_INFINITY;
        const bDistance = b.latitude == null || b.longitude == null ? Number.POSITIVE_INFINITY : haversineDistance(input.lat, input.lon, Number(b.latitude), Number(b.longitude)) ?? Number.POSITIVE_INFINITY;
        return aDistance - bDistance || a.name.localeCompare(b.name);
      })
      .slice(0, LAB_LOCATION_RESULT_LIMIT);
  } catch {
    return [];
  }
}

function formatStoredAddress(row: StoredLabLocationRow): string {
  return [
    row.address_line_1,
    row.address_line_2,
    [row.city, row.region, row.postal_code].filter(Boolean).join(', '),
    row.country,
  ].filter(Boolean).join(', ');
}
