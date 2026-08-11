#!/usr/bin/env bash
# Creates git tags for each codemod whose version was bumped by changesets.
# Outputs the list of changed codemod directories for the publish job.
# Tags follow the pattern: <name>@v<version>

set -euo pipefail

# actions/checkout does not fetch tags by default; load remote tags so we
# skip versions that were already released instead of failing on push.
git fetch --tags --force origin

changed_dirs="[]"
tags_to_push=()

for pkg_json in codemods/*/package.json; do
  dir="$(dirname "$pkg_json")"
  name="$(node -p "require('./$pkg_json').name")"
  version="$(node -p "require('./$pkg_json').version")"
  tag="${name}@v${version}"

  if git rev-parse "$tag" >/dev/null 2>&1; then
    echo "Tag $tag already exists, skipping"
    continue
  fi

  echo "Creating tag $tag"
  git tag "$tag"
  tags_to_push+=("$tag")
  changed_dirs="$(echo "$changed_dirs" | node -p "JSON.stringify([...JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')), \"$dir\"])")"
done

if [ ${#tags_to_push[@]} -gt 0 ]; then
  git push origin "${tags_to_push[@]}"
else
  echo "No new tags to push"
fi

echo "changed_dirs=$changed_dirs" >> "$GITHUB_OUTPUT"
