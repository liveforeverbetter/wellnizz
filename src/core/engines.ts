import { HEALTH_CONNECT_METRIC_MAP } from '../connectors/wearables.js';

export interface BiomarkerReading {
  id: string;
  value: number;
  unit?: string;
  raw_value?: string;
  collected_at?: string;
  original_unit?: string;
}

export interface WearableReading {
  id: string;
  value: number;
  unit?: string;
  window_days?: number;
  original_unit?: string;
}

export interface EngineFinding {
  id: string;
  name: string;
  status: 'optimal' | 'watch' | 'needs_attention' | 'missing';
  score: number;
  value?: number;
  interpretation: string;
  action: string;
  source_type?: 'direct' | 'derived';
  domain?: string;
  inputs?: string[];
  unit?: string;
  optimal_min?: number;
  optimal_max?: number;
  converted_from?: string;
  unit_unrecognized?: boolean;
  // Which side of the target range the value fell on, so downstream engines (the
  // action plan) can map a finding to direction-specific interventions.
  direction?: 'low' | 'high' | 'ok';
}

interface Range {
  optimal_min?: number;
  optimal_max?: number;
  critical_low?: number;
  critical_high?: number;
}

// A unit conversion is either a multiplicative factor to the canonical unit or a
// function for non-linear conversions (e.g. HbA1c IFCC mmol/mol -> NGSP %).
type UnitConversion = number | ((value: number) => number);

interface Definition extends Range {
  id: string;
  aliases: string[];
  name: string;
  domain: string;
  unit: string;
  action_low?: string;
  action_high?: string;
  // Normalized alternate-unit keys (see normalizeUnit) -> conversion to canonical unit.
  alt_units?: Record<string, UnitConversion>;
  // Sex-specific ranges override the base range for the matching sex.
  ranges_by_sex?: { male?: Range; female?: Range };
}

// EU labs report many analytes in SI units. Each biomarker declares the canonical
// unit its thresholds are expressed in, plus factors/functions to convert common
// SI units into that canonical unit. Without this, e.g. glucose 5.0 mmol/L would be
// scored against a 70-90 mg/dL band and wrongly flagged critically low.
const MMOL_L_TO_MG_DL_GLUCOSE = 18.0182;
const MMOL_L_TO_MG_DL_CHOL = 38.67;
const MMOL_L_TO_MG_DL_TG = 88.57;
const UMOL_L_TO_MG_DL_CREAT = 1 / 88.42;

