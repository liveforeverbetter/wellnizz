import * as fs from "fs";

import type { BiomarkerReading } from "./biomarker_engine.js";
import { BIOMARKER_DEFINITIONS } from "./biomarker_engine.js";
import type { WearableReading } from "./wearable_engine.js";

type CsvRow = Record<string, string>;
type JsonObject = Record<string, unknown>;

const WEARABLE_SUM_METRICS = new Set([
  "zone2_minutes",
  "vigorous_minutes",
  "strength_sessions",
  "workout_count",
  "alcohol_days",
]);

const WEARABLE_COLUMN_ALIASES: Record<string, string> = {
  sleep_hours: "sleep_duration",
  total_sleep: "sleep_duration",
  asleep_duration: "sleep_duration",
  sleep_performance_percentage: "sleep_performance",
  total_light_sleep_time_milli: "light_sleep",
  whoop_recovery: "recovery_score",
  readiness: "recovery_score",
  rmssd: "hrv",
  hrv_rmssd_milli: "hrv",
  rhr: "resting_heart_rate",
  resting_hr: "resting_heart_rate",
  avg_heart_rate: "average_heart_rate",
  average_hr: "average_heart_rate",
  max_hr: "max_heart_rate",
  maximum_heart_rate: "max_heart_rate",
  min_heart_rate: "resting_heart_rate",
  respiration_rate: "respiratory_rate",
  oxygen_saturation: "spo2",
  spo2_pct: "spo2",
  blood_oxygen: "spo2",
  skin_temp: "skin_temperature",
  skin_temp_c: "skin_temperature",
  skin_temp_celsius: "skin_temperature",
  daily_steps: "steps",
  whoop_strain: "strain",
  training_strain: "strain",
  bedtime_variation: "bedtime_variability",
  wake_time_variation: "wake_variability",
  heart_minutes: "daily_heart_minutes",
  active_minutes: "daily_active_minutes",
  hrv_ms: "hrv",
  sleep_efficiency_pct: "sleep_efficiency",
  heart_rate_avg_bpm: "average_heart_rate",
  heart_rate_variability_avg_ms: "hrv",
  oxygen_saturation_avg: "spo2",
  respiratory_rate_avg_breaths_min: "respiratory_rate",
  resting_heart_rate_avg_bpm: "resting_heart_rate",
  body_temperature_c: "skin_temperature",
  vo2_max_avg_ml_min_kg: "vo2max_estimate",
};

const WEARABLE_UNITS: Record<string, string> = {
  sleep_duration: "hours",
  sleep_efficiency: "%",
  sleep_performance: "%",
  deep_sleep: "hours",
  light_sleep: "hours",
  rem_sleep: "hours",
  sleep_debt_minutes: "minutes",
  nap_minutes: "minutes",
  recovery_score: "%",
  hrv: "ms",
  resting_heart_rate: "bpm",
  average_heart_rate: "bpm",
  max_heart_rate: "bpm",
  respiratory_rate: "rpm",
  spo2: "%",
  skin_temperature: "C",
  steps: "steps",
  zone2_minutes: "min/week",
  vigorous_minutes: "min/week",
  workout_count: "sessions/week",
  strength_sessions: "sessions/week",
  vo2max_estimate: "mL/kg/min",
  strain: "score",
  sleep_consistency: "%",
  bedtime_variability: "minutes",
  wake_variability: "minutes",
  alcohol_days: "days/week",
  daily_heart_minutes: "min/day",
  daily_active_minutes: "min/day",
};

function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

export function parseCsv(text: string): CsvRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length === 0) return [];

  const headers = parseCsvLine(lines[0]).map(normalizeHeader);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row: CsvRow = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? "";
    });
    return row;
  });
}

function numberFrom(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return numberFrom(value);
  return undefined;
}

function qualitativeCode(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().trim();
  if (!normalized) return undefined;
  if (numberFrom(normalized) != null) return undefined;
  if (
    /(positive|present|detected|abnormal|moderate|many|large|cloudy|turbid|red|brown)/.test(
      normalized
    )
  )
    return 1;
  if (/(trace|few|rare|small|slight|hazy)/.test(normalized)) return 0.5;
  return 0;
}

function arrayFrom(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is JsonObject =>
          item != null && typeof item === "object" && !Array.isArray(item)
      )
    : [];
}

function objectFrom(value: unknown): JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return (
    Math.round(
      (values.reduce((sum, value) => sum + value, 0) / values.length) * 100
    ) / 100
  );
}

function sum(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return (
    Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100
  );
}

