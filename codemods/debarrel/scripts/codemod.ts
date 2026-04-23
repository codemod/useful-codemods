import type { Codemod, Edit, GetSelector } from "codemod:ast-grep";
import path from "path";
import type { Language } from "./utils/language.ts";
import { getStringContent } from "./utils/ast.ts";
import {
  hasPackageJson,
  isBarrelFile,
  isInsideNodeModules,
} from "./utils/paths.ts";
import { isPureBarrel } from "./utils/barrel.ts";
import { resolveSpecifier, type SpecRewrite } from "./utils/specifiers.ts";
import { buildImportText, groupByPath } from "./utils/imports.ts";
import {
  recordBarrelRewrites,
  rewriteMockCalls,
  type BarrelMockInfo,
} from "./utils/mocks.ts";
import { emitMetricsForBarrelSibling } from "./utils/metrics.ts";

const codemod: Codemod<Language> = async (root) => {
  const rootNode = root.root();
  const filename = root.filename();
  const edits: Edit[] = [];
  const barrelRewrites = new Map<string, BarrelMockInfo>();

  emitMetricsForBarrelSibling(filename);

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

    recordBarrelRewrites(barrelRewrites, importPath, rewrites);

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
      // Partial — some specifiers stay with the barrel. Replace the entire
      // import statement in-place (residual barrel + new direct imports) to
      // avoid removeImport/addImport conflicts and to correctly handle
      // `type`-qualified specifiers that removeImport cannot match.
      const rewrittenNames = new Set(rewrites.map((rw) => rw.consumerName));
      const remainingSpecTexts: string[] = [];
      if (namedImports) {
        for (const spec of namedImports.findAll({
          rule: { kind: "import_specifier" },
        })) {
          const identifiers = spec.findAll({ rule: { kind: "identifier" } });
          const localBinding = identifiers[identifiers.length - 1];
          if (localBinding && !rewrittenNames.has(localBinding.text())) {
            remainingSpecTexts.push(spec.text());
          }
        }
      }
      const lines: string[] = [];
      if (remainingSpecTexts.length > 0) {
        lines.push(
          `import { ${remainingSpecTexts.join(", ")} } from ${quoteChar}${importPath}${quoteChar};`,
        );
      }
      for (const [sourcePath, specs] of byPath) {
        lines.push(buildImportText(sourcePath, specs, quoteChar));
      }
      edits.push(importStmt.replace(lines.join("\n")));
    }
  }

  rewriteMockCalls(rootNode, barrelRewrites, edits);

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

export const getSelector: GetSelector<Language> = () => {
  return {
    rule: {
      any: [{ kind: "import_statement" }, { kind: "export_statement" }],
    },
  };
};

export default codemod;
