import { access, link, rename, rm, writeFile } from 'node:fs/promises';
import { buildPgsCalibrationRegistry } from '../core/pgs-calibration-builder.js';
import { calibrationRegistryDigest } from '../core/pgs-calibration.js';

async function main(): Promise<void> {
  const output = required('PRS_CALIBRATION_OUTPUT_PATH');
  const allowReplace = process.env.PRS_CALIBRATION_ALLOW_REPLACE === 'true';
  if (!allowReplace && await exists(output)) {
    throw new Error(`${output} already exists. Calibration releases are immutable; set PRS_CALIBRATION_ALLOW_REPLACE=true only for an intentional replacement.`);
  }

  const registry = await buildPgsCalibrationRegistry({
    scoreRowsPath: required('PRS_REFERENCE_SCORE_ROWS_PATH'),
    scoreManifestPath: process.env.PRS_SCORE_MANIFEST_PATH ?? 'data/genetics/pgs/manifest.json',
    release: required('PRS_CALIBRATION_RELEASE'),
    referencePanel: {
      id: process.env.PRS_REFERENCE_PANEL_ID ?? 'PGSC_HGDP+1kGP_v1',
      release: process.env.PRS_REFERENCE_PANEL_RELEASE ?? 'v1',
      source_url: process.env.PRS_REFERENCE_PANEL_URL ?? 'https://ftp.ebi.ac.uk/pub/databases/spot/pgs/resources/pgsc_HGDP+1kGP_v1.tar.zst',
      sha256: required('PRS_REFERENCE_PANEL_SHA256'),
      unrelated_samples: positiveInteger('PRS_REFERENCE_UNRELATED_SAMPLES'),
    },
    generator: {
      name: process.env.PRS_REFERENCE_GENERATOR_NAME ?? 'wellnizz-prs-reference',
      version: required('PRS_REFERENCE_GENERATOR_VERSION'),
      command: process.env.PRS_REFERENCE_GENERATOR_COMMAND,
    },
  });

  const temp = `${output}.tmp-${process.pid}`;
  try {
    await writeFile(temp, `${JSON.stringify(registry)}\n`, { flag: 'wx' });
    if (allowReplace) await rename(temp, output);
    else await link(temp, output);
  } finally {
    await rm(temp, { force: true });
  }
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event: 'prs_calibration_registry_built',
    output,
    score_count: registry.scores.length,
    reference_panel: registry.reference_panel.id,
    reference_release: registry.reference_panel.release,
    registry_sha256: calibrationRegistryDigest(registry),
  }));
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positiveInteger(name: string): number {
  const value = Number(required(name));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

void main().catch(error => {
  console.error(JSON.stringify({
    ts: new Date().toISOString(),
    event: 'prs_calibration_registry_build_failed',
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});