function hoursFromMillis(value: unknown): number | undefined {
  const millis = numeric(value);
  return millis == null
    ? undefined
    : Math.round((millis / 3_600_000) * 100) / 100;
}

function minutesFromMillis(value: unknown): number | undefined {
  const millis = numeric(value);
  return millis == null ? undefined : Math.round((millis / 60_000) * 100) / 100;
}

function firstDefined(row: CsvRow, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[normalizeHeader(key)];
    if (value != null && value !== "") return value;
  }
  return undefined;
}

type BiomarkerPattern = {
  id: string;
  labels: string[];
};

function buildBiomarkerPatterns(): BiomarkerPattern[] {
  return BIOMARKER_DEFINITIONS.map((def) => ({
    id: def.id,
    labels: [def.name, def.id, ...def.aliases]
      .map((label) => label.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length),
  })).sort((a, b) => b.labels[0].length - a.labels[0].length);
}

const BIOMARKER_PATTERNS = buildBiomarkerPatterns();

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseBiomarkerText(text: string): BiomarkerReading[] {
  const readings: BiomarkerReading[] = [];
  const seen = new Set<string>();
  const collectedAt = text.match(
    /Collected:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i
  )?.[1];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^[A-Za-z ]+:?$/.test(trimmed)) continue;
    for (const pattern of BIOMARKER_PATTERNS) {
      if (seen.has(pattern.id)) continue;
      for (const label of pattern.labels) {
        const re = new RegExp(
          `\\b${escapeRegex(
            label
          )}\\b\\s*[:\\-]?\\s*(-?\\d+(?:\\.\\d+)?)\\s*([^,;\\n]*)`,
          "i"
        );
        const match = trimmed.match(re);
        if (!match) continue;
        const value = numeric(match[1]);
        if (value == null) continue;
        const unit = match[2]?.trim() || undefined;
        readings.push({
          id: pattern.id,
          value,
          unit,
          collected_at: collectedAt,
        });
        seen.add(pattern.id);
        break;
      }
      if (seen.has(pattern.id)) break;
      for (const label of pattern.labels) {
        const re = new RegExp(
          `\\b${escapeRegex(
            label
          )}\\b\\s*[:\\-]?\\s*([A-Za-z][A-Za-z0-9 +/\\-]*)`,
          "i"
        );
        const match = trimmed.match(re);
        if (!match) continue;
        const rawValue = match[1]?.trim();
        const value = qualitativeCode(rawValue);
        if (value == null || !rawValue) continue;
        readings.push({
          id: pattern.id,
          value,
          unit: "qualitative",
          raw_value: rawValue,
          collected_at: collectedAt,
        });
        seen.add(pattern.id);
        break;
      }
      if (seen.has(pattern.id)) break;
    }
  }

  return readings;
}

export function parseBiomarkerCsv(text: string): BiomarkerReading[] {
  return parseCsv(text)
    .map((row): BiomarkerReading | undefined => {
      const id = firstDefined(row, [
        "marker",
        "biomarker",
        "test",
        "test_name",
        "name",
        "id",
      ]);
      const rawValue = firstDefined(row, ["value", "result", "result_value"]);
      const value = numberFrom(rawValue) ?? qualitativeCode(rawValue);
      if (!id || value == null) return undefined;
      return {
        id,
        value,
        unit:
          firstDefined(row, ["unit", "units"]) ??
          (numberFrom(rawValue) == null ? "qualitative" : undefined),
        raw_value: rawValue,
        collected_at: firstDefined(row, [
          "collected_at",
          "date",
          "result_date",
        ]),
      };
    })
    .filter((reading): reading is BiomarkerReading => reading != null);
}

export function parseBiomarkerCsvFile(filePath: string): BiomarkerReading[] {
  return parseBiomarkerCsv(fs.readFileSync(filePath, "utf8"));
}

