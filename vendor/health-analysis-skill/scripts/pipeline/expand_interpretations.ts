/**
 * ClinVar → Interpretation DB Expansion Engine
 *
 * Reads ClinVar matches and generates structured interpretation entries for
 * clinically actionable variants that aren't in the curated interpretation DB.
 * Writes new entries to the appropriate category JSON files.
 *
 * Run: npx tsx scripts/pipeline/expand_interpretations.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Types
// ============================================================================

interface ClinVarMatch {
  rsid: string;
  clinicalSignificance: string;
  diseaseName: string;
  geneInfo: string;
  reviewStatus: string;
}

interface InterpretationEntry {
  gene: string;
  name: string;
  category: string;
  chrom: string;
  pos: number;
  display: string;
  interpretations: Record<string, {
    effect: string;
    interpretation: string;
    recommendations: string[];
    priority: 'low' | 'medium' | 'high' | 'critical';
  }>;
}

interface CategoryFile {
  version: string;
  updated: string;
  description: string;
  markers: Record<string, InterpretationEntry>;
}

// ============================================================================
// Gene symbol extraction from messy ClinVar geneInfo
// ============================================================================

const GENE_ID_PATTERN = /^([A-Z][A-Z0-9-]*):\d+$/;
const GENE_RELATED_PATTERN = /^([A-Z][A-Z0-9]+)-related/;
const KNOWN_GENE_SYMBOLS = new Set([
  'ABCB1','OPRM1','IL36RN','PRSS1','CFH','CFHR','ENPP1','SOD2','TBXT',
  'IL1B','FCN3','GLCCI1','EPO','NEB','CD244','IRF5','FCGR2B','TAS2R38',
  'CDKN2B','CDKN2A','PCSK9','LDLR','APOB','TTN','CFTR','KCNT1','NOTCH2',
  'ROR2','DOCK8','ABCA4','ABCA13','VPS13A','VPS13D','PARS2','TRAPPC12',
  'CYP51A1','WEE2','EGFR','GMPR','CFAP69','ATIC','PRDM16','EYS',
  'COL1A1','COL1A2','COL3A1','FBN1','TGFBR1','TGFBR2','SMAD3','ACTA2',
  'MYH11','MYH7','MYBPC3','TNNT2','TNNI3','TPM1','MYL2','MYL3','ACTC1',
  'PRKAG2','GLA','LMNA','RYR2','PKP2','DSP','DSC2','DSG2','TMEM43',
  'KCNQ1','KCNH2','SCN5A','BRCA1','BRCA2','TP53','MLH1','MSH2','MSH6',
  'PMS2','APC','MUTYH','PTEN','RET','VHL','SDHB','SDHC','SDHD','RB1',
  'ATP7B','OTC','RYR1','CACNA1S','STK11','BMPR1A','SMAD4',
  'MTHFR','COMT','BDNF','CYP1A2','CYP2C9','CYP2C19','CYP2D6','CYP3A4',
  'CYP3A5','SLCO1B1','DPYD','TPMT','UGT1A1','VKORC1','HLA-A','HLA-B',
]);

function extractGeneSymbol(rawGeneInfo: string): string | null {
  if (!rawGeneInfo || rawGeneInfo === 'not_provided' || rawGeneInfo === 'not_specified' || rawGeneInfo === 'unknown') {
    return null;
  }

  // Clean: GENE:EntrezID format
  const geneIdMatch = rawGeneInfo.match(GENE_ID_PATTERN);
  if (geneIdMatch) {
    const gene = geneIdMatch[1];
    if (KNOWN_GENE_SYMBOLS.has(gene) || /^[A-Z][A-Z0-9]{1,8}$/.test(gene)) {
      return gene;
    }
  }

  // Try GENE-related_condition pattern
  const relatedMatch = rawGeneInfo.match(GENE_RELATED_PATTERN);
  if (relatedMatch) {
    const gene = relatedMatch[1];
    if (KNOWN_GENE_SYMBOLS.has(gene) || /^[A-Z][A-Z0-9]{1,8}$/.test(gene)) {
      return gene;
    }
  }

  // Try gene symbol within underscores
  const underscoreParts = rawGeneInfo.split('_');
  for (const part of underscoreParts) {
    if (KNOWN_GENE_SYMBOLS.has(part)) return part;
  }

  // WEE2-AS1 pattern
  if (/^[A-Z][A-Z0-9-]+:\d+$/.test(rawGeneInfo)) {
    return rawGeneInfo.split(':')[0];
  }

  return null;
}

// ============================================================================
// Disease name cleaning
// ============================================================================

function cleanDiseaseName(raw: string): string {
  return raw
    .replace(/_/g, ' ')
    .replace(/not provided|not specified/i, '')
    .trim();
}

// ============================================================================
// Significance classification
// ============================================================================

function classifySignificance(sig: string): 'pathogenic' | 'likely_pathogenic' | 'conflicting' | 'risk_factor' | 'protective' | 'drug_response' | 'uncertain' {
  const s = sig.toLowerCase();
  // Check conflicting BEFORE pathogenic — "Conflicting_classifications_of_pathogenicity"
  // contains "pathogenic" but is not a pathogenic assertion
  if (s.includes('conflicting')) return 'conflicting';
  if (s.includes('pathogenic') && s.includes('likely') && !s.includes('uncertain')) return 'likely_pathogenic';
  if (s.includes('pathogenic') && !s.includes('benign') && !s.includes('uncertain')) return 'pathogenic';
  if (s.includes('risk_factor')) return 'risk_factor';
  if (s.includes('protective')) return 'protective';
  if (s.includes('drug')) return 'drug_response';
  return 'uncertain';
}

// ============================================================================
// Review status → confidence
// ============================================================================

function reviewStatusToConfidence(review: string): 'high' | 'medium' | 'low' {
  const r = review.toLowerCase();
  if (r.includes('expert_panel') || r.includes('practice_guideline')) return 'high';
  if (r.includes('multiple_submitters') || r.includes('criteria_provided')) return 'medium';
  return 'low';
}

// ============================================================================
// Category assignment
// ============================================================================

const CATEGORY_RULES: Array<{ pattern: RegExp; category: string }> = [
  // Hereditary / monogenic conditions
  { pattern: /cancer|tumor|neoplasm|melanom|leukemia|lymphoma|sarcoma|hereditary|lynch|li-fraumeni|brca|cowden|retinoblastoma|polyposis|fanconi|neuroblastoma/i, category: 'hereditary' },
  { pattern: /cardiomyopathy|arrhythmia|long qt|brugada|heart|aort|marfan|loey|ehlers|vascular|thoracic/i, category: 'hereditary' },
  { pattern: /muscular dystrophy|myopathy|nemaline|limb.girdle|emery.dreifuss/i, category: 'hereditary' },
  { pattern: /hearing loss|deafness|retinitis|blindness|usher|macular|eye|vision|achromatopsia|glaucoma/i, category: 'hereditary' },
  { pattern: /kidney|renal|nephron|cystic|polycystic|nephrotic|hemolytic.uremic|alport/i, category: 'hereditary' },
  { pattern: /metabolic|storage|gaucher|fabry|pompe|mucopolysacch|glycogen|niemann|gaucher|wilson|hemochromatosis|porphyria/i, category: 'hereditary' },
  { pattern: /epilepsy|seizure|encephalopathy|neurodegenerat|ataxia|spastic|charcot|huntington|parkinson|dementia|als/i, category: 'hereditary' },
  { pattern: /osteogenesis|bone|skeletal|dwarfism|chondro|dysplasia|arthrogryposis|scoliosis/i, category: 'hereditary' },
  { pattern: /immunodeficiency|immune|autoimmune|immunolog|chronic_granulomatous/i, category: 'hereditary' },
  { pattern: /ciliopathy|primary_ciliary|kartagener/i, category: 'hereditary' },
  { pattern: /skin|epidermolysis|ichthyosis|ectodermal|dermatol/i, category: 'hereditary' },
  { pattern: /blood|coagul|factor|thrombo|bleeding|hemophilia|anemia|thalassemia|sickle/i, category: 'hereditary' },
  { pattern: /diabetes|mody|maturity.onset/i, category: 'hereditary' },

  // Pharmacogenomics
  { pattern: /response|metabolism|sensitivity|resistance.*drug|tramadol|warfarin|clopidogrel|statin|methotrexate|levothyroxine|glucocorticoid|codeine|morphine|opioid/i, category: 'pharmacology' },

  // Vulnerability / disease risk
  { pattern: /hypercholesterolemia|cholesterol|lipid|ldl|hdl|triglyceride/i, category: 'vulnerability' },
  { pattern: /coronary|cardiovascular|myocardial|atheroscl|vascular/i, category: 'vulnerability' },
  { pattern: /obesity|body_mass|weight|adipos/i, category: 'vulnerability' },
  { pattern: /macula|age.related/i, category: 'vulnerability' },
  { pattern: /arthritis|rheumatoid|lupus|scleroderma|psoriasis|inflammatory/i, category: 'vulnerability' },

  // Wellness
  { pattern: /tasting|phenylthiocarbamide|bitter/i, category: 'wellness' },
  { pattern: /caffeine|alcohol|lactose/i, category: 'wellness' },
];

function assignCategory(diseaseName: string, geneInfo: string, significance: string): string {
  const sig = classifySignificance(significance);
  if (sig === 'drug_response') return 'pharmacogenomics';

  const text = `${diseaseName} ${geneInfo}`;
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(text)) return rule.category;
  }

  // Default: if it's pathogenic and in a known disease gene, it's hereditary
  if (sig === 'pathogenic' || sig === 'likely_pathogenic') return 'inherited-conditions';
  if (sig === 'risk_factor') return 'health-vulnerability';
  return 'health-vulnerability';
}

// ============================================================================
// Interpretation generation
// ============================================================================

function generateInterpretation(
  match: ClinVarMatch,
  gene: string | null,
  category: string
): InterpretationEntry | null {
  const disease = cleanDiseaseName(match.diseaseName);
  const sig = classifySignificance(match.clinicalSignificance);
  const confidence = reviewStatusToConfidence(match.reviewStatus);
  const displayGene = gene || disease || match.rsid;

  // Build the display name — prefer gene when available, use disease as subtitle
  let displayName: string;
  const isDiseasePlausible = disease && disease.length > 3 &&
    !/^(risk factor|protective|not specified|not provided)$/i.test(disease);

  if (gene && isDiseasePlausible) {
    displayName = `${gene} — ${disease}`;
  } else if (gene) {
    displayName = `${gene} variant`;
  } else if (isDiseasePlausible) {
    displayName = disease;
  } else {
    displayName = `${match.rsid} clinical variant`;
  }

  // Build interpretations based on significance type
  const interpretations: Record<string, any> = {};

  switch (sig) {
    case 'pathogenic':
    case 'likely_pathogenic':
      interpretations['*'] = {
        effect: `${sig === 'pathogenic' ? 'Pathogenic' : 'Likely pathogenic'} variant${gene ? ` in ${gene}` : ''}`,
        interpretation: `${disease ? `Associated with ${disease}. ` : ''}This variant has been classified as ${sig.replace('_', ' ')} by ClinVar${confidence !== 'low' ? ` (${match.reviewStatus.replace(/_/g, ' ')})` : ''}.${confidence === 'low' ? ' Note: limited evidence — single submitter or no assertion criteria.' : ''}`,
        recommendations: buildRecommendations(match, gene, category, sig),
        priority: sig === 'pathogenic' ? 'high' : 'medium',
      };
      break;

    case 'drug_response':
      interpretations['*'] = {
        effect: `Altered drug response${gene ? ` (${gene})` : ''}`,
        interpretation: `${disease ? `Relevant to ${disease}. ` : ''}Pharmacogenomic variant affecting drug metabolism or response. Clinical significance: ${match.clinicalSignificance.replace(/_/g, ' ')}.${confidence !== 'low' ? ` Review status: ${match.reviewStatus.replace(/_/g, ' ')}.` : ' Limited evidence available.'}`,
        recommendations: buildDrugRecommendations(match, gene),
        priority: 'high',
      };
      break;

    case 'risk_factor':
      interpretations['*'] = {
        effect: `Genetic risk factor${gene ? ` in ${gene}` : ''}`,
        interpretation: `${disease ? `Associated with altered risk for ${disease}. ` : ''}This variant has been identified as a genetic risk factor.${confidence !== 'low' ? ` Evidence: ${match.reviewStatus.replace(/_/g, ' ')}.` : ' Limited evidence — interpret with caution.'}`,
        recommendations: buildRiskRecommendations(match, gene, disease),
        priority: 'medium',
      };
      break;

    case 'protective':
      interpretations['*'] = {
        effect: `Protective variant${gene ? ` in ${gene}` : ''}`,
        interpretation: `${disease ? `Associated with reduced risk for ${disease}. ` : ''}This variant may confer a protective effect. Favorable genetic finding.`,
        recommendations: [
          'Maintain standard health practices',
          'This protective effect does not eliminate baseline risk — continue regular screening',
        ],
        priority: 'low',
      };
      break;

    case 'conflicting':
      // Skip conflicting interpretations — too uncertain to provide actionable guidance
      return null;

    default:
      return null;
  }

  return {
    gene: gene || 'ClinVar',
    name: match.rsid.replace('rs', ''),
    category,
    chrom: '',    // Would need VCF lookup for position
    pos: 0,       // Would need VCF lookup for position
    display: displayName,
    interpretations,
  };
}

function buildRecommendations(
  match: ClinVarMatch,
  gene: string | null,
  category: string,
  sig: string
): string[] {
  const recs: string[] = [];

  // ACMG genes get specific recommendations
  const acmgRecs = getACMGRecommendation(gene);
  if (acmgRecs.length > 0) {
    recs.push(...acmgRecs);
  } else {
    recs.push(
      `Discuss ${match.rsid} finding with a healthcare provider or genetic counselor`,
      'Consider family screening for this variant',
      'Follow condition-specific surveillance guidelines if applicable'
    );
  }

  if (sig === 'likely_pathogenic') {
    recs.push('Note: Likely pathogenic — confirmatory testing may be warranted');
  }

  return recs;
}

function buildDrugRecommendations(match: ClinVarMatch, gene: string | null): string[] {
  const disease = cleanDiseaseName(match.diseaseName);
  const recs: string[] = [
    'Discuss pharmacogenomic findings with prescribing physician',
  ];

  if (disease.toLowerCase().includes('tramadol')) {
    recs.push('Tramadol metabolism may be altered — consider dose adjustment or alternative analgesic');
  } else if (disease.toLowerCase().includes('statin')) {
    recs.push('Statin response may be attenuated — discuss alternative lipid-lowering strategies');
  } else if (disease.toLowerCase().includes('warfarin')) {
    recs.push('Warfarin dosing may need adjustment — consider pharmacogenomic-guided dosing');
  } else if (disease.toLowerCase().includes('clopidogrel')) {
    recs.push('Clopidogrel activation may be impaired — consider alternative antiplatelet therapy');
  } else if (disease.toLowerCase().includes('methotrexate')) {
    recs.push('Methotrexate response may vary — monitor efficacy and toxicity closely');
  } else if (disease.toLowerCase().includes('levothyroxine')) {
    recs.push('Levothyroxine dosing may need adjustment — monitor TSH levels');
  }

  recs.push('Include pharmacogenomic profile in medical record for future prescribing decisions');
  return recs;
}

function buildRiskRecommendations(match: ClinVarMatch, gene: string | null, disease: string): string[] {
  const recs: string[] = [];
  const d = disease.toLowerCase();

  if (d.includes('obesity') || d.includes('weight')) {
    recs.push('Maintain healthy diet and regular physical activity', 'Monitor BMI and metabolic markers regularly');
  } else if (d.includes('coronary') || d.includes('cardiovascular') || d.includes('heart')) {
    recs.push('Regular cardiovascular risk assessment including lipid panel and blood pressure', 'Discuss aspirin and statin primary prevention with healthcare provider');
  } else if (d.includes('macular') || d.includes('eye')) {
    recs.push('Regular comprehensive eye exams', 'Avoid smoking — significant risk factor for macular degeneration');
  } else if (d.includes('arthritis') || d.includes('rheumatoid')) {
    recs.push('Monitor for joint symptoms', 'Early rheumatology consultation if symptoms develop');
  } else {
    recs.push('Discuss risk factor with healthcare provider', 'Consider relevant screening based on family history and other risk factors');
  }

  return recs;
}

function getACMGRecommendation(gene: string | null): string[] {
  if (!gene) return [];
  const g = gene.toUpperCase();
  const acmgMap: Record<string, string[]> = {
    'BRCA1': ['Enhanced breast cancer screening (MRI + mammogram). Consider prophylactic surgery.', 'Consult genetic counselor for familial risk assessment.'],
    'BRCA2': ['Enhanced breast cancer screening. Male breast and prostate cancer risk.', 'Consult genetic counselor.'],
    'TP53': ['Comprehensive cancer surveillance protocol. Avoid radiation when possible.', 'Consult oncologist and genetic counselor.'],
    'LDLR': ['Aggressive lipid-lowering therapy. Screen family members.', 'Consult lipidologist or cardiologist.'],
    'APOB': ['Aggressive lipid management. Consider PCSK9 inhibitor if statins insufficient.', 'Consult cardiologist.'],
    'PCSK9': ['Gain-of-function: aggressive lipid-lowering. Loss-of-function is protective.', 'Consult cardiologist.'],
    'MLH1': ['Colonoscopy every 1-2 years starting age 20-25. Consider prophylactic hysterectomy.', 'Consult genetic counselor.'],
    'MSH2': ['Colonoscopy every 1-2 years starting age 20-25. Consider prophylactic surgery.', 'Consult genetic counselor.'],
    'MSH6': ['Colonoscopy every 1-2 years starting age 30. Endometrial cancer surveillance.', 'Consult genetic counselor.'],
    'PMS2': ['Colonoscopy every 1-2 years starting age 30. Moderate cancer risk increase.', 'Consult genetic counselor.'],
    'APC': ['Annual colonoscopy starting age 10-12. Prophylactic colectomy usually required.', 'Consult gastroenterologist.'],
    'PTEN': ['Comprehensive cancer surveillance. Thyroid ultrasound, breast MRI.', 'Consult genetic counselor.'],
    'RET': ['Prophylactic thyroidectomy recommended in childhood.', 'Consult endocrinologist and genetic counselor.'],
    'VHL': ['Annual surveillance for renal, CNS, and retinal tumors starting in childhood.', 'Consult specialist.'],
    'RB1': ['Specialized ophthalmic surveillance starting at birth.', 'Consult ophthalmologist and oncologist.'],
    'FBN1': ['Regular echocardiogram. Aortic root surveillance. Beta-blocker or ARB therapy.', 'Consult cardiologist.'],
    'RYR1': ['CRITICAL: Avoid succinylcholine and volatile anesthetics. Inform all anesthesiologists.', 'Medical alert bracelet recommended.'],
    'CACNA1S': ['CRITICAL: Avoid triggering anesthetics. Inform all anesthesiologists.', 'Medical alert bracelet recommended.'],
  };
  return acmgMap[g] || [];
}

// ============================================================================
// Main expansion logic
// ============================================================================

interface ExpansionResult {
  added: number;
  skipped: number;
  byCategory: Record<string, number>;
  entries: Array<{ rsid: string; gene: string; category: string; significance: string }>;
}

function expandInterpretations(
  clinvarMatches: ClinVarMatch[],
  existingRSIDs: Set<string>,
  categoryFiles: Record<string, CategoryFile>
): ExpansionResult {
  const result: ExpansionResult = {
    added: 0,
    skipped: 0,
    byCategory: {},
    entries: [],
  };

  for (const match of clinvarMatches) {
    // Skip if already in interpretation DB
    if (existingRSIDs.has(match.rsid)) {
      result.skipped++;
      continue;
    }

    const sig = classifySignificance(match.clinicalSignificance);
    // Skip uncertain, conflicting, and benign
    if (sig === 'uncertain' || sig === 'conflicting') {
      result.skipped++;
      continue;
    }

    // Extract gene symbol
    const gene = extractGeneSymbol(match.geneInfo);

    // Assign category
    const category = assignCategory(match.diseaseName, match.geneInfo, match.clinicalSignificance);

    // Generate interpretation
    const entry = generateInterpretation(match, gene, category);
    if (!entry) {
      result.skipped++;
      continue;
    }

    // Add to category file
    if (!categoryFiles[category]) {
      console.warn(`   ⚠️  Unknown category: ${category} for ${match.rsid}`);
      result.skipped++;
      continue;
    }

    categoryFiles[category].markers[match.rsid] = entry;
    result.added++;
    result.byCategory[category] = (result.byCategory[category] || 0) + 1;
    result.entries.push({
      rsid: match.rsid,
      gene: entry.gene,
      category,
      significance: match.clinicalSignificance,
    });
  }

  return result;
}

// ============================================================================
// File I/O
// ============================================================================

function loadClinVarMatches(path: string): ClinVarMatch[] {
  return JSON.parse(fs.readFileSync(path, 'utf-8'));
}

function loadExistingRSIDs(interpretationsDir: string): Set<string> {
  const rsids = new Set<string>();
  const files = fs.readdirSync(interpretationsDir).filter(f => f.endsWith('.json') && f !== 'README.md');
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(interpretationsDir, file), 'utf-8'));
      if (data.markers) {
        for (const rsid of Object.keys(data.markers)) {
          rsids.add(rsid);
        }
      }
    } catch {}
  }
  return rsids;
}

function loadCategoryFiles(interpretationsDir: string): Record<string, CategoryFile> {
  const files: Record<string, CategoryFile> = {};
  const categoryFiles = [
    { name: 'wellness.json', category: 'wellness' },
    { name: 'pharmacology.json', category: 'pharmacology' },
    { name: 'vulnerability.json', category: 'vulnerability' },
    { name: 'hereditary.json', category: 'hereditary' },
    { name: 'performance.json', category: 'performance' },
    { name: 'personality.json', category: 'personality' },
    { name: 'ancestry.json', category: 'ancestry' },
  ];

  for (const { name, category } of categoryFiles) {
    const filePath = path.join(interpretationsDir, name);
    if (fs.existsSync(filePath)) {
      try {
        files[category] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch {
        files[category] = {
          version: '1.0.0',
          updated: new Date().toISOString(),
          description: `ClinVar-expanded ${category} markers`,
          markers: {},
        };
      }
    }
  }
  return files;
}

function saveCategoryFiles(categoryFiles: Record<string, CategoryFile>, interpretationsDir: string): void {
  const categoryFileNames: Record<string, string> = {
    'wellness': 'wellness.json',
    'pharmacology': 'pharmacology.json',
    'vulnerability': 'vulnerability.json',
    'hereditary': 'hereditary.json',
    'performance': 'performance.json',
    'personality': 'personality.json',
    'ancestry': 'ancestry.json',
  };

  for (const [category, data] of Object.entries(categoryFiles)) {
    const fileName = categoryFileNames[category];
    if (!fileName) continue;

    data.updated = new Date().toISOString();

    // Only write if there are markers
    if (Object.keys(data.markers).length === 0) continue;

    const filePath = path.join(interpretationsDir, fileName);

    // Check if the file already has a markers key with existing data — preserve it
    let existingMarkers: Record<string, any> = {};
    if (fs.existsSync(filePath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (existing.markers) {
          existingMarkers = existing.markers;
        }
      } catch {}
    }

    // Merge: existing markers + new markers (new markers win on conflict)
    data.markers = { ...existingMarkers, ...data.markers };

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log(`   Saved: ${filePath} (${Object.keys(data.markers).length} markers total)`);
  }
}

// ============================================================================
// Entry point
// ============================================================================

function main() {
  console.log('🧬 ClinVar → Interpretation DB Expansion\n');

  const interpretationsDir = path.join(__dirname, '..', '..', 'shared', 'interpretations');
  const clinvarMatchesPath = path.join(__dirname, '..', '..', '..', '..', 'example-data', 'clinvar_matches.json');

  if (!fs.existsSync(clinvarMatchesPath)) {
    console.error(`❌ ClinVar matches not found at: ${clinvarMatchesPath}`);
    console.error('   Run the pipeline first to generate ClinVar matches, or provide a path.');
    process.exit(1);
  }

  // Load data
  console.log('📂 Loading data...');
  const clinvarMatches = loadClinVarMatches(clinvarMatchesPath);
  console.log(`   ClinVar matches: ${clinvarMatches.length}`);

  const existingRSIDs = loadExistingRSIDs(interpretationsDir);
  console.log(`   Existing interpreted RSIDs: ${existingRSIDs.size}`);

  const categoryFiles = loadCategoryFiles(interpretationsDir);
  console.log(`   Category files loaded: ${Object.keys(categoryFiles).length}`);

  // Expand
  console.log('\n🔬 Generating interpretations...');
  const result = expandInterpretations(clinvarMatches, existingRSIDs, categoryFiles);

  // Report
  console.log(`\n📊 Results:`);
  console.log(`   Added: ${result.added} new interpretations`);
  console.log(`   Skipped: ${result.skipped} (already covered or uncertain)`);
  console.log(`\n   By category:`);
  for (const [cat, count] of Object.entries(result.byCategory).sort(([,a], [,b]) => b - a)) {
    console.log(`     ${cat}: ${count}`);
  }

  // Save
  if (result.added > 0) {
    console.log('\n💾 Saving expanded category files...');
    saveCategoryFiles(categoryFiles, interpretationsDir);

    // Print added entries
    console.log(`\n✅ Added entries:`);
    for (const entry of result.entries) {
      console.log(`   ${entry.rsid.padEnd(14)} ${entry.gene.padEnd(12)} → ${entry.category.padEnd(15)} [${entry.significance}]`);
    }
  } else {
    console.log('\n⚠️  No new interpretations to add — everything is already covered.');
  }

  console.log('\n✅ Expansion complete.');
}

main();