const BIOMARKERS: Definition[] = [
  // Cardiometabolic
  { id: 'apob', aliases: ['apo b', 'apolipoprotein b'], name: 'ApoB', domain: 'cardiometabolic', unit: 'mg/dL', optimal_max: 80, critical_high: 120, alt_units: { 'g/l': 100 }, action_high: 'Review ApoB lowering strategy, fiber, protein, blood pressure, and ASCVD risk with a clinician.' },
  { id: 'triglycerides', aliases: ['tg', 'trigs'], name: 'Triglycerides', domain: 'cardiometabolic', unit: 'mg/dL', optimal_max: 100, critical_high: 200, alt_units: { 'mmol/l': MMOL_L_TO_MG_DL_TG }, action_high: 'Review alcohol, refined carbohydrate, insulin resistance, and omega-3 or fiber intake.' },
  { id: 'hdl_c', aliases: ['hdl', 'hdl cholesterol'], name: 'HDL-C', domain: 'cardiometabolic', unit: 'mg/dL', optimal_min: 50, critical_low: 35, alt_units: { 'mmol/l': MMOL_L_TO_MG_DL_CHOL }, ranges_by_sex: { male: { optimal_min: 45, critical_low: 35 }, female: { optimal_min: 50, critical_low: 40 } }, action_low: 'Use HDL-C as context; focus on exercise, triglycerides, and insulin sensitivity.' },
  { id: 'ldl_c', aliases: ['ldl', 'ldl cholesterol'], name: 'LDL-C', domain: 'cardiometabolic', unit: 'mg/dL', optimal_max: 100, critical_high: 190, alt_units: { 'mmol/l': MMOL_L_TO_MG_DL_CHOL }, action_high: 'Interpret alongside ApoB, Lp(a), blood pressure, family history, and clinician guidance.' },
  { id: 'total_cholesterol', aliases: ['tc', 'cholesterol', 'total cholesterol'], name: 'Total cholesterol', domain: 'cardiometabolic', unit: 'mg/dL', optimal_max: 200, critical_high: 240, alt_units: { 'mmol/l': MMOL_L_TO_MG_DL_CHOL }, action_high: 'Use total cholesterol as context; prioritize ApoB, non-HDL-C, LDL-C, and Lp(a) for risk discussion.' },
  { id: 'non_hdl_c', aliases: ['non hdl', 'non-hdl cholesterol'], name: 'Non-HDL-C', domain: 'cardiometabolic', unit: 'mg/dL', optimal_max: 130, critical_high: 190, alt_units: { 'mmol/l': MMOL_L_TO_MG_DL_CHOL }, action_high: 'Treat non-HDL-C as a practical ApoB surrogate when ApoB is unavailable.' },
  { id: 'lp_a', aliases: ['lpa', 'lp(a)', 'lipoprotein a'], name: 'Lp(a)', domain: 'cardiometabolic', unit: 'mg/dL', optimal_max: 30, critical_high: 50, alt_units: { 'nmol/l': 0.4357 }, action_high: 'Treat elevated Lp(a) as inherited cardiovascular context; optimize ApoB and discuss risk stratification.' },
  { id: 'apoa1', aliases: ['apo a1', 'apolipoprotein a1'], name: 'ApoA1', domain: 'cardiometabolic', unit: 'mg/dL', optimal_min: 120, critical_low: 100, alt_units: { 'g/l': 100 }, action_low: 'Use ApoA1 with ApoB/ApoA1 balance, triglycerides, activity, and nutrition context.' },
  // Glucose and insulin
  { id: 'hba1c', aliases: ['a1c', 'hemoglobin a1c'], name: 'HbA1c', domain: 'glucose_insulin', unit: '%', optimal_max: 5.3, critical_high: 6.5, alt_units: { 'mmol/mol': (v: number) => v / 10.929 + 2.15 }, action_high: 'Confirm with fasting glucose or CGM and pair nutrition changes with resistance training and post-meal walking.' },
  { id: 'fasting_insulin', aliases: ['insulin'], name: 'Fasting insulin', domain: 'glucose_insulin', unit: 'uIU/mL', optimal_max: 8, critical_high: 15, alt_units: { 'pmol/l': 1 / 6.945 }, action_high: 'Use this as an early insulin-resistance signal; prioritize waist reduction, resistance training, and meal composition.' },
  { id: 'fasting_glucose', aliases: ['glucose', 'fasting blood glucose'], name: 'Fasting glucose', domain: 'glucose_insulin', unit: 'mg/dL', optimal_min: 70, optimal_max: 90, critical_high: 126, alt_units: { 'mmol/l': MMOL_L_TO_MG_DL_GLUCOSE }, action_high: 'Pair with insulin and HbA1c before interpreting the metabolic pattern.' },
  // Inflammation and immune
  { id: 'hs_crp', aliases: ['crp', 'high sensitivity crp'], name: 'hs-CRP', domain: 'inflammation_immune', unit: 'mg/L', optimal_max: 1, critical_high: 3, alt_units: { 'mg/dl': 10, 'nmol/l': 1 / 9.524 }, action_high: 'Repeat when healthy and review infection, injury, oral health, sleep debt, and visceral-fat drivers.' },
  { id: 'homocysteine', aliases: ['hcy', 'total homocysteine'], name: 'Homocysteine', domain: 'inflammation_immune', unit: 'umol/L', optimal_max: 9, critical_high: 15, alt_units: { 'mg/l': 7.397 }, action_high: 'Review B12, folate, B6, kidney function, and MTHFR context; retest after 8-12 weeks of targeted B-vitamin support.' },
  { id: 'neutrophils', aliases: ['absolute neutrophils', 'neutrophil count'], name: 'Neutrophils', domain: 'inflammation_immune', unit: '10^3/uL', optimal_min: 1.8, optimal_max: 6.5, critical_low: 1, critical_high: 8, action_high: 'Review infection, stress, and inflammation with the full differential and clinician context.' },
  { id: 'lymphocytes', aliases: ['absolute lymphocytes', 'lymphocyte count'], name: 'Lymphocytes', domain: 'inflammation_immune', unit: '10^3/uL', optimal_min: 1.2, optimal_max: 3.5, critical_low: 0.8, critical_high: 4.5, action_low: 'Review recent illness, stress, training load, and clinician context; consider the neutrophil-to-lymphocyte ratio.' },
  // Nutrient status
  { id: 'ferritin', aliases: ['serum ferritin'], name: 'Ferritin', domain: 'nutrient_status', unit: 'ng/mL', optimal_min: 40, optimal_max: 150, critical_low: 20, critical_high: 300, alt_units: { 'ug/l': 1 }, ranges_by_sex: { male: { optimal_min: 50, optimal_max: 200, critical_low: 30, critical_high: 300 }, female: { optimal_min: 40, optimal_max: 150, critical_low: 20, critical_high: 250 } }, action_low: 'Review iron intake, blood loss, CBC, and clinician context.', action_high: 'Review inflammation, iron overload context, liver markers, and clinician follow-up.' },
  { id: 'vitamin_d', aliases: ['25-oh vitamin d', '25 hydroxy vitamin d', 'vitamin d'], name: 'Vitamin D', domain: 'nutrient_status', unit: 'ng/mL', optimal_min: 35, optimal_max: 60, critical_low: 20, critical_high: 100, alt_units: { 'nmol/l': 1 / 2.496 }, action_low: 'Review sunlight, diet, supplementation, magnesium, and retest after 8-12 weeks.', action_high: 'Avoid escalating vitamin D without calcium, kidney, and clinician context.' },
  { id: 'b12', aliases: ['vitamin b12', 'cobalamin'], name: 'Vitamin B12', domain: 'nutrient_status', unit: 'pg/mL', optimal_min: 450, critical_low: 250, alt_units: { 'pmol/l': 1.355 }, action_low: 'Review intake, absorption, metformin/PPI context, methylmalonic acid, and clinician guidance.' },
  { id: 'folate', aliases: ['serum folate', 'folic acid'], name: 'Folate', domain: 'nutrient_status', unit: 'ng/mL', optimal_min: 6, critical_low: 3, alt_units: { 'nmol/l': 1 / 2.265 }, action_low: 'Review leafy greens, legumes, alcohol, and B12/homocysteine context; retest after dietary change.' },
  { id: 'magnesium', aliases: ['serum magnesium', 'rbc magnesium'], name: 'Magnesium', domain: 'nutrient_status', unit: 'mg/dL', optimal_min: 2, optimal_max: 2.6, critical_low: 1.7, alt_units: { 'mmol/l': 2.43 }, action_low: 'Serum magnesium is insensitive; prioritize dietary magnesium, and consider RBC magnesium if symptoms persist.' },
  { id: 'uric_acid', aliases: ['urate', 'serum uric acid'], name: 'Uric acid', domain: 'nutrient_status', unit: 'mg/dL', optimal_max: 6, critical_high: 8, alt_units: { 'umol/l': 1 / 59.48 }, ranges_by_sex: { male: { optimal_max: 6.5, critical_high: 8.5 }, female: { optimal_max: 5.5, critical_high: 7.5 } }, action_high: 'Review fructose, alcohol, purine load, hydration, and metabolic context; discuss gout risk with a clinician.' },
  { id: 'omega3_index', aliases: ['omega-3 index', 'omega 3 index'], name: 'Omega-3 index', domain: 'nutrient_status', unit: '%', optimal_min: 8, critical_low: 4, action_low: 'Increase oily fish or EPA/DHA supplementation and retest after 12-16 weeks.' },
  // Hormone and thyroid
  { id: 'tsh', aliases: ['thyroid stimulating hormone'], name: 'TSH', domain: 'hormone_thyroid', unit: 'mIU/L', optimal_min: 0.5, optimal_max: 2.5, critical_low: 0.1, critical_high: 4.5, action_low: 'Interpret low TSH with free T4/T3, symptoms, medications, and clinician context.', action_high: 'Interpret high TSH with free T4/T3, thyroid antibodies, symptoms, and clinician context.' },
  { id: 'free_t4', aliases: ['ft4', 'free thyroxine'], name: 'Free T4', domain: 'hormone_thyroid', unit: 'ng/dL', optimal_min: 1, optimal_max: 1.6, critical_low: 0.8, critical_high: 2, alt_units: { 'pmol/l': 1 / 12.87 }, action_low: 'Interpret with TSH, free T3, symptoms, energy availability, and clinician context.', action_high: 'Interpret with TSH, symptoms, supplements, and clinician context.' },
  { id: 'free_t3', aliases: ['ft3', 'free triiodothyronine'], name: 'Free T3', domain: 'hormone_thyroid', unit: 'pg/mL', optimal_min: 2.8, optimal_max: 4.2, critical_low: 2.2, critical_high: 5, alt_units: { 'pmol/l': 1 / 1.536 }, action_low: 'Review energy availability, illness, training load, thyroid labs, and clinician context.', action_high: 'Interpret with TSH/free T4 and clinician context before action.' },
  { id: 'total_testosterone', aliases: ['testosterone', 'total t'], name: 'Total testosterone', domain: 'hormone_thyroid', unit: 'ng/dL', optimal_min: 500, optimal_max: 900, critical_low: 300, critical_high: 1100, alt_units: { 'nmol/l': 28.842 }, ranges_by_sex: { male: { optimal_min: 500, optimal_max: 900, critical_low: 300, critical_high: 1100 }, female: { optimal_min: 15, optimal_max: 70, critical_low: 8, critical_high: 90 } }, action_low: 'Review sleep, body composition, training, alcohol, and SHBG; discuss symptoms and confirmatory testing with a clinician.' },
  { id: 'free_testosterone', aliases: ['free t'], name: 'Free testosterone', domain: 'hormone_thyroid', unit: 'pg/mL', optimal_min: 90, optimal_max: 250, critical_low: 50, alt_units: { 'pmol/l': 0.288 }, ranges_by_sex: { male: { optimal_min: 90, optimal_max: 250, critical_low: 50 }, female: { optimal_min: 1, optimal_max: 8.5, critical_low: 0.5 } }, action_low: 'Interpret with total testosterone, SHBG, symptoms, and clinician context.' },
  { id: 'estradiol', aliases: ['e2', 'oestradiol'], name: 'Estradiol', domain: 'hormone_thyroid', unit: 'pg/mL', optimal_min: 20, optimal_max: 40, critical_high: 60, alt_units: { 'pmol/l': 1 / 3.671 }, action_high: 'Estradiol is sex- and cycle-dependent; interpret with sex, menstrual phase, symptoms, and clinician context.' },
  { id: 'shbg', aliases: ['sex hormone binding globulin'], name: 'SHBG', domain: 'hormone_thyroid', unit: 'nmol/L', optimal_min: 20, optimal_max: 60, critical_low: 10, critical_high: 80, action_high: 'Interpret SHBG with total/free testosterone, thyroid, insulin, and liver context.' },
  { id: 'dhea_s', aliases: ['dhea-s', 'dhea sulfate', 'dheas'], name: 'DHEA-S', domain: 'hormone_thyroid', unit: 'ug/dL', optimal_min: 150, optimal_max: 400, critical_low: 80, alt_units: { 'umol/l': 38.46 }, action_low: 'DHEA-S declines with age; interpret with symptoms, stress, and clinician context before supplementation.' },
  { id: 'cortisol_morning', aliases: ['morning cortisol', 'am cortisol', 'cortisol'], name: 'Morning cortisol', domain: 'hormone_thyroid', unit: 'ug/dL', optimal_min: 10, optimal_max: 18, critical_low: 5, critical_high: 25, alt_units: { 'nmol/l': 1 / 27.59 }, action_high: 'Interpret morning cortisol with sleep, stress, timing, and clinician context; a single value is a weak signal.' },
  { id: 'igf_1', aliases: ['igf-1', 'insulin-like growth factor 1'], name: 'IGF-1', domain: 'hormone_thyroid', unit: 'ng/mL', optimal_min: 120, optimal_max: 200, critical_low: 80, critical_high: 280, alt_units: { 'nmol/l': 7.649 }, action_high: 'IGF-1 is age-dependent and links growth signaling to longevity trade-offs; interpret with age norms and clinician context.' },
  // Organ function and safety
  { id: 'creatinine', aliases: ['serum creatinine'], name: 'Creatinine', domain: 'organ_function', unit: 'mg/dL', optimal_min: 0.6, optimal_max: 1.2, critical_high: 1.5, alt_units: { 'umol/l': UMOL_L_TO_MG_DL_CREAT }, ranges_by_sex: { male: { optimal_min: 0.7, optimal_max: 1.3, critical_high: 1.6 }, female: { optimal_min: 0.6, optimal_max: 1.1, critical_high: 1.4 } }, action_high: 'Interpret with eGFR, cystatin C, hydration, muscle mass, medications, and clinician context.' },
  { id: 'egfr', aliases: ['e gfr', 'estimated glomerular filtration rate'], name: 'eGFR', domain: 'organ_function', unit: 'mL/min/1.73m2', optimal_min: 90, critical_low: 60, action_low: 'Review hydration, creatinine/cystatin C, blood pressure, medications, and clinician follow-up.' },
  { id: 'cystatin_c', aliases: ['cystatin c'], name: 'Cystatin C', domain: 'organ_function', unit: 'mg/L', optimal_max: 1, critical_high: 1.3, action_high: 'Cystatin C estimates kidney function independent of muscle mass; interpret with creatinine, eGFR, and clinician context.' },
  { id: 'alt', aliases: ['alanine aminotransferase', 'sgpt'], name: 'ALT', domain: 'organ_function', unit: 'U/L', optimal_max: 30, critical_high: 55, action_high: 'Review alcohol, liver fat, medication/supplement load, viral illness, and clinician context.' },
  { id: 'ast', aliases: ['aspartate aminotransferase', 'sgot'], name: 'AST', domain: 'organ_function', unit: 'U/L', optimal_max: 30, critical_high: 55, action_high: 'Interpret with ALT, CK, training, alcohol, and clinician context.' },
  { id: 'ggt', aliases: ['gamma gt', 'gamma-glutamyl transferase'], name: 'GGT', domain: 'organ_function', unit: 'U/L', optimal_max: 25, critical_high: 60, action_high: 'Review alcohol, oxidative stress, liver/gallbladder context, and clinician follow-up.' },
  { id: 'alp', aliases: ['alkaline phosphatase'], name: 'ALP', domain: 'organ_function', unit: 'U/L', optimal_min: 40, optimal_max: 100, critical_high: 130, action_high: 'Interpret ALP with liver vs bone source, GGT, vitamin D, and clinician context.' },
  { id: 'bilirubin_total', aliases: ['bilirubin', 'total bilirubin'], name: 'Total bilirubin', domain: 'organ_function', unit: 'mg/dL', optimal_max: 1.2, critical_high: 2, alt_units: { 'umol/l': 1 / 17.1 }, action_high: 'Mild elevation is often Gilbert syndrome; interpret with liver enzymes, hemolysis markers, and clinician context.' },
  { id: 'albumin', aliases: ['serum albumin'], name: 'Albumin', domain: 'organ_function', unit: 'g/dL', optimal_min: 4, optimal_max: 5, critical_low: 3.5, alt_units: { 'g/l': 0.1 }, action_low: 'Review protein intake, inflammation, liver/kidney context, and clinician follow-up.' },
  { id: 'bun', aliases: ['blood urea nitrogen', 'urea nitrogen'], name: 'BUN', domain: 'organ_function', unit: 'mg/dL', optimal_min: 8, optimal_max: 20, critical_high: 25, alt_units: { 'mmol/l': 2.801 }, action_high: 'Interpret BUN with hydration, protein intake, creatinine, and clinician context.' },
  // Hematology
  { id: 'hemoglobin', aliases: ['hgb', 'haemoglobin'], name: 'Hemoglobin', domain: 'hematology', unit: 'g/dL', optimal_min: 13.5, optimal_max: 16.5, critical_low: 12, critical_high: 18, alt_units: { 'g/l': 0.1, 'mmol/l': 1.611 }, ranges_by_sex: { male: { optimal_min: 13.5, optimal_max: 17, critical_low: 12.5, critical_high: 18 }, female: { optimal_min: 12, optimal_max: 15.5, critical_low: 11, critical_high: 16.5 } }, action_low: 'Review CBC indices, ferritin, B12/folate, blood loss, training load, and clinician context.', action_high: 'Review hydration, altitude, sleep breathing risk, and clinician context.' },
  { id: 'hematocrit', aliases: ['hct', 'haematocrit', 'packed cell volume'], name: 'Hematocrit', domain: 'hematology', unit: '%', optimal_min: 40, optimal_max: 50, critical_low: 36, critical_high: 54, alt_units: { 'l/l': 100, 'ratio': 100 }, ranges_by_sex: { male: { optimal_min: 41, optimal_max: 50, critical_low: 38, critical_high: 54 }, female: { optimal_min: 36, optimal_max: 46, critical_low: 33, critical_high: 49 } }, action_low: 'Interpret with hemoglobin, ferritin, and CBC indices.', action_high: 'Review hydration, altitude, and clinician context.' },
  { id: 'wbc', aliases: ['white blood cells', 'white blood cell count'], name: 'WBC', domain: 'hematology', unit: '10^3/uL', optimal_min: 4, optimal_max: 8, critical_low: 3, critical_high: 11, action_low: 'Interpret with differential, infection history, medications, and clinician context.', action_high: 'Review infection, inflammation, stress, medications, and clinician context.' },
  { id: 'platelets', aliases: ['platelet count'], name: 'Platelets', domain: 'hematology', unit: '10^3/uL', optimal_min: 150, optimal_max: 350, critical_low: 100, critical_high: 450, action_low: 'Interpret with CBC, bleeding/bruising context, medications, and clinician guidance.', action_high: 'Review inflammation, iron status, recent illness, and clinician guidance.' },
  { id: 'rdw', aliases: ['red cell distribution width'], name: 'RDW', domain: 'hematology', unit: '%', optimal_max: 13.5, critical_high: 15, action_high: 'Elevated RDW suggests mixed red-cell populations; interpret with ferritin, B12/folate, and clinician context.' },
  { id: 'mcv', aliases: ['mean corpuscular volume'], name: 'MCV', domain: 'hematology', unit: 'fL', optimal_min: 82, optimal_max: 96, critical_low: 76, critical_high: 100, action_high: 'High MCV points to B12/folate, alcohol, or thyroid context; low points to iron or thalassemia context. Interpret with a clinician.' },
  // Cancer-screening context (wellness framing)
  { id: 'psa', aliases: ['prostate specific antigen', 'psa total'], name: 'PSA', domain: 'cancer_screening', unit: 'ng/mL', optimal_max: 2.5, critical_high: 4, alt_units: { 'ug/l': 1 }, action_high: 'PSA is age-dependent and non-specific; discuss elevated or rising PSA with a clinician before further screening.' },
];

