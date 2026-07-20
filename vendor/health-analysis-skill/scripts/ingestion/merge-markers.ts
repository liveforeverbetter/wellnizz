#!/usr/bin/env npx tsx
/**
 * Merge additional rsID markers into the interpretation database
 * Source: extracted-report-data/known-rsid-markers.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTERPRETATIONS_DIR = path.join(__dirname, '../shared/interpretations');
const KNOWN_RSID_FILE = path.join(__dirname, '../../../extracted-report-data/known-rsid-markers.json');

interface RsidMarker {
  rsid: string;
  gene: string;
  name: string;
  chrom: string;
  pos: number;
  ref: string;
  alt: string;
  category: string;
  display: string;
}

interface ExistingMarker {
  gene: string;
  name: string;
  category: string;
  chrom: string;
  pos: number;
  display: string;
  interpretations: Record<string, unknown>;
}

interface ExistingInterpretation {
  version: string;
  updated: string;
  description: string;
  markers: Record<string, ExistingMarker>;
}

// Load known rsID markers
const knownMarkers: RsidMarker[] = JSON.parse(
  fs.readFileSync(KNOWN_RSID_FILE, 'utf-8')
).markers;

console.log(`Loaded ${knownMarkers.length} known rsID markers from extracted data\n`);

// Track additions by category
const additions: Record<string, string[]> = {};

// Process each category file
const categoryFiles: Record<string, string> = {
  wellness: 'metabolism.json',
  pharmacogenomics: 'pharmacogenomics.json',
  'health-vulnerability': 'health-vulnerability.json',
  cognitive: 'cognitive.json',
  superpowers: 'superpowers.json',
  'inherited-conditions': 'inherited-conditions.json',
  'physical-traits': 'physical-traits.json'
};

// Track existing rsIDs per category
const existingByCategory: Record<string, Set<string>> = {};
for (const [cat, file] of Object.entries(categoryFiles)) {
  const filePath = path.join(INTERPRETATIONS_DIR, file);
  if (fs.existsSync(filePath)) {
    const data: ExistingInterpretation = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    existingByCategory[cat] = new Set(Object.keys(data.markers));
    console.log(`${cat}: ${existingByCategory[cat].size} existing markers`);
  }
}

console.log('');

// Process each known marker
for (const marker of knownMarkers) {
  const cat = marker.category;
  if (!existingByCategory[cat]) {
    console.warn(`Unknown category: ${cat} for ${marker.rsid}`);
    continue;
  }

  if (existingByCategory[cat].has(marker.rsid)) {
    continue; // Already exists
  }

  // Add new marker
  const filePath = path.join(INTERPRETATIONS_DIR, categoryFiles[cat]);
  const data: ExistingInterpretation = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  // Create minimal interpretation for this marker
  const genotypePattern = `${marker.ref}${marker.alt}`;
  data.markers[marker.rsid] = {
    gene: marker.gene,
    name: marker.name,
    category: marker.category,
    chrom: marker.chrom,
    pos: marker.pos,
    display: marker.display,
    interpretations: createBasicInterpretation(marker, genotypePattern)
  };

  // Write back
  data.updated = new Date().toISOString().split('T')[0];
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

  // Track addition
  if (!additions[cat]) additions[cat] = [];
  additions[cat].push(marker.rsid);
  existingByCategory[cat].add(marker.rsid);
}

// Summary
console.log('\n=== MERGE SUMMARY ===');
let totalAdded = 0;
for (const [cat, added] of Object.entries(additions)) {
  if (added.length > 0) {
    console.log(`${cat}: added ${added.length} markers`);
    totalAdded += added.length;
  }
}
console.log(`\nTotal new markers added: ${totalAdded}`);

if (totalAdded > 0) {
  console.log('\nRun the pipeline again to use the new markers:');
  console.log('  npx tsx skills/longevity-analysis/scripts/analyze-vcf.ts example-data/snps.vcf.gz');
}

function createBasicInterpretation(marker: RsidMarker, genotypePattern: string): Record<string, unknown> {
  // Create basic interpretations for common genotypes
  const interpretations: Record<string, unknown> = {};

  // Homozygous reference (e.g., CC)
  interpretations[`${marker.ref}${marker.ref}`] = {
    effect: "Reference allele - typical function",
    interpretation: `Standard ${marker.gene} function`,
    recommendations: [`No specific intervention needed for ${marker.name}`],
    priority: "low"
  };

  // Heterozygous (e.g., CT)
  if (marker.ref !== marker.alt && marker.alt !== 'del') {
    interpretations[`${marker.ref}${marker.alt}`] = {
      effect: "Heterozygous variant",
      interpretation: `One copy of variant allele - may affect ${marker.gene} function`,
      recommendations: [`Consider genetic counseling for ${marker.gene} variants`],
      priority: "medium"
    };
    interpretations[`${marker.alt}${marker.ref}`] = interpretations[`${marker.ref}${marker.alt}`];
  }

  // Homozygous variant (e.g., TT)
  if (marker.alt !== 'del') {
    interpretations[`${marker.alt}${marker.alt}`] = {
      effect: "Homozygous variant",
      interpretation: `Two copies of variant allele - may significantly affect ${marker.gene}`,
      recommendations: [`Consult healthcare provider about ${marker.name} variant`],
      priority: marker.category === 'vulnerability' ? "high" : "medium",
      theWhy: `${marker.display} variant in ${marker.gene} may affect ${marker.category}-related pathways`,
      scienceSimplified: `Your genome shows a variant form of ${marker.gene} that may impact ${marker.category}`
    };
  } else {
    // Deletion variant
    interpretations['del'] = {
      effect: "Deletion variant",
      interpretation: `Deletion variant in ${marker.gene}`,
      recommendations: [`Consult healthcare provider about ${marker.name} deletion`],
      priority: "high"
    };
  }

  return interpretations;
}
