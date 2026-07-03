import path from "path";
import fs from "fs";

export function isLocalRelativePath(source: string): boolean {
  return (
    source === "." ||
    source === ".." ||
    source.startsWith("./") ||
    source.startsWith("../")
  );
}

export function joinImportPaths(
  barrelImportPath: string,
  sourceFromBarrel: string,
): string {
  // Cannot use path.join here because the JSSG runtime's path.join has a bug
  // where leading "../" segments are dropped (e.g. path.join("../../a/b", "./c")
  // produces "a/b/c" instead of "../../a/b/c").
  // The barrel import path points to a directory (containing index.ts), so we
  // concatenate it with the relative source path and normalize.
  // If the import explicitly ends with "/index", strip it — it's a file
  // reference (e.g. "../index" → "../"), not a directory called "index/".
  let barrelDir = barrelImportPath;
  if (
    /\/index$/.test(barrelDir) ||
    barrelDir === "index" ||
    barrelDir === "./index"
  ) {
    barrelDir = barrelDir.replace(/\/?index$/, "") || ".";
  }
  const segments = (barrelDir + "/" + sourceFromBarrel).split("/");
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === "." || seg === "") continue;
    if (
      seg === ".." &&
      resolved.length > 0 &&
      resolved[resolved.length - 1] !== ".."
    ) {
      resolved.pop();
    } else {
      resolved.push(seg);
    }
  }
  let result = resolved.join("/");
  if (isLocalRelativePath(barrelImportPath) && !result.startsWith(".")) {
    result = "./" + result;
  }
  return result;
}

export function isBarrelFile(filename: string): boolean {
  return /^index\.(ts|tsx|js|jsx)$/.test(path.basename(filename));
}

export function isNextPagesApiRoute(filename: string): boolean {
  const normalized = filename.replace(/\\/g, "/");
  return /(^|\/)pages\/api(?:\/.*)?\/index\.(ts|tsx|js|jsx)$/.test(
    normalized,
  );
}

const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"] as const;

/**
 * Resolve a relative import path to the absolute file it points to on disk,
 * mirroring Node/TS module resolution preferences:
 *   1. `<resolved>.<ext>`            (file form — preferred when both exist)
 *   2. `<resolved>/index.<ext>`      (directory's index form)
 *
 * Returns null when the import path isn't relative or no candidate exists.
 */