const WEARABLES: Definition[] = [
  { id: 'sleep_duration', aliases: ['sleep hours', 'total sleep', 'asleep duration', 'sleep_duration_seconds', 'sleep_total_duration_minutes'], name: 'Sleep duration', domain: 'sleep_recovery', unit: 'hours', optimal_min: 7, optimal_max: 9, critical_low: 6, critical_high: 10, action_low: 'Increase sleep opportunity by 30-60 minutes and protect a fixed wake time for two weeks.' },
  { id: 'sleep_efficiency', aliases: ['efficiency_percent', 'sleep efficiency'], name: 'Sleep efficiency', domain: 'sleep_recovery', unit: '%', optimal_min: 85, critical_low: 75, action_low: 'Review sleep fragmentation, alcohol, room conditions, late training, and breathing risk if efficiency remains low.' },
  { id: 'deep_sleep_minutes', aliases: ['sleep_deep_minutes', 'deep minutes', 'deep sleep'], name: 'Deep sleep', domain: 'sleep_recovery', unit: 'min', optimal_min: 60, critical_low: 35, action_low: 'Use this as a directional signal; prioritize sufficient sleep opportunity, regular timing, and recovery from hard training.' },
  { id: 'rem_sleep_minutes', aliases: ['sleep_rem_minutes', 'rem minutes', 'rem sleep'], name: 'REM sleep', domain: 'sleep_recovery', unit: 'min', optimal_min: 70, critical_low: 40, action_low: 'Review sleep duration, alcohol, stress, and late caffeine if REM sleep remains compressed.' },
  { id: 'sleep_debt_minutes', aliases: ['sleep debt', 'sleep debt minutes'], name: 'Sleep debt', domain: 'sleep_recovery', unit: 'min', optimal_max: 30, critical_high: 90, action_high: 'Repay sleep debt before adding training intensity or interpreting hormonal and glucose signals.' },
  { id: 'recovery_score', aliases: ['whoop recovery', 'oura readiness', 'readiness'], name: 'Recovery/readiness score', domain: 'sleep_recovery', unit: '%', optimal_min: 70, critical_low: 45, action_low: 'Use low-recovery days for lower-intensity training, daylight, hydration, and earlier bedtime.' },
  { id: 'hrv', aliases: ['heart rate variability', 'rmssd', 'heart_rate_variability_rmssd', 'heart_rate_variability_sdnn'], name: 'HRV', domain: 'cardiovascular_recovery', unit: 'ms', optimal_min: 45, critical_low: 25, action_low: 'Interpret against baseline; review sleep debt, alcohol, illness, stress, and training load.' },
  { id: 'resting_heart_rate', aliases: ['rhr', 'resting hr'], name: 'Resting heart rate', domain: 'cardiovascular_recovery', unit: 'bpm', optimal_max: 60, critical_high: 75, action_high: 'If elevated versus baseline, review illness, alcohol, heat, dehydration, sleep debt, and overtraining.' },
  { id: 'heart_rate', aliases: ['average heart rate', 'avg heart rate', 'mean heart rate'], name: 'Heart rate', domain: 'cardiovascular_recovery', unit: 'bpm', optimal_min: 50, optimal_max: 90, critical_high: 110, action_high: 'A high average heart rate versus baseline can reflect stress, illness, stimulants, dehydration, or low fitness. Review context and the trend rather than a single reading.' },
  { id: 'respiratory_rate', aliases: ['respiration rate', 'breathing rate'], name: 'Respiratory rate', domain: 'cardiovascular_recovery', unit: 'rpm', optimal_min: 12, optimal_max: 18, critical_high: 22, action_high: 'Watch for illness, altitude, asthma/allergy, or acute stress if this rises above baseline.' },
  { id: 'skin_temperature', aliases: ['skin temp', 'skin temperature celsius'], name: 'Skin temperature', domain: 'cardiovascular_recovery', unit: 'C', optimal_min: 32, optimal_max: 35, critical_low: 30, critical_high: 37, action_high: 'Treat temperature elevation as illness, heat, alcohol, or cycle-context signal before pushing training.' },
  { id: 'spo2', aliases: ['oxygen_saturation', 'spo2', 'blood oxygen'], name: 'SpO2', domain: 'cardiovascular_recovery', unit: '%', optimal_min: 95, critical_low: 92, action_low: 'Review device fit and sleep breathing context; persistent low SpO2 should be discussed with a clinician.' },
  { id: 'steps', aliases: ['daily steps'], name: 'Daily steps', domain: 'activity_training', unit: 'steps', optimal_min: 8000, critical_low: 4000, action_low: 'Raise baseline by 1000-2000 steps per day before adding harder conditioning.' },
  { id: 'active_energy', aliases: ['energy', 'active calories', 'active_energy', 'active_calories_burned'], name: 'Active energy', domain: 'activity_training', unit: 'kcal', optimal_min: 300, critical_low: 150, action_low: 'Use alongside steps and training load; raise baseline gradually before adding high-intensity work.' },
  { id: 'zone2_minutes', aliases: ['zone 2', 'moderate cardio minutes'], name: 'Zone 2 minutes', domain: 'activity_training', unit: 'min/week', optimal_min: 120, critical_low: 60, action_low: 'Build toward 120-180 weekly minutes of conversational aerobic work.' },
  { id: 'vigorous_minutes', aliases: ['vigorous activity', 'zone 4 minutes', 'zone 5 minutes'], name: 'Vigorous minutes', domain: 'activity_training', unit: 'min/week', optimal_min: 30, optimal_max: 120, critical_low: 10, critical_high: 180, action_low: 'Add one short interval or hill session after sleep and injury risk are stable.', action_high: 'Check recovery, injury risk, and HRV/RHR before adding more intensity.' },
  { id: 'workout_count', aliases: ['workouts', 'workout sessions'], name: 'Workout count', domain: 'activity_training', unit: 'sessions/week', optimal_min: 2, optimal_max: 6, critical_low: 1, action_low: 'Add one planned training session once sleep and recovery are stable.' },
  { id: 'strength_sessions', aliases: ['lifting sessions', 'resistance sessions'], name: 'Strength sessions', domain: 'activity_training', unit: 'sessions/week', optimal_min: 2, critical_low: 1, action_low: 'Add two full-body resistance sessions weekly before optimizing supplements.' },
  { id: 'vo2max_estimate', aliases: ['vo2 max', 'cardio fitness', 'vo2_max'], name: 'VO2max estimate', domain: 'activity_training', unit: 'mL/kg/min', optimal_min: 40, critical_low: 30, action_low: 'Use aerobic base plus one weekly intensity session and retest after 8-12 weeks.' },
  { id: 'sleep_consistency', aliases: ['sleep regularity', 'bedtime consistency'], name: 'Sleep consistency', domain: 'rhythm_consistency', unit: '%', optimal_min: 80, critical_low: 60, action_low: 'Anchor wake time and keep bedtime within a 60-minute window most nights.' },
  { id: 'bedtime_variability', aliases: ['bedtime variation'], name: 'Bedtime variability', domain: 'rhythm_consistency', unit: 'min', optimal_max: 60, critical_high: 120, action_high: 'Stabilize bedtime before interpreting HRV, glucose, or cortisol trends.' },
  { id: 'wake_variability', aliases: ['wake time variation'], name: 'Wake-time variability', domain: 'rhythm_consistency', unit: 'min', optimal_max: 60, critical_high: 120, action_high: 'Anchor wake time first; it is the easiest rhythm lever to standardize.' },
  { id: 'alcohol_days', aliases: ['alcohol nights', 'drinking days'], name: 'Alcohol days', domain: 'rhythm_consistency', unit: 'days/week', optimal_max: 1, critical_high: 4, action_high: 'Run a 2-week alcohol-free recovery experiment and compare HRV, RHR, sleep, and glucose.' },
  // Continuous glucose (metabolic wellness)
  { id: 'glucose_mean', aliases: ['mean glucose', 'average glucose', 'cgm mean', 'blood_glucose'], name: 'Mean glucose', domain: 'metabolic', unit: 'mg/dL', optimal_max: 100, critical_high: 120, alt_units: { 'mmol/l': MMOL_L_TO_MG_DL_GLUCOSE }, action_high: 'Review meal composition, post-meal movement, sleep, and stress; a rising mean glucose precedes HbA1c changes.' },
  { id: 'glucose_time_in_range', aliases: ['time in range', 'tir', 'glucose tir'], name: 'Glucose time in range', domain: 'metabolic', unit: '%', optimal_min: 95, critical_low: 70, action_low: 'Raise time in the 70-180 mg/dL band by adjusting refined-carb load, meal order, and post-meal walks.' },
  { id: 'glucose_cv', aliases: ['glucose variability', 'glucose cv', 'coefficient of variation'], name: 'Glucose variability (CV)', domain: 'metabolic', unit: '%', optimal_max: 36, critical_high: 45, action_high: 'High glucose variability is a metabolic-instability signal; stabilize meals, sleep, and stress before other tuning.' },
  // Body composition
  { id: 'body_fat_percent', aliases: ['body fat', 'body fat percent', 'bodyfat', 'body_fat'], name: 'Body fat', domain: 'body_composition', unit: '%', optimal_max: 25, critical_high: 32, ranges_by_sex: { male: { optimal_min: 10, optimal_max: 20, critical_high: 25 }, female: { optimal_min: 18, optimal_max: 28, critical_high: 35 } }, action_high: 'Prioritize resistance training, protein intake, sleep, and a modest energy deficit; interpret with waist and strength.' },
  { id: 'visceral_fat', aliases: ['visceral fat', 'visceral fat rating'], name: 'Visceral fat', domain: 'body_composition', unit: 'level', optimal_max: 10, critical_high: 13, action_high: 'Visceral fat drives cardiometabolic risk; prioritize sleep, resistance training, fiber/protein, and reduced refined carbs.' },
  { id: 'waist_circumference', aliases: ['waist', 'waist circumference'], name: 'Waist circumference', domain: 'body_composition', unit: 'cm', optimal_max: 94, critical_high: 102, alt_units: { 'in': 2.54, 'inch': 2.54, 'inches': 2.54 }, ranges_by_sex: { male: { optimal_max: 94, critical_high: 102 }, female: { optimal_max: 80, critical_high: 88 } }, action_high: 'Waist is a strong cardiometabolic-risk signal; pair resistance training, protein/fiber, and sleep with a modest deficit.' },
  { id: 'waist_to_height_ratio', aliases: ['waist to height', 'wthr', 'whtr'], name: 'Waist-to-height ratio', domain: 'body_composition', unit: 'ratio', optimal_max: 0.5, critical_high: 0.6, action_high: 'Keep waist below half your height; it tracks visceral fat better than BMI alone.' },
  { id: 'bmi', aliases: ['body mass index'], name: 'BMI', domain: 'body_composition', unit: 'kg/m2', optimal_min: 18.5, optimal_max: 25, critical_low: 16, critical_high: 30, action_high: 'BMI is a coarse signal; interpret with waist, body fat, and strength before acting.' },
  // Vitals
  { id: 'systolic_bp', aliases: ['systolic', 'systolic blood pressure', 'blood_pressure_systolic', 'sbp'], name: 'Systolic blood pressure', domain: 'vitals', unit: 'mmHg', optimal_min: 90, optimal_max: 120, critical_low: 80, critical_high: 140, action_high: 'Confirm with repeat resting measurements; review sodium, alcohol, sleep, stress, and clinician follow-up if persistently elevated.' },
  { id: 'diastolic_bp', aliases: ['diastolic', 'diastolic blood pressure', 'blood_pressure_diastolic', 'dbp'], name: 'Diastolic blood pressure', domain: 'vitals', unit: 'mmHg', optimal_min: 60, optimal_max: 80, critical_low: 50, critical_high: 90, action_high: 'Confirm with repeat resting measurements and review with a clinician if persistently elevated.' },
];

