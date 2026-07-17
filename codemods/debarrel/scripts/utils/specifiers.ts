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
  relativePathFromDir,
  resolveModuleImportPath,
  shouldPreservePackageExportBoundary,
} from "./paths.ts";
import { findSymbolViaBarrelReexports, findSymbolViaExportStar, moduleDeclaresNamedExport, moduleHasDefaultExport, moduleSoleNamedExport } from "./exportStar.ts";

function getImportPackageName(importPath: string): string | null {
  if (importPath.startsWith("@")) {
    const segments = importPath.split("/");
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
  }

  const [packageName] = importPath.split("/");
  return packageName || null;
}

/**
 * True when `importPath` targets a package root (e.g. `myapp`, `@acme/ui`),
 * as opposed to a subpath that may be a tsconfig/webpack alias
 * (e.g. `myapp/widgets`, `@acme/ui/internal`).
 */
function isPackageRootImport(importPath: string): boolean {
  if (importPath.startsWith("@")) {
    return importPath.split("/").length === 2;
  }
  return !importPath.includes("/");
}

export interface SpecRewrite {
  consumerName: string;
  newImportPath: string;
  localName: string;
  importType: "default" | "named" | "namespace";
  resolvedFilePath: string;
  typeOnly?: boolean;
}

/**
 * Given a definition result for an import specifier, resolve it to
 * a direct import path bypassing the barrel.
 */
