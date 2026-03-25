import type { Transform, Edit, SgNode } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import type TypeScript from "codemod:ast-grep/langs/typescript";
import type JavaScript from "codemod:ast-grep/langs/javascript";
import { addImport, removeImport } from "@jssg/utils/javascript/imports";
import path from "path";

type Language = TSX | TypeScript | JavaScript;

function getStringContent(node: SgNode<Language>): string | null {
  const fragment = node.find({ rule: { kind: "string_fragment" } });
  return fragment ? fragment.text() : null;
}

function joinImportPaths(
  barrelImportPath: string,
  sourceFromBarrel: string,
): string {
  let result = path.join(barrelImportPath, sourceFromBarrel);
  if (!result.startsWith(".")) {
    result = "./" + result;
  }
  return result;
}

function isLocalRelativePath(source: string): boolean {
  return source.startsWith("./") || source.startsWith("../");
}

function isBarrelFile(filename: string): boolean {
  return /^index\.(ts|tsx|js|jsx)$/.test(path.basename(filename));
}

function computeRelativeImportPath(fromFile: string, toFile: string): string {
  // @ts-expect-error -- JSSG types missing relative
  let rel = path.relative(path.dirname(fromFile), toFile);
  rel = rel.replace(/\.(ts|tsx|js|jsx)$/, "");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

interface BarrelExportInfo {
  sourceFromBarrel: string;
  localName: string;
  importType: "default" | "named" | "namespace";
}

/**
 * Parse a barrel file's export_statement to extract the re-export source and local name.
 */
function parseBarrelExport(
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

function isPureBarrel(rootNode: SgNode<Language>): {
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

interface SpecRewrite {
  consumerName: string;
  newImportPath: string;
  localName: string;
  importType: "default" | "named" | "namespace";
}

/**
 * Given a definition result for an import specifier, resolve it to
 * a direct import path bypassing the barrel.
 */
function resolveSpecifier(
  localBinding: SgNode<Language>,
  importPath: string,
  filename: string,
  def: { kind: string; root: { filename(): string }; node: SgNode<Language> },
): SpecRewrite | null {
  if (def.kind !== "external") return null;

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
    };
  }

  // Semantic analyzer resolved all the way through to the actual source file
  const directPath = computeRelativeImportPath(filename, def.root.filename());
  if (directPath === importPath) return null;
  return {
    consumerName: localBinding.text(),
    newImportPath: directPath,
    localName: localBinding.text(),
    importType: "named",
  };
}

function buildImportText(
  sourcePath: string,
  specs: SpecRewrite[],
  quoteChar: string,
): string {
  const parts: string[] = [];
  const defaultSpec = specs.find((s) => s.importType === "default");
  if (defaultSpec) parts.push(defaultSpec.consumerName);
  for (const ns of specs.filter((s) => s.importType === "namespace")) {
    parts.push(`* as ${ns.consumerName}`);
  }
  const namedSpecs = specs.filter((s) => s.importType === "named");
  if (namedSpecs.length > 0) {
    const specTexts = namedSpecs.map((s) =>
      s.localName !== s.consumerName
        ? `${s.localName} as ${s.consumerName}`
        : s.consumerName,
    );
    parts.push(`{ ${specTexts.join(", ")} }`);
  }
  return `import ${parts.join(", ")} from ${quoteChar}${sourcePath}${quoteChar};`;
}

function groupByPath(rewrites: SpecRewrite[]): Map<string, SpecRewrite[]> {
  const byPath = new Map<string, SpecRewrite[]>();
  for (const rw of rewrites) {
    const existing = byPath.get(rw.newImportPath) ?? [];
    existing.push(rw);
    byPath.set(rw.newImportPath, existing);
  }
  return byPath;
}

function addImportsFromRewrites(
  rootNode: SgNode<Language, "program">,
  byPath: Map<string, SpecRewrite[]>,
  edits: Edit[],
): void {
  for (const [sourcePath, specs] of byPath) {
    const defaultSpec = specs.find((s) => s.importType === "default");
    if (defaultSpec) {
      const e = addImport(rootNode, {
        type: "default",
        name: defaultSpec.consumerName,
        from: sourcePath,
      });
      if (e) edits.push(e);
    }

    for (const ns of specs.filter((s) => s.importType === "namespace")) {
      const e = addImport(rootNode, {
        type: "namespace",
        name: ns.consumerName,
        from: sourcePath,
      });
      if (e) edits.push(e);
    }

    const namedSpecs = specs.filter((s) => s.importType === "named");
    if (namedSpecs.length > 0) {
      const e = addImport(rootNode, {
        type: "named",
        specifiers: namedSpecs.map((s) =>
          s.localName !== s.consumerName
            ? { name: s.localName, alias: s.consumerName }
            : { name: s.consumerName },
        ),
        from: sourcePath,
      });
      if (e) edits.push(e);
    }
  }
}

const transform: Transform<Language> = async (root) => {
  const rootNode = root.root();
  const filename = root.filename();
  const edits: Edit[] = [];

  for (const importStmt of rootNode.findAll({
    rule: { kind: "import_statement" },
  })) {
    const importSourceNode = importStmt.children().find((c) => c.is("string"));
    if (!importSourceNode) continue;
    const importPath = getStringContent(importSourceNode);
    if (!importPath) continue;
    const quoteChar = importSourceNode.text().startsWith('"') ? '"' : "'";

    const importClause = importStmt
      .children()
      .find((c) => c.is("import_clause"));
    if (!importClause) continue;

    const rewrites: SpecRewrite[] = [];
    let totalSpecifiers = 0;

    // Named imports
    const namedImports = importClause.find({
      rule: { kind: "named_imports" },
    });
    if (namedImports) {
      const specifiers = namedImports.findAll({
        rule: { kind: "import_specifier" },
      });
      totalSpecifiers += specifiers.length;
      for (const spec of specifiers) {
        const identifiers = spec.findAll({ rule: { kind: "identifier" } });
        const localBinding = identifiers[identifiers.length - 1];
        if (!localBinding) continue;
        const def = localBinding.definition();
        if (!def) continue;
        const rw = resolveSpecifier(localBinding, importPath, filename, def);
        if (rw) rewrites.push(rw);
      }
    }

    // Default import
    const defaultIdent = importClause
      .children()
      .find(
        (c) =>
          c.is("identifier") && !c.inside({ rule: { kind: "named_imports" } }),
      );
    if (defaultIdent) {
      totalSpecifiers += 1;
      const def = defaultIdent.definition();
      if (def) {
        const rw = resolveSpecifier(defaultIdent, importPath, filename, def);
        if (rw) rewrites.push(rw);
      }
    }

    if (rewrites.length === 0) continue;

    const byPath = groupByPath(rewrites);

    if (rewrites.length === totalSpecifiers) {
      // All specifiers rewritten — replace the entire import statement.
      // Can't use removeImport+addImport here because edits overlap
      // when the barrel import is the last/only import in the file.
      const lines: string[] = [];
      for (const [sourcePath, specs] of byPath) {
        lines.push(buildImportText(sourcePath, specs, quoteChar));
      }
      edits.push(importStmt.replace(lines.join("\n")));
    } else {
      // Partial — some specifiers stay with the barrel.
      const removeEdit = removeImport(rootNode, {
        type: "named",
        specifiers: rewrites.map((rw) => rw.consumerName),
        from: importPath,
      });
      if (removeEdit) edits.push(removeEdit);
      addImportsFromRewrites(rootNode, byPath, edits);
    }
  }

  // Barrel rename
  if (isBarrelFile(filename)) {
    const { pure, hasWildcards } = isPureBarrel(rootNode);
    if (pure && !hasWildcards) {
      root.rename(`index.barrel.bak${path.extname(filename)}`);
    }
  }

  if (edits.length === 0) return null;
  return rootNode.commitEdits(edits);
};

export default transform;
