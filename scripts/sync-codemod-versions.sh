#!/usr/bin/env bash
# Syncs the version field in each codemod's codemod.yaml with its package.json.
# Run after `changeset version` to keep both files in sync.

set -euo pipefail

for pkg_json in codemods/*/package.json; do
  dir="$(dirname "$pkg_json")"
  codemod_yaml="$dir/codemod.yaml"

  if [ ! -f "$codemod_yaml" ]; then
    continue
  fi

  version="$(node -p "require('./$pkg_json').version")"
  # Use Node instead of sed -i: BSD sed (macOS) and GNU sed (Linux CI) disagree
  # on the in-place backup-extension syntax.
  node --input-type=module -e "
    import fs from 'node:fs';
    const file = process.argv[1];
    const version = process.argv[2];
    const next = fs
      .readFileSync(file, 'utf8')
      .replace(/^version: .*$/m, \`version: \"\${version}\"\`);
    fs.writeFileSync(file, next);
  " "$codemod_yaml" "$version"

  echo "Synced $codemod_yaml to version $version"
done
