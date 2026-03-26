import type { Transform, Edit, SgNode } from "codemod:ast-grep";
import type TSX from "codemod:ast-grep/langs/tsx";
import type TypeScript from "codemod:ast-grep/langs/typescript";
import type JavaScript from "codemod:ast-grep/langs/javascript";
import { addImport, removeImport } from "@jssg/utils/javascript/imports";
import path from "path";
import fs from "fs";

type Language = TSX | TypeScript | JavaScript;

function getStringContent(node: SgNode<Language>): string | null {
  const fragment = node.find({ rule: { kind: "string_fragment" } });
  return fragment ? fragment.text() : null;
}

function joinImportPaths(
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

function isLocalRelativePath(source: string): boolean {
  return (
    source === "." ||
    source === ".." ||
    source.startsWith("./") ||
    source.startsWith("../")
  );
}

function isBarrelFile(filename: string): boolean {
  return /^index\.(ts|tsx|js|jsx)$/.test(path.basename(filename));
}

function isInsideNodeModules(filename: string): boolean {
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

function hasPackageJson(filename: string): boolean {
  let dir = path.dirname(filename);
  const root = path.parse(dir).root || "/";
  while (dir !== root) {
    if (fileExists(path.join(dir, "package.json"))) return true;
    dir = path.dirname(dir);
  }
  return false;
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
  def: { kind: string; root: { filename(): string }; node: SgNode<Language> },
): SpecRewrite | null {
  if (def.kind !== "external") return null;

  // Never rewrite imports that resolve into node_modules — those are
  // third-party or published workspace packages with potentially restricted
  // package.json "exports" that would break if we change the import subpath.
  if (isInsideNodeModules(def.root.filename())) return null;

  // For non-relative imports (package names, aliases), skip if the resolved
  // file lives inside a package (has a package.json ancestor). The package's
  // "exports" field controls valid subpaths — rewriting the import could
  // produce a path that isn't exported (e.g. @acme/validators → @acme/validators/foo).
  if (!isLocalRelativePath(importPath) && hasPackageJson(def.root.filename())) {
    return null;
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
  // (not a barrel). Only rewrite if the import actually went through a barrel
  // that we can bypass. If the resolved file is already the direct target of
  // the import (e.g. @acme/api/models/utils/ratelimiter → ratelimiter.ts),
  // the import is already correct — don't rewrite.
  return null;
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
        const rw = resolveSpecifier(localBinding, importPath, def);
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
        const rw = resolveSpecifier(defaultIdent, importPath, def);
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

  // Barrel rename — skip files inside node_modules or inside a package
  // (renaming a package entry point would break consumers importing via
  // the package name).
  if (
    isBarrelFile(filename) &&
    !isInsideNodeModules(filename) &&
    !hasPackageJson(filename)
  ) {
    const { pure, hasWildcards } = isPureBarrel(rootNode);
    if (pure && !hasWildcards) {
      root.rename(`index.barrel.bak${path.extname(filename)}`);
    }
  }

  if (edits.length === 0) return null;
  return rootNode.commitEdits(edits);
};

export default transform;