function resolveFileCandidates(resolvedBase: string): string | null {
  for (const ext of MODULE_EXTENSIONS) {
    const candidate = resolvedBase + ext;
    if (fileExists(candidate)) return candidate;
  }
  for (const ext of MODULE_EXTENSIONS) {
    const candidate = path.join(resolvedBase, `index${ext}`);
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

export function resolveImportPath(
  importerFilename: string,
  importPath: string,
): string | null {
  if (!isLocalRelativePath(importPath)) return null;
  const importerDir = path.dirname(importerFilename);
  const resolved = path.resolve(importerDir, importPath);
  return resolveFileCandidates(resolved);
}

interface TsconfigPaths {
  baseUrl: string;
  paths: Record<string, string[]>;
}

export function findNearestTsconfig(filename: string): string | null {
  let dir = path.dirname(filename);
  const root = path.parse(dir).root || "/";
  while (true) {
    const candidate = path.join(dir, "tsconfig.json");
    if (fileExists(candidate)) return candidate;
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

function loadTsconfigPaths(tsconfigPath: string): TsconfigPaths | null {
  const parsed = readJsonFile(tsconfigPath);
  if (!parsed || typeof parsed !== "object") return null;
  const compilerOptions = (parsed as { compilerOptions?: unknown })
    .compilerOptions;
  if (!compilerOptions || typeof compilerOptions !== "object") return null;
  const opts = compilerOptions as { baseUrl?: unknown; paths?: unknown };
  const baseUrl =
    typeof opts.baseUrl === "string" ? opts.baseUrl : ".";
  const paths = opts.paths;
  if (!paths || typeof paths !== "object") return null;
  const pathsRecord: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(paths)) {
    if (typeof key === "string" && Array.isArray(value)) {
      pathsRecord[key] = value.filter(
        (entry): entry is string => typeof entry === "string",
      );
    }
  }
  return {
    baseUrl: path.resolve(path.dirname(tsconfigPath), baseUrl),
    paths: pathsRecord,
  };
}

function matchTsconfigPath(
  importPath: string,
  pattern: string,
  targets: string[],
): string | null {
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    if (!importPath.startsWith(`${prefix}/`)) return null;
    const subst = importPath.slice(prefix.length + 1);
    for (const target of targets) {
      if (target.endsWith("/*")) {
        return `${target.slice(0, -2)}/${subst}`;
      }
    }
    return null;
  }
  if (pattern === importPath) {
    return targets[0] ?? null;
  }
  return null;
}

/**
 * Resolve a tsconfig path alias (e.g. `myapp/widgets`) to the absolute file
 * it points at on disk, or null when no mapping matches.
 */
export function resolveAliasImportPath(
  importerFilename: string,
  importPath: string,
): string | null {
  if (isLocalRelativePath(importPath)) return null;

  const tsconfigPath = findNearestTsconfig(importerFilename);
  if (!tsconfigPath) return null;
  const tsconfig = loadTsconfigPaths(tsconfigPath);
  if (!tsconfig) return null;

  for (const [pattern, targets] of Object.entries(tsconfig.paths)) {
    const mapped = matchTsconfigPath(importPath, pattern, targets);
    if (!mapped) continue;
    const resolvedBase = path.isAbsolute(mapped)
      ? mapped
      : path.resolve(tsconfig.baseUrl, mapped);
    const candidate = resolveFileCandidates(resolvedBase);
    if (candidate) return candidate;
  }
  return null;
}

/**
 * Resolve either a relative import or a tsconfig path alias to an absolute
 * module file path.
 */
export function resolveModuleImportPath(
  importerFilename: string,
  importPath: string,
): string | null {
  return (
    resolveImportPath(importerFilename, importPath) ??
    resolveAliasImportPath(importerFilename, importPath)
  );
}

export function isInsideNodeModules(filename: string): boolean {
  return (
    filename.includes("/node_modules/") || filename.includes("\\node_modules\\")
  );
}

/** Project root for scanning sibling source files (tsconfig dir, else package dir). */
export function findWorkspaceSourceRoot(filename: string): string {
  const tsconfigPath = findNearestTsconfig(filename);
  if (tsconfigPath) return path.dirname(tsconfigPath);
  const packageJsonPath = findNearestPackageJson(filename);
  if (packageJsonPath) return path.dirname(packageJsonPath);
  return path.dirname(filename);
}

const SOURCE_FILE_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/** Recursively list source files under `rootDir`, skipping node_modules. */
export function walkProjectSourceFiles(
  rootDir: string,
  files: string[] = [],
): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkProjectSourceFiles(fullPath, files);
    } else if (SOURCE_FILE_PATTERN.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function readJsonFile(filePath: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function normalizePackageTarget(target: string): string {
  return target.replace(/\\/g, "/").replace(/^\.\//, "");
}

function collectExportTargets(value: unknown, targets: string[]): void {
  if (typeof value === "string") {
    targets.push(normalizePackageTarget(value));
    return;
  }

  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const item of value) collectExportTargets(item, targets);
    return;
  }

  for (const nested of Object.values(value)) {
    collectExportTargets(nested, targets);
  }
}

export function findNearestPackageJson(filename: string): string | null {
  let dir = path.dirname(filename);
  const root = path.parse(dir).root || "/";
  while (true) {
    const packageJsonPath = path.join(dir, "package.json");
    if (fileExists(packageJsonPath)) return packageJsonPath;
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

export function getPackageName(filename: string): string | null {
  const packageJsonPath = findNearestPackageJson(filename);
  if (!packageJsonPath) return null;
  const parsed = readJsonFile(packageJsonPath);
  if (!parsed || typeof parsed !== "object") return null;
  const name = (parsed as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

export function hasPackageJson(filename: string): boolean {
  return findNearestPackageJson(filename) !== null;
}

export function isPackageEntrypoint(filename: string): boolean {
  const packageJsonPath = findNearestPackageJson(filename);
  if (!packageJsonPath) return false;

  const parsed = readJsonFile(packageJsonPath);
  if (!parsed || typeof parsed !== "object") return false;

  const packageDir = path.dirname(packageJsonPath);
  const relativeFilename = path
    .relative(packageDir, filename)
    .replace(/\\/g, "/");
  if (!relativeFilename || relativeFilename.startsWith("../")) return false;

  const manifest = parsed as {
    main?: unknown;
    module?: unknown;
    types?: unknown;
    typings?: unknown;
    exports?: unknown;
  };
  const entrypoints: string[] = [];

  for (const field of [
    manifest.main,
    manifest.module,
    manifest.types,
    manifest.typings,
  ]) {
    if (typeof field === "string") {
      entrypoints.push(normalizePackageTarget(field));
    }
  }

  collectExportTargets(manifest.exports, entrypoints);

  return entrypoints.includes(relativeFilename);
}