const BIOMARKER_LOOKUP = definitionLookup(BIOMARKERS);
const WEARABLE_LOOKUP = definitionLookup(WEARABLES);

export function parseBiomarkerCsv(text: string): BiomarkerReading[] {
  return parseCsv(text).map(rowToBiomarker).filter((item): item is BiomarkerReading => Boolean(item));
}

export function parseBiomarkerJson(text: string): BiomarkerReading[] {
  const parsed = JSON.parse(text) as unknown;
  const rows = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { readings?: unknown })?.readings) ? (parsed as { readings: unknown[] }).readings : [parsed];
  return rows.map(item => rowToBiomarker(flattenObject(item))).filter((reading): reading is BiomarkerReading => Boolean(reading));
}

// A compact unit token: starts with a letter/percent/micro sign and continues
// with unit characters (so "mg/dL", "mmol/mol", "%", "ng/mL", "U/L" are captured
// but the following word is not). This keeps units clean even when a PDF extracts
// all labs onto one line.
const UNIT_TOKEN = '[%\\u00b5a-zA-Z][a-zA-Z0-9/^.\\u00b5%]*';

// Every (marker id, label) pair, longest label first, so specific multi-word
// labels ("total cholesterol") are matched and consumed before shorter, more
// ambiguous ones ("cholesterol").
const BIOMARKER_LABELS: Array<{ id: string; label: string }> = BIOMARKERS
  .flatMap(def => [def.name, ...def.aliases, def.id].map(label => ({ id: def.id, label })))
  .sort((a, b) => b.label.length - a.label.length);

