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
export function parseBarrelExport(
  exportStmt: SgNode<Language>,
  consumerImportName: string,
): BarrelExportInfo | null {
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
    }
  }

  return null;
}

export function isPureBarrel(rootNode: SgNode<Language>): {
  pure: boolean;
  hasWildcards: boolean;
} {
  let hasWildcards = false;
  let hasOwnDeclarations = false;

  for (const child of rootNode.children()) {
    if (child.is("import_statement")) continue;
    if (child.is("export_statement")) {
      const stmtChildren = child.children();
      const hasSource = stmtChildren.some((c) => c.is("string"));
      const hasExportClause = stmtChildren.some((c) => c.is("export_clause"));
      const hasNamespaceExport = stmtChildren.some((c) =>
        c.is("namespace_export"),
      );
      const hasDeclaration = stmtChildren.some(
        (c) =>
          c.is("lexical_declaration") ||
          c.is("function_declaration") ||
          c.is("class_declaration") ||
          c.is("type_alias_declaration") ||
          c.is("interface_declaration"),
      );
      if (hasDeclaration) {
        hasOwnDeclarations = true;
      } else if (hasSource && (!hasExportClause || hasNamespaceExport)) {
        hasWildcards = true;
      }
      continue;
    }
    if (child.isNamed()) {
      hasOwnDeclarations = true;
    }
  }

  return { pure: !hasOwnDeclarations, hasWildcards };
}
