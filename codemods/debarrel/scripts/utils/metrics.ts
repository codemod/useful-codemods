import fs from "fs";
import path from "path";
import { useMetricAtom } from "codemod:metrics";
import {
  isBarrelFile,
  isInsideNodeModules,
  isLocalRelativePath,
} from "./paths.ts";
import { getBarrelEmissions, fileHasTopLevelSideEffectOnlyImport } from "./barrel-metric-ast.ts";

const barrelMetric = useMetricAtom("barrel-metric");

type ExportStyle = "explicit" | "wildcard";
type Chaining = "single-level" | "chained";
type RiskAmplifier =
  | "none"
  | "heavy-usage-or-public-api"
  | "cycles-or-side-effects";

interface BarrelAnalysis {
  export_style: ExportStyle;
  chaining: Chaining;
  risk_amplifier: RiskAmplifier;
  migration_complexity_score: number;
  file: string;
}

function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function findNearestPackageJson(filename: string): string | null {
  let dir = path.dirname(filename);
  const root = path.parse(dir).root || "/";
  while (dir !== root) {
    const candidate = path.join(dir, "package.json");
    if (fileExists(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

function stripModuleExt(p: string): string {
  return p.replace(/\.(d\.ts|ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, "");
}

/**
 * Check whether `filePath` is the advertised entry point of its nearest
 * `package.json` — matches `main`, `module`, `types`, `typings`, or any
 * string leaf of the `exports` field (including nested conditional keys).
 * Tighter than "there is a package.json somewhere above" so we don't flag
 * every file in a monorepo as a public API.
 */
function isPackageEntryPoint(filePath: string): boolean {
  const pkgPath = findNearestPackageJson(filePath);
  if (!pkgPath) return false;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return false;
  }
  const pkgDir = path.dirname(pkgPath);
  const targetBase = stripModuleExt(path.resolve(filePath));

  const matches = (val: unknown): boolean => {
    if (typeof val !== "string") return false;
    const resolved = path.resolve(pkgDir, val);
    return stripModuleExt(resolved) === targetBase;
  };

  const walkExports = (node: unknown): boolean => {
    if (node == null) return false;
    if (typeof node === "string") return matches(node);
    if (Array.isArray(node)) return node.some(walkExports);
    if (typeof node === "object") {
      for (const v of Object.values(node as Record<string, unknown>)) {
        if (walkExports(v)) return true;
      }
    }
    return false;
  };

  return (
    matches(pkg.main) ||
    matches(pkg.module) ||
    matches(pkg.types) ||
    matches(pkg.typings) ||
    walkExports(pkg.exports)
  );
}

/**
 * Anchor an absolute barrel path at the first recognizable project-root
 * segment (e.g. `packages/`, `src/`) so the `file` cardinality stays stable
 * across different checkout locations. Falls back to the last three segments.
 */
function normalizeBarrelPath(filePath: string): string {
  const segments = filePath.split(/[\\/]/).filter(Boolean);
  const markers = ["packages", "apps", "app", "src", "lib"];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg && markers.includes(seg)) {
      return segments.slice(i).join("/");
    }
  }
  return segments.slice(-3).join("/");
}

function resolveLocalModule(
  fromFile: string,
  relPath: string,
): string | null {
  const base = path.resolve(path.dirname(fromFile), relPath);
  const exts = ["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"];
  for (const ext of exts) {
    const candidate = `${base}.${ext}`;
    if (fileExists(candidate)) return candidate;
  }
  for (const ext of exts) {
    const candidate = path.join(base, `index.${ext}`);
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

function fileContentHasSideEffectImport(filePath: string): boolean {
  return fileHasTopLevelSideEffectOnlyImport(filePath, (p) =>
    fs.readFileSync(p, "utf8"),
  );
}

function computeBarrelAnalysis(params: {
  barrelFile: string;
  sourceFromBarrel: string;
  isWildcard: boolean;
  barrelHasSideEffects: boolean;
}): BarrelAnalysis {
  const export_style: ExportStyle = params.isWildcard ? "wildcard" : "explicit";

  const targetPath = resolveLocalModule(
    params.barrelFile,
    params.sourceFromBarrel,
  );
  const chaining: Chaining =
    targetPath && isBarrelFile(targetPath) ? "chained" : "single-level";

  const targetHasSideEffects =
    !!targetPath && fileContentHasSideEffectImport(targetPath);
  let risk_amplifier: RiskAmplifier = "none";
  if (params.barrelHasSideEffects || targetHasSideEffects) {
    risk_amplifier = "cycles-or-side-effects";
  } else if (isPackageEntryPoint(params.barrelFile)) {
    risk_amplifier = "heavy-usage-or-public-api";
  }

  const exportScore = export_style === "wildcard" ? 1 : 0;
  const chainingScore = chaining === "chained" ? 1 : 0;
  const riskScore =
    risk_amplifier === "cycles-or-side-effects"
      ? 2
      : risk_amplifier === "heavy-usage-or-public-api"
        ? 1
        : 0;
  const migration_complexity_score = exportScore + chainingScore + riskScore;

  return {
    export_style,
    chaining,
    risk_amplifier,
    migration_complexity_score,
    file: normalizeBarrelPath(params.barrelFile),
  };
}

function emitBarrelMetric(analysis: BarrelAnalysis): void {
  barrelMetric.increment({
    export_style: analysis.export_style,
    chaining: analysis.chaining,
    risk_amplifier: analysis.risk_amplifier,
    migration_complexity_score: String(analysis.migration_complexity_score),
    file: analysis.file,
  });
}

/**
 * When `filename` is a barrel, returns it; otherwise returns the
 * `index.{ts,tsx,js,jsx}` sibling in the same directory, or null.
 */
function findSiblingBarrel(filename: string): string | null {
  if (isBarrelFile(filename)) {
    return fileExists(filename) ? filename : null;
  }
  const dir = path.dirname(filename);
  for (const ext of ["ts", "tsx", "js", "jsx"]) {
    const candidate = path.join(dir, `index.${ext}`);
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

/**
 * Walk every re-export in `barrelFile` and emit one `barrel-metric` event
 * per analyzed re-export source, using an ast-grep parse of the barrel file
 * (and the same for side-effect `import` heuristics on resolved targets).
 *
 * Handles:
 *   1. `export * from "..."` / `export type * from "..."` (wildcard)
 *   2. `export * as X from "..."` (any valid identifier, including non-ASCII)
 *   3. `export { A, B } from "..."` (explicit) including `export type { } from`
 *   4. `import { X } from "..."; export { X };` (explicit, per sourceless name)
 */
function emitMetricsForBarrelFile(barrelFile: string): void {
  const parsed = getBarrelEmissions(barrelFile, (p) =>
    fs.readFileSync(p, "utf8"),
  );
  if (!parsed) return;
  const { barrelHasSideEffects, emissions } = parsed;
  for (const e of emissions) {
    if (!isLocalRelativePath(e.source)) continue;
    emitBarrelMetric(
      computeBarrelAnalysis({
        barrelFile,
        sourceFromBarrel: e.source,
        isWildcard: e.isWildcard,
        barrelHasSideEffects,
      }),
    );
  }
}

/**
 * Emit `barrel-metric` events for every re-export reachable from this
 * file's sibling barrel (or from itself if it IS a barrel).
 *
 * Every file in the same directory emits the same metric set because the
 * `jssg test` runner stores a single `metrics.json` per directory that is
 * compared against EACH file's test case — a non-emitting sibling would
 * fail with "stale snapshot". Consequence: in production, `count` is
 * multiplied by the number of files in the barrel's directory. Interpret
 * `count` as emission events, not unique re-export sites.
 */
export function emitMetricsForBarrelSibling(filename: string): void {
  if (isInsideNodeModules(filename)) return;
  const sibBarrel = findSiblingBarrel(filename);
  if (sibBarrel) emitMetricsForBarrelFile(sibBarrel);
}
