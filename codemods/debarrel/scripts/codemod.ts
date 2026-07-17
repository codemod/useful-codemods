import type { Codemod, Edit, GetSelector, SgNode } from "codemod:ast-grep";
import { useMetricAtom } from "codemod:metrics";
import path from "path";
import type { Language } from "./utils/language.ts";
import { getStringContent, getImportSpecifierNames } from "./utils/ast.ts";
import {
  hasPackageJson,
  isBarrelFile,
  isInsideNodeModules,
  isNextPagesApiRoute,
  isPackageEntrypoint,
  joinImportPaths,
  relativePathFromDir,
  resolveModuleImportPath,
  shouldPreservePackageExportBoundary,
} from "./utils/paths.ts";
import {
  barrelMustBePreserved,
  findSymbolViaBarrelReexports,
} from "./utils/exportStar.ts";
import { isPureBarrel } from "./utils/barrel.ts";
import { resolveSpecifier, adjustRewriteForTargetExports, type SpecRewrite } from "./utils/specifiers.ts";
import { buildImportText, groupByPath } from "./utils/imports.ts";
import {
  recordBarrelRewrites,
  rewriteDynamicImports,
  rewriteMockCalls,
  type BarrelMockInfo,
} from "./utils/mocks.ts";

const barrelImport = useMetricAtom("barrel_import");

interface ExportSpecRewrite {
  /** Original export_specifier text, e.g. `Checkbox` or `Option as PublicOptionType`. */
  specText: string;
  newExportPath: string;
}