// Parse free-form or PDF-extracted lab text. Scans the whole text for each marker
// (not line-by-line), captures a clean unit, and blanks out matched spans so a
// shorter alias cannot re-match text already claimed by a longer label.
export function parseBiomarkerText(text: string): BiomarkerReading[] {
  let working = text;
  const readings: BiomarkerReading[] = [];
  const seen = new Set<string>();
  for (const { id, label } of BIOMARKER_LABELS) {
    if (seen.has(id)) continue;
    const match = working.match(new RegExp(`\\b${escapeRegex(label)}\\b[\\s:=-]*(-?\\d+(?:[.,]\\d+)*)\\s*(${UNIT_TOKEN})?`, 'i'));
    if (!match || match.index == null) continue;
    const value = parseDecimal(match[1]);
    if (value == null) continue;
    readings.push({ id, value, unit: match[2]?.trim() || BIOMARKER_LOOKUP.get(id)?.unit });
    seen.add(id);
    working = working.slice(0, match.index) + ' '.repeat(match[0].length) + working.slice(match.index + match[0].length);
  }
  return readings;
}

export function parseWearableCsv(text: string): WearableReading[] {
  return parseCsv(text).flatMap(row => rowToWearables(row));
}

export function parseWearableJson(text: string): WearableReading[] {
  const parsed = JSON.parse(text) as unknown;
  const rows = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { readings?: unknown })?.readings) ? (parsed as { readings: unknown[] }).readings : [parsed];
  return rows.flatMap(item => rowToWearables(flattenObject(item)));
}