export function resolveSpecifier(
  importedName: string,
  consumerName: string,
  importPath: string,
  def: { kind: string; root: SgRoot<Language>; node: SgNode<Language> },
  importerFilename: string,
  importerRelativeFilename: string,
  isDefaultImport = false,
): SpecRewrite | null {
  // When the semantic analyzer fully resolves the binding to a different
  // file we go through the `external` branches below. When it punts (most
  // commonly because the symbol flows through a bare `export *` re-export
  // that the analyzer can't enumerate statically), `def.kind` is "import"
  // and `def.root.filename()` is the importer itself — skip the
  // external-only checks and head straight to the manual barrel walkers.
  if (def.kind !== "external") {
    return resolveViaBarrelWalk(
      importedName,
      consumerName,
      importPath,
      importerFilename,
      importerRelativeFilename,
      isDefaultImport,
    );
  }

  // Never rewrite imports that resolve into node_modules — those are
  // third-party or published workspace packages with potentially restricted
  // package.json "exports" that would break if we change the import subpath.
  if (isInsideNodeModules(def.root.filename())) return null;

  // For non-relative imports, only preserve the package boundary for root
  // package imports (e.g. `myapp`, `@acme/ui`). Subpath imports like
  // `myapp/widgets` are often tsconfig/webpack aliases that share the
  // package.json name and must still be debarreled — unless they are
  // already a public `"exports"` entry (handled in maybeRewrite).
  if (!isLocalRelativePath(importPath)) {
    const packageName = getPackageName(def.root.filename());
    const importPackage = getImportPackageName(importPath);
    if (
      packageName &&
      importPackage === packageName &&
      isPackageRootImport(importPath)
    ) {
      return null;
    }
  }

  if (isBarrelFile(def.root.filename())) {
    // Definition landed on an export_statement in the barrel — walk the full
    // named re-export chain so one pass reaches the leaf module.
    if (def.node.is("export_statement")) {
      const reexport = findSymbolViaBarrelReexports(
        def.root.filename(),
        importedName,
        isDefaultImport,
      );
      if (!reexport) return null;
      return buildRewriteFromTarget(
        consumerName,
        importPath,
        def.root.filename(),
        reexport.targetFile,
        importerFilename,
        importerRelativeFilename,
        reexport.localName,
        reexport.importType,
      );
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
    let originalName = importedName;
    if (def.node.is("import_specifier")) {
      const idents = def.node.findAll({ rule: { kind: "identifier" } });
      if (idents.length >= 1) originalName = idents[0]?.text() ?? importedName;
    }
    return maybeRewrite(
      {
        consumerName,
        newImportPath: joinImportPaths(importPath, impPath),
        localName: originalName,
        importType: "named",
        resolvedFilePath: def.root.relativeFilename(),
      },
      importPath,
      def.root.filename(),
    );
  }

  // Semantic analyzer resolved through the barrel to the actual source file.
  // The import may still point at the barrel alias (e.g. `myapp/widgets`).
  const resolvedFilename = def.root.filename();
  const barrelFile = resolveModuleImportPath(importerFilename, importPath);
  if (
    barrelFile &&
    isBarrelFile(barrelFile) &&
    resolvedFilename !== barrelFile
  ) {
    const reexport = findSymbolViaBarrelReexports(
      barrelFile,
      importedName,
      isDefaultImport,
    );
    const localName = reexport?.localName ?? importedName;
    const importType =
      reexport?.importType ?? (isDefaultImport ? "default" : "named");

    return buildRewriteFromTarget(
      consumerName,
      importPath,
      barrelFile,
      resolvedFilename,
      importerFilename,
      importerRelativeFilename,
      localName,
      importType,
    );
  }

  return null;
}

/**
 * Walk the barrel pointed to by `importPath` when the semantic analyzer
 * can't resolve the binding. Tries explicit re-exports first, then bare
 * `export *` chains.
 */
function resolveViaBarrelWalk(
  importedName: string,
  consumerName: string,
  importPath: string,
  importerFilename: string,
  importerRelativeFilename: string,
  isDefaultImport: boolean,
): SpecRewrite | null {
  const barrelFile = resolveModuleImportPath(importerFilename, importPath);
  if (!barrelFile || !isBarrelFile(barrelFile)) return null;

  const reexport = findSymbolViaBarrelReexports(
    barrelFile,
    importedName,
    isDefaultImport,
  );
  if (reexport) {
    return buildRewriteFromTarget(
      consumerName,
      importPath,
      barrelFile,
      reexport.targetFile,
      importerFilename,
      importerRelativeFilename,
      reexport.localName,
      reexport.importType,
    );
  }

  const targetFile = findSymbolViaExportStar(barrelFile, importedName);
  if (!targetFile || targetFile === barrelFile) return null;

  return buildRewriteFromTarget(
    consumerName,
    importPath,
    barrelFile,
    targetFile,
    importerFilename,
    importerRelativeFilename,
    importedName,
    "named",
  );
}

function buildRewriteFromTarget(
  consumerName: string,
  importPath: string,
  barrelFile: string,
  targetFile: string,
  importerFilename: string,
  importerRelativeFilename: string,
  localName: string,
  importType: "default" | "named",
): SpecRewrite | null {
  const barrelDir = path.dirname(barrelFile);
  let rel = relativePathFromDir(barrelDir, targetFile);
  const ext = path.extname(rel);
  if (ext) rel = rel.slice(0, -ext.length);
  rel = rel.replace(/\/index$/, "") || ".";
  const fromBarrel = rel.startsWith(".") ? rel : `./${rel}`;

  const barrelRelativeFilename = toWorkspaceRelative(
    importerFilename,
    importerRelativeFilename,
    barrelFile,
  );

  return maybeRewrite(
    adjustRewriteForTargetExports(
      {
        consumerName,
        newImportPath: joinImportPaths(importPath, fromBarrel),
        localName,
        importType,
        resolvedFilePath: barrelRelativeFilename,
      },
      targetFile,
    ),
    importPath,
    barrelFile,
  );
}

export function adjustRewriteForTargetExports(
  rewrite: SpecRewrite,
  targetFile: string,
): SpecRewrite {
  if (rewrite.importType === "default") return rewrite;
  if (moduleDeclaresNamedExport(targetFile, rewrite.localName)) return rewrite;

  if (moduleHasDefaultExport(targetFile)) {
    return {
      ...rewrite,
      importType: "default",
      localName: "default",
    };
  }

  const soleNamedExport = moduleSoleNamedExport(targetFile);
  if (soleNamedExport) {
    return {
      ...rewrite,
      localName: soleNamedExport,
    };
  }

  if (moduleDeclaresNamedExport(targetFile, rewrite.consumerName)) {
    return {
      ...rewrite,
      localName: rewrite.consumerName,
    };
  }

  return rewrite;
}

/**
 * Drop a candidate rewrite when it would deepen a public package
 * `"exports"` subpath into a non-exported deep path.
 */
function maybeRewrite(
  rewrite: SpecRewrite,
  originalImportPath: string,
  resolvedFilename: string,
): SpecRewrite | null {
  if (
    shouldPreservePackageExportBoundary(
      resolvedFilename,
      originalImportPath,
      rewrite.newImportPath,
    )
  ) {
    return null;
  }
  return rewrite;
}

/**
 * Convert an absolute path inside the workspace back into a workspace-relative
 * path, using the importer's own absolute+relative pair to derive the
 * workspace root. Falls back to the absolute path if the root can't be
 * inferred (importerFilename doesn't end with importerRelativeFilename).
 */
function toWorkspaceRelative(
  importerFilename: string,
  importerRelativeFilename: string,
  absolutePath: string,
): string {
  if (!importerFilename.endsWith(importerRelativeFilename)) return absolutePath;
  const workspaceRoot = importerFilename.slice(
    0,
    importerFilename.length - importerRelativeFilename.length,
  );
  return relativePathFromDir(workspaceRoot, absolutePath).replace(/\\/g, "/");
}