const codemod: Codemod<Language> = async (root, options) => {
  const rootNode = root.root();
  const relativeFilename = root.relativeFilename();
  const filename = root.filename();
  const edits: Edit[] = [];
  const barrelRewrites = new Map<string, BarrelMockInfo>();

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

    // Top-level `import type { … } from "…"` — preserved across rewrites so
    // we don't downgrade a type-only import to a value import (which can
    // break under --verbatimModuleSyntax / --isolatedModules when the
    // resolved declarations are `export type` aliases).
    const isTypeOnlyImport = importStmt.children().some((c) => c.is("type"));

    const isTypeOnlySpecifier = (spec: SgNode<Language>) =>
      spec.children().some((c) => c.is("type"));

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
        const names = getImportSpecifierNames(spec);
        if (!names) continue;
        const { importedName, localName: consumerName } = names;
        const localBinding = spec
          .findAll({ rule: { kind: "identifier" } })
          .at(-1);
        if (!localBinding) continue;
        const def = localBinding.definition();
        if (!def) continue;
        const rw = resolveSpecifier(
          importedName,
          consumerName,
          importPath,
          def,
          filename,
          relativeFilename,
          false,
        );
        if (rw) {
          if (!isTypeOnlyImport && isTypeOnlySpecifier(spec)) {
            rw.typeOnly = true;
          }
          const targetFile = resolveModuleImportPath(filename, rw.newImportPath);
          if (targetFile) {
            Object.assign(rw, adjustRewriteForTargetExports(rw, targetFile));
          }
          rewrites.push(rw);
        }
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
        const rw = resolveSpecifier(
          defaultIdent.text(),
          defaultIdent.text(),
          importPath,
          def,
          filename,
          relativeFilename,
          true,
        );
        if (rw) {
          const targetFile = resolveModuleImportPath(filename, rw.newImportPath);
          if (targetFile) {
            Object.assign(rw, adjustRewriteForTargetExports(rw, targetFile));
          }
          rewrites.push(rw);
        }
      }
    }

    if (rewrites.length === 0) continue;

    const firstRewrite = rewrites[0];
    if (firstRewrite) {
      barrelImport.increment({
        filePath: firstRewrite.resolvedFilePath,
        importer: relativeFilename,
      });
    }

    recordBarrelRewrites(barrelRewrites, importPath, rewrites);

    const byPath = groupByPath(rewrites);

    if (rewrites.length === totalSpecifiers) {
      // All specifiers rewritten — replace the entire import statement.
      // Can't use removeImport+addImport here because edits overlap
      // when the barrel import is the last/only import in the file.
      const lines: string[] = [];
      for (const [sourcePath, specs] of byPath) {
        lines.push(buildImportText(sourcePath, specs, quoteChar, isTypeOnlyImport));
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
        const typeKeyword = isTypeOnlyImport ? "type " : "";
        lines.push(
          `import ${typeKeyword}{ ${remainingSpecTexts.join(", ")} } from ${quoteChar}${importPath}${quoteChar};`,
        );
      }
      for (const [sourcePath, specs] of byPath) {
        lines.push(buildImportText(sourcePath, specs, quoteChar, isTypeOnlyImport));
      }
      edits.push(importStmt.replace(lines.join("\n")));
    }
  }

  // Rewrite re-export edges (`export { X } from "…"`) when the source is a
  // barrel that can be deepened — mirrors import rewriting for parent barrels.
  for (const exportStmt of rootNode.findAll({
    rule: { kind: "export_statement" },
  })) {
    const children = exportStmt.children();
    if (children.some((c) => c.is("namespace_export"))) continue;

    const exportClause = children.find((c) => c.is("export_clause"));
    const sourceNode = children.find((c) => c.is("string"));
    if (!exportClause || !sourceNode) continue;

    const exportPath = getStringContent(sourceNode);
    if (!exportPath) continue;
    const quoteChar = sourceNode.text().startsWith('"') ? '"' : "'";
    const isTypeOnlyExport = children.some((c) => c.is("type"));

    const barrelFile = resolveModuleImportPath(filename, exportPath);
    if (!barrelFile || !isBarrelFile(barrelFile)) continue;

    const specs = exportClause.findAll({ rule: { kind: "export_specifier" } });
    if (specs.length === 0) continue;

    const rewrites: ExportSpecRewrite[] = [];
    for (const spec of specs) {
      const identifiers = spec.findAll({ rule: { kind: "identifier" } });
      if (identifiers.length === 0) continue;
      // `X` → local X in source; `X as Y` → local X, exported Y.
      const localInSource = identifiers[0]!.text();
      const isDefault =
        localInSource === "default" ||
        (identifiers.length >= 2 && identifiers[1]!.text() === "default");

      const match = findSymbolViaBarrelReexports(
        barrelFile,
        localInSource,
        isDefault,
      );
      if (!match) continue;

      const barrelDir = path.dirname(barrelFile);
      let rel = relativePathFromDir(barrelDir, match.targetFile);
      const ext = path.extname(rel);
      if (ext) rel = rel.slice(0, -ext.length);
      rel = rel.replace(/\/index$/, "") || ".";
      const fromBarrel = rel.startsWith(".") ? rel : `./${rel}`;
      const newExportPath = joinImportPaths(exportPath, fromBarrel);
      if (newExportPath === exportPath) continue;

      if (
        shouldPreservePackageExportBoundary(
          barrelFile,
          exportPath,
          newExportPath,
        )
      ) {
        continue;
      }

      let specText = spec.text();
      if (match.importType === "default") {
        const identifiers = spec.findAll({ rule: { kind: "identifier" } });
        const localInSpec = identifiers[0]?.text();
        if (localInSpec && localInSpec !== "default") {
          const exportedName =
            identifiers[identifiers.length - 1]?.text() ?? localInSpec;
          specText = `default as ${exportedName}`;
        }
      }

      rewrites.push({
        specText,
        newExportPath,
      });
    }

    if (rewrites.length === 0) continue;

    const rewrittenTexts = new Set(rewrites.map((rw) => rw.specText));
    const byPath = new Map<string, string[]>();
    for (const rw of rewrites) {
      const existing = byPath.get(rw.newExportPath) ?? [];
      existing.push(rw.specText);
      byPath.set(rw.newExportPath, existing);
    }

    const typeKeyword = isTypeOnlyExport ? "type " : "";
    const lines: string[] = [];

    if (rewrites.length < specs.length) {
      const remaining: string[] = [];
      for (const spec of specs) {
        if (!rewrittenTexts.has(spec.text())) remaining.push(spec.text());
      }
      if (remaining.length > 0) {
        lines.push(
          `export ${typeKeyword}{ ${remaining.join(", ")} } from ${quoteChar}${exportPath}${quoteChar};`,
        );
      }
    }

    for (const [sourcePath, specTexts] of byPath) {
      lines.push(
        `export ${typeKeyword}{ ${specTexts.join(", ")} } from ${quoteChar}${sourcePath}${quoteChar};`,
      );
    }

    edits.push(exportStmt.replace(lines.join("\n")));
  }

  rewriteMockCalls(rootNode, barrelRewrites, edits);
  rewriteDynamicImports(rootNode, barrelRewrites, edits);

  // Barrel rename — skip files inside node_modules or inside a package
  // when the barrel is an actual package entrypoint (renaming it would break
  // consumers importing via the package name). Also preserve barrels that
  // are still required by namespace imports, namespace re-exports, or
  // dynamic `import()` consumers.
  let barrelRenamed = false;
  if (
    isBarrelFile(filename) &&
    !isInsideNodeModules(filename) &&
    !isNextPagesApiRoute(filename) &&
    (!hasPackageJson(filename) || !isPackageEntrypoint(filename))
  ) {
    const { pure, hasWildcards } = isPureBarrel(rootNode);
    if (pure && !hasWildcards && !barrelMustBePreserved(filename)) {
      root.rename(`index.barrel.bak${path.extname(filename)}`);
      barrelRenamed = true;
    }
  }

  if (edits.length === 0) {
    return barrelRenamed ? rootNode.commitEdits([]) : null;
  }
  return rootNode.commitEdits(edits);
};

export function getSelector(): ReturnType<GetSelector<Language>> {
  return {
    rule: {
      any: [{ kind: "import_statement" }, { kind: "export_statement" }],
    },
  };
}

export default codemod;
