import fs from "fs";
import { isLocalRelativePath, resolveImportPath } from "./paths.ts";

// Note on parsing strategy:
//
// We deliberately use regex-driven parsing here rather than re-entering
// ast-grep. The semantic analyzer's `definition()` does not chase through
// bare `export * from "./y"` in this jssg runtime — for those specifiers
// `def.kind` is "import" and `def.root.filename()` is the importer itself
// — so to find the symbol's actual source we have to walk the barrel
// chain by reading the files off disk ourselves. Limiting that walk to
// regex matching keeps the helper self-contained and avoids needing a
// second ast-grep entry point per file.

// Matches bare `export * from "./y"` and `export type * from "./y"`, but
// NOT `export * as Ns from "./y"` — namespace re-exports wrap their target
// in a single binding, which the semantic analyzer already resolves on its
// own through the namespace import.
const EXPORT_STAR_RE =
  /^\s*export\s+(?:type\s+)?\*\s+from\s+["']([^"']+)["']/gm;

function findExportStarSources(source: string): string[] {
  const results = new Set<string>();
  EXPORT_STAR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPORT_STAR_RE.exec(source))) {
    if (m[1]) results.add(m[1]);
  }
  return [...results];
}

function escapeRegex(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

/**
 * Returns true if `source` exposes `name` as a top-level export — either
 * a direct declaration (`export const NAME`, `export type NAME`, …) or
 * inside an export clause (`export { …, NAME, … }`, possibly aliased,
 * possibly re-exported from another module).
 */
function fileDeclaresName(source: string, name: string): boolean {
  const escaped = escapeRegex(name);

  // Direct declarations.
  const declRe = new RegExp(
    `\\bexport\\s+(?:async\\s+)?(?:abstract\\s+)?(?:const|let|var|function|class|enum|interface|type)\\s+${escaped}\\b`,
  );
  if (declRe.test(source)) return true;

  // `export default function NAME`/`export default class NAME` are rare but
  // worth catching for symmetry; named default-aliased re-exports happen
  // elsewhere.
  const defaultDeclRe = new RegExp(
    `\\bexport\\s+default\\s+(?:async\\s+)?(?:function|class)\\s+${escaped}\\b`,
  );
  if (defaultDeclRe.test(source)) return true;

  // Export clauses: `export { … }` or `export type { … }`, with or without
  // a trailing `from "..."`. We strip block comments + line comments before
  // scanning the clause so commented-out names don't produce false positives.
  const clauseRe = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = clauseRe.exec(source))) {
    const inside = (m[1] ?? "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // Match either "NAME" or "X as NAME" between commas / clause boundaries.
    const nameInClauseRe = new RegExp(
      `(^|,)\\s*(?:type\\s+)?(?:[A-Za-z_$][\\w$]*\\s+as\\s+)?${escaped}\\s*(,|$)`,
    );
    if (nameInClauseRe.test(inside)) return true;
  }
  return false;
}

/**
 * Walk `barrelFile`'s bare `export * from "./y"` chain to find which file
 * declares `name`. Returns the absolute path of that file, or null if `name`
 * isn't reachable through any wildcard re-export.
 *
 * Stops at non-local re-export targets (e.g. workspace packages, node_modules)
 * since those would route the import through a different package boundary
 * the codemod isn't authorized to rewrite.
 */
export function findSymbolViaExportStar(
  barrelFile: string,
  name: string,
): string | null {
  return walk(barrelFile, name, new Set(), 0);
}

function walk(
  file: string,
  name: string,
  visited: Set<string>,
  depth: number,
): string | null {
  if (depth > 10) return null;
  if (visited.has(file)) return null;
  visited.add(file);

  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }

  for (const subPath of findExportStarSources(source)) {
    if (!isLocalRelativePath(subPath)) continue;
    const targetFile = resolveImportPath(file, subPath);
    if (!targetFile) continue;
    let targetSource: string;
    try {
      targetSource = fs.readFileSync(targetFile, "utf8");
    } catch {
      continue;
    }
    if (fileDeclaresName(targetSource, name)) return targetFile;

    // The first re-export hop didn't declare the symbol directly — keep
    // walking that file's own `export *` chain. We don't try to follow
    // named `export { X } from "./y"` re-exports here; those are
    // single-hop by design, mirroring the existing named-reexport branch.
    const nested = walk(targetFile, name, visited, depth + 1);
    if (nested) return nested;
  }
  return null;
}