export function analyzeBiomarkers(readings: BiomarkerReading[], profile?: { age?: number; sex?: 'male' | 'female' }): { findings: EngineFinding[] } {
  const canonical = readings.map(reading => canonicalizeReading(reading, BIOMARKER_LOOKUP.get(normalizeId(reading.id))));
  const findings = canonical
    .map(reading => findingFor(reading, BIOMARKER_LOOKUP.get(normalizeId(reading.id)), 'direct', undefined, profile))
    .filter((finding): finding is EngineFinding => Boolean(finding));

  const byId = new Map(findings.map(finding => [finding.id, finding]));
  const glucose = valueFor(canonical, 'fasting_glucose');
  const insulin = valueFor(canonical, 'fasting_insulin');
  if (glucose != null && insulin != null) {
    const homaIr = Math.round(((glucose * insulin) / 405) * 100) / 100;
    setDerived(byId, 'homa_ir', findingFor(
      { id: 'homa_ir', value: homaIr, unit: 'score' },
      { id: 'homa_ir', aliases: [], name: 'HOMA-IR', domain: 'glucose_insulin', unit: 'score', optimal_max: 1.5, critical_high: 2.9, action_high: 'Use the combined glucose-insulin signal to prioritize metabolic fundamentals and retest.' },
      'derived',
      ['fasting_glucose', 'fasting_insulin'],
    ));
  }
  const triglycerides = valueFor(canonical, 'triglycerides');
  const hdl = valueFor(canonical, 'hdl_c');
  if (triglycerides != null && hdl != null && hdl > 0) {
    const tgHdl = Math.round((triglycerides / hdl) * 100) / 100;
    setDerived(byId, 'tg_hdl_ratio', findingFor(
      { id: 'tg_hdl_ratio', value: tgHdl, unit: 'ratio' },
      { id: 'tg_hdl_ratio', aliases: [], name: 'TG/HDL-C ratio', domain: 'cardiometabolic', unit: 'ratio', optimal_max: 2, critical_high: 3.5, action_high: 'Use this lipid-insulin-resistance pattern with waist, glucose, ApoB, and training context before changing the plan.' },
      'derived',
      ['triglycerides', 'hdl_c'],
    ));
  }
  if (triglycerides != null && glucose != null && triglycerides > 0 && glucose > 0) {
    const tyg = Math.round(Math.log((triglycerides * glucose) / 2) * 100) / 100;
    setDerived(byId, 'tyg_index', findingFor(
      { id: 'tyg_index', value: tyg, unit: 'index' },
      { id: 'tyg_index', aliases: [], name: 'TyG index', domain: 'glucose_insulin', unit: 'index', optimal_max: 8.5, critical_high: 9, action_high: 'Treat this as a derived metabolic-efficiency signal; confirm with waist, insulin, HbA1c, activity, and repeat labs.' },
      'derived',
      ['triglycerides', 'fasting_glucose'],
    ));
  }
  const totalCholesterol = valueFor(canonical, 'total_cholesterol');
  const ldl = valueFor(canonical, 'ldl_c');
  const apob = valueFor(canonical, 'apob');
  const apoa1 = valueFor(canonical, 'apoa1');
  if (totalCholesterol != null && hdl != null) {
    const nonHdl = Math.round((totalCholesterol - hdl) * 10) / 10;
    if (nonHdl > 0) {
      setDerived(byId, 'non_hdl_c', findingFor(
        { id: 'non_hdl_c', value: nonHdl, unit: 'mg/dL' },
        BIOMARKER_LOOKUP.get('non_hdl_c'),
        'derived',
        ['total_cholesterol', 'hdl_c'],
      ));
    }
    if (hdl > 0) {
      const totalHdlRatio = Math.round((totalCholesterol / hdl) * 100) / 100;
      setDerived(byId, 'chol_hdl_ratio', findingFor(
        { id: 'chol_hdl_ratio', value: totalHdlRatio, unit: 'ratio' },
        { id: 'chol_hdl_ratio', aliases: [], name: 'Total cholesterol/HDL-C ratio', domain: 'cardiometabolic', unit: 'ratio', optimal_max: 4, critical_high: 5.5, action_high: 'Use this as a directional lipid balance signal; confirm with ApoB, LDL-C, non-HDL-C, Lp(a), and clinician risk context.' },
        'derived',
        ['total_cholesterol', 'hdl_c'],
      ));
    }
  }
  if (ldl != null && hdl != null && hdl > 0) {
    const ldlHdlRatio = Math.round((ldl / hdl) * 100) / 100;
    setDerived(byId, 'ldl_hdl_ratio', findingFor(
      { id: 'ldl_hdl_ratio', value: ldlHdlRatio, unit: 'ratio' },
      { id: 'ldl_hdl_ratio', aliases: [], name: 'LDL-C/HDL-C ratio', domain: 'cardiometabolic', unit: 'ratio', optimal_max: 2.5, critical_high: 3.5, action_high: 'Use this as context only; ApoB and non-HDL-C are better first-order lipid targets.' },
      'derived',
      ['ldl_c', 'hdl_c'],
    ));
  }
  if (totalCholesterol != null && ldl != null && hdl != null) {
    const remnantCholesterol = Math.round((totalCholesterol - ldl - hdl) * 10) / 10;
    if (remnantCholesterol > 0) {
      setDerived(byId, 'remnant_cholesterol', findingFor(
        { id: 'remnant_cholesterol', value: remnantCholesterol, unit: 'mg/dL' },
        { id: 'remnant_cholesterol', aliases: [], name: 'Remnant cholesterol', domain: 'cardiometabolic', unit: 'mg/dL', optimal_max: 20, critical_high: 30, action_high: 'Review triglycerides, insulin resistance, alcohol, refined carbohydrate intake, and ApoB context.' },
        'derived',
        ['total_cholesterol', 'ldl_c', 'hdl_c'],
      ));
    }
  }
  if (apob != null && apoa1 != null && apoa1 > 0) {
    const apobApoa1Ratio = Math.round((apob / apoa1) * 100) / 100;
    setDerived(byId, 'apob_apoa1_ratio', findingFor(
      { id: 'apob_apoa1_ratio', value: apobApoa1Ratio, unit: 'ratio' },
      { id: 'apob_apoa1_ratio', aliases: [], name: 'ApoB/ApoA1 ratio', domain: 'cardiometabolic', unit: 'ratio', optimal_max: 0.7, critical_high: 0.9, action_high: 'Use this as an atherogenic-particle balance signal; optimize ApoB and cardiometabolic fundamentals.' },
      'derived',
      ['apob', 'apoa1'],
    ));
  }
  const neutrophils = valueFor(canonical, 'neutrophils');
  const lymphocytes = valueFor(canonical, 'lymphocytes');
  if (neutrophils != null && lymphocytes != null && lymphocytes > 0) {
    const nlr = Math.round((neutrophils / lymphocytes) * 100) / 100;
    setDerived(byId, 'neutrophil_lymphocyte_ratio', findingFor(
      { id: 'neutrophil_lymphocyte_ratio', value: nlr, unit: 'ratio' },
      { id: 'neutrophil_lymphocyte_ratio', aliases: [], name: 'Neutrophil-to-lymphocyte ratio', domain: 'inflammation_immune', unit: 'ratio', optimal_max: 2, critical_high: 3, action_high: 'Elevated NLR is a systemic-inflammation signal; retest when well and review sleep, stress, and infection context.' },
      'derived',
      ['neutrophils', 'lymphocytes'],
    ));
  }
  const creatinine = valueFor(canonical, 'creatinine');
  if (creatinine != null && profile?.age != null && profile.sex) {
    const egfr = estimatedGfr2021(creatinine, profile.age, profile.sex);
    setDerived(byId, 'egfr', findingFor(
      { id: 'egfr', value: egfr, unit: 'mL/min/1.73m2' },
      BIOMARKER_LOOKUP.get('egfr'),
      'derived',
      ['creatinine', 'age', 'sex'],
      profile,
    ));
  }
  const signals = [
    triglycerides != null && triglycerides >= 150,
    hdl != null && hdl < 50,
    glucose != null && glucose >= 100,
    valueFor(canonical, 'hba1c') != null && valueFor(canonical, 'hba1c')! >= 5.7,
  ].filter(Boolean).length;
  if (signals > 0) {
    setDerived(byId, 'metabolic_signal_count', findingFor(
      { id: 'metabolic_signal_count', value: signals, unit: 'signals' },
      { id: 'metabolic_signal_count', aliases: [], name: 'Metabolic signal count', domain: 'glucose_insulin', unit: 'signals', optimal_max: 1, critical_high: 2, action_high: 'Use the combined pattern to prioritize sleep, protein/fiber intake, resistance training, post-meal movement, and a retest plan.' },
      'derived',
      ['triglycerides', 'hdl_c', 'fasting_glucose', 'hba1c'],
    ));
  }
  return { findings: Array.from(byId.values()).sort((a, b) => a.score - b.score) };
}