export function parseBiomarkerJson(text: string): BiomarkerReading[] {
  const parsed = JSON.parse(text) as unknown;
  const rows = Array.isArray(parsed)
    ? parsed
    : arrayFrom(
        objectFrom(parsed).biomarkers ??
          objectFrom(parsed).results ??
          objectFrom(parsed).markers
      );

  return rows
    .map((row): BiomarkerReading | undefined => {
      if (row == null || typeof row !== "object" || Array.isArray(row))
        return undefined;
      const item = row as JsonObject;
      const id = String(
        item.marker ??
          item.biomarker ??
          item.test_name ??
          item.name ??
          item.id ??
          ""
      ).trim();
      const rawValue = item.value ?? item.result ?? item.result_value;
      const value =
        numeric(rawValue) ??
        (typeof rawValue === "string" ? qualitativeCode(rawValue) : undefined);
      if (!id || value == null) return undefined;
      return {
        id,
        value,
        unit:
          typeof item.unit === "string"
            ? item.unit
            : typeof item.units === "string"
            ? item.units
            : typeof rawValue === "string" && numeric(rawValue) == null
            ? "qualitative"
            : undefined,
        raw_value: typeof rawValue === "string" ? rawValue : undefined,
        collected_at:
          typeof item.collected_at === "string"
            ? item.collected_at
            : typeof item.date === "string"
            ? item.date
            : undefined,
      };
    })
    .filter((reading): reading is BiomarkerReading => reading != null);
}

export function parseBiomarkerFile(filePath: string): BiomarkerReading[] {
  const text = fs.readFileSync(filePath, "utf8");
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".json")) return parseBiomarkerJson(text);
  if (lower.endsWith(".txt") || lower.endsWith(".md"))
    return parseBiomarkerText(text);
  return parseBiomarkerCsv(text);
}

function canonicalWearableId(rawId: string): string {
  const normalized = normalizeHeader(rawId);
  return WEARABLE_COLUMN_ALIASES[normalized] ?? normalized;
}

export function parseWearableCsv(text: string): WearableReading[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];

  if ("metric" in rows[0] && "value" in rows[0]) {
    return rows
      .map((row): WearableReading | undefined => {
        const id = firstDefined(row, ["metric", "signal", "name", "id"]);
        const value = numberFrom(firstDefined(row, ["value", "result"]));
        if (!id || value == null) return undefined;
        return {
          id: canonicalWearableId(id),
          value,
          unit: firstDefined(row, ["unit", "units"]),
          window_days: numberFrom(firstDefined(row, ["window_days", "days"])),
        };
      })
      .filter((reading): reading is WearableReading => reading != null);
  }

  // Columns stored in minutes that the engine expects in hours
  const MINUTE_TO_HOUR: Record<string, string> = {
    total_sleep_min: "sleep_duration",
    deep_sleep_min: "deep_sleep",
    rem_sleep_min: "rem_sleep",
  };

  const aggregates = new Map<string, { values: number[]; unit?: string }>();
  for (const row of rows) {
    for (const [column, rawValue] of Object.entries(row)) {
      const normalized = normalizeHeader(column);
      const convTarget = MINUTE_TO_HOUR[normalized];
      const id = convTarget ?? canonicalWearableId(column);
      if (id === "date" || id === "start" || id === "end") continue;
      const rawNum = numberFrom(rawValue);
      if (rawNum == null) continue;
      const value = convTarget ? rawNum / 60 : rawNum;
      const aggregate = aggregates.get(id) ?? {
        values: [],
        unit: WEARABLE_UNITS[id],
      };
      aggregate.values.push(value);
      aggregates.set(id, aggregate);
    }
  }

  const readings = Array.from(aggregates.entries()).map(([id, aggregate]) => {
    const sum = aggregate.values.reduce((total, value) => total + value, 0);
    const value = WEARABLE_SUM_METRICS.has(id)
      ? sum
      : Math.round((sum / aggregate.values.length) * 100) / 100;
    return {
      id,
      value,
      unit: aggregate.unit,
      window_days: rows.length,
    };
  });

  // Health Connect sleep exports record individual sleep intervals instead of a
  // daily duration column. Sum intervals by the supplied date before averaging,
  // so a split night or nap does not make a person's sleep look half as long.
  if ("start_time" in rows[0] && "end_time" in rows[0]) {
    const dailyHours = new Map<string, number>();
    for (const row of rows) {
      const start = Date.parse(row.start_time ?? "");
      const end = Date.parse(row.end_time ?? "");
      const date = row.date;
      if (
        !date ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end <= start
      )
        continue;
      dailyHours.set(
        date,
        (dailyHours.get(date) ?? 0) + (end - start) / 3_600_000
      );
    }
    if (dailyHours.size > 0) {
      const duration = average([...dailyHours.values()]);
      if (duration != null)
        readings.push({
          id: "sleep_duration",
          value: duration,
          unit: "hours",
          window_days: dailyHours.size,
        });
    }
  }

  return readings;
}

export function parseWearableCsvFile(filePath: string): WearableReading[] {
  return parseWearableCsv(fs.readFileSync(filePath, "utf8"));
}

