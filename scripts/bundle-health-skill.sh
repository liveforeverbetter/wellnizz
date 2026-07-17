#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_repo="${HEALTH_ANALYSIS_SKILL_SOURCE:-$root/../open-source}"
source_subdir="${HEALTH_ANALYSIS_SKILL_SOURCE_SUBDIR:-skills/longevity-analysis}"
dest="${HEALTH_ANALYSIS_SKILL_DEST:-$root/vendor/health-analysis-skill}"
tmp="$dest.tmp"

if ! git -C "$source_repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Source is not a git checkout: $source_repo" >&2
  exit 1
fi

if ! git -C "$source_repo" cat-file -e "HEAD:$source_subdir/SKILL.md" >/dev/null 2>&1; then
  echo "Source checkout does not contain $source_subdir/SKILL.md" >&2
  exit 1
fi

rm -rf "$tmp"
mkdir -p "$tmp"

# Start from the committed tree, then overlay scoped tracked/untracked working-tree
# changes. The review baseline explicitly treats uncommitted source work as the
# latest state, so a HEAD-only archive would silently ship an older skill.
git -C "$source_repo" archive --format=tar HEAD "$source_subdir" | tar -x -C "$tmp"

while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  if [[ -f "$source_repo/$file" || -L "$source_repo/$file" ]]; then
    mkdir -p "$tmp/$(dirname "$file")"
    cp -p "$source_repo/$file" "$tmp/$file"
  else
    rm -f "$tmp/$file"
  fi
done < <(
  {
    git -C "$source_repo" diff --name-only HEAD -- "$source_subdir"
    git -C "$source_repo" ls-files --others --exclude-standard -- "$source_subdir"
  } | LC_ALL=C sort -u
)

mkdir -p "$(dirname "$dest")"
rm -rf "$dest"
mv "$tmp/$source_subdir" "$dest"
rm -rf "$tmp"

{
  echo "source_repo=$(git -C "$source_repo" remote get-url origin 2>/dev/null || echo liveforeverbetter/agentic-health-analysis)"
  echo "source_subdir=$source_subdir"
  echo "source_commit=$(git -C "$source_repo" rev-parse HEAD)"
  if [[ -n "$(git -C "$source_repo" status --porcelain -- "$source_subdir")" ]]; then
    echo "source_dirty=true"
  else
    echo "source_dirty=false"
  fi
  echo "bundled_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$dest/.bundle-manifest"

echo "Bundled analyze-longevity skill into $dest"
