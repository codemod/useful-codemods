import fs from "fs";
import path from "path";
import { parse, type SgNode, type SgRoot } from "codemod:ast-grep";
import type { Language } from "./language.ts";
import { getStringContent } from "./ast.ts";
import { parseBarrelExport } from "./barrel.ts";
import {
  fileHasMdxNamespaceImportFrom,
  findWorkspaceSourceRoot,
  getAliasImportPathsForBarrel,
  isBarrelFile,
  isLocalRelativePath,
  normalizeAbsolutePath,
  resolveImportPath,
  resolveModuleImportPath,
  getProjectSourceFiles,
} from "./paths.ts";

// The semantic analyzer's `definition()` does not chase through bare
// `export * from "./y"` re-exports in this jssg runtime — for those
// specifiers `def.kind` is "import" and `def.root.filename()` is the
// importer itself. To find the symbol's actual source we walk the barrel
// chain ourselves: read each file off disk, parse it with ast-grep, and
// scan its top-level `export_statement` nodes.

function langForFile(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".tsx" || ext === ".jsx") return "tsx";
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return "javascript";
  return "typescript";
}

function parseFile(filename: string): SgRoot<Language> | null {
  let source: string;
  try {
    source = fs.readFileSync(filename, "utf8");
  } catch {
    return null;
  }
  try {
    return parse<Language>(langForFile(filename), source);
  } catch {
    return null;
  }
}

interface ExportStatementShape {
  hasNamespaceExport: boolean;
  hasExportClause: boolean;
  exportClause: SgNode<Language> | undefined;
  sourceNode: SgNode<Language> | undefined;
  declaration: SgNode<Language> | undefined;
}

function inspectExportStatement(stmt: SgNode<Language>): ExportStatementShape {
  const children = stmt.children();
  return {
    hasNamespaceExport: children.some((c) => c.is("namespace_export")),
    hasExportClause: children.some((c) => c.is("export_clause")),
    exportClause: children.find((c) => c.is("export_clause")),
    sourceNode: children.find((c) => c.is("string")),
    declaration: children.find(
      (c) =>
        c.is("lexical_declaration") ||
        c.is("function_declaration") ||
        c.is("class_declaration") ||
        c.is("type_alias_declaration") ||
        c.is("interface_declaration") ||
        c.is("enum_declaration"),
    ),
  };
}

// `export * from "./y"` (and `export type * from "./y"`), but NOT
// `export * as Ns from "./y"` — namespace re-exports wrap their target in a
// single binding the semantic analyzer already resolves on its own.
function findExportStarSources(root: SgRoot<Language>): string[] {
  const results = new Set<string>();
  for (const stmt of root.root().children()) {
    if (!stmt.is("export_statement")) continue;
    const shape = inspectExportStatement(stmt);
    if (!shape.sourceNode) continue;
    if (shape.hasNamespaceExport || shape.hasExportClause) continue;
    const sourcePath = getStringContent(shape.sourceNode);
    if (sourcePath) results.add(sourcePath);
  }
  return [...results];
}

function declarationNameMatches(decl: SgNode<Language>, name: string): boolean {
  if (decl.is("lexical_declaration")) {
    for (const declarator of decl.findAll({
      rule: { kind: "variable_declarator" },
    })) {
      const ident = declarator
        .children()
        .find((c) => c.is("identifier") || c.is("shorthand_property_identifier_pattern"));
      if (ident && ident.text() === name) return true;
    }
    return false;
  }
  const ident = decl
    .children()
    .find((c) => c.is("identifier") || c.is("type_identifier"));
  return ident !== undefined && ident.text() === name;
}