function pushReading(
  readings: WearableReading[],
  id: string,
  value: number | undefined,
  unit?: string,
  windowDays?: number
): void {
  if (value == null || !Number.isFinite(value)) return;
  readings.push({
    id,
    value,
    unit: unit ?? WEARABLE_UNITS[id],
    window_days: windowDays,
  });
}

export function parseWearableJson(text: string): WearableReading[] {
  const root = objectFrom(JSON.parse(text) as unknown);
  const recoveries = arrayFrom(root.recoveries ?? root.recovery);
  const sleeps = arrayFrom(root.sleeps ?? root.sleep);
  const cycles = arrayFrom(root.cycles ?? root.cycle);
  const workouts = arrayFrom(root.workouts ?? root.workout);
  const dailyActivity = arrayFrom(root.daily_activity ?? root.activity);
  const manual = objectFrom(root.manual_context);
  const inferredWindowDays = Math.max(
    recoveries.length,
    sleeps.length,
    cycles.length,
    dailyActivity.length
  );
  const windowDays =
    numeric(root.window_days) ??
    (inferredWindowDays > 0 ? inferredWindowDays : undefined);

  const readings: WearableReading[] = [];

  const recoveryScores: number[] = [];
  const hrv: number[] = [];
  const rhr: number[] = [];
  const spo2: number[] = [];
  const skinTemperature: number[] = [];
  for (const recovery of recoveries) {
    const score = objectFrom(recovery.score);
    const state = String(recovery.score_state ?? "").toUpperCase();
    if (state && state !== "SCORED") continue;
    const recoveryScore = numeric(score.recovery_score);
    const hrvValue = numeric(score.hrv_rmssd_milli ?? score.hrv);
    const rhrValue = numeric(score.resting_heart_rate);
    const spo2Value = numeric(score.spo2_percentage ?? score.spo2);
    const skinTempValue = numeric(score.skin_temp_celsius ?? score.skin_temp);
    if (recoveryScore != null) recoveryScores.push(recoveryScore);
    if (hrvValue != null) hrv.push(hrvValue);
    if (rhrValue != null) rhr.push(rhrValue);
    if (spo2Value != null) spo2.push(spo2Value);
    if (skinTempValue != null) skinTemperature.push(skinTempValue);
  }
  pushReading(
    readings,
    "recovery_score",
    average(recoveryScores),
    "%",
    windowDays
  );
  pushReading(readings, "hrv", average(hrv), "ms", windowDays);
  pushReading(readings, "resting_heart_rate", average(rhr), "bpm", windowDays);
  pushReading(readings, "spo2", average(spo2), "%", windowDays);
  pushReading(
    readings,
    "skin_temperature",
    average(skinTemperature),
    "C",
    windowDays
  );

  const sleepDuration: number[] = [];
  const sleepEfficiency: number[] = [];
  const sleepPerformance: number[] = [];
  const deepSleep: number[] = [];
  const lightSleep: number[] = [];
  const remSleep: number[] = [];
  const respiratoryRate: number[] = [];
  for (const sleep of sleeps) {
    const score = objectFrom(sleep.score);
    const state = String(sleep.score_state ?? "").toUpperCase();
    if (state && state !== "SCORED") continue;
    const stages = objectFrom(score.stage_summary);
    const inBed = hoursFromMillis(stages.total_in_bed_time_milli);
    const awake = hoursFromMillis(stages.total_awake_time_milli) ?? 0;
    const sleepHours =
      inBed == null
        ? undefined
        : Math.max(0, Math.round((inBed - awake) * 100) / 100);
    const efficiency = numeric(score.sleep_efficiency_percentage);
    const performance = numeric(score.sleep_performance_percentage);
    const deep = hoursFromMillis(stages.total_slow_wave_sleep_time_milli);
    const light = hoursFromMillis(stages.total_light_sleep_time_milli);
    const rem = hoursFromMillis(stages.total_rem_sleep_time_milli);
    const respiration = numeric(score.respiratory_rate);
    if (sleepHours != null) sleepDuration.push(sleepHours);
    if (efficiency != null) sleepEfficiency.push(efficiency);
    if (performance != null) sleepPerformance.push(performance);
    if (deep != null) deepSleep.push(deep);
    if (light != null) lightSleep.push(light);
    if (rem != null) remSleep.push(rem);
    if (respiration != null) respiratoryRate.push(respiration);
  }
  pushReading(
    readings,
    "sleep_duration",
    average(sleepDuration),
    "hours",
    windowDays
  );
  pushReading(
    readings,
    "sleep_efficiency",
    average(sleepEfficiency),
    "%",
    windowDays
  );
  pushReading(
    readings,
    "sleep_performance",
    average(sleepPerformance),
    "%",
    windowDays
  );
  pushReading(readings, "deep_sleep", average(deepSleep), "hours", windowDays);
  pushReading(
    readings,
    "light_sleep",
    average(lightSleep),
    "hours",
    windowDays
  );
  pushReading(readings, "rem_sleep", average(remSleep), "hours", windowDays);
  pushReading(
    readings,
    "respiratory_rate",
    average(respiratoryRate),
    "rpm",
    windowDays
  );

  const strainValues: number[] = [];
  const averageHeartRateValues: number[] = [];
  const maxHeartRateValues: number[] = [];
  for (const cycle of cycles) {
    const score = objectFrom(cycle.score);
    const state = String(cycle.score_state ?? "").toUpperCase();
    if (state && state !== "SCORED") continue;
    const value = numeric(score.strain);
    const averageHeartRate = numeric(score.average_heart_rate);
    const maxHeartRate = numeric(score.max_heart_rate);
    if (value != null) strainValues.push(value);
    if (averageHeartRate != null) averageHeartRateValues.push(averageHeartRate);
    if (maxHeartRate != null) maxHeartRateValues.push(maxHeartRate);
  }
  pushReading(readings, "strain", average(strainValues), "score", windowDays);
  pushReading(
    readings,
    "average_heart_rate",
    average(averageHeartRateValues),
    "bpm",
    windowDays
  );
  pushReading(
    readings,
    "max_heart_rate",
    average(maxHeartRateValues),
    "bpm",
    windowDays
  );

  const zone2Minutes: number[] = [];
  const vigorousMinutes: number[] = [];
  for (const workout of workouts) {
    const score = objectFrom(workout.score);
    const zones = objectFrom(score.zone_duration);
    const zone2 = minutesFromMillis(zones.zone_two_milli);
    const vigorous = sum(
      [
        minutesFromMillis(zones.zone_four_milli),
        minutesFromMillis(zones.zone_five_milli),
      ].filter((value): value is number => value != null)
    );
    if (zone2 != null) zone2Minutes.push(zone2);
    if (vigorous != null) vigorousMinutes.push(vigorous);
  }
  pushReading(
    readings,
    "zone2_minutes",
    sum(zone2Minutes),
    "min/week",
    windowDays
  );
  pushReading(
    readings,
    "vigorous_minutes",
    sum(vigorousMinutes),
    "min/week",
    windowDays
  );
  pushReading(
    readings,
    "workout_count",
    workouts.length > 0 ? workouts.length : undefined,
    "sessions/week",
    windowDays
  );

  const steps = dailyActivity
    .map((day) => numeric(day.steps))
    .filter((value): value is number => value != null);
  pushReading(readings, "steps", average(steps), "steps", windowDays);

  for (const [key, rawValue] of Object.entries(manual)) {
    const id = canonicalWearableId(key);
    pushReading(
      readings,
      id,
      numeric(rawValue),
      WEARABLE_UNITS[id],
      windowDays
    );
  }

  return Array.from(
    new Map(readings.map((reading) => [reading.id, reading])).values()
  );
}

