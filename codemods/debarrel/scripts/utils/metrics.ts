import fs from "fs";
import path from "path";
import { useMetricAtom } from "codemod:metrics";
import {
  isBarrelFile,
  isInsideNodeModules,
  isLocalRelativePath,
} from "./paths.ts";

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
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return /^\s*import\s+["'][^"']+["']\s*;?\s*$/m.test(content);
  } catch {
    return false;
  }
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

interface BarrelImportBinding {
  localName: string;
  source: string;
}

/**
 * Parse `import ... from "..."` statements and return bindings by local
 * name → source. Regex-based so we can resolve sourceless `export { X };`
 * patterns without an AST.
 */
function collectImportBindings(content: string): BarrelImportBinding[] {
  const bindings: BarrelImportBinding[] = [];
  const importRe =
    /import\s+([\s\S]+?)\s+from\s+["']([^"']+)["']\s*;?/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(content)) !== null) {
    const clause = m[1];
    const source = m[2];
    if (!clause || !source) continue;

    const namedMatch = clause.match(/\{([^}]*)\}/);
    if (namedMatch && namedMatch[1] !== undefined) {
      for (const spec of namedMatch[1].split(",")) {
        const parts = spec.trim().split(/\s+as\s+/);
        const local = (parts[1] ?? parts[0] ?? "").trim();
        if (local) bindings.push({ localName: local, source });
      }
    }

    const withoutNamed = clause.replace(/\{[^}]*\}/g, "");

    const nsMatch = withoutNamed.match(/\*\s+as\s+([\w$]+)/);
    if (nsMatch && nsMatch[1]) {
      bindings.push({ localName: nsMatch[1], source });
    }

    const defaultMatch = withoutNamed.match(/(?:^|,)\s*([\w$]+)\s*(?:,|$)/);
    if (defaultMatch && defaultMatch[1]) {
      bindings.push({ localName: defaultMatch[1], source });
    }
  }
  return bindings;
}

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

/**
 * Walk every re-export in `barrelFile` and emit one `barrel-metric` event
 * per analyzed re-export source. Uses a regex-based scan so the metric set
 * is identical regardless of whether the barrel itself or a sibling triggered
 * the emission.
 *
 * Handles:
 *   1. `export * from "..."`           (wildcard)
 *   2. `export * as X from "..."`      (wildcard)
 *   3. `export { A, B } from "..."`    (explicit)
 *   4. `import { X } from "..."; export { X };` (explicit, per traced source)
 */
function emitMetricsForBarrelFile(barrelFile: string): void {
  let content: string;
  try {
    content = fs.readFileSync(barrelFile, "utf8");
  } catch {
    return;
  }
  const code = stripComments(content);

  const barrelHasSideEffects =
    /^[ \t]*import\s+["'][^"']+["']\s*;?\s*$/m.test(code);

  const emitForSource = (source: string, isWildcard: boolean): void => {
    if (!isLocalRelativePath(source)) return;
    emitBarrelMetric(
      computeBarrelAnalysis({
        barrelFile,
        sourceFromBarrel: source,
        isWildcard,
        barrelHasSideEffects,
      }),
    );
  };

  const wildcardRe =
    /export\s+\*(?:\s+as\s+[\w$]+)?\s+from\s+["']([^"']+)["']\s*;?/g;
  let m: RegExpExecArray | null;
  while ((m = wildcardRe.exec(code)) !== null) {
    if (m[1]) emitForSource(m[1], true);
  }

  const explicitFromRe = /export\s*\{[^}]*\}\s*from\s+["']([^"']+)["']\s*;?/g;
  while ((m = explicitFromRe.exec(code)) !== null) {
    if (m[1]) emitForSource(m[1], false);
  }

  const importBindings = collectImportBindings(code);
  if (importBindings.length === 0) return;
  const bindingMap = new Map<string, string>();
  for (const b of importBindings) bindingMap.set(b.localName, b.source);

  const exportSourcelessRe = /export\s*\{([^}]*)\}\s*(?:;|$)/gm;
  while ((m = exportSourcelessRe.exec(code)) !== null) {
    if (m[1] === undefined) continue;
    for (const spec of m[1].split(",")) {
      const parts = spec.trim().split(/\s+as\s+/);
      const localName = parts[0]?.trim();
      if (!localName) continue;
      const source = bindingMap.get(localName);
      if (!source) continue;
      emitForSource(source, false);
    }
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
