import fs from "fs";
import path from "path";
import { parse, type SgNode, type SgRoot } from "codemod:ast-grep";
import type { Language } from "./language.ts";
import { getStringContent } from "./ast.ts";
import { isLocalRelativePath, resolveImportPath } from "./paths.ts";

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
    // named `export { X } from "./y"` re-exports here; those are
    // single-hop by design, mirroring the existing named-reexport branch.
    const nested = walk(targetFile, name, visited, depth + 1);
    if (nested) return nested;
  }
  return null;
}
