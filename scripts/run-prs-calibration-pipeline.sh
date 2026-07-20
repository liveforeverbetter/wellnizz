#!/usr/bin/env bash
# Step 5 calibration pipeline: HGDP+1000G → reference scores → calibration.json
#
# Prerequisites: bcftools, zstd, node 22+
#
# This script:
# 1. Downloads the PGS Catalog HGDP+1000G reference panel (15.9 GB)
# 2. Runs the position-aware scorer against all reference samples
# 3. Builds a compact, de-identified calibration.json
# 4. Outputs to data/genetics/pgs/calibration.json
#
# Usage:
#   bash scripts/run-prs-calibration-pipeline.sh
#
# Environment:
#   PRS_PANEL_URL      Override the default panel URL
#   PRS_PANEL_DIR      Where to download/extract (default: .prs-reference)
#   PRS_DBSNP_VCF      Path to the GRCh37 dbSNP VCF (only needed if panel has gaps)
#   PRS_SAMPLE_LIMIT   Limit reference samples (for testing, default: all)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PANEL_URL="${PRS_PANEL_URL:-https://ftp.ebi.ac.uk/pub/databases/spot/pgs/resources/pgsc_HGDP+1kGP_v1.tar.zst}"
PANEL_DIR="${PRS_PANEL_DIR:-$ROOT_DIR/.prs-reference}"
REGISTRY_DIR="$ROOT_DIR/data/genetics/pgs"
CALIBRATION_OUTPUT="$REGISTRY_DIR/calibration.json"
REFERENCE_SCORES="$PANEL_DIR/calibration-scores.tsv"
SAMPLE_LIMIT="${PRS_SAMPLE_LIMIT:-}"
RELEASE="${PRS_CALIBRATION_RELEASE:-$(date +%Y-%m-%d).1}"
PANEL_SHA256=""
GENERATOR_VERSION="${PRS_GENERATOR_VERSION:-1.0}"

mkdir -p "$PANEL_DIR"

echo "=== Step 1/5: Download HGDP+1000G reference panel ==="
PANEL_TAR="$PANEL_DIR/pgsc_HGDP+1kGP_v1.tar.zst"
if [ -f "$PANEL_TAR" ]; then
  echo "Panel already downloaded: $PANEL_TAR ($(du -h "$PANEL_TAR" | cut -f1))"
else
  echo "Downloading from $PANEL_URL ..."
  curl -L -o "$PANEL_TAR" "$PANEL_URL"
  echo "Download complete: $(du -h "$PANEL_TAR" | cut -f1)"
fi

echo ""
echo "=== Step 2/5: Discover panel structure ==="
echo "Listing archive contents (first 40 entries)..."
zstdcat "$PANEL_TAR" | tar -tf - 2>/dev/null | head -40

echo ""
echo "Searching for metadata file and VCF directory..."
ARCHIVE_FILES=$(zstdcat "$PANEL_TAR" | tar -tf - 2>/dev/null)
echo "Total entries in archive: $(echo "$ARCHIVE_FILES" | wc -l)"

# Find metadata file
METADATA_FILE=$(echo "$ARCHIVE_FILES" | grep -iE '(sample_info|sample_metadata|metadata.*txt|sample.*tsv)' | grep -v '/$' | head -1 || true)
echo "Metadata candidate: $METADATA_FILE"

# Find VCF directory
VCF_DIR=$(echo "$ARCHIVE_FILES" | grep -E '\.(vcf\.gz|bcf)$' | head -1 | xargs dirname 2>/dev/null || true)
if [ -z "$VCF_DIR" ]; then
  # Try to guess from directory structure
  VCF_DIR=$(echo "$ARCHIVE_FILES" | grep '/$' | grep -iE '(reference|vcf|data)' | head -1 || true)
fi
echo "VCF directory: $VCF_DIR"

echo ""
echo "=== Step 3/5: Extract metadata ==="
if [ -n "$METADATA_FILE" ]; then
  METADATA_PATH="$PANEL_DIR/sample_metadata.tsv"
  zstdcat "$PANEL_TAR" | tar -xOf - "$METADATA_FILE" > "$METADATA_PATH"
  echo "Metadata extracted: $METADATA_PATH ($(wc -l < "$METADATA_PATH") lines)"
  echo "First 5 lines:"
  head -5 "$METADATA_PATH"
else
  echo "ERROR: Could not find sample metadata file in archive."
  echo "Available files:"
  echo "$ARCHIVE_FILES" | head -30
  exit 1
fi

echo ""
echo "=== Step 4/5: Score reference samples ==="
SAMPLE_LIMIT_ARG=""
if [ -n "$SAMPLE_LIMIT" ]; then
  SAMPLE_LIMIT_ARG="--max-samples $SAMPLE_LIMIT"
  echo "Sample limit: $SAMPLE_LIMIT (canary mode)"