export function analyzeWearables(readings: WearableReading[]): { findings: EngineFinding[] } {
  return {
    findings: readings
      .map(reading => canonicalizeReading(reading, WEARABLE_LOOKUP.get(normalizeId(reading.id))))
      .map(reading => findingFor(reading, WEARABLE_LOOKUP.get(normalizeId(reading.id))))
      .filter((finding): finding is EngineFinding => Boolean(finding))
      .sort((a, b) => a.score - b.score),
  };
}

function rowToBiomarker(row: Record<string, string>): BiomarkerReading | undefined {
  const rawId = firstDefined(row, ['marker', 'biomarker', 'test', 'test_name', 'name', 'id']);
  const rawValue = firstDefined(row, ['value', 'result', 'result_value']);
  const value = numberFrom(rawValue);
  if (!rawId || value == null) return undefined;
  return {
    id: normalizeReadingId(rawId, BIOMARKER_LOOKUP),
    value,
    unit: firstDefined(row, ['unit', 'units']),
    collected_at: firstDefined(row, ['collected_at', 'date', 'observed_at']),
  };
}

function rowToWearables(row: Record<string, string>): WearableReading[] {
  const rawId = firstDefined(row, ['metric', 'name', 'id', 'type']);
  const rawValue = firstDefined(row, ['value', 'result', 'average']);
  if (rawId && rawValue != null) {
    const value = numberFrom(rawValue);
    return value == null ? [] : [{ id: wearableDefinitionFor(rawId)?.id ?? normalizeId(rawId), value, unit: firstDefined(row, ['unit', 'units']) }];
  }

  return Object.entries(row).flatMap(([key, value]) => {
    const numeric = numberFrom(value);
    const def = wearableDefinitionFor(key);
    return numeric == null || !def ? [] : [{ id: def.id, value: numeric, unit: def.unit }];
  });
}

// Resolve a raw wearable metric name to a canonical definition. Consults the
// Health Connect record-type map as a fallback so imported Health Connect names
// (which collapse to separator-less tokens like "restingheartrate") resolve to
// the same canonical ids the mobile SDK path produces, instead of only "steps".
function wearableDefinitionFor(rawId: string): Definition | undefined {
  const normalized = normalizeId(rawId);
  const direct = WEARABLE_LOOKUP.get(normalized);
  if (direct) return direct;
  const mapped = HEALTH_CONNECT_METRIC_MAP[normalized];
  return mapped ? WEARABLE_LOOKUP.get(mapped) : undefined;
}

// Convert a reading into the definition's canonical unit so scoring and derived
// calculations operate on one unit system regardless of what the lab reported.
function canonicalizeReading<T extends BiomarkerReading | WearableReading>(reading: T, def: Definition | undefined): T {
  if (!def || !Number.isFinite(reading.value)) return reading;
  const provided = reading.unit;
  if (provided == null || provided === '') return reading;
  const providedKey = normalizeUnit(provided);
  if (providedKey === normalizeUnit(def.unit)) return reading;
  const conversion = def.alt_units?.[providedKey];
  if (conversion == null) {
    // Unit given but neither canonical nor a known alternate: keep the value but
    // flag it so a misleading interpretation is not produced silently.
    return { ...reading, unit_unrecognized: true } as T & { unit_unrecognized?: boolean };
  }
  const converted = typeof conversion === 'function' ? conversion(reading.value) : reading.value * conversion;
  return { ...reading, value: Math.round(converted * 1000) / 1000, unit: def.unit, original_unit: provided };
}

function findingFor(
  reading: (BiomarkerReading | WearableReading) & { unit_unrecognized?: boolean },
  def: Definition | undefined,
  sourceType: 'direct' | 'derived' = 'direct',
  inputs?: string[],
  profile?: { age?: number; sex?: 'male' | 'female' },
): EngineFinding | undefined {
  if (!def || !Number.isFinite(reading.value)) return undefined;
  const range = resolveRange(def, profile);
  const scored = scoreReadingWithRange(reading.value, range);
  const unit = reading.unit || def.unit;
  const convertedNote = reading.original_unit ? ` (converted from ${reading.original_unit})` : '';
  const unrecognizedNote = reading.unit_unrecognized ? ' Unit was not recognized, so it was interpreted against the canonical unit; confirm the reported unit.' : '';
  return {
    id: def.id,
    name: def.name,
    status: scored.status,
    score: scored.score,
    value: reading.value,
    source_type: sourceType,
    domain: def.domain,
    inputs,
    unit,
    optimal_min: range.optimal_min,
    optimal_max: range.optimal_max,
    converted_from: reading.original_unit,
    unit_unrecognized: reading.unit_unrecognized,
    direction: scored.direction,
    interpretation: (scored.status === 'optimal'
      ? `${def.name} is inside the current wellness target range at ${reading.value} ${unit}${convertedNote}.`
      : `${def.name} is ${scored.direction} versus the current wellness target at ${reading.value} ${unit}${convertedNote}.`) + unrecognizedNote,
    action: actionFor(def, scored.status, scored.direction),
  };
}

function setDerived(byId: Map<string, EngineFinding>, id: string, finding: EngineFinding | undefined): void {
  if (!finding || byId.has(id)) return;
  byId.set(id, finding);
}

function estimatedGfr2021(creatinineMgDl: number, age: number, sex: 'male' | 'female'): number {
  const female = sex === 'female';
  const k = female ? 0.7 : 0.9;
  const alpha = female ? -0.241 : -0.302;
  const value = 142
    * Math.pow(Math.min(creatinineMgDl / k, 1), alpha)
    * Math.pow(Math.max(creatinineMgDl / k, 1), -1.2)
    * Math.pow(0.9938, age)
    * (female ? 1.012 : 1);
  return Math.round(value);
}

