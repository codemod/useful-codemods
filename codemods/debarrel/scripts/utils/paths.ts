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

/**
 * Relative path from a directory to a file, normalized to POSIX separators.
 * Uses `path.relative` (available in the JSSG runtime, though undocumented).
 */
export function relativePathFromDir(fromDir: string, toFile: string): string {
  return path.relative(fromDir, toFile).replace(/\\/g, "/");
}

export function normalizeAbsolutePath(
  filename: string,
  workspaceRoot: string,
): string {
  return path.isAbsolute(filename)
    ? path.resolve(filename)
    : path.resolve(workspaceRoot, filename);
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
  return /^index(\.barrel\.bak)?\.(ts|tsx|js|jsx)$/.test(path.basename(filename));
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
  // During a single migration pass, earlier files may have already renamed a
  // barrel to index.barrel.bak.* — still resolve it for later consumers.
  for (const ext of MODULE_EXTENSIONS) {
    const candidate = resolvedBase + `.barrel.bak${ext}`;
    if (fileExists(candidate)) return candidate;
  }
  for (const ext of MODULE_EXTENSIONS) {
    const candidate = path.join(resolvedBase, `index.barrel.bak${ext}`);
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
  let dir = path.dirname(path.resolve(filename));
  const root = path.parse(dir).root || "/";
  while (true) {
    const candidate = path.join(dir, "tsconfig.json");
    if (fileExists(candidate)) return candidate;
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

/** Strip line and block comments so JSONC tsconfig files parse. */
function stripJsonComments(text: string): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      result += ch;
      i++;
      while (i < text.length) {
        const inner = text[i]!;
        result += inner;
        if (inner === "\\") {
          i++;
          if (i < text.length) result += text[i]!;
        } else if (inner === '"') {
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (text.startsWith("//", i)) {
      const newline = text.indexOf("\n", i);
      if (newline === -1) break;
      result += "\n";
      i = newline + 1;
      continue;
    }
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    result += ch;
    i++;
  }
  return result;
}

function stripTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, "$1");
}

function readTsconfigJson(filePath: string): unknown | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const stripped = stripTrailingCommas(stripJsonComments(raw));
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

function loadTsconfigPaths(tsconfigPath: string): TsconfigPaths | null {
  const parsed = readTsconfigJson(tsconfigPath);
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
  const absolute = path.resolve(filename);
  const tsconfigPath = findNearestTsconfig(absolute);
  if (tsconfigPath) return path.dirname(path.resolve(tsconfigPath));
  const packageJsonPath = findNearestPackageJson(absolute);
  if (packageJsonPath) return path.dirname(path.resolve(packageJsonPath));
  return path.dirname(absolute);
}

/**
 * Tsconfig path aliases that resolve to `barrelFile` (e.g. `sentry/stories` for
 * `static/app/stories/index.tsx` when `sentry/*` maps to `./static/app/*`).
 */
export function getAliasImportPathsForBarrel(barrelFile: string): string[] {
  const workspaceRoot = findWorkspaceSourceRoot(barrelFile);
  const absoluteBarrel = normalizeAbsolutePath(barrelFile, workspaceRoot);
  const barrelDir = path.resolve(path.dirname(absoluteBarrel));
  const tsconfigPath = findNearestTsconfig(absoluteBarrel);
  if (!tsconfigPath) return [];

  const tsconfig = loadTsconfigPaths(tsconfigPath);
  if (!tsconfig) return [];

  const aliases: string[] = [];
  for (const [pattern, targets] of Object.entries(tsconfig.paths)) {
    if (!pattern.endsWith("/*")) continue;
    const prefix = pattern.slice(0, -2);
    for (const target of targets) {
      if (!target.endsWith("/*")) continue;
      const targetPrefix = path.resolve(
        tsconfig.baseUrl,
        target.slice(0, -2),
      );
      if (barrelDir === targetPrefix) {
        aliases.push(prefix);
        continue;
      }
      if (!barrelDir.startsWith(`${targetPrefix}${path.sep}`)) continue;
      const subst = path.relative(targetPrefix, barrelDir).replace(/\\/g, "/");
      if (!subst || subst.includes("..")) continue;
      aliases.push(`${prefix}/${subst}`);
    }
  }
  return aliases;
}

const SOURCE_FILE_PATTERN = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const MDX_FILE_PATTERN = /\.mdx$/;
const NAMESPACE_IMPORT_RE =
  /import\s+\*\s+as\s+[\w$]+\s+from\s+['"]([^'"]+)['"]/g;

/** Resolve a `readdirSync` entry to a file name across Node and curated fs. */
function readdirEntryName(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (
    entry &&
    typeof entry === "object" &&
    "name" in entry &&
    typeof (entry as { name: unknown }).name === "string"
  ) {
    return (entry as { name: string }).name;
  }
  return null;
}

function readdirEntryIsDirectory(entry: unknown, fullPath: string): boolean {
  if (
    entry &&
    typeof entry === "object" &&
    typeof (entry as fs.Dirent).isDirectory === "function"
  ) {
    try {
      return (entry as fs.Dirent).isDirectory();
    } catch {
      // Fall through to stat.
    }
  }
  try {
    return fs.statSync(fullPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Recursively list source files under `rootDir`, skipping node_modules.
 *
 * Uses plain `readdirSync` (string names) plus `statSync`. Cloud/LLRT curated
 * fs has returned incomplete Dirents for `{ withFileTypes: true }`, which
 * crashed on `entry.name.startsWith(...)`.
 */
export function walkProjectSourceFiles(
  rootDir: string,
  files: string[] = [],
): string[] {
  const absoluteRoot = path.resolve(rootDir);
  let entries: unknown[];
  try {
    entries = fs.readdirSync(absoluteRoot);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const name = readdirEntryName(entry);
    if (!name || name === "node_modules" || name.startsWith(".")) continue;
    const fullPath = path.resolve(absoluteRoot, name);
    if (readdirEntryIsDirectory(entry, fullPath)) {
      walkProjectSourceFiles(fullPath, files);
    } else if (
      SOURCE_FILE_PATTERN.test(name) ||
      MDX_FILE_PATTERN.test(name)
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

const projectSourceFilesCache = new Map<string, string[]>();

/** Cached wrapper around {@link walkProjectSourceFiles} for a codemod run. */
export function getProjectSourceFiles(rootDir: string): string[] {
  const absoluteRoot = path.resolve(rootDir);
  const cached = projectSourceFilesCache.get(absoluteRoot);
  if (cached) return cached;
  const files = walkProjectSourceFiles(absoluteRoot);
  projectSourceFilesCache.set(absoluteRoot, files);
  return files;
}

/** True when an MDX file namespace-imports one of `importPaths`. */
export function fileHasMdxNamespaceImportFrom(
  filePath: string,
  importPaths: Set<string>,
): boolean {
  if (!MDX_FILE_PATTERN.test(filePath)) return false;
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  for (const match of source.matchAll(NAMESPACE_IMPORT_RE)) {
    const importPath = match[1];
    if (importPath && importPaths.has(importPath)) return true;
  }
  return false;
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

/**
 * Top-level keys of a package.json `"exports"` map (e.g. `"."`,
 * `"./components/button"`). Conditional export objects contribute their
 * outer keys only — nested `"import"` / `"require"` conditions are ignored.
 */
function collectExportKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).filter(
    (key) => key === "." || key.startsWith("./"),
  );
}

function getImportPackageName(importPath: string): string | null {
  if (importPath.startsWith("@")) {
    const segments = importPath.split("/");
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
  }
  const [packageName] = importPath.split("/");
  return packageName || null;
}

/**
 * True when `importPath` matches an exact public `"exports"` key of the
 * package that owns `resolvedFilename` (e.g. `@acme/ui/components/button`
 * against `"./components/button"`).
 *
 * Returns false when the package has no `"exports"` map — those packages
 * are treated as unrestricted (tsconfig aliases may still deepen).
 */
export function isPackageExportSubpath(
  resolvedFilename: string,
  importPath: string,
): boolean {
  if (isLocalRelativePath(importPath)) return false;

  const packageJsonPath = findNearestPackageJson(resolvedFilename);
  if (!packageJsonPath) return false;

  const parsed = readJsonFile(packageJsonPath);
  if (!parsed || typeof parsed !== "object") return false;

  const manifest = parsed as { name?: unknown; exports?: unknown };
  if (typeof manifest.name !== "string" || !manifest.name) return false;
  if (manifest.exports === undefined) return false;

  const importPackage = getImportPackageName(importPath);
  if (importPackage !== manifest.name) return false;
  if (!importPath.startsWith(manifest.name)) return false;

  const rest = importPath.slice(manifest.name.length);
  const exportKey = rest === "" ? "." : `.${rest}`;
  return collectExportKeys(manifest.exports).includes(exportKey);
}

/**
 * True when rewriting `originalImportPath` → `candidateImportPath` would
 * leave a package `"exports"` surface for a deeper, non-exported path.
 *
 * Preserves already-valid export subpaths (e.g. `@acme/ui/components/button`)
 * while still allowing tsconfig/webpack aliases that share a package name
 * but are not listed in `"exports"`.
 */
export function shouldPreservePackageExportBoundary(
  resolvedFilename: string,
  originalImportPath: string,
  candidateImportPath: string,
): boolean {
  if (isLocalRelativePath(originalImportPath)) return false;
  if (!isPackageExportSubpath(resolvedFilename, originalImportPath)) {
    return false;
  }
  return !isPackageExportSubpath(resolvedFilename, candidateImportPath);
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
  const relativeFilename = relativePathFromDir(packageDir, filename);
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
