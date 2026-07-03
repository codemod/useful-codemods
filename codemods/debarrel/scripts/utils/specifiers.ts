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
  resolveModuleImportPath,
} from "./paths.ts";
import { parseBarrelExport } from "./barrel.ts";
import { findSymbolViaBarrelReexports, findSymbolViaExportStar } from "./exportStar.ts";

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
  localBinding: SgNode<Language>,
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
      localBinding,
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
  // package.json name and must still be debarreled.
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
    // Definition landed on an export_statement in the barrel
    if (def.node.is("export_statement")) {
      const info = parseBarrelExport(def.node, localBinding.text(), {
        isDefaultImport,
      });
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

  // Semantic analyzer resolved through the barrel to the actual source file.
  // The import may still point at the barrel alias (e.g. `myapp/widgets`).
  const resolvedFilename = def.root.filename();
  const barrelFile = resolveModuleImportPath(importerFilename, importPath);
  if (
    barrelFile &&
    isBarrelFile(barrelFile) &&
    resolvedFilename !== barrelFile
  ) {
    const barrelDir = path.dirname(barrelFile);
    let rel = path.relative(barrelDir, resolvedFilename);
    const ext = path.extname(rel);
    if (ext) rel = rel.slice(0, -ext.length);
    rel = rel.replace(/\/index$/, "") || ".";
    const fromBarrel = rel.startsWith(".") ? rel : `./${rel}`;
    return {
      consumerName: localBinding.text(),
      newImportPath: joinImportPaths(importPath, fromBarrel),
      localName: localBinding.text(),
      importType: "named",
      resolvedFilePath: def.root.relativeFilename(),
    };
  }

  return null;
}

/**
 * Walk the barrel pointed to by `importPath` when the semantic analyzer
 * can't resolve the binding. Tries explicit re-exports first, then bare
 * `export *` chains.
 */
function resolveViaBarrelWalk(
  localBinding: SgNode<Language>,
  importPath: string,
  importerFilename: string,
  importerRelativeFilename: string,
  isDefaultImport: boolean,
): SpecRewrite | null {
  const barrelFile = resolveModuleImportPath(importerFilename, importPath);
  if (!barrelFile || !isBarrelFile(barrelFile)) return null;

  const reexport = findSymbolViaBarrelReexports(
    barrelFile,
    localBinding.text(),
    isDefaultImport,
  );
  if (reexport) {
    return buildRewriteFromTarget(
      localBinding.text(),
      importPath,
      barrelFile,
      reexport.targetFile,
      importerFilename,
      importerRelativeFilename,
      reexport.localName,
      reexport.importType,
    );
  }

  const targetFile = findSymbolViaExportStar(barrelFile, localBinding.text());
  if (!targetFile || targetFile === barrelFile) return null;

  return buildRewriteFromTarget(
    localBinding.text(),
    importPath,
    barrelFile,
    targetFile,
    importerFilename,
    importerRelativeFilename,
    localBinding.text(),
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
): SpecRewrite {
  const barrelDir = path.dirname(barrelFile);
  let rel = path.relative(barrelDir, targetFile);
  const ext = path.extname(rel);
  if (ext) rel = rel.slice(0, -ext.length);
  rel = rel.replace(/\/index$/, "") || ".";
  const fromBarrel = rel.startsWith(".") ? rel : `./${rel}`;

  const barrelRelativeFilename = toWorkspaceRelative(
    importerFilename,
    importerRelativeFilename,
    barrelFile,
  );

  return {
    consumerName,
    newImportPath: joinImportPaths(importPath, fromBarrel),
    localName,
    importType,
    resolvedFilePath: barrelRelativeFilename,
  };
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
  return path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/");
}