export function parseWearableFile(filePath: string): WearableReading[] {
  if (fs.statSync(filePath).isDirectory()) {
    const files = fs
      .readdirSync(filePath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(csv|json)$/i.test(entry.name))
      .map((entry) => `${filePath}/${entry.name}`)
      .sort();
    const grouped = new Map<string, WearableReading[]>();
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      const parsed = file.toLowerCase().endsWith(".json")
        ? parseWearableJson(text)
        : parseWearableCsv(text);
      for (const reading of parsed)
        grouped.set(reading.id, [...(grouped.get(reading.id) ?? []), reading]);
    }
    return Array.from(grouped.entries()).map(([id, readings]) => {
      const unit = readings.find((reading) => reading.unit)?.unit;
      const windowDays = readings.reduce(
        (total, reading) => total + (reading.window_days ?? 1),
        0
      );
      const value = WEARABLE_SUM_METRICS.has(id)
        ? readings.reduce((total, reading) => total + reading.value, 0)
        : Math.round(
            (readings.reduce(
              (total, reading) =>
                total + reading.value * (reading.window_days ?? 1),
              0
            ) /
              windowDays) *
              100
          ) / 100;
      return { id, value, unit, window_days: windowDays };
    });
  }
  const text = fs.readFileSync(filePath, "utf8");
  return filePath.toLowerCase().endsWith(".json")
    ? parseWearableJson(text)
    : parseWearableCsv(text);
}