fi

if [ -f "$REFERENCE_SCORES" ]; then
  echo "Reference scores already computed: $REFERENCE_SCORES ($(wc -l < "$REFERENCE_SCORES") lines)"
else
  # Extract VCFs to disk if we have space, otherwise use streaming
  VCF_EXTRACT_DIR="$PANEL_DIR/vcfs"
  if [ ! -d "$VCF_EXTRACT_DIR" ] || [ -z "$(ls -A "$VCF_EXTRACT_DIR" 2>/dev/null)" ]; then
    mkdir -p "$VCF_EXTRACT_DIR"
    echo "Extracting per-chromosome VCFs to $VCF_EXTRACT_DIR ..."
    # Extract only VCF files from the reference directory
    VCF_FILES=$(echo "$ARCHIVE_FILES" | grep -E '\.(vcf\.gz|bcf)$' | grep -v '/$' || true)
    if [ -n "$VCF_FILES" ]; then
      echo "$VCF_FILES" | while read -r f; do
        echo "  Extracting: $f"
        zstdcat "$PANEL_TAR" | tar -xOf - "$f" > "$VCF_EXTRACT_DIR/$(basename "$f")" 2>/dev/null || true
      done
    else
      echo "ERROR: No VCF files found in archive."
      exit 1
    fi
  else
    echo "VCFs already extracted to $VCF_EXTRACT_DIR"
  fi

  echo "Running batch scorer..."
  echo "Command: tsx scripts/batch-score-reference-panel.ts --vcf-dir $VCF_EXTRACT_DIR --metadata $METADATA_PATH --registry-dir $REGISTRY_DIR --out $REFERENCE_SCORES $SAMPLE_LIMIT_ARG"
  (
    cd "$ROOT_DIR"
    npx tsx scripts/batch-score-reference-panel.ts \
      --vcf-dir "$VCF_EXTRACT_DIR" \
      --metadata "$METADATA_PATH" \
      --registry-dir "$REGISTRY_DIR" \
      --out "$REFERENCE_SCORES" \
      $SAMPLE_LIMIT_ARG
  )
  echo "Reference scores written: $REFERENCE_SCORES ($(wc -l < "$REFERENCE_SCORES") lines)"
fi

echo ""
echo "=== Step 5/5: Build calibration.json ==="
PANEL_SHA256=$(shasum -a 256 "$PANEL_TAR" | cut -d' ' -f1)
UNRELATED_SAMPLES=$(tail -n +2 "$REFERENCE_SCORES" | cut -f1 | sort -u | wc -l | tr -d ' ')
echo "Panel SHA-256: $PANEL_SHA256"
echo "Unrelated reference samples: $UNRELATED_SAMPLES"

if [ -f "$CALIBRATION_OUTPUT" ]; then
  BACKUP="$CALIBRATION_OUTPUT.prev"
  cp "$CALIBRATION_OUTPUT" "$BACKUP"
  echo "Existing calibration backed up to $BACKUP"
fi

(
  cd "$ROOT_DIR"
  npx tsx scripts/build-prs-calibration.ts \
    --scores "$REFERENCE_SCORES" \
    --manifest "$REGISTRY_DIR/manifest.json" \
    --release "$RELEASE" \
    --reference-id PGSC_HGDP+1kGP_v1 \
    --reference-release v1 \
    --reference-sha256 "$PANEL_SHA256" \
    --unrelated-samples "$UNRELATED_SAMPLES" \
    --generator-version "$GENERATOR_VERSION" \
    --output "$CALIBRATION_OUTPUT"
)

echo ""
echo "=== Calibration pipeline complete ==="
echo "Output: $CALIBRATION_OUTPUT"
if [ -f "$CALIBRATION_OUTPUT" ]; then
  echo "Size: $(du -h "$CALIBRATION_OUTPUT" | cut -f1)"
  CAL_SHA256=$(shasum -a 256 "$CALIBRATION_OUTPUT" | cut -d' ' -f1)
  echo "SHA-256: $CAL_SHA256"
  echo "Scores: $(node -e "console.log(JSON.parse(require('fs').readFileSync('$CALIBRATION_OUTPUT','utf8')).scores.length)")"

  echo ""
  echo "=== Next steps ==="
  echo "1. Upload to Tigris:"
  echo "   aws s3 cp --endpoint-url=\$TIGRIS_ENDPOINT $CALIBRATION_OUTPUT s3://\$BUCKET/genetics/calibration/$RELEASE/calibration.json"
  echo ""
  echo "2. Configure the WGS worker:"
  echo "   HEALTH_ANALYSIS_PGS_CALIBRATION_PATH=$CALIBRATION_OUTPUT"
  echo "   (or point it at the Tigris URL for the worker to download and cache)"
  echo ""
  echo "3. Requeue analyses for percentile calibration"
fi
