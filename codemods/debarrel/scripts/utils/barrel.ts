import type { SgNode } from "codemod:ast-grep";
import type { Language } from "./language.ts";
import { getStringContent } from "./ast.ts";
import { isLocalRelativePath } from "./paths.ts";

export interface BarrelExportInfo {
  sourceFromBarrel: string;
  localName: string;
  importType: "default" | "named" | "namespace";
}

/**
 * Parse a barrel file's export_statement to extract the re-export source and local name.
 */
export interface ParseBarrelExportOptions {
  /** True when the consumer uses `import Binding from "…"` syntax. */
  isDefaultImport?: boolean;
}

export function parseBarrelExport(
  exportStmt: SgNode<Language>,
  consumerImportName: string,
  options: ParseBarrelExportOptions = {},
): BarrelExportInfo | null {
  const { isDefaultImport = false } = options;
  const children = exportStmt.children();
  const sourceNode = children.find((c) => c.is("string"));
  const exportClause = children.find((c) => c.is("export_clause"));
  const namespaceExport = children.find((c) => c.is("namespace_export"));

  // export * as X from './source'
  if (namespaceExport && sourceNode) {
    const sourcePath = getStringContent(sourceNode);
    if (!sourcePath || !isLocalRelativePath(sourcePath)) return null;
    return {
      sourceFromBarrel: sourcePath,
      localName: consumerImportName,
      importType: "namespace",
    };
  }

  // export { X } from './source' or export { X as Y } from './source'
  if (exportClause && sourceNode) {
    const sourcePath = getStringContent(sourceNode);
    if (!sourcePath || !isLocalRelativePath(sourcePath)) return null;

    for (const spec of exportClause.findAll({
      rule: { kind: "export_specifier" },
    })) {
      const identifiers = spec.findAll({ rule: { kind: "identifier" } });
      const localName = identifiers[0]?.text();
      const exportedName =
        identifiers.length >= 2 ? identifiers[1]?.text() : localName;
      if (exportedName === consumerImportName) {
        return {
          sourceFromBarrel: sourcePath,
          localName: localName ?? consumerImportName,
          importType: localName === "default" ? "default" : "named",
        };
      }
      if (isDefaultImport && exportedName === "default") {
        return {
          sourceFromBarrel: sourcePath,
          localName: localName ?? consumerImportName,
          importType: "named",
        };
      }
    }
  }

  return null;
}

export function isPureBarrel(rootNode: SgNode<Language>): {
  pure: boolean;
  hasWildcards: boolean;
} {
  const importedBindings = collectLocalImportBindings(rootNode);
  let hasReExports = false;
  let hasWildcards = false;

  for (const child of rootNode.children()) {
    if (child.is("import_statement")) continue;
    if (child.is("export_statement")) {
      const stmtChildren = child.children();
      const sourceNode = stmtChildren.find((c) => c.is("string"));
      const source = sourceNode ? getStringContent(sourceNode) : null;
      const hasExportClause = stmtChildren.some((c) => c.is("export_clause"));
      const hasNamespaceExport = stmtChildren.some((c) =>
        c.is("namespace_export"),
      );

      if (!source) {
        if (
          !hasExportClause ||
          !exportsOnlyImportedBindings(child, importedBindings)
        ) {
          return { pure: false, hasWildcards };
        }

        hasReExports = true;
        continue;
      }

      if (!isLocalRelativePath(source)) {
        return { pure: false, hasWildcards };
      }

      hasReExports = true;
      if (!hasExportClause || hasNamespaceExport) hasWildcards = true;
      continue;
    }
    if (child.isNamed()) return { pure: false, hasWildcards };
  }

  return { pure: hasReExports, hasWildcards };
}

function collectLocalImportBindings(rootNode: SgNode<Language>): Set<string> {
  const bindings = new Set<string>();

  for (const importStmt of rootNode.findAll({
    rule: { kind: "import_statement" },
  })) {
    const sourceNode = importStmt.children().find((c) => c.is("string"));
    const source = sourceNode ? getStringContent(sourceNode) : null;
    if (!source || !isLocalRelativePath(source)) continue;

    const importClause = importStmt
      .children()
      .find((c) => c.is("import_clause"));
    if (!importClause) continue;

    for (const specifier of importClause.findAll({
      rule: { kind: "import_specifier" },
    })) {
      const identifiers = specifier.findAll({ rule: { kind: "identifier" } });
      const localName = identifiers[identifiers.length - 1]?.text();
      if (localName) bindings.add(localName);
    }

    for (const namespaceImport of importClause.findAll({
      rule: { kind: "namespace_import" },
    })) {
      const identifiers = namespaceImport.findAll({
        rule: { kind: "identifier" },
      });
      const localName = identifiers[identifiers.length - 1]?.text();
      if (localName) bindings.add(localName);
    }

    for (const child of importClause.children()) {
      if (child.is("identifier")) bindings.add(child.text());
    }
  }

  return bindings;
}

function exportsOnlyImportedBindings(
  exportStmt: SgNode<Language>,
  importedBindings: Set<string>,
): boolean {
  const specifiers = exportStmt.findAll({
    rule: { kind: "export_specifier" },
  });
  if (specifiers.length === 0) return false;

  return specifiers.every((specifier) => {
    const identifiers = specifier.findAll({ rule: { kind: "identifier" } });
    const localName = identifiers[0]?.text();
    return Boolean(localName && importedBindings.has(localName));
  });
}
