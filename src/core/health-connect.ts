import { createId } from '../store.js';
import type { NormalizedObservation, RawSourceReference } from '../types.js';

export interface HealthConnectSdkData {
  records?: Array<Record<string, unknown>>;
  sleep?: Array<Record<string, unknown>>;
  workouts?: Array<Record<string, unknown>>;
}

export interface HealthConnectSdkPayload {
  provider?: string;
  sdkVersion?: string;
  syncTimestamp?: string;
  // IANA timezone of the device (e.g. "Europe/London"). When present, wearable
  // daily aggregates bucket by the user's local day instead of UTC.
  timezone?: string;
  data?: HealthConnectSdkData;
}

interface HealthConnectReading {
  metric: string;
  value: number;
  unit?: string;
  observed_at?: string;
  raw: Record<string, unknown>;
}

// Health Connect sends the original on-device record dates. Preserve those
// dates in normalized observations so a historical mobile export does not look
// like a single day of newly-created data once it reaches the cloud.
export function normalizeHealthConnectPayload(
  source: RawSourceReference,
  data: HealthConnectSdkData,
): NormalizedObservation[] {
  return healthConnectReadings(data).map(reading => ({
    id: createId('obs'),
    user_id: source.user_id,
    organization_id: source.organization_id,
    source_id: source.id,
    category: 'wearables' as const,
    type: 'wearable_metric',
    name: reading.metric,
    value: reading.value,
    unit: reading.unit,
    observed_at: reading.observed_at,
    provider: 'health_connect',
    raw: reading.raw,
  }));
}

export function healthConnectReadings(data: HealthConnectSdkData): HealthConnectReading[] {
  const readings: HealthConnectReading[] = [];
  for (const record of data.records ?? []) {
    const value = healthConnectNumericValue(record.value);
    if (value == null) continue;
    readings.push({
      metric: healthConnectMetricId(String(record.type ?? 'health_connect_metric')),
      value,
      unit: typeof record.unit === 'string' ? record.unit : undefined,
      observed_at: healthConnectTimestamp(record, ['endDate', 'time', 'timestamp', 'startDate']),
      raw: record,
    });
  }

  const sleepBySession = new Map<string, { hours: number; observed_at?: string; raw: Record<string, unknown> }>();
  for (const record of data.sleep ?? []) {
    const stage = String(record.stage ?? '').toLowerCase();
    if (stage === 'awake' || stage === 'in_bed' || stage === 'inbed') continue;
    const started = Date.parse(String(record.startDate ?? ''));
    const ended = Date.parse(String(record.endDate ?? ''));
    if (!Number.isFinite(started) || !Number.isFinite(ended) || ended <= started) continue;
    const session = String(record.parentId ?? record.id ?? `${started}-${ended}`);
    const previous = sleepBySession.get(session);
    sleepBySession.set(session, {
      hours: (previous?.hours ?? 0) + (ended - started) / 3_600_000,
      observed_at: healthConnectTimestamp(record, ['endDate', 'startDate']) ?? previous?.observed_at,
      raw: record,
    });
  }
  for (const { hours, observed_at, raw } of sleepBySession.values()) {
    readings.push({ metric: 'sleep_duration', value: Math.round(hours * 100) / 100, unit: 'hours', observed_at, raw });
  }

  return readings;
}

// Extract a numeric reading value. The Flutter health/Health Connect bridges do
// not all serialize `value` as a bare number: some wrap it in a typed object
// (`{ numericValue: 58 }`, `{ beatsPerMinute: 58 }`, ...). A bare `Number(...)`
// on those objects yields NaN and silently drops every non-trivial record, which
// can leave only step counts surviving. Accept the common shapes instead.
function healthConnectNumericValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return value.trim() && Number.isFinite(parsed) ? parsed : undefined;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of ['numericValue', 'numeric_value', 'value', 'beatsPerMinute', 'count', 'doubleValue', 'longValue']) {
      const nested = healthConnectNumericValue(record[key]);
      if (nested != null) return nested;
    }
  }
  return undefined;
}

function healthConnectTimestamp(record: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== 'string') continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return undefined;
}

function healthConnectMetricId(type: string): string {
  const normalized = type
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  const aliases: Record<string, string> = {
    heart_rate_variability_sdnn: 'hrv',
    heart_rate_variability_rmssd: 'hrv',
    resting_heart_rate: 'resting_heart_rate',
    heart_rate: 'heart_rate',
    step_count: 'steps',
    steps: 'steps',
    active_calories_burned: 'active_calories',
    active_energy: 'active_calories',
    oxygen_saturation: 'oxygen_saturation',
    vo2_max: 'vo2_max',
    distance_walking_running: 'distance',
  };
  return aliases[normalized] ?? normalized;
}