// True when `root` exposes `name` as a top-level export — either as a direct
// declaration (`export const NAME`, `export type NAME`, …) or inside an
// export clause (`export { …, NAME, … }`, possibly aliased, possibly
// re-exported from another module).
function fileDeclaresName(root: SgRoot<Language>, name: string): boolean {
  for (const stmt of root.root().children()) {
    if (!stmt.is("export_statement")) continue;
    const shape = inspectExportStatement(stmt);

    if (shape.exportClause) {
      for (const spec of shape.exportClause.findAll({
        rule: { kind: "export_specifier" },
      })) {
        const idents = spec.findAll({ rule: { kind: "identifier" } });
        // `X` -> [X]; `X as Y` -> [X, Y]; exported name is the last identifier.
        const exportedName = idents[idents.length - 1]?.text();
        if (exportedName === name) return true;
      }
      continue;
    }

    if (shape.declaration && declarationNameMatches(shape.declaration, name)) {
      return true;
    }
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

export interface BarrelReexportMatch {
  targetFile: string;
  localName: string;
  importType: "default" | "named";
}

/**
 * Walk `barrelFile`'s explicit `export { … } from "./y"` re-exports to find
 * which file provides `name` for a consumer import. Follows transitive named
 * re-export chains (barrel → barrel → source) in a single pass.
 */
export function findSymbolViaBarrelReexports(
  barrelFile: string,
  consumerName: string,
  isDefaultImport: boolean,
): BarrelReexportMatch | null {
  return findSymbolViaBarrelReexportsRecursive(
    barrelFile,
    consumerName,
    isDefaultImport,
    new Set(),
    0,
  );
}

interface ImportBindingSource {
  targetFile: string;
  importedName: string;
  importType: "default" | "named";
}

function findImportBindingSource(
  barrelFile: string,
  localBinding: string,
): ImportBindingSource | null {
  const root = parseFile(barrelFile);
  if (!root) return null;

  for (const importStmt of root.root().findAll({
    rule: { kind: "import_statement" },
  })) {
    const sourceNode = importStmt.children().find((c) => c.is("string"));
    const impPath = sourceNode ? getStringContent(sourceNode) : null;
    if (!impPath || !isLocalRelativePath(impPath)) continue;

    const importClause = importStmt
      .children()
      .find((c) => c.is("import_clause"));
    if (!importClause) continue;

    const defaultIdent = importClause
      .children()
      .find(
        (c) =>
          c.is("identifier") &&
          !c.inside({ rule: { kind: "named_imports" } }),
      );
    if (defaultIdent?.text() === localBinding) {
      const targetFile = resolveImportPath(barrelFile, impPath);
      if (!targetFile) continue;
      return {
        targetFile,
        importedName: "default",
        importType: "default",
      };
    }

    for (const spec of importClause.findAll({
      rule: { kind: "import_specifier" },
    })) {
      const idents = spec.findAll({ rule: { kind: "identifier" } });
      const imported = idents[0]?.text();
      const local = idents[idents.length - 1]?.text();
      if (!imported || local !== localBinding) continue;

      const targetFile = resolveImportPath(barrelFile, impPath);
      if (!targetFile) continue;
      const isDefaultSpec = imported === "default";
      return {
        targetFile,
        importedName: isDefaultSpec ? "default" : imported,
        importType: isDefaultSpec ? "default" : "named",
      };
    }
  }

  return null;
}

function findSymbolViaLocalReexport(
  barrelFile: string,
  consumerName: string,
  visited: Set<string>,
  depth: number,
): BarrelReexportMatch | null {
  const root = parseFile(barrelFile);
  if (!root) return null;

  for (const stmt of root.root().children()) {
    if (!stmt.is("export_statement")) continue;
    const shape = inspectExportStatement(stmt);
    if (!shape.exportClause || shape.sourceNode) continue;

    for (const spec of shape.exportClause.findAll({
      rule: { kind: "export_specifier" },
    })) {
      const idents = spec.findAll({ rule: { kind: "identifier" } });
      const localName = idents[0]?.text();
      const exportedName =
        idents.length >= 2 ? idents[1]?.text() : localName;
      if (!localName || exportedName !== consumerName) continue;

      const binding = findImportBindingSource(barrelFile, localName);
      if (!binding) continue;

      if (isBarrelFile(binding.targetFile)) {
        const nested = findSymbolViaBarrelReexportsRecursive(
          binding.targetFile,
          binding.importedName === "default" ? localName : binding.importedName,
          binding.importType === "default",
          visited,
          depth + 1,
        );
        if (nested) return nested;
      }

      return {
        targetFile: binding.targetFile,
        localName: binding.importedName,
        importType: binding.importType,
      };
    }
  }

  return null;
}

function findSymbolViaBarrelReexportsRecursive(
  barrelFile: string,
  consumerName: string,
  isDefaultImport: boolean,
  visited: Set<string>,
  depth: number,
): BarrelReexportMatch | null {
  if (depth > 10) return null;
  const normalized = path.resolve(barrelFile);
  if (visited.has(normalized)) return null;
  visited.add(normalized);

  const local = findSymbolViaLocalReexport(
    barrelFile,
    consumerName,
    visited,
    depth,
  );
  if (local) return local;

  const root = parseFile(barrelFile);
  if (!root) return null;

  for (const stmt of root.root().children()) {
    if (!stmt.is("export_statement")) continue;
    // Namespace re-exports (`export * as Ns from "./y"`) are not debarreled here.
    if (stmt.children().some((c) => c.is("namespace_export"))) continue;
    const info = parseBarrelExport(stmt, consumerName, { isDefaultImport });
    if (!info || info.importType === "namespace") continue;
    const targetFile = resolveImportPath(barrelFile, info.sourceFromBarrel);
    if (!targetFile) continue;

    // Continue through nested barrels so one pass reaches the leaf module.
    if (isBarrelFile(targetFile) && targetFile !== barrelFile) {
      const nested = findSymbolViaBarrelReexportsRecursive(
        targetFile,
        info.localName,
        info.importType === "default",
        visited,
        depth + 1,
      );
      if (nested) return nested;
    }

    return {
      targetFile,
      localName: info.localName,
      importType: info.importType,
    };
  }
  return null;
}

function barrelDirectory(filePath: string): string | null {
  const base = path.basename(filePath);
  if (!/^index(\.barrel\.bak)?\.(ts|tsx|js|jsx)$/.test(base)) return null;
  return path.resolve(path.dirname(filePath));
}

function barrelPathsMatch(left: string, right: string): boolean {
  const leftDir = barrelDirectory(left);
  const rightDir = barrelDirectory(right);
  if (leftDir && rightDir) return leftDir === rightDir;
  return path.resolve(left) === path.resolve(right);
}

function importPathResolvesToBarrel(
  importerFile: string,
  importPath: string,
  normalizedBarrel: string,
  aliasImportPaths: Set<string>,
): boolean {
  if (aliasImportPaths.has(importPath)) return true;
  const resolved = resolveModuleImportPath(importerFile, importPath);
  return Boolean(resolved && barrelPathsMatch(resolved, normalizedBarrel));
}

/**
 * True when `root` contains a static (non-namespace) import whose source path
 * resolves to `normalizedBarrel`. Such files get mock/dynamic-import paths
 * rewritten in the same codemod pass, so they should not block barrel rename.
 */
function fileHasRewritableStaticBarrelImport(
  root: SgRoot<Language>,
  importerFile: string,
  barrelImportPath: string,
  normalizedBarrel: string,
  aliasImportPaths: Set<string>,
): boolean {
  if (
    !importPathResolvesToBarrel(
      importerFile,
      barrelImportPath,
      normalizedBarrel,
      aliasImportPaths,
    )
  ) {
    return false;
  }

  for (const importStmt of root.root().findAll({
    rule: { kind: "import_statement" },
  })) {
    const sourceNode = importStmt.children().find((c) => c.is("string"));
    const importPath = sourceNode ? getStringContent(sourceNode) : null;
    if (importPath !== barrelImportPath) continue;

    const importClause = importStmt
      .children()
      .find((c) => c.is("import_clause"));
    if (importClause?.find({ rule: { kind: "namespace_import" } })) continue;

    return true;
  }

  return false;
}

/**
 * True when any source file in the workspace depends on `barrelFile` in a
 * way that cannot be rewritten to a single direct module:
 * - namespace imports (`import * as X from "..."`)
 * - namespace re-exports (`export * as X from "..."`)
 * - dynamic imports (`import("...")`)
 *
 * Those consumers require the barrel entrypoint to remain in place.
 */
export function barrelHasNamespaceImporters(barrelFile: string): boolean {
  return barrelMustBePreserved(barrelFile);
}

/**
 * Broader rename-safety check covering namespace imports, namespace
 * re-exports, and dynamic `import()` consumers.
 */
export function barrelMustBePreserved(barrelFile: string): boolean {
  const workspaceRoot = findWorkspaceSourceRoot(barrelFile);
  const normalizedBarrel = normalizeAbsolutePath(barrelFile, workspaceRoot);
  const aliasImportPaths = new Set(getAliasImportPathsForBarrel(barrelFile));

  for (const file of getProjectSourceFiles(workspaceRoot)) {
    if (path.resolve(file) === path.resolve(normalizedBarrel)) continue;

    if (fileHasMdxNamespaceImportFrom(file, aliasImportPaths)) {
      return true;
    }

    const root = parseFile(file);
    if (!root) continue;

    for (const importStmt of root.root().findAll({
      rule: { kind: "import_statement" },
    })) {
      const importClause = importStmt
        .children()
        .find((c) => c.is("import_clause"));
      if (!importClause?.find({ rule: { kind: "namespace_import" } })) continue;

      const sourceNode = importStmt.children().find((c) => c.is("string"));
      const importPath = sourceNode ? getStringContent(sourceNode) : null;
      if (!importPath) continue;

      if (
        importPathResolvesToBarrel(
          file,
          importPath,
          normalizedBarrel,
          aliasImportPaths,
        )
      ) {
        return true;
      }
    }

    for (const exportStmt of root.root().findAll({
      rule: { kind: "export_statement" },
    })) {
      if (!exportStmt.children().some((c) => c.is("namespace_export"))) {
        continue;
      }
      const sourceNode = exportStmt.children().find((c) => c.is("string"));
      const exportPath = sourceNode ? getStringContent(sourceNode) : null;
      if (!exportPath) continue;

      if (
        importPathResolvesToBarrel(
          file,
          exportPath,
          normalizedBarrel,
          aliasImportPaths,
        )
      ) {
        return true;
      }
    }

    // Dynamic import("./barrel") / import('...') — string argument only.
    for (const call of root.root().findAll({
      rule: { kind: "call_expression" },
    })) {
      const callee = call.children().find((c) => c.is("import"));
      if (!callee) continue;
      const args = call.children().find((c) => c.is("arguments"));
      if (!args) continue;
      const sourceNode = args.children().find((c) => c.is("string"));
      const importPath = sourceNode ? getStringContent(sourceNode) : null;
      if (!importPath) continue;

      if (
        importPathResolvesToBarrel(
          file,
          importPath,
          normalizedBarrel,
          aliasImportPaths,
        )
      ) {
        if (
          fileHasRewritableStaticBarrelImport(
            root,
            file,
            importPath,
            normalizedBarrel,
            aliasImportPaths,
          )
        ) {
          continue;
        }
        return true;
      }
    }
  }
  return false;
}

export function moduleDeclaresNamedExport(
  moduleFile: string,
  name: string,
): boolean {
  const root = parseFile(moduleFile);
  if (!root) return false;
  return fileDeclaresName(root, name);
}

export function moduleHasDefaultExport(moduleFile: string): boolean {
  const root = parseFile(moduleFile);
  if (!root) return false;

  for (const stmt of root.root().children()) {
    if (!stmt.is("export_statement")) continue;
    const children = stmt.children();
    if (!children.some((c) => c.is("default"))) continue;

    const shape = inspectExportStatement(stmt);
    if (shape.exportClause) {
      for (const spec of shape.exportClause.findAll({
        rule: { kind: "export_specifier" },
      })) {
        const idents = spec.findAll({ rule: { kind: "identifier" } });
        if (idents[0]?.text() === "default") return true;
      }
      continue;
    }

    if (shape.declaration) return true;
  }
  return false;
}

function collectExportedNames(root: SgRoot<Language>): string[] {
  const names = new Set<string>();
  for (const stmt of root.root().children()) {
    if (!stmt.is("export_statement")) continue;
    const shape = inspectExportStatement(stmt);

    if (shape.exportClause) {
      for (const spec of shape.exportClause.findAll({
        rule: { kind: "export_specifier" },
      })) {
        const idents = spec.findAll({ rule: { kind: "identifier" } });
        const exportedName = idents[idents.length - 1]?.text();
        if (exportedName && exportedName !== "default") names.add(exportedName);
      }
      continue;
    }

    if (shape.declaration) {
      if (shape.declaration.is("lexical_declaration")) {
        for (const declarator of shape.declaration.findAll({
          rule: { kind: "variable_declarator" },
        })) {
          const ident = declarator
            .children()
            .find(
              (c) =>
                c.is("identifier") ||
                c.is("shorthand_property_identifier_pattern"),
            );
          if (ident) names.add(ident.text());
        }
      } else {
        const ident = shape.declaration
          .children()
          .find((c) => c.is("identifier") || c.is("type_identifier"));
        if (ident) names.add(ident.text());
      }
    }
  }
  return [...names];
}

export function moduleSoleNamedExport(moduleFile: string): string | null {
  const root = parseFile(moduleFile);
  if (!root) return null;
  const names = collectExportedNames(root);
  return names.length === 1 ? names[0]! : null;
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

  const root = parseFile(file);
  if (!root) return null;

  for (const subPath of findExportStarSources(root)) {
    if (!isLocalRelativePath(subPath)) continue;
    const targetFile = resolveImportPath(file, subPath);
    if (!targetFile) continue;
    const targetRoot = parseFile(targetFile);
    if (!targetRoot) continue;
    if (fileDeclaresName(targetRoot, name)) return targetFile;

    // The first re-export hop didn't declare the symbol directly — keep
    // walking that file's own `export *` chain. We don't try to follow
    // named `export { X } from "./y"` re-exports here; those are handled
    // by findSymbolViaBarrelReexports.
    const nested = walk(targetFile, name, visited, depth + 1);
    if (nested) return nested;
  }
  return null;
}
