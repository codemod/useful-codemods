import type { SgNode, SgRoot } from "codemod:ast-grep";
import path from "path";
import type { Language } from "./language.ts";
import { getStringContent } from "./ast.ts";
import {
  getPackageName,
  isBarrelFile,
  isInsideNodeModules,
  isLocalRelativePath,
  joinImportPaths,
  resolveImportPath,
} from "./paths.ts";
import { parseBarrelExport } from "./barrel.ts";
import { findSymbolViaExportStar } from "./exportStar.ts";

function getImportPackageName(importPath: string): string | null {
  if (importPath.startsWith("@")) {
    const segments = importPath.split("/");
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
  }

  const [packageName] = importPath.split("/");
  return packageName || null;
}

export interface SpecRewrite {
  consumerName: string;
  newImportPath: string;
  localName: string;
  importType: "default" | "named" | "namespace";
  resolvedFilePath: string;
}

/**
 * Given a definition result for an import specifier, resolve it to
 * a direct import path bypassing the barrel.
 */
export function resolveSpecifier(
  localBinding: SgNode<Language>,
  importPath: string,
  def: { kind: string; root: SgRoot<Language>; node: SgNode<Language> },
  importerFilename: string,
  importerRelativeFilename: string,
): SpecRewrite | null {
  // When the semantic analyzer fully resolves the binding to a different
  // file we go through the `external` branches below. When it punts (most
  // commonly because the symbol flows through a bare `export *` re-export
  // that the analyzer can't enumerate statically), `def.kind` is "import"
  // and `def.root.filename()` is the importer itself — skip the
  // external-only checks and head straight to the manual export-star walker.
  if (def.kind !== "external") {
    return resolveViaExportStarWalk(
      localBinding,
      importPath,
      importerFilename,
      importerRelativeFilename,
    );
  }

  // Never rewrite imports that resolve into node_modules — those are
  // third-party or published workspace packages with potentially restricted
  // package.json "exports" that would break if we change the import subpath.
  if (isInsideNodeModules(def.root.filename())) return null;

  // For non-relative imports, only preserve the package boundary when the
  // resolved file belongs to the same named package as the import specifier.
  // This keeps tsconfig aliases like `~/foo` or `@acme/pkg/*` rewriteable
  // even when the surrounding repo has an unrelated package.json.
  if (!isLocalRelativePath(importPath)) {
    const packageName = getPackageName(def.root.filename());
    const importPackage = getImportPackageName(importPath);
    if (packageName && importPackage === packageName) {
      return null;
    }
  }

  if (isBarrelFile(def.root.filename())) {
    // Definition landed on an export_statement in the barrel
    if (def.node.is("export_statement")) {
      const info = parseBarrelExport(def.node, localBinding.text());
      if (!info) return null;
      return {
        consumerName: localBinding.text(),
        newImportPath: joinImportPaths(importPath, info.sourceFromBarrel),
        localName: info.localName,
        importType: info.importType,
        resolvedFilePath: def.root.relativeFilename(),
      };
    }
    // Import-then-reexport: definition landed on import_specifier in the barrel
    const barrelImportStmt = def.node.is("import_statement")
      ? def.node
      : def.node.ancestors().find((a) => a.is("import_statement"));
    if (!barrelImportStmt) return null;
    const impSource = barrelImportStmt.children().find((c) => c.is("string"));
    if (!impSource) return null;
    const impPath = getStringContent(impSource);
    if (!impPath || !isLocalRelativePath(impPath)) return null;
    let originalName = localBinding.text();
    if (def.node.is("import_specifier")) {
      const idents = def.node.findAll({ rule: { kind: "identifier" } });
      if (idents.length >= 1) originalName = idents[0]?.text() ?? "";
    }
    return {
      consumerName: localBinding.text(),
      newImportPath: joinImportPaths(importPath, impPath),
      localName: originalName,
      importType: "named",
      resolvedFilePath: def.root.relativeFilename(),
    };
  }

  // Semantic analyzer resolved all the way through to the actual source file
  // (not a barrel). If the resolved file is already the direct target of
  // the import (e.g. @acme/api/models/utils/ratelimiter → ratelimiter.ts),
  // the import is already correct — don't rewrite.
  return null;
}

/**
 * Compute the workspace-relative path of a barrel `index.<ext>` from an
 * importer's relative filename and the import specifier that points at it.
 * Hand-rolled because the runtime exposes only a partial `path` polyfill
 * (no `path.posix`).
 */
function barrelToRelativeFilename(
  importerRelativeFilename: string,
  importPath: string,
  barrelExt: string,
): string {
  const importerDir = importerRelativeFilename
    .replace(/\\/g, "/")
    .split("/")
    .slice(0, -1);
  const joined = importerDir.concat(importPath.replace(/\\/g, "/").split("/"));
  const resolved: string[] = [];
  for (const seg of joined) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && resolved.length > 0 && resolved[resolved.length - 1] !== "..") {
      resolved.pop();
    } else {
      resolved.push(seg);
    }
  }
  if (resolved.length > 0 && resolved[resolved.length - 1] === "index") {
    resolved.pop();
  }
  return resolved.length === 0
    ? `index${barrelExt}`
    : `${resolved.join("/")}/index${barrelExt}`;
}

/**
 * Walk the barrel pointed to by `importPath` and look for which file in its
 * `export * from "./y"` chain declares `localBinding`'s name. Used when the
 * semantic analyzer can't tell us — bare `export *` re-exports don't carry
 * named bindings the analyzer can chase.
 */
function resolveViaExportStarWalk(
  localBinding: SgNode<Language>,
  importPath: string,
  importerFilename: string,
  importerRelativeFilename: string,
): SpecRewrite | null {
  if (!isLocalRelativePath(importPath)) return null;
  const barrelFile = resolveImportPath(importerFilename, importPath);
  if (!barrelFile || !isBarrelFile(barrelFile)) return null;

  const targetFile = findSymbolViaExportStar(barrelFile, localBinding.text());
  if (!targetFile) return null;
  if (targetFile === barrelFile) return null;

  const barrelDir = path.dirname(barrelFile);
  let rel = path.relative(barrelDir, targetFile);
  const ext = path.extname(rel);
  if (ext) rel = rel.slice(0, -ext.length);
  rel = rel.replace(/\/index$/, "") || ".";
  const fromBarrel = rel.startsWith(".") ? rel : `./${rel}`;

  // Mirror the barrel's workspace-relative path for the metric, so the
  // `filePath` cardinality matches the named-reexport branches above.
  const barrelExt = path.extname(barrelFile);
  const barrelRelativeFilename = barrelToRelativeFilename(
    importerRelativeFilename,
    importPath,
    barrelExt,
  );

  return {
    consumerName: localBinding.text(),
    newImportPath: joinImportPaths(importPath, fromBarrel),
    localName: localBinding.text(),
    importType: "named",
    resolvedFilePath: barrelRelativeFilename,
  };
}
