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

const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"] as const;

/**
 * Resolve a relative import path to the absolute file it points to on disk,
 * mirroring Node/TS module resolution preferences:
 *   1. `<resolved>.<ext>`            (file form — preferred when both exist)
 *   2. `<resolved>/index.<ext>`      (directory's index form)
 *
 * Returns null when the import path isn't relative or no candidate exists.
 */
export function resolveImportPath(
  importerFilename: string,
  importPath: string,
): string | null {
  if (!isLocalRelativePath(importPath)) return null;
  const importerDir = path.dirname(importerFilename);
  const resolved = path.resolve(importerDir, importPath);
  for (const ext of MODULE_EXTENSIONS) {
    const candidate = resolved + ext;
    if (fileExists(candidate)) return candidate;
  }
  for (const ext of MODULE_EXTENSIONS) {
    const candidate = path.join(resolved, `index${ext}`);
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

export function isInsideNodeModules(filename: string): boolean {
  return (
    filename.includes("/node_modules/") || filename.includes("\\node_modules\\")
  );
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