// Merge sex-specific range overrides onto the base definition range.
function resolveRange(def: Definition, profile?: { sex?: 'male' | 'female' }): Range {
  const base: Range = { optimal_min: def.optimal_min, optimal_max: def.optimal_max, critical_low: def.critical_low, critical_high: def.critical_high };
  const override = profile?.sex ? def.ranges_by_sex?.[profile.sex] : undefined;
  return override ? { ...base, ...override } : base;
}

function scoreReadingWithRange(value: number, range: Range): { status: EngineFinding['status']; score: number; direction: 'low' | 'high' | 'ok' } {
  if (range.critical_low != null && value < range.critical_low) return { status: 'needs_attention', score: 25, direction: 'low' };
  if (range.critical_high != null && value > range.critical_high) return { status: 'needs_attention', score: 25, direction: 'high' };
  if (range.optimal_min != null && value < range.optimal_min) return { status: 'watch', score: 55, direction: 'low' };
  if (range.optimal_max != null && value > range.optimal_max) return { status: 'watch', score: 55, direction: 'high' };
  return { status: 'optimal', score: 90, direction: 'ok' };
}

function scoreReading(value: number, def: Definition): { status: EngineFinding['status']; score: number; direction: 'low' | 'high' | 'ok' } {
  return scoreReadingWithRange(value, resolveRange(def));
}

function actionFor(def: Definition, status: EngineFinding['status'], direction: 'low' | 'high' | 'ok'): string {
  if (status === 'optimal') return `Maintain the current baseline and compare ${def.name} against future trends.`;
  if (direction === 'low' && def.action_low) return def.action_low;
  if (direction === 'high' && def.action_high) return def.action_high;
  return `Review ${def.name} with related signals before changing supplements, medication, or training load.`;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const delimiter = detectCsvDelimiter(lines[0]!);
  const headers = parseCsvLine(lines[0]!, delimiter).map(normalizeId);
  return lines.slice(1).map(line => {
    const cells = parseCsvLine(line, delimiter);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
  });
}

// European exports often use ';' (or a tab) as the column delimiter precisely
// because ',' is the decimal separator there. Pick whichever the header row uses
// most, defaulting to ','.
function detectCsvDelimiter(headerLine: string): string {
  const counts = [';', '\t', ','].map(d => [d, headerLine.split(d).length - 1] as const);
  const best = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return best[1] > 0 ? best[0] : ',';
}

function parseCsvLine(line: string, delimiter = ','): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function definitionLookup(definitions: Definition[]): Map<string, Definition> {
  const lookup = new Map<string, Definition>();
  for (const def of definitions) {
    for (const label of [def.id, def.name, ...def.aliases]) lookup.set(normalizeId(label), def);
  }
  return lookup;
}

function flattenObject(value: unknown): Record<string, string> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [normalizeId(key), String(item ?? '')]));
}

function normalizeReadingId(id: string, lookup: Map<string, Definition>): string {
  return lookup.get(normalizeId(id))?.id ?? normalizeId(id);
}

function normalizeId(id: string): string {
  return id.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// Normalize a unit string for lookup: lowercase, map micro sign to "u", drop
// spaces, and standardize the litre/deciliter casing so "µmol/L", "umol/l", and
// "uMol / L" all collapse to "umol/l".
function normalizeUnit(unit: string): string {
  return unit
    .toLowerCase()
    .replace(/µ|μ/g, 'u')
    .replace(/\s+/g, '')
    .replace(/·/g, '')
    .trim();
}

function numberFrom(value: string | undefined): number | undefined {
  return parseDecimal(value);
}

// Parse a numeric token that may use either '.' or ',' as the decimal separator,
// so European labs (glucose "5,1", creatinine "0,9") are read correctly rather
// than having the comma stripped ("5,1" -> 51). Rules, in order:
//   - both separators present: the rightmost one is the decimal, the other groups
//     (e.g. "1.234,56" -> 1234.56, "1,234.56" -> 1234.56)
//   - only commas, all in 3-digit groups (e.g. "250,000"): thousands grouping
//   - a single/trailing comma otherwise (e.g. "5,1", "0,45"): decimal comma
export function parseDecimal(value: string | number | undefined): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const token = value.trim().match(/-?\d[\d.,]*\d|-?\d/)?.[0];
  if (!token) return undefined;
  const lastComma = token.lastIndexOf(',');
  const lastDot = token.lastIndexOf('.');
  let normalized: string;
  if (lastComma === -1 && lastDot === -1) {
    normalized = token;
  } else if (lastComma > lastDot) {
    // Comma is rightmost. Treat as thousands grouping only when it is purely
    // 3-digit comma groups with no dot; otherwise the comma is the decimal mark.
    if (lastDot === -1 && /^-?\d{1,3}(,\d{3})+$/.test(token)) {
      normalized = token.replace(/,/g, '');
    } else {
      normalized = token.slice(0, lastComma).replace(/[.,]/g, '') + '.' + token.slice(lastComma + 1).replace(/[.,]/g, '');
    }
  } else {
    // Dot is rightmost: decimal dot, any commas are grouping.
    normalized = token.slice(0, lastDot).replace(/[.,]/g, '') + '.' + token.slice(lastDot + 1).replace(/[.,]/g, '');
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstDefined(row: Record<string, string>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[normalizeId(key)];
    if (value != null && value !== '') return value;
  }
  return undefined;
}

function dedupeReadings<T extends { id: string }>(readings: T[]): T[] {
  return Array.from(new Map(readings.map(reading => [reading.id, reading])).values());
}

function valueFor(readings: Array<BiomarkerReading & { unit_unrecognized?: boolean }>, id: string): number | undefined {
  const reading = readings.find(reading => normalizeId(reading.id) === id);
  // A reading whose unit we could not recognize is not interpretable, so it must
  // not feed derived metrics (HOMA-IR, TyG, ratios) that assume canonical units.
  if (!reading || reading.unit_unrecognized) return undefined;
  return reading.value;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type MarkerDefinition = Definition;

export type MarkerDirection = 'lower_is_better' | 'higher_is_better' | 'range' | 'unknown';

// Resolve a biomarker or wearable marker by id, canonical name, or alias so
// trends and other consumers reuse the same catalog the analysis engine uses.
export function resolveMarkerDefinition(nameOrId: string): MarkerDefinition | undefined {
  const key = normalizeId(nameOrId);
  return BIOMARKER_LOOKUP.get(key) ?? WEARABLE_LOOKUP.get(key);
}

export function markerDirectionality(def: MarkerDefinition): MarkerDirection {
  const hasMin = def.optimal_min != null;
  const hasMax = def.optimal_max != null;
  if (hasMin && hasMax) return 'range';
  if (hasMax) return 'lower_is_better';
  if (hasMin) return 'higher_is_better';
  return 'unknown';
}

export function scoreMarkerValue(value: number, def: MarkerDefinition): { status: EngineFinding['status']; score: number } {
  const scored = scoreReading(value, def);
  return { status: scored.status, score: scored.score };
}

// Convert a marker value to its canonical unit. Exposed for connectors and tests
// that need EU/SI-unit normalization outside the full analysis path.
export function convertMarkerToCanonical(nameOrId: string, value: number, unit?: string): { value: number; unit: string; converted_from?: string; unrecognized?: boolean } | undefined {
  const def = resolveMarkerDefinition(nameOrId);
  if (!def) return undefined;
  const reading = canonicalizeReading({ id: def.id, value, unit }, def) as BiomarkerReading & { unit_unrecognized?: boolean };
  return { value: reading.value, unit: reading.unit ?? def.unit, converted_from: reading.original_unit, unrecognized: reading.unit_unrecognized };
}
